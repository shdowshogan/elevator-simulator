import { useState } from 'react';
import type { Passenger } from '../sim/engine';
import { CAR_COLORS, floorLabel } from '../sim/types';
import { LineChart } from './charts';
import { FloorSelect, fmtInt, fmtSec, NumInput, Section, Stat } from './components';
import { runtime } from './runtime';
import { useStore } from './store';

const STATE_TEXT: Record<Passenger['state'], string> = {
  walkIn: 'walking to the elevators',
  waiting: 'waiting for a car',
  riding: 'riding',
  walkOut: 'arrived, walking away',
};

function PersonRow({ p, top, lobby }: { p: Passenger; top: number; lobby?: string }) {
  const set = useStore((s) => s.set);
  const sim = runtime.sim;
  return (
    <div className="person-row">
      <button className="link" onClick={() => set({ selection: { type: 'passenger', id: p.id } })}>#{p.id}</button>
      <span className="muted">to</span>
      <FloorSelect value={p.finalDest} top={top} exclude={p.state === 'riding' ? undefined : p.floor} onChange={(f) => sim.setDestination(p.id, f)} />
      {lobby && <span className="muted">{lobby}</span>}
      {p.state === 'waiting' && <span className="muted">{fmtSec(sim.time - p.tCall)}</span>}
      <span className="spacer" />
      <button className="ghost" title="Remove this person" onClick={() => sim.removePassenger(p.id)}>✕</button>
    </div>
  );
}

