import type { SimConfig } from './types';
import { hashSeed, mulberry32, randInt, randNormal, randPoisson } from './rng';

export interface Trip {
  t: number; // seconds since midnight of day 0
  from: number;
  to: number;
  flat: number; // flat index on the origin floor, -1 = arrives from the street
  destFlat: number; // flat index on the destination floor, -1 = leaves the building
}

/** Residents living in each flat, indexed (floor - 1) * flatsPerFloor + flat. Fixed by the seed. */
export function flatPopulation(cfg: SimConfig, bi: number): number[] {
  const b = cfg.buildings[bi];
  const r = mulberry32(hashSeed(cfg.seed, bi, 1001));
  const out: number[] = [];
  for (let i = 0; i < b.floors * b.flatsPerFloor; i++) out.push(randInt(r, b.residentsMin, b.residentsMax));
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Every elevator trip that starts on the given day. Demand depends only on the seed, so every
 * algorithm is tested against exactly the same people.
 */
export function generateDay(cfg: SimConfig, bi: number, day: number): Trip[] {
  const b = cfg.buildings[bi];
  const tc = cfg.traffic;
  const m = tc.demandMultiplier;
  const pop = flatPopulation(cfg, bi);
  const r = mulberry32(hashSeed(cfg.seed, bi, day, 7));
  const base = day * 86400;
  const trips: Trip[] = [];
  const push = (hour: number, from: number, to: number, flat: number, destFlat: number) =>
    trips.push({ t: base + Math.max(0, hour) * 3600, from, to, flat, destFlat });

  for (let floor = 1; floor <= b.floors; floor++) {
    for (let flat = 0; flat < b.flatsPerFloor; flat++) {
      const residents = pop[(floor - 1) * b.flatsPerFloor + flat];
      for (let k = 0; k < residents; k++) {
        // Work or school: the morning down-peak and the evening up-peak.
        if (r() < Math.min(1, tc.workShare * m)) {
          const dep = clamp(randNormal(r, tc.workDepartHour, tc.workDepartSpread), 4.5, 13);
          const dur = Math.max(1.5, randNormal(r, tc.workDurationHours, 1.5));
          push(dep, floor, 0, flat, -1);
          push(dep + dur, 0, floor, -1, flat);
        }
        // Errands and leisure spread over the day, denser in the evening.
        for (let e = randPoisson(r, tc.errandsPerDay * m); e > 0; e--) {
          const dep = r() < 0.6 ? 10 + r() * 8 : 17 + r() * 4.5;
          const dur = 0.3 + r() * 2.7;
          push(dep, floor, 0, flat, -1);
          push(dep + dur, 0, floor, -1, flat);
        }
        // Visiting a neighbour on another floor.
        if (b.floors > 1) {
          for (let e = randPoisson(r, tc.interfloorPerDay * m); e > 0; e--) {
            let other = randInt(r, 1, b.floors - 1);
            if (other >= floor) other++;
            const otherFlat = randInt(r, 0, b.flatsPerFloor - 1);
            const dep = 9 + r() * 13;
            const stay = 0.3 + r() * 1.7;
            push(dep, floor, other, flat, otherFlat);
            push(dep + stay, other, floor, otherFlat, flat);
          }
        }
      }
      // Visitors: quick deliveries through the day, guests mostly in the evening.
      const expected = randInt(r, b.visitorsMin, b.visitorsMax) * m;
      const visitors = Math.floor(expected) + (r() < expected % 1 ? 1 : 0);
      for (let v = 0; v < visitors; v++) {
        let arrive: number;
        let stay: number;
        if (r() < tc.deliveryShare) {
          arrive = 9 + r() * 12;
          stay = (2 + r() * 5) / 60;
        } else {
          arrive = clamp(randNormal(r, 18.5, 2.5), 8, 23);
          stay = 1 + r() * 2.5;
        }
        push(arrive, 0, floor, -1, flat);
        push(arrive + stay, floor, 0, flat, -1);
      }
    }
  }
  trips.sort((a, c) => a.t - c.t);
  return trips;
}

export interface DemandCurve {
  bucketMinutes: number;
  up: number[];
  down: number[];
  inter: number[];
  total: number;
  residents: number;
}

/** Trips per time-of-day bucket for one typical day, summed over all buildings. */
export function demandCurve(cfg: SimConfig, bucketMinutes = 15): DemandCurve {
  const n = Math.round((24 * 60) / bucketMinutes);
  const up = new Array<number>(n).fill(0);
  const down = new Array<number>(n).fill(0);
  const inter = new Array<number>(n).fill(0);
  let total = 0;
  let residents = 0;
  cfg.buildings.forEach((_, bi) => {
    residents += flatPopulation(cfg, bi).reduce((a, c) => a + c, 0);
    for (const t of generateDay(cfg, bi, 0)) {
      const i = Math.floor((t.t % 86400) / (bucketMinutes * 60)) % n;
      if (t.from === 0) up[i]++;
      else if (t.to === 0) down[i]++;
      else inter[i]++;
      total++;
    }
  });
  return { bucketMinutes, up, down, inter, total, residents };
}
