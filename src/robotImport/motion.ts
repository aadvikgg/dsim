/**
 * MOVING PARTS — the geometry behind the importer's moving parts (`docs/area/robot-import.md`,
 * "Moving parts"). DOM-free and three-free: the measurement (`geometry.ts`, in the measure worker
 * too), the editor and the tests all run it.
 *
 * A moving part is a set of CAD BODIES (`MeshPart.body`) with a role. This file turns those bodies
 * into an axis and a pivot (a spinning part's axle, a turret's vertical, a ramp's hinge), finds the
 * drive wheels from the floor contacts, grows a click on one body into everything on its axle, and
 * FOLDS a ramp the file shows deployed, so the footprint that is measured is the starting one.
 */
import type { DrivetrainType, Vec2 } from '../types';
import type { MeshPart } from './geometry';
import { DEFAULT_DEPLOY_DEG, HINGE_ROLES, JOINT_DEFAULT_AMOUNT, JOINT_ROLES, SPIN_ROLES, type MotionGroup, type MotionPart, type MotionRole } from './types';

type V3 = [number, number, number];

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const isSpin = (r: MotionRole): boolean => SPIN_ROLES.includes(r);
export const isHinge = (r: MotionRole): boolean => HINGE_ROLES.includes(r);
export const isJoint = (r: MotionRole): boolean => JOINT_ROLES.includes(r);

// ---- per-body statistics ------------------------------------------------------------------------

/**
 * Sums over every vertex of every body: count, the coordinate sums, the box and the second moments,
 * indexed by body id. One pass over the parts; what every fit and every "which bodies are near here"
 * question reads before it looks at a single vertex.
 */
export interface BodyStats {
  /** ids that have at least one vertex, ascending */
  ids: number[];
  n: Float64Array;
  /** x, y, z sums */
  s: Float64Array;
  /** xx, xy, xz, yy, yz, zz sums */
  q: Float64Array;
  min: Float64Array;
  max: Float64Array;
}

const statsCache = new WeakMap<readonly MeshPart[], BodyStats>();

/** the per-body statistics of `parts` (memoised on the array) */
export function bodyStats(parts: readonly MeshPart[]): BodyStats {
  const hit = statsCache.get(parts);
  if (hit) return hit;
  let top = -1;
  for (const p of parts) if (p.body) for (let i = 0; i < p.body.length; i++) if (p.body[i] > top) top = p.body[i];
  const N = top + 1;
  const n = new Float64Array(N);
  const s = new Float64Array(3 * N);
  const q = new Float64Array(6 * N);
  const min = new Float64Array(3 * N).fill(Infinity);
  const max = new Float64Array(3 * N).fill(-Infinity);
  for (const p of parts) {
    if (!p.body) continue;
    const a = p.positions;
    for (let v = 0; v < p.body.length; v++) {
      const b = p.body[v];
      const x = a[3 * v];
      const y = a[3 * v + 1];
      const z = a[3 * v + 2];
      n[b]++;
      s[3 * b] += x;
      s[3 * b + 1] += y;
      s[3 * b + 2] += z;
      q[6 * b] += x * x;
      q[6 * b + 1] += x * y;
      q[6 * b + 2] += x * z;
      q[6 * b + 3] += y * y;
      q[6 * b + 4] += y * z;
      q[6 * b + 5] += z * z;
      if (x < min[3 * b]) min[3 * b] = x;
      if (y < min[3 * b + 1]) min[3 * b + 1] = y;
      if (z < min[3 * b + 2]) min[3 * b + 2] = z;
      if (x > max[3 * b]) max[3 * b] = x;
      if (y > max[3 * b + 1]) max[3 * b + 1] = y;
      if (z > max[3 * b + 2]) max[3 * b + 2] = z;
    }
  }
  const ids: number[] = [];
  for (let b = 0; b < N; b++) if (n[b] > 0) ids.push(b);
  const out = { ids, n, s, q, min, max };
  statsCache.set(parts, out);
  return out;
}

/** a set of bodies' summed statistics: count, centroid, covariance (xx xy xz yy yz zz), box */
/** the centre of a set's box: unlike the vertex mean, it does not lean toward where the mesh is dense
 *  (a fanned cap puts half a cylinder's vertices on one point of its rim) */
const boxCentre = (mo: { min: V3; max: V3 }): V3 => [(mo.min[0] + mo.max[0]) / 2, (mo.min[1] + mo.max[1]) / 2, (mo.min[2] + mo.max[2]) / 2];

function setMoments(st: BodyStats, bodies: Iterable<number>): { n: number; c: V3; cov: number[]; min: V3; max: V3 } {
  let n = 0;
  const S = [0, 0, 0];
  const Q = [0, 0, 0, 0, 0, 0];
  const mn: V3 = [Infinity, Infinity, Infinity];
  const mx: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    if (b >= st.n.length || !st.n[b]) continue;
    n += st.n[b];
    for (let k = 0; k < 3; k++) {
      S[k] += st.s[3 * b + k];
      mn[k] = Math.min(mn[k], st.min[3 * b + k]);
      mx[k] = Math.max(mx[k], st.max[3 * b + k]);
    }
    for (let k = 0; k < 6; k++) Q[k] += st.q[6 * b + k];
  }
  if (!n) return { n: 0, c: [0, 0, 0], cov: [0, 0, 0, 0, 0, 0], min: [0, 0, 0], max: [0, 0, 0] };
  const c: V3 = [S[0] / n, S[1] / n, S[2] / n];
  const cov = [
    Q[0] / n - c[0] * c[0],
    Q[1] / n - c[0] * c[1],
    Q[2] / n - c[0] * c[2],
    Q[3] / n - c[1] * c[1],
    Q[4] / n - c[1] * c[2],
    Q[5] / n - c[2] * c[2],
  ];
  return { n, c, cov, min: mn, max: mx };
}

/** eigen-decomposition of a symmetric 3×3 (xx xy xz yy yz zz), Jacobi; values descending */
export function eigenSym3(m: readonly number[]): { values: V3; vectors: [V3, V3, V3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-30)) break;
    for (const [p, r] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      if (Math.abs(a[p][r]) < 1e-300) continue;
      const theta = (a[r][r] - a[p][p]) / (2 * a[p][r]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akr = a[k][r];
        a[k][p] = c * akp - s * akr;
        a[k][r] = s * akp + c * akr;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const ark = a[r][k];
        a[p][k] = c * apk - s * ark;
        a[r][k] = s * apk + c * ark;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkr = v[k][r];
        v[k][p] = c * vkp - s * vkr;
        v[k][r] = s * vkp + c * vkr;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map((i) => a[i][i]) as V3,
    vectors: order.map((i) => norm([v[0][i], v[1][i], v[2][i]])) as [V3, V3, V3],
  };
}

/** snap a direction to the nearest model axis when it is within `deg` of one */
export function snapAxis(a: V3, deg = 10): V3 {
  const cos = Math.cos((deg * Math.PI) / 180);
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a[k]) >= cos) {
      const out: V3 = [0, 0, 0];
      out[k] = Math.sign(a[k]);
      return out;
    }
  }
  return a;
}

