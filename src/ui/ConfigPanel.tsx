import { useMemo, useRef } from 'react';
import { listAlgorithms } from '../algorithms/registry';
import { demandCurve } from '../sim/traffic';
import {
  CAR_COLORS, carName, defaultBuilding, defaultConfig, defaultElevator, servedFloors,
  type BuildingConfig, type CallMode, type ElevatorConfig, type ServedMode, type SimConfig,
} from '../sim/types';
import { fmtHour, fmtInt, MinMax, Num, NumInput, Section, Seg, Select, Slider, Toggle } from './components';
import { useStore } from './store';

const SERVED: { value: ServedMode; label: string }[] = [
  { value: 'all', label: 'All floors' },
  { value: 'even', label: 'Even floors + lobby' },
  { value: 'odd', label: 'Odd floors + lobby' },
  { value: 'low', label: 'Lower half + lobby' },
  { value: 'high', label: 'Upper half + lobby (express)' },
  { value: 'custom', label: 'Custom list…' },
];

/** Split an elevator bank into zones. Odd counts give the spare car to the first zone. */
export function applyZoning(elevators: ElevatorConfig[], zoning: 'all' | 'evenodd' | 'lowhigh' | 'mixed'): ElevatorConfig[] {
  const n = elevators.length;
  const lobbies = elevators.some((e) => e.bank !== undefined);
  return elevators.map((e, i) => {
    // With several lift lobbies the zones alternate around the building, so both are near every corner.
    const bank = e.bank ?? 0;
    const first = lobbies ? ((bank >> 1) + (bank & 1)) % 2 === 0 : i < Math.ceil(n / 2);
    let served: ServedMode = 'all';
    if (zoning === 'evenodd') served = first ? 'even' : 'odd';
    else if (zoning === 'lowhigh') served = first ? 'low' : 'high';
    else if (zoning === 'mixed') served = i === 0 ? 'even' : i === 1 ? 'odd' : 'all';
    return { ...e, served };
  });
}

function uncovered(b: BuildingConfig): number[] {
  const any = new Array<boolean>(b.floors + 1).fill(false);
  for (const e of b.elevators) servedFloors(e, b.floors).forEach((s, f) => (any[f] ||= s));
  return any.flatMap((s, f) => (s ? [] : [f]));
}

/** Algorithm dropdown with its description and sliders. callMode belongs to whichever building is on screen. */
export function AlgorithmPicker(props: { callMode: CallMode; onMode: (m: CallMode) => void }) {
  const algoId = useStore((s) => s.algoId);
  const editorAlgos = useStore((s) => s.editorAlgos);
  const algoParams = useStore((s) => s.algoParams);
  const { callMode } = props;
  const set = useStore((s) => s.set);
  const entries = useMemo(() => listAlgorithms(editorAlgos), [editorAlgos]);
  const current = entries.find((e) => e.id === algoId) ?? entries[0];
  const algo = current.algo;
  const groupName = { builtin: 'Built-in', file: 'Your files (src/algorithms/custom)', editor: 'Written in the editor' };

  return (
    <>
      <Select
        value={current.id}
        onChange={(id) => set({ algoId: id })}
        options={entries.map((e) => ({ value: e.id, label: e.algo ? e.name : `${e.name} (error)`, group: groupName[e.kind] }))}
      />
      {algo?.description && <p className="note">{algo.description}</p>}
      {current.error && <p className="warn">This algorithm has an error: {current.error}</p>}
      {algo?.prefersMode && algo.prefersMode !== callMode && (
        <p className="warn">
          Designed for {algo.prefersMode === 'destination' ? 'destination keypads' : 'up/down buttons'}.{' '}
          <button className="link" onClick={() => props.onMode(algo.prefersMode!)}>Switch</button>
        </p>
      )}
      {Object.entries(algo?.params ?? {}).map(([key, spec]) => (
        <Slider
          key={key}
          label={spec.label}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          value={algoParams[current.id]?.[key] ?? spec.value}
          format={(v) => `${v}${spec.unit ? ` ${spec.unit}` : ''}`}
          onChange={(v) => set({ algoParams: { ...algoParams, [current.id]: { ...algoParams[current.id], [key]: v } } })}
        />
      ))}
    </>
  );
}

