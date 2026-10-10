import { useEffect, useRef, useState } from 'react';
import type { DemandCurve } from '../sim/traffic';
import { fmtClock } from './components';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const compact = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : `${+v.toFixed(v < 10 ? 1 : 0)}`);

/** Single-series time chart with a crosshair tooltip. */
export function LineChart(props: {
  data: { t: number; v: number }[];
  format: (v: number) => string;
  color?: string;
  height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { data, format, color = 'var(--series-1)', height = 84 } = props;
  const pl = 34, pr = 10, pt = 8, pb = 18;

  const empty = data.length < 2;
  const t0 = empty ? 0 : data[0].t;
  const t1 = empty ? 1 : data[data.length - 1].t;
  const max = niceMax(Math.max(...data.map((d) => d.v)));
  const X = (t: number) => pl + ((t - t0) / Math.max(1, t1 - t0)) * (w - pl - pr);
  const Y = (v: number) => pt + (1 - v / max) * (height - pt - pb);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${X(d.t).toFixed(1)},${Y(d.v).toFixed(1)}`).join('');
  const area = `${line}L${X(t1).toFixed(1)},${Y(0)}L${X(t0).toFixed(1)},${Y(0)}Z`;
  const h = hover !== null && !empty ? data[Math.min(hover, data.length - 1)] : null;

  return (
    <div
      ref={ref}
      className="chart"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        if (empty) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const t = t0 + ((e.clientX - rect.left - pl) / Math.max(1, w - pl - pr)) * (t1 - t0);
        let best = 0;
        for (let i = 1; i < data.length; i++) if (Math.abs(data[i].t - t) < Math.abs(data[best].t - t)) best = i;
        setHover(best);
      }}
    >
      {empty && <div className="chart-empty">Collecting data… first point after 5 simulated minutes</div>}
      {w > 0 && !empty && (
        <svg width={w} height={height}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pl} x2={w - pr} y1={Y(max * f)} y2={Y(max * f)} className={f === 0 ? 'axis' : 'grid'} />
              <text x={pl - 6} y={Y(max * f) + 3} textAnchor="end" className="tick">{compact(max * f)}</text>
            </g>
          ))}
          <text x={pl} y={height - 4} className="tick">{fmtClock(t0)}</text>
          <text x={w - pr} y={height - 4} textAnchor="end" className="tick">{fmtClock(t1)}</text>
          <path d={area} fill={color} opacity={0.1} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {h && (
            <>
              <line x1={X(h.t)} x2={X(h.t)} y1={pt} y2={height - pb} className="crosshair" />
              <circle cx={X(h.t)} cy={Y(h.v)} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      {h && (
        <div className="tip" style={{ left: Math.min(Math.max(X(h.t), 50), w - 50), top: 0 }}>
          <b>{format(h.v)}</b> · {fmtClock(h.t)}
        </div>
      )}
    </div>
  );
}

const DEMAND_SERIES = [
  { key: 'down', label: 'Leaving (down)', color: 'var(--series-2)' },
  { key: 'up', label: 'Arriving (up)', color: 'var(--series-1)' },
  { key: 'inter', label: 'Between floors', color: 'var(--series-3)' },
] as const;

/** Trips per quarter hour across a typical day, with the current time marked. */
export function DemandTimeline(props: { curve: DemandCurve; clock: number; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { curve, clock, height = 58 } = props;
  const n = curve.up.length;
  const pb = 14;
  const plot = height - pb;
  const max = Math.max(1, ...curve.up.map((u, i) => u + curve.down[i] + curve.inter[i]));
  const bw = w / n;
  const now = (((clock % 86400) + 86400) % 86400) / 86400;

  return (
    <div className="timeline">
      <div
        ref={ref}
        className="chart"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / Math.max(1, w)) * n))));
        }}
      >
        {w > 0 && (
          <svg width={w} height={height}>
            {curve.up.map((_, i) => {
              let y = plot;
              return DEMAND_SERIES.map((s) => {
                const v = curve[s.key][i];
                if (!v) return null;
                const hgt = (v / max) * (plot - 2);
                y -= hgt;
                return (
                  <rect
                    key={`${i}${s.key}`}
                    x={i * bw + 0.5}
                    y={y + 0.5}
                    width={Math.max(1, bw - 1)}
                    height={Math.max(0.5, hgt - 1)}
                    fill={s.color}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                );
              });
            })}
            <line x1={0} x2={w} y1={plot} y2={plot} className="axis" />
            {[0, 6, 12, 18, 24].map((hr) => (
              <text key={hr} x={Math.min(w - 2, Math.max(2, (hr / 24) * w))} y={height - 2} textAnchor={hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle'} className="tick">
                {String(hr % 24).padStart(2, '0')}:00
              </text>
            ))}
            <line x1={now * w} x2={now * w} y1={0} y2={plot} className="now" />
          </svg>
        )}
        {hover !== null && (
          <div className="tip" style={{ left: Math.min(Math.max((hover + 0.5) * bw, 90), w - 90), top: -6 }}>
            <b>{fmtClock(hover * curve.bucketMinutes * 60)}</b> · {curve.down[hover]} leaving · {curve.up[hover]} arriving · {curve.inter[hover]} between floors
          </div>
        )}
      </div>
      <div className="legend">
        {DEMAND_SERIES.map((s) => (
          <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
        ))}
        <span className="legend-note">trips per {curve.bucketMinutes} min</span>
      </div>
    </div>
  );
}

/** Horizontal bars for comparing one measure across runs. */
export function BarChart(props: {
  title: string;
  rows: { label: string; value: number }[];
  format: (v: number) => string;
  lowerIsBetter?: boolean;
}) {
  const { rows, format, lowerIsBetter = true } = props;
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  const best = rows.length ? (lowerIsBetter ? Math.min(...rows.map((r) => r.value)) : Math.max(...rows.map((r) => r.value))) : 0;
  return (
    <div className="barchart">
      <h4>{props.title}<small>{lowerIsBetter ? 'lower is better' : 'higher is better'}</small></h4>
      {rows.map((r) => (
        <div className="bar-row" key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <span className="bar-label">{r.label}</span>
          <div className="bar-track">
            <div className="bar" style={{ width: `calc((100% - 104px) * ${Math.max(0.004, r.value / max).toFixed(4)})` }} />
            <span className="bar-value">
              {format(r.value)}
              {rows.length > 1 && r.value === best && <em>best</em>}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Trade-off plot: each run is a dot; hover for the name and values. */
export function Scatter(props: {
  points: { label: string; x: number; y: number }[];
  xLabel: string;
  yLabel: string;
  fx: (v: number) => string;
  fy: (v: number) => string;
  height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { points, height = 260 } = props;
  const pl = 58, pr = 16, pt = 12, pb = 34;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const span = (vals: number[]) => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo || hi || 1) * 0.12;
    return [Math.max(0, lo - pad), hi + pad];
  };
  const [x0, x1] = span(xs);
  const [y0, y1] = span(ys);
  const X = (v: number) => pl + ((v - x0) / (x1 - x0)) * (w - pl - pr);
  const Y = (v: number) => pt + (1 - (v - y0) / (y1 - y0)) * (height - pt - pb);
  const h = hover !== null ? points[hover] : null;
  const direct = points.length <= 3; // more than that and the names collide: number the dots instead

  return (
    <>
    <div ref={ref} className="chart scatter" style={{ height }} onMouseLeave={() => setHover(null)}>
      {w > 0 && points.length > 0 && (
        <svg width={w} height={height}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pl} x2={w - pr} y1={Y(y0 + (y1 - y0) * f)} y2={Y(y0 + (y1 - y0) * f)} className={f === 0 ? 'axis' : 'grid'} />
              <text x={pl - 6} y={Y(y0 + (y1 - y0) * f) + 3} textAnchor="end" className="tick">{compact(y0 + (y1 - y0) * f)}</text>
              <text x={X(x0 + (x1 - x0) * f)} y={height - pb + 14} textAnchor="middle" className="tick">{compact(x0 + (x1 - x0) * f)}</text>
            </g>
          ))}
          <text x={(pl + w - pr) / 2} y={height - 4} textAnchor="middle" className="axis-title">{props.xLabel}</text>
          <text transform={`translate(11 ${(pt + height - pb) / 2}) rotate(-90)`} textAnchor="middle" className="axis-title">{props.yLabel}</text>
          {points.map((p, i) => (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <circle cx={X(p.x)} cy={Y(p.y)} r={14} fill="transparent" />
              <circle cx={X(p.x)} cy={Y(p.y)} r={hover === i ? 6 : 5} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
              <text x={X(p.x) + (X(p.x) > w * 0.7 ? -9 : 9)} y={Y(p.y) + 4} textAnchor={X(p.x) > w * 0.7 ? 'end' : 'start'} className="dot-label">{direct ? p.label : i + 1}</text>
            </g>
          ))}
        </svg>
      )}
      {h && (
        <div className="tip" style={{ left: Math.min(Math.max(X(h.x), 110), w - 110), top: Math.max(0, Y(h.y) - 46) }}>
          <b>{h.label}</b><br />{props.fx(h.x)} · {props.fy(h.y)}
        </div>
      )}
    </div>
    {!direct && (
      <ol className="scatter-key">
        {points.map((p, i) => <li key={i} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>{p.label}</li>)}
      </ol>
    )}
    </>
  );
}
