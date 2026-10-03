import type { JointAxis, MotionDrive, MotionGroup, MotionPart, MotionRole } from '../types';
import { HINGE_ROLES, JOINT_DEFAULT_AMOUNT, JOINT_ROLES, MOTION_DRIVES, SPIN_ROLES } from '../types';
import { COPY } from './copy';
import { NumberField } from './NumberField';

/** what a click in the preview does while a row is being picked: add its parts, or name its axle */
export type PickTarget = 'bodies' | 'axis';

/** the roles a part can be geared to another part's motion, or ride on another part */
const LINKABLE: readonly MotionRole[] = ['roller', 'flywheel', 'spin', 'swing', 'slide'];

/**
 * THE MOVING PARTS (`docs/area/robot-import.md`, "Moving parts"): what turns, folds or slides in a
 * match. One row per part; Pick parts makes the preview pick (a click adds a part, and for a wheel,
 * roller or flywheel everything on its axle), Done ends it. Find moving parts looks for wheels, intake
 * rollers, flywheels, a turret and a part the file shows deployed. For a mechanism none of those
 * names, a spinning, swinging or sliding part is moved by one of the robot's signals (`MotionDrive`),
 * about a robot axis or a picked part's axle, or geared to another part at a ratio, and can ride on
 * another (an arm on a slide).
 */
