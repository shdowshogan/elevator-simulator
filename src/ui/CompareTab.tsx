import { useEffect, useMemo, useRef, useState } from 'react';
import { listAlgorithms } from '../algorithms/registry';
import type { Summary } from '../sim/metrics';
import { defaultElevator, type SimConfig } from '../sim/types';
import type { BenchJob, BenchMessage } from '../workers/benchmark.worker';
import { BarChart, Scatter } from './charts';
import { fmtInt, NumInput, Select } from './components';
import { applyZoning } from './ConfigPanel';
import { useStore, type CompareRow } from './store';

type Sweep = 'none' | 'cars' | 'zoning' | 'mode' | 'demand';

const PERIODS = [
  { label: 'Full day (24 h)', start: 0, hours: 24 },
  { label: 'Morning rush (06:00–10:00)', start: 6, hours: 4 },
  { label: 'Midday (11:00–15:00)', start: 11, hours: 4 },
  { label: 'Evening rush (16:30–21:30)', start: 16.5, hours: 5 },
];

const SWEEPS: { value: Sweep; label: string }[] = [
  { value: 'none', label: 'Current setup only' },
  { value: 'zoning', label: 'Zoning: all floors vs even/odd vs low/high' },
  { value: 'cars', label: 'Number of elevators' },
  { value: 'mode', label: 'Up/down buttons vs destination keypads' },
  { value: 'demand', label: 'Demand level (0.5× to 3×)' },
];

function variants(cfg: SimConfig, sweep: Sweep, from: number, to: number): { label: string; config: SimConfig; fixedMode?: boolean }[] {
  const withElevators = (fn: (b: SimConfig['buildings'][number]) => SimConfig['buildings'][number]['elevators']) => ({
    ...cfg,
    buildings: cfg.buildings.map((b) => ({ ...b, elevators: fn(b) })),
  });
  switch (sweep) {
    case 'cars': {
      const out = [];
      for (let k = Math.min(from, to); k <= Math.max(from, to); k++) {
        out.push({
          label: `${k} car${k === 1 ? '' : 's'}`,
          config: withElevators((b) => Array.from({ length: k }, (_, i) => ({ ...(b.elevators[i] ?? b.elevators[0] ?? defaultElevator()) }))),
        });
      }
      return out;
    }
    case 'zoning': {
      const out = [
        { label: 'All floors', config: withElevators((b) => applyZoning(b.elevators, 'all')) },
        { label: 'Even / odd', config: withElevators((b) => applyZoning(b.elevators, 'evenodd')) },
        { label: 'Low / high', config: withElevators((b) => applyZoning(b.elevators, 'lowhigh')) },
      ];
      if (cfg.buildings.every((b) => b.elevators.length >= 3)) {
        out.push({ label: '1 even + 1 odd + rest all', config: withElevators((b) => applyZoning(b.elevators, 'mixed')) });
      }
      return out;
    }
    case 'mode':
      return [
        { label: 'Up/down buttons', config: { ...cfg, callMode: 'hall' }, fixedMode: true },
        { label: 'Destination keypad', config: { ...cfg, callMode: 'destination' }, fixedMode: true },
      ];
    case 'demand':
      return [0.5, 1, 1.5, 2, 3].map((m) => ({
        label: `${m}× demand`,
        config: { ...cfg, traffic: { ...cfg.traffic, demandMultiplier: cfg.traffic.demandMultiplier * m } },
      }));
    default:
      return [{ label: '', config: cfg }];
  }
}

function average(list: Summary[]): Summary {
  const out = { ...list[0] } as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'number') out[key] = list.reduce((a, s) => a + (s as unknown as Record<string, number>)[key], 0) / list.length;
  }
  out.lastError = list.find((s) => s.lastError)?.lastError ?? null;
  return out as unknown as Summary;
}

