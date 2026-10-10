import {
  eta as estimateArrival,
  type CarView,
  type ElevatorAlgorithm,
  type HallCallView,
  type PassengerRequest,
  type WorldView,
} from '../algorithms/api';
import { layoutOf, type Layout, type Plan } from './layout';
import { planOf } from './plan';
import { Metrics, percentile, type SeriesPoint, type Summary } from './metrics';
import { generateDay, type Trip } from './traffic';
import { carName, servedFloors, type BuildingConfig, type Dir, type ElevatorConfig, type SimConfig } from './types';

export const DT = 0.1; // seconds per simulation step
const G = 9.81;
const SAMPLE = 300; // seconds between chart samples
const TRANSFER_WALK = 4; // seconds to re-queue when changing cars in the lobby
const REASSIGN = 3; // seconds between second looks at which car should hold each waiting hall call

export type CarState = 'idle' | 'moving' | 'opening' | 'open' | 'closing';
export type PassengerState = 'walkIn' | 'waiting' | 'riding' | 'walkOut';

export interface Passenger {
  id: number;
  b: number;
  origin: number;
  dest: number; // where this elevator ride ends
  finalDest: number; // where the person actually wants to be
  flat: number; // where they walk from: flat index, -1 street, -2 already in the lobby
  destFlat: number;
  floor: number; // current floor while not riding
  bank: number; // the lift lobby they use
  fromBank: number; // the lobby they gave up on and walked away from, -1 if none
  state: PassengerState;
  stateT: number;
  stateDur: number;
  car: number; // car being ridden, -1 otherwise
  lastCar: number;
  slot: number;
  assignedCar: number; // destination keypads: the car they were told to take, -1 = any
  tStart: number; // when they set off
  tCall: number;
  tBoard: number;
  waitTotal: number;
  rideTotal: number;
  stops: number;
  crowdSum: number;
  crowdN: number;
  wrongWay: boolean;
}

export interface Car {
  index: number;
  name: string;
  bank: number; // lift lobby this car stands in
  cfg: ElevatorConfig;
  served: boolean[];
  servedList: number[];
  pos: number; // metres above the lobby
  vel: number; // m/s, positive = up
  state: CarState;
  target: number;
  announce: Dir | null; // direction the algorithm wants shown on arrival
  parking: boolean;
  direction: Dir;
  indicator: Dir; // direction shown while the doors are open
  door: number; // 0 closed … 1 open
  xferT: number;
  idleT: number;
  riders: Passenger[];
  slots: boolean[];
  callOrder: number[];
  askedVersion: number;
  askedAt: number;
  energyJ: number;
  distance: number;
  starts: number;
  doorCycles: number;
  busyTime: number;
}

interface HallCall {
  bank: number;
  floor: number;
  dir: 1 | -1;
  assignedCar: number;
  eligible: number[];
}

export interface BuildingSim {
  index: number;
  cfg: BuildingConfig;
  layout: Layout;
  plan: Plan;
  banks: number;
  levels: number;
  h: number;
  cars: Car[];
  /** Queues, indexed lobby * levels + floor. */
  waiting: Passenger[][];
  walkers: Passenger[];
  passengers: Map<number, Passenger>;
  calls: (HallCall | null)[];
  version: number;
  pending: Trip[];
  cursor: number;
  dayGenerated: number;
  algoState: Record<string, any>;
  metrics: Metrics;
  unserved: number;
  faults: number;
  lastError: string | null;
  recent: { t: number; kind: 0 | 1 | 2 }[];
  nextReassign: number;
  view: WorldView | null;
  viewVersion: number;
  viewTime: number;
}

const dirOf = (p: Passenger): 1 | -1 => (p.dest > p.floor ? 1 : -1);
/** queue is lobby * levels + floor. */
const callIndex = (queue: number, dir: number) => queue * 2 + (dir === 1 ? 0 : 1);

export class Simulation {
  readonly cfg: SimConfig;
  readonly algo: ElevatorAlgorithm;
  readonly params: Record<string, number>;
  time = 0;
  buildings: BuildingSim[] = [];
  series: SeriesPoint[] = [];
  lastDeliveryTime = 0;
  private nextId = 1;
  private nextSample = SAMPLE;
  private sampleEnergy = 0;
  private sampleDelivered = 0;
  private sampleWait = 0;

  constructor(cfg: SimConfig, algo: ElevatorAlgorithm, params: Record<string, number> = {}) {
    this.cfg = cfg;
    this.algo = algo;
    this.params = {};
    for (const [k, spec] of Object.entries(algo.params ?? {})) this.params[k] = params[k] ?? spec.value;

    cfg.buildings.forEach((bc, index) => {
      const levels = bc.floors + 1;
      const plan = planOf(bc);
      const b: BuildingSim = {
        index,
        cfg: bc,
        layout: layoutOf(bc),
        plan,
        banks: plan.banks,
        levels,
        h: bc.floorHeight,
        cars: bc.elevators.map((ec, i) => this.makeCar(i, ec, bc, plan)),
        waiting: Array.from({ length: levels * plan.banks }, () => []),
        walkers: [],
        passengers: new Map(),
        calls: new Array(levels * plan.banks * 2).fill(null),
        version: 1,
        pending: [],
        cursor: 0,
        dayGenerated: -1,
        algoState: {},
        metrics: new Metrics(),
        unserved: 0,
        faults: 0,
        lastError: null,
        recent: [],
        nextReassign: REASSIGN,
        view: null,
        viewVersion: -1,
        viewTime: -1,
      };
      this.buildings.push(b);
    });

    if (cfg.scenario && this.buildings[0]) this.applyScenario(this.buildings[0]);
  }

  /** Seconds since midnight of day 0. */
  get clock(): number {
    return this.cfg.startHour * 3600 + this.time;
  }

  // ------------------------------------------------------------------ setup