/**
 * THE AXLE OF A ROUND PART from its second moments: a part turned about an axis spreads EQUALLY in
 * the two directions across it, so the axis is the principal direction whose spread differs from
 * the other two — the LONGEST for a roller (a long thin cylinder), the SHORTEST for a wheel or a
 * flywheel (a disc). Snapped to a model axis within 10°, since a robot is built square.
 */
export function roundAxis(cov: readonly number[]): V3 {
  const { values, vectors } = eigenSym3(cov);
  const a = values[0] - values[1] > values[1] - values[2] ? vectors[0] : vectors[2];
  return snapAxis(a);
}

/** visit every vertex of the bodies in `set`: (x, y, z, body) */
function eachVertex(parts: readonly MeshPart[], set: ReadonlySet<number>, f: (x: number, y: number, z: number, b: number) => void): void {
  for (const p of parts) {
    if (!p.body) continue;
    const a = p.positions;
    for (let v = 0; v < p.body.length; v++) {
      const b = p.body[v];
      if (set.has(b)) f(a[3 * v], a[3 * v + 1], a[3 * v + 2], b);
    }
  }
}

/** a round part's axle: its direction, the point on it mid-way along the part, and its radius */
export function fitRound(parts: readonly MeshPart[], bodies: readonly number[], axisHint?: V3): { axis: V3; pivot: V3; radius: number } | null {
  const st = bodyStats(parts);
  const mo = setMoments(st, bodies);
  if (mo.n < 3) return null;
  const axis = axisHint ?? roundAxis(mo.cov);
  // the centre: mid-way along the axis, and across it the middle of the box the part spans in the
  // two directions square to the axis (the centroid of a lopsided hub is off its own axle)
  const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
  const e2 = cross(axis, e1);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const set = new Set(bodies);
  eachVertex(parts, set, (x, y, z) => {
    const p: V3 = [x, y, z];
    const d = [dot(p, axis), dot(p, e1), dot(p, e2)];
    for (let k = 0; k < 3; k++) {
      if (d[k] < lo[k]) lo[k] = d[k];
      if (d[k] > hi[k]) hi[k] = d[k];
    }
  });
  const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const pivot = add(add(scale(axis, mid[0]), scale(e1, mid[1])), scale(e2, mid[2]));
  let radius = 0;
  eachVertex(parts, set, (x, y, z) => {
    const r = sub([x, y, z], pivot);
    const along = dot(r, axis);
    const rr = Math.hypot(r[0] - axis[0] * along, r[1] - axis[1] * along, r[2] - axis[2] * along);
    if (rr > radius) radius = rr;
  });
  return { axis, pivot, radius };
}

// ---- picking: a click on one body → everything on its axle ---------------------------------------

/** how far a body's centre may sit off the seed's axle and still be on it, inches */
const COAXIAL_TOL_IN = 0.3;
/** a roller's or flywheel's axle carries nothing wider than this from its line, inches */
const AXLE_RADIUS_IN = 3.25;
/** a body this small (its box's longest side) needs no axis of its own to be on an axle: a nut, a spacer */
const SMALL_BODY_IN = 1;

/**
 * The bodies that turn WITH `seed`: on its axle (centre within `COAXIAL_TOL_IN` of the line), turned
 * about the same direction (their own axle parallel, or too small to have one), and within reach of
 * the line. A WHEEL keeps to its own width along the axle (the other side's wheel is often on the
 * same line); a roller or a flywheel takes the whole shaft, every wheel and pulley on it.
 */
export function coaxialBodies(parts: readonly MeshPart[], seed: number, role: MotionRole): number[] {
  const st = bodyStats(parts);
  const fit = fitRound(parts, [seed]);
  if (!fit) return [seed];
  const { axis, pivot } = fit;
  const seedLo = dot(sub([st.min[3 * seed], st.min[3 * seed + 1], st.min[3 * seed + 2]], pivot), axis);
  const seedHi = dot(sub([st.max[3 * seed], st.max[3 * seed + 1], st.max[3 * seed + 2]], pivot), axis);
  const span = Math.max(Math.abs(seedLo), Math.abs(seedHi));
  const wheel = role === 'wheel';
  const reach = wheel ? fit.radius + 0.6 : Math.max(AXLE_RADIUS_IN, fit.radius + 0.25);
  const cos = Math.cos((10 * Math.PI) / 180);
  const cand = new Set<number>();
  for (const b of st.ids) {
    if (b === seed) continue;
    const mo = setMoments(st, [b]);
    const d = sub(mo.c, pivot);
    const along = dot(d, axis);
    const off = Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along);
    if (off > COAXIAL_TOL_IN) continue;
    if (wheel && Math.abs(along) > span + 1) continue;
    const ext = Math.max(mo.max[0] - mo.min[0], mo.max[1] - mo.min[1], mo.max[2] - mo.min[2]);
    if (ext > SMALL_BODY_IN && Math.abs(dot(roundAxis(mo.cov), axis)) < cos) continue;
    cand.add(b);
  }
  // nothing that reaches past the axle's own radius: a side plate the shaft runs through is centred on
  // it too, and it does not turn
  const worst = new Map<number, number>();
  eachVertex(parts, cand, (x, y, z, b) => {
    const r = sub([x, y, z], pivot);
    const along = dot(r, axis);
    const rr = Math.hypot(r[0] - axis[0] * along, r[1] - axis[1] * along, r[2] - axis[2] * along);
    if (rr > (worst.get(b) ?? 0)) worst.set(b, rr);
  });
  const near = [...cand].filter((b) => (worst.get(b) ?? 0) <= reach);
  if (wheel) {
    // a wheel: what lies wholly inside its own cylinder (the screws through it are off its axle),
    // and of that what turns with it: no motor, no bearing block, no shield, no frame screw beside it
    const inCyl = new Set<number>();
    for (const b of st.ids) {
      const c = boxCentre(setMoments(st, [b]));
      const d = sub(c, pivot);
      const al = dot(d, axis);
      if (Math.abs(al) <= WHEEL_HALF_WIDTH_IN && Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al) <= fit.radius + 0.35) inCyl.add(b);
    }
    const bad = new Set<number>();
    eachVertex(parts, inCyl, (x, y, z, b) => {
      if (bad.has(b)) return;
      const r = sub([x, y, z], pivot);
      const al = dot(r, axis);
      if (Math.abs(al) > WHEEL_HALF_WIDTH_IN || Math.hypot(r[0] - axis[0] * al, r[1] - axis[1] * al, r[2] - axis[2] * al) > fit.radius + 0.35) bad.add(b);
    });
    const inside = new Set([...inCyl].filter((b) => !bad.has(b)));
    inside.add(seed);
    const keep = turnsWithWheel(axleFits(parts, st, inside, pivot, axis), fit.radius, axis);
    keep.add(seed);
    return [...keep].sort((a, b) => a - b);
  }
  const fits = axleFits(parts, st, new Set([seed, ...near]), pivot, axis);
  // A ROLLER'S OR A FLYWHEEL'S AXLE (2026-10-03, owner: "the auto-detector combines a static channel
  // and a gear into one component"): a body larger than a fastener turns with it only when it is ROUND
  // about it (a channel the shaft runs along is centred on it too), and a motor-sized cylinder past
  // the end of everything else on the axle is the motor driving it, which does not turn
  const round = near.filter((b) => fits.get(b)!.ext < FASTENER_IN || roundAboutAxle(fits.get(b)!));
  const motorLike = (b: number): boolean => {
    const f = fits.get(b)!;
    const d = 2 * Math.max(f.w1, f.w2);
    return f.ext >= FASTENER_IN && f.hi - f.lo >= 1.5 * d && d >= 0.9 && d <= 2.6;
  };
  let glo = fits.get(seed)!.lo;
  let ghi = fits.get(seed)!.hi;
  for (const b of round) {
    if (motorLike(b)) continue;
    glo = Math.min(glo, fits.get(b)!.lo);
    ghi = Math.max(ghi, fits.get(b)!.hi);
  }
  const out = [seed];
  for (const b of round) {
    const f = fits.get(b)!;
    const half = (f.hi - f.lo) / 2;
    if (motorLike(b) && (f.hi > ghi + half || f.lo < glo - half)) continue;
    out.push(b);
  }
  return out.sort((a, b) => a - b);
}

