/**
 * Parts → a three.js group, and back out to the GPU's bin. Shared by the bake (GLB export and
 * the two pictures) and the editor preview, so what the player previews is what is stored.
 */
import * as THREE from 'three';
import type { MeshPart } from '../geometry';
import { creasedNormals } from './meshOps';

/** the crease angle every importer normal is computed at, degrees */
export const CREASE_DEG = 40;

/** give every indexed part creased normals (new arrays; parts that have them are kept) */
export function creaseParts(parts: readonly MeshPart[]): MeshPart[] {
  return parts.map((p) => {
    if (p.normals || !p.indices) return p;
    const c = creasedNormals(p.positions, p.indices, CREASE_DEG);
    return { positions: c.positions, indices: c.indices, normals: c.normals, color: p.color, name: p.name };
  });
}

/** one BufferGeometry: position, normal, and the narrowest index type that fits */
export function geometryOf(p: MeshPart): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  if (p.normals) g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
  if (p.indices) {
    const nV = p.positions.length / 3;
    g.setIndex(new THREE.BufferAttribute(nV < 65536 ? Uint16Array.from(p.indices) : p.indices, 1));
  }
  if (!p.normals) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const safeName = (s: string, i: number): string => `${(s || 'part').replace(/[^\w.-]+/g, '_').slice(0, 40)}_${i}`;

/** parts → a group of meshes, one standard material per part colour */
export function buildMeshGroup(parts: readonly MeshPart[], name = 'robot'): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  parts.forEach((p, i) => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(p.color[0], p.color[1], p.color[2]),
      roughness: 0.55,
      metalness: 0.05,
      name: `colour_${i}`,
    });
    const mesh = new THREE.Mesh(geometryOf(p), mat);
    mesh.name = safeName(p.name, i);
    group.add(mesh);
  });
  return group;
}

/** dispose every geometry and material under `root` */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}