const COLUMNS: { key: string; label: string; hint: string; get: (s: Summary) => number; digits: number; better: 'low' | 'high' | null }[] = [
  { key: 'wait', label: 'Avg wait', hint: 'Seconds from pressing the button to boarding', get: (s) => s.avgWait, digits: 1, better: 'low' },
  { key: 'p95', label: '95% wait', hint: '95% of people waited less than this (s)', get: (s) => s.p95Wait, digits: 0, better: 'low' },
  { key: 'max', label: 'Longest', hint: 'Longest wait (s)', get: (s) => s.maxWait, digits: 0, better: 'low' },
  { key: 'journey', label: 'Door to door', hint: 'Average wait plus ride (s)', get: (s) => s.avgJourney, digits: 1, better: 'low' },
  { key: 'long', label: 'Over 60 s', hint: 'Share of people who waited more than a minute (%)', get: (s) => s.longWaitPct, digits: 1, better: 'low' },
  { key: 'kwh', label: 'kWh', hint: 'Electricity for the whole period', get: (s) => s.energyKWh, digits: 1, better: 'low' },
  { key: 'wh', label: 'Wh / trip', hint: 'Electricity per delivered person', get: (s) => s.whPerTrip, digits: 0, better: 'low' },
  { key: 'comfort', label: 'Comfort', hint: 'Ride quality score, 0–100', get: (s) => s.comfort, digits: 1, better: 'high' },
  { key: 'stops', label: 'Stops', hint: 'Intermediate stops per ride', get: (s) => s.avgStops, digits: 2, better: 'low' },
  { key: 'delivered', label: 'Delivered', hint: 'People who completed their trip', get: (s) => s.delivered, digits: 0, better: null },
  { key: 'left', label: 'Left over', hint: 'People still waiting or riding at the end', get: (s) => s.waitingNow + s.ridingNow, digits: 0, better: 'low' },
];