// ---- the drive wheels, from the floor contacts ----------------------------------------------------

/** half a drive wheel's width along its axle, at most, inches (a 104 mm mecanum is 1.8 in wide) */
const WHEEL_HALF_WIDTH_IN = 1.4;
/** a body whose box centre is this close to an axle is ON it (a hub, a spacer, a clamp screw), inches */
const ON_AXLE_IN = 0.35;
/** how far a part on the axle may stand out of the wheel's own width and still turn with it, inches
 *  (a hub through the bore does; a motor, a bearing block or a collar inside the frame does not) */
const HUB_PROUD_IN = 0.6;
/** a body smaller than this (its box's longest side) may be a fastener, inches */
const FASTENER_IN = 1.2;

interface AxleFit {
  /** its points' span along the axle */
  lo: number;
  hi: number;
  /** the largest distance of its points from the axle */
  rMax: number;
  /** its box centre's distance from the axle */
  off: number;
  /** its box's longest side */
  ext: number;
  /** its own long direction (the largest principal axis) */
  dir: V3;
  /** the unit direction from the axle to its box centre (zero when on it) */
  radial: V3;
  /** its half widths across the axle, in two directions square to it and each other */
  w1: number;
  w2: number;
}

/** where each of `bodies` sits about the axle through `centre` along unit `axis` */
function axleFits(parts: readonly MeshPart[], st: BodyStats, bodies: ReadonlySet<number>, centre: V3, axis: V3): Map<number, AxleFit> {
  const out = new Map<number, AxleFit>();
  for (const b of bodies) {
    const mo = setMoments(st, [b]);
    const d = sub(boxCentre(mo), centre);
    const al = dot(d, axis);
    const rv = sub(d, scale(axis, al));
    const off = Math.hypot(rv[0], rv[1], rv[2]);
    out.set(b, {
      lo: Infinity,
      hi: -Infinity,
      rMax: 0,
      off,
      ext: Math.max(mo.max[0] - mo.min[0], mo.max[1] - mo.min[1], mo.max[2] - mo.min[2]),
      dir: eigenSym3(mo.cov).vectors[0],
      radial: off > 1e-6 ? scale(rv, 1 / off) : [0, 0, 0],
      w1: 0,
      w2: 0,
    });
  }
  const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
  const e2 = cross(axis, e1);
  const span = new Map<number, number[]>();
  eachVertex(parts, bodies, (x, y, z, b) => {
    const f = out.get(b)!;
    const r = sub([x, y, z], centre);
    const along = dot(r, axis);
    const rr = Math.hypot(r[0] - axis[0] * along, r[1] - axis[1] * along, r[2] - axis[2] * along);
    if (along < f.lo) f.lo = along;
    if (along > f.hi) f.hi = along;
    if (rr > f.rMax) f.rMax = rr;
    let sp = span.get(b);
    if (!sp) span.set(b, (sp = [Infinity, -Infinity, Infinity, -Infinity]));
    const u = dot(r, e1);
    const v = dot(r, e2);
    if (u < sp[0]) sp[0] = u;
    if (u > sp[1]) sp[1] = u;
    if (v < sp[2]) sp[2] = v;
    if (v > sp[3]) sp[3] = v;
  });
  for (const [b, sp] of span) {
    const f = out.get(b)!;
    f.w1 = (sp[1] - sp[0]) / 2;
    f.w2 = (sp[3] - sp[2]) / 2;
  }
  return out;
}

/** is a body ROUND about the axle: as wide one way across it as the other, with no corner past the
 *  circle (a gear, a hub, a shaft, a roller pass; a channel or a plate the shaft runs through fails) */
function roundAboutAxle(f: AxleFit): boolean {
  const w = Math.max(f.w1, f.w2);
  if (!(w > 1e-6)) return false;
  const ratio = f.w1 / Math.max(f.w2, 1e-9);
  return ratio >= 0.8 && ratio <= 1.25 && f.rMax <= 1.12 * w;
}

/**
 * WHAT OF `fits` TURNS WITH A WHEEL of radius `R` about unit `axis` (2026-10-03, owner: "the motor
 * or the motor cover/shield spins with the wheel sometimes"; measured on goBILDA's kit, frame screws
 * beside the axle came along too). The wheel's own WIDTH is the along-axle span of its ring: the
 * bodies centred on the axle that reach past 0.6 R (the tyre, a rim, a mecanum's side plates). Then:
 *  · a body ON the axle (a hub, a spacer, a clamp screw) must touch that width and stand out of it by
 *    no more than `HUB_PROUD_IN`: a motor, a bearing block, a collar inside the frame do not turn;
 *  · a body OFF the axle must lie within the width, and a small one lying square to the axle must be
 *    TANGENTIAL to it (an omni wheel's roller), not pointing toward the axle (a frame screw beside it).
 *    A mecanum's rollers lie at 45° to the axle, so they are never "square" to it.
 * With no outer ring found, every body passes (the cylinder test alone, as before).
 */