function Inspector() {
  const selection = useStore((s) => s.selection);
  const set = useStore((s) => s.set);
  useStore((s) => s.live?.tick); // re-render with the simulation
  const [dest, setDest] = useState(0);
  const [count, setCount] = useState(1);
  const [lobby, setLobby] = useState(0);
  const sim = runtime.sim;
  if (!selection || !sim) {
    return <p className="note">Click a person, an elevator or a floor in the 3D view to inspect it and change where people want to go.</p>;
  }

  if (selection.type === 'passenger') {
    const hit = sim.find(selection.id);
    if (!hit) return <p className="note">Person #{selection.id} has left.</p>;
    const { b, p } = hit;
    const top = b.levels - 1;
    const where = p.state === 'riding' ? `in lift ${b.cars[p.car].name}` : `on ${p.floor === 0 ? 'the ground floor' : `floor ${p.floor}`}`;
    return (
      <div className="inspector">
        <h4>Person #{p.id}<small>{b.cfg.name}</small></h4>
        <p className="note">{STATE_TEXT[p.state]} {where}</p>
        {p.state !== 'walkOut' && (
          <div className="field">
            <span>Wants to go to</span>
            <FloorSelect value={p.finalDest} top={top} exclude={p.state === 'riding' ? undefined : p.floor} onChange={(f) => sim.setDestination(p.id, f)} />
          </div>
        )}
        {p.finalDest !== p.dest && <p className="note">Will change cars in the lobby: no single car serves both floors.</p>}
        <div className="kv">
          <span>Waited so far</span><b>{fmtSec(p.waitTotal + (p.state === 'waiting' ? sim.time - p.tCall : 0))}</b>
          <span>Riding time</span><b>{fmtSec(p.rideTotal + (p.state === 'riding' ? sim.time - p.tBoard : 0))}</b>
          {p.assignedCar >= 0 && <><span>Told to take</span><b>Lift {b.cars[p.assignedCar].name}</b></>}
          {b.banks > 1 && p.state !== 'riding' && <><span>Using the lift at</span><b>{b.plan.bankNames[p.bank]}</b></>}
        </div>
        <div className="chips">
          <button onClick={() => { sim.removePassenger(p.id); set({ selection: null }); }}>Remove person</button>
        </div>
      </div>
    );
  }

  const b = sim.buildings[selection.b];
  if (!b) return null;
  const top = b.levels - 1;

  if (selection.type === 'car') {
    const c = b.cars[selection.car];
    if (!c) return null;
    const here = sim.floorOf(b, c);
    return (
      <div className="inspector">
        <h4><i className="dot" style={{ background: CAR_COLORS[c.index % CAR_COLORS.length] }} />Lift {c.name}<small>{b.cfg.name}</small></h4>
        <div className="kv">
          <span>Position</span><b>{floorLabel(here)}{c.state === 'moving' ? ` → ${floorLabel(c.target)}` : ''}</b>
          <span>State</span><b>{c.state}{c.parking ? ' (parking)' : ''}</b>
          <span>On board</span><b>{c.riders.length} / {c.cfg.capacity}</b>
          <span>Energy used</span><b>{(c.energyJ / 3.6e6).toFixed(2)} kWh</b>
        </div>
        <h5>Riders and where they want to go</h5>
        {c.riders.length === 0 && <p className="note">Empty.</p>}
        {c.riders.map((p) => <PersonRow key={p.id} p={p} top={top} />)}
        <div className="add-row">
          <span>Add rider to</span>
          <FloorSelect value={dest} top={top} onChange={setDest} />
          <button disabled={c.riders.length >= c.cfg.capacity} onClick={() => sim.addRider(b.index, c.index, dest)}>Add</button>
        </div>
      </div>
    );
  }

  const f = selection.floor;
  const addDest = dest === f ? (f === 0 ? top : 0) : dest;
  const here = sim.waitingAt(b, f);
  return (
    <div className="inspector">
      <h4>{f === 0 ? 'Ground floor (lobby)' : `Floor ${f}`}<small>{b.cfg.name}</small></h4>
      <div className="chips">
        <button onClick={() => runtime.scene?.focusFloor(b.index, f)}>Look here</button>
      </div>
      <h5>Waiting here ({here.length})</h5>
      {here.length === 0 && <p className="note">Nobody is waiting.</p>}
      {here.slice(0, 30).map((p) => <PersonRow key={p.id} p={p} top={top} lobby={b.banks > 1 ? b.plan.bankNames[p.bank] : undefined} />)}
      {here.length > 30 && <p className="note">…and {here.length - 30} more.</p>}
      <div className="add-row">
        <span>Add</span>
        <NumInput value={count} min={1} max={40} integer onChange={setCount} />
        <span>going to</span>
        <FloorSelect value={addDest} top={top} exclude={f} onChange={setDest} />
        {b.banks > 1 && (
          <>
            <span>at</span>
            <select value={lobby} onChange={(e) => setLobby(Number(e.target.value))}>
              {b.plan.bankNames.map((name, k) => <option key={k} value={k}>{name} lift</option>)}
            </select>
          </>
        )}
        <button onClick={() => { for (let i = 0; i < count; i++) sim.addPassenger(b.index, f, addDest, b.banks > 1 ? lobby : undefined); }}>Add</button>
      </div>
    </div>
  );
}

