import type { BenchJob, BenchMessage } from '../workers/benchmark.worker';

/**
 * Run headless simulations on a small pool of background workers.
 * Returns a function that stops everything still running.
 */
export function runBench(jobs: BenchJob[], onMessage: (m: BenchMessage) => void, onDone: () => void): () => void {
  const workers: Worker[] = [];
  let next = 0;
  let finished = 0;
  const stop = () => workers.splice(0).forEach((w) => w.terminate());
  if (!jobs.length) {
    onDone();
    return stop;
  }
  const size = Math.max(1, Math.min(jobs.length, (navigator.hardwareConcurrency || 4) - 1, 6));
  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('../workers/benchmark.worker.ts', import.meta.url), { type: 'module' });
    workers.push(w);
    w.onmessage = (e: MessageEvent<BenchMessage>) => {
      onMessage(e.data);
      if ('progress' in e.data) return;
      if (++finished === jobs.length) {
        stop();
        onDone();
      } else if (next < jobs.length) w.postMessage(jobs[next++]);
    };
    if (next < jobs.length) w.postMessage(jobs[next++]);
  }
  return stop;
}