  private makeCar(index: number, cfg: ElevatorConfig, bc: BuildingConfig, plan: Plan): Car {
    const served = servedFloors(cfg, bc.floors);
    const start = cfg.parkFloor >= 0 && cfg.parkFloor <= bc.floors && served[cfg.parkFloor] ? cfg.parkFloor : 0;
    const bank = Math.min(plan.banks - 1, Math.max(0, Math.round(cfg.bank ?? 0)));
    // Towers letter their cars; multi-lobby buildings name them after the lobby (NW, NW2, …).
    const earlier = bc.elevators.slice(0, index).filter((e) => Math.min(plan.banks - 1, Math.max(0, Math.round(e.bank ?? 0))) === bank).length;
    const name = plan.banks === 1 ? carName(index) : plan.bankNames[bank] + (earlier ? earlier + 1 : '');
    return {
      index,
      name,
      bank,
      cfg,
      served,
      servedList: served.flatMap((s, f) => (s ? [f] : [])),
      pos: start * bc.floorHeight,
      vel: 0,
      state: 'idle',
      target: -1,
      announce: null,
      parking: false,
      direction: 0,
      indicator: 0,
      door: 0,
      xferT: 0,
      idleT: 0,
      riders: [],
      slots: [],
      callOrder: [],
      askedVersion: -1,
      askedAt: -1e9,
      energyJ: 0,
      distance: 0,
      starts: 0,
      doorCycles: 0,
      busyTime: 0,
    };
  }

  private applyScenario(b: BuildingSim) {
    const sc = this.cfg.scenario!;
    const top = b.levels - 1;
    const clampF = (f: number) => Math.min(top, Math.max(0, Math.round(f)));
    sc.cars.forEach((s, i) => {
      const c = b.cars[i];
      if (!c) return;
      let f = clampF(s.floor);
      if (!c.served[f]) f = 0;
      c.pos = f * b.h;
      for (const raw of s.riders) this.addRider(0, i, clampF(raw));
    });
    for (const w of sc.waiting) {
      for (let k = 0; k < Math.max(1, Math.round(w.count)); k++) this.addPassenger(0, clampF(w.floor), clampF(w.dest));
    }
  }

  private newPassenger(b: BuildingSim, floor: number, finalDest: number, flat: number, destFlat: number): Passenger {
    const p: Passenger = {
      id: this.nextId++,
      b: b.index,
      origin: floor,
      dest: finalDest,
      finalDest,
      flat,
      destFlat,
      floor,
      bank: 0,
      fromBank: -1,
      state: 'walkIn',
      stateT: this.time,
      stateDur: 0,
      car: -1,
      lastCar: -1,
      slot: 0,
      assignedCar: -1,
      tStart: this.time,
      tCall: this.time,
      tBoard: this.time,
      waitTotal: 0,
      rideTotal: 0,
      stops: 0,
      crowdSum: 0,
      crowdN: 0,
      wrongWay: false,
    };
    b.passengers.set(p.id, p);
    return p;
  }

  // ------------------------------------------------------------------ stepping