function ElevatorBoard() {
  useStore((s) => s.live?.tick);
  const set = useStore((s) => s.set);
  const selection = useStore((s) => s.selection);
  const sim = runtime.sim;
  if (!sim) return null;
  return (
    <div className="board">
      {sim.buildings.map((b) => (
        <div key={b.index}>
          {sim.buildings.length > 1 && <h5>{b.cfg.name}</h5>}
          {b.cars.map((c) => {
            const stops = [...new Set(c.riders.map((p) => p.dest))].sort((x, y) => x - y);
            const arrow = c.state === 'moving' ? (c.vel >= 0 ? '▲' : '▼') : c.state === 'idle' ? '·' : '◇';
            const selected = selection?.type === 'car' && selection.b === b.index && selection.car === c.index;
            return (
              <button key={c.index} className={`board-row ${selected ? 'on' : ''}`} onClick={() => set({ selection: { type: 'car', b: b.index, car: c.index } })}>
                <i className="dot" style={{ background: CAR_COLORS[c.index % CAR_COLORS.length] }} />
                <b>{c.name}</b>
                <span className="board-floor">{floorLabel(sim.floorOf(b, c))}</span>
                <span className="board-arrow">{arrow}</span>
                <span className="meter" title={`${c.riders.length} of ${c.cfg.capacity} people`}>
                  <span style={{ width: `${(100 * c.riders.length) / c.cfg.capacity}%` }} />
                </span>
                <span className="board-load">{c.riders.length}/{c.cfg.capacity}</span>
                <span className="board-stops">{stops.length ? stops.map(floorLabel).join(' ') : c.parking ? 'parking' : c.state === 'idle' ? 'idle' : ''}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function StatsPanel() {
  const live = useStore((s) => s.live);
  if (!live) return null;
  const s = live.summary;
  const series = live.series;
  return (
    <div className="panel-scroll">
      {live.error && <p className="warn">The selected algorithm could not be loaded ({live.error}). Running “shortest ETA” instead.</p>}
      {s.lastError && <p className="warn">The algorithm threw an error {fmtInt(s.faults)} time{s.faults === 1 ? '' : 's'}: {s.lastError}</p>}
      {!s.lastError && s.faults > 0 && <p className="warn">The algorithm asked for a floor its car cannot reach {fmtInt(s.faults)} time{s.faults === 1 ? '' : 's'}; those requests were ignored.</p>}
      {s.unserved > 0 && <p className="warn">{fmtInt(s.unserved)} trips could not start because no car serves the floor.</p>}

      <div className="stats">
        <Stat label="Average wait" value={s.avgWait.toFixed(1)} unit="s" sub={`95% under ${s.p95Wait.toFixed(0)} s · longest ${s.maxWait.toFixed(0)} s`} hint="From pressing the button to stepping into a car" />
        <Stat label="Door to door" value={s.avgJourney.toFixed(1)} unit="s" sub={`${s.avgRide.toFixed(1)} s riding · ${s.avgTotal.toFixed(0)} s with the walk to and from the lift`} hint="Waiting plus riding. The second figure adds the time spent walking between the room or street and the lift." />
        <Stat label="Electricity" value={s.energyKWh.toFixed(1)} unit="kWh" sub={`${s.whPerTrip.toFixed(0)} Wh per trip · ${s.distanceKm.toFixed(1)} km travelled`} hint="Net of energy fed back by the regenerative drive. It can dip below zero for a moment: an empty car going up is pulled by its heavier counterweight and generates power." />
        <Stat label="Comfort" value={s.comfort.toFixed(0)} unit="/ 100" sub={`cars ${Math.round(s.avgCrowd * 100)}% full · ${s.wrongWayPct.toFixed(1)}% carried the wrong way`} hint="100 minus penalties for crowding (35), stops on the way (30), riding the wrong way first (15), harsh acceleration (10) and long waits (10)" />
      </div>
      <div className="mini-stats">
        <span><b>{fmtInt(s.delivered)}</b> delivered</span>
        <span><b>{s.waitingNow}</b> waiting</span>
        <span><b>{s.ridingNow}</b> riding</span>
        <span><b>{s.longWaitPct.toFixed(1)}%</b> waited over 60 s</span>
        {s.transfers > 0 && <span><b>{fmtInt(s.transfers)}</b> lobby changes</span>}
      </div>

      <Section title="Elevators">
        <ElevatorBoard />
      </Section>

      <Section title="Inspect & edit">
        <Inspector />
      </Section>

      <Section title="Average wait over time">
        <LineChart data={series.map((p) => ({ t: p.t, v: p.avgWait }))} format={(v) => `${v.toFixed(1)} s`} />
      </Section>
      <Section title="People waiting" open={false}>
        <LineChart data={series.map((p) => ({ t: p.t, v: p.waiting }))} format={(v) => `${v.toFixed(0)} people`} color="var(--series-2)" />
      </Section>
      <Section title="Electricity per 5 minutes" open={false}>
        <LineChart data={series.map((p) => ({ t: p.t, v: p.kWh * 1000 }))} format={(v) => `${v.toFixed(0)} Wh`} color="var(--series-3)" />
      </Section>
    </div>
  );
}
