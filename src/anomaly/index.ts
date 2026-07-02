// Anomaly-detection pipeline (spec §6), run on the ISO roughness residual r(x).
// Five stages:
//   1. Signal decomposition  — r = y − w (done in roughness/; passed in here).
//   2. Point-wise Hampel     — rolling median/MAD, robust Z > 3.5.
//   3. Structural windows     — local Rq > 2×global Rq over 50–100 µm windows.
//   4. Zone aggregation       — merge flags ≤20 µm apart into discrete zones.
//   5. Before/after diff       — vs the as-printed reference (computeDelta).
import type {
  AnomalyDelta,
  AnomalyResult,
  AnomalySettings,
  RoughnessResult,
} from '../types';
import { estimateDx, metricsFromResidual } from '../roughness/index';

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Stage 2 — point-wise Hampel identifier. Returns per-sample robust Z. */
function hampelZ(r: number[], win: number): number[] {
  const n = r.length;
  const half = Math.max(1, Math.floor(win / 2));
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const w: number[] = [];
    for (let j = lo; j <= hi; j++) w.push(r[j]);
    w.sort((a, b) => a - b);
    const med = median(w);
    // MAD = median(|x − med|)
    const dev = w.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = median(dev);
    const scale = 1.4826 * mad;
    z[i] = scale > 1e-12 ? Math.abs(r[i] - med) / scale : 0;
  }
  return z;
}

/** Stage 3 — structural window scoring over 50–100 µm windows. */
function structuralFlags(
  r: number[],
  dx: number,
  globalRq: number,
  globalRz: number,
  s: AnomalySettings,
): boolean[] {
  const n = r.length;
  const flags = new Array<boolean>(n).fill(false);
  const rqThresh = s.rqMultiple * globalRq;
  const rzThresh = s.rqMultiple * globalRz;
  // Sample a couple of window lengths across the 50–100 µm band.
  const lengths = uniqueSorted([
    Math.max(3, Math.round(s.windowMin / dx)),
    Math.max(3, Math.round(((s.windowMin + s.windowMax) / 2) / dx)),
    Math.max(3, Math.round(s.windowMax / dx)),
  ]);
  for (const L of lengths) {
    const stride = Math.max(1, Math.floor(L / 2));
    // Rz = mean(top-5) − mean(bottom-5) is only meaningful when the window has
    // clearly more than 5 samples; on coarse scans a ≤5-sample window collapses
    // both extremes to the whole segment (Rz≡0), so gate the Rz criterion.
    const useRz = L >= 10;
    for (let start = 0; start + L <= n; start += stride) {
      const seg = r.slice(start, start + L);
      const { Rq, Rz } = metricsFromResidual(seg);
      if (Rq > rqThresh || (useRz && Rz > rzThresh)) {
        for (let j = start; j < start + L; j++) flags[j] = true;
      }
    }
  }
  return flags;
}

function uniqueSorted(a: number[]): number[] {
  return [...new Set(a)].sort((p, q) => p - q);
}

/**
 * Full detection on one profile's roughness result. `globalRq/Rz` come from the
 * whole-profile roughness metrics (spec: local vs global comparison).
 */
export function detectAnomalies(
  rough: RoughnessResult,
  s: AnomalySettings,
): AnomalyResult {
  const r = rough.residual;
  const x = rough.x;
  const n = r.length;
  const dx = estimateDx(x) || 1;

  // Stage 2
  const z = hampelZ(r, s.hampelWindow);
  const pointFlag = z.map((v) => v > s.hampelZ);

  // Stage 3
  const winFlag = structuralFlags(r, dx, rough.Rq, rough.Rz, s);

  // Combined per-sample flags for plotting.
  const combined = new Array<boolean>(n);
  for (let i = 0; i < n; i++) combined[i] = pointFlag[i] || winFlag[i];

  // Stage 4 — aggregate into zones, merging gaps ≤ mergeGap (µm).
  const gapSamples = Math.max(0, Math.round(s.mergeGap / dx));
  const zones = aggregateZones(combined, pointFlag, winFlag, z, x, gapSamples);

  // Metrics restricted to flagged samples.
  const flaggedResidual: number[] = [];
  for (let i = 0; i < n; i++) if (combined[i]) flaggedResidual.push(r[i]);
  const restricted = flaggedResidual.length
    ? metricsFromResidual(flaggedResidual)
    : { Ra: 0, Rq: 0, Rz: 0 };

  const widths = zones.map((zn) => zn.width);
  return {
    zones,
    zoneCount: zones.length,
    meanWidth: widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0,
    maxWidth: widths.length ? Math.max(...widths) : 0,
    Ra: restricted.Ra,
    Rq: restricted.Rq,
    Rz: restricted.Rz,
    pointFlags: combined,
  };
}

function aggregateZones(
  combined: boolean[],
  pointFlag: boolean[],
  winFlag: boolean[],
  z: number[],
  x: number[],
  gapSamples: number,
): AnomalyResult['zones'] {
  const n = combined.length;
  // Find raw flagged runs.
  type Run = { i0: number; i1: number };
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (combined[i] && start < 0) start = i;
    if ((!combined[i] || i === n - 1) && start >= 0) {
      const end = combined[i] && i === n - 1 ? i : i - 1;
      runs.push({ i0: start, i1: end });
      start = -1;
    }
  }
  // Merge runs whose index gap ≤ gapSamples.
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.i0 - last.i1 <= gapSamples) {
      last.i1 = run.i1;
    } else {
      merged.push({ ...run });
    }
  }
  // Build zone records.
  return merged.map((run) => {
    let peakZ = 0;
    let hasPoint = false;
    let hasWin = false;
    for (let i = run.i0; i <= run.i1; i++) {
      if (z[i] > peakZ) peakZ = z[i];
      if (pointFlag[i]) hasPoint = true;
      if (winFlag[i]) hasWin = true;
    }
    const x0 = x[run.i0];
    const x1 = x[run.i1];
    return {
      x0,
      x1,
      width: x1 - x0,
      peakZ,
      source: hasPoint && hasWin ? 'both' : hasPoint ? 'point' : 'window',
    } as const;
  });
}

/** Stage 5 — before/after differencing vs the reference profile. */
export function computeDelta(
  target: AnomalyResult,
  targetRough: RoughnessResult,
  ref: AnomalyResult,
  refRough: RoughnessResult,
): AnomalyDelta {
  const dZoneCount = target.zoneCount - ref.zoneCount;
  const reduction =
    ref.zoneCount > 0 ? (ref.zoneCount - target.zoneCount) / ref.zoneCount : 0;
  return {
    dZoneCount,
    dMeanWidth: target.meanWidth - ref.meanWidth,
    dRa: targetRough.Ra - refRough.Ra,
    dRq: targetRough.Rq - refRough.Rq,
    dRz: targetRough.Rz - refRough.Rz,
    reduction,
  };
}