export function MotionPanel({
  rampOk,
  groups,
  parts,
  active,
  target,
  playing,
  onActive,
  onChange,
  onFind,
  onFindWheels,
  onPlay,
}: {
  /** this build has a deployable ramp (BIOBUZZ's `ramp` intake) */
  rampOk: boolean;
  groups: readonly MotionGroup[];
  /** the moving parts as measured (`MotionPart.group` names the row) */
  parts: readonly MotionPart[];
  /** the group being picked, or null, and what the click does */
  active: number | null;
  target: PickTarget;
  playing: boolean;
  onActive: (i: number | null, target?: PickTarget) => void;
  onChange: (next: MotionGroup[]) => void;
  /** look for every kind of moving part among the bodies no row has yet */
  onFind: () => void;
  onFindWheels: () => void;
  onPlay: (on: boolean) => void;
}) {
  // the measured part for each group (a group with no parts, or none it could fit, has none)
  const measured = new Map(parts.map((p) => [p.group, p]));
  // an edit is the player's: the row is no longer "found"
  const set = (i: number, patch: Partial<MotionGroup>): void => onChange(groups.map((g, j) => (j === i ? { ...g, ...patch, found: undefined } : g)));
  const remove = (i: number): void => {
    if (active === i) onActive(null);
    // the rows after it move up one: what named them by index follows, and what named it goes
    const shift = (k: number | undefined): number | undefined => (k === undefined || k === i ? undefined : k > i ? k - 1 : k);
    onChange(
      groups
        .filter((_, j) => j !== i)
        .map((g) => {
          const out: MotionGroup = { ...g };
          const f = g.follows ? shift(g.follows.group) : undefined;
          if (g.follows && f !== undefined) out.follows = { ...g.follows, group: f };
          else delete out.follows;
          const r = shift(g.rideOn);
          if (r !== undefined) out.rideOn = r;
          else delete out.rideOn;
          return out;
        }),
    );
  };
  const add = (role: MotionRole): void => {
    onChange([...groups, { role, bodies: [] }]);
    onActive(groups.length);
  };
  const hasWheels = groups.some((g) => g.role === 'wheel');
  const roles: MotionRole[] = ['roller', 'flywheel', 'turret', ...(rampOk ? (['ramp'] as const) : []), 'fold', ...JOINT_ROLES];
  const label = (j: number): string => `${j + 1} · ${COPY.motionRole(groups[j].role, groups[j].corner)}`;
  return (
    <>
      <h3 className="ds-subh" id="ri-moving" tabIndex={-1}>
        {COPY.moving}
      </h3>
      <p className="ds-hint">{active !== null && target === 'axis' ? COPY.motionPickAxisHint : COPY.movingHint}</p>
      {groups.length ? (
        <ul className="ds-import-moving">
          {groups.map((g, i) => {
            const p = measured.get(i);
            const on = active === i;
            const spin = SPIN_ROLES.includes(g.role);
            const hinge = HINGE_ROLES.includes(g.role);
            const joint = JOINT_ROLES.includes(g.role) ? (g.role as 'spin' | 'swing' | 'slide') : null;
            const pose = g.filePose ?? 'deployed';
            const others = groups.map((_, j) => j).filter((j) => j !== i && LINKABLE.includes(groups[j].role));
            const axis: JointAxis = g.axis ?? (joint === 'swing' ? 'left' : joint === 'slide' ? 'up' : 'part');
            return (
              <li key={i} className={on ? 'on' : undefined}>
                <span className="what">
                  {label(i)}
                  <small>
                    {g.bodies.length ? COPY.motionDetail(g.role, g.bodies.length, p) : COPY.motionEmpty}
                    {g.found ? ` · ${COPY.motionFound}` : ''}
                  </small>
                </span>
                <span className="acts">
                  <button
                    type="button"
                    className={`ds-btn small${on && target === 'bodies' ? ' primary' : ''}`}
                    aria-pressed={on && target === 'bodies'}
                    onClick={() => onActive(on && target === 'bodies' ? null : i, 'bodies')}
                  >
                    {on && target === 'bodies' ? COPY.motionDone : COPY.motionPick}
                  </button>
                  {spin || g.role === 'turret' || joint ? (
                    <button type="button" className="ds-btn ghost small" aria-pressed={!!g.flip} onClick={() => set(i, { flip: !g.flip })}>
                      {COPY.motionReverse}
                    </button>
                  ) : null}
                  <button type="button" className="ds-btn ghost small" aria-label={COPY.motionRemoveAria(COPY.motionRole(g.role, g.corner))} onClick={() => remove(i)}>
                    {COPY.motionRemove}
                  </button>
                </span>
                {hinge ? (
                  <div className="ds-import-moving-hinge">
                    <div className="ds-segs" role="group" aria-label={COPY.motionFileAria}>
                      {(['deployed', 'folded'] as const).map((v) => (
                        <button key={v} type="button" className={`ds-seg${pose === v ? ' on' : ''}`} aria-pressed={pose === v} onClick={() => set(i, { filePose: v })}>
                          {COPY.motionFile[v]}
                        </button>
                      ))}
                    </div>
                    {pose === 'deployed' ? (
                      <NumberField
                        label={COPY.motionFoldBy}
                        unit="°"
                        value={g.foldDeg ?? Math.round(((p?.deploy ?? 0) * 180) / Math.PI)}
                        min={0}
                        max={180}
                        step={5}
                        onCommit={(v) => set(i, { foldDeg: v })}
                      />
                    ) : (
                      <NumberField
                        label={COPY.motionDeployBy}
                        unit="°"
                        value={g.deployDeg ?? Math.round(((p?.deploy ?? 0) * 180) / Math.PI)}
                        min={0}
                        max={180}
                        step={5}
                        onCommit={(v) => set(i, { deployDeg: v })}
                      />
                    )}
                  </div>
                ) : null}
                {joint ? (
                  <div className="ds-import-moving-hinge">
                    <label className="ds-field narrow">
                      <span className="cap">{COPY.motionDriveLabel}</span>
                      <select
                        className="ds-select"
                        value={g.follows ? '' : (g.drive ?? (joint === 'spin' ? 'always' : 'intake'))}
                        disabled={!!g.follows}
                        onChange={(e) => set(i, { drive: e.target.value as MotionDrive })}
                      >
                        {g.follows ? <option value="">{COPY.motionGearedShort}</option> : null}
                        {MOTION_DRIVES.map((d) => (
                          <option key={d} value={d}>
                            {COPY.motionDrives[d]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="ds-field">
                      <span className="cap">{joint === 'slide' ? COPY.motionAlong : COPY.motionAbout}</span>
                      <div className="ds-segs" role="group" aria-label={joint === 'slide' ? COPY.motionAlong : COPY.motionAbout}>
                        {(['forward', 'left', 'up', 'part'] as const).map((a) => (
                          <button
                            key={a}
                            type="button"
                            className={`ds-seg${axis === a ? ' on' : ''}`}
                            aria-pressed={axis === a}
                            onClick={() => (a === 'part' ? onActive(i, 'axis') : set(i, { axis: a, axisBody: undefined }))}
                          >
                            {a === 'part' && g.axis === 'part' && g.axisBody !== undefined ? COPY.motionAxisPicked : COPY.motionAxes[a]}
                          </button>
                        ))}
                      </div>
                    </div>
                    {g.follows ? null : (
                      <NumberField
                        label={COPY.motionAmount[joint].label}
                        unit={COPY.motionAmount[joint].unit}
                        value={g.amount ?? JOINT_DEFAULT_AMOUNT[joint]}
                        min={0}
                        max={joint === 'spin' ? 50 : joint === 'swing' ? 720 : 60}
                        step={joint === 'spin' ? 0.5 : joint === 'swing' ? 5 : 0.25}
                        onCommit={(v) => set(i, { amount: v })}
                      />
                    )}
                  </div>
                ) : null}
                {LINKABLE.includes(g.role) && others.length ? (
                  <div className="ds-import-moving-hinge">
                    <label className="ds-field narrow">
                      <span className="cap">{COPY.motionGeared}</span>
                      <select
                        className="ds-select"
                        value={g.follows ? String(g.follows.group) : ''}
                        onChange={(e) => set(i, { follows: e.target.value === '' ? undefined : { group: Number(e.target.value), ratio: g.follows?.ratio ?? 1 } })}
                      >
                        <option value="">{COPY.motionNone}</option>
                        {others.map((j) => (
                          <option key={j} value={String(j)}>
                            {label(j)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {g.follows ? (
                      <NumberField label={COPY.motionRatio} unit="×" value={g.follows.ratio} min={-100} max={100} step={0.05} onCommit={(v) => set(i, { follows: { group: g.follows!.group, ratio: v } })} />
                    ) : null}
                    <label className="ds-field narrow">
                      <span className="cap">{COPY.motionRides}</span>
                      <select className="ds-select" value={g.rideOn !== undefined ? String(g.rideOn) : ''} onChange={(e) => set(i, { rideOn: e.target.value === '' ? undefined : Number(e.target.value) })}>
                        <option value="">{COPY.motionNone}</option>
                        {others.map((j) => (
                          <option key={j} value={String(j)}>
                            {label(j)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="ds-import-turns">
        <button type="button" className="ds-btn small" onClick={onFind}>
          {COPY.motionFind}
        </button>
        <button type="button" className="ds-btn ghost small" onClick={onFindWheels}>
          {hasWheels ? COPY.motionFindAgain : COPY.motionFindWheels}
        </button>
        {roles.map((r) => (
          <button key={r} type="button" className="ds-btn ghost small" onClick={() => add(r)}>
            {COPY.motionAdd(r)}
          </button>
        ))}
        {groups.some((g) => g.bodies.length) ? (
          <button type="button" className={`ds-btn small${playing ? ' primary' : ''}`} aria-pressed={playing} onClick={() => onPlay(!playing)}>
            {playing ? COPY.motionStop : COPY.motionPlay}
          </button>
        ) : null}
      </div>
    </>
  );
}
