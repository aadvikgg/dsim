/**
 * THE BAKE: the stored GLB (frame `STORED_MESH_TO_ROBOT`), the 512-px top-down PNG (frame
 * `topImageFrame`) and the 192-px card thumbnail, from the normalised, simplified parts.
 */
import * as THREE from 'three';
import type { ImportedRobot, Vec2 } from '../../types';
import { topImageFrame, transformParts, triangleBody, triangleCount, type MeshPart } from '../geometry';
import { ROBOT_TO_STORED_MESH, STORED_MESH_TO_ROBOT, THUMB_PX, TOP_IMAGE_PX, type MotionPart, type StoredMotion } from '../types';
import { sceneParts, type StoredScene } from './bakeMesh';
import { bakeSceneOff } from './importSession';
import { buildMeshGroup, creaseParts, disposeTree } from './meshGroup';

export { exportGlb, exportGlbStored } from './bakeMesh';

export interface BakeInput {
  /** MODEL frame (the engine's `normalise` output) */
  modelParts: MeshPart[];
  /** the robot-local origin in the MODEL frame (`measurement.origin`) */
  origin: Vec2;
  /** the descriptor that will be saved; its hull frames the top image */
  descriptor: ImportedRobot;
  /** the moving parts as measured (MODEL frame, starting pose); each becomes a node of its own */
  motion?: MotionPart[];
  onProgress?: (stage: 'mesh' | 'top' | 'thumb') => void;
}

export interface BakeResult {
  mesh: Blob;
  top: Blob;
  thumb: Blob;
  meshBytes: number;
  trisOut: number;
  /** how many times the mesh was simplified again to fit `MAX_MESH_BYTES` */
  refits: number;
}

const translate = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** MODEL frame → robot-local (the origin moves to the wheelbase centre) */
export function toRobotLocal(modelParts: readonly MeshPart[], origin: Vec2): MeshPart[] {
  return transformParts(modelParts, translate(-origin.x, -origin.y, 0));
}

/** the triangles `tris` of `p` as a part of their own, compacted (normals and bodies carried) */
function subsetPart(p: MeshPart, tris: readonly number[]): MeshPart {
  const map = new Map<number, number>();
  const idx = new Uint32Array(tris.length * 3);
  const pos: number[] = [];
  const nrm: number[] = [];
  const body: number[] = [];
  let k = 0;
  for (const t of tris) {
    for (let c = 0; c < 3; c++) {
      const v = p.indices ? p.indices[3 * t + c] : 3 * t + c;
      let m = map.get(v);
      if (m === undefined) {
        m = pos.length / 3;
        map.set(v, m);
        pos.push(p.positions[3 * v], p.positions[3 * v + 1], p.positions[3 * v + 2]);
        if (p.normals) nrm.push(p.normals[3 * v], p.normals[3 * v + 1], p.normals[3 * v + 2]);
        if (p.body) body.push(p.body[v]);
      }
      idx[k++] = m;
    }
  }
  return {
    positions: new Float32Array(pos),
    indices: idx,
    normals: p.normals ? new Float32Array(nrm) : null,
    color: p.color,
    name: p.name,
    body: p.body ? Uint32Array.from(body) : null,
  };
}

/**
 * Robot-local parts split by moving part: `rest` holds every triangle no moving part owns, and
 * `moving[i]` the triangles of `motion[i]`'s bodies, by colour.
 */
export function splitMoving(robotParts: readonly MeshPart[], motion: readonly { bodies: readonly number[] }[]): { rest: MeshPart[]; moving: MeshPart[][] } {
  const owner = new Map<number, number>();
  motion.forEach((m, i) => {
    for (const b of m.bodies) if (!owner.has(b)) owner.set(b, i);
  });
  const rest: MeshPart[] = [];
  const moving: MeshPart[][] = motion.map(() => []);
  for (const p of robotParts) {
    const n = Math.floor((p.indices ? p.indices.length : p.positions.length / 3) / 3);
    if (!owner.size || !p.body) {
      rest.push(p);
      continue;
    }
    const buckets = new Map<number, number[]>();
    for (let t = 0; t < n; t++) {
      const o = owner.get(triangleBody(p, t)) ?? -1;
      let list = buckets.get(o);
      if (!list) buckets.set(o, (list = []));
      list.push(t);
    }
    if (buckets.size === 1 && buckets.has(-1)) {
      rest.push(p);
      continue;
    }
    for (const [o, tris] of buckets) (o < 0 ? rest : moving[o]).push(subsetPart(p, tris));
  }
  return { rest, moving };
}

