import { useEffect, useMemo, useRef, useState } from 'react';
import { listAlgorithms } from '../algorithms/registry';
import { LOBBY_NAMES, LOBBY_TITLES } from '../sim/hostel';
import { demandCurve } from '../sim/traffic';
import { hostel18Config, servedFloors, type ElevatorConfig } from '../sim/types';
import type { BenchJob } from '../workers/benchmark.worker';
import { runBench } from './bench';
import { fmtHour, fmtInt, MinMax, Num, Section, Seg, Select, Slider } from './components';
import { AlgorithmPicker, applyZoning, ElevatorCard } from './ConfigPanel';
import { useStore, type CompareRow } from './store';

const PERIODS = [
  { label: 'Full day (24 h)', start: 0, hours: 24 },
  { label: 'Morning rush to class (07:30–10:30)', start: 7.5, hours: 3 },
  { label: 'Lunch and afternoon (12:00–15:00)', start: 12, hours: 3 },
  { label: 'Evening and night (17:00–01:00)', start: 17, hours: 8 },
];

/** Ranks every algorithm on the hostel as it is currently set up. */
function Ranking() {
  const hostel = useStore((s) => s.hostel);
  const editorAlgos = useStore((s) => s.editorAlgos);
  const algoParams = useStore((s) => s.algoParams);
  const algoId = useStore((s) => s.algoId);
  const rows = useStore((s) => s.hostelRank);
  const running = useStore((s) => s.hostelRankRunning);
  const set = useStore((s) => s.set);
  const [period, setPeriod] = useState(0);
  const cancel = useRef<() => void>(() => {});
  useEffect(() => () => cancel.current(), []);

  const run = () => {
    cancel.current();
    const p = PERIODS[period];
    const entries = listAlgorithms(editorAlgos).filter((e) => e.algo);
    const jobs: BenchJob[] = entries.map((e) => ({
      key: e.id,
      // each algorithm gets the call buttons it was designed for
      config: { ...hostel, scenario: null, startHour: p.start, callMode: e.algo!.prefersMode ?? hostel.callMode },
      algoId: e.id,
      source: editorAlgos.find((x) => x.id === e.id)?.source,
      params: algoParams[e.id] ?? {},
      hours: p.hours,
    }));
    set({
      hostelRankRunning: true,
      hostelRank: entries.map((e) => ({ key: e.id, algorithm: e.name, variant: '', progress: 0, summary: null })),
    });
    const patch = (key: string, change: Partial<CompareRow>) =>
      set({ hostelRank: useStore.getState().hostelRank.map((r) => (r.key === key ? { ...r, ...change } : r)) });
    cancel.current = runBench(
      jobs,
      (m) => {
        if ('progress' in m) patch(m.key, { progress: m.progress });
        else if ('error' in m) patch(m.key, { error: m.error, progress: 1 });
        else patch(m.key, { summary: m.summary, progress: 1 });
      },
      () => set({ hostelRankRunning: false }),
    );
  };

  const sorted = [...rows].sort((a, b) => (a.summary?.avgWait ?? Infinity) - (b.summary?.avgWait ?? Infinity));
  return (
    <>
      <p className="note">Runs every algorithm on this exact hostel setup, with the same students making the same trips, and ranks them by waiting time.</p>
      <Select value={String(period)} onChange={(v) => setPeriod(Number(v))} options={PERIODS.map((p, i) => ({ value: String(i), label: p.label }))} />
      <div className="chips">
        {running ? (
          <button onClick={() => { cancel.current(); set({ hostelRankRunning: false }); }}>Stop</button>
        ) : (
          <button className="primary" onClick={run}>Rank all algorithms</button>
        )}
      </div>
      {rows.length > 0 && (
        <table className="mini-table rank">
          <thead>
            <tr>
              <th>Algorithm</th>
              <th title="Average seconds from pressing the button to boarding">Wait</th>
              <th title="95% of people waited less than this">95%</th>
              <th title="Average seconds from leaving the room to arriving, including the walk to and from the lift">Total</th>
              <th title="Electricity for the period">kWh</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key} className={r.key === algoId ? 'current' : ''} onClick={() => set({ algoId: r.key })} title="Click to run this algorithm in the 3D view">
                <td>{r.algorithm}</td>
                {r.summary ? (
                  <>
                    <td>{r.summary.avgWait.toFixed(1)}</td>
                    <td>{r.summary.p95Wait.toFixed(0)}</td>
                    <td>{r.summary.avgTotal.toFixed(0)}</td>
                    <td>{r.summary.energyKWh.toFixed(1)}</td>
                  </>
                ) : (
                  <td colSpan={4}>{r.error ? <span className="warn-text">failed</span> : <span className="progress"><span style={{ width: `${r.progress * 100}%` }} /></span>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && !running && <p className="note">Seconds, best wait first. Click a row to watch that algorithm. For zoning or lift-count experiments, the Compare tab can use the hostel too.</p>}
    </>
  );
}

export function HostelPanel() {
  const hostel = useStore((s) => s.hostel);
  const spread = useStore((s) => s.hostelSpread);
  const set = useStore((s) => s.set);
  const update = useStore((s) => s.updateHostel);
  const b = hostel.buildings[0];
  const t = hostel.traffic;
  const curve = useMemo(() => demandCurve(hostel), [hostel]);
  const editLift = (i: number, fn: (e: ElevatorConfig) => void) => update((c) => fn(c.buildings[0].elevators[i]));
  const covered = new Array<boolean>(b.floors + 1).fill(false);
  for (const e of b.elevators) servedFloors(e, b.floors).forEach((s, f) => (covered[f] ||= s));
  const missing = covered.flatMap((s, f) => (s ? [] : [f]));

  return (
    <div className="panel-scroll">
      <div className="summary-strip">
        <div><b>{fmtInt(curve.residents)}</b><span>students</span></div>
        <div><b>{fmtInt(curve.total)}</b><span>lift trips / day</span></div>
        <div><b>{b.elevators.length}</b><span>lift{b.elevators.length === 1 ? '' : 's'}</span></div>
      </div>
      <p className="note">
        Hostel 18 as a figure-8 block: two wings, three cross-blocks, two courtyards, and a lift at each of the six junctions. Floors are drawn as open trays so you can see the corridors.
      </p>

      <Section title="Algorithm">
        <AlgorithmPicker callMode={hostel.callMode} onMode={(m) => update((c) => { c.callMode = m; })} />
      </Section>

      <Section title="Find the best algorithm">
        <Ranking />
      </Section>

      <Section title="How students choose a lift">
        <Seg
          value={hostel.liftChoice ?? 'nearest'}
          onChange={(v) => update((c) => { c.liftChoice = v; })}
          options={[
            { value: 'nearest', label: 'Shortest walk', title: 'Everyone uses the lift that means the least walking overall' },
            { value: 'guided', label: 'Guided to the fastest', title: 'A screen or app sends each person to the lift with the best walk-plus-wait' },
          ]}
        />
        <p className="note">
          {(hostel.liftChoice ?? 'nearest') === 'nearest'
            ? 'Each student takes the lift that needs the least walking in total. People coming in through the front door take the first lift they reach, so the lift beside it gets the crowd. Anyone who finds more people waiting than the lift can hold walks on to a quieter one.'
            : 'Imagine a display by the door or an app: each student is sent to the lift where walking plus expected waiting is lowest, which spreads the load across all six. A custom algorithm can make this choice itself with chooseLobby().'}
        </p>
        <div className="field">
          <span>Call buttons</span>
          <Seg
            value={hostel.callMode}
            onChange={(v) => update((c) => { c.callMode = v; })}
            options={[
              { value: 'hall', label: 'Up / down buttons' },
              { value: 'destination', label: 'Destination keypad' },
            ]}
          />
        </div>
      </Section>

      <Section title="View">
        <Slider label="Pull the floors apart" min={1} max={3.5} step={0.1} value={spread} format={(v) => (v === 1 ? 'true scale' : `${v.toFixed(1)}×`)} hint="Stretches the drawing vertically so you can look into every floor. It does not change the simulation." onChange={(v) => set({ hostelSpread: v })} />
      </Section>

      <Section title="Building" open={false}>
        <div className="grid2">
          <Num label="Floors" value={b.floors} min={2} max={30} integer hint="Floors of rooms above the ground floor" onChange={(v) => update((c) => { c.buildings[0].floors = v; })} />
          <Num label="Rooms per floor" value={b.flatsPerFloor} min={30} max={260} integer hint="The wings grow or shrink to fit" onChange={(v) => update((c) => { c.buildings[0].flatsPerFloor = v; })} />
        </div>
        <Select
          label="Front door at"
          hint="Where people enter and leave the building on the ground floor"
          value={String(b.entrance ?? 4)}
          onChange={(v) => update((c) => { c.buildings[0].entrance = Number(v); })}
          options={LOBBY_TITLES.map((title, i) => ({ value: String(i), label: `${title} junction` }))}
        />
        <MinMax label="Students per room" min={b.residentsMin} max={b.residentsMax} limit={4} onChange={(lo, hi) => update((c) => { c.buildings[0].residentsMin = lo; c.buildings[0].residentsMax = hi; })} />
        <MinMax label="Visitors per room per day" min={b.visitorsMin} max={b.visitorsMax} limit={10} hint="Guests and food deliveries" onChange={(lo, hi) => update((c) => { c.buildings[0].visitorsMin = lo; c.buildings[0].visitorsMax = hi; })} />
        <div className="grid2">
          <Num label="Floor height" unit="m" value={b.floorHeight} min={2.6} max={5} step={0.1} onChange={(v) => update((c) => { c.buildings[0].floorHeight = v; })} />
          <Num label="Walking speed" unit="m/s" value={hostel.walkSpeed} min={0.5} max={3} step={0.1} onChange={(v) => update((c) => { c.walkSpeed = v; })} />
        </div>
      </Section>

      <Section title={`Lifts (${b.elevators.length})`} open={false}>
        <div className="field">
          <span>Quick zoning</span>
          <div className="chips">
            <button onClick={() => update((c) => { c.buildings[0].elevators = applyZoning(c.buildings[0].elevators, 'all'); })}>All floors</button>
            <button title="Alternating around the building: NW, E and SW take even floors; NE, W and SE take odd" onClick={() => update((c) => { c.buildings[0].elevators = applyZoning(c.buildings[0].elevators, 'evenodd'); })}>Even / odd</button>
            <button onClick={() => update((c) => { c.buildings[0].elevators = applyZoning(c.buildings[0].elevators, 'lowhigh'); })}>Low / high</button>
          </div>
        </div>
        {missing.length > 0 && <p className="warn">No lift stops at floor{missing.length > 1 ? 's' : ''} {missing.join(', ')}. Students there cannot travel.</p>}
        {LOBBY_NAMES.map((name, bank) => {
          const here = b.elevators.map((e, i) => ({ e, i })).filter((x) => (x.e.bank ?? 0) === bank);
          return (
            <div key={bank} className="lobby-group">
              <div className="lobby-head">
                <b>{LOBBY_TITLES[bank]} junction</b>
                <span className="muted">{here.length ? `${here.length} lift${here.length > 1 ? 's' : ''}` : 'no lift'}</span>
                <span className="spacer" />
                <div className="stepper">
                  <button
                    title="Remove a lift here"
                    disabled={!here.length || b.elevators.length <= 1}
                    onClick={() => update((c) => { c.buildings[0].elevators.splice(here[here.length - 1].i, 1); })}
                  >−</button>
                  <button
                    title="Add a lift here"
                    disabled={here.length >= 3}
                    onClick={() => update((c) => { c.buildings[0].elevators.push({ ...(here[0]?.e ?? c.buildings[0].elevators[0]), bank }); })}
                  >+</button>
                </div>
              </div>
              {here.map(({ e, i }, k) => (
                <ElevatorCard
                  key={i}
                  e={e}
                  index={i}
                  floors={b.floors}
                  title={`Lift ${name}${k ? k + 1 : ''}`}
                  onChange={(fn) => editLift(i, fn)}
                  onCopyToAll={() => update((c) => { c.buildings[0].elevators = c.buildings[0].elevators.map((o) => ({ ...e, served: o.served, customFloors: o.customFloors, bank: o.bank })); })}
                />
              ))}
            </div>
          );
        })}
        <div className="grid2">
          <Num label="Doors stay open" unit="s" value={hostel.doorDwell} min={0.5} max={15} step={0.5} onChange={(v) => update((c) => { c.doorDwell = v; })} />
        </div>
      </Section>

      <Section title="Student traffic" open={false}>
        <Slider label="Overall demand" min={0.2} max={4} step={0.1} value={t.demandMultiplier} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => update((c) => { c.traffic.demandMultiplier = v; })} />
        <Slider label="Students with morning classes" min={0} max={1} step={0.05} value={t.workShare} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((c) => { c.traffic.workShare = v; })} />
        <Slider label="Typical time they leave" min={7} max={10.5} step={0.1} value={t.workDepartHour} format={fmtHour} onChange={(v) => update((c) => { c.traffic.workDepartHour = v; })} />
        <Slider label="Spread of leaving times" min={0.1} max={1.5} step={0.05} value={t.workDepartSpread} format={(v) => `±${Math.round(v * 60)} min`} hint="Smaller = everyone leaves at once" onChange={(v) => update((c) => { c.traffic.workDepartSpread = v; })} />
        <Slider label="Hours until back for lunch" min={2} max={6} step={0.25} value={t.workDurationHours} format={(v) => `${v} h`} onChange={(v) => update((c) => { c.traffic.workDurationHours = v; })} />
        <Slider label="Evening and night outings" min={0} max={5} step={0.1} value={t.errandsPerDay} format={(v) => `${v.toFixed(1)} / day`} onChange={(v) => update((c) => { c.traffic.errandsPerDay = v; })} />
        <Slider label="Visits to friends on other floors" min={0} max={3} step={0.05} value={t.interfloorPerDay} format={(v) => `${v.toFixed(2)} / day`} onChange={(v) => update((c) => { c.traffic.interfloorPerDay = v; })} />
        <Slider label="Take the stairs for" min={0} max={4} step={1} value={t.stairsFloors ?? 0} format={(v) => (v === 0 ? 'nothing' : `${v} floor${v > 1 ? 's' : ''} or fewer`)} hint="Trips this short never call a lift" onChange={(v) => update((c) => { c.traffic.stairsFloors = v; })} />
        <Slider label="Start the day at" min={0} max={23.5} step={0.5} value={hostel.startHour} format={fmtHour} onChange={(v) => update((c) => { c.startHour = v; })} />
        <Num label="Random seed" value={hostel.seed} min={0} max={999999} integer onChange={(v) => update((c) => { c.seed = v; })} />
      </Section>

      <Section title="Reset" open={false}>
        <div className="chips">
          <button onClick={() => { if (confirm('Reset Hostel 18 to its defaults?')) set({ hostel: hostel18Config(), hostelRank: [] }); }}>Reset Hostel 18</button>
        </div>
        <p className="note">The hostel has its own settings, separate from the Simulate tab; the energy model uses the default values. Changing a setting restarts the run.</p>
      </Section>
    </div>
  );
}
