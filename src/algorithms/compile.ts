import { helpers, type ElevatorAlgorithm } from './api';

export interface EditorAlgorithm {
  id: string;
  name: string;
  source: string;
}

/**
 * Turn source typed into the in-site editor into an algorithm object. The code runs in this
 * browser tab only. It may `return { ... }` or `export default { ... }`; `helpers`, `UP` and
 * `DOWN` are in scope.
 */
export function compileAlgorithm(source: string, id: string): ElevatorAlgorithm {
  const body = source.replace(/export\s+default\s+/, 'return ');
  const factory = new Function('helpers', 'UP', 'DOWN', `"use strict";\n${body}`);
  const algo = factory(helpers, helpers.UP, helpers.DOWN);
  if (!algo || typeof algo !== 'object') throw new Error('The code must return (or export default) an algorithm object.');
  if (typeof algo.nextStop !== 'function') throw new Error('The algorithm needs a nextStop(car, world) function.');
  for (const hook of ['assignCall', 'assignPassenger', 'park']) {
    if (algo[hook] !== undefined && typeof algo[hook] !== 'function') throw new Error(`${hook} must be a function.`);
  }
  for (const [key, spec] of Object.entries(algo.params ?? {}) as [string, any][]) {
    if (!spec || typeof spec.value !== 'number' || typeof spec.min !== 'number' || typeof spec.max !== 'number') {
      throw new Error(`Parameter "${key}" needs numeric min, max and value.`);
    }
    spec.label ??= key;
  }
  return { ...algo, id, name: String(algo.name || 'Untitled algorithm') };
}

export const EDITOR_TEMPLATE = `// Return an algorithm object. helpers, UP (1) and DOWN (-1) are available.
// nextStop is asked whenever a car needs a decision; return a floor number,
// { floor, direction }, or null to stay where it is.
return {
  name: 'My algorithm',
  description: 'Collective control with an express rule for the lobby.',

  // Optional sliders. Read them as world.params.<key>.
  params: {
    lobbyPatience: { label: 'Send an empty car to the lobby after', min: 0, max: 120, step: 5, value: 30, unit: 's' },
  },

  nextStop(car, world) {
    // Example rule: an empty idle car answers a lobby call that has waited too long before anything else.
    const lobby = world.calls.find((c) => c.floor === 0 && c.direction === UP);
    if (lobby && car.load === 0 && car.state === 'idle' && lobby.age > world.params.lobbyPatience && car.serves(0)) {
      return { floor: 0, direction: UP };
    }
    // Otherwise behave like a normal elevator.
    return helpers.collective(car, world);
  },

  // Give each hall call to one car (remove this to let every car react to every call).
  // Asked when the call appears and again every few seconds; call.assignedCar is the current holder.
  assignCall(call, world) {
    return helpers.bestCar(call.eligibleCars, world, (car) =>
      helpers.eta(car, call.floor, call.direction, world)
      + (car.isFull ? 90 : 0)                      // a full car cannot help
      - (call.assignedCar === car.id ? 6 : 0));    // small bonus for the current holder, to avoid flip-flopping
  },

  // Destination keypads only: choose the car for each person.
  // assignPassenger(req, world) { return carId; },

  // Where an idle car waits. Return null to stay put.
  // park(car, world) { return 0; },
};
`;

export const EDITOR_REFERENCE: { title: string; rows: [string, string][] }[] = [
  {
    title: 'car',
    rows: [
      ['id, name', 'index and letter of the car'],
      ['floor / position', 'nearest floor / exact position in floors'],
      ['direction', '1 up, -1 down, 0 none'],
      ['state', "'idle' | 'moving' | 'opening' | 'open' | 'closing'"],
      ['target', 'floor it is moving to, or null'],
      ['nextStoppable', 'nearest floor it can still stop at'],
      ['load, capacity, free, isFull', 'people on board'],
      ['carCalls', 'floors pressed inside, sorted'],
      ['carCallsInOrder', 'same, in the order pressed'],
      ['serves(floor), servedFloors, topFloor', 'zoning of this car'],
      ['assignedCalls', 'hall calls given to it by assignCall'],
      ['assigned', 'people told to take it (destination keypads)'],
      ['maxSpeed, acceleration, stopTime', 'for time estimates'],
    ],
  },
  {
    title: 'world',
    rows: [
      ['calls', 'hall calls: floor, direction, age, assignedCar, eligibleCars'],
      ['calls[i].waiting / destinations / passengers', 'destination keypads only, otherwise null'],
      ['cars', 'every car in the building'],
      ['time, timeOfDay, day', 'seconds since start, hour 0–24, day number'],
      ['traffic', '{ up, down, inter, total } people per minute, last 5 min'],
      ['topFloor, floorHeight, mode', 'building facts'],
      ['params', 'current values of your sliders'],
      ['state', 'your own memory between calls'],
    ],
  },
  {
    title: 'helpers',
    rows: [
      ['collective(car, world, calls?)', 'next stop under standard collective (LOOK) control'],
      ['myCalls(car, world)', 'calls this car may answer'],
      ['eta(car, floor, direction, world)', 'seconds until the car could serve that call'],
      ['travelTime(floors, car, world)', 'seconds to travel a distance'],
      ['bestCar(ids, world, costFn)', 'car id with the lowest cost'],
      ['nearestServed(car, floor)', 'closest floor the car stops at'],
    ],
  },
];
