import { useState } from 'react';
import { CAR_COLORS, carName } from '../sim/types';
import { AlgorithmPicker } from './ConfigPanel';
import { fmtSec, NumInput, Section } from './components';
import { compareSandbox } from './runtime';
import { SCENARIO_PRESETS, useStore } from './store';

function RidersInput(props: { riders: number[]; top: number; onChange: (r: number[]) => void }) {
  const [text, setText] = useState(props.riders.join(', '));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : props.riders.join(', ');
  return (
    <input
      type="text"
      placeholder="e.g. 10, 25, 30"
      value={shown}
      onFocus={() => { setText(props.riders.join(', ')); setFocused(true); }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        const floors = e.target.value
          .split(/[,\s]+/)
          .filter((x) => x !== '')
          .map((x) => (x.toLowerCase() === 'g' ? 0 : Number(x)))
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= props.top);
        props.onChange(floors);
      }}
    />
  );
}

export function SandboxPanel() {
  const scenario = useStore((s) => s.scenario);
  const top = useStore((s) => s.config.buildings[0].floors);
  const maxCars = 8;
  const updateScenario = useStore((s) => s.updateScenario);
  const set = useStore((s) => s.set);
  const restart = useStore((s) => s.restart);
  const results = useStore((s) => s.sandboxResults);
  const [preset, setPreset] = useState(-1);

  return (
    <div className="panel-scroll">
      <p className="note lead">
        Build an exact situation and watch how an algorithm handles it. Floors run from G (0) to {top}; the building itself comes from the Simulate tab.
      </p>

      <Section title="Start from an example">
        <select
          value={preset}
          onChange={(e) => {
            const i = Number(e.target.value);
            setPreset(i);
            if (i >= 0) set({ scenario: structuredClone(SCENARIO_PRESETS[i].scenario), sandboxResults: null });
          }}
        >
          <option value={-1}>Choose…</option>
          {SCENARIO_PRESETS.map((p, i) => <option key={i} value={i}>{p.name}</option>)}
        </select>
        {preset >= 0 && <p className="note">{SCENARIO_PRESETS[preset].note}</p>}
      </Section>

      <Section
        title={`Elevators (${scenario.cars.length})`}
        right={
          <div className="stepper">
            <button disabled={scenario.cars.length <= 1} onClick={() => updateScenario((sc) => { sc.cars.pop(); })}>−</button>
            <button disabled={scenario.cars.length >= maxCars} onClick={() => updateScenario((sc) => { sc.cars.push({ floor: 0, riders: [] }); })}>+</button>
          </div>
        }
      >
        {scenario.cars.map((c, i) => (
          <div className="card" key={i}>
            <div className="card-head">
              <i className="dot" style={{ background: CAR_COLORS[i % CAR_COLORS.length] }} />
              <b>Car {carName(i)}</b>
              <span className="spacer" />
              <span className="muted">starts at floor</span>
              <NumInput value={c.floor} min={0} max={top} integer onChange={(v) => updateScenario((sc) => { sc.cars[i].floor = v; })} />
            </div>
            <label className="field">
              <span>Riders already inside want floors</span>
              <RidersInput riders={c.riders} top={top} onChange={(r) => updateScenario((sc) => { sc.cars[i].riders = r; })} />
            </label>
          </div>
        ))}
      </Section>

      <Section title="People waiting on floors">
        {scenario.waiting.length === 0 && <p className="note">Nobody yet.</p>}
        {scenario.waiting.map((w, i) => (
          <div className="wait-row" key={i}>
            <NumInput value={w.count} min={1} max={60} integer onChange={(v) => updateScenario((sc) => { sc.waiting[i].count = v; })} />
            <span>on</span>
            <NumInput value={w.floor} min={0} max={top} integer onChange={(v) => updateScenario((sc) => { sc.waiting[i].floor = v; })} />
            <span>going to</span>
            <NumInput value={w.dest} min={0} max={top} integer onChange={(v) => updateScenario((sc) => { sc.waiting[i].dest = v; })} />
            <span className={`dir ${w.dest > w.floor ? 'up' : 'down'}`}>{w.dest === w.floor ? '–' : w.dest > w.floor ? '▲' : '▼'}</span>
            <button className="ghost" title="Remove" onClick={() => updateScenario((sc) => { sc.waiting.splice(i, 1); })}>✕</button>
          </div>
        ))}
        <div className="chips">
          <button onClick={() => updateScenario((sc) => { sc.waiting.push({ floor: Math.min(top, 5), dest: 0, count: 1 }); })}>+ Add people</button>
          <button onClick={() => updateScenario((sc) => { sc.waiting = []; })} disabled={!scenario.waiting.length}>Clear</button>
        </div>
        <p className="note">Rows where the floor and destination match are skipped. While it runs you can still click anyone in the 3D view and change their destination.</p>
      </Section>

      <Section title="Algorithm">
        <AlgorithmPicker />
        <div className="chips">
          <button className="primary" onClick={() => { restart(); setTimeout(() => set({ playing: true }), 30); }}>▶ Run from the start</button>
        </div>
      </Section>

      <Section title="Compare every algorithm on this situation">
        <div className="chips">
          <button onClick={() => set({ sandboxResults: compareSandbox() })}>Run all</button>
        </div>
        {results && (
          <table className="mini-table">
            <thead>
              <tr><th>Algorithm</th><th title="Average wait">Wait</th><th title="Average door-to-door time">Journey</th><th title="Time until the last person arrives">All done</th><th title="Energy for movement and doors">Wh</th><th>Stops</th></tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.algorithm} className={r.delivered < r.total ? 'bad' : ''}>
                  <td>{r.algorithm}</td>
                  <td>{r.avgWait.toFixed(1)}</td>
                  <td>{r.avgJourney.toFixed(1)}</td>
                  <td>{r.delivered < r.total ? `${r.total - r.delivered} left` : fmtSec(r.clearTime)}</td>
                  <td>{r.energyWh.toFixed(0)}</td>
                  <td>{r.stops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {results && <p className="note">Seconds unless noted, sorted by door-to-door time. Riders who start inside a car count with zero wait.</p>}
      </Section>
    </div>
  );
}
