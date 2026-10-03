/**
 * THE STORED MESH: parts → a GLB in the stored mesh frame (`STORED_MESH_TO_ROBOT`), held to
 * `MAX_MESH_BYTES`. DOM-free (GLTFExporter writes a binary GLB through a `Blob` and a `FileReader`,
 * both of which a worker has), so `bake` runs it in the import worker and keeps only the two
 * pictures, which need WebGL, on the main thread.
 *
 * MOVING PARTS ARE NODES OF THEIR OWN (`docs/area/robot-import.md`, "Moving parts"): each is a group
 * translated to its pivot, its meshes relative to it, and `extras.dsim` (`StoredMotion`) saying what
 * it does and about which axis. A part that rides on another (a roller on a ramp) is that part's
 * child. Everything else is the static rest, one mesh per colour, as it always was.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { transformParts, triangleCount, type MeshPart } from '../geometry';
import { MAX_MESH_BYTES, ROBOT_TO_STORED_MESH, STORED_MESH_TO_ROBOT, readStoredMotion, type StoredMotion } from '../types';
import { buildMeshGroup, creaseParts, disposeTree } from './meshGroup';
import { partsFromObject } from './parse';
import { simplifyLists } from './simplify';

type V3 = [number, number, number];

/** a stored mesh's scene, STORED frame, positions absolute (a moving part's are not yet relative) */
export interface StoredScene {
  rest: MeshPart[];
  moving: {
    info: StoredMotion;
    /** a point on the axis, stored frame (metres) */
    pivot: V3;
    /** the moving part this one rides on, by index into `moving`, or -1 */
    parent: number;
    parts: MeshPart[];
  }[];
}

/**
 * A stored GLB's scene graph → its `StoredScene` (positions absolute, stored frame): every node with
 * a `userData.dsim` is a moving part, owning the meshes under it down to the next one; the rest is the
 * static robot. The reverse of `exportStoredScene`.
 */
export function readStoredScene(root: THREE.Object3D): StoredScene {
  root.updateMatrixWorld(true);
  const nodes: { o: THREE.Object3D; info: StoredMotion }[] = [];
  root.traverse((o) => {
    const info = readStoredMotion((o.userData as { dsim?: unknown } | undefined)?.dsim);
    if (info) nodes.push({ o, info });
  });
  const at = new Map(nodes.map((n, i) => [n.o, i]));
  const owner = (o: THREE.Object3D): number => {
    for (let p = o.parent; p; p = p.parent) {
      const i = at.get(p);
      if (i !== undefined) return i;
    }
    return -1;
  };
  const v = new THREE.Vector3();
  const scene: StoredScene = {
    rest: [],
    moving: nodes.map((n) => {
      n.o.getWorldPosition(v);
      return { info: n.info, pivot: [v.x, v.y, v.z] as V3, parent: owner(n.o), parts: [] as MeshPart[] };
    }),
  };
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const i = owner(o);
    const parts = partsFromObject(o, false).filter((p) => p.positions.length >= 9);
    (i < 0 ? scene.rest : scene.moving[i].parts).push(...parts);
  });
  return scene;
}

/** every part of a scene, rest first then each moving part's, in order */
export function sceneParts(scene: StoredScene): MeshPart[] {
  return [...scene.rest, ...scene.moving.flatMap((m) => m.parts)];
}

/** robot-local parts → a GLB in the stored mesh frame (no moving parts) */
export async function exportGlb(robotParts: readonly MeshPart[]): Promise<ArrayBuffer> {
  return exportGlbStored(transformParts(robotParts, ROBOT_TO_STORED_MESH));
}

/** parts ALREADY in the stored mesh frame → a GLB (no moving parts) */
export async function exportGlbStored(stored: readonly MeshPart[]): Promise<ArrayBuffer> {
  return exportStoredScene({ rest: [...stored], moving: [] });
}

const translateParts = (parts: readonly MeshPart[], d: V3): MeshPart[] =>
  transformParts(parts, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1]);

/** a stored scene → the GLB: the rest under the root, each moving part a node at its pivot */
export async function exportStoredScene(scene: StoredScene): Promise<ArrayBuffer> {
  const root3 = new THREE.Scene();
  const group = buildMeshGroup(scene.rest, 'dsim_robot');
  root3.add(group);
  const nodes: (THREE.Group | null)[] = scene.moving.map(() => null);
  const make = (i: number, depth = 0): THREE.Group | null => {
    if (nodes[i]) return nodes[i];
    const m = scene.moving[i];
    if (!m || depth > 8) return null;
    const parent = m.parent >= 0 && m.parent !== i ? make(m.parent, depth + 1) : null;
    const node = new THREE.Group();
    node.name = `dsim_motion_${i}_${m.info.role}`;
    const base: V3 = parent ? scene.moving[m.parent].pivot : [0, 0, 0];
    node.position.set(m.pivot[0] - base[0], m.pivot[1] - base[1], m.pivot[2] - base[2]);
    node.userData = { dsim: m.info };
    const meshes = buildMeshGroup(translateParts(m.parts, [-m.pivot[0], -m.pivot[1], -m.pivot[2]]), `dsim_motion_${i}_mesh`);
    for (const c of [...meshes.children]) node.add(c);
    (parent ?? group).add(node);
    nodes[i] = node;
    return node;
  };
  for (let i = 0; i < scene.moving.length; i++) make(i);
  try {
    const out = await new GLTFExporter().parseAsync(root3, { binary: true, onlyVisible: true });
    return out as ArrayBuffer;
  } finally {
    disposeTree(root3);
  }
}

/**
 * A stored scene → the stored GLB. When an export comes out larger than `MAX_MESH_BYTES`, the
 * triangle budget drops in proportion (with 10 % to spare) and every part list is simplified again,
 * each to its share, up to four times. Returns the GLB and the scene it holds (the pictures are
 * rendered from that, so they show what is stored).
 */
export async function bakeSceneHere(scene: StoredScene): Promise<{ glb: ArrayBuffer; scene: StoredScene; refits: number }> {
  let cur = scene;
  let glb = await exportStoredScene(cur);
  let refits = 0;
  while (glb.byteLength > MAX_MESH_BYTES && refits < 4) {
    const tris = triangleCount(sceneParts(cur));
    const ratio = Math.max(2000 / Math.max(1, tris), (MAX_MESH_BYTES * 0.9) / glb.byteLength);
    // one error bound over the robot and its moving parts (`simplifyLists`), each kept apart
    const strip = (parts: MeshPart[]): MeshPart[] => parts.map((p) => ({ ...p, normals: null }));
    const s = await simplifyLists([strip(cur.rest), ...cur.moving.map((m) => strip(m.parts))], Math.floor(tris * ratio));
    cur = { rest: creaseParts(s.lists[0]), moving: cur.moving.map((m, i) => ({ ...m, parts: creaseParts(s.lists[i + 1]) })) };
    glb = await exportStoredScene(cur);
    refits++;
  }
  return { glb, scene: cur, refits };
}

/** robot-local creased parts with no moving parts → the stored GLB (the old single-group bake) */
export async function bakeMeshHere(robotParts: MeshPart[]): Promise<{ glb: ArrayBuffer; parts: MeshPart[]; refits: number }> {
  const r = await bakeSceneHere({ rest: transformParts(robotParts, ROBOT_TO_STORED_MESH), moving: [] });
  return { glb: r.glb, parts: r.refits ? transformParts(r.scene.rest, STORED_MESH_TO_ROBOT) : robotParts, refits: r.refits };
}
