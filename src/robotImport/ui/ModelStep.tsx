import { useRef } from 'react';
import type { Vec2 } from '../../types';
import { OptRow, ToggleRow } from '../../ui/OptRow';
import type { ImportMeasurement, ImportSetup, LengthUnit, QuarterTurns, UpAxis } from '../types';
import { LENGTH_UNITS, UP_AXES } from '../types';
import { COPY, FORMAT_LABEL, UNIT_LABEL, sizeLabel, upLabel } from './copy';
import { ACCEPT, DropZone, type DropError, type Phase } from './DropZone';
import { rectangleWheels, type EditorDoc } from './editorModel';
import { NumberField } from './NumberField';
import { TopDownMap, type MapHandle } from './TopDownMap';

const fmt = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const ROBOT_MAX = 18;

export function ModelStep({
  doc,
  m,
  phase,
  error,
  wheels,
  selectedWheel,
  mirror,
  onFiles,
  onCancel,
  onSetup,
  onWheel,
  onSelectWheel,
  onMirror,
}: {
  doc: EditorDoc;
  m: ImportMeasurement | null;
  phase: Phase | null;
  error: DropError | null;
  /** FL FR BL BR, MODEL frame, with any drag in flight applied */
  wheels: Vec2[] | null;
  selectedWheel: number;
  mirror: boolean;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
  onSetup: (patch: Partial<ImportSetup>) => void;
  onWheel: (i: number, p: Vec2, final: boolean) => void;
  onSelectWheel: (i: number) => void;
  onMirror: (on: boolean) => void;
}) {
  const replace = useRef<HTMLInputElement>(null);
  if (!m || phase || error) {
    return (
      <>
        <DropZone phase={phase} error={error} onFiles={onFiles} onCancel={onCancel} />
        {!phase ? <p className="ds-hint">{COPY.sidecarHint}</p> : null}
      </>
    );
  }
  const s = doc.source;
  const over = Math.max(m.size.length, m.size.width, m.size.height) > ROBOT_MAX + 1 / 64;
  const hint = (v: string): string => (doc.savedModel ? COPY.savedModel : COPY.detected(v));
  const handles: MapHandle[] = (wheels ?? []).map((w, i) => ({
    key: `w${i}`,
    label: COPY.wheelNames[i],
    x: w.x,
    y: w.y,
    shape: 'wheel',
  }));
  const sel = wheels?.[selectedWheel] ?? null;
  const b0 = m.hull.length ? m.hull : [];
  const turned = ((doc.setup.yaw % 4) * 90) % 360;
  const turn = (by: 1 | 3): void => onSetup({ yaw: (((doc.setup.yaw + by) % 4) as QuarterTurns), wheels: null });
  return (
    <>
      <div className="ds-field">
        <span className="cap">{COPY.fileCap}</span>
        <div className="ds-import-filerow">
          <span>
            {s
              ? COPY.fileVal(s.name, FORMAT_LABEL[s.format] ?? s.format.toUpperCase(), sizeLabel(s.bytes))
              : ''}
            {doc.savedModel ? ` · ${COPY.savedModel}` : ''}
          </span>
          <button type="button" className="ds-btn small" onClick={() => replace.current?.click()}>
            {COPY.replace}
          </button>
          <input
            ref={replace}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) onFiles(files);
            }}
          />
        </div>
      </div>

      <dl className="ds-facts">
        <dt>{COPY.size}</dt>
        <dd>
          {fmt(m.size.length)} × {fmt(m.size.width)} × {fmt(m.size.height)} in{' '}
          <span className={`ds-badge ${over ? 'danger' : 'ok'}`}>{over ? COPY.over : COPY.fits}</span>
        </dd>
        <dt>{COPY.triangles}</dt>
        <dd>
          {(s?.trisIn ?? m.trisIn).toLocaleString('en-US')} → {(s?.trisOut ?? m.trisIn).toLocaleString('en-US')}
        </dd>
        <dt>{COPY.wheels}</dt>
        <dd>
          {m.wheelSource === 'manual' ? COPY.wheelsManual : m.wheelSource === 'detected' ? COPY.wheelsFound : COPY.wheelsNone}
        </dd>
      </dl>

      <div id="ri-units">
        <OptRow<LengthUnit>
          label={COPY.units}
          hint={doc.detected ? hint(UNIT_LABEL[doc.detected.units]) : undefined}
          value={m.units}
          cols="five"
          mini
          // feet only when the file is in feet: a fifth tile wrapped the row for a unit nobody exports in
          options={LENGTH_UNITS.filter((u) => u !== 'ft' || m.units === 'ft').map((u) => ({ v: u, t: UNIT_LABEL[u] }))}
          onPick={(u) => onSetup({ units: u, wheels: null })}
        />
      </div>
      <div id="ri-up">
        <OptRow<UpAxis>
          label={COPY.up}
          hint={doc.detected ? hint(upLabel(doc.detected.up)) : undefined}
          value={m.up}
          cols="three"
          mini
          options={UP_AXES.map((a) => ({ v: a, t: upLabel(a) }))}
          onPick={(a) => onSetup({ up: a, wheels: null })}
        />
      </div>
      <div className="ds-field">
        <span className="cap">
          {COPY.front}
          <span>{turned ? COPY.frontTurned(turned) : doc.savedModel ? COPY.savedModel : COPY.frontDetected}</span>
        </span>
        <div className="ds-import-turns">
          <button type="button" className="ds-btn small" onClick={() => turn(1)}>
            {COPY.turnLeft}
          </button>
          <button type="button" className="ds-btn small" onClick={() => turn(3)}>
            {COPY.turnRight}
          </button>
        </div>
      </div>

      <div className="ds-field" id="ri-wheels">
        <span className="cap">{COPY.footprint}</span>
        <TopDownMap
          hull={b0}
          handles={handles}
          contacts={m.wheels.contacts}
          origin={m.origin}
          selected={`w${selectedWheel}`}
          ariaLabel={COPY.footprintAria}
          status={sel ? COPY.placed(COPY.wheelNames[selectedWheel], sel.x, sel.y) : m.wheels.note}
          onSelect={(k) => onSelectWheel(Number(k.slice(1)))}
          onMove={(k, p, final) => onWheel(Number(k.slice(1)), p, final)}
          onHome={(k) => {
            const i = Number(k.slice(1));
            const home = (m.wheels.wheels ?? rectangleWheels(m.hull))[i];
            if (home) onWheel(i, home, true);
          }}
        />
        <ToggleRow label={COPY.mirror} value={mirror} onPick={onMirror} />
        {sel ? (
          <div className="ds-fields">
            <NumberField
              label={COPY.forward}
              unit="in"
              value={sel.x}
              min={-12}
              max={12}
              step={0.25}
              onCommit={(x) => onWheel(selectedWheel, { x, y: sel.y }, true)}
            />
            <NumberField
              label={COPY.left}
              unit="in"
              value={sel.y}
              min={-12}
              max={12}
              step={0.25}
              onCommit={(y) => onWheel(selectedWheel, { x: sel.x, y }, true)}
            />
          </div>
        ) : null}
        <div>
          <button
            type="button"
            className="ds-btn ghost small"
            disabled={m.wheelSource !== 'manual'}
            onClick={() => onSetup({ wheels: null })}
          >
            {COPY.useDetected}
          </button>
        </div>
      </div>
    </>
  );
}
