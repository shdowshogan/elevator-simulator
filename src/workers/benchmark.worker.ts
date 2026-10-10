import { resolveAlgorithm } from '../algorithms/registry';
import { Simulation } from '../sim/engine';
import type { Summary } from '../sim/metrics';
import type { SimConfig } from '../sim/types';

export interface BenchJob {
  key: string;
  config: SimConfig;
  algoId: string;
  source?: string; // editor algorithms travel as source code
  params: Record<string, number>;
  hours: number;
}

export type BenchMessage =
  | { key: string; progress: number }
  | { key: string; summary: Summary }
  | { key: string; error: string };

const post = (m: BenchMessage) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<BenchJob>) => {
  const job = e.data;
  try {
    const sim = new Simulation(job.config, resolveAlgorithm(job.algoId, job.source), job.params);
    const total = job.hours * 3600;
    const chunk = 900;
    for (let t = 0; t < total; t += chunk) {
      sim.advance(Math.min(chunk, total - t));
      post({ key: job.key, progress: Math.min(1, (t + chunk) / total) });
    }
    post({ key: job.key, summary: sim.summary() });
  } catch (err) {
    post({ key: job.key, error: err instanceof Error ? err.message : String(err) });
  }
};
