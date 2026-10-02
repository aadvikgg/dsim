/**
 * THE IMPORTER ENGINE — the one entry of the lazy three.js zone `src/robotImport/engine/`.
 *
 * Reached ONLY through `loadImporterEngine()` (`src/robotImport/engineLoader.ts`), the single
 * dynamic specifier, so the zone is one measurable chunk (`bundleaudit`'s `importer` route) and
 * a player who never imports a robot downloads none of it. STEP support is a further lazy step
 * inside (`load.ts` → `stepReader.ts` → a worker), fetched only when a STEP file is dropped.
 *
 * The pipeline, in the order the editor runs it:
 *   loadModel(files)            → LoadedModel: SOURCE-frame parts, merged by colour
 *   simplifyModel(model, tris)  → PreparedModel: welded, ≤ tris triangles, creased normals
 *   normalise(prepared, setup)  → measurement + MODEL-frame parts (cheap: re-run on every edit)
 *   bake({ … })                 → the stored GLB, the top PNG, the thumbnail
 *   createPreview(canvas)       → the orbit view the editor drives with `update`
 * Frames and budgets: `docs/area/robot-import.md`.
 */
import { measureParts, type MeshPart } from '../geometry';
import { MAX_TRIANGLES, type ImportMeasurement, type ImportSetup } from '../types';
import type { LoadedModel } from './load';
import { creaseParts } from './meshGroup';
import { simplifyParts } from './simplify';

export { loadModel, pickModelFile, ImportError, MAX_FILE_BYTES } from './load';
export type { LoadedModel, LoadProgress, LoadStage, ImportErrorCode } from './load';
export { bake, exportGlb, renderTop, renderThumb, toRobotLocal } from './bake';
export type { BakeInput, BakeResult } from './bake';
export { createPreview } from './preview';
export type { PreviewController, PreviewState } from './preview';

export interface PreparedModel extends LoadedModel {
  /** simplified, welded, creased: still the SOURCE frame */
  parts: MeshPart[];
  trisOut: number;
  /** meshopt's largest relative error */
  simplifyError: number;
}

export interface NormalisedModel {
  measurement: ImportMeasurement;
  /** MODEL frame, with normals */
  modelParts: MeshPart[];
}

/**
 * Simplify once per file, in the source frame (simplification is invariant under the rotation
 * and uniform scale normalisation applies), then crease the normals. `triBudget` is clamped to
 * `MAX_TRIANGLES`.
 */
export async function simplifyModel(model: LoadedModel, triBudget: number): Promise<PreparedModel> {
  const budget = Math.max(1000, Math.min(MAX_TRIANGLES, Math.floor(triBudget) || MAX_TRIANGLES));
  const s = await simplifyParts(model.parts, budget);
  return { ...model, parts: creaseParts(s.parts), trisOut: s.trisOut, simplifyError: s.error };
}

/**
 * Units, up axis, yaw, floor, centring, and every measurement (`measureParts`), on the prepared
 * model. Synchronous and fast on a simplified model, so the editor re-runs it on every change.
 */
export function normalise(model: PreparedModel, setup: ImportSetup): NormalisedModel {
  const { measurement, modelParts } = measureParts(model.parts, setup, { format: model.format, fileUnit: model.fileUnit });
  measurement.trisIn = model.trisIn;
  if (model.trisOut < model.trisIn) {
    measurement.checks.push({
      code: 'mesh-simplified',
      level: 'info',
      message: `Simplified from ${model.trisIn.toLocaleString('en-US')} to ${model.trisOut.toLocaleString('en-US')} triangles for the match view.`,
    });
  }
  return { measurement, modelParts };
}
