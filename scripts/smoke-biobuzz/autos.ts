import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alliance, Artifact, RobotCommand, World } from '../../src/types';
import { PRE_COUNTDOWN as C_PRE, SIM_DT } from '../../src/config';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { BB_FLOWERS, BB_POLLEN_R, BB_RAMP_DEPLOY_S } from '../../src/games/biobuzz/config';
import { bbFootprint, bbRampSettled } from '../../src/games/biobuzz/robot';
import { BIOBUZZ_AUTO_COMMANDS } from '../../src/games/biobuzz/auto';
import type { RobotSpec } from '../../src/types';
import { startMatch } from '../../src/sim/match';
import { coerceSetup, type RobotSetup } from '../../src/sim/spawn';
import { driveParams } from '../../src/sim/drivetrain';
import { localizeCommand } from '../../src/net/protocol';
import { GAME_IDS } from '../../src/games/types';
import { simModuleFor } from '../../src/games/sim';
import { autoAdapterFor, autoStartPose, createAutoSeat, type AutoSeat } from '../../src/auto/zenithAutos';
import { ZENITH_AUTO_MAX_BYTES } from '../../src/auto/coerce';
import type { ZenithAutoSetup } from '../../src/auto/types';
import { cmd, setup, type Check } from './harness';
import { Room, type Client } from '../../server/room';
import { CLIENT_CAPS, type ServerMsg } from '../../src/net/protocol';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { DEFAULT_ASSISTS } from '../../src/sim/spawn';

/**
 * THE AUTO LANE — Zenith autos driven by an auto seat (docs/area/autos.md).
 *
 * The property this lane exists for is the one the old `.pp` follower broke: an auto DRIVES the
 * robot. Every tick of every run below is checked against the drivetrain's own limits, so a pose
 * or a heading written from outside the drivetrain (the heading snap the owner reported) fails
 * here by name. Around it: the robot gets where the file says, each heading mode is held, the
 * alliance rule is the robot runtime's, the commands work the mechanisms, a replay needs no
 * seat, and the seat lets go at the buzzer and in Free Drive.
 *
 * Paths stay in open field on the BLUE side (x > 30, away from the HIVE frame and the FLOWERS),
 * so what is measured is the follower and the drivetrain, not a collision.
 */

const here = dirname(fileURLToPath(import.meta.url));
const adapter = autoAdapterFor('biobuzz');

/** A build with the deployable ramp intake, everything else the default. */
const RAMP_BUILD: Partial<RobotSpec> = {
  ...BB_DEFAULT_SPEC,
  intakeMount: 'front',
  bbMech: { ...BB_DEFAULT_SPEC.bbMech, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
};

interface Pose {
  xIn: number;
  yIn: number;
  headingRad?: number;
}

/** A BLUE-side routine from the TOP · SIDE WALL anchor (63.17, 45, pi). */
function probeAuto(alliance: 'RED' | 'BLUE' = 'BLUE'): Record<string, unknown> {
  return {
    formatVersion: 3,
    name: 'lane-probe',
    alliance,
    start: { pose: { xIn: 61.6, yIn: 45, headingRad: Math.PI } },
    steps: [
      {
        id: 'line',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 40, yIn: 45 } }],
        heading: { mode: 'constant', headingRad: Math.PI },
      },
      {
        id: 'turn',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 40, yIn: 30 } }],
        heading: { mode: 'linear', fromRad: Math.PI, toRad: -Math.PI / 2 },
      },
      {
        id: 'curve',
        kind: 'path',
        segments: [
          { kind: 'bezier', from: 'current', control: [{ xIn: 40, yIn: 0 }, { xIn: 50, yIn: -10 }], to: { xIn: 50, yIn: -40 } },
        ],
        heading: { mode: 'tangent' },
      },
      {
        id: 'face',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 36, yIn: -30 } }],
        heading: { mode: 'facePoint', xIn: 12.75, yIn: 0 },
      },
      {
        id: 'back',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 50, yIn: -10 } }],
        heading: { mode: 'tangentReversed' },
      },
    ],
  };
}

const zen = (auto: Record<string, unknown>, waypoints?: string): ZenithAutoSetup => ({
  auto: JSON.stringify(auto),
  ...(waypoints ? { waypoints } : {}),
});

/** A match world with robot 0 seated where the auto starts, and its seat. */
function stage(
  z: ZenithAutoSetup,
  alliance: Alliance,
  physics: '2d' | '3d',
  extra: Partial<RobotSetup> = {},
): { world: World; seat: AutoSeat; setup: RobotSetup } {
  if (!adapter) throw new Error('BIOBUZZ has no auto adapter');
  const base = { ...setup(0, alliance, {}, 2), zenithAuto: z, ...extra };
  // seat the robot at the auto's start through the same canonical conversion the match setup uses
  const probeWorld = BIOBUZZ_SIM.createWorld('match', 7, [base], undefined, physics);
  const probe = createAutoSeat(probeWorld, 0, z, adapter);
  const s: RobotSetup = probe.loaded ? { ...base, startPose: autoStartPose(probe.loaded, alliance, adapter) } : base;
  const world = BIOBUZZ_SIM.createWorld('match', 7, [s], undefined, physics);
  return { world, seat: createAutoSeat(world, 0, z, adapter), setup: s };
}

