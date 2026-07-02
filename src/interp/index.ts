// Interpolation engine: Gaussian-kernel (Nadaraya–Watson) regression in a
// normalized (log2 rpm, feed-per-rev) feature space, run separately per milling
// mode. Reports leave-one-out MAE as the honest uncertainty metric (spec §7).
import type { Dataset, RoughnessResult } from '../types';

export interface FitPoint {
  id: string;
  name: string;
  n: number; // rpm
  fpr: number; // feed per rev, mm
  feedRate: number; // mm/min
  Ra: number;
  Rq: number;
  Rz: number;
  mode: 'down' | 'up';
  /** Normalized feature coordinates. */
  fx: number;
  fy: number;
}

export interface FeatureNorm {
  logMin: number;
  logMax: number;
  fprMin: number;
  fprMax: number;
}

export interface Prediction {
  Ra: number;
  Rq: number;
  Rz: number;
  /** Nearest measured point (for 3D fallback + labeling). */
  nearest: FitPoint | null;
  /** True if the query is at/near a measured point (weight ~1 dominates). */
  onMeasured: boolean;
  /** True if rpm or fpr lies outside the measured range for this mode. */
  extrapolated: boolean;
  /** Sum of kernel weights (low ⇒ far from data). */
  weightSum: number;
  /** Number of same-mode measured points available. */
  count: number;
}

export interface ModeFit {
  mode: 'down' | 'up';
  points: FitPoint[];
  norm: FeatureNorm;
  looMae: number | null;
  meanRa: number;
  /** looMae / meanRa (fractional). */
  looRel: number | null;
}

function roughnessOf(d: Dataset): RoughnessResult | undefined {
  return d.roughness;
}

/** Build fit points for a given mode from measured (non-reference) datasets. */
export function buildFit(
  datasets: Dataset[],
  mode: 'down' | 'up',
  bandwidth: number,
): ModeFit {
  const measured = datasets.filter(
    (d) =>
      d.millingMode === mode &&
      d.spindleSpeed != null &&
      d.feedRate != null &&
      roughnessOf(d),
  );

  const raw = measured.map((d) => {
    const n = d.spindleSpeed as number;
    const feedRate = d.feedRate as number;
    const r = roughnessOf(d)!;
    return {
      id: d.id,
      name: d.name,
      n,
      feedRate,
      fpr: feedRate / n,
      Ra: r.Ra,
      Rq: r.Rq,
      Rz: r.Rz,
      mode,
    };
  });

  const norm = computeNorm(raw);
  const points: FitPoint[] = raw.map((p) => ({
    ...p,
    fx: normLog(p.n, norm),
    fy: normFpr(p.fpr, norm),
  }));

  const meanRa = points.length
    ? points.reduce((a, p) => a + p.Ra, 0) / points.length
    : 0;
  const looMae = leaveOneOutMae(points, bandwidth);

  return {
    mode,
    points,
    norm,
    looMae,
    meanRa,
    looRel: looMae != null && meanRa > 0 ? looMae / meanRa : null,
  };
}

function computeNorm(raw: { n: number; fpr: number }[]): FeatureNorm {
  if (raw.length === 0) {
    return { logMin: 0, logMax: 1, fprMin: 0, fprMax: 1 };
  }
  const logs = raw.map((p) => Math.log2(p.n));
  const fprs = raw.map((p) => p.fpr);
  return {
    logMin: Math.min(...logs),
    logMax: Math.max(...logs),
    fprMin: Math.min(...fprs),
    fprMax: Math.max(...fprs),
  };
}

function normLog(n: number, norm: FeatureNorm): number {
  const span = norm.logMax - norm.logMin || 1;
  return (Math.log2(n) - norm.logMin) / span;
}
function normFpr(fpr: number, norm: FeatureNorm): number {
  const span = norm.fprMax - norm.fprMin || 1;
  return (fpr - norm.fprMin) / span;
}

