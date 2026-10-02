/**
 * THE IMPORTER EDITOR'S MODEL, DOM-free so `npm test` can hold it: the document the editor edits
 * (and the draft store keeps), how a document plus a measurement becomes the `RobotSpec` that is
 * test-driven and saved, and the Review step's checks.
 *
 * Frames (`docs/area/robot-import.md`): wheel overrides and mechanism placements are kept in the
 * MODEL frame, which does not move when a wheel is dragged; the descriptor converts them to
 * robot-local when the spec is built.
 */
import type { GameId } from '../../games/types';
import type { ImportedEdge, ImportedMech, RobotSpec, Vec2 } from '../../types';
import { coerceSpec } from '../../sim/spawn';
import { IMPORT_MIN_SIDE } from '../../sim/imported';
import { driveParams, massLimits, pushForce, rpmLimits } from '../../sim/drivetrain';
import { chainMassFloorBump } from '../../games/chain/config';
import { DRIVETRAIN_LABELS } from '../../ui/labelData';
import { bbox, buildDescriptor, q64 } from '../geometry';
import { driveReadout, driveRpmFor, importedDriveFields } from '../drive';
import type { ImportCheck, ImportMeasurement, ImportSetup, LengthUnit, LibrarySource, UpAxis } from '../types';
import { validateMechFor } from './adapters';
import { COPY } from './copy';

export const STEP_COUNT = 4;
export type StepIndex = 0 | 1 | 2 | 3;

/** what the editor edits; plain JSON, so the draft store keeps it as is */
export interface EditorDoc {
  v: 1;
  /** `<game>:new` or `<game>:<id>` */
  key: string;
  game: GameId;
  /** the robot's id (a new one for a new import, the library id when editing) */
  id: string;
  /** the library robot being edited, or null for a new import */
  editId: string | null;
  step: StepIndex;
  setup: ImportSetup;
  /** what auto-detection chose when the file was read, for the "Detected: mm" hints */
  detected: { units: LengthUnit; up: UpAxis } | null;
  /** mechanism placements, MODEL frame */
  mech: ImportedMech | null;
  /** identity, mechanism fields and assists; the import fields are filled in by `buildSpec` */
  spec: RobotSpec;
  source: LibrarySource | null;
  /** the model is a saved robot's stored mesh (re-open), not the file it came from */
  savedModel: boolean;
  /** created time of the library robot being edited */
  created: number | null;
  /** the source file's name, for the robot page's "Resume import" card */
  sourceName: string | null;
  updated: number;
}

export const draftKey = (game: GameId, editId: string | null): string => `${game}:${editId ?? 'new'}`;