export function ElevatorCard(props: { e: ElevatorConfig; index: number; floors: number; title?: string; onChange: (fn: (e: ElevatorConfig) => void) => void; onRemove?: () => void; onCopyToAll: () => void }) {
  const { e, index, onChange } = props;
  const served = servedFloors(e, props.floors).filter(Boolean).length;
  return (
    <div className="card">
      <div className="card-head">
        <i className="dot" style={{ background: CAR_COLORS[index % CAR_COLORS.length] }} />
        <b>{props.title ?? `Car ${carName(index)}`}</b>
        <span className="muted">stops at {served} of {props.floors + 1} levels</span>
        <span className="spacer" />
        <button className="ghost" title="Copy this car's settings to every car" onClick={props.onCopyToAll}>⧉</button>
        {props.onRemove && <button className="ghost" title="Remove this car" onClick={props.onRemove}>✕</button>}
      </div>
      <div className="grid2">
        <Num label="Capacity" unit="people" value={e.capacity} min={1} max={60} integer onChange={(v) => onChange((x) => { x.capacity = v; })} />
        <Num label="Top speed" unit="m/s" value={e.maxSpeed} min={0.3} max={12} step={0.1} onChange={(v) => onChange((x) => { x.maxSpeed = v; })} />
        <Num label="Acceleration" unit="m/s²" value={e.acceleration} min={0.2} max={3} step={0.1} hint="Above about 1.2 m/s² starts to feel uncomfortable" onChange={(v) => onChange((x) => { x.acceleration = v; })} />
        <Num label="Door open/close" unit="s" value={e.doorTime} min={0.5} max={10} step={0.1} onChange={(v) => onChange((x) => { x.doorTime = v; })} />
        <Num label="Step in/out" unit="s each" value={e.boardTime} min={0.2} max={5} step={0.1} onChange={(v) => onChange((x) => { x.boardTime = v; })} />
        <Num label="Parks at floor" value={e.parkFloor} min={-1} max={props.floors} integer hint="Where the car waits when idle. −1 = stay where it last stopped." onChange={(v) => onChange((x) => { x.parkFloor = v; })} />
      </div>
      <Select label="Serves" value={e.served} options={SERVED} onChange={(v) => onChange((x) => { x.served = v; })} />
      {e.served === 'custom' && (
        <label className="field">
          <span>Floors</span>
          <input type="text" placeholder="e.g. 1-10, 15, 20-30" value={e.customFloors} onChange={(ev) => onChange((x) => { x.customFloors = ev.target.value; })} />
        </label>
      )}
    </div>
  );
}

export function BuildingEditor(props: { index: number }) {
  const b = useStore((s) => s.config.buildings[props.index]);
  const update = useStore((s) => s.update);
  if (!b) return null;
  const edit = (fn: (b: BuildingConfig) => void) => update((c) => fn(c.buildings[props.index]));
  const missing = uncovered(b);
  const setCount = (n: number) =>
    edit((x) => {
      while (x.elevators.length < n) x.elevators.push({ ...(x.elevators[x.elevators.length - 1] ?? defaultElevator()) });
      x.elevators.length = Math.max(1, n);
    });

  return (
    <>
      <Section title="Building">
        <label className="field">
          <span>Name</span>
          <input type="text" value={b.name} onChange={(e) => edit((x) => { x.name = e.target.value; })} />
        </label>
        <div className="grid2">
          <Num label="Floors" value={b.floors} min={2} max={120} integer hint="Residential floors above the ground-floor lobby" onChange={(v) => edit((x) => { x.floors = v; })} />
          <Num label="Flats per floor" value={b.flatsPerFloor} min={1} max={24} integer onChange={(v) => edit((x) => { x.flatsPerFloor = v; })} />
        </div>
        <MinMax label="Residents per flat" min={b.residentsMin} max={b.residentsMax} limit={20} onChange={(lo, hi) => edit((x) => { x.residentsMin = lo; x.residentsMax = hi; })} />
        <MinMax label="Visitors per flat per day" min={b.visitorsMin} max={b.visitorsMax} limit={30} hint="Guests, deliveries and other extra people" onChange={(lo, hi) => edit((x) => { x.visitorsMin = lo; x.visitorsMax = hi; })} />
        <Num label="Floor height" unit="m" value={b.floorHeight} min={2.4} max={6} step={0.1} onChange={(v) => edit((x) => { x.floorHeight = v; })} />
      </Section>

      <Section
        title={`Elevators (${b.elevators.length})`}
        right={
          <div className="stepper">
            <button onClick={() => setCount(b.elevators.length - 1)} disabled={b.elevators.length <= 1}>−</button>
            <button onClick={() => setCount(b.elevators.length + 1)} disabled={b.elevators.length >= 12}>+</button>
          </div>
        }
      >
        <div className="field">
          <span>Quick zoning</span>
          <div className="chips">
            <button onClick={() => edit((x) => { x.elevators = applyZoning(x.elevators, 'all'); })}>All floors</button>
            <button onClick={() => edit((x) => { x.elevators = applyZoning(x.elevators, 'evenodd'); })}>Even / odd</button>
            <button onClick={() => edit((x) => { x.elevators = applyZoning(x.elevators, 'lowhigh'); })}>Low / high</button>
          </div>
        </div>
        {missing.length > 0 && (
          <p className="warn">
            No car stops at floor{missing.length > 1 ? 's' : ''} {missing.slice(0, 12).join(', ')}{missing.length > 12 ? '…' : ''}. People there cannot travel.
          </p>
        )}
        {b.elevators.map((e, i) => (
          <ElevatorCard
            key={i}
            e={e}
            index={i}
            floors={b.floors}
            onChange={(fn) => edit((x) => fn(x.elevators[i]))}
            onRemove={b.elevators.length > 1 ? () => edit((x) => { x.elevators.splice(i, 1); }) : undefined}
            onCopyToAll={() => edit((x) => { x.elevators = x.elevators.map((o) => ({ ...e, served: o.served, customFloors: o.customFloors })); })}
          />
        ))}
      </Section>
    </>
  );
}