export function turnsWithWheel(fits: ReadonlyMap<number, AxleFit>, R: number, axis: V3): Set<number> {
  // the ring: big bodies CENTRED on the axle (a tyre, a rim, a mecanum's side plates). Off the axle a
  // body can reach 0.6 R and be a frame screw beside the wheel (measured), so only when nothing
  // centred is that big does the off-axle ring count
  // ...and of those, the ones near the largest such radius: a shield or a pulley beside the wheel is
  // centred and big too, and must not widen it
  let lo = Infinity;
  let hi = -Infinity;
  for (const centred of [true, false]) {
    let top = 0;
    for (const f of fits.values()) if (f.rMax >= 0.6 * R && (!centred || f.off <= ON_AXLE_IN)) top = Math.max(top, f.rMax);
    for (const f of fits.values()) {
      if (f.rMax >= Math.max(0.6 * R, 0.85 * top) && (!centred || f.off <= ON_AXLE_IN)) {
        lo = Math.min(lo, f.lo);
        hi = Math.max(hi, f.hi);
      }
    }
    if (hi > lo) break;
  }
  const keep = new Set<number>();
  if (!(hi > lo)) {
    for (const b of fits.keys()) keep.add(b);
    return keep;
  }
  const margin = 0.15;
  const square = Math.cos((70 * Math.PI) / 180);
  for (const [b, f] of fits) {
    if (f.off <= ON_AXLE_IN) {
      if (f.hi < lo || f.lo > hi) continue; // beside the wheel (a shield, a bearing), not in it
      if (f.lo < lo - HUB_PROUD_IN || f.hi > hi + HUB_PROUD_IN) continue; // a motor, a long collar
      keep.add(b);
      continue;
    }
    if (f.lo < lo - margin || f.hi > hi + margin) continue;
    if (f.ext < FASTENER_IN && Math.abs(dot(f.dir, axis)) < square && Math.abs(dot(f.dir, f.radial)) > 0.4) continue;
    keep.add(b);
  }
  return keep;
}

/**
 * THE DRIVE WHEELS: for each wheel contact (MODEL frame, FL FR BL BR), the bodies wholly inside the
 * wheel's own cylinder (its axle square to the robot, radial for an X-drive, at the wheel's radius
 * above the floor, a wheel's width along it: never a frame plate, which runs past it), and of those
 * the ones that turn with it (`turnsWithWheel`). A corner with nothing there is left out.
 */
export function findWheelGroups(parts: readonly MeshPart[], wheels: readonly Vec2[], drivetrain: DrivetrainType, wheelDiaIn: number): MotionGroup[] {
  const st = bodyStats(parts);
  const R = Number.isFinite(wheelDiaIn) && wheelDiaIn > 0.5 ? wheelDiaIn / 2 : 2;
  const cx = wheels.reduce((s, w) => s + w.x, 0) / Math.max(1, wheels.length);
  const cy = wheels.reduce((s, w) => s + w.y, 0) / Math.max(1, wheels.length);
  const taken = new Set<number>();
  const out: MotionGroup[] = [];
  wheels.forEach((w, corner) => {
    const axis: V3 = drivetrain === 'xdrive' ? norm([w.x - cx, w.y - cy, 0]) : [0, 1, 0];
    const centre: V3 = [w.x, w.y, R];
    const cand = new Set<number>();
    for (const b of st.ids) {
      if (taken.has(b)) continue;
      if (st.max[3 * b] < w.x - R - 0.5 || st.min[3 * b] > w.x + R + 0.5) continue;
      if (st.max[3 * b + 1] < w.y - R - 0.5 || st.min[3 * b + 1] > w.y + R + 0.5) continue;
      if (st.min[3 * b + 2] > 2 * R + 0.5) continue;
      cand.add(b);
    }
    const bad = new Set<number>();
    eachVertex(parts, cand, (x, y, z, b) => {
      if (bad.has(b)) return;
      const r = sub([x, y, z], centre);
      const along = dot(r, axis);
      const rr = Math.hypot(r[0] - axis[0] * along, r[1] - axis[1] * along, r[2] - axis[2] * along);
      if (rr > R + 0.35 || Math.abs(along) > WHEEL_HALF_WIDTH_IN) bad.add(b);
    });
    const inside = new Set([...cand].filter((b) => !bad.has(b)));
    const bodies = [...turnsWithWheel(axleFits(parts, st, inside, centre, axis), R, axis)].sort((a, b) => a - b);
    if (!bodies.length) return;
    for (const b of bodies) taken.add(b);
    out.push({ role: 'wheel', bodies, corner, found: true });
  });
  return out;
}

// ---- the intake rollers, from the intake spans ----------------------------------------------------

/** how far in from the robot's edge an intake roller's axle may sit, inches */
const ROLLER_DEPTH_IN = 4;
/** an intake roller's axle is no higher than this, inches (a folded ramp's far roller is up near it) */
const ROLLER_TOP_IN = 10;
/** a roller group's radius, inches: under it is a bare shaft, over it is not a roller */
const ROLLER_R_MIN_IN = 0.35;
const ROLLER_R_MAX_IN = 2.5;

/**
 * THE INTAKE ROLLERS: on each intake span (`ImportedMech.intakes`, MODEL frame), every axle that runs
 * along the edge within `ROLLER_DEPTH_IN` of it, under `ROLLER_TOP_IN`, inside the span. An axle is
 * seeded by a ROUND body along the edge (its cross-section as wide one way as the other, and no
 * corner past the circle: a square tube fails, a hex shaft passes), then grown to everything on it
 * (`coaxialBodies`). Bodies in `taken` (the wheels) are never used. A suggestion: the player removes
 * what is not a roller.
 */
export function findRollerGroups(
  parts: readonly MeshPart[],
  intakes: readonly { edge: 'front' | 'back' | 'left' | 'right'; from: number; to: number }[],
  taken: ReadonlySet<number>,
): MotionGroup[] {
  const st = bodyStats(parts);
  if (!st.ids.length) return [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const b of st.ids) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], st.min[3 * b + k]);
      hi[k] = Math.max(hi[k], st.max[3 * b + k]);
    }
  }
  const used = new Set(taken);
  const out: MotionGroup[] = [];
  for (const span of intakes) {
    const along: 0 | 1 = span.edge === 'front' || span.edge === 'back' ? 1 : 0;
    const across = along === 1 ? 0 : 1;
    const outward = span.edge === 'front' || span.edge === 'left' ? 1 : -1;
    const edgeAt = outward > 0 ? hi[across] : lo[across];
    // two ways a roller stands at a mouth: its axle ALONG the edge (a sweeper, a roller bar), or
    // UPRIGHT (side rollers, which pull an element in from beside it). Each is judged round in the
    // plane square to its axle.
    const orients: { axis: V3; d1: number; d2: number }[] = [
      { axis: along === 1 ? [0, 1, 0] : [1, 0, 0], d1: across, d2: 2 },
      { axis: [0, 0, 1], d1: 0, d2: 1 },
    ];
    for (const o of orients) {
      // the candidates by their boxes: near the edge, low, within the span, round about the axle's
      // direction (equal spread across it)
      const cand = new Map<number, { c: number[]; h1: number; h2: number; r: number }>();
      for (const b of st.ids) {
        if (used.has(b)) continue;
        const c = [0, 1, 2].map((k) => (st.min[3 * b + k] + st.max[3 * b + k]) / 2);
        if ((edgeAt - c[across]) * outward > ROLLER_DEPTH_IN || c[2] > ROLLER_TOP_IN) continue;
        if (c[along] < Math.min(span.from, span.to) - 1 || c[along] > Math.max(span.from, span.to) + 1) continue;
        const h1 = (st.max[3 * b + o.d1] - st.min[3 * b + o.d1]) / 2;
        const h2 = (st.max[3 * b + o.d2] - st.min[3 * b + o.d2]) / 2;
        if (h1 < 0.05 || h2 < 0.05 || h1 / h2 < 0.85 || h1 / h2 > 1.18) continue;
        cand.set(b, { c, h1, h2, r: 0 });
      }
      // and no corner past the circle: ONE pass over the model for every candidate (a pass each was
      // 0.2 s at 250k triangles on goBILDA's BIOBUZZ kit, 2026-10-03)
      eachVertex(parts, new Set(cand.keys()), (x, y, z, b) => {
        const k = cand.get(b)!;
        const p = [x, y, z];
        const d = Math.hypot(p[o.d1] - k.c[o.d1], p[o.d2] - k.c[o.d2]);
        if (d > k.r) k.r = d;
      });
      for (const [b, k] of cand) {
        if (used.has(b)) continue;
        if (k.r > 1.12 * Math.max(k.h1, k.h2)) continue;
        const bodies = coaxialBodies(parts, b, 'roller').filter((x) => !used.has(x));
        const whole = fitRound(parts, bodies, o.axis);
        if (!whole || whole.radius < ROLLER_R_MIN_IN || whole.radius > ROLLER_R_MAX_IN) continue;
        for (const x of bodies) used.add(x);
        out.push({ role: 'roller', bodies, found: true });
      }
    }
  }
  return out;
}

