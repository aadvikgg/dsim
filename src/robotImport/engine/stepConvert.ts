/**
 * occt-import-js's result → plain parts, one per colour. Shared by the STEP worker and the Node
 * harness (which runs occt directly), so both measure exactly the same triangles.
 */
import type { OcctParams, OcctResult } from 'occt-import-js';

/** the triangulation every STEP import uses: millimetres, 0.1 % of the bounding box, 0.5 rad */
export const STEP_PARAMS: OcctParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

export interface StepPart {
  positions: Float32Array;
  indices: Uint32Array;
  /** linear RGB 0..1 */
  color: [number, number, number];
  name: string;
}

export type StepRequest = { bytes: ArrayBuffer; params: OcctParams };
export type StepResponse =
  | { kind: 'progress'; stage: 'step-wasm' | 'step-parse' }
  | { kind: 'done'; parts: StepPart[]; trisIn: number }
  | { kind: 'error'; message: string };

/**
 * CAD aluminium when a STEP body carries no colour. LINEAR, like every colour occt returns: OCCT's
 * `Quantity_Color` holds linear RGB and converts a STEP file's sRGB `COLOUR_RGB` on read (measured:
 * a fixture written as sRGB 0.95/0.55/0.10 comes back 0.89/0.26/0.01).
 */
const DEFAULT_LINEAR: [number, number, number] = [0.48, 0.5, 0.52];

export function stepToParts(res: OcctResult): StepResponse {
  if (!res || !res.success) return { kind: 'error', message: 'occt could not read the file' };
  const groups = new Map<string, { color: [number, number, number]; pos: number[]; idx: number[]; name: string }>();
  let trisIn = 0;
  for (const m of res.meshes) {
    const P = m.attributes.position.array;
    const I = m.index.array;
    const nT = Math.floor(I.length / 3);
    trisIn += nT;
    const meshColor = m.color ?? DEFAULT_LINEAR;
    // triangle → colour, from the B-rep faces when they carry their own
    const triColor: ([number, number, number] | null)[] = new Array(nT).fill(null);
    for (const f of m.brep_faces ?? []) {
      if (!f.color) continue;
      for (let t = f.first; t <= f.last && t < nT; t++) triColor[t] = f.color;
    }
    const local = new Map<string, Map<number, number>>(); // colour key → (source vertex → group vertex)
    for (let t = 0; t < nT; t++) {
      const c = triColor[t] ?? meshColor;
      const key = `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`;
      let g = groups.get(key);
      if (!g) {
        g = { color: [c[0], c[1], c[2]], pos: [], idx: [], name: m.name || 'step' };
        groups.set(key, g);
      }
      let vm = local.get(key);
      if (!vm) local.set(key, (vm = new Map()));
      for (let k = 0; k < 3; k++) {
        const v = I[3 * t + k];
        let nv = vm.get(v);
        if (nv === undefined) {
          nv = g.pos.length / 3;
          g.pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
          vm.set(v, nv);
        }
        g.idx.push(nv);
      }
    }
  }
  const parts: StepPart[] = [...groups.values()].map((g) => ({
    positions: new Float32Array(g.pos),
    indices: new Uint32Array(g.idx),
    color: g.color,
    name: g.name,
  }));
  return { kind: 'done', parts, trisIn };
}
