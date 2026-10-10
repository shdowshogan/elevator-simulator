// The interface every elevator algorithm implements, plus building blocks to reuse.
//
// The engine owns physics, doors, boarding and capacity. An algorithm only answers questions:
//   nextStop(car, world)        where should this car go next?            (required)
//   assignCall(call, world)     which car should answer this hall call?   (optional; asked when the
//                               call appears and again every few seconds while it is still waiting)
//   assignPassenger(req, world) which car should this person take?        (optional, destination keypads)
//   park(car, world)            where should an idle car wait?            (optional)
//   chooseLobby(req, world)     which lift lobby should this person walk to? (optional; only in
//                               buildings with several lobbies when people follow guidance)
// Everything in `world` is a read-only snapshot. Use `world.state` to remember things between calls.

export const UP = 1;
export const DOWN = -1;
export type Direction = 1 | -1;

export interface ParamSpec {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
}

export interface PassengerRequest {
  id: number;
  floor: number;
  dest: number;
  direction: Direction;
  age: number; // seconds waited so far
  assignedCar: number | null;
  lobby: number; // the lift lobby they are standing in
}

/** Someone about to set off, in a building with several lift lobbies. */
export interface LobbyRequest {
  floor: number;
  dest: number;
  direction: Direction;
  /** Seconds of walking if they use each lobby (both ends of the trip). Infinity = no car there can take them. */
  walk: number[];
  nearest: number; // the lobby they would pick on their own
}

export interface HallCallView {
  lobby: number; // which lift lobby the call is in (always 0 in a single-lobby building)
  floor: number;
  direction: Direction;
  age: number; // seconds since the longest-waiting person here pressed the button
  assignedCar: number | null; // the car currently holding this call (set by assignCall)
  eligibleCars: number[]; // cars that stop here and can take at least one of the people waiting
  /** Only known with destination keypads; null with plain up/down buttons. */
  waiting: number | null;
  destinations: number[] | null;
  passengers: PassengerRequest[] | null;
}

export interface CarView {
  id: number;
  name: string;
  lobby: number; // the lift lobby this car stands in; cars only answer calls from their own lobby
  floor: number; // nearest floor
  position: number; // exact position in floors, e.g. 12.4
  velocity: number; // m/s, positive = up
  direction: 1 | -1 | 0; // direction of travel, or the direction announced at the last stop
  state: 'idle' | 'moving' | 'opening' | 'open' | 'closing';
  target: number | null; // floor it is travelling to
  parking: boolean; // true while moving to a parking floor
  nextStoppable: number; // nearest floor it can still stop at (its own floor when not moving)
  load: number; // people on board (load sensor)
  capacity: number;
  free: number;
  isFull: boolean;
  carCalls: number[]; // floors pressed inside the car, sorted
  carCallsInOrder: number[]; // same floors in the order they were pressed
  servedFloors: number[];
  serves(floor: number): boolean;
  topFloor: number; // highest floor this car serves
  assignedCalls: HallCallView[]; // hall calls given to this car by assignCall
  assigned: PassengerRequest[]; // people told to wait for this car (destination keypads)
  parkFloor: number | null; // from the elevator's settings
  maxSpeed: number;
  acceleration: number;
  stopTime: number; // rough seconds lost per stop (doors + boarding)
}

export interface WorldView {
  time: number; // seconds since the simulation started
  timeOfDay: number; // 0–24 hours
  day: number;
  topFloor: number;
  floorHeight: number;
  mode: 'hall' | 'destination';
  cars: CarView[];
  calls: HallCallView[];
  /** Lift lobbies: one in a tower, six in Hostel 18. */
  lobbies: { id: number; name: string; cars: number[] }[];
  /** People per minute over the last five minutes. */
  traffic: { up: number; down: number; inter: number; total: number };
  params: Record<string, number>;
  /** Scratch memory that survives between calls (one object per building). */
  state: Record<string, any>;
}

