import { create } from 'zustand';
import type { EditorAlgorithm } from '../algorithms/compile';
import type { Selection } from '../render/scene';
import type { SeriesPoint, Summary } from '../sim/metrics';
import { defaultConfig, hostel18Config, type ScenarioConfig, type SimConfig } from '../sim/types';

export type Tab = 'simulate' | 'hostel' | 'sandbox' | 'compare' | 'editor';
/** The tabs that show the 3D view; the simulation keeps running the last one visited. */
export type LiveTab = 'simulate' | 'hostel' | 'sandbox';
export const isLive = (t: Tab): t is LiveTab => t === 'simulate' || t === 'hostel' || t === 'sandbox';

export interface Live {
  tick: number;
  clock: number;
  time: number;
  summary: Summary;
  series: SeriesPoint[];
  pending: number;
  done: boolean; // sandbox: everyone has been delivered
  error: string | null; // the selected algorithm could not be loaded
}

export interface CompareRow {
  key: string;
  algorithm: string;
  variant: string;
  progress: number;
  summary: Summary | null;
  error?: string;
}

export interface SandboxResult {
  algorithm: string;
  clearTime: number;
  avgWait: number;
  maxWait: number;
  avgJourney: number;
  energyWh: number;
  stops: number;
  delivered: number;
  total: number;
}

export const SCENARIO_PRESETS: { name: string; note: string; scenario: ScenarioConfig }[] = [
  {
    name: 'Your example: down call on 5, car heading up',
    note: 'One car leaving floor 2 with riders for 10, 25 and the top floor. Someone on 5 presses down. With a single car every sensible algorithm agrees: finish the trip up, then collect the person on the way back. Stopping at 5 on the way up would only carry them to the top first. Add a second car (next example) and the algorithms start to differ.',
    scenario: { cars: [{ floor: 2, riders: [10, 25, 30] }], waiting: [{ floor: 5, dest: 0, count: 1 }] },
  },
  {
    name: 'Same, with a second car idle at the top',
    note: 'Does the controller send the idle car down from the top for the person on 5, or make them wait for the busy one?',
    scenario: { cars: [{ floor: 2, riders: [10, 25, 30] }, { floor: 30, riders: [] }], waiting: [{ floor: 5, dest: 0, count: 1 }] },
  },
  {
    name: 'Morning rush: everyone leaving',
    note: 'Twenty-four people on scattered upper floors all want the lobby. Three cars start at the lobby.',
    scenario: {
      cars: [{ floor: 0, riders: [] }, { floor: 0, riders: [] }, { floor: 0, riders: [] }],
      waiting: [28, 27, 24, 22, 19, 17, 14, 11, 9, 6, 4, 3].map((floor) => ({ floor, dest: 0, count: 2 })),
    },
  },
  {
    name: 'Evening rush: lobby crowd',
    note: 'Thirty people arrive at the lobby for different floors with only two cars.',
    scenario: {
      cars: [{ floor: 12, riders: [] }, { floor: 25, riders: [] }],
      waiting: [3, 5, 8, 8, 11, 13, 16, 16, 19, 21, 22, 24, 26, 28, 30].map((dest) => ({ floor: 0, dest, count: 2 })),
    },
  },
  {
    name: 'Mixed traffic, three cars',
    note: 'Up, down and floor-to-floor trips at once.',
    scenario: {
      cars: [{ floor: 0, riders: [14, 20] }, { floor: 16, riders: [0] }, { floor: 29, riders: [] }],
      waiting: [
        { floor: 0, dest: 18, count: 3 }, { floor: 7, dest: 0, count: 2 }, { floor: 12, dest: 23, count: 1 },
        { floor: 21, dest: 4, count: 2 }, { floor: 26, dest: 0, count: 3 }, { floor: 9, dest: 10, count: 1 },
      ],
    },
  },
];

interface State {
  config: SimConfig;
  algoId: string;
  algoParams: Record<string, Record<string, number>>;
  editorAlgos: EditorAlgorithm[];
  scenario: ScenarioConfig;
  hostel: SimConfig; // Hostel 18 has its own settings, separate from the tower
  hostelSpread: number; // how far apart its floors are drawn
  hostelRank: CompareRow[];
  hostelRankRunning: boolean;
  tab: Tab;
  liveTab: LiveTab;
  playing: boolean;
  speed: number;
  showLabels: boolean;
  buildingTab: number;
  selection: Selection;
  revision: number;
  live: Live | null;
  compareRows: CompareRow[];
  compareRunning: boolean;
  sandboxResults: SandboxResult[] | null;
  set: (patch: Partial<State>) => void;
  update: (fn: (cfg: SimConfig) => void) => void;
  updateHostel: (fn: (cfg: SimConfig) => void) => void;
  setTab: (tab: Tab) => void;
  updateScenario: (fn: (sc: ScenarioConfig) => void) => void;
  restart: () => void;
}

