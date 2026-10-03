/**
 * Simplify a model to a triangle budget with meshoptimizer (three's bundled
 * `meshopt_simplifier.module.js`, which carries its own wasm). Works in any frame and unit:
 * simplification is invariant under rotation and uniform scale, so the engine simplifies ONCE
 * per file, in the source frame, and every later change of units, up axis or yaw re-measures the
 * small result instead of the multi-million-triangle original.
 */
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { triangleCount, type MeshPart } from '../geometry';
import { compact, componentBodies, weld } from './meshOps';

export interface SimplifyReport {
  parts: MeshPart[];
  trisIn: number;
  trisOut: number;
  /** meshopt's largest relative error over the parts (fraction of each part's extent) */
  error: number;
}

/** relative error the error-bounded pass may introduce before the sloppy pass takes over */
const TARGET_ERROR = 0.002;

function extentOf(parts: readonly MeshPart[]): number {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (a[i + k] < mn[k]) mn[k] = a[i + k];
        if (a[i + k] > mx[k]) mx[k] = a[i + k];
      }
    }
  }
  return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
}

/**
 * Weld every part, then bring the whole model under `budget` triangles. Each part gets a share
 * of the budget in proportion to its own triangle count (at least 12 triangles, so a small part
 * keeps a shape); `simplify` runs first with a bounded error, and where it stalls short of the
 * target (thousands of disconnected fasteners do that) `simplifySloppy` finishes the job.
 */
export async function simplifyParts(
  parts: readonly MeshPart[],
  budget: number,
  onProgress?: (frac: number) => void,
  opts: { consume?: boolean } = {},
): Promise<SimplifyReport> {
  await MeshoptSimplifier.ready;
  const trisIn = triangleCount(parts);
  const eps = extentOf(parts) * 1e-6;
  // progress: welding is the first quarter, the first simplify pass the rest (later passes, when
  // the budget overshoots, are small)
  let doneTris = 0;
  const tick = (tris: number, from: number, span: number): void => {
    doneTris += tris;
    onProgress?.(from + (span * doneTris) / Math.max(1, trisIn));
  };
  // `consume`: the caller hands the parts over (`parts` is a mutable array only it held), and each
  // one's arrays are let go as soon as its welded copy exists, instead of all of them living until
  // the end beside their copies
  const src = parts as (MeshPart | null)[];
  const welded: { part: Pick<MeshPart, 'color' | 'name'>; positions: Float32Array; indices: Uint32Array; body: Uint32Array | null }[] = [];
  for (let i = 0; i < src.length; i++) {
    const p = src[i]!;
    welded.push({ part: { color: p.color, name: p.name }, ...weld(p, eps) });
    tick(triangleCount([p]), 0, 0.25);
    if (opts.consume) src[i] = null;
  }
  // A MODEL WITH NO BODIES OF ITS OWN (an STL, a PLY, a glTF exported as one mesh, or a reader that
  // gave every vertex one id) gets one per connected piece of the welded mesh, numbered across the
  // parts. Positions and indices are untouched: only `body` is added.
  if (distinctBodies(welded) <= 1) {
    let next = 0;
    for (const w of welded) {
      const c = componentBodies(w.positions.length / 3, w.indices, next);
      w.body = c.body;
      next += c.count;
    }
  }
  doneTris = 0;
  const weldedTris = welded.reduce((s, w) => s + w.indices.length / 3, 0);
  const out: MeshPart[] = [];
  let error = 0;
  if (weldedTris <= budget) {
    for (const w of welded) if (w.indices.length) out.push({ ...compact(w.positions, w.indices, w.body), color: w.part.color, name: w.part.name });
    return { parts: out, trisIn, trisOut: weldedTris, error: 0 };
  }
  // meshopt lands NEAR a target, not on it (and the 12-triangle floor adds a little), so the
  // budget is a ceiling enforced by re-running the pass on its own result, aimed lower each time
  let current = welded.map((w) => ({ positions: w.positions, indices: w.indices, part: w.part, body: w.body }));
  let total = weldedTris;
  let aim = budget;
  for (let pass = 0; pass < 4 && total > budget; pass++) {
    const ratio = aim / total;
    const next: typeof current = [];
    for (const w of current) {
      const n = w.indices.length / 3;
      if (n === 0) continue;
      const target = Math.min(n, Math.max(12, Math.floor(n * ratio)));
      let idx = w.indices;
      if (target < n) {
        const [res, err] = MeshoptSimplifier.simplify(idx, w.positions, 3, target * 3, TARGET_ERROR, []);
        idx = res;
        error = Math.max(error, err);
        if (idx.length / 3 > target * 1.1) {
          const [sl, e2] = MeshoptSimplifier.simplifySloppy(idx, w.positions, 3, null, target * 3, 0.05);
          if (sl.length >= 3) {
            idx = sl;
            error = Math.max(error, e2);
          }
        }
      }
      if (pass === 0) tick(n, 0.25, 0.75);
      if (idx.length < 3) continue;
      next.push({ positions: w.positions, indices: idx, part: w.part, body: w.body });
    }
    current = next;
    total = current.reduce((s, w) => s + w.indices.length / 3, 0);
    aim = Math.floor(aim * (budget / Math.max(total, 1)) * 0.995);
  }
  for (const w of current) out.push({ ...compact(w.positions, w.indices, w.body), color: w.part.color, name: w.part.name });
  return { parts: out, trisIn, trisOut: triangleCount(out), error };
}

/** how many different body ids the welded parts carry (0 when none carries any) */
function distinctBodies(welded: readonly { body: Uint32Array | null }[]): number {
  let first = -1;
  for (const w of welded) {
    if (!w.body) continue;
    for (let i = 0; i < w.body.length; i++) {
      if (first < 0) first = w.body[i];
      else if (w.body[i] !== first) return 2;
    }
  }
  return first < 0 ? 0 : 1;
}
