import { useEffect, useState, type ReactNode } from 'react';

/**
 * A number the player types. Typing never commits a value that is not a finite number; Enter or
 * leaving the field clamps it into range and writes it back at the step's precision, so the field
 * never disagrees with what the editor stored. A `.ds-field` with a `.cap`, like every other row.
 */
export function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  narrow = true,
  onCommit,
}: {
  id?: string;
  label: string;
  hint?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  /** printed after the label as a `.val`, e.g. ":1" or "lb" */
  unit?: string;
  narrow?: boolean;
  onCommit: (v: number) => void;
}) {
  const decimals = step >= 1 ? 0 : (String(step).split('.')[1]?.length ?? 2);
  const fmt = (v: number): string => (Number.isFinite(v) ? Number(v.toFixed(decimals)).toString() : '');
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (): void => {
    const v = Number(text);
    if (!Number.isFinite(v) || text.trim() === '') {
      setText(fmt(value));
      return;
    }
    const c = Math.min(max, Math.max(min, Math.round(v / step) * step));
    setText(fmt(c));
    if (Math.abs(c - value) > 1e-9) onCommit(c);
  };
  return (
    <label className={`ds-field${narrow ? ' narrow' : ''}`}>
      <span className="cap">
        {label}
        {unit ? <span className="val">{unit}</span> : hint ? <span>{hint}</span> : null}
      </span>
      <input
        id={id}
        className="ds-input"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
}
