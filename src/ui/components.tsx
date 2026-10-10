import { useEffect, useState, type ReactNode } from 'react';

export const fmtSec = (s: number) => (s >= 100 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)} s`);
export const fmtClock = (clock: number) => {
  const d = ((clock % 86400) + 86400) % 86400;
  return `${String(Math.floor(d / 3600)).padStart(2, '0')}:${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}`;
};
export const fmtHour = (h: number) => fmtClock(h * 3600);
export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export function Section(props: { title: string; open?: boolean; right?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(props.open ?? true);
  return (
    <section className={`section ${open ? 'open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <h3>{props.title}</h3>
        <div className="section-right" onClick={(e) => e.stopPropagation()}>{props.right}</div>
      </header>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}

interface NumProps {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  integer?: boolean;
}

export function NumInput({ value, onChange, min = -Infinity, max = Infinity, step = 1, integer }: NumProps) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const commit = (raw: string) => {
    if (raw.trim() === '') return;
    let v = Number(raw);
    if (!Number.isFinite(v)) return;
    if (integer) v = Math.round(v);
    v = Math.min(max, Math.max(min, v));
    if (v !== value) onChange(v);
  };
  return (
    <input
      type="number"
      value={text}
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(String(value));
      }}
    />
  );
}

export function Num(props: NumProps) {
  return (
    <label className="field" title={props.hint}>
      <span>{props.label}</span>
      <div className="input">
        <NumInput {...props} />
        {props.unit && <em>{props.unit}</em>}
      </div>
    </label>
  );
}

export function MinMax(props: {
  label: string;
  min: number;
  max: number;
  onChange: (min: number, max: number) => void;
  limit?: number;
  hint?: string;
}) {
  return (
    <div className="field" title={props.hint}>
      <span>{props.label}</span>
      <div className="input pair">
        <NumInput value={props.min} min={0} max={props.limit ?? 50} integer onChange={(v) => props.onChange(v, Math.max(v, props.max))} />
        <em>to</em>
        <NumInput value={props.max} min={0} max={props.limit ?? 50} integer onChange={(v) => props.onChange(Math.min(v, props.min), v)} />
      </div>
    </div>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  hint?: string;
}) {
  return (
    <label className="field slider" title={props.hint}>
      <span>
        {props.label}
        <b>{props.format ? props.format(props.value) : props.value}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Select<T extends string>(props: {
  label?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; group?: string }[];
  hint?: string;
}) {
  const groups = [...new Set(props.options.map((o) => o.group))];
  const select = (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {groups.map((g) =>
        g === undefined ? (
          props.options.filter((o) => !o.group).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
        ) : (
          <optgroup key={g} label={g}>
            {props.options.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        ),
      )}
    </select>
  );
  if (!props.label) return select;
  return (
    <label className="field" title={props.hint}>
      <span>{props.label}</span>
      {select}
    </label>
  );
}

export function Seg<T extends string | number>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; title?: string }[];
}) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={String(o.value)} className={o.value === props.value ? 'on' : ''} title={o.title} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="field toggle" title={props.hint}>
      <span>{props.label}</span>
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
    </label>
  );
}

export function Stat(props: { label: string; value: string; unit?: string; sub?: string; hint?: string }) {
  return (
    <div className="stat" title={props.hint}>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">
        {props.value}
        {props.unit && <small>{props.unit}</small>}
      </div>
      {props.sub && <div className="stat-sub">{props.sub}</div>}
    </div>
  );
}

export function FloorSelect(props: { value: number; top: number; onChange: (f: number) => void; exclude?: number }) {
  const floors = [];
  for (let f = props.top; f >= 0; f--) if (f !== props.exclude) floors.push(f);
  return (
    <select className="floor-select" value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
      {floors.map((f) => (
        <option key={f} value={f}>{f === 0 ? 'G (lobby)' : `Floor ${f}`}</option>
      ))}
    </select>
  );
}