const toStoredPoint = (v: readonly number[]): [number, number, number] => {
  const m = ROBOT_TO_STORED_MESH;
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
};
const toStoredDir = (v: readonly number[]): [number, number, number] => {
  const p = toStoredPoint(v);
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

/**
 * The stored scene a bake writes: robot-local creased parts and the moving parts (MODEL frame,
 * shifted here by `origin`), in the stored mesh frame. A turret turns about the placed launcher
 * (`descriptor.mech.shooter`, then `shooter2`), which is where the sim aims it from.
 */
export function storedSceneOf(robotParts: readonly MeshPart[], motion: readonly MotionPart[], origin: Vec2, descriptor: ImportedRobot): StoredScene {
  const { rest, moving } = splitMoving(robotParts, motion);
  const turretAt = [descriptor.mech?.shooter, descriptor.mech?.shooter2];
  let turrets = 0;
  const scene: StoredScene = { rest: transformParts(rest, ROBOT_TO_STORED_MESH), moving: [] };
  const kept: number[] = [];
  motion.forEach((m, i) => {
    if (!moving[i].length) return;
    let pivot = [m.pivot[0] - origin.x, m.pivot[1] - origin.y, m.pivot[2]];
    if (m.role === 'turret') {
      const at = turretAt[turrets++];
      if (at) pivot = [at.x, at.y, pivot[2]];
    }
    const info: StoredMotion = { v: 1, role: m.role, axis: toStoredDir(m.axis), radius: m.radius, deploy: m.deploy, ...(m.corner !== undefined ? { corner: m.corner } : {}) };
    kept[i] = scene.moving.length;
    scene.moving.push({ info, pivot: toStoredPoint(pivot), parent: m.parent, parts: transformParts(moving[i], ROBOT_TO_STORED_MESH) });
  });
  // parents by their index in what was kept (a parent with no triangles drops its riders to the root)
  for (const mv of scene.moving) mv.parent = mv.parent >= 0 && kept[mv.parent] !== undefined ? kept[mv.parent] : -1;
  return scene;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
}

function lights(scene: THREE.Scene, key: THREE.Vector3): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
  const d = new THREE.DirectionalLight(0xffffff, 2.2);
  d.position.copy(key);
  scene.add(d);
}

/** a throwaway renderer with a transparent background, sized `px`² */
function offscreenRenderer(px: number): { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(px, px, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { renderer, canvas };
}

function freeRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.dispose();
  renderer.forceContextLoss();
}

/**
 * The top-down PNG: orthographic, looking down −z, front (+x) = image up, left (+y) = image left,
 * framed by `topImageFrame(descriptor.hull)` so a renderer can map it back from the hull alone.
 */
export async function renderTop(robotParts: readonly MeshPart[], hull: readonly Vec2[], px = TOP_IMAGE_PX): Promise<Blob> {
  const f = topImageFrame(hull, px);
  const { renderer, canvas } = offscreenRenderer(px);
  const scene = new THREE.Scene();
  const group = buildMeshGroup(robotParts);
  scene.add(group);
  lights(scene, new THREE.Vector3(8, 5, 30));
  const half = f.sideIn / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 400);
  cam.position.set(f.cx, f.cy, 200);
  cam.up.set(1, 0, 0);
  cam.lookAt(f.cx, f.cy, 0);
  try {
    // link the programs with `KHR_parallel_shader_compile` before drawing, so the link does not
    // block this thread (the same pixels either way)
    await renderer.compileAsync(scene, cam);
    renderer.render(scene, cam);
    return await canvasBlob(canvas);
  } finally {
    disposeTree(group);
    freeRenderer(renderer);
  }
}

/** the card thumbnail: a 3/4 view from front-left-above, transparent */
export async function renderThumb(robotParts: readonly MeshPart[], px = THUMB_PX): Promise<Blob> {
  const { renderer, canvas } = offscreenRenderer(px);
  const scene = new THREE.Scene();
  const group = buildMeshGroup(robotParts);
  scene.add(group);
  lights(scene, new THREE.Vector3(14, 10, 24));
  const sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  const dir = new THREE.Vector3(1, 0.85, 0.75).normalize();
  const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02;
  cam.position.copy(sphere.center).addScaledVector(dir, dist);
  cam.up.set(0, 0, 1);
  cam.lookAt(sphere.center);
  try {
    await renderer.compileAsync(scene, cam);
    renderer.render(scene, cam);
    return await canvasBlob(canvas);
  } finally {
    disposeTree(group);
    freeRenderer(renderer);
  }
}

/**
 * Bake all three. The GLB is held to `MAX_MESH_BYTES`: when an export comes out larger, the
 * triangle budget drops in proportion (with 10 % to spare) and the parts are simplified again
 * (`bakeMeshHere`). That half runs in the import worker when one can start: an export is ~30 ms of
 * synchronous work on 100k triangles and a refit (a weld, a meshopt pass, the creases, a second
 * export) about 100 ms more, which made a Save's longest task 103–144 ms. The pictures need WebGL
 * and stay here.
 */
export async function bake(input: BakeInput): Promise<BakeResult> {
  input.onProgress?.('mesh');
  const creased = creaseParts(toRobotLocal(input.modelParts, input.origin));
  const { glb, scene, refits } = await bakeSceneOff(storedSceneOf(creased, input.motion ?? [], input.origin, input.descriptor));
  // the pictures show what is stored: the scene, back in the robot frame (every part where it starts)
  const robotParts = transformParts(sceneParts(scene), STORED_MESH_TO_ROBOT);
  input.onProgress?.('top');
  const top = await renderTop(robotParts, input.descriptor.hull);
  input.onProgress?.('thumb');
  const thumb = await renderThumb(robotParts);
  return {
    mesh: new Blob([glb], { type: 'model/gltf-binary' }),
    top,
    thumb,
    meshBytes: glb.byteLength,
    trisOut: triangleCount(robotParts),
    refits,
  };
}