/** Predict Ra/Rq/Rz at a query point within one mode's fit. */
export function predict(
  fit: ModeFit,
  spindleSpeed: number,
  feedRate: number,
  bandwidth: number,
): Prediction {
  const empty: Prediction = {
    Ra: NaN,
    Rq: NaN,
    Rz: NaN,
    nearest: null,
    onMeasured: false,
    extrapolated: false,
    weightSum: 0,
    count: fit.points.length,
  };
  if (fit.points.length === 0) return empty;
  // Guard nonpositive spindle speed (reachable if the slider min pads to 0):
  // fpr/log2 would be Infinity/-Infinity and the nearest-point fallback would
  // dereference null. Mirror kinematics' n>0 guard and return an empty result.
  if (!(spindleSpeed > 0)) return empty;

  const fpr = feedRate / spindleSpeed;
  const qx = normLog(spindleSpeed, fit.norm);
  const qy = normFpr(fpr, fit.norm);
  const h2 = 2 * bandwidth * bandwidth;

  let wSum = 0;
  let raSum = 0;
  let rqSum = 0;
  let rzSum = 0;
  let nearest: FitPoint | null = null;
  let nearestD2 = Infinity;
  let maxW = 0;

  for (const p of fit.points) {
    const dx = qx - p.fx;
    const dy = qy - p.fy;
    const d2 = dx * dx + dy * dy;
    const w = Math.exp(-d2 / h2);
    wSum += w;
    raSum += w * p.Ra;
    rqSum += w * p.Rq;
    rzSum += w * p.Rz;
    if (w > maxW) maxW = w;
    if (d2 < nearestD2) {
      nearestD2 = d2;
      nearest = p;
    }
  }

  const underflow = wSum < 1e-9;
  const Ra = underflow ? nearest!.Ra : raSum / wSum;
  const Rq = underflow ? nearest!.Rq : rqSum / wSum;
  const Rz = underflow ? nearest!.Rz : rzSum / wSum;

  // Extrapolation: outside the measured rpm or fpr range for this mode.
  const rpmMin = Math.min(...fit.points.map((p) => p.n));
  const rpmMax = Math.max(...fit.points.map((p) => p.n));
  const fprMin = Math.min(...fit.points.map((p) => p.fpr));
  const fprMax = Math.max(...fit.points.map((p) => p.fpr));
  const extrapolated =
    spindleSpeed < rpmMin ||
    spindleSpeed > rpmMax ||
    fpr < fprMin ||
    fpr > fprMax;

  return {
    Ra,
    Rq,
    Rz,
    nearest,
    onMeasured: maxW > 0.985, // essentially coincident with a measured point
    extrapolated,
    weightSum: wSum,
    count: fit.points.length,
  };
}

/** One measured neighbor's normalized contribution to a query point. */
export interface NeighborWeight {
  point: FitPoint;
  /** Kernel weight normalized so the returned set sums to 1. */
  weight: number;
}

/**
 * Top-k measured neighbors of a query point with Gaussian-kernel weights
 * normalized to sum to 1 — the same kernel `predict` uses, exposed so the 3D
 * viewer can blend the neighbors' height fields consistently with the Ra
 * surface. Falls back to the single nearest point (weight 1) if all weights
 * underflow. Returns [] when the mode has no measured points.
 */
export function weightedNeighbors(
  fit: ModeFit,
  spindleSpeed: number,
  feedRate: number,
  bandwidth: number,
  k = 4,
): NeighborWeight[] {
  if (fit.points.length === 0 || !(spindleSpeed > 0)) return [];

  const fpr = feedRate / spindleSpeed;
  const qx = normLog(spindleSpeed, fit.norm);
  const qy = normFpr(fpr, fit.norm);
  const h2 = 2 * bandwidth * bandwidth;

  const scored = fit.points.map((point) => {
    const dx = qx - point.fx;
    const dy = qy - point.fy;
    const w = Math.exp(-(dx * dx + dy * dy) / h2);
    return { point, w };
  });
  scored.sort((a, b) => b.w - a.w);

  const top = scored.slice(0, Math.max(1, Math.min(k, scored.length)));
  let wSum = 0;
  for (const s of top) wSum += s.w;
  // All weights underflowed ⇒ snap to the single nearest neighbor.
  if (wSum < 1e-12) return [{ point: top[0].point, weight: 1 }];
  return top.map((s) => ({ point: s.point, weight: s.w / wSum }));
}

/** Leave-one-out MAE on Ra (null if fewer than 2 points). */
function leaveOneOutMae(points: FitPoint[], bandwidth: number): number | null {
  if (points.length < 2) return null;
  const h2 = 2 * bandwidth * bandwidth;
  let errSum = 0;
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    const target = points[i];
    let wSum = 0;
    let raSum = 0;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const p = points[j];
      const dx = target.fx - p.fx;
      const dy = target.fy - p.fy;
      const d2 = dx * dx + dy * dy;
      const w = Math.exp(-d2 / h2);
      wSum += w;
      raSum += w * p.Ra;
    }
    // Skip points whose leave-one-out weights underflow; they contribute no
    // error estimate, so they must not inflate the divisor either.
    if (wSum < 1e-9) continue;
    errSum += Math.abs(raSum / wSum - target.Ra);
    count += 1;
  }
  return count > 0 ? errSum / count : null;
}

/** Global smoothest measured point across both modes (for ★ / Jump). */
export function smoothestPoint(datasets: Dataset[]): Dataset | null {
  let best: Dataset | null = null;
  let bestRa = Infinity;
  for (const d of datasets) {
    if (d.millingMode === 'reference') continue;
    if (d.spindleSpeed == null || d.feedRate == null) continue;
    const ra = d.roughness?.Ra;
    if (ra == null) continue;
    if (ra < bestRa) {
      bestRa = ra;
      best = d;
    }
  }
  return best;
}

/** Nearest measured dataset (same mode) to a working point — for 3D fallback. */
export function nearestDataset(
  datasets: Dataset[],
  fit: ModeFit,
  spindleSpeed: number,
  feedRate: number,
): Dataset | null {
  const pred = predict(fit, spindleSpeed, feedRate, 0.16);
  if (!pred.nearest) return null;
  return datasets.find((d) => d.id === pred.nearest!.id) ?? null;
}