export function ConfigPanel() {
  const config = useStore((s) => s.config);
  const buildingTab = useStore((s) => s.buildingTab);
  const set = useStore((s) => s.set);
  const update = useStore((s) => s.update);
  const fileRef = useRef<HTMLInputElement>(null);
  const bi = Math.min(buildingTab, config.buildings.length - 1);
  const curve = useMemo(() => demandCurve(config), [config]);
  const cars = config.buildings.reduce((a, b) => a + b.elevators.length, 0);
  const t = config.traffic;
  const en = config.energy;

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ ...config, scenario: null }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'elevator-lab-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as SimConfig;
      if (!Array.isArray(parsed.buildings) || !parsed.buildings.length) throw new Error('no buildings');
      const base = defaultConfig();
      set({ config: { ...base, ...parsed, traffic: { ...base.traffic, ...parsed.traffic }, energy: { ...base.energy, ...parsed.energy }, scenario: null }, buildingTab: 0 });
    } catch {
      alert('That file is not a valid Elevator Lab configuration.');
    }
  };

  return (
    <div className="panel-scroll">
      <div className="summary-strip">
        <div><b>{fmtInt(curve.residents)}</b><span>residents</span></div>
        <div><b>{fmtInt(curve.total)}</b><span>trips / day</span></div>
        <div><b>{cars}</b><span>elevator{cars === 1 ? '' : 's'}</span></div>
      </div>

      <Section title="Algorithm">
        <AlgorithmPicker callMode={config.callMode} onMode={(m) => update((c) => { c.callMode = m; })} />
      </Section>

      <div className="tabs-row">
        {config.buildings.map((b, i) => (
          <button key={i} className={i === bi ? 'on' : ''} onClick={() => set({ buildingTab: i })}>{b.name || `Building ${i + 1}`}</button>
        ))}
        <button
          title="Add a building (copies the current one)"
          disabled={config.buildings.length >= 6}
          onClick={() => {
            const n = config.buildings.length;
            update((c) => {
              const copy = structuredClone(c.buildings[bi] ?? defaultBuilding());
              copy.name = `Tower ${String.fromCharCode(65 + n)}`;
              c.buildings.push(copy);
            });
            set({ buildingTab: n });
          }}
        >＋</button>
        {config.buildings.length > 1 && (
          <button
            title="Remove this building"
            onClick={() => {
              update((c) => { c.buildings.splice(bi, 1); });
              set({ buildingTab: Math.max(0, bi - 1) });
            }}
          >✕</button>
        )}
      </div>
      <BuildingEditor index={bi} />

      <Section title="Controls" open={false}>
        <div className="field">
          <span>How people call a car</span>
          <Seg
            value={config.callMode}
            onChange={(v) => update((c) => { c.callMode = v; })}
            options={[
              { value: 'hall', label: 'Up / down buttons', title: 'The controller only learns the destination once the person is inside' },
              { value: 'destination', label: 'Destination keypad', title: 'People enter their floor before boarding, so the controller can plan ahead' },
            ]}
          />
        </div>
        <div className="grid2">
          <Num label="Doors stay open" unit="s" value={config.doorDwell} min={0.5} max={15} step={0.5} hint="After the last person steps through" onChange={(v) => update((c) => { c.doorDwell = v; })} />
          <Num label="Walking speed" unit="m/s" value={config.walkSpeed} min={0.5} max={3} step={0.1} onChange={(v) => update((c) => { c.walkSpeed = v; })} />
        </div>
        <Slider label="Start the day at" min={0} max={23.5} step={0.5} value={config.startHour} format={fmtHour} onChange={(v) => update((c) => { c.startHour = v; })} />
        <Num label="Random seed" value={config.seed} min={0} max={999999} integer hint="Same seed = exactly the same people and trips" onChange={(v) => update((c) => { c.seed = v; })} />
      </Section>

      <Section title="Traffic" open={false}>
        <Slider label="Overall demand" min={0.2} max={4} step={0.1} value={t.demandMultiplier} format={(v) => `${v.toFixed(1)}×`} hint="Scales every kind of trip" onChange={(v) => update((c) => { c.traffic.demandMultiplier = v; })} />
        <Slider label="Residents who commute" min={0} max={1} step={0.05} value={t.workShare} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((c) => { c.traffic.workShare = v; })} />
        <Slider label="Typical time they leave" min={5} max={11} step={0.25} value={t.workDepartHour} format={fmtHour} onChange={(v) => update((c) => { c.traffic.workDepartHour = v; })} />
        <Slider label="Spread of leaving times" min={0.2} max={3} step={0.1} value={t.workDepartSpread} format={(v) => `±${v.toFixed(1)} h`} hint="Smaller = sharper rush hour" onChange={(v) => update((c) => { c.traffic.workDepartSpread = v; })} />
        <Slider label="Hours away" min={3} max={13} step={0.5} value={t.workDurationHours} format={(v) => `${v} h`} onChange={(v) => update((c) => { c.traffic.workDurationHours = v; })} />
        <Slider label="Other outings per person" min={0} max={4} step={0.1} value={t.errandsPerDay} format={(v) => `${v.toFixed(1)} / day`} onChange={(v) => update((c) => { c.traffic.errandsPerDay = v; })} />
        <Slider label="Visits to other floors" min={0} max={2} step={0.05} value={t.interfloorPerDay} format={(v) => `${v.toFixed(2)} / day`} hint="These trips are what zoning (even/odd) makes awkward" onChange={(v) => update((c) => { c.traffic.interfloorPerDay = v; })} />
        <Slider label="Visitors that are quick deliveries" min={0} max={1} step={0.05} value={t.deliveryShare} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((c) => { c.traffic.deliveryShare = v; })} />
      </Section>

      <Section title="Energy model" open={false}>
        <div className="grid2">
          <Num label="Empty car" unit="kg" value={en.carMassKg} min={300} max={6000} step={50} onChange={(v) => update((c) => { c.energy.carMassKg = v; })} />
          <Num label="Person" unit="kg" value={en.personMassKg} min={30} max={150} onChange={(v) => update((c) => { c.energy.personMassKg = v; })} />
          <Num label="Standby per car" unit="W" value={en.standbyW} min={0} max={2000} step={10} hint="Lights, controller and drive electronics, always on" onChange={(v) => update((c) => { c.energy.standbyW = v; })} />
          <Num label="Door cycle" unit="Wh" value={en.doorCycleWh} min={0} max={10} step={0.1} onChange={(v) => update((c) => { c.energy.doorCycleWh = v; })} />
        </div>
        <Slider label="Counterweight balance" min={0} max={0.6} step={0.05} value={en.counterweightRatio} format={(v) => `${Math.round(v * 100)}% of full load`} hint="Counterweight = empty car + this share of a full load" onChange={(v) => update((c) => { c.energy.counterweightRatio = v; })} />
        <Slider label="Motor efficiency" min={0.4} max={0.98} step={0.01} value={en.motorEfficiency} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((c) => { c.energy.motorEfficiency = v; })} />
        <Toggle label="Regenerative drive" value={en.regen} hint="Feeds braking energy back instead of burning it off as heat" onChange={(v) => update((c) => { c.energy.regen = v; })} />
        {en.regen && <Slider label="Energy recovered" min={0.1} max={0.9} step={0.05} value={en.regenEfficiency} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((c) => { c.energy.regenEfficiency = v; })} />}
      </Section>

      <Section title="Save & load" open={false}>
        <div className="chips">
          <button onClick={exportJson}>Export settings</button>
          <button onClick={() => fileRef.current?.click()}>Import settings</button>
          <button onClick={() => { if (confirm('Reset every setting to its default?')) set({ config: defaultConfig(), buildingTab: 0 }); }}>Reset to defaults</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
        <p className="note">Settings are remembered in this browser. Changing a setting restarts the run.</p>
      </Section>
    </div>
  );
}

export { NumInput };
