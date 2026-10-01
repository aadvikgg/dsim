/**
 * The editor's 3D preview: the normalised model on field tiles, the 18-in cube, the measured hull
 * on the floor, the wheel contacts, a front arrow, and the mechanism placements. Everything is in
 * the MODEL frame (inches, +x front, +y left, +z up, origin at the footprint's box centre), which
 * does not move when a wheel is dragged. Renders on demand: a frame per control change or
 * `update`, nothing while idle.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ImportedMech, Vec2 } from '../../types';
import { bbox, type MeshPart } from '../geometry';
import { buildMeshGroup, creaseParts, disposeTree } from './meshGroup';

export interface PreviewState {
  /** the normalised model, MODEL frame (compared by identity) */
  parts: MeshPart[] | null;
  hull: Vec2[] | null;
  /** FL, FR, BL, BR */
  wheels: Vec2[] | null;
  /** every floor-contact cluster */
  contacts: Vec2[] | null;
  /** the wheelbase centre */
  origin: Vec2 | null;
  mech: ImportedMech | null;
  size: { length: number; width: number; height: number } | null;
  showCube: boolean;
}

export interface PreviewController {
  update(state: Partial<PreviewState>): void;
  resize(width: number, height: number): void;
  /** back to the default 3/4 view */
  resetView(): void;
  dispose(): void;
}

const TILE_IN = 24;
const CUBE_IN = 18;
const COLORS = {
  tile: 0x5c6066,
  seam: 0x3a3d42,
  cube: 0xd8dde3,
  cubeOver: 0xf0a020,
  hull: 0x3fb6ff,
  wheel: 0x58d68d,
  contact: 0xb0b8c0,
  origin: 0xffffff,
  front: 0xffffff,
  intake: 0x58d68d,
  shooter: 0xff7a45,
  place: 0xc58cff,
};

function line(points: THREE.Vector3[], color: number, loop = false): THREE.Line {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const m = new THREE.LineBasicMaterial({ color, depthTest: true });
  return loop ? new THREE.LineLoop(g, m) : new THREE.Line(g, m);
}

function marker(radius: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.12, 24), new THREE.MeshBasicMaterial({ color }));
  m.rotation.x = Math.PI / 2; // cylinder axis y → z
  return m;
}

