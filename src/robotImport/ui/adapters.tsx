/**
 * THE SEAMS TO TWO LANES THAT HAD NOT LANDED when the importer UI was built — one file, so the
 * reconciliation is one file.
 *
 *  - LANE 2 (mechanisms): which mechanisms an imported robot places, their defaults, and the
 *    plain-language checks on a placement (`validateImportedMech`, `defaultImportedMech`,
 *    `mechHandles` in `src/sim/importedMech.ts` once merged).
 *  - LANE 6 (rendering): the asset seam the renderers read an imported robot's pictures through
 *    (`registerImportedAssets` in `src/render/importedAssets.ts`) and the footprint picture
 *    (`FootprintSvg`).
 *
 * Every function here is a MINIMAL LOCAL FALLBACK with the shape the UI needs. Main-chunk safe:
 * no three.js, no DOM beyond the SVG.
 */
import type { ImportedEdge, ImportedMech, RobotSpec, Vec2 } from '../../types';
import type { GameId } from '../../games/types';
import { intakeMountOf } from '../../games/chain/mounts';
import { bbIntakeMountOf } from '../../games/biobuzz/mounts';
import { bbLiftOf } from '../../games/biobuzz/mechs';
// NOT `../geometry`: this file is in the MAIN chunk (the robot page draws the footprint), and
// geometry.ts is shared with the lazy engine, so importing any of it moved the whole module (the
// measurement code included) into main. The two helpers it needs are a few lines each.

/** the box of a point set */
export function bbox(points: readonly Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** how far `p` is inside a CCW convex polygon (negative: outside) */
function insetDepth(p: Vec2, poly: readonly Vec2[]): number {
  if (poly.length < 3) return -Infinity;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const s = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
    if (s < d) d = s;
  }
  return d;
}

// ---- lane 6: assets ------------------------------------------------------------------------

const draftAssets = new Map<string, { top: Blob; mesh: Blob }>();

/**
 * Hand the renderers an UNSAVED robot's pictures, so a test drive draws the draft and not its
 * bare footprint. Lane 6's `registerImportedAssets(id, { top, mesh })` once merged.
 */
export function registerDraftAssets(id: string, assets: { top: Blob; mesh: Blob }): void {
  draftAssets.set(id, assets);
}

/** the registered draft assets (the renderers' lookup until lane 6 owns it) */
export function draftAssetsFor(id: string): { top: Blob; mesh: Blob } | null {
  return draftAssets.get(id) ?? null;
}

/**
 * The footprint seen from above, nose up: robot (x, y) → screen (−y, −x), so the robot's LEFT is
 * the screen's left (CLAUDE.md, the bird's-eye gotcha). Lane 6's `FootprintSvg` once merged.
 */
export function FootprintPicture({ hull, wheels, size }: { hull: readonly Vec2[]; wheels?: readonly Vec2[]; size: number }) {
  if (hull.length < 3) return null;
  const b = bbox(hull);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) + 2;
  const sx = (p: Vec2): number => -(p.y - cy);
  const sy = (p: Vec2): number => -(p.x - cx);
  const pts = hull.map((p) => `${sx(p).toFixed(2)},${sy(p).toFixed(2)}`).join(' ');
  return (
    <svg
      className="ds-import-footprint"
      width={size}
      height={size}
      viewBox={`${-span / 2} ${-span / 2} ${span} ${span}`}
      aria-hidden="true"
    >
      <polygon className="hull" points={pts} />
      {(wheels ?? []).map((w, i) => (
        <rect key={i} className="wheel" x={sx(w) - 0.75} y={sy(w) - 1.75} width={1.5} height={3.5} rx={0.4} />
      ))}
      <path className="nose" d={`M ${-1.5} ${-(b.maxX - cx) - 0.4} L 0 ${-(b.maxX - cx) - 1.6} L ${1.5} ${-(b.maxX - cx) - 0.4}`} />
    </svg>
  );
}

// ---- lane 2: mechanism placement -------------------------------------------------------------

/** one thing the placement editor lets the player drag */
export interface MechHandleDef {
  /** unique: `intake:front`, `shooter`, `place` */
  key: string;
  kind: 'span' | 'point';
  label: string;
  field: 'intake' | 'shooter' | 'place';
  /** spans: the bounding-box edge it rides */
  edge?: ImportedEdge;
}

const EDGE_WORD: Record<ImportedEdge, string> = { front: 'front', back: 'back', left: 'left', right: 'right' };

/** which bounding-box edges this build's intake uses (its mount decides; the editor says where) */
export function intakeEdges(game: GameId, spec: RobotSpec): ImportedEdge[] {
  const mount = game === 'chain' ? intakeMountOf(spec) : game === 'biobuzz' ? bbIntakeMountOf(spec) : 'front';
  switch (mount) {
    case 'back':
      return ['back'];
    case 'side':
      return ['left', 'right'];
    case 'frontback':
      return ['front', 'back'];
    default:
      return ['front'];
  }
}