export function CompareTab() {
  const config = useStore((s) => s.config);
  const editorAlgos = useStore((s) => s.editorAlgos);
  const algoParams = useStore((s) => s.algoParams);
  const rows = useStore((s) => s.compareRows);
  const running = useStore((s) => s.compareRunning);
  const set = useStore((s) => s.set);
  const entries = useMemo(() => listAlgorithms(editorAlgos).filter((e) => e.algo), [editorAlgos]);

  const [picked, setPicked] = useState<string[]>(() => entries.filter((e) => e.kind !== 'builtin' || ['eta', 'group-nearest', 'look', 'energy-saver', 'fcfs'].includes(e.id)).map((e) => e.id));
  const [sweep, setSweep] = useState<Sweep>('none');
  const [from, setFrom] = useState(2);
  const [to, setTo] = useState(6);
  const [period, setPeriod] = useState(0);
  const [seeds, setSeeds] = useState(1);
  const [preferred, setPreferred] = useState(true);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const workers = useRef<Worker[]>([]);

  const stop = () => {
    workers.current.forEach((w) => w.terminate());
    workers.current = [];
    set({ compareRunning: false });
  };
  useEffect(() => () => workers.current.forEach((w) => w.terminate()), []);

  const run = () => {
    stop();
    const p = PERIODS[period];
    const vs = variants(config, sweep, from, to);
    const jobs: BenchJob[] = [];
    const table: CompareRow[] = [];
    const partial = new Map<string, { done: Summary[]; progress: number[] }>();
    for (const id of picked) {
      const entry = entries.find((e) => e.id === id);
      if (!entry?.algo) continue;
      vs.forEach((v, vi) => {
        const key = `${id}|${vi}`;
        table.push({ key, algorithm: entry.name, variant: v.label, progress: 0, summary: null });
        partial.set(key, { done: [], progress: new Array(seeds).fill(0) });
        for (let s = 0; s < seeds; s++) {
          jobs.push({
            key: `${key}|${s}`,
            config: {
              ...v.config,
              scenario: null,
              startHour: p.start,
              seed: config.seed + s * 7919,
              callMode: preferred && !v.fixedMode && entry.algo!.prefersMode ? entry.algo!.prefersMode : v.config.callMode,
            },
            algoId: id,
            source: editorAlgos.find((e) => e.id === id)?.source,
            params: algoParams[id] ?? {},
            hours: p.hours,
          });
        }
      });
    }
    if (!jobs.length) return;
    set({ compareRows: table, compareRunning: true });

    let next = 0;
    let finished = 0;
    const patch = (key: string, change: Partial<CompareRow>) =>
      set({ compareRows: useStore.getState().compareRows.map((r) => (r.key === key ? { ...r, ...change } : r)) });
    const feed = (w: Worker) => {
      if (next < jobs.length) w.postMessage(jobs[next++]);
    };
    const size = Math.max(1, Math.min(jobs.length, (navigator.hardwareConcurrency || 4) - 1, 6));
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('../workers/benchmark.worker.ts', import.meta.url), { type: 'module' });
      workers.current.push(w);
      w.onmessage = (e: MessageEvent<BenchMessage>) => {
        const m = e.data;
        const [id, vi, s] = m.key.split('|');
        const key = `${id}|${vi}`;
        const acc = partial.get(key)!;
        if ('progress' in m) {
          acc.progress[Number(s)] = m.progress;
          patch(key, { progress: acc.progress.reduce((a, c) => a + c, 0) / seeds });
          return;
        }
        if ('error' in m) patch(key, { error: m.error, progress: 1 });
        else {
          acc.done.push(m.summary);
          if (acc.done.length === seeds) patch(key, { summary: average(acc.done), progress: 1 });
        }
        if (++finished === jobs.length) stop();
        else feed(w);
      };
      feed(w);
    }
  };

  const done = rows.filter((r) => r.summary);
  // One algorithm across several setups: the setup alone tells the rows apart.
  const oneAlgorithm = new Set(rows.map((r) => r.algorithm)).size === 1;
  const label = (r: CompareRow) => (!r.variant ? r.algorithm : oneAlgorithm ? r.variant : `${r.algorithm} · ${r.variant}`);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = COLUMNS.find((c) => c.key === sort.key)!;
    return [...rows].sort((a, b) => ((a.summary ? col.get(a.summary) : Infinity) - (b.summary ? col.get(b.summary) : Infinity)) * sort.dir);
  }, [rows, sort]);
  const best = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of COLUMNS) {
      if (!c.better || done.length < 2) continue;
      const vals = done.map((r) => c.get(r.summary!));
      if (Math.min(...vals) === Math.max(...vals)) continue; // a tie is not a win
      out[c.key] = c.better === 'low' ? Math.min(...vals) : Math.max(...vals);
    }
    return out;
  }, [rows]);
  const jobCount = picked.length * variants(config, sweep, from, to).length * seeds;

  return (
    <div className="page">
      <div className="page-side">
        <h2>Compare</h2>
        <p className="note">Runs every selected algorithm against exactly the same people and trips, without drawing anything, and tabulates the results. It uses the building and traffic settings from the Simulate tab.</p>

        <h4>Algorithms</h4>
        <div className="checklist">
          {entries.map((e) => (
            <label key={e.id}>
              <input type="checkbox" checked={picked.includes(e.id)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.id] : picked.filter((x) => x !== e.id))} />
              <span>{e.name}</span>
              {e.kind !== 'builtin' && <em>{e.kind === 'file' ? 'file' : 'editor'}</em>}
            </label>
          ))}
        </div>

        <h4>Also vary</h4>
        <Select value={sweep} onChange={setSweep} options={SWEEPS} />
        {sweep === 'cars' && (
          <div className="add-row">
            <span>From</span><NumInput value={from} min={1} max={12} integer onChange={setFrom} />
            <span>to</span><NumInput value={to} min={1} max={12} integer onChange={setTo} />
            <span>cars per building</span>
          </div>
        )}
        {sweep === 'zoning' && <p className="note">Splits each building's cars in half: one half per zone. Trips between an even and an odd floor then need a change of cars in the lobby.</p>}

        <h4>Period</h4>
        <Select value={String(period)} onChange={(v) => setPeriod(Number(v))} options={PERIODS.map((p, i) => ({ value: String(i), label: p.label }))} />
        <div className="add-row">
          <span>Repeat with</span><NumInput value={seeds} min={1} max={10} integer onChange={setSeeds} />
          <span>different random day{seeds === 1 ? '' : 's'}, averaged</span>
        </div>
        {sweep !== 'mode' && (
          <label className="check">
            <input type="checkbox" checked={preferred} onChange={(e) => setPreferred(e.target.checked)} />
            <span>Give destination dispatch its keypads</span>
          </label>
        )}

        <div className="chips">
          {running ? <button onClick={stop}>Stop</button> : <button className="primary" disabled={!picked.length} onClick={run}>Run {jobCount} simulation{jobCount === 1 ? '' : 's'}</button>}
        </div>
      </div>

      <div className="page-main">
        {rows.length === 0 ? (
          <div className="empty">
            <h3>No results yet</h3>
            <p>Pick the algorithms on the left and press Run. A full simulated day takes about a second per algorithm.</p>
            <p>To test whether dedicated even/odd elevators are worth it, choose <b>Zoning</b> under “Also vary”.</p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="results">
                <thead>
                  <tr>
                    <th>Algorithm</th>
                    {rows.some((r) => r.variant) && <th>Setup</th>}
                    {COLUMNS.map((c) => (
                      <th key={c.key} title={`${c.hint}. Click to sort.`} className="num sortable" onClick={() => setSort(sort?.key === c.key ? (sort.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
                        {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.key}>
                      <td>{r.algorithm}</td>
                      {rows.some((x) => x.variant) && <td>{r.variant}</td>}
                      {r.summary ? (
                        COLUMNS.map((c) => {
                          const v = c.get(r.summary!);
                          return <td key={c.key} className={`num ${best[c.key] === v ? 'best' : ''}`}>{c.digits ? v.toFixed(c.digits) : fmtInt(v)}</td>;
                        })
                      ) : (
                        <td colSpan={COLUMNS.length} className="progress-cell">
                          {r.error ? <span className="warn-text">Failed: {r.error}</span> : <span className="progress"><span style={{ width: `${r.progress * 100}%` }} /></span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {done.some((r) => r.summary!.faults > 0) && (
              <p className="warn">Some algorithms made invalid requests or threw errors during the run: {done.filter((r) => r.summary!.faults > 0).map((r) => `${label(r)} (${fmtInt(r.summary!.faults)})`).join(', ')}.</p>
            )}
            {done.length > 0 && (
              <div className="chart-grid">
                <BarChart title="Average wait" rows={done.map((r) => ({ label: label(r), value: r.summary!.avgWait }))} format={(v) => `${v.toFixed(1)} s`} />
                <BarChart title="Electricity" rows={done.map((r) => ({ label: label(r), value: r.summary!.energyKWh }))} format={(v) => `${v.toFixed(1)} kWh`} />
                <BarChart title="Comfort" lowerIsBetter={false} rows={done.map((r) => ({ label: label(r), value: r.summary!.comfort }))} format={(v) => v.toFixed(1)} />
                <div className="barchart">
                  <h4>Time against electricity<small>bottom-left is better on both</small></h4>
                  <Scatter
                    points={done.map((r) => ({ label: label(r), x: r.summary!.avgJourney, y: r.summary!.energyKWh }))}
                    xLabel="Average door-to-door time (s)"
                    yLabel="Electricity (kWh)"
                    fx={(v) => `${v.toFixed(0)} s`}
                    fy={(v) => `${v.toFixed(0)} kWh`}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
