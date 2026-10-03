import type { MotionGroup, MotionPart, MotionRole } from '../types';
import { HINGE_ROLES, SPIN_ROLES } from '../types';
import { COPY } from './copy';
import { NumberField } from './NumberField';

/**
 * THE MOVING PARTS (`docs/area/robot-import.md`, "Moving parts"): what turns or folds in a match.
 * One row per part; Pick parts makes the preview pick (a click adds a part, and for a wheel, roller or
 * flywheel everything on its axle), Done ends it. The wheels are found from the floor contacts.
 * A ramp or a folding part the file shows deployed is measured folded, which is how a robot whose
 * CAD has its intake out still fits the 18-in start.
 */
export function MotionPanel({
  rampOk,
  groups,
  parts,
  active,
  playing,
  onActive,
  onChange,
  onFindWheels,
  onFindRollers,
  onPlay,
}: {
  /** this build has a deployable ramp (BIOBUZZ's `ramp` intake) */
  rampOk: boolean;
  groups: readonly MotionGroup[];
  /** the moving parts as measured (`MotionPart.group` names the row) */
  parts: readonly MotionPart[];
  /** the group being picked, or null */
  active: number | null;
  playing: boolean;
  onActive: (i: number | null) => void;
  onChange: (next: MotionGroup[]) => void;
  onFindWheels: () => void;
  /** look for intake rollers on the intake spans (absent: the build has none) */
  onFindRollers?: () => void;
  onPlay: (on: boolean) => void;
}) {
  // the measured part for each group (a group with no parts, or none it could fit, has none)
  const measured = new Map(parts.map((p) => [p.group, p]));
  const set = (i: number, patch: Partial<MotionGroup>): void => onChange(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const remove = (i: number): void => {
    if (active === i) onActive(null);
    onChange(groups.filter((_, j) => j !== i));
  };
  const add = (role: MotionRole): void => {
    onChange([...groups, { role, bodies: [] }]);
    onActive(groups.length);
  };
  const hasWheels = groups.some((g) => g.role === 'wheel');
  const roles: MotionRole[] = ['roller', 'flywheel', 'turret', ...(rampOk ? (['ramp'] as const) : []), 'fold'];
  return (
    <>
      <h3 className="ds-subh" id="ri-moving" tabIndex={-1}>
        {COPY.moving}
      </h3>
      <p className="ds-hint">{COPY.movingHint}</p>
      {groups.length ? (
        <ul className="ds-import-moving">
          {groups.map((g, i) => {
            const p = measured.get(i);
            const on = active === i;
            const spin = SPIN_ROLES.includes(g.role);
            const hinge = HINGE_ROLES.includes(g.role);
            const pose = g.filePose ?? 'deployed';
            return (
              <li key={i} className={on ? 'on' : undefined}>
                <span className="what">
                  {COPY.motionRole(g.role, g.corner)}
                  <small>{g.bodies.length ? COPY.motionDetail(g.role, g.bodies.length, p) : COPY.motionEmpty}</small>
                </span>
                <span className="acts">
                  <button type="button" className={`ds-btn small${on ? ' primary' : ''}`} aria-pressed={on} onClick={() => onActive(on ? null : i)}>
                    {on ? COPY.motionDone : COPY.motionPick}
                  </button>
                  {spin || g.role === 'turret' ? (
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
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="ds-import-turns">
        <button type="button" className="ds-btn small" onClick={onFindWheels}>
          {hasWheels ? COPY.motionFindAgain : COPY.motionFindWheels}
        </button>
        {onFindRollers ? (
          <button type="button" className="ds-btn small" onClick={onFindRollers}>
            {COPY.motionFindRollers}
          </button>
        ) : null}
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