export function createPreview(canvas: HTMLCanvasElement, initial: Partial<PreviewState> = {}): PreviewController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(30, 20, 60);
  scene.add(key);

  // three tiles a side, with seams
  const floor = new THREE.Group();
  const tiles = new THREE.Mesh(new THREE.PlaneGeometry(TILE_IN * 3, TILE_IN * 3), new THREE.MeshStandardMaterial({ color: COLORS.tile, roughness: 0.95 }));
  floor.add(tiles);
  for (let i = -1; i <= 2; i++) {
    const c = (i - 0.5) * TILE_IN;
    floor.add(line([new THREE.Vector3(c, -1.5 * TILE_IN, 0.01), new THREE.Vector3(c, 1.5 * TILE_IN, 0.01)], COLORS.seam));
    floor.add(line([new THREE.Vector3(-1.5 * TILE_IN, c, 0.01), new THREE.Vector3(1.5 * TILE_IN, c, 0.01)], COLORS.seam));
  }
  scene.add(floor);

  const cubeMat = new THREE.LineBasicMaterial({ color: COLORS.cube, transparent: true, opacity: 0.7 });
  const cube = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE_IN, CUBE_IN, CUBE_IN)), cubeMat);
  cube.position.set(0, 0, CUBE_IN / 2);
  scene.add(cube);

  const overlays = new THREE.Group();
  scene.add(overlays);
  let model: THREE.Group | null = null;

  const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 10;
  controls.maxDistance = 250;

  const state: PreviewState = {
    parts: null,
    hull: null,
    wheels: null,
    contacts: null,
    origin: null,
    mech: null,
    size: null,
    showCube: true,
  };

  let frame = 0;
  const render = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
    });
  };
  controls.addEventListener('change', render);

  const resetView = (): void => {
    const h = state.size?.height ?? 12;
    controls.target.set(0, 0, h / 2);
    camera.position.set(42, 34, 30 + h / 2);
    controls.update();
    render();
  };

  const rebuildOverlays = (): void => {
    disposeTree(overlays);
    overlays.clear();
    const z = 0.06;
    if (state.hull && state.hull.length >= 3) {
      overlays.add(line(state.hull.map((p) => new THREE.Vector3(p.x, p.y, z)), COLORS.hull, true));
      // front arrow just past the hull's front edge
      const b = bbox(state.hull);
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(b.maxX + 1.5, (b.minY + b.maxY) / 2, z), 5, COLORS.front, 1.6, 1.2);
      overlays.add(arrow);
    }
    for (const c of state.contacts ?? []) {
      const m = marker(0.35, COLORS.contact);
      m.position.set(c.x, c.y, z);
      overlays.add(m);
    }
    for (const w of state.wheels ?? []) {
      const m = marker(0.8, COLORS.wheel);
      m.position.set(w.x, w.y, z + 0.02);
      overlays.add(m);
    }
    if (state.origin) {
      const o = state.origin;
      overlays.add(line([new THREE.Vector3(o.x - 1, o.y, z), new THREE.Vector3(o.x + 1, o.y, z)], COLORS.origin));
      overlays.add(line([new THREE.Vector3(o.x, o.y - 1, z), new THREE.Vector3(o.x, o.y + 1, z)], COLORS.origin));
    }
    const mech = state.mech;
    if (mech && state.hull && state.hull.length >= 3) {
      const b = bbox(state.hull);
      for (const it of mech.intakes ?? []) {
        const zz = 0.5;
        const pts =
          it.edge === 'front'
            ? [new THREE.Vector3(b.maxX, it.from, zz), new THREE.Vector3(b.maxX, it.to, zz)]
            : it.edge === 'back'
              ? [new THREE.Vector3(b.minX, it.from, zz), new THREE.Vector3(b.minX, it.to, zz)]
              : it.edge === 'left'
                ? [new THREE.Vector3(it.from, b.maxY, zz), new THREE.Vector3(it.to, b.maxY, zz)]
                : [new THREE.Vector3(it.from, b.minY, zz), new THREE.Vector3(it.to, b.minY, zz)];
        const dir = new THREE.Vector3().subVectors(pts[1], pts[0]);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.6, Math.abs(dir.x)), Math.max(0.6, Math.abs(dir.y)), 0.6), new THREE.MeshBasicMaterial({ color: COLORS.intake }));
        bar.position.copy(pts[0]).add(pts[1]).multiplyScalar(0.5);
        overlays.add(bar);
      }
      for (const [p, color] of [[mech.shooter, COLORS.shooter], [mech.place, COLORS.place]] as const) {
        if (!p) continue;
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), new THREE.MeshBasicMaterial({ color }));
        s.position.set(p.x, p.y, p.z);
        overlays.add(s);
        overlays.add(line([new THREE.Vector3(p.x, p.y, 0.05), new THREE.Vector3(p.x, p.y, p.z)], color));
      }
    }
    const over = !!state.size && Math.max(state.size.length, state.size.width, state.size.height) > CUBE_IN + 1 / 64;
    cubeMat.color.setHex(over ? COLORS.cubeOver : COLORS.cube);
    cube.visible = state.showCube;
  };

  const update = (next: Partial<PreviewState>): void => {
    const partsChanged = next.parts !== undefined && next.parts !== state.parts;
    Object.assign(state, next);
    if (partsChanged) {
      if (model) {
        scene.remove(model);
        disposeTree(model);
        model = null;
      }
      if (state.parts) {
        model = buildMeshGroup(creaseParts(state.parts), 'preview');
        scene.add(model);
      }
    }
    rebuildOverlays();
    render();
  };

  const resize = (width: number, height: number): void => {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    render();
  };

  resize(canvas.clientWidth || canvas.width || 640, canvas.clientHeight || canvas.height || 480);
  update(initial);
  resetView();

  return {
    update,
    resize,
    resetView,
    dispose(): void {
      if (frame) cancelAnimationFrame(frame);
      controls.removeEventListener('change', render);
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