export type StopCommand =
  | number
  | { floor: number; direction?: 1 | -1 | 0 | 'up' | 'down' | null }
  | null
  | undefined
  | void;

export interface ElevatorAlgorithm {
  id?: string;
  name: string;
  description?: string;
  /** Hint for the UI: this algorithm is designed for one call mode. */
  prefersMode?: 'hall' | 'destination';
  params?: Record<string, ParamSpec>;
  nextStop(car: CarView, world: WorldView): StopCommand;
  assignCall?(call: HallCallView, world: WorldView): number | null | undefined | void;
  assignPassenger?(req: PassengerRequest, world: WorldView): number | null | undefined | void;
  park?(car: CarView, world: WorldView): number | null | undefined | void;
  chooseLobby?(req: LobbyRequest, world: WorldView): number | null | undefined | void;
}

// ---------------------------------------------------------------- helpers

/** Hall calls this car may answer: it can serve them, and they are not assigned to another car. */
export function myCalls(car: CarView, world: WorldView): HallCallView[] {
  return world.calls.filter(
    (c) => c.eligibleCars.includes(car.id) && (c.assignedCar === null || c.assignedCar === car.id),
  );
}

/**
 * Collective control (the LOOK discipline most real elevators use): keep going in the current
 * direction, stopping for riders' floors and for hall calls in that direction; when nothing is
 * left ahead, take the farthest call the other way and reverse.
 */
export function collective(car: CarView, world: WorldView, calls: HallCallView[] = myCalls(car, world)): StopCommand {
  const hall = car.isFull ? [] : calls; // a full car skips hall calls
  const at = car.state === 'moving' ? car.nextStoppable : car.floor;
  let d: number = car.direction;

  if (!d) {
    let best: number | null = null;
    let bestDist = Infinity;
    let bestAge = -1;
    let bestDir: Direction | undefined;
    for (const f of car.carCalls) {
      const dist = Math.abs(f - car.floor);
      if (dist < bestDist) { best = f; bestDist = dist; bestAge = Infinity; bestDir = undefined; }
    }
    // People already on board come first: never set off away from where they are going.
    for (const c of best === null ? hall : []) {
      const dist = Math.abs(c.floor - car.floor);
      if (dist < bestDist || (dist === bestDist && c.age > bestAge)) {
        best = c.floor; bestDist = dist; bestAge = c.age; bestDir = c.direction;
      }
    }
    if (best === null) return null;
    if (best === car.floor) return { floor: best, direction: bestDir };
    d = best > car.floor ? 1 : -1;
  }

  const ahead = (f: number) => (f - at) * d;

  // 1. Nearest stop ahead that is on the way.
  let pick: number | null = null;
  let score = Infinity;
  for (const f of car.carCalls) if (ahead(f) >= 0 && ahead(f) < score) { pick = f; score = ahead(f); }
  for (const c of hall) if (c.direction === d && ahead(c.floor) >= 0 && ahead(c.floor) < score) { pick = c.floor; score = ahead(c.floor); }
  if (pick !== null) return { floor: pick, direction: d as Direction };

  // 2. Farthest call ahead that wants to go the other way: turn around there.
  score = -1;
  for (const c of hall) if (c.direction === -d && ahead(c.floor) >= 0 && ahead(c.floor) > score) { pick = c.floor; score = ahead(c.floor); }
  if (pick !== null) return { floor: pick, direction: -d as Direction };

  // 3. Reverse: nearest stop behind that is on the way back.
  score = Infinity;
  for (const f of car.carCalls) if (ahead(f) < 0 && -ahead(f) < score) { pick = f; score = -ahead(f); }
  for (const c of hall) if (c.direction === -d && ahead(c.floor) < 0 && -ahead(c.floor) < score) { pick = c.floor; score = -ahead(c.floor); }
  if (pick !== null) return { floor: pick, direction: -d as Direction };

  // 4. Farthest call behind that wants the original direction.
  score = -1;
  for (const c of hall) if (c.direction === d && ahead(c.floor) < 0 && -ahead(c.floor) > score) { pick = c.floor; score = -ahead(c.floor); }
  if (pick !== null) return { floor: pick, direction: d as Direction };

  return null;
}

