import type { ElevatorAlgorithm } from '../algorithms/api';
import { BUILTIN, listAlgorithms, resolveAlgorithm } from '../algorithms/registry';
import { SceneManager } from '../render/scene';
import { DT, Simulation } from '../sim/engine';
import { effectiveConfig, useStore, type SandboxResult } from './store';

// Owns the live simulation and the 3D scene. React only reads from here.

export const runtime: { sim: Simulation; scene: SceneManager | null; algo: ElevatorAlgorithm } = {
  sim: null as unknown as Simulation,
  scene: null,
  algo: BUILTIN[0],
};

// Handy in the browser console while developing: __lab.runtime.sim, __lab.useStore.getState()
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__lab = { runtime, useStore };

let loadError: string | null = null;
let raf = 0;
let last = 0;
let acc = 0;
let lastLive = 0;
let tick = 0;
let rebuildTimer = 0;
let structure = '';

function pickAlgorithm(): ElevatorAlgorithm {
  const s = useStore.getState();
  loadError = null;
  try {
    const src = s.editorAlgos.find((e) => e.id === s.algoId)?.source;
    return resolveAlgorithm(s.algoId, src);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    return BUILTIN[0];
  }
}

export function rebuild() {
  const s = useStore.getState();
  const cfg = effectiveConfig(s);
  runtime.algo = pickAlgorithm();
  runtime.sim = new Simulation(cfg, runtime.algo, s.algoParams[s.algoId] ?? {});
  acc = 0;
  const shape = JSON.stringify(cfg.buildings.map((b) => [b.floors, b.flatsPerFloor, b.floorHeight, b.elevators.length]));
  runtime.scene?.build(runtime.sim, shape === structure);
  structure = shape;
  if (s.tab === 'sandbox') useStore.setState({ playing: false, selection: null });
  else useStore.setState({ selection: null });
  pushLive();
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(rebuild, 220);
}

function pushLive() {
  const sim = runtime.sim;
  const pending = sim.pendingCount();
  const s = useStore.getState();
  const done =
    s.tab === 'sandbox' && pending === 0 && sim.time > 0 &&
    sim.buildings.every((b) => b.cars.every((c) => c.state === 'idle'));
  useStore.setState({
    live: {
      tick: ++tick,
      clock: sim.clock,
      time: sim.time,
      summary: sim.summary(),
      series: sim.series,
      pending,
      done,
      error: loadError,
    },
    ...(done && s.playing ? { playing: false } : {}),
  });
}

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const s = useStore.getState();
  if (s.playing) {
    acc += dt * s.speed;
    const deadline = performance.now() + 11;
    let steps = Math.floor(acc / DT);
    acc -= steps * DT;
    while (steps-- > 0) {
      runtime.sim.step();
      if ((steps & 63) === 0 && performance.now() > deadline) break; // can't keep up: run as fast as possible
    }
  }
  if (runtime.scene) {
    runtime.scene.showLabels = s.showLabels;
    runtime.scene.update(runtime.sim);
  }
  if (now - lastLive > 200) {
    lastLive = now;
    pushLive();
  }
}

export function startRuntime(container: HTMLElement) {
  const scene = new SceneManager(container);
  runtime.scene = scene;
  scene.onSelect = (selection) => useStore.setState({ selection });
  structure = '';
  rebuild();
  last = performance.now();
  raf = requestAnimationFrame(frame);

  const unsub = useStore.subscribe((s, prev) => {
    const sandbox = s.tab === 'sandbox';
    const wasSandbox = prev.tab === 'sandbox';
    if (s.algoParams !== prev.algoParams && s.algoId === prev.algoId) {
      // sliders apply live, without restarting the run
      const next = s.algoParams[s.algoId] ?? {};
      for (const k of Object.keys(runtime.sim.params)) if (next[k] !== undefined) runtime.sim.params[k] = next[k];
    }
    const editorChanged =
      s.editorAlgos !== prev.editorAlgos &&
      s.editorAlgos.find((e) => e.id === s.algoId)?.source !== prev.editorAlgos.find((e) => e.id === s.algoId)?.source;
    if (
      s.config !== prev.config || s.algoId !== prev.algoId || s.revision !== prev.revision ||
      sandbox !== wasSandbox || (sandbox && s.scenario !== prev.scenario) || editorChanged
    ) {
      if (s.revision !== prev.revision || sandbox !== wasSandbox) {
        clearTimeout(rebuildTimer);
        rebuild();
      } else scheduleRebuild();
    }
    if (s.selection !== prev.selection && runtime.scene && runtime.scene.selection !== s.selection) {
      runtime.scene.setSelection(s.selection, false);
    }
  });

  return () => {
    unsub();
    cancelAnimationFrame(raf);
    clearTimeout(rebuildTimer);
    scene.dispose();
    runtime.scene = null;
  };
}

/** Run the current sandbox situation under every algorithm, headless, and tabulate the results. */
export function compareSandbox(): SandboxResult[] {
  const s = useStore.getState();
  const cfg = effectiveConfig({ ...s, tab: 'sandbox' });
  const out: SandboxResult[] = [];
  for (const entry of listAlgorithms(s.editorAlgos)) {
    if (!entry.algo) continue;
    const sim = new Simulation(cfg, entry.algo, s.algoParams[entry.id] ?? {});
    const total = sim.pendingCount();
    for (let i = 0; i < 72000 && sim.pendingCount() > 0; i++) sim.step();
    const sum = sim.summary();
    const standby = (cfg.energy.standbyW * sim.buildings[0].cars.length * sim.time) / 3600;
    out.push({
      algorithm: entry.name,
      clearTime: sim.lastDeliveryTime,
      avgWait: sum.avgWait,
      maxWait: sum.maxWait,
      avgJourney: sum.avgJourney,
      energyWh: sum.energyKWh * 1000 - standby, // movement and doors only, so run length doesn't skew it
      stops: sum.doorCycles,
      delivered: sum.delivered,
      total,
    });
  }
  return out.sort((a, b) => a.avgJourney - b.avgJourney);
}
