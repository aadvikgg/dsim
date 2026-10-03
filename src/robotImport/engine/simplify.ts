/**
 * Simplify a model to a triangle budget with meshoptimizer (three's bundled
 * `meshopt_simplifier.module.js`, which carries its own wasm). Works in any frame and unit:
 * simplification is invariant under rotation and uniform scale, so the engine simplifies ONCE
 * per file, in the source frame, and every later change of units, up axis or yaw re-measures the
 * small result instead of the multi-million-triangle original.
 *
 * ⚠️ ONE ERROR BOUND FOR THE WHOLE ROBOT, NEVER A SLOPPY PASS (measured 2026-10-03 on the REV and
 * goBILDA starter-bot STEPs, `docs/area/robot-import.md` "Mesh quality"). The old pass gave each
 * colour group a share of the budget in proportion to its triangles and, where the bounded
 * `simplify` stalled short of it, let `simplifySloppy` finish: every one of the goBILDA kit's 12
 * groups went sloppy, which tore triangular holes through perforated plates and extrusions and
 * turned gears into blobs (p90 2.09 mm, max 15.9 mm off the CAD at 84k triangles). One ABSOLUTE
 * bound searched for the whole robot, each group simplified to it with small disconnected pieces
 * pruned, lands at the same triangle count with p90 0.66 mm and max 3.6 mm, and no shards. Groups
 * are simplified one call each: in one call, coincident vertices of two colours read as a seam.
 */
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { triangleCount, type MeshPart } from '../geometry';
import { compact, componentBodies, weld } from './meshOps';

export interface SimplifyReport {
  parts: MeshPart[];
  trisIn: number;
  trisOut: number;
  /** the error bound used, as a fraction of the model's extent (0 when nothing was simplified) */
  error: number;
}

/** the ladder's first bound, as a fraction of the model's extent (~0.02 mm on an 18-in robot) */
const FIRST_BOUND = 4e-5;
/** each rung doubles the bound; this many at most (2^40 × the first is past any model's size) */
const MAX_RUNGS = 40;
/** bisection steps between the last two rungs */
const REFINE_STEPS = 5;

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

/** weld every part and bring the whole model under `budget` triangles (one list: `simplifyLists`) */
export async function simplifyParts(
  parts: readonly MeshPart[],
  budget: number,
  onProgress?: (frac: number) => void,
  opts: { consume?: boolean } = {},
): Promise<SimplifyReport> {
  const r = await simplifyLists([parts], budget, onProgress, opts);
  return { parts: r.lists[0], trisIn: r.trisIn, trisOut: r.trisOut, error: r.error };
}

/**
 * Weld every part of every list, then bring them all under `budget` triangles with ONE error
 * bound, and hand them back in the same lists (a part simplified to nothing is left out). A
 * stored robot's static body and each of its moving parts are separate lists that must stay
 * separate, and share the bound so none of them is cut harder than the rest.
 *
 * The bound is found by a LADDER: from `FIRST_BOUND`, doubled each rung, each rung run on the last
 * rung's result (so every pass is smaller than the one before), then `REFINE_STEPS` of bisection
 * between the last two rungs. Deviation can add across rungs, to at most about twice the final
 * bound; measured, the same accuracy as a bisection on the original (p90 0.378 vs 0.393 mm) at a
 * third of the time.
 */
export async function simplifyLists(
  lists: readonly (readonly MeshPart[])[],
  budget: number,
  onProgress?: (frac: number) => void,
  opts: { consume?: boolean } = {},
): Promise<{ lists: MeshPart[][]; trisIn: number; trisOut: number; error: number }> {
  await MeshoptSimplifier.ready;
  const all = lists.flat();
  const trisIn = triangleCount(all);
  const extent = extentOf(all);
  const eps = extent * 1e-6;
  // progress: welding is the first quarter, the ladder the rest
  let doneTris = 0;
  const report = (f: number): void => onProgress?.(Math.min(1, f));
  // `consume`: the caller hands the parts over (each list a mutable array only it held), and each
  // one's arrays are let go as soon as its welded copy exists, instead of all of them living until
  // the end beside their copies
  const welded: { list: number; part: Pick<MeshPart, 'color' | 'name'>; positions: Float32Array; indices: Uint32Array; body: Uint32Array | null }[] = [];
  lists.forEach((list, li) => {
    const src = list as (MeshPart | null)[];
    for (let i = 0; i < src.length; i++) {
      const p = src[i]!;
      welded.push({ list: li, part: { color: p.color, name: p.name }, ...weld(p, eps) });
      doneTris += triangleCount([p]);
      report((0.25 * doneTris) / Math.max(1, trisIn));
      if (opts.consume) src[i] = null;
    }
  });
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
  const count = (r: readonly Uint32Array[]): number => r.reduce((a, x) => a + x.length / 3, 0);
  let cur = welded.map((w) => w.indices);
  let res = cur;
  let bound = 0;
  if (count(cur) > budget) {
    const run = (src: readonly Uint32Array[], e: number): Uint32Array[] =>
      src.map((ix, i) => (ix.length >= 3 ? (MeshoptSimplifier.simplify(ix, welded[i].positions, 3, 0, e, ['ErrorAbsolute', 'Prune'])[0] as Uint32Array) : ix));
    let e = extent * FIRST_BOUND;
    let lastE = 0;
    for (let rung = 0; ; rung++) {
      res = run(cur, e);
      report(0.25 + 0.6 * Math.min(1, rung / 12));
      if (count(res) <= budget || rung >= MAX_RUNGS) break;
      cur = res;
      lastE = e;
      e *= 2;
    }
    // refine between the last rung over budget and the first under it, on the last result over it
    let lo = Math.max(lastE, extent * FIRST_BOUND * 0.5);
    let hi = e;
    for (let i = 0; i < REFINE_STEPS && lastE > 0; i++) {
      const mid = Math.sqrt(lo * hi);
      const r = run(cur, mid);
      report(0.85 + (0.15 * (i + 1)) / REFINE_STEPS);
      if (count(r) <= budget) {
        hi = mid;
        res = r;
      } else lo = mid;
    }
    bound = hi;
  }
  const out: MeshPart[][] = lists.map(() => []);
  welded.forEach((w, i) => {
    if (res[i].length >= 3) out[w.list].push({ ...compact(w.positions, res[i], w.body), color: w.part.color, name: w.part.name });
  });
  report(1);
  return { lists: out, trisIn, trisOut: count(res), error: bound / extent };
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
