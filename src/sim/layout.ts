import type { BuildingConfig } from './types';

// Floor plan shared by the engine (walking distances) and the renderer (geometry).
// x runs along the facade, z towards the viewer. Flats sit behind z = 0, the open
// corridor in front of it, and the elevator core in the middle of the flat row.

export const FLAT_W = 7;
export const FLAT_D = 8;
export const CORRIDOR_D = 2.8;
export const SHAFT_W = 2.7;
export const SHAFT_D = 2.6;
export const CORE_PAD = 1.0;
export const ENTRANCE_Z = CORRIDOR_D + 11;

export interface Layout {
  width: number;
  height: number;
  x0: number;
  coreX0: number;
  coreX1: number;
  coreCenter: number;
  flatsLeft: number;
  shaftX(i: number): number;
  flatX0(i: number): number;
  flatDoorX(i: number): number;
}

export function layoutOf(b: BuildingConfig): Layout {
  const n = Math.max(1, b.flatsPerFloor);
  const flatsLeft = Math.ceil(n / 2);
  const coreW = Math.max(1, b.elevators.length) * SHAFT_W + 2 * CORE_PAD;
  const width = n * FLAT_W + coreW;
  const x0 = -width / 2;
  const coreX0 = x0 + flatsLeft * FLAT_W;
  const coreX1 = coreX0 + coreW;
  const flatX0 = (i: number) => (i < flatsLeft ? x0 + i * FLAT_W : coreX1 + (i - flatsLeft) * FLAT_W);
  return {
    width,
    height: (b.floors + 1) * b.floorHeight,
    x0,
    coreX0,
    coreX1,
    coreCenter: (coreX0 + coreX1) / 2,
    flatsLeft,
    shaftX: (i) => coreX0 + CORE_PAD + SHAFT_W * (i + 0.5),
    flatX0,
    flatDoorX: (i) => flatX0(i) + FLAT_W / 2,
  };
}

/** Metres walked between a flat door (or the street when flat < 0) and the elevator lobby. */
export function walkDistance(l: Layout, flat: number): number {
  if (flat < 0) return ENTRANCE_Z - 1;
  return Math.abs(l.flatDoorX(flat) - l.coreCenter) + 1.5;
}
