import type { Plan } from './layout';
import type { BuildingConfig } from './types';

// Floor plan of Hostel 18: two long wings joined by three cross-blocks, enclosing two courtyards
// (a figure 8 seen from above). Corridors run down the middle of every block with rooms on both
// sides. A lift lobby sits at each of the six places where a cross-block meets a wing.
//
// Axes: x runs south (+) to north (-), z runs east (-) to west (+, towards the default camera).

export const ROOM_W = 3.2;
export const ROOM_D = 4.6;
export const CORRIDOR_W = 2.4;
export const BLOCK_HALF = ROOM_D + CORRIDOR_W / 2; // half the depth of a wing or cross-block
const A = 17; // wing corridor centre lines at z = ±A
const LOBBY_Z = A - BLOCK_HALF - ROOM_W / 2; // lift lobbies stand at z = ±LOBBY_Z on the cross corridors
const WING_OVERHANG = BLOCK_HALF + ROOM_W; // how far the wings run past the end cross-blocks
const STREET = 12; // metres from the front door out to the road

export const LOBBY_NAMES = ['NW', 'NE', 'W', 'E', 'SW', 'SE'];
export const LOBBY_TITLES = ['North-west', 'North-east', 'West', 'East', 'South-west', 'South-east'];

export interface Rect {
  x: number;
  z: number;
  w: number; // extent along x
  d: number; // extent along z
}

export interface HostelRoom extends Rect {
  doorX: number; // where the door meets the corridor edge
  doorZ: number;
  cx: number; // nearest point on the corridor centre line
  cz: number;
  u: number; // corridor graph: the room sits between nodes u and v, tu metres from u
  v: number; // -1 when the corridor is a dead end beyond u
  tu: number;
}

export interface Path {
  pts: number[]; // x0, z0, x1, z1, …
  cum: number[]; // distance walked on reaching each point
  len: number;
}

export interface Shaft {
  bank: number;
  x: number; // centre of the shaft
  z: number;
  doorX: number; // door centre, on the corridor edge
  doorZ: number;
}

export interface HostelPlan extends Plan {
  kind: 'hostel18';
  length: number; // along x
  depth: number; // along z
  blocks: Rect[]; // floor slabs
  corridors: Rect[];
  courtyards: Rect[];
  rooms: HostelRoom[];
  lobbies: { x: number; z: number }[];
  shafts: Shaft[]; // one per elevator, same order as the building's elevator list
  entrance: { x: number; z: number };
  street: { x: number; z: number };
  /** Walking route between a room (or the street when room < 0) and a lift lobby. */
  path(room: number, bank: number): Path;
  /** Walking route from one lift lobby to another. */
  lobbyPath(from: number, to: number): Path;
}

/** Point `dist` metres along a path. */
export function samplePath(p: Path, dist: number): [number, number] {
  const n = p.cum.length;
  if (dist <= 0 || n === 1) return [p.pts[0], p.pts[1]];
  if (dist >= p.len) return [p.pts[n * 2 - 2], p.pts[n * 2 - 1]];
  let i = 1;
  while (p.cum[i] < dist) i++;
  const span = p.cum[i] - p.cum[i - 1] || 1;
  const t = (dist - p.cum[i - 1]) / span;
  return [p.pts[i * 2 - 2] + (p.pts[i * 2] - p.pts[i * 2 - 2]) * t, p.pts[i * 2 - 1] + (p.pts[i * 2 + 1] - p.pts[i * 2 - 1]) * t];
}

function makePath(points: [number, number][]): Path {
  const pts: number[] = [];
  const cum: number[] = [];
  let len = 0;
  points.forEach(([x, z], i) => {
    if (i > 0) len += Math.hypot(x - points[i - 1][0], z - points[i - 1][1]);
    pts.push(x, z);
    cum.push(len);
  });
  return { pts, cum, len };
}