/** the file's name without its extension, cut to the name field's 24 */
export function baseName(file: string): string {
  return (file.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Robot').slice(0, 24);
}

/** extra lb a game adds to the mass floor (the same value `coerceSpec` uses) */
export function extraMassFloor(game: GameId, spec: RobotSpec): number {
  return game === 'chain' ? chainMassFloorBump(spec) : 0;
}

/** robot-local mechanism placements → the MODEL frame (the inverse of `mechModelToRobot`) */
export function mechRobotToModel(mech: ImportedMech, origin: Vec2): ImportedMech {
  const out: ImportedMech = {};
  if (mech.shooter) out.shooter = { x: mech.shooter.x + origin.x, y: mech.shooter.y + origin.y, z: mech.shooter.z };
  if (mech.place) out.place = { x: mech.place.x + origin.x, y: mech.place.y + origin.y, z: mech.place.z };
  if (mech.intakes) {
    out.intakes = mech.intakes.map((m) => {
      const lateral = m.edge === 'front' || m.edge === 'back' ? origin.y : origin.x;
      return { edge: m.edge, from: m.from + lateral, to: m.to + lateral };
    });
  }
  return out;
}

export interface Built {
  spec: RobotSpec;
  /** what the player chose before the sim's clamps */
  raw: { rpm: number; tankRpm?: number; massLb: number };
}

/**
 * The spec that is test-driven and saved: the descriptor from the measurement, the drivetrain
 * numbers from the gearing, the game's mechanism fields, and `coerceSpec` with the last word on
 * every one of them. Identity text is kept as typed (it is length-capped on save).
 */
export function buildSpec(doc: EditorDoc, m: ImportMeasurement): Built {
  const descriptor = buildDescriptor({ id: doc.id, measurement: m, mech: doc.mech });
  const hb = bbox(descriptor.hull);
  const box = { length: hb.maxX - hb.minX, width: hb.maxY - hb.minY };
  const extra = extraMassFloor(doc.game, doc.spec);
  const fields = importedDriveFields(doc.spec, doc.setup.drive, box, extra);
  const raw: RobotSpec = {
    ...doc.spec,
    ...fields,
    imported: descriptor,
    ...(doc.game === 'biobuzz' ? { heightIn: descriptor.heightIn } : {}),
  };
  const spec: RobotSpec = { ...coerceSpec(raw, undefined, doc.game), name: doc.spec.name, teamName: doc.spec.teamName };
  const { rpm, tankRpm } = driveRpmFor(doc.setup.drive);
  return { spec, raw: { rpm, tankRpm, massLb: doc.setup.drive.massLb } };
}

/** the four numbers the Drivetrain step shows, read off the spec that will drive */
export interface DriveNumbers {
  rpm: number;
  topSpeed: number;
  accel: number;
  pushLbf: number;
  rpmRange: { min: number; max: number };
  massRange: { min: number; max: number };
  lines: { label: string; text: string; warn: boolean }[];
  checks: ImportCheck[];
}

const G_IN_S2 = 386.0886;

export function driveNumbers(built: Built, game: GameId): DriveNumbers {
  const s = built.spec;
  const p = driveParams(s);
  const rpmRange = rpmLimits(s.drivetrain);
  const massRange = massLimits(s.drivetrain, s.flywheelInertia, extraMassFloor(game, s));
  const dt = DRIVETRAIN_LABELS[s.drivetrain].toLowerCase();
  const ro = driveReadout(s, { driveRpm: built.raw.rpm, tankRpm: built.raw.tankRpm, massLb: built.raw.massLb }, extraMassFloor(game, s));
  const rawRpm = built.raw.rpm;
  const rawMass = built.raw.massLb;
  const rpmLine =
    rawRpm > rpmRange.max
      ? { text: COPY.rpmHigh(dt, rpmRange.max), warn: true }
      : rawRpm < rpmRange.min
        ? { text: COPY.rpmLow(dt, rpmRange.min), warn: true }
        : { text: COPY.rpmOk(dt, rpmRange.min, rpmRange.max), warn: false };
  const massLine =
    rawMass < s.massLb - 0.005
      ? { text: COPY.massLow(s.massLb), warn: true }
      : rawMass > s.massLb + 0.005
        ? { text: COPY.massHigh(s.massLb), warn: true }
        : { text: COPY.massOk(massRange.min, massRange.max), warn: false };
  return {
    rpm: s.driveRpm,
    topSpeed: p.maxSpeed,
    accel: p.accel,
    pushLbf: pushForce(s) / G_IN_S2,
    rpmRange,
    massRange,
    lines: [
      { label: COPY.statRpm, ...rpmLine },
      { label: COPY.weight, ...massLine },
      { label: COPY.statSpeed, text: COPY.speedLine, warn: false },
      { label: COPY.statPush, text: COPY.pushLine, warn: false },
    ],
    checks: ro.checks,
  };
}

/** one line of the Review list */
export interface ReviewItem {
  id: string;
  level: 'block' | 'warn' | 'info' | 'ok';
  text: string;
  /** where "Fix" goes: the step, and the id of the control to focus */
  fix?: { step: StepIndex; focus: string };
}

/** where each engine check is fixed */
const FIX: Partial<Record<ImportCheck['code'], { step: StepIndex; focus: string }>> = {
  oversize: { step: 0, focus: 'ri-units' },
  'units-suspect': { step: 0, focus: 'ri-units' },
  'up-uncertain': { step: 0, focus: 'ri-up' },
  'no-floor': { step: 0, focus: 'ri-up' },
  'few-wheels': { step: 0, focus: 'ri-wheels' },
  'wheels-off-hull': { step: 0, focus: 'ri-wheels' },
  'mass-low': { step: 1, focus: 'ri-weight' },
  'mass-high': { step: 1, focus: 'ri-weight' },
  'rpm-low': { step: 1, focus: 'ri-motor' },
  'rpm-high': { step: 1, focus: 'ri-motor' },
  'tank-rpm-clamped': { step: 1, focus: 'ri-tank' },
};

/** the step each check belongs to, for the step rail's counts */
export function stepOf(item: ReviewItem): StepIndex {
  return item.fix?.step ?? 3;
}

/**
 * Every check, passes included, in step order. `block` disables Save, Test drive and Export.
 * A pass line stands in for a category with nothing to say, so the list says what was checked.
 */
export function reviewItems(m: ImportMeasurement | null, built: Built | null, game: GameId): ReviewItem[] {
  if (!m || !built) return [{ id: 'empty', level: 'block', text: COPY.dropTitle, fix: { step: 0, focus: 'ri-choose' } }];
  const items: ReviewItem[] = [];
  const codes = new Set(m.checks.map((c) => c.code));
  for (const c of m.checks) {
    if (c.code === 'mesh-simplified' || c.code === 'hull-simplified' || c.code === 'wheels-picked') continue;
    items.push({ id: c.code, level: c.level, text: c.message, fix: FIX[c.code] });
  }
  // TOO SMALL is a block too: `coerceImported` refuses a footprint under 6 in a side (or 24 in²) and the
  // robot would silently play as its parametric fallback. Almost always a units mistake.
  const imp = built.spec.imported;
  const hb = bbox(m.hull);
  const sideMin = m.hull.length >= 3 ? Math.min(hb.maxX - hb.minX, hb.maxY - hb.minY) : 0;
  if (!codes.has('empty') && !codes.has('oversize') && (!imp || sideMin < IMPORT_MIN_SIDE)) {
    items.push({ id: 'tiny', level: 'block', text: COPY.tooSmall(sideMin, IMPORT_MIN_SIDE), fix: { step: 0, focus: 'ri-units' } });
  } else if (!codes.has('oversize') && !codes.has('empty')) items.push({ id: 'fits', level: 'ok', text: COPY.passFits });
  if (!codes.has('no-floor') && !codes.has('few-wheels') && !codes.has('wheels-off-hull')) {
    items.push({ id: 'wheels', level: 'ok', text: COPY.passWheels });
  }
  const dn = driveNumbers(built, game);
  for (const c of dn.checks) items.push({ id: c.code, level: c.level, text: c.message, fix: FIX[c.code] });
  const driveCodes = new Set(dn.checks.map((c) => c.code));
  if (!driveCodes.has('mass-low') && !driveCodes.has('mass-high')) items.push({ id: 'mass-ok', level: 'ok', text: COPY.passWeight });
  if (!driveCodes.has('rpm-low') && !driveCodes.has('rpm-high')) items.push({ id: 'rpm-ok', level: 'ok', text: COPY.passRpm });
  const mech = validateMechFor(built.spec, game);
  mech.forEach((c, i) => items.push({ id: `mech-${i}`, level: c.level, text: c.text, fix: { step: 2, focus: !c.key ? 'ri-placement' : c.key.startsWith('intake:') ? `ri-h-${c.key}:mid` : `ri-h-${c.key}` } }));
  if (!mech.length) items.push({ id: 'mech-ok', level: 'ok', text: COPY.passMech });
  const rank = { block: 0, warn: 1, info: 2, ok: 3 } as const;
  return items.sort((a, b) => stepOf(a) - stepOf(b) || rank[a.level] - rank[b.level]);
}

export const blocks = (items: readonly ReviewItem[]): number => items.filter((i) => i.level === 'block').length;

/** the Review title: all pass, the number to fix, or ready with notes */
export function reviewSummary(items: readonly ReviewItem[]): string {
  const b = blocks(items);
  if (b) return COPY.toFix(b);
  const n = items.filter((i) => i.level === 'warn' || i.level === 'info').length;
  return n ? COPY.notes(n) : COPY.allPass;
}

/** the units hint maths (spec §2 Review): which unit would make the largest side robot-sized */
export function suggestUnit(largestIn: number, current: LengthUnit): LengthUnit | null {
  const asSource = largestIn / ({ mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254, in: 1, ft: 12 } as const)[current];
  for (const u of ['mm', 'cm', 'm', 'in'] as const) {
    if (u === current) continue;
    const v = asSource * ({ mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254, in: 1 } as const)[u];
    if (v > 6 && v <= 18) return u;
  }
  return null;
}

// ---- wheels: the rectangle default and the mirror ----------------------------------------------

/** FL FR BL BR, MODEL frame, 1.5 in inside the footprint's box */
export function rectangleWheels(hull: readonly Vec2[]): Vec2[] {
  const b = bbox(hull);
  const i = 1.5;
  return [
    { x: b.maxX - i, y: b.maxY - i },
    { x: b.maxX - i, y: b.minY + i },
    { x: b.minX + i, y: b.maxY - i },
    { x: b.minX + i, y: b.minY + i },
  ];
}

/** FL↔FR, BL↔BR */
export const MIRROR_OF = [1, 0, 3, 2] as const;

/** move wheel `i` to `p`; with `mirror`, its partner goes to the mirror point across the box centre */
export function moveWheel(wheels: readonly Vec2[], i: number, p: Vec2, mirror: boolean, hull: readonly Vec2[]): Vec2[] {
  const out = wheels.map((w) => ({ x: w.x, y: w.y }));
  out[i] = { x: q64(p.x), y: q64(p.y) };
  if (mirror) {
    const b = bbox(hull);
    const cy = (b.minY + b.maxY) / 2;
    out[MIRROR_OF[i]] = { x: q64(p.x), y: q64(2 * cy - p.y) };
  }
  return out;
}

/** an intake span's lateral range on its edge (y for front/back, x for left/right) */
export function edgeRange(edge: ImportedEdge, hull: readonly Vec2[]): { lo: number; hi: number; at: number } {
  const b = bbox(hull);
  switch (edge) {
    case 'front':
      return { lo: b.minY, hi: b.maxY, at: b.maxX };
    case 'back':
      return { lo: b.minY, hi: b.maxY, at: b.minX };
    case 'left':
      return { lo: b.minX, hi: b.maxX, at: b.maxY };
    case 'right':
      return { lo: b.minX, hi: b.maxX, at: b.minY };
  }
}
