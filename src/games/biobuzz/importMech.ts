import type { RobotSpec, Vec2 } from '../../types';
import { INTAKE_RAIL_T } from '../../config';
import { clamp } from '../../math';
import {
  carveImportPlates,
  importHalfChordThrough,
  importMouthRect,
  importPlacePoint,
  rayExit,
  resolveImportMouth,
  type ImportMouth,
} from '../../sim/importedMech';
import { polyBounds } from '../../sim/imported';
import {
  BB_DEFAULT_INTAKE,
  BB_INTAKES,
  BB_LAUNCH_Z0,
  BB_PLACE_REACH,
  BB_SIDE_ROLLER_PROTRUDE,
  BB_TURRET_AXLE_Z,
  bbHead,
  bbIntakeReach,
} from './config';
import { EDGE_DIR, MOUNT_DIR, bbIntakeEdges, bbIntakeMountOf, type BbEdge } from './mounts';
import { bbIntakeKindOf, bbLauncherOf, bbLiftOf } from './mechs';
import type { LocalRect } from './state';

/**
 * BIOBUZZ MECHANISMS ON AN IMPORTED ROBOT — the game's half of `src/sim/importedMech.ts`. Every
 * reader in this game that asks "where is the mouth / the turret / the release / the Box Tube"
 * branches here on `spec.imported`, and nowhere else, so a standard robot never reaches it.
 *
 * Kept out of `robot.ts` so `config.ts` (which `robot.ts` imports) can share the Box Tube point
 * without a cycle, and out of `mounts.ts`, which stays a leaf that imports only `types`.
 */

/** the narrowest BIOBUZZ mouth an import gets, half-width (in): a NECTAR plus a plate each side */
export const BB_IMPORT_MOUTH_MIN_HALF = 3;
/** ...and the widest */
export const BB_IMPORT_MOUTH_MAX_HALF = 9;
/** release heights an import may place (in): a turret's axle above the deck, a dumper's lip */
export const BB_IMPORT_TURRET_Z = { min: 7.5, max: 18 } as const;
export const BB_IMPORT_DUMP_Z = { min: 6, max: 18 } as const;

/**
 * The mouths on the edges `intakeMount` names, fitted to the hull (`resolveImportMouth`). The
 * archetype's own hardware that stands past the roller line — a `siderollers` wheel's front
 * quadrant, `BB_SIDE_ROLLER_PROTRUDE` — is INSIDE the CAD hull, so the roller line is that much
 * behind where the hull ends: the wheels land on the hull's front face, and every FLOWER window
 * measured from the roller line holds.
 */
export function bbImportMouths(spec: RobotSpec): ImportMouth[] {
  const imp = spec.imported!;
  const reach = bbIntakeReach(spec);
  const protrude = bbIntakeKindOf(spec) === 'siderollers' ? BB_SIDE_ROLLER_PROTRUDE : 0;
  return bbIntakeEdges(bbIntakeMountOf(spec)).map((edge) =>
    resolveImportMouth(imp, edge, {
      reach,
      depth: BB_INTAKES[BB_DEFAULT_INTAKE].depth,
      protrude,
      minHalf: BB_IMPORT_MOUTH_MIN_HALF,
      maxHalf: BB_IMPORT_MOUTH_MAX_HALF,
    }),
  );
}

/** the mouths as the `LocalRect`s `bbMouths` publishes, each carrying its chassis `face` */
export function bbImportMouthRects(spec: RobotSpec): LocalRect[] {
  return bbImportMouths(spec).map((m) => ({ edge: m.edge, ...importMouthRect(m), face: m.face }));
}

/** what on an imported robot is solid to a ground POLLEN: the hull with its mouths open, a side
 *  plate each side of each (`carveImportPlates`) */
export function bbImportSolids(spec: RobotSpec): { chassis: Vec2[]; structure: Vec2[][] } {
  return carveImportPlates(spec.imported!.hull, bbImportMouths(spec), INTAKE_RAIL_T);
}

/** the placed launcher point for turret `which` (`shooter`, or a double turret's `shooter2`) */
function placedHead(spec: RobotSpec, which: 0 | 1): { x: number; y: number; z: number } | undefined {
  const mech = spec.imported?.mech;
  if (!mech) return undefined;
  return which === 1 ? mech.shooter2 : mech.shooter;
}

/**
 * The turret's FLYWHEEL AXLE height on an import (in): the placed release height less the head's
 * path radius — `BB_TURRET_PITCH_MIN` is 0, so the rest-pitch muzzle `axle + pathR` is exactly the
 * height the player set, and elevating drops it by `pathR(1 − cos p)` as on a standard head. No
 * placed head ⇒ the standard axle.
 */
export function bbImportTurretAxleZ(spec: RobotSpec, which: 0 | 1): number {
  const p = placedHead(spec, which);
  if (!p) return BB_TURRET_AXLE_Z;
  return clamp(p.z, BB_IMPORT_TURRET_Z.min, BB_IMPORT_TURRET_Z.max) - bbHead(which).pathR;
}

/** a turretless launcher's release height on an import: the placed lip, else the standard tray */
export function bbImportDumpZ(spec: RobotSpec): number {
  const p = spec.imported?.mech?.shooter;
  return p ? clamp(p.z, BB_IMPORT_DUMP_Z.min, BB_IMPORT_DUMP_Z.max) : BB_LAUNCH_Z0;
}

/** the release height a DUMPER's elements leave at, any robot (`BB_LAUNCH_Z0` on a standard one) */
export function bbDumpZ(spec: RobotSpec): number {
  return spec.imported ? bbImportDumpZ(spec) : BB_LAUNCH_Z0;
}

/**
 * A turretless launcher's release LINE on an import, robot-local: centred on the placed lip
 * (`mech.shooter`), else where the hull ends along the firing edge's normal from the hull's
 * bounding-box centre; spread across the edge no further than the hull reaches through that point.
 */
export function bbImportLaunchLine(spec: RobotSpec, edge: BbEdge, spanHalf: number): { origin: Vec2; half: number } {
  const imp = spec.imported!;
  const sh = imp.mech?.shooter;
  const b = polyBounds(imp.hull);
  const origin = sh ? { x: sh.x, y: sh.y } : rayExit(imp.hull, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, EDGE_DIR[edge]);
  const perp = { x: -EDGE_DIR[edge].y, y: EDGE_DIR[edge].x };
  return { origin, half: Math.min(spanHalf, importHalfChordThrough(imp, origin, perp)) };
}

/** the Box Tube's placement point on an import: out of the hull from its base along the mount's
 *  direction, then `BB_PLACE_REACH` (`importPlacePoint`) */
export function bbImportPlacePoint(spec: RobotSpec): Vec2 | null {
  const lift = bbLiftOf(spec);
  if (!lift || !spec.imported) return null;
  return importPlacePoint(spec.imported, MOUNT_DIR[lift.mount], BB_PLACE_REACH);
}

/** is launcher `which` a placed head on this import? (validation and the editor read it) */
export function bbImportHasHead(spec: RobotSpec, which: 0 | 1): boolean {
  if (which === 1 && bbLauncherOf(spec, 45).kind !== 'twinturret') return false;
  return !!placedHead(spec, which);
}