/** Seconds to travel a number of floors from standstill to standstill. */
export function travelTime(floors: number, car: CarView, world: WorldView): number {
  const dist = Math.abs(floors) * world.floorHeight;
  if (dist <= 0) return 0;
  const v = car.maxSpeed;
  const a = car.acceleration;
  return dist >= (v * v) / a ? dist / v + v / a : 2 * Math.sqrt(dist / a);
}

/**
 * Estimated seconds until this car can open its doors at `floor` ready to travel in `direction`,
 * assuming it keeps serving its riders and `calls` collectively first.
 */
export function eta(
  car: CarView,
  floor: number,
  direction: number,
  world: WorldView,
  calls: { floor: number; direction: number }[] = car.assignedCalls,
): number {
  const pos = car.position;
  const perStop = car.stopTime + car.maxSpeed / car.acceleration;
  const doorPenalty = car.state === 'open' || car.state === 'opening' || car.state === 'closing' ? car.stopTime / 2 : 0;
  const stops: { floor: number; dir: number }[] = car.carCalls.map((f) => ({ floor: f, dir: 0 }));
  for (const c of calls) if (c.floor !== floor || c.direction !== direction) stops.push({ floor: c.floor, dir: c.direction });

  // An idle car with work queued will set off towards its nearest stop first.
  let d: number = car.direction;
  if (!d && stops.length) {
    const first = car.carCalls.length ? stops.slice(0, car.carCalls.length) : stops; // riders' floors first
    let nearest = first[0].floor;
    for (const s of first) if (Math.abs(s.floor - pos) < Math.abs(nearest - pos)) nearest = s.floor;
    d = nearest > pos ? 1 : nearest < pos ? -1 : stops[0].dir || 1;
  }
  if (!d || (stops.length === 0 && car.state !== 'moving')) {
    return travelTime(floor - pos, car, world) + doorPenalty;
  }
  const fwd = (f: number) => (f - pos) * d;
  const target = fwd(floor);
  let path: number;
  let n = 0;
  if (target >= 0 && direction === d) {
    path = target;
    for (const s of stops) if ((s.dir === 0 || s.dir === d) && fwd(s.floor) >= 0 && fwd(s.floor) < target) n++;
  } else {
    let far = Math.max(0, target);
    for (const s of stops) far = Math.max(far, fwd(s.floor));
    if (direction === -d) {
      path = far + (far - target);
      for (const s of stops) if (fwd(s.floor) >= 0 || fwd(s.floor) > target) n++;
    } else {
      let near = Math.min(0, target);
      for (const s of stops) near = Math.min(near, fwd(s.floor));
      path = far + (far - near) + (target - near);
      n = stops.length;
    }
  }
  return travelTime(path, car, world) + n * perStop + doorPenalty;
}

/** The car for which `cost` is lowest among those that can serve the call. */
export function bestCar(
  eligible: number[],
  world: WorldView,
  cost: (car: CarView) => number,
): number | null {
  let best: number | null = null;
  let bestCost = Infinity;
  for (const id of eligible) {
    const c = cost(world.cars[id]);
    if (c < bestCost) { bestCost = c; best = id; }
  }
  return best;
}

/** Nearest floor to `floor` that the car actually serves. */
export function nearestServed(car: CarView, floor: number): number {
  let best = car.servedFloors[0] ?? 0;
  for (const f of car.servedFloors) if (Math.abs(f - floor) < Math.abs(best - floor)) best = f;
  return best;
}

export const helpers = { UP, DOWN, myCalls, collective, travelTime, eta, bestCar, nearestServed };
export type Helpers = typeof helpers;
