export interface Summary {
  delivered: number;
  avgWait: number;
  p95Wait: number;
  maxWait: number;
  avgRide: number;
  avgJourney: number;
  avgTotal: number; // wait + ride + walking to and from the lift
  longWaitPct: number; // share of people who waited more than 60 s
  avgStops: number; // intermediate stops per ride
  avgCrowd: number; // average car fill while riding, 0–1
  wrongWayPct: number; // share of people carried the wrong way first
  transfers: number; // lobby changes forced by zoning
  comfort: number; // 0–100
  energyKWh: number;
  whPerTrip: number;
  starts: number;
  doorCycles: number;
  distanceKm: number;
  utilisation: number; // share of time cars were busy
  waitingNow: number;
  ridingNow: number;
  unserved: number; // trips nobody could serve (floor not covered by any car)
  faults: number; // invalid or failed algorithm decisions
  lastError: string | null;
}

export interface SeriesPoint {
  t: number; // seconds since midnight
  avgWait: number; // people delivered in this bucket
  delivered: number;
  kWh: number;
  waiting: number;
}

export const LONG_WAIT = 60;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Ride-quality score for one person. Each term is a penalty out of the listed points. */
export function comfortScore(wait: number, stops: number, crowd: number, wrongWay: boolean, accel: number): number {
  return (
    100 -
    35 * clamp01((crowd - 0.4) / 0.6) - // packed cars
    30 * clamp01(stops / 8) - // stop-and-go rides
    15 * (wrongWay ? 1 : 0) - // carried away from the destination first
    10 * clamp01((accel - 0.8) / 0.8) - // harsh acceleration
    10 * clamp01(wait / 120) // long waits
  );
}

export class Metrics {
  waits: number[] = [];
  delivered = 0;
  waitSum = 0;
  rideSum = 0;
  journeySum = 0;
  totalSum = 0;
  maxWait = 0;
  longWaits = 0;
  stopsSum = 0;
  crowdSum = 0;
  wrongWay = 0;
  comfortSum = 0;
  transfers = 0;

  record(wait: number, ride: number, stops: number, crowd: number, wrongWay: boolean, accel: number, total: number) {
    this.totalSum += total;
    this.waits.push(wait);
    this.delivered++;
    this.waitSum += wait;
    this.rideSum += ride;
    this.journeySum += wait + ride;
    if (wait > this.maxWait) this.maxWait = wait;
    if (wait > LONG_WAIT) this.longWaits++;
    this.stopsSum += stops;
    this.crowdSum += crowd;
    if (wrongWay) this.wrongWay++;
    this.comfortSum += comfortScore(wait, stops, crowd, wrongWay, accel);
  }
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
