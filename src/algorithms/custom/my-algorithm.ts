import { collective, myCalls, type ElevatorAlgorithm } from '../api';

// Your own algorithm. Every .ts file in this folder that default-exports an algorithm shows up
// in the algorithm list automatically (the page reloads when you save).
//
// What you get:
//   car    one elevator: car.floor, car.position, car.direction, car.load, car.capacity,
//          car.carCalls (floors pressed inside), car.state, car.nextStoppable, car.serves(floor) …
//   world  everything else: world.calls (hall calls with floor, direction, age), world.cars,
//          world.timeOfDay, world.traffic (people/min going up and down), world.params,
//          world.state (your own memory between calls)
// With destination keypads each call also has call.destinations and call.waiting.
// See src/algorithms/api.ts for the full list and the reusable helpers.

const algorithm: ElevatorAlgorithm = {
  name: 'My algorithm (file)',
  description: 'Starter: collective control, but calls that have waited too long jump the queue.',
  params: {
    maxWait: { label: 'Rescue calls older than', min: 20, max: 300, step: 10, value: 90, unit: 's' },
  },

  // Return the floor this car should go to next (or null to stay put).
  // You can also return { floor, direction } to say which way the car will leave from there.
  nextStop(car, world) {
    // An empty car goes straight to any call that has been waiting too long.
    if (car.load === 0 && car.state !== 'moving') {
      const overdue = myCalls(car, world)
        .filter((c) => c.age > world.params.maxWait)
        .sort((a, b) => b.age - a.age)[0];
      if (overdue) return { floor: overdue.floor, direction: overdue.direction };
    }
    return collective(car, world);
  },

  // Optional hooks:
  // assignCall(call, world) { return carId; }        // pick one car for each new hall call
  // assignPassenger(req, world) { return carId; }    // destination keypads: car for each person
  // park(car, world) { return floor; }               // where an idle car should wait
};

export default algorithm;