// ---- flywheels, a turret and a deployed ramp, from the placements ---------------------------------

/** a flywheel's centre is within this of the launcher's placed point, inches */
const FLYWHEEL_REACH_IN = 5;
/** a flywheel's radius, inches */
const FLYWHEEL_R_MIN_IN = 0.6;
const FLYWHEEL_R_MAX_IN = 2.6;

/**
 * THE FLYWHEELS: round DISCS (thinner along their axle than across) with a level axle, centred within
 * `FLYWHEEL_REACH_IN` of the launcher's placed point (`at`, MODEL frame: a fixed launcher's lip, a
 * turret's axis at its release height), each grown to its axle (`coaxialBodies`). The two largest
 * axles at most (a double wheel). Bodies in `taken` are never used. A suggestion.
 */
export function findFlywheelGroups(parts: readonly MeshPart[], at: V3, taken: ReadonlySet<number>): MotionGroup[] {
  const st = bodyStats(parts);
  const used = new Set(taken);
  const cands: { b: number; r: number }[] = [];
  for (const b of st.ids) {
    if (used.has(b)) continue;
    const mo = setMoments(st, [b]);
    const c = boxCentre(mo);
    if (Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) > FLYWHEEL_REACH_IN) continue;
    const ext = [0, 1, 2].map((k) => mo.max[k] - mo.min[k]);
    const big = Math.max(...ext);
    if (big < 2 * FLYWHEEL_R_MIN_IN || big > 2 * FLYWHEEL_R_MAX_IN) continue;
    const fit = fitRound(parts, [b]);
    if (!fit || Math.abs(fit.axis[2]) > 0.3) continue; // a level axle
    // a disc: thinner along the axle than across, and round across it
    const along = Math.abs(fit.axis[0]) * ext[0] + Math.abs(fit.axis[1]) * ext[1] + Math.abs(fit.axis[2]) * ext[2];
    if (along > fit.radius * 1.2) continue;
    const f = axleFits(parts, st, new Set([b]), fit.pivot, fit.axis).get(b)!;
    if (!roundAboutAxle(f) || fit.radius < FLYWHEEL_R_MIN_IN) continue;
    cands.push({ b, r: fit.radius });
  }
  cands.sort((a, b) => b.r - a.r || a.b - b.b);
  const out: MotionGroup[] = [];
  for (const { b } of cands) {
    if (used.has(b) || out.length >= 2) continue;
    const bodies = coaxialBodies(parts, b, 'flywheel').filter((x) => !used.has(x));
    for (const x of bodies) used.add(x);
    out.push({ role: 'flywheel', bodies, found: true });
  }
  return out;
}

/**
 * THE TURRET: the largest round body with an UPRIGHT axis whose axis passes within 1.5 in of the
 * launcher's placed point (`at`, its x and y) below its release height (a bearing ring, a lazy-susan
 * plate, 1.5 to 6 in across its radius), and everything standing on it: bodies whose box lies within
 * the ring's radius plus 3 in of that axis and starts no lower than the ring's own bottom. A
 * suggestion; null when no such ring is there.
 */
export function findTurretGroup(parts: readonly MeshPart[], at: V3, taken: ReadonlySet<number>): MotionGroup | null {
  const st = bodyStats(parts);
  let ring: { b: number; c: V3; r: number; z0: number } | null = null;
  for (const b of st.ids) {
    if (taken.has(b)) continue;
    const mo = setMoments(st, [b]);
    const c = boxCentre(mo);
    if (Math.hypot(c[0] - at[0], c[1] - at[1]) > 1.5 || mo.max[2] > at[2]) continue;
    const wx = (mo.max[0] - mo.min[0]) / 2;
    const wy = (mo.max[1] - mo.min[1]) / 2;
    const h = mo.max[2] - mo.min[2];
    const r = Math.max(wx, wy);
    if (r < 1.5 || r > 6 || h > r || wx / Math.max(wy, 1e-9) < 0.85 || wx / Math.max(wy, 1e-9) > 1.18) continue;
    const f = axleFits(parts, st, new Set([b]), [c[0], c[1], 0], [0, 0, 1]).get(b)!;
    if (!roundAboutAxle(f)) continue;
    if (!ring || r > ring.r) ring = { b, c, r, z0: mo.min[2] };
  }
  if (!ring) return null;
  const reach = ring.r + 3;
  const bodies: number[] = [];
  for (const b of st.ids) {
    if (taken.has(b)) continue;
    if (st.min[3 * b + 2] < ring.z0 - 0.05) continue;
    let far = 0;
    for (const x of [st.min[3 * b], st.max[3 * b]]) for (const y of [st.min[3 * b + 1], st.max[3 * b + 1]]) far = Math.max(far, Math.hypot(x - ring.c[0], y - ring.c[1]));
    if (far > reach) continue;
    bodies.push(b);
  }
  return bodies.length ? { role: 'turret', bodies: bodies.sort((a, b) => a - b), found: true } : null;
}

/**
 * A RAMP (or any part) THE FILE SHOWS DEPLOYED, from an intake edge: when the model runs past 18 in
 * outward from its far edge, every body whose box reaches past that line, and the smaller ones mounted
 * on them (`mountedBodies`). The owner's case: a robot imported with its ramp down "says it is too
 * big". `role` is `ramp` on a build with BIOBUZZ's ramp intake, else `fold`. Null when the model fits.
 */
