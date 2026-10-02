import type { Alliance, Artifact, RobotCommand, RobotSpec, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { clamp, datan2, dcos, dsin, hyp, rot, wrapAngle } from '../math';
import { classifierRect, goalCenter } from './field';
import { checkGoalEntry } from './goal';
import { collideBallRect, collideBallStatic, stepFlightBall } from './physics';
import { decodeImportLaunchZ, decodeImportTurret } from './importedMech';
import { flyExitSpeed, flyPlannedSpeed } from './flywheel';

/**
 * DECODE'S FIXED SHOOTER AND FIXED HOOD — the launcher that does not solve its own shot.
 *
 * Three build facts on the spec, each ABSENT on every robot built before they existed:
 *   · `launcher: 'fixed'` — bolted to the chassis: the artifact leaves along the chassis heading
 *     (an import: plus `mech.shooterYawDeg`), so the ROBOT is what aims;
 *   · `hoodDeg`           — one elevation, the hood's build angle;
 *   · `flywheel`          — a setpoint wheel (`src/sim/flywheel.ts`): one speed, or a few presets.
 * Whatever is NOT fixed is still solved: a fixed hood with a solved speed solves the speed for that
 * angle, a setpoint wheel under an adjustable hood solves the angle for that speed. With both
 * fixed nothing is solved at all, and the artifact flies the one arc the hardware throws — the
 * existing flight and `checkGoalEntry` decide whether it scores, unchanged.
 *
 * ⚠️ NONE OF THIS RUNS FOR A ROBOT WITHOUT ONE OF THE THREE (`decodeShotSpecial`). The turret that
 * solves everything keeps `aimSolution`/`fire` exactly as they were, and smoke pins it.
 */

/** does this spec have any part of a fixed shot? `false` = today's turret, byte-identically */
export function decodeShotSpecial(spec: RobotSpec): boolean {
  return spec.launcher === 'fixed' || spec.hoodDeg !== undefined || spec.flywheel !== undefined;
}

/** is the launcher bolted to the chassis? */
export function decodeFixedLauncher(spec: RobotSpec): boolean {
  return spec.launcher === 'fixed';
}

/** a fixed launcher's facing, rad CCW from chassis forward: an import's `mech.shooterYawDeg`,
 * otherwise straight ahead */
export function decodeFixedFacing(spec: RobotSpec): number {
  const y = spec.imported?.mech?.shooterYawDeg;
  return y === undefined ? 0 : (y * Math.PI) / 180;
}

/** the release height (the turret's, unchanged: `LAUNCH_HEIGHT`, an import's placed `z`) */
export function decodeLaunchZ(spec: RobotSpec): number {
  return spec.imported ? decodeImportLaunchZ(spec) : C.LAUNCH_HEIGHT;
}

/** the launcher's mount, robot-local — the turret's point (`turretWorldPos`'s offset) */
function launcherLocal(spec: RobotSpec): Vec2 {
  return spec.imported ? decodeImportTurret(spec) : { x: spec.length * C.TURRET_OFFSET_FRAC, y: 0 };
}

/** where the artifact leaves if the chassis were at `heading` */
function muzzleAt(r: RobotState, heading: number): Vec2 {
  const o = rot(launcherLocal(r.spec), heading);
  return { x: r.pos.x + o.x, y: r.pos.y + o.y };
}

/** the exact minimum-speed arc — `robot.ts`'s `solveShot`, restated so this file does not reach
 * back into the turret path it must leave alone */
function minSpeedShot(dd: number, dh: number): { speed: number; angle: number } {
  const reach = hyp(dd, dh);
  return { speed: Math.min(Math.sqrt(C.GRAVITY * (dh + reach)), C.LAUNCH_MAX_SPEED), angle: datan2(dh + reach, dd) };
}

/**
 * THE SHOT THIS BUILD PLANS for a horizontal distance `d` to the goal centre: the hood's angle or a
 * solved one, the wheel's PLANNED speed (its setpoint) or a solved one. Aim and the angle solve
 * plan around the setpoint; the release itself leaves at what the wheel is actually doing
 * (`decodeFixedRelease`).
 */
export function decodePlannedShot(r: RobotState, d: number): { speed: number; angle: number } {
  const lz = decodeLaunchZ(r.spec);
  const dh = C.GOAL_OPENING_Z - lz;
  const dd = Math.max(d, 0.5);
  const hood = r.spec.hoodDeg;
  if (r.spec.flywheel) {
    const v = flyPlannedSpeed(r);
    if (hood !== undefined) return { speed: v, angle: (hood * Math.PI) / 180 };
    // ADJUSTABLE HOOD, SETPOINT WHEEL: tan θ = (v² ± √(v⁴ − g(g·d² + 2·dh·v²))) / (g·d). The HIGH
    // root first (it arrives descending, over the goal face), the low one if the high is past the
    // hood's travel; no root at all is a target out of this wheel's reach, and the hood goes to
    // its longest throw so the shot falls honestly short.
    const g = C.GRAVITY;
    const disc = v * v * v * v - g * (g * dd * dd + 2 * dh * v * v);
    const lo = (C.DECODE_HOOD_MIN_DEG * Math.PI) / 180;
    const hi = (C.DECODE_HOOD_MAX_DEG * Math.PI) / 180;
    if (disc >= 0) {
      const high = datan2(v * v + Math.sqrt(disc), g * dd);
      if (high <= hi) return { speed: v, angle: Math.max(high, lo) };
      const low = datan2(v * v - Math.sqrt(disc), g * dd);
      return { speed: v, angle: clamp(low, lo, hi) };
    }
    return { speed: v, angle: (C.DECODE_HOOD_FALLBACK_DEG * Math.PI) / 180 };
  }
  if (hood !== undefined) {
    // FIXED HOOD, SOLVED SPEED: v² = g·d² / (2·cos²θ·(d·tanθ − dh)). Too close for the hood to
    // reach the opening at all (d·tanθ ≤ dh) has no answer; it throws the min-speed arc's speed
    // at its own angle and misses, which is what a speed table read past its end does.
    const th = (hood * Math.PI) / 180;
    const c = dcos(th);
    const s = dsin(th);
    const den = 2 * c * c * (dd * (s / c) - dh);
    const v = den > 0 ? Math.min(Math.sqrt((C.GRAVITY * dd * dd) / den), C.LAUNCH_MAX_SPEED) : minSpeedShot(dd, dh).speed;
    return { speed: v, angle: th };
  }
  return minSpeedShot(dd, dh);
}

/**
 * THE AIM: the world yaw the artifact should leave along, plus the planned speed and angle — and
 * for a FIXED launcher, the chassis heading that puts its facing on that yaw.
 *
 * Lead-compensated for the half of the chassis velocity a shot inherits
 * (`SHOT_ROBOT_VEL_INHERIT`), over the planned arc's own flight time. A fixed point solved in a
 * FIXED number of passes (no tolerance), because the muzzle of a fixed launcher moves with the
 * heading being solved for and a trip count that depended on a float comparison could differ
 * between a client's prediction and the server.
 */
export function decodeFixedAim(r: RobotState): { yaw: number; heading: number; speed: number; angle: number } {
  const g = goalCenter(r.alliance);
  const wv = { x: r.vel.x * C.SHOT_ROBOT_VEL_INHERIT, y: r.vel.y * C.SHOT_ROBOT_VEL_INHERIT };
  const fixed = decodeFixedLauncher(r.spec);
  const face = fixed ? decodeFixedFacing(r.spec) : 0;
  let heading = r.heading;
  let tx = g.x;
  let ty = g.y;
  let yaw = 0;
  let sol = { speed: 0, angle: 0 };
  for (let i = 0; i < 4; i++) {
    const m = muzzleAt(r, fixed ? heading : r.heading);
    sol = decodePlannedShot(r, hyp(tx - m.x, ty - m.y));
    const t = hyp(g.x - m.x, g.y - m.y) / Math.max(sol.speed * dcos(sol.angle), 1);
    tx = g.x - wv.x * t;
    ty = g.y - wv.y * t;
    yaw = datan2(ty - m.y, tx - m.x);
    heading = wrapAngle(yaw - face);
  }
  return { yaw, heading: fixed ? heading : r.heading, speed: sol.speed, angle: sol.angle };
}

/**
 * THE RELEASE THIS ROBOT WOULD MAKE NOW: where the artifact is born, at what height, and the
 * velocity it leaves with. A FIXED launcher leaves along where it is pointing (`turretHeading`,
 * which `updateRobotActions` keeps on the chassis facing); a turret along its aimed yaw. A setpoint
 * wheel leaves at the speed it is turning NOW, not its setpoint.
 */
export function decodeFixedRelease(r: RobotState): { origin: Vec2; z: number; vel: { x: number; y: number }; vz: number; speed: number } {
  const aim = decodeFixedAim(r);
  const origin = muzzleAt(r, r.heading);
  const speed = r.spec.flywheel ? flyExitSpeed(r) : aim.speed;
  const yaw = r.turretHeading;
  const c = dcos(aim.angle);
  return {
    origin,
    z: decodeLaunchZ(r.spec),
    vel: {
      x: dcos(yaw) * speed * c + r.vel.x * C.SHOT_ROBOT_VEL_INHERIT,
      y: dsin(yaw) * speed * c + r.vel.y * C.SHOT_ROBOT_VEL_INHERIT,
    },
    vz: speed * dsin(aim.angle),
    speed,
  };
}

/**
 * WOULD A RELEASE ENTER `alliance`'S GOAL — the world's flight stage run forward on a copy, in
 * the same order (`stepFlightBall`, `checkGoalEntry`, the goal face below `GOAL_WALL_TOP`, the
 * ground, then the low-flight classifier/wall pass), stopping at the first landing. Robots are not
 * in it: a shot that a robot would block is not a shot the launcher can know about.
 *
 * Pure: the artifact is a scratch copy and nothing in the world is written.
 */
export function decodeShotEnters(
  alliance: Alliance,
  origin: Vec2,
  z: number,
  vel: { x: number; y: number },
  vz: number,
  dt: number,
): boolean {
  if (!(dt > 0)) return false;
  const b: Artifact = {
    id: -1,
    color: 'purple',
    state: { kind: 'flight', target: alliance },
    pos: { x: origin.x, y: origin.y },
    vel: { x: vel.x, y: vel.y },
    z,
    vz,
  };
  const steps = Math.ceil(4 / dt);
  for (let i = 0; i < steps; i++) {
    const prevZ = b.z;
    stepFlightBall(b, dt);
    if (checkGoalEntry(undefined as unknown as World, b, prevZ)) {
      return b.state.kind === 'basin' && b.state.goal === alliance;
    }
    if (b.z < C.GOAL_WALL_TOP) collideBallStatic(b);
    if (b.z <= 0 && b.vz < 0) return false;
    if (b.z < C.BALL_RADIUS * 4) {
      if (b.z <= C.CLASSIFIER_HEIGHT) {
        collideBallRect(b, classifierRect('red'));
        collideBallRect(b, classifierRect('blue'));
      }
      collideBallStatic(b);
    }
  }
  return false;
}

/** will THIS robot's release, made now, score in its own goal? */
export function decodeFixedShotScores(r: RobotState, dt: number): boolean {
  const rel = decodeFixedRelease(r);
  return decodeShotEnters(r.alliance, rel.origin, rel.z, rel.vel, rel.vz, dt);
}

/**
 * THE AIM HOOK — the rotate override a FIXED launcher gets while the driver holds fire with aim
 * assist on, or `null` to leave the command alone. A P-controller on the heading error, dead-banded
 * by `DECODE_FIXED_AIM_TOL` so a robot already lined up holds still — BIOBUZZ's `bbAimAssist`, and
 * Chain Reaction's `chainAimAssist` before it. Never for a robot on an auto path (the path owns the
 * pose) or a passive dummy.
 */
export function decodeFixedAimAssist(r: RobotState, cmd: RobotCommand, enabled: boolean): number | null {
  if (!enabled || !cmd.fire || !r.aimAssist || r.autoPathActive || r.passive) return null;
  if (!decodeFixedLauncher(r.spec)) return null;
  const err = wrapAngle(decodeFixedAim(r).heading - r.heading);
  if (Math.abs(err) < C.DECODE_FIXED_AIM_TOL) return 0;
  return clamp(err * C.DECODE_FIXED_AIM_GAIN, -1, 1);
}

/** is a FIXED launcher's chassis on its aim heading (within `DECODE_FIXED_AIM_TOL`)? */
export function decodeFixedOnTarget(r: RobotState): boolean {
  return Math.abs(wrapAngle(decodeFixedAim(r).heading - r.heading)) < C.DECODE_FIXED_AIM_TOL;
}
