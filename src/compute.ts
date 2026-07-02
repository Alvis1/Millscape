// Orchestration: derive kinematics, and recompute roughness + anomalies +
// before/after deltas for every dataset whenever data or settings change.
import type { Dataset, Kinematics, Settings } from './types';
import { computeRoughness } from './roughness/index';
import { computeDelta, detectAnomalies } from './anomaly/index';

/** Derived kinematics for a working point (never asked of the user). */
export function kinematics(
  spindleSpeed: number,
  feedRate: number,
  settings: Settings,
): Kinematics {
  const D = settings.toolDiameter; // mm
  const z = settings.effectiveTeeth;
  const n = spindleSpeed;
  const vf = feedRate;
  const vc = (Math.PI * D * n) / 1000; // m/min
  const fpr = n > 0 ? vf / n : 0; // mm
  const fz = n > 0 ? vf / (n * z) : 0; // mm
  // Cusp-height floor h ≈ fz²/(8·(D/2)), converted to µm (fz, D in mm).
  const cuspFloorMm = (fz * fz) / (8 * (D / 2));
  return { vc, fpr, fz, cuspFloor: cuspFloorMm * 1000 };
}

/** Recompute roughness + anomalies for all datasets, then deltas vs reference. */
export function recomputeAll(datasets: Dataset[], settings: Settings): void {
  for (const d of datasets) {
    d.roughness = computeRoughness(d.profile, settings);
    d.anomaly = detectAnomalies(d.roughness, settings.anomaly);
  }
  const ref = datasets.find((d) => d.millingMode === 'reference');
  for (const d of datasets) {
    if (ref && d.id !== ref.id && d.roughness && d.anomaly && ref.roughness && ref.anomaly) {
      d.delta = computeDelta(d.anomaly, d.roughness, ref.anomaly, ref.roughness);
    } else {
      delete d.delta;
    }
  }
}