interface Log {
  ticks: number;
  /** the largest per-tick heading change, rad, and the per-tick position change, in */
  maxDh: number;
  maxDp: number;
  commands: RobotCommand[];
  /** the pose at the end of each step, by step id */
  stepEnds: Map<string, { x: number; y: number; h: number }>;
  /** every pose, for the cross-track check */
  poses: { x: number; y: number; step: string | null }[];
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Tick the seat into the step, the way the controller does, until done or `maxS`. */
function drive(world: World, seat: AutoSeat, maxS: number, driver: RobotCommand = cmd({})): Log {
  const commands = new Map<number, RobotCommand>();
  const log: Log = { ticks: 0, maxDh: 0, maxDp: 0, commands: [], stepEnds: new Map(), poses: [] };
  let prev = { x: world.robots[0].pos.x, y: world.robots[0].pos.y, h: world.robots[0].heading };
  let step: string | null = null;
  for (let i = 0; i < Math.round(maxS / SIM_DT); i++) {
    const c = localizeCommand(seat.step(world, driver));
    commands.set(0, c);
    log.commands.push(c);
    world.events.length = 0;
    BIOBUZZ_SIM.step(world, SIM_DT, commands);
    const r = world.robots[0];
    log.maxDh = Math.max(log.maxDh, Math.abs(wrap(r.heading - prev.h)));
    log.maxDp = Math.max(log.maxDp, Math.hypot(r.pos.x - prev.x, r.pos.y - prev.y));
    prev = { x: r.pos.x, y: r.pos.y, h: r.heading };
    const now = seat.status().stepId;
    if (step !== null && now !== step) log.stepEnds.set(step, prev);
    step = now;
    log.poses.push({ x: r.pos.x, y: r.pos.y, step: now });
    log.ticks++;
    if (seat.status().state === 'done') break;
  }
  if (step !== null) log.stepEnds.set(step, prev);
  return log;
}

function pollen(world: World, x: number, y: number): Artifact {
  const b: Artifact = {
    id: 9000 + world.balls.length,
    color: 'yellow',
    r: BB_POLLEN_R,
    state: { kind: 'ground' },
    pos: { x, y },
    vel: { x: 0, y: 0 },
    z: 0,
    vz: 0,
  };
  world.balls.push(b);
  return b;
}

export function autoChecks(check: Check): void {
  check('AUTO: BIOBUZZ has an auto adapter', adapter !== null);
  if (!adapter) return;

  // ── the seam: the main-chunk flag and the lazy registry agree, for every game ─────────────
  for (const g of GAME_IDS) {
    check(
      `AUTO: ${g}'s zenithAutos flag matches the auto registry`,
      (simModuleFor(g).zenithAutos === true) === (autoAdapterFor(g) !== null),
    );
  }
  // ── the field DSIM hands Zenith: positions move with DSIM's walls, sizes do not ─────────────
  {
    const field = adapter.field() as {
      sizeIn: { xIn: number };
      zones: Array<{ id: string; minXIn: number }>;
      elements: Array<{ id: string; xIn: number; radiusIn?: number }>;
    };
    const wall = -field.sizeIn.xIn / 2;
    const zone = field.zones.find((z) => z.id === 'loadingZoneRed');
    check(
      "AUTO: the handed field's red loading zone starts at DSIM's wall, not at Zenith's 72",
      zone !== undefined && Math.abs(zone.minXIn - wall) < 1e-3,
      `minXIn ${String(zone?.minXIn)}, wall ${String(wall)}`,
    );
    const pollen = field.elements.find((e) => e.id === 'gardenRed0');
    check(
      "AUTO: the handed field moves a garden pollen inside DSIM's wall and keeps its radius",
      pollen !== undefined && pollen.xIn > -70.6 && pollen.radiusIn === 1.4,
      `xIn ${String(pollen?.xIn)}, radiusIn ${String(pollen?.radiusIn)}`,
    );
  }

  const text = JSON.stringify(probeAuto());
  const kept = coerceSetup({ ...setup(0, 'blue'), zenithAuto: { auto: text } }, 'biobuzz');
  check('AUTO: coerceSetup keeps a BIOBUZZ auto byte for byte', kept.zenithAuto?.auto === text);
  const decode = coerceSetup({ ...setup(0, 'blue'), zenithAuto: { auto: text } }, 'decode');
  check('AUTO: coerceSetup drops a Zenith auto for a game that cannot play one', decode.zenithAuto === undefined);
  const huge = coerceSetup({ ...setup(0, 'blue'), zenithAuto: { auto: 'x'.repeat(ZENITH_AUTO_MAX_BYTES + 1) } }, 'biobuzz');
  check('AUTO: coerceSetup drops an auto over the byte bound', huge.zenithAuto === undefined);

  // ── a bad file drives nothing and says why ────────────────────────────────────────────────
  {
    const { world, seat } = stage({ auto: '{"formatVersion": 3, "name": "x"' }, 'blue', '2d');
    startMatch(world);
    const driver = cmd({ driveY: 0.5 });
    const out = seat.step(world, driver);
    const st = seat.status();
    check('AUTO: a malformed file reports an error and hands the driver through', st.state === 'error' && out === driver, st.error);
  }

  // ── it drives, never teleports, and gets there: both physics ──────────────────────────────
  for (const physics of ['2d', '3d'] as const) {
    const { world, seat } = stage(zen(probeAuto()), 'blue', physics);
    const dp = driveParams(world.robots[0].spec);
    const r0 = world.robots[0];
    check(
      `AUTO ${physics}: the robot is seated at the auto's start pose`,
      Math.hypot(r0.pos.x - 61.6, r0.pos.y - 45) < 0.6 && Math.abs(wrap(r0.heading - Math.PI)) < 0.01,
      `at (${r0.pos.x.toFixed(2)}, ${r0.pos.y.toFixed(2)}, ${r0.heading.toFixed(3)})`,
    );
    startMatch(world);
    const log = drive(world, seat, 12);
    const st = seat.status();
    check(`AUTO ${physics}: the routine finishes inside the AUTO period`, st.state === 'done' && log.ticks * SIM_DT < 30, `${st.state} after ${(log.ticks * SIM_DT).toFixed(2)} s`);
    // THE NO-TELEPORT PROPERTY. The drivetrain turns at most maxTurn and drives at most
    // maxSpeed; 5 % covers a contact-free Rapier solve's rounding. A heading written from
    // outside the drivetrain is a jump of whatever the snap was, and fails this at once.
    check(
      `AUTO ${physics}: the heading never moves faster than the drivetrain turns (no heading teleport)`,
      log.maxDh <= dp.maxTurn * SIM_DT * 1.05,
      `max ${log.maxDh.toFixed(4)} rad/tick, limit ${(dp.maxTurn * SIM_DT).toFixed(4)}`,
    );
    check(
      `AUTO ${physics}: the robot never moves faster than the drivetrain drives (no pose teleport)`,
      log.maxDp <= dp.maxSpeed * SIM_DT * 1.05,
      `max ${log.maxDp.toFixed(3)} in/tick, limit ${(dp.maxSpeed * SIM_DT).toFixed(3)}`,
    );
    const plan = seat.loaded!.plan;
    for (const ps of plan.steps) {
      const end = log.stepEnds.get(ps.id);
      const want = ps.endPose;
      if (!end || !want) {
        check(`AUTO ${physics}: step "${ps.id}" ran`, false);
        continue;
      }
      // Pedro hands over at t = 0.975 while still moving, so an intermediate end is judged
      // loosely; the LAST step is followed by the hold, and is judged at the end of the run.
      // The heading bound is the looser one: a P-only heading loop (the robot's measured 2.52
      // power/rad) lags a sweep by about rate / (P * maxTurn), and a 90° linear sweep over a
      // 15 in leg hands over ~11° short — on the robot too — and finishes the turn on the next leg.
      const last = ps === plan.steps[plan.steps.length - 1];
      const r = world.robots[0];
      const at = last ? { x: r.pos.x, y: r.pos.y, h: r.heading } : end;
      const dPos = Math.hypot(at.x - want.xIn, at.y - want.yIn);
      const dH = Math.abs(wrap(at.h - (want.headingRad ?? 0)));
      check(
        `AUTO ${physics}: step "${ps.id}" ends where the plan does`,
        last ? dPos < 1 && dH < 0.05 : dPos < 4 && dH < 0.25,
        `${dPos.toFixed(2)} in and ${((dH * 180) / Math.PI).toFixed(1)}° off`,
      );
    }
    // cross-track on the curve: every pose within 3 in of the planned samples
    const curve = plan.steps.find((s) => s.id === 'curve')!;
    let worst = 0;
    for (const p of log.poses) {
      if (p.step !== 'curve') continue;
      let best = Infinity;
      for (const s of curve.samples) best = Math.min(best, Math.hypot(s.pose.xIn - p.x, s.pose.yIn - p.y));
      worst = Math.max(worst, best);
    }
    check(`AUTO ${physics}: the bezier leg stays within 3 in of the planned curve`, worst < 3, `worst ${worst.toFixed(2)} in`);
  }

  // ── the alliance rule: mirror iff the robot plays the other alliance ─────────────────────
  {
    const blue = stage(zen(probeAuto('BLUE')), 'blue', '2d');
    const red = stage(zen(probeAuto('BLUE')), 'red', '2d');
    const redFile = stage(zen(probeAuto('RED')), 'red', '2d');
    check('AUTO: a BLUE file on a BLUE robot is not mirrored', blue.seat.loaded?.mirrored === false);
    check('AUTO: a BLUE file on a RED robot is mirrored', red.seat.loaded?.mirrored === true);
    check('AUTO: a RED file on a RED robot is not mirrored twice', redFile.seat.loaded?.mirrored === false);
    startMatch(blue.world);
    startMatch(red.world);
    drive(blue.world, blue.seat, 12);
    drive(red.world, red.seat, 12);
    const b = blue.world.robots[0];
    const r = red.world.robots[0];
    const dPos = Math.hypot(r.pos.x + b.pos.x, r.pos.y + b.pos.y);
    const dH = Math.abs(wrap(r.heading - (b.heading + Math.PI)));
    check(
      'AUTO: the RED run ends at the point mirror of the BLUE run, heading included',
      dPos < 0.5 && dH < 0.02,
      `${dPos.toFixed(3)} in, ${dH.toFixed(4)} rad`,
    );
  }

  // ── determinism, and a replay needs no seat ──────────────────────────────────────────────
  {
    const a = stage(zen(probeAuto()), 'blue', '2d');
    const b = stage(zen(probeAuto()), 'blue', '2d');
    startMatch(a.world);
    startMatch(b.world);
    const la = drive(a.world, a.seat, 6);
    drive(b.world, b.seat, 6);
    const ra = a.world.robots[0];
    const rb = b.world.robots[0];
    check('AUTO: two runs of one auto are identical', ra.pos.x === rb.pos.x && ra.pos.y === rb.pos.y && ra.heading === rb.heading);
    // replay: the recorded commands, stepped with no seat, give the same world
    const replay = BIOBUZZ_SIM.createWorld('match', 7, [a.setup], undefined, '2d');
    startMatch(replay);
    const map = new Map<number, RobotCommand>();
    for (const c of la.commands) {
      map.set(0, c);
      replay.events.length = 0;
      BIOBUZZ_SIM.step(replay, SIM_DT, map);
    }
    const rr = replay.robots[0];
    check(
      'AUTO: replaying the recorded commands with NO seat reproduces the run',
      rr.pos.x === ra.pos.x && rr.pos.y === ra.pos.y && rr.heading === ra.heading,
      `replay (${rr.pos.x}, ${rr.pos.y}) vs run (${ra.pos.x}, ${ra.pos.y})`,
    );
  }

  // ── commands work the mechanisms ─────────────────────────────────────────────────────────
  {
    const auto = {
      ...probeAuto(),
      steps: [
        { id: 'two', kind: 'command', name: 'shootAll', args: { count: 2 } },
        { id: 'hold', kind: 'wait', seconds: 1 },
      ],
    };
    const { world, seat } = stage(zen(auto), 'blue', '2d');
    const before = world.robots[0].hopper.length;
    startMatch(world);
    drive(world, seat, 6);
    const after = world.robots[0].hopper.length;
    check('AUTO: shootAll count:2 launches exactly two of the preload', before >= 2 && before - after === 2, `hopper ${before} -> ${after}`);
  }
  {
    // an intake leg: FORWARD at t = 0 through two pollen lying on the line, then STOP
    const auto = {
      ...probeAuto(),
      steps: [
        { id: 'empty', kind: 'command', name: 'shootAll', args: { count: 4 } },
        {
          id: 'sweep',
          kind: 'path',
          speedFraction: 0.4,
          segments: [{ kind: 'line', from: 'current', to: { xIn: 34, yIn: 45 } }],
          heading: { mode: 'constant', headingRad: Math.PI },
          markers: [{ at: { t: 0 }, command: { name: 'setIntake', args: { side: 'BOTH', state: 'FORWARD' } } }],
        },
        { id: 'stop', kind: 'command', name: 'setIntake', args: { side: 'BOTH', state: 'STOP' } },
      ],
    };
    const { world, seat } = stage(zen(auto), 'blue', '2d');
    startMatch(world);
    // empty the hopper first, then lay the pollen once the shots are gone
    let placed = false;
    const commands = new Map<number, RobotCommand>();
    let intakeHeld = false;
    for (let i = 0; i < 60 * 10; i++) {
      if (!placed && world.robots[0].hopper.length === 0 && seat.status().stepId === 'sweep') {
        pollen(world, 45, 45);
        pollen(world, 40, 45);
        placed = true;
      }
      const c = localizeCommand(seat.step(world, cmd({})));
      if (c.intake) intakeHeld = true;
      commands.set(0, c);
      world.events.length = 0;
      BIOBUZZ_SIM.step(world, SIM_DT, commands);
      if (seat.status().state === 'done') break;
    }
    const got = world.robots[0].hopper.length;
    check('AUTO: a setIntake FORWARD marker runs the intake and collects the pollen on the path', placed && intakeHeld && got >= 1, `placed ${placed}, intake ${intakeHeld}, holds ${got}`);
    const last = seat.step(world, cmd({}));
    check('AUTO: setIntake STOP lets go of the intake', last.intake === false);
  }
  {
    // an end condition the host reads: hopperEmpty is already true, so the leg ends at once
    const auto = {
      ...probeAuto(),
      steps: [
        { id: 'empty', kind: 'command', name: 'shootAll', args: { count: 4 } },
        {
          id: 'cut',
          kind: 'path',
          segments: [{ kind: 'line', from: 'current', to: { xIn: 34, yIn: 45 } }],
          heading: { mode: 'constant', headingRad: Math.PI },
          endCondition: { condition: 'hopperEmpty' },
        },
      ],
    };
    const { world, seat } = stage(zen(auto), 'blue', '2d');
    startMatch(world);
    drive(world, seat, 6);
    const cut = seat.trace()?.steps.find((s) => s.id === 'cut');
    check('AUTO: an endCondition that reads true cuts the path at once', cut?.conditionFired === true && world.robots[0].pos.x > 55, `x ${world.robots[0].pos.x.toFixed(1)}`);
  }

  // ── setRamp: the driver's RAMP toggle, pressed by the auto (DSIM only; the robot has no ramp) ─
  {
    check('AUTO: setRamp is a command the BIOBUZZ adapter runs', (BIOBUZZ_AUTO_COMMANDS as readonly string[]).includes('setRamp') && adapter.commands.includes('setRamp'));
    type Cmd = { name: string; summary?: string; params?: { state?: { type: string; values?: string[] } }; requires?: string[] };
    for (const [label, spec] of [
      ['a ramp build', { ...BB_DEFAULT_SPEC, ...RAMP_BUILD }],
      ['a build without a ramp', BB_DEFAULT_SPEC],
    ] as const) {
      const file = adapter.robot(spec as RobotSpec) as { commands: Cmd[] };
      const c = file.commands.find((x) => x.name === 'setRamp');
      check(
        `AUTO: the robot file handed to Zenith lists setRamp with a DEPLOY/STOW state, for ${label}`,
        c !== undefined && c.params?.state?.type === 'enum' && c.params.state.values?.join() === 'DEPLOY,STOW' && !!c.summary && !(c.requires ?? []).includes('intake'),
        JSON.stringify(c),
      );
    }
    const rampAuto = {
      ...probeAuto(),
      steps: [
        { id: 'deploy', kind: 'command', name: 'setRamp', args: { state: 'DEPLOY' } },
        { id: 'hold', kind: 'wait', seconds: 0.5 },
        { id: 'stow', kind: 'command', name: 'setRamp', args: { state: 'STOW' } },
        { id: 'again', kind: 'command', name: 'setRamp', args: { state: 'STOW' } },
      ],
    };
    for (const physics of ['2d', '3d'] as const) {
      const { world, seat } = stage(zen(rampAuto), 'blue', physics, { spec: { ...BB_DEFAULT_SPEC, ...RAMP_BUILD } as RobotSpec });
      // SCHEMA is Zenith's "robot.json does not register this command" (the probe's start pose is
      // tuned for the default footprint, so its start-legality finding is not this check's business)
      const errors = seat.loaded?.findings.filter((f) => f.code === 'SCHEMA') ?? [];
      check(`AUTO ${physics}: a setRamp auto has no Zenith SCHEMA finding on a ramp build, and nothing is listed against it`, seat.loaded !== null && errors.length === 0 && seat.loaded.unsupported.length === 0 && seat.loaded.notOnRobot.length === 0, errors.map((f) => f.message).join(' | '));
      startMatch(world);
      const r = world.robots[0];
      const x0 = r.pos.x;
      const commands = new Map<number, RobotCommand>();
      let deployedAtHold: boolean | null = null;
      let pressedTicks = 0;
      let lastCmd: RobotCommand | null = null;
      for (let i = 0; i < 60 * 3 && seat.status().state !== 'done'; i++) {
        const c = localizeCommand(seat.step(world, cmd({})));
        if (c.bbRamp) pressedTicks++;
        if (deployedAtHold === null && seat.status().stepId === 'hold') deployedAtHold = bbRampSettled(r, world.time);
        commands.set(0, c);
        lastCmd = c;
        world.events.length = 0;
        BIOBUZZ_SIM.step(world, SIM_DT, commands);
      }
      const t = seat.trace()?.steps ?? [];
      const dep = t.find((s) => s.id === 'deploy');
      const again = t.find((s) => s.id === 'again');
      check(`AUTO ${physics}: setRamp DEPLOY presses the RAMP button and ends with the ramp deployed and settled`, deployedAtHold === true && pressedTicks >= 2, `settled at the wait ${String(deployedAtHold)}, pressed ${pressedTicks} ticks`);
      check(
        `AUTO ${physics}: ...taking the swing and no more (about ${BB_RAMP_DEPLOY_S} s)`,
        dep !== undefined && dep.endS - dep.startS >= BB_RAMP_DEPLOY_S - 1e-6 && dep.endS - dep.startS <= BB_RAMP_DEPLOY_S + 0.15,
        dep ? `${(dep.endS - dep.startS).toFixed(3)} s` : 'no trace step',
      );
      check(`AUTO ${physics}: setRamp STOW folds it again, and the routine finishes`, seat.status().state === 'done' && r.bbRampOut === false && bbRampSettled(r, world.time) === false, `${seat.status().state}, out ${String(r.bbRampOut)}`);
      check(`AUTO ${physics}: setRamp STOW on a stowed ramp ends at once and presses nothing`, again !== undefined && again.endS - again.startS <= SIM_DT + 1e-6 && lastCmd?.bbRamp !== true, again ? `${(again.endS - again.startS).toFixed(3)} s` : 'no trace step');
      check(`AUTO ${physics}: setRamp never moves the robot`, Math.abs(r.pos.x - x0) < 0.25, `moved ${(r.pos.x - x0).toFixed(3)} in`);
    }
    {
      // THE POINT OF IT: an auto that deploys the ramp and drives into a FLOWER pulls POLLEN out
      // (the match's own staged columns, F3 on BLUE's right wall). The path ends 1 in past flush so
      // the follower keeps pressing, the way a driver holds the stick; the same run WITHOUT the
      // deploy takes nothing, so the extraction is the command's doing and not the drive's.
      // Measured 2026-09-27 over four approaches (lateral -1.5…+1 in, speed 0.35…1.0, 14…20 in
      // out): all four took all four POLLEN in both physics, the first one 0.65…1.17 s in.
      const f = BB_FLOWERS[2];
      const spec = { ...BB_DEFAULT_SPEC, ...RAMP_BUILD } as RobotSpec;
      const foot = bbFootprint(spec).front;
      const flowerAuto = (deploy: boolean): Record<string, unknown> => ({
        formatVersion: 3,
        name: 'lane-ramp-flower',
        alliance: 'BLUE',
        start: { pose: { xIn: f.x - foot - 14, yIn: f.y + 1, headingRad: 0 } },
        steps: [
          ...(deploy ? [{ id: 'deploy', kind: 'command', name: 'setRamp', args: { state: 'DEPLOY' } }] : []),
          { id: 'on', kind: 'command', name: 'setIntake', args: { side: 'BOTH', state: 'FORWARD' } },
          {
            id: 'in',
            kind: 'path',
            speedFraction: 0.8,
            segments: [{ kind: 'line', from: 'current', to: { xIn: f.x - foot + 1, yIn: f.y + 1 } }],
            heading: { mode: 'constant', headingRad: 0 },
          },
        ],
      });
      const extract = (physics: '2d' | '3d', deploy: boolean): { got: number; out: boolean } => {
        const { world, seat } = stage(zen(flowerAuto(deploy)), 'blue', physics, { spec });
        const r = world.robots[0];
        r.hopper.length = 0; // staging, before the match: an empty hopper so the intake can take
        startMatch(world);
        drive(world, seat, 3);
        return { got: r.hopper.length, out: r.bbRampOut === true };
      };
      for (const physics of ['2d', '3d'] as const) {
        const q = extract(physics, true);
        check(`AUTO ${physics}: an auto that runs setRamp DEPLOY and drives into a FLOWER pulls POLLEN out of it`, q.got >= 1 && q.out, `hopper ${q.got}, ramp out ${q.out}`);
      }
      const none = extract('2d', false);
      check('AUTO 2d: ...and the same drive with the ramp left folded takes nothing', none.got === 0 && !none.out, `hopper ${none.got}`);
    }
    {
      // NO RAMP: done at once, the button never pressed, and the panel says why
      const { world, seat } = stage(zen(rampAuto), 'blue', '2d');
      const why = seat.loaded?.notOnRobot.find((c) => c.name === 'setRamp');
      check('AUTO: on a build without a ramp the panel lists setRamp as not on this robot, and not as unknown to DSIM', why !== undefined && /no ramp/.test(why.why) && seat.loaded?.unsupported.length === 0, JSON.stringify(seat.loaded?.notOnRobot));
      startMatch(world);
      let pressed = false;
      const log = drive(world, seat, 3);
      for (const c of log.commands) if (c.bbRamp) pressed = true;
      const dep = seat.trace()?.steps.find((s) => s.id === 'deploy');
      check(
        'AUTO: on a build without a ramp setRamp ends at once, presses nothing, and the routine carries on',
        seat.status().state === 'done' && !pressed && dep !== undefined && dep.endS - dep.startS <= SIM_DT + 1e-6 && world.robots[0].bbRampOut === undefined,
        `${seat.status().state}, pressed ${pressed}, took ${dep ? (dep.endS - dep.startS).toFixed(3) : '?'} s`,
      );
    }
  }

  // ── the buzzer and Free Drive: the seat lets go ─────────────────────────────────────────
  {
    const { world, seat } = stage(zen(probeAuto()), 'blue', '2d');
    const driver = cmd({ driveX: 0.25, driveY: -0.5, rotate: 0.1 });
    check('AUTO: before AUTO the seat hands the driver through', seat.step(world, driver) === driver);
    startMatch(world);
    check('AUTO: in AUTO the seat drives', seat.step(world, driver) !== driver);
    world.match.phase = 'teleop';
    check('AUTO: from TELEOP the driver drives again', seat.step(world, driver) === driver && seat.status().state === 'stopped');
  }
  {
    const s = { ...setup(0, 'blue', {}, 2), zenithAuto: zen(probeAuto()) };
    const world = BIOBUZZ_SIM.createWorld('free', 7, [s], undefined, '2d');
    const seat = createAutoSeat(world, 0, s.zenithAuto, adapter);
    const driver = cmd({ driveY: 0.5 });
    check('AUTO: in Free Drive an unarmed seat never drives (the old .pp freeze)', world.match.phase === 'freeplay' && seat.step(world, driver) === driver);
    seat.arm();
    check('AUTO: in Free Drive an armed seat plays the auto', seat.step(world, driver) !== driver && seat.status().state === 'running');
  }

  // ── the demo routine: a whole AUTO cycle on DSIM's field, Zenith-clean ─────────────────────
  {
    const auto = readFileSync(join(here, 'fixtures', 'zenith', 'garden-cycle.auto.json'), 'utf8');
    const { world, seat } = stage({ auto }, 'red', '2d');
    const errors = seat.loaded?.findings.filter((f) => f.severity === 'error') ?? [];
    check('AUTO: garden-cycle plans with no Zenith errors against the DSIM robot and field', seat.loaded !== null && errors.length === 0, errors.map((f) => `${f.code}: ${f.message}`).join(' | '));
    startMatch(world);
    let most = 0;
    let fired = 0;
    const commands = new Map<number, RobotCommand>();
    for (let i = 0; i < 60 * 30 && seat.status().state !== 'done'; i++) {
      const before = world.robots[0].hopper.length;
      commands.set(0, localizeCommand(seat.step(world, cmd({}))));
      world.events.length = 0;
      BIOBUZZ_SIM.step(world, SIM_DT, commands);
      const after = world.robots[0].hopper.length;
      if (after < before) fired += before - after;
      most = Math.max(most, after);
    }
    const r = world.robots[0];
    const inZone = r.pos.x < -59.101 + 9 && r.pos.y > 23.907 - 9 && r.pos.y < 46.599 + 9;
    check(
      'AUTO: garden-cycle finishes inside AUTO, fires the preload, collects in the garden and ends at the loading zone',
      seat.status().state === 'done' && fired >= 5 && inZone,
      `state ${seat.status().state}, fired ${fired}, end (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)})`,
    );
  }

  // ── CUSTOM ROOMS: the server drives the robot (owner, 2026-09-25: custom only) ────────────
  {
    const mk = (id: string, alliance: Alliance, sink: ServerMsg[]): Client => ({
      id,
      send: (m) => sink.push(JSON.parse(JSON.stringify(m)) as ServerMsg),
      player: {
        clientId: id,
        name: id,
        teamName: 'Smoke',
        teamNumber: 1,
        alliance,
        startIndex: 0,
        ready: true,
        spec: { ...BB_DEFAULT_SPEC },
        assists: { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: false },
      },
      connected: true,
      disconnectAt: 0,
      caps: CLIENT_CAPS,
    });
    const auto = readFileSync(join(here, 'fixtures', 'zenith', 'garden-cycle.auto.json'), 'utf8');
    const seen: ServerMsg[] = [];
    const room = new Room('auto-cust', () => {}, { kind: 'versus', game: 'biobuzz', physics: '2d' });
    room.add(mk('au-a', 'red', seen));
    room.onMessage('au-a', { t: 'zenithAuto', auto: { auto } });
    const roster = [...seen].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }> | undefined;
    check('AUTO room: the roster names the auto, and carries no file', roster?.players[0]?.autoName === 'garden-cycle' && !JSON.stringify(roster).includes('"steps"'), JSON.stringify(roster?.players[0]?.autoName));
    // a BIOBUZZ room is 3D on the server whatever it asks for, so it waits for the seat's 3D chunk
    room.onMessage('au-a', { t: 'physicsReady' });
    room.onMessage('au-a', { t: 'start' });
    const start = seen.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
    const mine = start?.setups.find((x) => x.id === 0);
    check('AUTO room: the match setup carries the auto', mine?.zenithAuto?.auto === auto);
    const world = (room as unknown as { world: World }).world;
    const r = world.robots[0];
    check(
      'AUTO room: the robot is seated at the auto’s start (a RED file, a RED robot)',
      Math.hypot(r.pos.x + 34, r.pos.y + 63.17) < 1 && Math.abs(wrap(r.heading - Math.PI / 2)) < 0.02,
      `(${r.pos.x.toFixed(2)}, ${r.pos.y.toFixed(2)}, ${r.heading.toFixed(3)})`,
    );
    // no input is ever sent: the server's own seat has to drive it
    room.advanceForTest(Math.round((C_PRE + 9) / SIM_DT));
    const moved = Math.hypot(world.robots[0].pos.x + 34, world.robots[0].pos.y + 63.17);
    check('AUTO room: with no input from the client, the SERVER’s seat drives the robot through AUTO', world.match.phase === 'auto' && moved > 20 && world.robots[0].hopper.length < 4, `phase ${world.match.phase}, moved ${moved.toFixed(1)} in, hopper ${world.robots[0].hopper.length}`);
    room.advanceForTest(1);
  }
  {
    // a RECORD room refuses one, with a line that says why, and its roster names nothing
    const seen: ServerMsg[] = [];
    const rec = new Room('auto-rec', () => {}, { kind: 'record', record: 'solo', game: 'biobuzz' });
    rec.add({
      id: 'au-r',
      send: (m) => seen.push(m),
      player: { clientId: 'au-r', name: 'r', teamName: 'S', teamNumber: 1, alliance: 'blue', startIndex: 0, ready: true, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
      connected: true,
      disconnectAt: 0,
      caps: CLIENT_CAPS,
    });
    rec.onMessage('au-r', { t: 'zenithAuto', auto: { auto: JSON.stringify(probeAuto()) } });
    const err = seen.find((m) => m.t === 'error') as Extract<ServerMsg, { t: 'error' }> | undefined;
    check('AUTO room: a RECORD room refuses an auto and says it is custom rooms only', err?.message === 'Autos run in custom rooms only.', err?.message);
    // and a malformed file is refused in the lobby, not left to stand a robot still
    const bad: ServerMsg[] = [];
    const room = new Room('auto-bad', () => {}, { kind: 'versus', game: 'biobuzz', physics: '2d' });
    room.add({
      id: 'au-b',
      send: (m) => bad.push(m),
      player: { clientId: 'au-b', name: 'b', teamName: 'S', teamNumber: 1, alliance: 'blue', startIndex: 0, ready: true, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
      connected: true,
      disconnectAt: 0,
      caps: CLIENT_CAPS,
    });
    room.onMessage('au-b', { t: 'zenithAuto', auto: { auto: '{"formatVersion":3}' } });
    check('AUTO room: a malformed auto is refused in the lobby', bad.some((m) => m.t === 'error'));
  }

  // ── the team's own file: biobuzz's close.auto.json with its waypoints ────────────────────
  {
    const dir = join(here, 'fixtures', 'zenith');
    const auto = readFileSync(join(dir, 'close.auto.json'), 'utf8');
    const waypoints = readFileSync(join(dir, 'waypoints.json'), 'utf8');
    const red = stage({ auto, waypoints }, 'red', '2d');
    const blue = stage({ auto, waypoints }, 'blue', '2d');
    check('AUTO: close.auto.json loads, refs and all, with nothing it names unsupported', red.seat.loaded !== null && red.seat.loaded.unsupported.length === 0, red.seat.status().error ?? red.seat.loaded?.unsupported.join(', '));
    check('AUTO: close.auto.json (RED) is mirrored for BLUE and not for RED', red.seat.loaded?.mirrored === false && blue.seat.loaded?.mirrored === true);
    startMatch(red.world);
    const before = red.world.robots[0].hopper.length;
    drive(red.world, red.seat, 8);
    const trace = red.seat.trace();
    const shots = trace?.steps.find((s) => s.id === 'Preload shots');
    check(
      'AUTO: close.auto.json drives to its shoot pose and fires the whole preload',
      shots !== undefined && shots.endS > shots.startS && red.world.robots[0].hopper.length === 0 && before === 4,
      `preload ${before}, holds ${red.world.robots[0].hopper.length}, shots ${JSON.stringify(shots)}`,
    );
  }
}
