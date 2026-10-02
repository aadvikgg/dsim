/**
 * Files → parts ON THE CALLING THREAD. One loader per format, all ending in the same place:
 * `MeshPart`s in the SOURCE frame (world transforms applied, the file's own units and axes), merged
 * by colour.
 *
 * The editor does not read a dropped file here: `importSession.ts` sends GLB, glTF, STL, OBJ and PLY
 * to the import worker, which runs `parse.ts` there. This is the path for what cannot move (3MF:
 * three's loader needs `DOMParser`; STEP reads in its own worker either way), for a stored mesh or a
 * share file (≤ 4 MB), for the dev harness, and for a browser that cannot start a worker.
 */
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import type { LengthUnit, ModelFormat } from '../types';
import { ImportError } from './importError';
import { WORKER_FORMATS, assembleLoaded, extOf, parseFiles, partsFromObject, type LoadProgress, type LoadedModel, type ParsedFiles } from './parse';

export { ImportError } from './importError';
export type { ImportErrorCode } from './importError';
export { partsFromObject } from './parse';
export type { LoadedModel, LoadProgress, LoadStage } from './parse';

/** the largest file the importer reads (a full-robot STEP export is typically 20–150 MB) */
export const MAX_FILE_BYTES = 400 * 1024 * 1024;

const EXT_FORMAT: Record<string, ModelFormat> = {
  glb: 'glb',
  gltf: 'gltf',
  stl: 'stl',
  obj: 'obj',
  '3mf': '3mf',
  ply: 'ply',
  step: 'step',
  stp: 'step',
};
/** which file is the model when several are dropped together */
const PRIORITY: ModelFormat[] = ['glb', 'gltf', 'step', '3mf', 'obj', 'stl', 'ply'];

/** which of these files would be read, and as what (null when none is a supported model) */
export function pickModelFile(files: readonly File[]): { file: File; format: ModelFormat } | null {
  let best: { file: File; format: ModelFormat } | null = null;
  for (const f of files) {
    const fmt = EXT_FORMAT[extOf(f.name)];
    if (!fmt) continue;
    if (!best || PRIORITY.indexOf(fmt) < PRIORITY.indexOf(best.format)) best = { file: f, format: fmt };
  }
  return best;
}

/**
 * The checks every load makes before reading a byte: a file, a supported one, not empty, not
 * over `MAX_FILE_BYTES`. Throws `ImportError` with a sentence for the player.
 */
export function checkFiles(input: readonly File[] | FileList): { files: File[]; file: File; format: ModelFormat } {
  const files = Array.from(input as ArrayLike<File>);
  if (!files.length) throw new ImportError('no-file', 'Choose a robot file to import.');
  const pick = pickModelFile(files);
  if (!pick) {
    const names = files.map((f) => f.name).join(', ');
    throw new ImportError('unsupported', `Couldn’t read ${names}: DSIM imports GLB, glTF, STEP, STL, OBJ, 3MF and PLY. Export the robot in one of those and try again.`);
  }
  const { file, format } = pick;
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportError('too-large', `${file.name} is ${Math.round(file.size / 1048576)} MB; the importer reads files up to ${MAX_FILE_BYTES / 1048576} MB. Export without hidden parts or fasteners and try again.`);
  }
  if (file.size === 0) throw new ImportError('empty', `${file.name} is empty. Export it again and retry.`);
  return { files, file, format };
}

export interface LoadOptions {
  /** stop a STEP read (its worker is terminated) and reject with an `AbortError` */
  signal?: AbortSignal;
}

/**
 * Read dropped files into parts. Several files may be dropped together: a `.gltf` with its
 * `.bin`, an `.obj` with its `.mtl`. Throws `ImportError` with a sentence for the player.
 */
export async function loadModel(input: readonly File[] | FileList, onProgress?: LoadProgress, opts: LoadOptions = {}): Promise<LoadedModel> {
  const { file, format, parsed } = await readRaw(input, onProgress, opts);
  onProgress?.('convert');
  return assembleLoaded(file.name, format, parsed);
}

/**
 * `loadModel` without the merge: the parts as the format gave them. The import session reads a
 * STEP or 3MF file this way and hands the parts to the worker, which merges and simplifies them.
 */
export async function readRaw(
  input: readonly File[] | FileList,
  onProgress?: LoadProgress,
  opts: LoadOptions = {},
): Promise<{ file: File; format: ModelFormat; parsed: ParsedFiles }> {
  const { files, file, format } = checkFiles(input);
  onProgress?.('read');
  if (WORKER_FORMATS.includes(format)) {
    return { file, format, parsed: await parseFiles(file, files, format, onProgress, async () => MeshoptDecoder, opts.signal) };
  }
  try {
    if (format === 'step') {
      const buf = await file.arrayBuffer();
      const { readStep } = await import('./stepReader');
      let res: Awaited<ReturnType<typeof readStep>>;
      try {
        res = await readStep(buf, (s) => onProgress?.(s), opts.signal);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw e;
        throw new ImportError('step-failed', `Couldn’t read ${file.name} as STEP (${e instanceof Error ? e.message : 'unknown error'}). Export it again as STEP AP214 or AP242, or try GLB.`);
      }
      const parts = res.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: p.color, name: p.name }));
      return { file, format, parsed: { parts, bytes: file.size, notes: [], fileUnit: 'mm', trisIn: res.trisIn } };
    }
    // 3MF
    onProgress?.('parse');
    const buf = await file.arrayBuffer();
    const fileUnit = threeMfUnit(new Uint8Array(buf));
    const group = new ThreeMFLoader().parse(buf);
    return { file, format, parsed: { parts: partsFromObject(group, true), bytes: file.size, notes: [], fileUnit } };
  } catch (e) {
    if (e instanceof ImportError || (e instanceof Error && e.name === 'AbortError')) throw e;
    throw new ImportError('corrupt', `Couldn’t read ${file.name}: it looks damaged or isn’t really ${format.toUpperCase()} (${e instanceof Error ? e.message : 'unknown error'}). Export it again and retry.`);
  }
}

// ---- 3MF ---------------------------------------------------------------------------------

const MF_UNITS: Record<string, LengthUnit> = { millimeter: 'mm', centimeter: 'cm', meter: 'm', inch: 'in', foot: 'ft' };

/** the `unit` attribute of a 3MF's model part (millimetre when absent, per the 3MF spec) */
export function threeMfUnit(zip: Uint8Array): LengthUnit | null {
  try {
    const entries = unzipSync(zip, { filter: (f) => /\.model$/i.test(f.name) });
    for (const name of Object.keys(entries)) {
      const head = new TextDecoder().decode(entries[name].subarray(0, 4096));
      const m = /<model\b[^>]*\bunit\s*=\s*["']([a-z]+)["']/i.exec(head);
      if (/<model\b/i.test(head)) return m ? (MF_UNITS[m[1].toLowerCase()] ?? null) : 'mm';
    }
  } catch {
    return null;
  }
  return null;
}

