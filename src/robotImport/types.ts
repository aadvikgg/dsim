/**
 * ROBOT IMPORT — the importer's own types. Types only, plus three frame constants: no DOM, no
 * three.js, safe for the main chunk and the server. The contract (`ImportedRobot`) lives in
 * `src/types.ts`; `docs/robot-import-plan.md` §3 binds both; `docs/area/robot-import.md` names the
 * frames every number below is in.
 */
import type { DrivetrainType, GameId, RobotSpec, Vec2 } from '../types';

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
/** a signed source axis; `+z` means "the file's +Z points up" */
export type UpAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export type ModelFormat = 'glb' | 'gltf' | 'stl' | 'obj' | '3mf' | 'ply' | 'step';
/** counter-clockwise quarter turns about +z (seen from above), applied after the default front */
export type QuarterTurns = 0 | 1 | 2 | 3;

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
export const UP_AXES: readonly UpAxis[] = ['+z', '+y', '+x', '-z', '-y', '-x'];
/** inches per one source unit */
export const INCHES_PER_UNIT: Readonly<Record<LengthUnit, number>> = {
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1 / 0.0254,
  in: 1,
  ft: 12,
};

// ---- the stored mesh frame ---------------------------------------------------------------

/** metres per inch: the stored GLB is in metres (glTF 2.0), every descriptor number in inches */
export const MESH_METRES_PER_INCH = 0.0254;

/**
 * STORED GLB → ROBOT-LOCAL, as a column-major 4×4 (`THREE.Matrix4.fromArray` order).
 *
 * The stored mesh follows glTF so any viewer shows it upright, life-size and facing the viewer:
 * metres, +Y up, +Z front, +X left, origin at the robot-local origin on the floor. The sim and
 * the BIOBUZZ scene work in robot-local inches, +x front, +y left, +z up. So
 *   robot.x = gltf.z / 0.0254,  robot.y = gltf.x / 0.0254,  robot.z = gltf.y / 0.0254.
 * A cyclic permutation times a positive scale: a proper rotation, so triangle winding and
 * normals survive it unchanged.
 */
export const STORED_MESH_TO_ROBOT: readonly number[] = (() => {
  const k = 1 / MESH_METRES_PER_INCH;
  // columns: the images of gltf +X, +Y, +Z, and the translation
  return [0, k, 0, 0, /**/ 0, 0, k, 0, /**/ k, 0, 0, 0, /**/ 0, 0, 0, 1];
})();

/** the inverse of `STORED_MESH_TO_ROBOT`: robot-local inches → stored GLB metres */
export const ROBOT_TO_STORED_MESH: readonly number[] = (() => {
  const k = MESH_METRES_PER_INCH;
  // gltf.x = robot.y·k, gltf.y = robot.z·k, gltf.z = robot.x·k
  return [0, 0, k, 0, /**/ k, 0, 0, 0, /**/ 0, k, 0, 0, /**/ 0, 0, 0, 1];
})();

/** the top-down PNG's side, px */
export const TOP_IMAGE_PX = 512;
/** the card thumbnail's side, px */
export const THUMB_PX = 192;

// ---- the drivetrain choice -----------------------------------------------------------------

/** a motor from the catalogue in `drive.ts`, or a free rpm the player typed */
export type MotorChoice =
  | { kind: 'gobilda'; ratio: string } // a `GOBILDA_RATIOS` key, e.g. '19.2'
  | { kind: 'revHdHex'; cartridges: (3 | 4 | 5)[] } // nominal UltraPlanetary stages, motor side first
  | { kind: 'revCoreHex' }
  | { kind: 'neverest'; model: 'orbital20' | 'orbital3.7' }
  | { kind: 'custom'; freeRpm: number }; // output free rpm, gearbox included

/** a wheel from the catalogue in `drive.ts`, or a diameter the player typed */
export type WheelChoice = { kind: 'catalogue'; id: string } | { kind: 'custom'; diameterMm: number };

export interface DriveSetup {
  drivetrain: DrivetrainType;
  motor: MotorChoice;
  /** belts/gears after the gearbox: driven ÷ driving teeth. > 1 is a reduction, 1 is direct */
  externalRatio: number;
  wheel: WheelChoice;
  /** the measured robot weight, lb */
  massLb: number;
  /** BUTTERFLY only: the traction set's own wheel and external ratio (same motor). Absent = the
   *  mecanum set's. */
  tankWheel?: WheelChoice;
  tankExternalRatio?: number;
}

// ---- the setup the editor re-opens with ----------------------------------------------------

/**
 * Everything needed to re-run normalisation and re-open the editor exactly as it was left.
 * `units`/`up` may be `'auto'`; a stored setup keeps `'auto'` so a re-import re-detects.
 */
export interface ImportSetup {
  v: 1;
  units: LengthUnit | 'auto';
  up: UpAxis | 'auto';
  /** quarter turns applied after the default front (`docs/area/robot-import.md`, Detection) */
  yaw: QuarterTurns;
  /** cap on the footprint hull's vertex count, 3..16 */
  hullMaxVerts: number;
  /** wheel contacts the player placed, MODEL frame, FL FR BL BR. Null = detect. The UI clears
   *  them when units, up axis or yaw change, because the model frame moves with those. */
  wheels: Vec2[] | null;
  /** compute BIOBUZZ 3D height bands */
  bands: boolean;
  /** triangle budget after simplification, ≤ `MAX_TRIANGLES` */
  triBudget: number;
  drive: DriveSetup;
}

