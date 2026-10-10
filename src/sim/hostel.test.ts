import { describe, expect, it } from 'vitest';
import { BUILTIN } from '../algorithms/registry';
import { Simulation } from './engine';
import { hostelPlan } from './hostel';
import { demandCurve } from './traffic';
import { hostel18Config } from './types';

describe('hostel 18', () => {
  it('lays out the requested rooms around six lift lobbies', () => {
    const b = hostel18Config().buildings[0];
    const plan = hostelPlan(b);
    expect(plan.rooms.length).toBe(110);
    expect(plan.lobbies.length).toBe(6);
    expect(plan.shafts.map((s) => s.bank)).toEqual([0, 1, 2, 3, 4, 5]);
    // no two rooms overlap
    for (let i = 0; i < plan.rooms.length; i++) {
      for (let j = i + 1; j < plan.rooms.length; j++) {
        const p = plan.rooms[i];
        const q = plan.rooms[j];
        const apart = Math.abs(p.x - q.x) >= (p.w + q.w) / 2 - 1e-6 || Math.abs(p.z - q.z) >= (p.d + q.d) / 2 - 1e-6;
        expect(apart).toBe(true);
      }
    }
    // every room can reach every lobby, and its nearest lobby is a short walk
    for (let room = 0; room < plan.rooms.length; room++) {
      const walks = [0, 1, 2, 3, 4, 5].map((k) => plan.walk(room, k));
      expect(Math.max(...walks)).toBeLessThan(200);
      expect(Math.min(...walks)).toBeLessThan(45);
    }
    // the front door is at the south-west corner unless moved
    expect(plan.walk(-1, 4)).toBeLessThan(plan.walk(-1, 1));
    const moved = hostelPlan({ ...b, entrance: 1 });
    expect(moved.walk(-1, 1)).toBeLessThan(moved.walk(-1, 4));
    expect(moved.rooms.length).toBe(110);
    for (const count of [40, 80, 150, 240]) {
      expect(hostelPlan({ ...b, flatsPerFloor: count }).rooms.length).toBe(count);
    }
  });

  it('generates a student day with a sharp morning exodus', () => {
    const curve = demandCurve(hostel18Config(), 60);
    expect(curve.residents).toBe(990);
    expect(curve.total).toBeGreaterThan(4000);
    expect(curve.down[8]).toBeGreaterThan(curve.down[10] * 3);
  });

  for (const algo of BUILTIN) {
    for (const choice of ['nearest', 'guided'] as const) {
      it(`${algo.name} runs the morning in Hostel 18 (${choice})`, () => {
        const cfg = hostel18Config();
        cfg.liftChoice = choice;
        if (algo.prefersMode) cfg.callMode = algo.prefersMode;
        const sim = new Simulation(cfg, algo);
        sim.advance(2.5 * 3600);
        const s = sim.summary();
        const b = sim.buildings[0];
        expect(s.faults).toBe(0);
        expect(s.unserved).toBe(0);
        expect(s.delivered).toBeGreaterThan(600);
        for (const c of b.cars) {
          expect(c.riders.length).toBeLessThanOrEqual(c.cfg.capacity);
          expect(c.starts).toBeGreaterThan(0); // every lift gets used
          for (const p of c.riders) expect(p.bank).toBe(c.bank);
        }
        // nobody is left stranded for long once the rush has passed
        expect(s.waitingNow).toBeLessThan(40);
      });
    }
  }

  it('lets you add and re-route people at a specific lobby', () => {
    const cfg = hostel18Config();
    cfg.traffic.enabled = false;
    const sim = new Simulation(cfg, BUILTIN[0]);
    const b = sim.buildings[0];
    const id = sim.addPassenger(0, 6, 0, 3);
    expect(sim.find(id)!.p.bank).toBe(3);
    expect(sim.waitingAt(b, 6).length).toBe(1);
    expect(sim.setDestination(id, 9)).toBe(true);
    sim.advance(300);
    expect(sim.pendingCount()).toBe(0);
    expect(b.cars[3].starts).toBeGreaterThan(0);
    expect(b.cars[0].starts).toBe(0);
  });
});
