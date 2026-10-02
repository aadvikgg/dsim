/**
 * THE BAKE: the stored GLB (frame `STORED_MESH_TO_ROBOT`), the 512-px top-down PNG (frame
 * `topImageFrame`) and the 192-px card thumbnail, from the normalised, simplified parts.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { ImportedRobot, Vec2 } from '../../types';
import { topImageFrame, transformParts, triangleCount, type MeshPart } from '../geometry';
import { MAX_MESH_BYTES, ROBOT_TO_STORED_MESH, THUMB_PX, TOP_IMAGE_PX } from '../types';
import { buildMeshGroup, creaseParts, disposeTree } from './meshGroup';
import { simplifyParts } from './simplify';

export interface BakeInput {
  /** MODEL frame (the engine's `normalise` output) */
  modelParts: MeshPart[];
  /** the robot-local origin in the MODEL frame (`measurement.origin`) */
  origin: Vec2;
  /** the descriptor that will be saved; its hull frames the top image */
  descriptor: ImportedRobot;
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
    renderer.render(scene, cam);
    return await canvasBlob(canvas);
  } finally {
    disposeTree(group);
    freeRenderer(renderer);
  }
}

/**
 * Bake all three. The GLB is held to `MAX_MESH_BYTES`: when an export comes out larger, the
 * triangle budget drops in proportion (with 10 % to spare) and the parts are simplified again.
 */
export async function bake(input: BakeInput): Promise<BakeResult> {
  let robotParts = creaseParts(toRobotLocal(input.modelParts, input.origin));
  input.onProgress?.('mesh');
  let glb = await exportGlb(robotParts);
  let refits = 0;
  while (glb.byteLength > MAX_MESH_BYTES && refits < 4) {
    const tris = triangleCount(robotParts);
    const budget = Math.max(2000, Math.floor((tris * MAX_MESH_BYTES * 0.9) / glb.byteLength));
    const s = await simplifyParts(robotParts.map((p) => ({ ...p, normals: null })), budget);
    robotParts = creaseParts(s.parts);
    glb = await exportGlb(robotParts);
    refits++;
  }
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
