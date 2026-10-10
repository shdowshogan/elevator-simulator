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
  const stairs = tc.stairsFloors ?? 0;
  const push = (hour: number, from: number, to: number, flat: number, destFlat: number) => {
    if (Math.abs(to - from) <= stairs) return; // short hops take the stairs
    trips.push({ t: base + Math.max(0, hour) * 3600, from, to, flat, destFlat });
  };

  if (tc.profile === 'hostel') {
    hostelDay(cfg, bi, r, pop, push);
    trips.sort((a, c) => a.t - c.t);
    return trips;
  }

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

/**
 * A student hostel's day: out to morning classes, back for lunch, out again for the afternoon,
 * then outings, visits to friends on other floors and food deliveries late into the night.
 */
function hostelDay(
  cfg: SimConfig,
  bi: number,
  r: () => number,
  pop: number[],
  push: (hour: number, from: number, to: number, flat: number, destFlat: number) => void,
) {
  const b = cfg.buildings[bi];
  const tc = cfg.traffic;
  const m = tc.demandMultiplier;
  for (let floor = 1; floor <= b.floors; floor++) {
    for (let room = 0; room < b.flatsPerFloor; room++) {
      const students = pop[(floor - 1) * b.flatsPerFloor + room];
      for (let k = 0; k < students; k++) {
        const classes = r() < Math.min(1, tc.workShare * m);
        if (classes) {
          const dep = clamp(randNormal(r, tc.workDepartHour, tc.workDepartSpread), 6, 11.5);
          const back = Math.max(dep + 1, dep + randNormal(r, tc.workDurationHours, 0.5));
          push(dep, floor, 0, room, -1);
          push(back, 0, floor, -1, room);
          if (r() < 0.7) {
            // afternoon labs and lectures
            const out = Math.max(back + 0.3, randNormal(r, 14, 0.35));
            push(out, floor, 0, room, -1);
            push(Math.max(out + 1, randNormal(r, 17.6, 0.7)), 0, floor, -1, room);
          }
        }
        for (let e = randPoisson(r, tc.errandsPerDay * m); e > 0; e--) {
          const dep = r() < 0.75 ? 18 + r() * 5.5 : 10 + r() * 8; // mostly evenings and nights
          push(dep, floor, 0, room, -1);
          push(dep + 0.4 + r() * 2.2, 0, floor, -1, room);
        }
        if (b.floors > 1) {
          for (let e = randPoisson(r, tc.interfloorPerDay * m); e > 0; e--) {
            let other = randInt(r, 1, b.floors - 1);
            if (other >= floor) other++;
            const otherRoom = randInt(r, 0, b.flatsPerFloor - 1);
            const dep = 14 + r() * 11; // afternoon to past midnight
            push(dep, floor, other, room, otherRoom);
            push(dep + 0.3 + r() * 2, other, floor, otherRoom, room);
          }
        }
      }
      const expected = randInt(r, b.visitorsMin, b.visitorsMax) * m;
      const visitors = Math.floor(expected) + (r() < expected % 1 ? 1 : 0);
      for (let v = 0; v < visitors; v++) {
        const delivery = r() < tc.deliveryShare;
        const arrive = delivery ? (r() < 0.7 ? 19 + r() * 5 : 12 + r() * 3) : 10 + r() * 11;
        const stay = delivery ? (2 + r() * 4) / 60 : 0.5 + r() * 2;
        push(arrive, 0, floor, -1, room);
        push(arrive + stay, floor, 0, room, -1);
      }
    }
  }
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