export function findDeployedGroup(
  parts: readonly MeshPart[],
  intakes: readonly { edge: 'front' | 'back' | 'left' | 'right' }[],
  role: 'ramp' | 'fold',
  taken: ReadonlySet<number>,
  maxIn = 18,
): MotionGroup | null {
  const st = bodyStats(parts);
  if (!st.ids.length) return null;
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const b of st.ids) for (let k = 0; k < 2; k++) {
    lo[k] = Math.min(lo[k], st.min[3 * b + k]);
    hi[k] = Math.max(hi[k], st.max[3 * b + k]);
  }
  for (const { edge } of intakes) {
    const k = edge === 'front' || edge === 'back' ? 0 : 1;
    const outward = edge === 'front' || edge === 'left' ? 1 : -1;
    if (hi[k] - lo[k] <= maxIn + 0.05) continue;
    const line = outward > 0 ? lo[k] + maxIn : hi[k] - maxIn;
    const past = st.ids.filter((b) => !taken.has(b) && (outward > 0 ? st.max[3 * b + k] > line : st.min[3 * b + k] < line));
    if (!past.length) continue;
    const bodies = new Set(past);
    for (const b of past) for (const x of mountedBodies(parts, b)) if (!taken.has(x)) bodies.add(x);
    return { role, bodies: [...bodies].sort((a, b) => a - b), found: true };
  }
  return null;
}

// ---- folding: a ramp the file shows deployed ------------------------------------------------------

/**
 * How one hinged part is folded for the starting configuration, in the frame it was planned in (the
 * measurement's ROTATED frame: inches, +x front, +z up, not yet centred).
 */
export interface FoldPlan {
  /** index into the setup's `motion` */
  group: number;
  /** every body the fold turns: the part's own and those of the spinning parts riding on it */
  bodies: number[];
  /** the spinning groups that ride on it */
  riders: number[];
  hinge: V3;
  /** the hinge's direction: a POSITIVE turn about it swings the part out and down (deploys it) */
  axis: V3;
  /** radians, file pose → starting pose (≤ 0: folding is a turn up) */
  angle: number;
  /** radians, starting pose → deployed (≥ 0) */
  deploy: number;
}

/** how far past a hinged part's innermost point the hinge's height is read from, inches */
const HINGE_BAND_IN = 0.75;
/** a spinning part whose centre is within this of a hinged part's box rides on it, inches */
const RIDE_PAD_IN = 0.75;

/**
 * THE FOLD of every hinged group (`ramp`, `fold`) in `motion`, planned on `parts` (rotated frame).
 *
 *  · OUTWARD is the horizontal model axis along which the part sits furthest from the rest of the
 *    robot (a front ramp: +x). The HINGE runs square to it and level (along the edge), through the
 *    part's innermost point, at the mean height of the part within `HINGE_BAND_IN` of that point.
 *  · A part the file shows DEPLOYED folds up about it until its farthest point stands straight above
 *    the hinge (or by `foldDeg`), and deploys back to the file's pose; one the file shows FOLDED stays,
 *    and deploys by `deployDeg`.
 *  · A spinning part whose centre is inside the hinged part's box rides on it: a roller on a ramp folds
 *    with the ramp.
 */
export function planFolds(parts: readonly MeshPart[], motion: readonly MotionGroup[]): FoldPlan[] {
  const st = bodyStats(parts);
  const hinged = new Set<number>();
  motion.forEach((g) => {
    if (isHinge(g.role)) for (const b of g.bodies) hinged.add(b);
  });
  const rest = st.ids.filter((b) => !hinged.has(b));
  const restC = setMoments(st, rest).c;
  const plans: FoldPlan[] = [];
  motion.forEach((g, gi) => {
    if (!isHinge(g.role) || !g.bodies.length) return;
    const mo = setMoments(st, g.bodies);
    if (mo.n < 3) return;
    const d = sub(mo.c, restC);
    const u: V3 = Math.abs(d[0]) >= Math.abs(d[1]) ? [Math.sign(d[0]) || 1, 0, 0] : [0, Math.sign(d[1]) || 1, 0];
    const axis: V3 = [-u[1], u[0], 0]; // ẑ × u: a positive turn takes u toward −ẑ
    // riders: spinning groups whose centre is inside this part's box
    const riders: number[] = [];
    const bodies = [...g.bodies];
    motion.forEach((o, oi) => {
      if (oi === gi || !isSpin(o.role) || !o.bodies.length) return;
      const c = boxCentre(setMoments(st, o.bodies));
      const inside = [0, 1, 2].every((k) => c[k] >= mo.min[k] - RIDE_PAD_IN && c[k] <= mo.max[k] + RIDE_PAD_IN);
      if (inside) {
        riders.push(oi);
        bodies.push(...o.bodies);
      }
    });
    // the hinge. Deployed: at the part's innermost point along u, at the height of what is there.
    // Folded (standing up): at its foot, where the lowest band of it is.
    const own = new Set(g.bodies);
    const folded = g.filePose === 'folded';
    let sMin = Infinity;
    let zMin = Infinity;
    eachVertex(parts, own, (x, y, z) => {
      const s = x * u[0] + y * u[1];
      if (s < sMin) sMin = s;
      if (z < zMin) zMin = z;
    });
    let sSum = 0;
    let zSum = 0;
    let n = 0;
    eachVertex(parts, own, (x, y, z) => {
      const s = x * u[0] + y * u[1];
      if (folded ? z <= zMin + HINGE_BAND_IN : s <= sMin + HINGE_BAND_IN) {
        sSum += s;
        zSum += z;
        n++;
      }
    });
    const lateral = sub(mo.c, scale(u, dot(mo.c, u)));
    const sHinge = folded && n ? sSum / n : sMin;
    const hinge: V3 = [lateral[0] + u[0] * sHinge, lateral[1] + u[1] * sHinge, n ? zSum / n : mo.min[2]];
    // the lever: from the hinge to the part's farthest point, in the vertical plane through u
    let far = -1;
    let phi = 0;
    eachVertex(parts, own, (x, y, z) => {
      const du = (x - hinge[0]) * u[0] + (y - hinge[1]) * u[1];
      const dz = z - hinge[2];
      const r2 = du * du + dz * dz;
      if (r2 > far) {
        far = r2;
        phi = Math.atan2(dz, du);
      }
    });
    let angle = 0;
    let deploy = 0;
    const rad = Math.PI / 180;
    if ((g.filePose ?? 'deployed') === 'deployed') {
      if (g.foldDeg !== undefined && Number.isFinite(g.foldDeg)) angle = -Math.max(0, Math.min(180, g.foldDeg)) * rad;
      else if (phi < Math.PI / 2 - 2 * rad) angle = phi - Math.PI / 2;
      deploy = -angle;
    }
    if (deploy < 1e-3) {
      // the file is the starting pose: it deploys by the player's angle, else a quarter turn
      angle = 0;
      const dd = g.deployDeg !== undefined && Number.isFinite(g.deployDeg) ? g.deployDeg : DEFAULT_DEPLOY_DEG;
      deploy = Math.max(0, Math.min(180, dd)) * rad;
    }
    plans.push({ group: gi, bodies: bodies.sort((a, b) => a - b), riders, hinge, axis, angle, deploy });
  });
  return plans;
}

/** turn `p` about the line (`o`, unit `k`) by `c = cos θ`, `s = sin θ` (Rodrigues) */
function turn(p: V3, o: V3, k: V3, c: number, s: number): V3 {
  const v = sub(p, o);
  const kv = dot(k, v);
  const kxv = cross(k, v);
  return [
    o[0] + v[0] * c + kxv[0] * s + k[0] * kv * (1 - c),
    o[1] + v[1] * c + kxv[1] * s + k[1] * kv * (1 - c),
    o[2] + v[2] * c + kxv[2] * s + k[2] * kv * (1 - c),
  ];
}

