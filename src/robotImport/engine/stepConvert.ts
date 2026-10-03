/**
 * occt-import-js's result → plain parts, one per colour, and the messages of the STEP workers.
 * Shared by the occt worker and the Node harness (which runs occt directly), so both measure
 * exactly the same triangles.
 */
import type { OcctParams, OcctResult } from 'occt-import-js';
import type { ImportErrorCode } from './importError';
import type { ZipEntry } from './zip';

/** the triangulation a file read WHOLE uses: millimetres, 0.1 % of the bounding box, 0.5 rad */
export const STEP_PARAMS: OcctParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

/**
 * The triangulation of a file read IN PIECES (`stepSplit.ts`): ABSOLUTE, 0.5 mm and 0.5 rad. A
 * bounding-box ratio is taken per top-level shape, and a piece's shape is only its share of the
 * robot, so every piece would mesh to a different tolerance. 0.5 mm is what 0.1 % of an FTC robot's
 * average extent comes to (the whole-file setting), and occt's time is its STEP parse, not this:
 * measured on REV's starter bot, 2 mm and 1 rad cut a 24 MB piece's 29.3 s to 27.4 s.
 */
export const STEP_PIECE_PARAMS: OcctParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.5,
  angularDeflection: 0.5,
};

export interface StepPart {
  positions: Float32Array;
  indices: Uint32Array;
  /** linear RGB 0..1 */
  color: [number, number, number];
  name: string;
}

/** what one occt read gave: parts by colour, the triangles, and the B-rep faces it saw */
export type StepParts = { kind: 'done'; parts: StepPart[]; trisIn: number; faces: number } | { kind: 'error'; message: string };

/** the STEP worker's request: the file (or the zip holding it), read there, not on the main thread */
export type StepRequest = { file: Blob; name: string; entry: ZipEntry | null };
export type StepStage = 'unzip' | 'read' | 'step-wasm' | 'step-index' | 'step-parse';
export type StepResponse =
  | { kind: 'progress'; stage: StepStage; frac?: number }
  | { kind: 'done'; parts: StepPart[]; trisIn: number; notes: string[] }
  | { kind: 'error'; code: ImportErrorCode | null; message: string };

/** one occt worker's request (STEP text, transferred) and its answers */
export type OcctRequest = { id: number; bytes: Uint8Array; params: OcctParams };
export type OcctResponse =
  | { kind: 'reading'; id: number }
  | { kind: 'done'; id: number; parts: StepPart[]; trisIn: number; faces: number }
  | { kind: 'error'; id: number; message: string };

/**
 * CAD aluminium when a STEP body carries no colour. LINEAR, like every colour occt returns: OCCT's
 * `Quantity_Color` holds linear RGB and converts a STEP file's sRGB `COLOUR_RGB` on read (measured:
 * a fixture written as sRGB 0.95/0.55/0.10 comes back 0.89/0.26/0.01).
 */
const DEFAULT_LINEAR: [number, number, number] = [0.48, 0.5, 0.52];

/**
 * `faces` counts the B-rep faces occt reported. Faces with no triangles is how occt says it ran out
 * of heap: its mesher catches the failure per face and the read still "succeeds" (REV's 125 MB
 * starter bot: 118,734 faces, zero triangles).
 */
export function stepToParts(res: OcctResult): StepParts {
  if (!res || !res.success) return { kind: 'error', message: 'occt could not read the file' };
  const groups = new Map<string, { color: [number, number, number]; pos: number[]; idx: number[]; name: string }>();
  let trisIn = 0;
  let faces = 0;
  for (const m of res.meshes) {
    const P = m.attributes.position.array;
    const I = m.index.array;
    const nT = Math.floor(I.length / 3);
    trisIn += nT;
    faces += m.brep_faces?.length ?? 0;
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
  return { kind: 'done', parts, trisIn, faces };
}