  /** Advance by a number of seconds of simulated time. */
  advance(seconds: number) {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) this.step();
  }

  step() {
    for (const b of this.buildings) this.stepBuilding(b);
    this.time += DT;
    if (this.time >= this.nextSample) this.sample();
  }

  private stepBuilding(b: BuildingSim) {
    const t = this.time;

    if (this.cfg.traffic.enabled) {
      const clock = this.clock;
      const day = Math.floor(clock / 86400);
      if (day > b.dayGenerated) this.generate(b, day);
      while (b.cursor < b.pending.length && b.pending[b.cursor].t <= clock) this.spawnTrip(b, b.pending[b.cursor++]);
    }

    for (let i = b.walkers.length - 1; i >= 0; i--) {
      const p = b.walkers[i];
      if (t - p.stateT < p.stateDur) continue;
      b.walkers.splice(i, 1);
      if (p.state === 'walkIn') this.becomeWaiting(b, p);
      else b.passengers.delete(p.id);
    }

    for (const c of b.cars) this.stepCar(b, c);

    if (t >= b.nextReassign) {
      b.nextReassign = t + REASSIGN;
      for (const call of b.calls) if (call) this.assignCall(b, call);
    }

    const interval = this.hasCalls(b) ? 1 : 30;
    for (const c of b.cars) {
      if (c.state === 'idle') {
        if (c.askedVersion !== b.version || t - c.askedAt >= interval) this.decide(b, c);
      } else if (c.state === 'moving') {
        if (c.askedVersion !== b.version) this.decide(b, c);
      }
    }
  }

  private hasCalls(b: BuildingSim): boolean {
    for (const c of b.calls) if (c) return true;
    return false;
  }

  private generate(b: BuildingSim, day: number) {
    const start = this.cfg.startHour * 3600;
    const fresh = generateDay(this.cfg, b.index, day).filter((tr) => tr.t >= start);
    b.pending = b.pending.slice(b.cursor).concat(fresh).sort((x, y) => x.t - y.t);
    b.cursor = 0;
    b.dayGenerated = day;
  }

  private spawnTrip(b: BuildingSim, tr: Trip) {
    const leg = this.route(b, tr.from, tr.to);
    if (leg < 0) {
      b.unserved++;
      return;
    }
    const p = this.newPassenger(b, tr.from, tr.to, tr.flat, tr.destFlat);
    p.dest = leg;
    p.bank = this.chooseBank(b, p, -1);
    if (p.bank < 0) {
      b.passengers.delete(p.id);
      b.unserved++;
      return;
    }
    p.stateDur = b.plan.walk(tr.flat, p.bank) / this.cfg.walkSpeed;
    b.walkers.push(p);
  }

  /** First elevator ride needed to get from `from` to `to`: direct, or via the lobby. -1 if impossible. */
  private route(b: BuildingSim, from: number, to: number): number {
    if (from === to) return -1;
    let fromOk = false;
    let toOk = false;
    for (const c of b.cars) {
      if (c.served[from] && c.served[to]) return to;
      fromOk ||= c.served[from];
      toOk ||= c.served[to];
    }
    return fromOk && toOk && from !== 0 && to !== 0 ? 0 : -1;
  }

  /**
   * In a building with several lobbies, someone who arrives to find a crowd bigger than the lift
   * can take walks on to the nearest lobby with a much shorter queue (once per trip).
   */
  private walksOn(b: BuildingSim, p: Passenger): boolean {
    if (b.banks === 1 || p.fromBank >= 0) return false;
    const dir = dirOf(p);
    const queueAt = (k: number) => {
      let n = 0;
      for (const q of b.waiting[k * b.levels + p.floor]) if (dirOf(q) === dir) n++;
      return n;
    };
    let room = 0;
    for (const c of b.cars) if (c.bank === p.bank && c.served[p.floor] && c.served[p.dest]) room += c.cfg.capacity;
    const queue = queueAt(p.bank);
    if (queue < room) return false;
    let alt = -1;
    let altDist = Infinity;
    for (let k = 0; k < b.banks; k++) {
      if (k === p.bank || !b.cars.some((c) => c.bank === k && c.served[p.floor] && c.served[p.dest])) continue;
      const d = b.plan.between(p.bank, k);
      if (queueAt(k) * 2 < queue && d < altDist) {
        alt = k;
        altDist = d;
      }
    }
    if (alt < 0) return false;
    p.fromBank = p.bank;
    p.bank = alt;
    p.flat = -2;
    p.state = 'walkIn';
    p.stateT = this.time;
    p.stateDur = altDist / this.cfg.walkSpeed;
    b.walkers.push(p);
    return true;
  }

  private becomeWaiting(b: BuildingSim, p: Passenger) {
    if (this.walksOn(b, p)) return;
    p.state = 'waiting';
    p.stateT = this.time;
    p.tCall = this.time;
    b.waiting[p.bank * b.levels + p.floor].push(p);
    b.recent.push({ t: this.time, kind: p.floor === 0 ? 0 : p.finalDest === 0 ? 1 : 2 });
    this.assignPassenger(b, p);
    this.refreshCalls(b, p.bank, p.floor);
    if (this.cfg.callMode === 'destination') b.version++;
  }

  /**
   * Which lift lobby a person heads for; -1 if none has a car for the trip. On their own they
   * take the route with the least walking overall (first lobby they reach on a tie). With
   * guidance they are sent to the lobby with the best walk-plus-wait.
   * rom is the lobby they are standing in already, or -1 when starting from a room or the street.
   */
  private chooseBank(b: BuildingSim, p: Passenger, from: number): number {
    const usable = (k: number) => b.cars.some((c) => c.bank === k && c.served[p.floor] && c.served[p.dest]);
    if (b.banks === 1) return usable(0) ? 0 : -1;
    const speed = this.cfg.walkSpeed;
    const farRoom = p.dest === 0 ? -1 : Math.max(0, p.destFlat);
    const lastLeg = p.dest === p.finalDest;
    const walk: number[] = [];
    const near: number[] = [];
    let best = -1;
    let bestCost = Infinity;
    for (let k = 0; k < b.banks; k++) {
      if (!usable(k)) {
        walk.push(Infinity);
        near.push(Infinity);
        continue;
      }
      const here = from >= 0 ? b.plan.between(from, k) : p.flat < -1 ? 0 : b.plan.walk(p.flat, k);
      const there = lastLeg ? b.plan.walk(farRoom, k) : 0;
      near.push(here / speed);
      walk.push((here + there) / speed);
      const cost = here * 1.001 + there;
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    if (best < 0 || this.cfg.liftChoice !== 'guided') return best;

    const w = this.worldView(b);
    const dir = dirOf(p);
    if (this.algo.chooseLobby) {
      const req = { floor: p.floor, dest: p.dest, direction: dir, walk, nearest: best };
      const r = this.safe(b, () => this.algo.chooseLobby!(req, w));
      if (typeof r === 'number' && Number.isFinite(walk[r])) return r;
      return best;
    }
    // Default guidance: total walking, plus however long the best car there would keep them waiting,
    // plus a charge for everyone already waiting at or walking to that lobby (which keeps the
    // lobbies balanced: a far-off lift always looks free by the time you would get there).
    const heading = new Array<number>(b.banks).fill(0);
    for (const q of b.walkers) if (q.state === 'walkIn') heading[q.bank]++;
    for (let i = 0; i < b.waiting.length; i++) heading[Math.floor(i / b.levels)] += b.waiting[i].length;
    let pick = best;
    bestCost = Infinity;
    for (let k = 0; k < b.banks; k++) {
      if (!Number.isFinite(walk[k])) continue;
      let arrival = Infinity;
      for (const c of b.cars) {
        if (c.bank !== k || !c.served[p.floor] || !c.served[p.dest]) continue;
        const pending = w.calls.filter((call) => call.eligibleCars.includes(c.index));
        arrival = Math.min(arrival, estimateArrival(w.cars[c.index], p.floor, dir, w, pending));
      }
      const cost = walk[k] + Math.max(0, arrival - near[k]) + 3 * heading[k];
      if (cost < bestCost) {
        bestCost = cost;
        pick = k;
      }
    }
    return pick;
  }

  // ------------------------------------------------------------------ hall calls

  private refreshCalls(b: BuildingSim, bank: number, f: number) {
    const queue = bank * b.levels + f;
    const ws = b.waiting[queue];
    for (const dir of [1, -1] as const) {
      const i = callIndex(queue, dir);
      const eligible: number[] = [];
      let has = false;
      for (const p of ws) if (dirOf(p) === dir) { has = true; break; }
      if (has) {
        for (const c of b.cars) {
          if (c.bank !== bank || !c.served[f]) continue;
          if (ws.some((p) => dirOf(p) === dir && this.mayBoard(c, p))) eligible.push(c.index);
        }
      }
      const cur = b.calls[i];
      if (has && !cur) {
        const call: HallCall = { bank, floor: f, dir, assignedCar: -1, eligible };
        b.calls[i] = call;
        b.version++;
        this.assignCall(b, call);
      } else if (has && cur) {
        if (cur.eligible.length !== eligible.length || cur.eligible.some((v, k) => v !== eligible[k])) {
          cur.eligible = eligible;
          b.version++;
          if (cur.assignedCar >= 0 && !eligible.includes(cur.assignedCar)) {
            cur.assignedCar = -1;
            this.assignCall(b, cur);
          }
        }
      } else if (!has && cur) {
        b.calls[i] = null;
        b.version++;
      }
    }
  }

  private mayBoard(c: Car, p: Passenger): boolean {
    return c.bank === p.bank && c.served[p.dest] && (p.assignedCar < 0 || p.assignedCar === c.index);
  }

  private usesPassengerAssignment(): boolean {
    return this.cfg.callMode === 'destination' && !!this.algo.assignPassenger;
  }

  private assignCall(b: BuildingSim, call: HallCall) {
    if (!this.algo.assignCall || this.usesPassengerAssignment()) return;
    const w = this.worldView(b);
    const cv = w.calls.find((c) => c.lobby === call.bank && c.floor === call.floor && c.direction === call.dir);
    if (!cv) return;
    const r = this.safe(b, () => this.algo.assignCall!(cv, w));
    if (typeof r === 'number' && r !== call.assignedCar && call.eligible.includes(r)) {
      call.assignedCar = r;
      b.version++;
    }
  }

  private assignPassenger(b: BuildingSim, p: Passenger) {
    if (!this.usesPassengerAssignment()) return;
    b.version++;
    const w = this.worldView(b);
    const req: PassengerRequest = {
      id: p.id,
      floor: p.floor,
      dest: p.dest,
      direction: dirOf(p),
      age: this.time - p.tCall,
      assignedCar: null,
      lobby: p.bank,
    };
    const r = this.safe(b, () => this.algo.assignPassenger!(req, w));
    const c = typeof r === 'number' ? b.cars[r] : undefined;
    if (c && c.bank === p.bank && c.served[p.floor] && c.served[p.dest]) p.assignedCar = c.index;
    b.version++;
  }

  private safe<T>(b: BuildingSim, fn: () => T): T | null {
    try {
      return fn();
    } catch (e) {
      b.faults++;
      b.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  // ------------------------------------------------------------------ cars

  floorOf(b: BuildingSim, c: Car): number {
    return Math.round(c.pos / b.h);
  }

  private stepCar(b: BuildingSim, c: Car) {
    c.energyJ += this.cfg.energy.standbyW * DT;
    const doorStep = DT / Math.max(0.1, c.cfg.doorTime);
    switch (c.state) {
      case 'idle':
        return;
      case 'moving':
        this.moveCar(b, c);
        break;
      case 'opening':
        c.door += doorStep;
        if (c.door >= 1) {
          c.door = 1;
          c.state = 'open';
          c.xferT = c.cfg.boardTime;
          c.idleT = 0;
        }
        break;
      case 'open':
        this.transfer(b, c);
        break;
      case 'closing':
        c.door -= doorStep;
        if (c.door <= 0) {
          c.door = 0;
          this.doorsClosed(b, c);
        }
        break;
    }
    c.busyTime += DT;
  }

  private moveCar(b: BuildingSim, c: Car) {
    const e = this.cfg.energy;
    const targetPos = c.target * b.h;
    const delta = targetPos - c.pos;
    const dist = Math.abs(delta);
    const sgn = delta >= 0 ? 1 : -1;
    const a = c.cfg.acceleration;
    const speed = Math.abs(c.vel);

    let newVel: number;
    if (c.vel * sgn < -1e-6) {
      newVel = -sgn * Math.max(0, speed - a * DT); // still coasting the other way: brake first
    } else {
      const ns = Math.min(speed + a * DT, c.cfg.maxSpeed, Math.sqrt(2 * a * dist));
      if (dist < 0.02 || ns * DT >= dist) {
        c.distance += dist;
        c.pos = targetPos;
        c.vel = 0;
        this.arrive(b, c);
        return;
      }
      newVel = sgn * ns;
    }

    const load = c.riders.length * e.personMassKg;
    const counterweight = e.carMassKg + e.counterweightRatio * c.cfg.capacity * e.personMassKg;
    const acc = (newVel - c.vel) / DT;
    const vAvg = (newVel + c.vel) / 2;
    const force = (e.carMassKg + load - counterweight) * G + (e.carMassKg + load + counterweight) * acc;
    const power = force * vAvg + e.frictionN * Math.abs(vAvg);
    c.energyJ += (power >= 0 ? power / e.motorEfficiency : e.regen ? power * e.regenEfficiency : 0) * DT;
    c.pos += vAvg * DT;
    c.distance += Math.abs(vAvg) * DT;
    c.vel = newVel;
  }

  /** Nearest floor the car can still stop at given its speed. */
  nextStoppable(b: BuildingSim, c: Car): number {
    if (c.state !== 'moving') return this.floorOf(b, c);
    const dir = c.vel !== 0 ? Math.sign(c.vel) : Math.sign(c.target * b.h - c.pos) || 1;
    const stopPos = c.pos + (dir * c.vel * c.vel) / (2 * c.cfg.acceleration);
    let f = dir > 0 ? Math.ceil(stopPos / b.h - 1e-6) : Math.floor(stopPos / b.h + 1e-6);
    if ((f - c.target) * dir > 0) f = c.target;
    while (!c.served[f] && f !== c.target) f += dir;
    return f;
  }

  private startMove(b: BuildingSim, c: Car, floor: number, announce: Dir | null, parking: boolean) {
    const from = this.floorOf(b, c);
    c.target = floor;
    c.announce = announce;
    c.parking = parking;
    c.state = 'moving';
    c.direction = floor > from ? 1 : -1;
    c.starts++;
    const fill = c.riders.length / c.cfg.capacity;
    for (const p of c.riders) {
      p.crowdSum += fill;
      p.crowdN++;
      if (p.dest !== from && Math.sign(p.dest - from) !== c.direction) p.wrongWay = true;
    }
    b.version++;
  }

  private arrive(b: BuildingSim, c: Car) {
    const f = c.target;
    c.state = 'idle';
    c.target = -1;
    c.askedVersion = -1;
    b.version++;
    if (c.parking) {
      c.parking = false;
      c.direction = 0;
      return;
    }
    const d = this.resolveIndicator(b, c, f, c.announce);
    if (this.wouldTransfer(b, c, f, d)) this.openDoors(b, c, f, d);
  }

  private hasEligible(b: BuildingSim, c: Car, f: number, d: Dir): boolean {
    if (!d || !c.served[f]) return false;
    for (const p of b.waiting[c.bank * b.levels + f]) if (dirOf(p) === d && this.mayBoard(c, p)) return true;
    return false;
  }

  private wouldTransfer(b: BuildingSim, c: Car, f: number, d: Dir): boolean {
    let staying = 0;
    for (const p of c.riders) if (p.dest !== f) staying++;
    if (staying < c.riders.length) return true;
    return staying < c.cfg.capacity && this.hasEligible(b, c, f, d);
  }

  /** Direction shown to the people waiting when the doors open at floor f. */
  private resolveIndicator(b: BuildingSim, c: Car, f: number, announce: Dir | null): Dir {
    let up = false;
    let down = false;
    for (const p of c.riders) {
      if (p.dest > f) up = true;
      else if (p.dest < f) down = true;
    }
    if (announce === 1 || announce === -1) {
      const other = -announce as Dir;
      if (!up && !down && !this.hasEligible(b, c, f, announce) && this.hasEligible(b, c, f, other)) return other;
      return announce;
    }
    if (up || down) {
      if (up && !down) return 1;
      if (down && !up) return -1;
      return c.direction || 1;
    }
    const wantsUp = this.hasEligible(b, c, f, 1);
    const wantsDown = this.hasEligible(b, c, f, -1);
    if (wantsUp && wantsDown) {
      if (c.direction) return c.direction;
      let oldest: Passenger | null = null;
      for (const p of b.waiting[c.bank * b.levels + f]) if (this.mayBoard(c, p) && (!oldest || p.tCall < oldest.tCall)) oldest = p;
      return oldest ? dirOf(oldest) : 1;
    }
    return wantsUp ? 1 : wantsDown ? -1 : 0;
  }

  private openDoors(b: BuildingSim, c: Car, f: number, d: Dir) {
    c.state = 'opening';
    c.indicator = d;
    if (d) c.direction = d;
    c.doorCycles++;
    c.energyJ += this.cfg.energy.doorCycleWh * 3600;
    for (const p of c.riders) if (p.dest !== f) p.stops++;
    b.version++;
  }

  private transfer(b: BuildingSim, c: Car) {
    const f = this.floorOf(b, c);
    c.xferT += DT;
    const leaving = c.riders.findIndex((p) => p.dest === f);
    let boarder: Passenger | null = null;
    if (leaving < 0) {
      if (c.indicator === 0) {
        const d = this.resolveIndicator(b, c, f, null);
        if (d) {
          c.indicator = d;
          c.direction = d;
        }
      }
      if (c.indicator !== 0 && c.riders.length < c.cfg.capacity) {
        for (const p of b.waiting[c.bank * b.levels + f]) {
          if (dirOf(p) === c.indicator && this.mayBoard(c, p)) { boarder = p; break; }
        }
      }
    }
    if (leaving < 0 && !boarder) {
      c.idleT += DT;
      if (c.idleT >= this.cfg.doorDwell) c.state = 'closing';
      return;
    }
    c.idleT = 0;
    if (c.xferT < c.cfg.boardTime) return;
    c.xferT = 0;
    if (leaving >= 0) this.alight(b, c, c.riders[leaving], f);
    else this.board(b, c, boarder!, f);
  }

  private board(b: BuildingSim, c: Car, p: Passenger, f: number) {
    const ws = b.waiting[c.bank * b.levels + f];
    ws.splice(ws.indexOf(p), 1);
    let slot = 0;
    while (c.slots[slot]) slot++;
    c.slots[slot] = true;
    p.slot = slot;
    p.state = 'riding';
    p.car = p.lastCar = c.index;
    p.tBoard = this.time;
    p.stateT = this.time;
    p.waitTotal += this.time - p.tCall;
    c.riders.push(p);
    if (!c.callOrder.includes(p.dest)) c.callOrder.push(p.dest);
    this.refreshCalls(b, c.bank, f);
    b.version++;
  }

  private alight(b: BuildingSim, c: Car, p: Passenger, f: number) {
    c.riders.splice(c.riders.indexOf(p), 1);
    c.slots[p.slot] = false;
    this.rebuildCarCalls(c);
    p.rideTotal += this.time - p.tBoard;
    p.car = -1;
    p.floor = f;
    p.stateT = this.time;
    b.version++;

    if (p.finalDest !== f) {
      const leg = this.route(b, f, p.finalDest);
      const before = p.dest;
      if (leg >= 0) p.dest = leg;
      const bank = leg >= 0 ? this.chooseBank(b, p, c.bank) : -1;
      if (bank >= 0) {
        // Zoning forced a change of cars: back into the queue for the second ride.
        p.origin = f;
        p.flat = -2;
        p.state = 'walkIn';
        p.stateDur = TRANSFER_WALK + b.plan.between(c.bank, bank) / this.cfg.walkSpeed;
        p.bank = bank;
        b.walkers.push(p);
        b.metrics.transfers++;
        return;
      }
      p.dest = before;
    }
    p.stateDur = b.plan.walk(f === 0 ? -1 : Math.max(0, p.destFlat), c.bank) / this.cfg.walkSpeed;
    b.metrics.record(
      p.waitTotal,
      p.rideTotal,
      Math.max(0, p.stops),
      p.crowdN ? p.crowdSum / p.crowdN : 0,
      p.wrongWay,
      c.cfg.acceleration,
      this.time - p.tStart + p.stateDur,
    );
    this.lastDeliveryTime = this.time;
    p.state = 'walkOut';
    b.walkers.push(p);
  }

  private rebuildCarCalls(c: Car) {
    const wanted = new Set(c.riders.map((p) => p.dest));
    c.callOrder = c.callOrder.filter((f) => wanted.has(f));
    for (const p of c.riders) if (!c.callOrder.includes(p.dest)) c.callOrder.push(p.dest);
  }

  private doorsClosed(b: BuildingSim, c: Car) {
    const f = this.floorOf(b, c);
    c.state = 'idle';
    c.askedVersion = -1;
    b.version++;
    // Anyone left behind (car full) needs a new car.
    const d = c.indicator;
    if (!d) return;
    const queue = c.bank * b.levels + f;
    const call = b.calls[callIndex(queue, d)];
    if (!call) return;
    if (this.usesPassengerAssignment()) {
      for (const p of b.waiting[queue]) {
        if (p.assignedCar === c.index && dirOf(p) === d) {
          p.assignedCar = -1;
          this.assignPassenger(b, p);
        }
      }
      this.refreshCalls(b, c.bank, f);
    } else if (call.assignedCar === c.index) {
      call.assignedCar = -1;
      this.assignCall(b, call);
    }
  }

  // ------------------------------------------------------------------ decisions

  private decide(b: BuildingSim, c: Car) {
    c.askedVersion = b.version;
    c.askedAt = this.time;
    const w = this.worldView(b);
    const cv = w.cars[c.index];
    const raw = this.safe(b, () => this.algo.nextStop(cv, w)) as any;

    let floor = -1;
    let dir: Dir | null = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) floor = Math.round(raw);
    else if (raw && typeof raw === 'object' && Number.isFinite(raw.floor)) {
      floor = Math.round(raw.floor);
      const d = raw.direction;
      dir = d === 1 || d === 'up' ? 1 : d === -1 || d === 'down' ? -1 : null;
    }
    if (floor >= 0 && (floor >= b.levels || !c.served[floor])) {
      b.faults++; // asked for a floor this car cannot reach
      floor = -1;
    }

    if (c.state === 'moving') {
      if (floor < 0) {
        if (!c.parking) this.retarget(b, c, this.nextStoppable(b, c), null);
        return;
      }
      const stoppable = this.nextStoppable(b, c);
      const travel = Math.sign(c.target * b.h - c.pos) || c.direction || 1;
      if ((floor - stoppable) * travel >= 0) {
        this.retarget(b, c, floor, dir);
        c.parking = false;
      } else if (c.parking || !this.targetUseful(b, c)) {
        this.retarget(b, c, stoppable, null); // stop as soon as possible, then turn around
        c.parking = false;
      }
      return;
    }

    const here = this.floorOf(b, c);
    if (floor === here) {
      const d = this.resolveIndicator(b, c, here, dir);
      if (this.wouldTransfer(b, c, here, d)) {
        this.openDoors(b, c, here, d);
        return;
      }
      floor = -1;
    }
    if (floor < 0 && c.riders.length) {
      // Never strand riders: fall back to the nearest floor someone on board wants.
      let best = -1;
      for (const p of c.riders) if (best < 0 || Math.abs(p.dest - here) < Math.abs(best - here)) best = p.dest;
      if (best === here) {
        this.openDoors(b, c, here, this.resolveIndicator(b, c, here, null));
        return;
      }
      floor = best;
      dir = null;
    }
    if (floor >= 0) {
      this.startMove(b, c, floor, dir, false);
      return;
    }

    // Nothing to do: park.
    c.direction = 0;
    let park: number | null = null;
    if (this.algo.park) {
      const r = this.safe(b, () => this.algo.park!(cv, w));
      if (typeof r === 'number' && Number.isFinite(r)) park = Math.round(r);
    } else if (c.cfg.parkFloor >= 0) {
      park = c.cfg.parkFloor;
    }
    if (park !== null && park !== here && park >= 0 && park < b.levels && c.served[park]) {
      this.startMove(b, c, park, null, true);
    }
  }

  private retarget(b: BuildingSim, c: Car, floor: number, announce: Dir | null) {
    if (c.target === floor && c.announce === announce) return;
    const changed = c.target !== floor;
    c.target = floor;
    c.announce = announce;
    if (changed) b.version++;
  }

  private targetUseful(b: BuildingSim, c: Car): boolean {
    const f = c.target;
    if (c.riders.some((p) => p.dest === f)) return true;
    return this.hasEligible(b, c, f, 1) || this.hasEligible(b, c, f, -1);
  }

  // ------------------------------------------------------------------ algorithm view

  worldView(b: BuildingSim): WorldView {
    if (b.view && b.viewVersion === b.version && b.viewTime === this.time) return b.view;
    const t = this.time;
    const destMode = this.cfg.callMode === 'destination';

    const cars: CarView[] = b.cars.map((c) => {
      const load = c.riders.length;
      const served = c.served;
      return {
        id: c.index,
        name: c.name,
        lobby: c.bank,
        floor: Math.round(c.pos / b.h),
        position: c.pos / b.h,
        velocity: c.vel,
        direction: c.direction,
        state: c.state,
        target: c.state === 'moving' ? c.target : null,
        parking: c.parking,
        nextStoppable: this.nextStoppable(b, c),
        load,
        capacity: c.cfg.capacity,
        free: c.cfg.capacity - load,
        isFull: load >= c.cfg.capacity,
        carCalls: [...new Set(c.riders.map((p) => p.dest))].sort((x, y) => x - y),
        carCallsInOrder: c.callOrder.slice(),
        servedFloors: c.servedList,
        serves: (f: number) => !!served[f],
        topFloor: c.servedList[c.servedList.length - 1] ?? 0,
        assignedCalls: [],
        assigned: [],
        parkFloor: c.cfg.parkFloor >= 0 ? c.cfg.parkFloor : null,
        maxSpeed: c.cfg.maxSpeed,
        acceleration: c.cfg.acceleration,
        stopTime: 2 * c.cfg.doorTime + this.cfg.doorDwell + 2 * c.cfg.boardTime,
      };
    });

    const calls: HallCallView[] = [];
    for (const call of b.calls) {
      if (!call) continue;
      let oldest = t;
      const reqs: PassengerRequest[] = [];
      for (const p of b.waiting[call.bank * b.levels + call.floor]) {
        if (dirOf(p) !== call.dir) continue;
        if (p.tCall < oldest) oldest = p.tCall;
        if (destMode) {
          const req: PassengerRequest = {
            id: p.id,
            floor: p.floor,
            dest: p.dest,
            direction: call.dir,
            age: t - p.tCall,
            assignedCar: p.assignedCar >= 0 ? p.assignedCar : null,
            lobby: call.bank,
          };
          reqs.push(req);
          if (p.assignedCar >= 0) cars[p.assignedCar]?.assigned.push(req);
        }
      }
      const v: HallCallView = {
        lobby: call.bank,
        floor: call.floor,
        direction: call.dir,
        age: t - oldest,
        assignedCar: call.assignedCar >= 0 ? call.assignedCar : null,
        eligibleCars: call.eligible.slice(),
        waiting: destMode ? reqs.length : null,
        destinations: destMode ? reqs.map((r) => r.dest) : null,
        passengers: destMode ? reqs : null,
      };
      calls.push(v);
      if (call.assignedCar >= 0) cars[call.assignedCar]?.assignedCalls.push(v);
    }

    while (b.recent.length && b.recent[0].t < t - 300) b.recent.shift();
    const window = Math.min(300, Math.max(30, t)) / 60;
    const count = [0, 0, 0];
    for (const r of b.recent) count[r.kind]++;

    const clock = this.clock;
    b.view = {
      time: t,
      timeOfDay: (clock % 86400) / 3600,
      day: Math.floor(clock / 86400),
      topFloor: b.levels - 1,
      floorHeight: b.h,
      mode: this.cfg.callMode,
      cars,
      calls,
      lobbies: b.plan.bankNames.map((name, id) => ({ id, name, cars: b.cars.filter((c) => c.bank === id).map((c) => c.index) })),
      traffic: {
        up: count[0] / window,
        down: count[1] / window,
        inter: count[2] / window,
        total: b.recent.length / window,
      },
      params: this.params,
      state: b.algoState,
    };
    b.viewVersion = b.version;
    b.viewTime = t;
    return b.view;
  }

  // ------------------------------------------------------------------ editing people

  find(id: number): { b: BuildingSim; p: Passenger } | null {
    for (const b of this.buildings) {
      const p = b.passengers.get(id);
      if (p) return { b, p };
    }
    return null;
  }

  /** Put a new person in the queue on `floor` wanting to go to `dest`. Returns their id, or -1. */
  addPassenger(bi: number, floor: number, dest: number, bank?: number): number {
    const b = this.buildings[bi];
    if (!b || floor === dest || floor < 0 || dest < 0 || floor >= b.levels || dest >= b.levels) return -1;
    const leg = this.route(b, floor, dest);
    if (leg < 0) return -1;
    const p = this.newPassenger(b, floor, dest, -2, dest === 0 ? -1 : 0);
    p.dest = leg;
    const usable = (k: number) => b.cars.some((c) => c.bank === k && c.served[floor] && c.served[leg]);
    p.bank = bank !== undefined && usable(bank) ? bank : this.chooseBank(b, p, -1);
    if (p.bank < 0) {
      b.passengers.delete(p.id);
      return -1;
    }
    this.becomeWaiting(b, p);
    return p.id;
  }

  /** Everyone waiting on a floor, across all its lift lobbies. */
  waitingAt(b: BuildingSim, floor: number): Passenger[] {
    if (b.banks === 1) return b.waiting[floor];
    const out: Passenger[] = [];
    for (let k = 0; k < b.banks; k++) for (const p of b.waiting[k * b.levels + floor]) out.push(p);
    return out;
  }

  /** Put a new person inside a car, already heading for `dest`. Returns their id, or -1 if full. */
  addRider(bi: number, carIndex: number, dest: number): number {
    const b = this.buildings[bi];
    const c = b?.cars[carIndex];
    if (!c || c.riders.length >= c.cfg.capacity || dest < 0 || dest >= b.levels) return -1;
    const p = this.newPassenger(b, this.floorOf(b, c), dest, -2, dest === 0 ? -1 : 0);
    p.dest = c.served[dest] ? dest : 0;
    p.state = 'riding';
    p.car = p.lastCar = c.index;
    let slot = 0;
    while (c.slots[slot]) slot++;
    c.slots[slot] = true;
    p.slot = slot;
    c.riders.push(p);
    this.rebuildCarCalls(c);
    b.version++;
    return p.id;
  }

  /** Change where someone wants to go, whether they are walking, waiting or already riding. */
  setDestination(id: number, dest: number): boolean {
    const hit = this.find(id);
    if (!hit) return false;
    const { b, p } = hit;
    if (dest < 0 || dest >= b.levels || p.state === 'walkOut') return false;
    if (p.state === 'riding') {
      const c = b.cars[p.car];
      p.finalDest = dest;
      p.dest = c.served[dest] ? dest : 0;
      this.rebuildCarCalls(c);
      b.version++;
      return true;
    }
    const leg = this.route(b, p.floor, dest);
    if (leg < 0) return false;
    p.finalDest = dest;
    p.dest = leg;
    p.destFlat = dest === 0 ? -1 : Math.max(0, p.destFlat);
    if (p.state === 'waiting') {
      p.assignedCar = -1;
      // If no car in this lobby goes there, they move to one that does.
      if (!b.cars.some((c) => c.bank === p.bank && c.served[p.floor] && c.served[leg])) {
        const bank = this.chooseBank(b, p, p.bank);
        if (bank >= 0 && bank !== p.bank) {
          const ws = b.waiting[p.bank * b.levels + p.floor];
          ws.splice(ws.indexOf(p), 1);
          this.refreshCalls(b, p.bank, p.floor);
          p.bank = bank;
          b.waiting[bank * b.levels + p.floor].push(p);
        }
      }
      this.assignPassenger(b, p);
      this.refreshCalls(b, p.bank, p.floor);
    }
    b.version++;
    return true;
  }

  removePassenger(id: number): boolean {
    const hit = this.find(id);
    if (!hit) return false;
    const { b, p } = hit;
    if (p.state === 'riding') {
      const c = b.cars[p.car];
      c.riders.splice(c.riders.indexOf(p), 1);
      c.slots[p.slot] = false;
      this.rebuildCarCalls(c);
    } else if (p.state === 'waiting') {
      const ws = b.waiting[p.bank * b.levels + p.floor];
      ws.splice(ws.indexOf(p), 1);
      this.refreshCalls(b, p.bank, p.floor);
    } else {
      const i = b.walkers.indexOf(p);
      if (i >= 0) b.walkers.splice(i, 1);
    }
    b.passengers.delete(id);
    b.version++;
    return true;
  }

  // ------------------------------------------------------------------ results

  /** People still walking to, waiting for, or riding an elevator. */
  pendingCount(): number {
    let n = 0;
    for (const b of this.buildings) for (const p of b.passengers.values()) if (p.state !== 'walkOut') n++;
    return n;
  }

  private totals() {
    let energyJ = 0;
    let delivered = 0;
    let waitSum = 0;
    let waiting = 0;
    for (const b of this.buildings) {
      for (const c of b.cars) energyJ += c.energyJ;
      delivered += b.metrics.delivered;
      waitSum += b.metrics.waitSum;
      for (const w of b.waiting) waiting += w.length;
    }
    return { energyJ, delivered, waitSum, waiting };
  }

  private sample() {
    const tot = this.totals();
    const n = tot.delivered - this.sampleDelivered;
    this.series.push({
      t: this.clock,
      avgWait: n ? (tot.waitSum - this.sampleWait) / n : 0,
      delivered: n,
      kWh: (tot.energyJ - this.sampleEnergy) / 3.6e6,
      waiting: tot.waiting,
    });
    this.sampleEnergy = tot.energyJ;
    this.sampleDelivered = tot.delivered;
    this.sampleWait = tot.waitSum;
    this.nextSample += SAMPLE;
  }

  /** Results so far, for the whole campus or one building. */
  summary(bi?: number): Summary {
    const list = bi === undefined ? this.buildings : [this.buildings[bi]];
    const waits: number[] = [];
    const s: Summary = {
      delivered: 0, avgWait: 0, p95Wait: 0, maxWait: 0, avgRide: 0, avgJourney: 0, avgTotal: 0, longWaitPct: 0,
      avgStops: 0, avgCrowd: 0, wrongWayPct: 0, transfers: 0, comfort: 100, energyKWh: 0, whPerTrip: 0,
      starts: 0, doorCycles: 0, distanceKm: 0, utilisation: 0, waitingNow: 0, ridingNow: 0, unserved: 0,
      faults: 0, lastError: null,
    };
    let total = 0;
    let wait = 0, ride = 0, journey = 0, long = 0, stops = 0, crowd = 0, wrong = 0, comfort = 0, busy = 0, cars = 0;
    for (const b of list) {
      const m = b.metrics;
      for (const w of m.waits) waits.push(w);
      s.delivered += m.delivered;
      wait += m.waitSum; ride += m.rideSum; journey += m.journeySum; long += m.longWaits; total += m.totalSum;
      stops += m.stopsSum; crowd += m.crowdSum; wrong += m.wrongWay; comfort += m.comfortSum;
      s.transfers += m.transfers;
      s.maxWait = Math.max(s.maxWait, m.maxWait);
      s.unserved += b.unserved;
      s.faults += b.faults;
      s.lastError ??= b.lastError;
      for (const w of b.waiting) s.waitingNow += w.length;
      for (const c of b.cars) {
        s.energyKWh += c.energyJ / 3.6e6;
        s.starts += c.starts;
        s.doorCycles += c.doorCycles;
        s.distanceKm += c.distance / 1000;
        s.ridingNow += c.riders.length;
        busy += c.busyTime;
        cars++;
      }
    }
    const n = s.delivered;
    if (n) {
      waits.sort((x, y) => x - y);
      s.avgWait = wait / n;
      s.p95Wait = percentile(waits, 0.95);
      s.avgRide = ride / n;
      s.avgJourney = journey / n;
      s.avgTotal = total / n;
      s.longWaitPct = (100 * long) / n;
      s.avgStops = stops / n;
      s.avgCrowd = crowd / n;
      s.wrongWayPct = (100 * wrong) / n;
      s.comfort = comfort / n;
      s.whPerTrip = (s.energyKWh * 1000) / n;
    }
    s.utilisation = cars && this.time > 0 ? busy / (cars * this.time) : 0;
    return s;
  }
}
