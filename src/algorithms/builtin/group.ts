import { bestCar, collective, eta, nearestServed, travelTime, type CarView, type ElevatorAlgorithm, type HallCallView, type WorldView } from '../api';

/** Seconds of advantage the car already holding a call keeps, so calls don't flip between cars. */
const KEEP = 6;

/** Cost of giving a hall call to a car: estimated arrival time, pushed up as the car fills. */
function etaCost(car: CarView, call: HallCallView, world: WorldView): number {
  const fill = car.load / car.capacity;
  const held = call.assignedCar === car.id ? KEEP : 0;
  return eta(car, call.floor, call.direction, world) + 20 * fill + (car.isFull ? 90 : 0) - held;
}

export const groupNearest: ElevatorAlgorithm = {
  id: 'group-nearest',
  name: 'Group control: nearest car',
  description:
    'Classic bank controller. Each new hall call is given to one car using a suitability score (close, and already coming this way, scores best); each car then runs collective control on its own calls.',
  assignCall(call, world) {
    const n = world.topFloor;
    return bestCar(call.eligibleCars, world, (car) => {
      const d = Math.abs(car.position - call.floor);
      let fs: number;
      if (!car.direction) fs = n + 1 - d;
      else if ((call.floor - car.position) * car.direction < 0) fs = 1; // moving away
      else fs = car.direction === call.direction ? n + 2 - d : n + 1 - d;
      if (car.isFull) fs -= n;
      const held = call.assignedCar === car.id;
      fs -= car.assignedCalls.length - (held ? 1 : 0); // share the work between cars
      if (held) fs += 1.5;
      return -fs + car.load * 0.01;
    });
  },
  nextStop: (car, world) => collective(car, world),
};

export const etaDispatch: ElevatorAlgorithm = {
  id: 'eta',
  name: 'Group control: shortest ETA',
  description:
    'Each new hall call goes to the car that can get there soonest, counting the stops it already has to make and how full it is. A solid modern default.',
  assignCall: (call, world) => bestCar(call.eligibleCars, world, (car) => etaCost(car, call, world)),
  nextStop: (car, world) => collective(car, world),
};

export const destinationDispatch: ElevatorAlgorithm = {
  id: 'destination',
  name: 'Destination dispatch',
  description:
    'For destination keypads: people enter their floor before boarding and are told which car to take. Riders heading to the same floors are grouped into the same car, cutting the number of stops. With plain buttons it falls back to shortest-ETA.',
  prefersMode: 'destination',
  params: {
    grouping: { label: 'Grouping strength', min: 0, max: 3, step: 0.1, value: 1 },
  },
  assignPassenger(req, world) {
    const eligible = world.cars.filter((c) => c.serves(req.floor) && c.serves(req.dest)).map((c) => c.id);
    return bestCar(eligible, world, (car) => {
      const pickups = car.assigned.map((a) => ({ floor: a.floor, direction: a.direction as number }));
      const pickup = eta(car, req.floor, req.direction, world, pickups);
      const stopsAtOrigin = car.carCalls.includes(req.floor) || car.assigned.some((a) => a.floor === req.floor);
      const stopsAtDest = car.carCalls.includes(req.dest) || car.assigned.some((a) => a.dest === req.dest);
      const newStops = (stopsAtOrigin ? 0 : 1) + (stopsAtDest ? 0 : 1);
      // Every extra stop delays everyone already committed to this car.
      const others = car.load + car.assigned.length;
      const sameWay = car.assigned.filter((a) => a.direction === req.direction).length;
      const crowded = car.load + sameWay >= car.capacity ? 120 : 0;
      return (
        pickup +
        0.5 * travelTime(req.dest - req.floor, car, world) +
        world.params.grouping * newStops * car.stopTime * (1 + 0.25 * others) +
        crowded
      );
    });
  },
  assignCall: (call, world) => bestCar(call.eligibleCars, world, (car) => etaCost(car, call, world)),
  nextStop: (car, world) => collective(car, world),
};

export const peakAware: ElevatorAlgorithm = {
  id: 'peak-aware',
  name: 'Peak-aware parking',
  description:
    'Shortest-ETA dispatch plus prediction: idle cars are pre-positioned from recent traffic. Morning rush (people leaving) spreads them over the upper floors; evening rush (people arriving) sends them back to the lobby.',
  params: {
    sensitivity: { label: 'Peak threshold', min: 0.2, max: 4, step: 0.1, value: 1, unit: 'people/min' },
  },
  assignCall: (call, world) => bestCar(call.eligibleCars, world, (car) => etaCost(car, call, world)),
  nextStop: (car, world) => collective(car, world),
  park(car, world) {
    const { up, down } = world.traffic;
    const n = world.cars.length;
    const threshold = world.params.sensitivity;
    if (up > threshold && up > 1.5 * down) return 0; // people arriving: wait in the lobby
    if (down > threshold && down > 1.5 * up) {
      // people leaving: spread across the upper floors
      return nearestServed(car, Math.round((world.topFloor * (car.id + 1)) / (n + 0.5)));
    }
    // quiet or mixed: one car at the lobby, the rest spread evenly
    return nearestServed(car, Math.round((world.topFloor * car.id) / Math.max(1, n)));
  },
};

export const energySaver: ElevatorAlgorithm = {
  id: 'energy-saver',
  name: 'Energy saver',
  description:
    'Trades waiting time for electricity. Calls go to a car that is already moving that way when possible, an idle car only starts once a call has waited for the patience time, and cars never move just to park.',
  params: {
    patience: { label: 'Patience before starting an idle car', min: 0, max: 90, step: 5, value: 20, unit: 's' },
  },
  assignCall(call, world) {
    return bestCar(call.eligibleCars, world, (car) => {
      const base = eta(car, call.floor, call.direction, world);
      const onTheWay =
        car.direction !== 0 && car.direction === call.direction && (call.floor - car.position) * car.direction > 0;
      const idle = car.direction === 0 && car.load === 0 && car.assignedCalls.length === 0;
      // Waking an idle car costs a full start/stop cycle; riding along with a passing car is nearly free.
      const held = call.assignedCar === car.id ? KEEP : 0;
      return base + (onTheWay ? -15 : 0) + (idle ? 25 : 0) + (car.isFull ? 90 : 0) - held;
    });
  },
  nextStop(car, world) {
    const cmd = collective(car, world);
    if (cmd === null || car.load > 0 || car.state !== 'idle') return cmd;
    const mine = world.calls.filter((c) => c.assignedCar === car.id || (c.assignedCar === null && c.eligibleCars.includes(car.id)));
    const oldest = Math.max(0, ...mine.map((c) => c.age));
    return mine.length >= 2 || oldest >= world.params.patience ? cmd : null;
  },
  park: () => null,
};