const KEY = 'elevator-lab:v1';

function load(): Partial<State> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    const base = defaultConfig();
    // Merge section by section so settings added in later versions get their defaults.
    const config: SimConfig = {
      ...base,
      ...saved.config,
      traffic: { ...base.traffic, ...saved.config?.traffic },
      energy: { ...base.energy, ...saved.config?.energy },
      scenario: null,
    };
    if (!Array.isArray(config.buildings) || !config.buildings.length) config.buildings = base.buildings;
    const hbase = hostel18Config();
    const hostel: SimConfig = {
      ...hbase,
      ...saved.hostel,
      traffic: { ...hbase.traffic, ...saved.hostel?.traffic },
      energy: { ...hbase.energy, ...saved.hostel?.energy },
      scenario: null,
    };
    if (!Array.isArray(hostel.buildings) || hostel.buildings.length !== 1) hostel.buildings = hbase.buildings;
    return {
      config,
      hostel,
      hostelSpread: saved.hostelSpread,
      algoId: saved.algoId,
      algoParams: saved.algoParams ?? {},
      editorAlgos: saved.editorAlgos ?? [],
      scenario: saved.scenario,
      speed: saved.speed,
      showLabels: saved.showLabels,
    };
  } catch {
    return {};
  }
}

const saved = load();

export const useStore = create<State>((set) => ({
  config: saved.config ?? defaultConfig(),
  algoId: saved.algoId ?? 'eta',
  algoParams: saved.algoParams ?? {},
  editorAlgos: saved.editorAlgos ?? [],
  scenario: saved.scenario ?? structuredClone(SCENARIO_PRESETS[0].scenario),
  hostel: saved.hostel ?? hostel18Config(),
  hostelSpread: saved.hostelSpread ?? 1.7,
  hostelRank: [],
  hostelRankRunning: false,
  tab: 'simulate',
  liveTab: 'simulate',
  playing: true,
  speed: saved.speed ?? 20,
  showLabels: saved.showLabels ?? true,
  buildingTab: 0,
  selection: null,
  revision: 0,
  live: null,
  compareRows: [],
  compareRunning: false,
  sandboxResults: null,
  set: (patch) => set(patch),
  update: (fn) =>
    set((s) => {
      const config = structuredClone(s.config);
      fn(config);
      return { config };
    }),
  updateHostel: (fn) =>
    set((s) => {
      const hostel = structuredClone(s.hostel);
      fn(hostel);
      return { hostel };
    }),
  setTab: (tab) => set((s) => ({ tab, liveTab: isLive(tab) ? tab : s.liveTab })),
  updateScenario: (fn) =>
    set((s) => {
      const scenario = structuredClone(s.scenario);
      fn(scenario);
      return { scenario, sandboxResults: null };
    }),
  restart: () => set((s) => ({ revision: s.revision + 1 })),
}));

let saveTimer = 0;
useStore.subscribe((s, prev) => {
  if (
    s.config === prev.config && s.algoId === prev.algoId && s.algoParams === prev.algoParams &&
    s.editorAlgos === prev.editorAlgos && s.scenario === prev.scenario && s.speed === prev.speed &&
    s.showLabels === prev.showLabels && s.hostel === prev.hostel && s.hostelSpread === prev.hostelSpread
  ) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        config: s.config, algoId: s.algoId, algoParams: s.algoParams, editorAlgos: s.editorAlgos,
        scenario: s.scenario, speed: s.speed, showLabels: s.showLabels, hostel: s.hostel, hostelSpread: s.hostelSpread,
      }));
    } catch {
      // storage unavailable: settings simply are not remembered
    }
  }, 400);
});

/** The configuration the live simulation actually runs, depending on the open tab. */
export function effectiveConfig(s: { config: SimConfig; hostel: SimConfig; scenario: ScenarioConfig; liveTab: LiveTab }): SimConfig {
  if (s.liveTab === 'hostel') return { ...s.hostel, scenario: null };
  if (s.liveTab !== 'sandbox') return { ...s.config, scenario: null };
  const base = s.config.buildings[0];
  const elevators = s.scenario.cars.map((_, i) => base.elevators[i] ?? base.elevators[base.elevators.length - 1]);
  return {
    ...s.config,
    startHour: 12,
    buildings: [{ ...base, elevators }],
    traffic: { ...s.config.traffic, enabled: false },
    scenario: s.scenario,
  };
}