/** the handles this game and build place on an imported robot. Lane 2's `mechHandles` once merged. */
export function mechHandlesFor(game: GameId, spec: RobotSpec): MechHandleDef[] {
  const out: MechHandleDef[] = intakeEdges(game, spec).map((edge) => ({
    key: `intake:${edge}`,
    kind: 'span' as const,
    label: `Intake, ${EDGE_WORD[edge]} edge`,
    field: 'intake' as const,
    edge,
  }));
  out.push({ key: 'shooter', kind: 'point', label: 'Launcher', field: 'shooter' });
  if (game === 'chain') out.push({ key: 'place', kind: 'point', label: 'Catalyst', field: 'place' });
  if (game === 'biobuzz' && bbLiftOf(spec)) out.push({ key: 'place', kind: 'point', label: 'Box Tube', field: 'place' });
  return out;
}

/**
 * Default placements, MODEL frame, for whatever `mechHandlesFor` lists and `have` lacks: each
 * intake spans the middle 80 % of its edge, the launcher sits at the footprint's centre near the
 * top, the placer a third of the way back. Lane 2's `defaultImportedMech` once merged.
 */
export function defaultMechFor(game: GameId, spec: RobotSpec, hull: readonly Vec2[], heightIn: number, have: ImportedMech | null): ImportedMech {
  const out: ImportedMech = { ...(have ?? {}) };
  if (hull.length < 3) return out;
  const b = bbox(hull);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const handles = mechHandlesFor(game, spec);
  const intakes = [...(out.intakes ?? [])];
  for (const h of handles) {
    if (h.field !== 'intake' || !h.edge || intakes.some((i) => i.edge === h.edge)) continue;
    const lateral = h.edge === 'front' || h.edge === 'back';
    const lo = lateral ? b.minY : b.minX;
    const hi = lateral ? b.maxY : b.maxX;
    const pad = (hi - lo) * 0.1;
    intakes.push({ edge: h.edge, from: lo + pad, to: hi - pad });
  }
  const edges = new Set(handles.filter((h) => h.field === 'intake').map((h) => h.edge));
  out.intakes = intakes.filter((i) => edges.has(i.edge));
  if (!out.intakes.length) delete out.intakes;
  if (!out.shooter) out.shooter = { x: cx, y: cy, z: Math.max(1, heightIn * 0.8) };
  if (handles.some((h) => h.field === 'place')) {
    if (!out.place) out.place = { x: cx - (b.maxX - b.minX) / 3, y: cy, z: Math.max(1, heightIn * 0.6) };
  } else delete out.place;
  return out;
}

/** a plain-language check on a placement */
export interface MechCheck {
  level: 'block' | 'warn';
  text: string;
  /** the handle it is about, for "Fix" */
  key?: string;
}

/**
 * Checks on the placements of a built spec (ROBOT-LOCAL, `spec.imported.mech`): every point on the
 * footprint, every placed height under the top, every intake span on its edge. Lane 2's
 * `validateImportedMech` once merged.
 */
export function validateMechFor(spec: RobotSpec, game: GameId): MechCheck[] {
  const imp = spec.imported;
  if (!imp) return [];
  const out: MechCheck[] = [];
  const mech = imp.mech ?? {};
  const hull = imp.hull;
  const b = bbox(hull);
  for (const h of mechHandlesFor(game, spec)) {
    if (h.field === 'intake') {
      const span = mech.intakes?.find((i) => i.edge === h.edge);
      if (!span) {
        out.push({ level: 'warn', text: `${h.label} has no span. It uses the whole edge.`, key: h.key });
        continue;
      }
      const lateral = h.edge === 'front' || h.edge === 'back';
      const lo = lateral ? b.minY : b.minX;
      const hi = lateral ? b.maxY : b.maxX;
      if (span.from < lo - 0.25 || span.to > hi + 0.25) {
        out.push({ level: 'warn', text: `${h.label} runs past the corner. Drag its ends onto the robot.`, key: h.key });
      }
      continue;
    }
    const p = h.field === 'shooter' ? mech.shooter : mech.place;
    if (!p) continue;
    if (insetDepth(p, hull) < -0.05) {
      out.push({ level: 'warn', text: `The ${h.label.toLowerCase()} is off the footprint. Drag it back onto the robot.`, key: h.key });
    }
    if (p.z > imp.heightIn + 0.05) {
      out.push({ level: 'warn', text: `The ${h.label.toLowerCase()} is above the top of the robot. Lower its height.`, key: h.key });
    }
  }
  return out;
}
