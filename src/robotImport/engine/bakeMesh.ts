/**
 * THE STORED MESH: parts → a GLB in the stored mesh frame (`STORED_MESH_TO_ROBOT`), held to
 * `MAX_MESH_BYTES`. DOM-free (GLTFExporter writes a binary GLB through a `Blob` and a `FileReader`,
 * both of which a worker has), so `bake` runs it in the import worker and keeps only the two
 * pictures, which need WebGL, on the main thread.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { transformParts, triangleCount, type MeshPart } from '../geometry';
import { MAX_MESH_BYTES, ROBOT_TO_STORED_MESH } from '../types';
import { buildMeshGroup, creaseParts, disposeTree } from './meshGroup';
import { simplifyParts } from './simplify';

/** robot-local parts → a GLB in the stored mesh frame */
export async function exportGlb(robotParts: readonly MeshPart[]): Promise<ArrayBuffer> {
  return exportGlbStored(transformParts(robotParts, ROBOT_TO_STORED_MESH));
}

/** parts ALREADY in the stored mesh frame → a GLB (`liteMesh` re-cuts a stored mesh without leaving it) */
export async function exportGlbStored(stored: readonly MeshPart[]): Promise<ArrayBuffer> {
  const scene = new THREE.Scene();
  const group = buildMeshGroup(stored, 'dsim_robot');
  scene.add(group);
  try {
    const out = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
    return out as ArrayBuffer;
  } finally {
    disposeTree(group);
  }
}

/**
 * Robot-local, creased parts → the stored GLB. When an export comes out larger than
 * `MAX_MESH_BYTES`, the triangle budget drops in proportion (with 10 % to spare) and the parts are
 * simplified again, up to four times. Returns the GLB and the parts it holds (the pictures are
 * rendered from those, so they show what is stored).
 */
export async function bakeMeshHere(robotParts: MeshPart[]): Promise<{ glb: ArrayBuffer; parts: MeshPart[]; refits: number }> {
  let parts = robotParts;
  let glb = await exportGlb(parts);
  let refits = 0;
  while (glb.byteLength > MAX_MESH_BYTES && refits < 4) {
    const tris = triangleCount(parts);
    const budget = Math.max(2000, Math.floor((tris * MAX_MESH_BYTES * 0.9) / glb.byteLength));
    const s = await simplifyParts(parts.map((p) => ({ ...p, normals: null })), budget);
    parts = creaseParts(s.parts);
    glb = await exportGlb(parts);
    refits++;
  }
  return { glb, parts, refits };
}
