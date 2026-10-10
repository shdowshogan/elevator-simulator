# Elevator Lab

A local 3D simulator for comparing elevator control algorithms in residential towers.
Everything runs in your browser on `localhost`; nothing is uploaded.

## Run it

```
npm install
npm run dev
```

Then open http://localhost:5173.

- `npm test` runs the engine tests (and prints a full-day comparison table).
- `npm run build` type-checks and builds a production bundle.

## The four tabs

- **Simulate**: a full day of traffic in your buildings, in 3D. Every setting on the left is editable.
  Click a person, a car or a floor to inspect it and change where people want to go.
- **Sandbox**: hand-build one exact situation (cars, riders, people waiting) and watch it play out.
- **Compare**: run several algorithms, or several setups (even/odd zoning, number of cars…), against
  exactly the same people and compare time, electricity and comfort.
- **Algorithm editor**: write your own algorithm in the page.

## Writing your own algorithm

Two ways, same interface:

1. In the **Algorithm editor** tab (plain JavaScript, saved in the browser).
2. As a file: add a `.ts` file to `src/algorithms/custom/` that default-exports an algorithm.
   `src/algorithms/custom/my-algorithm.ts` is a working starter.

The interface and the reusable helpers (`collective`, `eta`, `bestCar`, …) are documented in
`src/algorithms/api.ts`. The built-in algorithms in `src/algorithms/builtin/` are short and make
good examples.

## Where things live

- `src/sim/`: the simulation engine (no graphics; deterministic for a given seed)
- `src/algorithms/`: the algorithm interface, built-ins and your custom ones
- `src/render/`: the three.js scene
- `src/ui/`: the React interface
