// Everything the user can edit lives in SimConfig. The engine is rebuilt from it.

export type Dir = 1 | -1 | 0;
export type ServedMode = 'all' | 'even' | 'odd' | 'low' | 'high' | 'custom';
export type CallMode = 'hall' | 'destination';

export interface ElevatorConfig {
  capacity: number; // persons
  maxSpeed: number; // m/s
  acceleration: number; // m/s²
  doorTime: number; // seconds to open (and again to close)
  boardTime: number; // seconds per person stepping in or out
  served: ServedMode;
  customFloors: string; // e.g. "1-10, 15, 20-30" (only when served === 'custom')
  parkFloor: number; // floor an idle car returns to, -1 = stay where it stopped
}

export interface BuildingConfig {
  name: string;
  floors: number; // residential floors above the ground-floor lobby (floor 0)
  flatsPerFloor: number;
  residentsMin: number;
  residentsMax: number;
  visitorsMin: number; // extra people per flat per day
  visitorsMax: number;
  floorHeight: number; // metres
  elevators: ElevatorConfig[];
}

export interface TrafficConfig {
  enabled: boolean;
  demandMultiplier: number;
  workShare: number; // share of residents leaving for work/school each day
  workDepartHour: number; // mean departure time, hours
  workDepartSpread: number; // standard deviation, hours
  workDurationHours: number;
  errandsPerDay: number; // extra round trips per resident per day
  interfloorPerDay: number; // visits to another floor per resident per day
  deliveryShare: number; // share of visitors that are short deliveries
}

export interface EnergyConfig {
  carMassKg: number;
  personMassKg: number;
  counterweightRatio: number; // counterweight = car + ratio × rated load
  motorEfficiency: number;
  regen: boolean;
  regenEfficiency: number;
  standbyW: number; // per car, always on
  doorCycleWh: number;
  frictionN: number;
}

export interface ScenarioConfig {
  cars: { floor: number; riders: number[] }[];
  waiting: { floor: number; dest: number; count: number }[];
}

export interface SimConfig {
  seed: number;
  startHour: number;
  callMode: CallMode;
  doorDwell: number; // seconds doors stay open after the last person moves
  walkSpeed: number; // m/s
  buildings: BuildingConfig[];
  traffic: TrafficConfig;
  energy: EnergyConfig;
  scenario: ScenarioConfig | null; // hand-built situation (sandbox), building 0 only
}

export function defaultElevator(): ElevatorConfig {
  return {
    capacity: 13,
    maxSpeed: 2.5,
    acceleration: 1.0,
    doorTime: 2.0,
    boardTime: 1.0,
    served: 'all',
    customFloors: '',
    parkFloor: -1,
  };
}

export function defaultBuilding(name = 'Tower A'): BuildingConfig {
  return {
    name,
    floors: 30,
    flatsPerFloor: 6,
    residentsMin: 4,
    residentsMax: 5,
    visitorsMin: 2,
    visitorsMax: 3,
    floorHeight: 3.0,
    elevators: [defaultElevator(), defaultElevator(), defaultElevator(), defaultElevator()],
  };
}

export function defaultConfig(): SimConfig {
  return {
    seed: 42,
    startHour: 7,
    callMode: 'hall',
    doorDwell: 2.0,
    walkSpeed: 1.3,
    buildings: [defaultBuilding()],
    traffic: {
      enabled: true,
      demandMultiplier: 1,
      workShare: 0.6,
      workDepartHour: 8.25,
      workDepartSpread: 1.0,
      workDurationHours: 9,
      errandsPerDay: 0.7,
      interfloorPerDay: 0.1,
      deliveryShare: 0.5,
    },
    energy: {
      carMassKg: 1300,
      personMassKg: 75,
      counterweightRatio: 0.45,
      motorEfficiency: 0.8,
      regen: true,
      regenEfficiency: 0.6,
      standbyW: 120,
      doorCycleWh: 0.4,
      frictionN: 300,
    },
    scenario: null,
  };
}

/** Which floors a car stops at. Index = floor, floor 0 (lobby) is always served. */
export function servedFloors(e: ElevatorConfig, floors: number): boolean[] {
  const out = new Array<boolean>(floors + 1).fill(false);
  out[0] = true;
  const split = Math.ceil(floors / 2);
  for (let f = 1; f <= floors; f++) {
    switch (e.served) {
      case 'all': out[f] = true; break;
      case 'even': out[f] = f % 2 === 0; break;
      case 'odd': out[f] = f % 2 === 1; break;
      case 'low': out[f] = f <= split; break;
      case 'high': out[f] = f > split; break;
      case 'custom': break;
    }
  }
  if (e.served === 'custom') {
    for (const part of e.customFloors.split(',')) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) continue;
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : Number(m[2]);
      for (let f = Math.min(a, b); f <= Math.max(a, b) && f <= floors; f++) out[f] = true;
    }
  }
  return out;
}

export const CAR_COLORS = ['#4cc9f0', '#ff6b9d', '#b5e48c', '#ffd166', '#c77dff', '#ff9f1c', '#06d6a0', '#f4a3a3'];
export const carName = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
export const floorLabel = (f: number) => (f === 0 ? 'G' : String(f));
