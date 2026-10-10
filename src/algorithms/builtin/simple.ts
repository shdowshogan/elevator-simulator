import { collective, myCalls, type CarView, type ElevatorAlgorithm } from '../api';

/** Floors another empty car is already heading to, so two cars do not chase the same call. */
function claimed(car: CarView, cars: CarView[]): Set<number> {
  const s = new Set<number>();
  for (const c of cars) {
    if (c.id !== car.id && c.lobby === car.lobby && c.target !== null && !c.parking && c.load === 0) s.add(c.target);
  }
  return s;
}

export const fcfs: ElevatorAlgorithm = {
  id: 'fcfs',
  name: 'First come, first served',
  description:
    'Naive baseline. Each car answers the oldest unanswered call, then delivers its riders in the order they pressed their buttons, without stopping for anyone on the way.',
  nextStop(car, world) {
    if (car.carCallsInOrder.length) return car.carCallsInOrder[0];
    if (car.isFull) return null;
    const taken = claimed(car, world.cars);
    let oldest = null;
    for (const c of myCalls(car, world)) {
      if (taken.has(c.floor)) continue;
      if (!oldest || c.age > oldest.age) oldest = c;
    }
    return oldest ? { floor: oldest.floor, direction: oldest.direction } : null;
  },
};

export const nearest: ElevatorAlgorithm = {
  id: 'nearest',
  name: 'Nearest request first',
  description:
    'Greedy: always go to the closest floor anyone wants, whether a rider or a hall call. Short moves, but far-away floors can be starved during busy periods.',
  nextStop(car, world) {
    const moving = car.state === 'moving';
    const from = moving ? car.nextStoppable : car.floor;
    const dir = car.direction;
    const reachable = (f: number) => !moving || (f - from) * dir >= 0;
    const taken = claimed(car, world.cars);
    let best: { floor: number; direction?: 1 | -1 } | null = null;
    let bestDist = Infinity;
    for (const f of car.carCalls) {
      const d = Math.abs(f - car.position);
      if (reachable(f) && d < bestDist) { best = { floor: f }; bestDist = d; }
    }
    if (!car.isFull) {
      for (const c of myCalls(car, world)) {
        if (taken.has(c.floor) || !reachable(c.floor)) continue;
        // A car with riders only picks up people going its way.
        if (car.load > 0 && car.carCalls.length && Math.sign(car.carCalls[0] - c.floor) !== c.direction) continue;
        const d = Math.abs(c.floor - car.position);
        if (d < bestDist) { best = { floor: c.floor, direction: car.load ? undefined : c.direction }; bestDist = d; }
      }
    }
    if (best) return best;
    return moving && car.target !== null ? car.target : null;
  },
};

export const scan: ElevatorAlgorithm = {
  id: 'scan',
  name: 'SCAN (full sweep)',
  description:
    'Like a disk head: sweep to the very top, then to the very bottom, picking up calls in the direction of travel. Fair and predictable, but wastes travel on empty stretches.',
  nextStop(car, world) {
    const calls = car.isFull ? [] : myCalls(car, world);
    if (!car.carCalls.length && !calls.length) return null;
    const dirs = (world.state.dir ??= {}) as Record<number, 1 | -1>;
    let d: 1 | -1 = car.state === 'moving' && car.direction ? car.direction : dirs[car.id] ?? 1;
    const at = car.state === 'moving' ? car.nextStoppable : car.floor;
    const top = car.topFloor;
    if (car.state !== 'moving') {
      if (d === 1 && at >= top) d = -1;
      else if (d === -1 && at <= 0) d = 1;
    }
    dirs[car.id] = d;
    let pick: number | null = null;
    let score = Infinity;
    for (const f of car.carCalls) if ((f - at) * d >= 0 && (f - at) * d < score) { pick = f; score = (f - at) * d; }
    for (const c of calls) if (c.direction === d && (c.floor - at) * d >= 0 && (c.floor - at) * d < score) { pick = c.floor; score = (c.floor - at) * d; }
    if (pick !== null) return { floor: pick, direction: d };
    const end = d === 1 ? top : 0;
    return { floor: end, direction: -d as 1 | -1 };
  },
};

export const look: ElevatorAlgorithm = {
  id: 'look',
  name: 'Collective (LOOK), uncoordinated',
  description:
    'What a single ordinary elevator does: keep going one way while there are requests ahead, then reverse. Every car reacts to every call, so several cars may race to the same floor.',
  nextStop: (car, world) => collective(car, world),
};
