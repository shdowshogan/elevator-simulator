import { it } from 'vitest';
import { BUILTIN } from '../algorithms/registry';
import { Simulation } from './engine';
import { defaultConfig } from './types';

// Prints a full-day comparison table. Run with: npx vitest run bench --reporter=verbose
it('full-day comparison (informational)', () => {
  const rows: Record<string, unknown>[] = [];
  for (const algo of BUILTIN) {
    const cfg = defaultConfig();
    cfg.startHour = 0;
    if (algo.prefersMode) cfg.callMode = algo.prefersMode;
    const t0 = performance.now();
    const sim = new Simulation(cfg, algo);
    sim.advance(24 * 3600);
    const s = sim.summary();
    rows.push({
      algorithm: algo.name,
      delivered: s.delivered,
      avgWait: +s.avgWait.toFixed(1),
      p95: +s.p95Wait.toFixed(0),
      max: +s.maxWait.toFixed(0),
      journey: +s.avgJourney.toFixed(1),
      kWh: +s.energyKWh.toFixed(1),
      comfort: +s.comfort.toFixed(1),
      stops: +s.avgStops.toFixed(2),
      left: s.waitingNow + s.ridingNow,
      faults: s.faults,
      ms: Math.round(performance.now() - t0),
    });
  }
  console.table(rows);
}, 120000);