/**
 * Apply `plans` to `parts` IN PLACE (positions, and normals when there are): each fold turns its
 * bodies about its hinge by its `angle`. The measurement does it in the rotated frame before it
 * centres the model, and `toModelFrame` does the same at the same step, so both get the same floats.
 */
export function applyFolds(parts: readonly MeshPart[], plans: readonly FoldPlan[]): void {
  if (!plans.length) return;
  const of = new Map<number, { plan: FoldPlan; c: number; s: number }>();
  for (const plan of plans) {
    if (Math.abs(plan.angle) < 1e-12) continue;
    const e = { plan, c: Math.cos(plan.angle), s: Math.sin(plan.angle) };
    for (const b of plan.bodies) of.set(b, e);
  }
  if (!of.size) return;
  for (const p of parts) {
    if (!p.body) continue;
    const a = p.positions;
    const nrm = p.normals ?? null;
    for (let v = 0; v < p.body.length; v++) {
      const e = of.get(p.body[v]);
      if (!e) continue;
      const q = turn([a[3 * v], a[3 * v + 1], a[3 * v + 2]], e.plan.hinge, e.plan.axis, e.c, e.s);
      a[3 * v] = q[0];
      a[3 * v + 1] = q[1];
      a[3 * v + 2] = q[2];
      if (nrm) {
        const n = turn([nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]], [0, 0, 0], e.plan.axis, e.c, e.s);
        nrm[3 * v] = n[0];
        nrm[3 * v + 1] = n[1];
        nrm[3 * v + 2] = n[2];
      }
    }
  }
}

/**
 * The setup's moving parts as the STORED MESH has them. It is baked in the starting pose, so a hinged
 * part the file showed deployed is folded in it: saved as `filePose: 'folded'`, deploying by what
 * was measured, so reopening the saved robot does not fold it a second time.
 */
export function motionAsStored(motion: readonly MotionGroup[] | undefined, measured: readonly MotionPart[] | undefined): MotionGroup[] | undefined {
  if (!motion) return undefined;
  return motion.map((g, gi) => {
    if (!isHinge(g.role) || g.filePose === 'folded') return g;
    const p = measured?.find((q) => q.group === gi);
    const { foldDeg: _fold, ...rest } = g;
    void _fold;
    return { ...rest, filePose: 'folded', deployDeg: p ? Math.round((p.deploy * 180) / Math.PI) : DEFAULT_DEPLOY_DEG };
  });
}

/** how far past a picked body's box a smaller body still counts as mounted on it, inches */
const MOUNT_PAD_IN = 0.4;

/**
 * `seed` and the bodies MOUNTED ON it: every smaller body whose box lies inside the seed's, padded by
 * `MOUNT_PAD_IN` (a plate's screws, standoffs and brackets). A click on a ramp's side plate takes its
 * hardware with it.
 */
export function mountedBodies(parts: readonly MeshPart[], seed: number): number[] {
  const st = bodyStats(parts);
  if (seed >= st.n.length || !st.n[seed]) return [seed];
  const lo = [0, 1, 2].map((k) => st.min[3 * seed + k] - MOUNT_PAD_IN);
  const hi = [0, 1, 2].map((k) => st.max[3 * seed + k] + MOUNT_PAD_IN);
  const ext = (b: number): number => Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]);
  const own = ext(seed);
  const out = [seed];
  for (const b of st.ids) {
    if (b === seed || ext(b) >= own) continue;
    if ([0, 1, 2].every((k) => st.min[3 * b + k] >= lo[k] && st.max[3 * b + k] <= hi[k])) out.push(b);
  }
  return out.sort((a, b) => a - b);
}

/** the setup keys a fold depends on: what `orientKey` adds so a new fold re-measures */
export function foldKey(motion: readonly MotionGroup[] | undefined): string {
  if (!motion || !motion.some((g) => isHinge(g.role) && g.bodies.length)) return '';
  return JSON.stringify(
    motion.map((g) => (isHinge(g.role) ? [g.role, g.bodies, g.filePose ?? 'deployed', g.foldDeg ?? null, g.deployDeg ?? null] : isSpin(g.role) ? [g.bodies] : [])),
  );
}

// ---- what the measurement reports ----------------------------------------------------------------

/**
 * The moving parts as measured (`MotionPart`): MODEL frame, STARTING pose (`modelParts` is already
 * folded), each with its axis turned so a positive turn is its role's own sense. `plans` are the
 * folds `orientParts` made (rotated frame) and `t` that frame's shift to the model frame.
 */
export function deriveMotion(modelParts: readonly MeshPart[], motion: readonly MotionGroup[], plans: readonly FoldPlan[], t: V3): MotionPart[] {
  const st = bodyStats(modelParts);
  const out: MotionPart[] = [];
  const index = new Map<number, number>(); // setup index → output index
  const rideOn = new Map<number, number>(); // setup index → carrier setup index
  // a part the player put on another (an arm on a slide) rides it, whatever the geometry says
  motion.forEach((g, gi) => {
    if (g.rideOn !== undefined && Number.isInteger(g.rideOn) && g.rideOn !== gi && motion[g.rideOn]?.bodies.length) rideOn.set(gi, g.rideOn);
  });
  for (const p of plans) for (const r of p.riders) if (!rideOn.has(r)) rideOn.set(r, p.group);
  // turrets carry what is inside them (a flywheel on a turret)
  motion.forEach((g, gi) => {
    if (g.role !== 'turret' || !g.bodies.length) return;
    const mo = setMoments(st, g.bodies);
    motion.forEach((o, oi) => {
      if (oi === gi || !isSpin(o.role) || rideOn.has(oi) || !o.bodies.length) return;
      const c = boxCentre(setMoments(st, o.bodies));
      if ([0, 1, 2].every((k) => c[k] >= mo.min[k] - 0.5 && c[k] <= mo.max[k] + 0.5)) rideOn.set(oi, gi);
    });
  });
  motion.forEach((g, gi) => {
    const bodies = g.bodies.filter((b) => b < st.n.length && st.n[b] > 0);
    if (!bodies.length) return;
    let part: MotionPart | null = null;
    if (isJoint(g.role)) {
      part = jointPart(modelParts, st, g, gi, bodies);
      if (!part) return;
    } else if (isHinge(g.role)) {
      const plan = plans.find((p) => p.group === gi);
      if (!plan) return;
      part = { role: g.role, bodies, pivot: add(plan.hinge, t), axis: plan.axis, radius: 0, deploy: plan.deploy, parent: -1, group: gi };
    } else if (g.role === 'turret') {
      const mo = setMoments(st, bodies);
      part = { role: 'turret', bodies, pivot: [(mo.min[0] + mo.max[0]) / 2, (mo.min[1] + mo.max[1]) / 2, mo.min[2]], axis: [0, 0, 1], radius: 0, deploy: 0, parent: -1, group: gi };
    } else {
      const fit = fitRound(modelParts, bodies, g.role === 'wheel' ? wheelAxisHint(modelParts, bodies) : undefined);
      if (!fit) return;
      let axis = fit.axis;
      const t3 = cross(axis, [0, 0, 1]); // a positive turn moves the part's BOTTOM along −t3 and its TOP along +t3
      let sense = 1;
      if (g.role === 'wheel') sense = t3[0] < -1e-9 || (Math.abs(t3[0]) <= 1e-9 && t3[1] < 0) ? -1 : 1;
      else if (g.role === 'roller') sense = Math.abs(axis[2]) > 0.7 ? 1 : t3[0] * fit.pivot[0] + t3[1] * fit.pivot[1] >= 0 ? 1 : -1;
      else if (g.role === 'flywheel') sense = Math.abs(axis[2]) > 0.7 ? 1 : t3[0] >= 0 ? 1 : -1;
      axis = scale(axis, sense);
      part = { role: g.role, bodies, pivot: fit.pivot, axis, radius: fit.radius, deploy: 0, parent: -1, group: gi };
    }
    if (g.flip) part.axis = scale(part.axis, -1);
    if (g.corner !== undefined) part.corner = g.corner;
    index.set(gi, out.length);
    out.push(part);
  });
  // parents, once every part has its index; a chain that comes back on itself is cut where it closes
  for (const [gi, carrier] of rideOn) {
    const i = index.get(gi);
    const c = index.get(carrier);
    if (i !== undefined && c !== undefined) out[i].parent = c;
  }
  out.forEach((p, i) => {
    let at = p.parent;
    for (let n = 0; at >= 0 && n <= out.length; n++) {
      if (at === i) {
        p.parent = -1;
        break;
      }
      at = out[at].parent;
    }
  });
  // gearing: a part that follows another moves as it does, times the ratio (never itself, never a
  // loop: a follow that comes back round is dropped)
  motion.forEach((g, gi) => {
    const i = index.get(gi);
    const f = g.follows;
    if (i === undefined || !f || !Number.isFinite(f.ratio)) return;
    const j = index.get(f.group);
    if (j === undefined || j === i) return;
    out[i].follows = { index: j, ratio: Math.max(-100, Math.min(100, f.ratio)) };
  });
  out.forEach((p, i) => {
    let at = p.follows?.index;
    for (let n = 0; at !== undefined && n <= out.length; n++) {
      if (at === i) {
        delete p.follows;
        break;
      }
      at = out[at].follows?.index;
    }
  });
  return out;
}