export const MAX_TRIANGLES = 150_000;
export const MAX_MESH_BYTES = 4 * 1024 * 1024;

// ---- measurement ---------------------------------------------------------------------------

export type ImportCheckCode =
  | 'empty'
  | 'oversize'
  | 'units-suspect'
  | 'up-uncertain'
  | 'no-floor'
  | 'few-wheels'
  | 'wheels-picked'
  | 'wheels-off-hull'
  | 'mass-low'
  | 'mass-high'
  | 'rpm-low'
  | 'rpm-high'
  | 'tank-rpm-clamped'
  | 'hull-simplified'
  | 'mesh-simplified'
  | 'front-assumed';

/**
 * Which way the robot faces, from its geometry (`detectFront`, `docs/area/robot-import.md`). Three
 * cues, each a vote along the footprint's two axes: an INTAKE (low geometry across the robot that
 * reaches out past the wheels further at one end than the other), the WHEELS set back from one
 * end, and the MASS (surface area) sitting toward the other end. When they agree strongly enough the
 * front is DETECTED; otherwise it is ASSUMED to be the CAD front view (`defaultFront`) and the
 * editor says so.
 */
export interface FrontDetection {
  /** the quarter turns (the setup's `yaw`, from the CAD front) that put the found front at +x */
  yaw: QuarterTurns;
  /** 0..1, how far the strongest direction is ahead of the rest */
  confidence: number;
  /** confidence ≥ `FRONT_MIN_CONFIDENCE`: the front was found, not assumed */
  detected: boolean;
  /** the cue that carried it: 'intake', 'wheels' or 'mass'; null when none did */
  cue: 'intake' | 'wheels' | 'mass' | null;
}

/** one plain-language check, for the Review step (copy follows `docs/area/ui.md`) */
export interface ImportCheck {
  code: ImportCheckCode;
  /** `block`: Save stays disabled. `warn`: shown, Save allowed. `info`: a note */
  level: 'block' | 'warn' | 'info';
  message: string;
}

export interface WheelDetection {
  /** FL FR BL BR, MODEL frame, or null when detection failed */
  wheels: Vec2[] | null;
  /** every floor-contact cluster's centre, MODEL frame, for the editor's inset */
  contacts: Vec2[];
  /** why detection failed or what it chose, a plain sentence */
  note: string;
}

/** what `measureParts` (and the engine's `normalise`) reports */
export interface ImportMeasurement {
  units: LengthUnit;
  unitsDetected: boolean;
  up: UpAxis;
  upDetected: boolean;
  /** best-minus-second up-axis score; under 0.15 the UI should ask */
  upMargin: number;
  yaw: QuarterTurns;
  /** source → MODEL frame, column-major 4×4 (scale, up rotation, front, yaw, floor, centring) */
  sourceToModel: number[];
  /** bounding box of the whole model in the MODEL frame, inches */
  size: { length: number; width: number; height: number };
  /** footprint hull, MODEL frame, CCW, ≤ hullMaxVerts, quantised to 1/64 in */
  hull: Vec2[];
  /** vertex count of the raw hull before reduction */
  hullRawVerts: number;
  /** largest distance from a raw hull vertex to the reduced hull, inches */
  hullDeviation: number;
  wheels: WheelDetection;
  /** which way the geometry says the robot faces (measured in this orientation, given as a yaw) */
  front: FrontDetection;
  /** wheels in force: the override, else detected, else null */
  wheelsUsed: Vec2[] | null;
  wheelSource: 'manual' | 'detected' | 'none';
  /** the robot-local origin (wheelbase centre, else hull box centre), MODEL frame */
  origin: Vec2;
  heightIn: number;
  /** robot-local frame (already shifted), absent when one prism is close enough */
  bands?: { z0: number; z1: number; hull: Vec2[] }[];
  trisIn: number;
  checks: ImportCheck[];
}

// ---- the library record (plan §3.2) ------------------------------------------------------

export interface LibrarySource {
  name: string;
  format: string;
  bytes: number;
  trisIn: number;
  trisOut: number;
}

export interface LibraryRobot {
  /** = spec.imported.id */
  id: string;
  game: GameId;
  spec: RobotSpec;
  /** simplified, normalised GLB (stored mesh frame above), ≤ 4 MB, ≤ 150k triangles */
  mesh: Blob;
  /** top-down orthographic PNG, `TOP_IMAGE_PX`, transparent; frame: `topImageFrame` */
  top: Blob;
  /** 3/4 view PNG for cards, `THUMB_PX` */
  thumb: Blob;
  /** a lighter GLB (same frame) for a room's visuals relay, made once by the engine's `liteMesh` when
   *  `mesh` is over the relay's 1 MiB cap; absent when `mesh` already fits or has not been needed. A
   *  re-save of the robot drops it, because the mesh it was cut from may have changed. */
  meshLite?: Blob;
  /** the import id inside the share file this robot was added from. A share-file import always gets
   *  a FRESH id (a room refuses two seats with one id, so two teammates who loaded the same file
   *  could not sit together); this is how a second import of that file on this device is still
   *  recognised as the same robot. Absent on robots imported from CAD. */
  sharedFrom?: string;
  source: LibrarySource;
  setup: ImportSetup;
  created: number;
  updated: number;
}

/** a library row without its blobs, for lists */
export type LibraryEntry = Omit<LibraryRobot, 'mesh' | 'top' | 'thumb' | 'meshLite'>;
