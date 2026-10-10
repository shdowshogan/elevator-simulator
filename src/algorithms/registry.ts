import type { ElevatorAlgorithm } from './api';
import { destinationDispatch, energySaver, etaDispatch, groupNearest, peakAware } from './builtin/group';
import { fcfs, look, nearest, scan } from './builtin/simple';
import { compileAlgorithm, type EditorAlgorithm } from './compile';

export const BUILTIN: ElevatorAlgorithm[] = [
  etaDispatch,
  groupNearest,
  look,
  destinationDispatch,
  peakAware,
  energySaver,
  scan,
  nearest,
  fcfs,
];

// Every file in ./custom that default-exports an algorithm.
const modules = import.meta.glob<{ default?: ElevatorAlgorithm }>('./custom/*.ts', { eager: true });
export const FILE_ALGORITHMS: ElevatorAlgorithm[] = Object.entries(modules).flatMap(([path, mod]) => {
  const algo = mod.default;
  if (!algo || typeof algo.nextStop !== 'function') return [];
  const file = path.split('/').pop()!.replace(/\.ts$/, '');
  return [{ ...algo, id: `file:${file}`, name: algo.name || file }];
});

export interface AlgorithmEntry {
  id: string;
  name: string;
  kind: 'builtin' | 'file' | 'editor';
  algo: ElevatorAlgorithm | null; // null when editor code fails to compile
  error?: string;
}

export function listAlgorithms(editor: EditorAlgorithm[]): AlgorithmEntry[] {
  const out: AlgorithmEntry[] = [
    ...BUILTIN.map((a) => ({ id: a.id!, name: a.name, kind: 'builtin' as const, algo: a })),
    ...FILE_ALGORITHMS.map((a) => ({ id: a.id!, name: a.name, kind: 'file' as const, algo: a })),
  ];
  for (const e of editor) {
    try {
      const algo = compileAlgorithm(e.source, e.id);
      out.push({ id: e.id, name: algo.name, kind: 'editor', algo });
    } catch (err) {
      out.push({ id: e.id, name: e.name, kind: 'editor', algo: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Resolve an id to a runnable algorithm. `source` is the editor code when the id is an editor one. */
export function resolveAlgorithm(id: string, source?: string): ElevatorAlgorithm {
  const found = BUILTIN.find((a) => a.id === id) ?? FILE_ALGORITHMS.find((a) => a.id === id);
  if (found) return found;
  if (source !== undefined) return compileAlgorithm(source, id);
  throw new Error(`Unknown algorithm: ${id}`);
}