/** a robot axis as a unit vector (MODEL frame: +x front, +y left, +z up) */
const ROBOT_AXIS: Readonly<Record<'forward' | 'left' | 'up', V3>> = { forward: [1, 0, 0], left: [0, 1, 0], up: [0, 0, 1] };

/**
 * A GENERIC JOINT as measured (`spin`, `swing`, `slide`). Its direction is a robot axis, or the picked
 * body's own: its round axle (`fitRound`) for a spin or a swing, its long side for a slide. Where it
 * turns about: a spin, its own axle through its bodies (`fitRound` along that direction); a swing, the
 * picked body's axle when there is one, else the end of the swinging part nearer the robot's middle
 * (an arm pivots at its root); a slide does not turn, and sits at its box's centre.
 */
function jointPart(modelParts: readonly MeshPart[], st: BodyStats, g: MotionGroup, gi: number, bodies: number[]): MotionPart | null {
  const role = g.role as 'spin' | 'swing' | 'slide';
  const amount = g.amount !== undefined && Number.isFinite(g.amount) && g.amount >= 0 ? g.amount : JOINT_DEFAULT_AMOUNT[role];
  const drive = g.drive ?? (role === 'spin' ? 'always' : 'intake');
  const ab = g.axis === 'part' && g.axisBody !== undefined && g.axisBody < st.n.length && st.n[g.axisBody] > 0 ? g.axisBody : null;
  const mo = setMoments(st, bodies);
  let axis: V3 | null = g.axis && g.axis !== 'part' ? ROBOT_AXIS[g.axis] : null;
  let pivot: V3 | null = null;
  if (ab !== null) {
    if (role === 'slide') {
      const v = eigenSym3(setMoments(st, [ab]).cov).vectors[0];
      const k = Math.abs(v[0]) >= Math.abs(v[1]) && Math.abs(v[0]) >= Math.abs(v[2]) ? 0 : Math.abs(v[1]) >= Math.abs(v[2]) ? 1 : 2;
      axis = snapAxis(v[k] < 0 ? scale(v, -1) : v);
    } else {
      const f = fitRound(modelParts, [ab]);
      if (f) {
        axis = f.axis;
        if (role === 'swing') pivot = f.pivot;
      }
    }
  }
  if (role === 'spin') {
    const f = fitRound(modelParts, bodies, axis ?? undefined);
    if (!f) return null;
    return { role, bodies, pivot: f.pivot, axis: axis ?? f.axis, radius: f.radius, deploy: 0, parent: -1, group: gi, drive, amount };
  }
  if (role === 'slide') {
    return { role, bodies, pivot: boxCentre(mo), axis: axis ?? [0, 0, 1], radius: 0, deploy: 0, parent: -1, group: gi, drive, amount };
  }
  // a swing: the hinge line
  const ax = axis ?? ROBOT_AXIS.left;
  if (!pivot) {
    // its long direction square to the hinge, and of its two ends the one nearer the robot's middle
    const v = eigenSym3(mo.cov).vectors;
    let d = v.map((w) => sub(w, scale(ax, dot(w, ax)))).reduce((best, w) => (Math.hypot(w[0], w[1], w[2]) > Math.hypot(best[0], best[1], best[2]) ? w : best));
    const dl = Math.hypot(d[0], d[1], d[2]);
    d = dl > 1e-6 ? scale(d, 1 / dl) : ([1, 0, 0] as V3);
    const c = boxCentre(mo);
    let lo = Infinity;
    let hi = -Infinity;
    eachVertex(modelParts, new Set(bodies), (x, y, z) => {
      const t = dot(sub([x, y, z], c), d);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    });
    const a = add(c, scale(d, lo));
    const b = add(c, scale(d, hi));
    pivot = Math.hypot(a[0], a[1]) <= Math.hypot(b[0], b[1]) ? a : b;
  }
  return { role, bodies, pivot, axis: ax, radius: 0, deploy: (amount * Math.PI) / 180, parent: -1, group: gi, drive, amount: (amount * Math.PI) / 180 };
}

/** a drive wheel turns about a LEVEL axle: the fit's own direction, laid flat */
function wheelAxisHint(parts: readonly MeshPart[], bodies: readonly number[]): V3 | undefined {
  const mo = setMoments(bodyStats(parts), bodies);
  if (mo.n < 3) return undefined;
  const a = roundAxis(mo.cov);
  const flat = norm([a[0], a[1], 0]);
  return Math.hypot(a[0], a[1]) > 0.2 ? snapAxis(flat, 12) : undefined;
}

/** every body of `group` and of the groups riding on it (what a pick highlights together) */
export function groupBodies(motion: readonly MotionGroup[], gi: number): number[] {
  return [...(motion[gi]?.bodies ?? [])];
}