export function hostelPlan(b: BuildingConfig): HostelPlan {
  const want = Math.max(1, b.flatsPerFloor);
  const bankOf = b.elevators.map((e) => Math.min(5, Math.max(0, Math.round(e.bank ?? 0))));
  // The front door opens onto one of the six junctions (south-west unless set otherwise).
  const doorAt = Math.min(5, Math.max(0, Math.round(b.entrance ?? 4)));
  const doorSide = doorAt % 2 === 0 ? 1 : -1;
  const doorX = (half: number) => [-half, 0, half][doorAt >> 1];

  // Cross-block rooms: seven slots a side along each cross corridor, minus the slots the shafts take.
  const barSlots = Math.floor((2 * LOBBY_Z + ROOM_W) / ROOM_W + 1e-6);
  const barZ = (i: number) => -LOBBY_Z + i * ROOM_W;
  const barCount = 3 * 2 * barSlots - b.elevators.length;

  // Wings: grow the building until the rooms fit. Outer rows are unbroken; inner rows are
  // interrupted where the three cross-blocks join.
  const innerBlocked = (x: number, xb: number) => [-xb, 0, xb].some((bx) => Math.abs(x - bx) < BLOCK_HALF + ROOM_W / 2 - 0.01);
  let length = 0;
  let xb = 0;
  let rowX: number[] = [];
  for (let n = 15; n < 400; n++) {
    length = n * ROOM_W;
    xb = length / 2 - WING_OVERHANG;
    rowX = Array.from({ length: n }, (_, i) => -length / 2 + ROOM_W / 2 + i * ROOM_W);
    const inner = rowX.filter((x) => !innerBlocked(x, xb)).length;
    const frontDoor = rowX.filter((x) => Math.abs(x - doorX(xb)) < ROOM_W).length;
    if (2 * n - frontDoor + 2 * inner + barCount >= want) break;
  }
  const bars = [-xb, 0, xb];

  // Corridor graph. Nodes 0–5 are the junctions, 6–11 the lift lobbies, in lobby order
  // (NW, NE, W, E, SW, SE): cross-block k = floor(i / 2), west (z > 0) when i is even.
  const side = (i: number) => (i % 2 === 0 ? 1 : -1);
  const nodes: [number, number][] = [];
  for (let i = 0; i < 6; i++) nodes.push([bars[i >> 1], side(i) * A]);
  for (let i = 0; i < 6; i++) nodes.push([bars[i >> 1], side(i) * LOBBY_Z]);
  const N = nodes.length;
  const dist = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 0 : Infinity)));
  const next = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? i : -1)));
  const link = (i: number, j: number) => {
    const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
    dist[i][j] = dist[j][i] = d;
    next[i][j] = j;
    next[j][i] = i;
  };
  for (let i = 0; i < 6; i++) link(i, 6 + i); // junction to its lobby
  for (let k = 0; k < 3; k++) link(6 + 2 * k, 7 + 2 * k); // along each cross corridor
  for (let i = 0; i < 4; i++) link(i, i + 2); // along the wings
  for (let m = 0; m < N; m++)
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        if (dist[i][m] + dist[m][j] < dist[i][j] - 1e-9) {
          dist[i][j] = dist[i][m] + dist[m][j];
          next[i][j] = next[i][m];
        }

  // Shafts take the cross-block slots nearest each junction, on the south side of the corridor.
  const shafts: Shaft[] = [];
  const taken = new Set<string>();
  const seen = [0, 0, 0, 0, 0, 0];
  for (const bank of bankOf) {
    const k = bank >> 1;
    const s = side(bank);
    const slot = s > 0 ? barSlots - 1 - seen[bank] : seen[bank];
    seen[bank]++;
    taken.add(`${k}:${slot}`);
    const z = barZ(Math.min(barSlots - 1, Math.max(0, slot)));
    shafts.push({ bank, x: bars[k] + CORRIDOR_W / 2 + 1.5, z, doorX: bars[k] + CORRIDOR_W / 2, doorZ: z });
  }

  const rooms: (HostelRoom & { edge: number })[] = [];
  // cross-block rooms
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < barSlots; i++) {
      for (const dx of [1, -1]) {
        if (dx > 0 && taken.has(`${k}:${i}`)) continue;
        const z = barZ(i);
        rooms.push({
          x: bars[k] + dx * (CORRIDOR_W / 2 + ROOM_D / 2), z, w: ROOM_D, d: ROOM_W,
          doorX: bars[k] + (dx * CORRIDOR_W) / 2, doorZ: z, cx: bars[k], cz: z,
          u: 6 + 2 * k, v: 7 + 2 * k, tu: LOBBY_Z - z, edge: 0,
        });
      }
    }
  }
  // wing rooms: edge = distance from the middle, so surplus slots are trimmed from the far ends
  for (const s of [1, -1]) {
    for (const outer of [true, false]) {
      for (const x of rowX) {
        if (!outer && innerBlocked(x, xb)) continue;
        if (outer && s === doorSide && Math.abs(x - doorX(xb)) < ROOM_W) continue; // the front door
        const dz = (outer ? 1 : -1) * s;
        const j = (k: number) => 2 * k + (s > 0 ? 0 : 1);
        let u: number, v: number, tu: number;
        if (x <= -xb) { u = j(0); v = -1; tu = -xb - x; }
        else if (x >= xb) { u = j(2); v = -1; tu = x - xb; }
        else if (x < 0) { u = j(0); v = j(1); tu = x + xb; }
        else { u = j(1); v = j(2); tu = x; }
        rooms.push({
          x, z: s * A + dz * (CORRIDOR_W / 2 + ROOM_D / 2), w: ROOM_W, d: ROOM_D,
          doorX: x, doorZ: s * A + (dz * CORRIDOR_W) / 2, cx: x, cz: s * A,
          u, v, tu, edge: Math.abs(x) + (outer ? 0 : 1000),
        });
      }
    }
  }
  // Trim to the requested room count, dropping outer-wing rooms furthest from the middle first.
  if (rooms.length > want) {
    const order = rooms.map((r, i) => ({ i, key: r.edge })).sort((p, q) => q.key - p.key);
    const drop = new Set<number>();
    for (const o of order) {
      if (rooms.length - drop.size <= want) break;
      if (o.key > 0 && o.key < 1000) drop.add(o.i);
    }
    for (const o of order) {
      if (rooms.length - drop.size <= want) break;
      drop.add(o.i);
    }
    for (let i = rooms.length - 1; i >= 0; i--) if (drop.has(i)) rooms.splice(i, 1);
  }

  const entrance = { x: doorX(xb), z: doorSide * (A + BLOCK_HALF) };
  const street = { x: doorX(xb), z: doorSide * (A + BLOCK_HALF + STREET) };
  const lobbies = Array.from({ length: 6 }, (_, i) => ({ x: nodes[6 + i][0], z: nodes[6 + i][1] }));

  const chain = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [nodes[from]];
    for (let at = from; at !== to; ) {
      at = next[at][to];
      out.push(nodes[at]);
    }
    return out;
  };
  const cache = new Map<number, Path>();
  const path = (room: number, bank: number): Path => {
    const key = (room < 0 ? rooms.length : room) * 8 + bank;
    let p = cache.get(key);
    if (p) return p;
    const lobby = 6 + bank;
    if (room < 0) {
      p = makePath([[street.x, street.z], [entrance.x, entrance.z], ...chain(doorAt, lobby)]); // in through the front door's junction
    } else {
      const r = rooms[Math.min(room, rooms.length - 1)];
      const viaU = r.tu + dist[r.u][lobby];
      const viaV = r.v < 0 ? Infinity : dist[r.u][r.v] - r.tu + dist[r.v][lobby];
      p = makePath([[r.doorX, r.doorZ], [r.cx, r.cz], ...chain(viaU <= viaV ? r.u : r.v, lobby)]);
    }
    cache.set(key, p);
    return p;
  };

  const depth = 2 * (A + BLOCK_HALF);
  const yard = xb - 2 * BLOCK_HALF;
  return {
    kind: 'hostel18',
    banks: 6,
    bankNames: LOBBY_NAMES,
    walk: (room, bank) => (room < -1 ? 0 : path(room, bank).len),
    between: (a, c) => dist[6 + a][6 + c],
    length,
    depth,
    blocks: [
      { x: 0, z: A, w: length, d: 2 * BLOCK_HALF },
      { x: 0, z: -A, w: length, d: 2 * BLOCK_HALF },
      ...bars.map((x) => ({ x, z: 0, w: 2 * BLOCK_HALF, d: 2 * (A - BLOCK_HALF) })),
    ],
    corridors: [
      { x: 0, z: A, w: length, d: CORRIDOR_W },
      { x: 0, z: -A, w: length, d: CORRIDOR_W },
      ...bars.map((x) => ({ x, z: 0, w: CORRIDOR_W, d: 2 * A })),
    ],
    courtyards: [-1, 1].map((sx) => ({ x: (sx * xb) / 2, z: 0, w: yard, d: 2 * (A - BLOCK_HALF) })),
    rooms,
    lobbies,
    shafts,
    entrance,
    street,
    path,
    lobbyPath: (from, to) => makePath(chain(6 + from, 6 + to)),
  };
}
