/**
 * A loaded model → a PREPARED one: welded, under the triangle budget, creased normals. three-free,
 * so the import worker runs it; `importerEngine.ts` re-exports it for the main-thread path.
 */
import type { MeshPart } from '../geometry';
import { MAX_TRIANGLES } from '../types';
import { creaseParts } from './meshOps';
import type { LoadedModel } from './parse';
import { simplifyParts } from './simplify';

export interface PreparedModel extends LoadedModel {
  /** simplified, welded, creased: still the SOURCE frame */
  parts: MeshPart[];
  trisOut: number;
  /** meshopt's largest relative error */
  simplifyError: number;
}

/** `triBudget` clamped to [1000, `MAX_TRIANGLES`] */
export function clampBudget(triBudget: number): number {
  return Math.max(1000, Math.min(MAX_TRIANGLES, Math.floor(triBudget) || MAX_TRIANGLES));
}

/**
 * Simplify once per file, in the source frame (simplification is invariant under the rotation
 * and uniform scale normalisation applies), then crease the normals. `triBudget` is clamped to
 * `MAX_TRIANGLES`.
 */
export async function simplifyModel(model: LoadedModel, triBudget: number, onProgress?: (frac: number) => void): Promise<PreparedModel> {
  const s = await simplifyParts(model.parts, clampBudget(triBudget), onProgress);
  return { ...model, parts: creaseParts(s.parts), trisOut: s.trisOut, simplifyError: s.error };
}
