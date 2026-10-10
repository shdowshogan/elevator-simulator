import { hostelPlan } from './hostel';
import { layoutOf, towerPlan, type Plan } from './layout';
import type { BuildingConfig } from './types';

export function planOf(b: BuildingConfig): Plan {
  return b.plan === 'hostel18' ? hostelPlan(b) : towerPlan(layoutOf(b));
}
