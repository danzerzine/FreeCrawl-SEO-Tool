import type { GscBqPlanView } from './ipc.js';

/**
 * What the BigQuery pull dialog may offer for a plan on screen (B91). Kept apart from the component
 * so the rules run under test: the plan's `coveredDays` / `missingDays` describe the EXPORT (days it
 * holds, days it lacks), not the work left, so the gate looks at the planned parts instead.
 */

/** Days the planned parts would read: what a Pull does. */
export function daysToPull(plan: GscBqPlanView): number {
  return plan.parts.reduce((sum, p) => sum + p.days, 0);
}

export interface PullGate {
  /** The Pull button is enabled. */
  canPull: boolean;
  /** Every exported day in the range is already saved. */
  upToDate: boolean;
  /** Revised days exist: the Rebuild action (reset + pull again) is offered. */
  canRebuild: boolean;
}

/** `reset` is the state of the «drop the saved data» box, which only matters when the plan needs it. */
export function pullGate(plan: GscBqPlanView | null, reset: boolean): PullGate {
  if (!plan) return { canPull: false, upToDate: false, canRebuild: false };
  const hasParts = plan.parts.length > 0;
  return {
    // `canRun` is false whenever the saved data must be reset first, so it cannot gate that case.
    canPull: hasParts && !plan.overCap && (!plan.needsReset || reset),
    upToDate: !hasParts && !plan.needsReset,
    canRebuild: !plan.needsReset && plan.revisedDays.length > 0,
  };
}

/**
 * A plan is single-use (the run consumes it), so a second run, a reset or a rebuild needs a new one;
 * only the first plain Pull runs the plan that is on screen.
 */
export function needsFreshPlan(
  plan: GscBqPlanView,
  o: { recordEmpty: boolean; rebuild: boolean },
): boolean {
  return plan.needsReset || o.rebuild || o.recordEmpty;
}
