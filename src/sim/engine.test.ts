import { describe, expect, it } from 'vitest';
import { BUILTIN, FILE_ALGORITHMS } from '../algorithms/registry';
import { compileAlgorithm, EDITOR_TEMPLATE } from '../algorithms/compile';
import { Simulation } from './engine';
import { defaultConfig, defaultElevator, type SimConfig } from './types';

const ALL = [...BUILTIN, ...FILE_ALGORITHMS, compileAlgorithm(EDITOR_TEMPLATE, 'editor:test')];

function scenarioConfig(): SimConfig {
  const cfg = defaultConfig();
  cfg.traffic.enabled = false;
  cfg.scenario = {
    cars: [{ floor: 3, riders: [10, 25, 30] }, { floor: 0, riders: [] }, { floor: 18, riders: [0, 0] }, { floor: 0, riders: [] }],
    waiting: [
      { floor: 5, dest: 0, count: 1 },
      { floor: 0, dest: 22, count: 16 },
      { floor: 27, dest: 0, count: 3 },
      { floor: 12, dest: 19, count: 2 },
      { floor: 14, dest: 2, count: 1 },
    ],
  };
  return cfg;
}

/** Step the sim, checking physical invariants as it goes. */
function run(sim: Simulation, seconds: number, until?: () => boolean) {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (i % 5 === 0) {
      for (const b of sim.buildings) {
        for (const c of b.cars) {
          expect(c.riders.length).toBeLessThanOrEqual(c.cfg.capacity);
          expect(c.pos).toBeGreaterThanOrEqual(-1e-6);
          expect(c.pos).toBeLessThanOrEqual((b.levels - 1) * b.h + 1e-6);
          if (c.state !== 'moving' && c.state !== 'idle') expect(c.served[sim.floorOf(b, c)]).toBe(true);
        }
      }
      if (until?.()) return;
    }
  }
}

describe('engine', () => {
  for (const algo of ALL) {
    for (const mode of ['hall', 'destination'] as const) {
      it(`${algo.name} delivers everyone in a hand-built scenario (${mode})`, () => {
        const cfg = scenarioConfig();
        cfg.callMode = mode;
        const sim = new Simulation(cfg, algo);
        const total = sim.pendingCount();
        expect(total).toBe(28);
        run(sim, 3600, () => sim.pendingCount() === 0);
        expect(sim.pendingCount()).toBe(0);
        expect(sim.summary().delivered).toBe(total);
        expect(sim.summary().faults).toBe(0);
      });
    }
  }

  it('is deterministic for a given seed', () => {
    const a = new Simulation(defaultConfig(), BUILTIN[0]);
    const b = new Simulation(defaultConfig(), BUILTIN[0]);
    a.advance(3600);
    b.advance(3600);
    expect(a.summary()).toEqual(b.summary());
    expect(a.summary().delivered).toBeGreaterThan(100);
  });

  it('gives every algorithm the same demand', () => {
    const counts = [BUILTIN[0], BUILTIN[2]].map((algo) => {
      const sim = new Simulation(defaultConfig(), algo);
      sim.advance(1800);
      const s = sim.summary();
      let active = 0;
      for (const b of sim.buildings) for (const p of b.passengers.values()) if (p.state !== 'walkOut') active++;
      return s.delivered + active;
    });
    expect(counts[0]).toBe(counts[1]);
  });

  it('coordinated dispatch beats first-come-first-served through the morning peak', () => {
    const wait = (id: string) => {
      const sim = new Simulation(defaultConfig(), BUILTIN.find((a) => a.id === id)!);
      run(sim, 3 * 3600);
      return sim.summary().avgWait;
    };
    expect(wait('eta')).toBeLessThan(wait('fcfs'));
  });

  it('even/odd zoning never stops at a floor outside the zone and still delivers inter-floor trips', () => {
    const cfg = scenarioConfig();
    cfg.buildings[0].elevators = ['even', 'even', 'odd', 'odd'].map((served) => ({ ...defaultElevator(), served: served as any }));
    cfg.scenario = {
      cars: [],
      waiting: [
        { floor: 7, dest: 8, count: 2 }, // needs a change of cars in the lobby
        { floor: 0, dest: 13, count: 3 },
        { floor: 20, dest: 4, count: 2 },
      ],
    };
    const sim = new Simulation(cfg, BUILTIN[0]);
    run(sim, 3600, () => sim.pendingCount() === 0);
    const s = sim.summary();
    expect(sim.pendingCount()).toBe(0);
    expect(s.delivered).toBe(7);
    expect(s.transfers).toBe(2);
  });

  it('never carries riders away from their floor to answer a nearer hall call', () => {
    for (const id of ['eta', 'group-nearest', 'look', 'destination', 'peak-aware', 'energy-saver']) {
      const cfg = scenarioConfig();
      cfg.scenario = { cars: [{ floor: 2, riders: [10, 25, 30] }], waiting: [{ floor: 0, dest: 21, count: 1 }] };
      const sim = new Simulation(cfg, BUILTIN.find((a) => a.id === id)!);
      run(sim, 1800, () => sim.pendingCount() === 0);
      expect(sim.pendingCount()).toBe(0);
      expect(sim.summary().wrongWayPct).toBe(0);
    }
  });

  it('sends the idle car, not the busy one, in the two-car version of the down-call example', () => {
    const cfg = scenarioConfig();
    cfg.scenario = { cars: [{ floor: 2, riders: [10, 25, 30] }, { floor: 30, riders: [] }], waiting: [{ floor: 5, dest: 0, count: 1 }] };
    const sim = new Simulation(cfg, BUILTIN.find((a) => a.id === 'eta')!);
    run(sim, 1800, () => sim.pendingCount() === 0);
    expect(sim.summary().maxWait).toBeLessThan(45);
  });

  it('lets you change what a waiting person and a rider want', () => {
    const cfg = scenarioConfig();
    cfg.scenario = { cars: [{ floor: 2, riders: [20] }], waiting: [{ floor: 9, dest: 0, count: 1 }] };
    const sim = new Simulation(cfg, BUILTIN[0]);
    const b = sim.buildings[0];
    const rider = b.cars[0].riders[0];
    const waiter = b.waiting[9][0];
    expect(sim.setDestination(rider.id, 6)).toBe(true);
    expect(sim.setDestination(waiter.id, 15)).toBe(true);
    expect(sim.worldView(b).calls.map((c) => [c.floor, c.direction])).toEqual([[9, 1]]);
    const id = sim.addPassenger(0, 11, 3);
    expect(id).toBeGreaterThan(0);
    expect(sim.removePassenger(id)).toBe(true);
    run(sim, 1800, () => sim.pendingCount() === 0);
    expect(sim.pendingCount()).toBe(0);
    expect(sim.summary().delivered).toBe(2);
  });
});
