// Roughness per ISO 16610-21 (Gaussian profile filter). All maths in µm.
//
//   waviness w = Gaussian-filtered profile      (the mean line)
//   roughness residual r = y − w
//   Ra = mean(|r|), Rq = √mean(r²), Rz = mean(top-5) − mean(bottom-5)
//
// The ISO Gaussian weighting has σ = 0.18738·λc  (α = √(ln2/π),
// σ = αλc/√(2π)). We convolve with a ±4σ kernel and reflect-padded ends.
import type { Profile, RoughnessResult, Settings } from '../types';

/** Reflect an out-of-range index back into [0, n) (mirror, edge not repeated). */
function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  let j = i;
  // Fold repeatedly for indices far outside the range.
  while (j < 0 || j >= n) {
    if (j < 0) j = -j;
    if (j >= n) j = 2 * (n - 1) - j;
  }
  return j;
}

/** ISO Gaussian σ in samples for a given λc and sample spacing (both µm). */
export function gaussianSigmaSamples(lambdaC: number, dx: number): number {
  return (0.18738 * lambdaC) / dx;
}

/** Build a normalized 1-D Gaussian kernel with half-width ⌈4σ⌉. */
function gaussianKernel(sigma: number): number[] {
  const half = Math.max(1, Math.ceil(4 * sigma));
  const k: number[] = new Array(2 * half + 1);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let sum = 0;
  for (let t = -half; t <= half; t++) {
    const v = Math.exp(-(t * t) * inv2s2);
    k[t + half] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable 1-D convolution with reflect padding. */
function convolveReflect(y: number[], kernel: number[]): number[] {
  const n = y.length;
  const half = (kernel.length - 1) / 2;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let t = -half; t <= half; t++) {
      acc += kernel[t + half] * y[reflect(i + t, n)];
    }
    out[i] = acc;
  }
  return out;
}

/** Odd-window moving average (Gaussian-equivalent alternate per the paper). */
function movingAverage(y: number[], win: number): number[] {
  const n = y.length;
  const half = Math.floor(win / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let t = -half; t <= half; t++) acc += y[reflect(i + t, n)];
    out[i] = acc / (2 * half + 1);
  }
  return out;
}

/** Least-squares linear fit → returns the fitted line sampled at each index. */
function linearTrend(x: number[], y: number[]): number[] {
  const n = x.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx || 1;
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  return x.map((xi) => a * xi + b);
}

function mean(a: number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}

/** Mean of the k largest (top) or k smallest (bottom) values. */
function extremeMean(a: number[], k: number, top: boolean): number {
  const sorted = [...a].sort((p, q) => (top ? q - p : p - q));
  const slice = sorted.slice(0, Math.min(k, sorted.length));
  return mean(slice);
}

export interface RoughnessMetrics {
  Ra: number;
  Rq: number;
  Rz: number;
}

/** Compute Ra/Rq/Rz on an already-residual array (mean-subtracted inside). */
export function metricsFromResidual(r: number[]): RoughnessMetrics {
  const m = mean(r);
  const c = r.map((v) => v - m);
  let absSum = 0;
  let sqSum = 0;
  for (const v of c) {
    absSum += Math.abs(v);
    sqSum += v * v;
  }
  const Ra = c.length ? absSum / c.length : 0;
  const Rq = c.length ? Math.sqrt(sqSum / c.length) : 0;
  const Rz = extremeMean(c, 5, true) - extremeMean(c, 5, false);
  return { Ra, Rq, Rz };
}

/**
 * Full roughness computation for a profile. Uniform dx is assumed (spec §4/§5).
 * Returns the trimmed, mean-subtracted residual plus Ra/Rq/Rz and the waviness.
 */
export function computeRoughness(profile: Profile, settings: Settings): RoughnessResult {
  const { x, y } = profile;
  const n = y.length;
  const lambdaC = settings.lambdaC;

  // Estimate dx (µm) from the median spacing; fall back to 1 µm.
  const dx = estimateDx(x);

  let waviness: number[];
  if (settings.roughnessMethod === 'linearDetrend') {
    waviness = linearTrend(x, y);
  } else if (settings.roughnessMethod === 'movingAverage') {
    const win = Math.max(3, 2 * Math.round(lambdaC / (2 * dx)) + 1); // ~201 for 200µm
    waviness = movingAverage(y, win);
  } else {
    const sigma = gaussianSigmaSamples(lambdaC, dx);
    waviness = convolveReflect(y, gaussianKernel(sigma));
  }

  const residualFull = new Array<number>(n);
  for (let i = 0; i < n; i++) residualFull[i] = y[i] - waviness[i];

  // Trim λc/2 from each end (Gaussian/MA only). Linear detrend keeps full length.
  const trim =
    settings.roughnessMethod === 'linearDetrend'
      ? 0
      : Math.min(Math.floor(n / 3), Math.round(lambdaC / (2 * dx)));
  const lo = trim;
  const hi = n - trim;

  const rTrim = residualFull.slice(lo, hi);
  const xTrim = x.slice(lo, hi);
  const wTrim = waviness.slice(lo, hi);

  // Mean-subtract for reporting.
  const m = mean(rTrim);
  const rCentered = rTrim.map((v) => v - m);

  const { Ra, Rq, Rz } = metricsFromResidual(rCentered);
  const evalLength = xTrim.length > 1 ? xTrim[xTrim.length - 1] - xTrim[0] : 0;

  return {
    Ra,
    Rq,
    Rz,
    residual: rCentered,
    x: xTrim,
    waviness: wTrim,
    evalLength,
    shortEval: evalLength < 5 * lambdaC,
  };
}

/** Median sample spacing (µm). Robust to a few irregular steps. */
export function estimateDx(x: number[]): number {
  if (x.length < 2) return 1;
  const diffs: number[] = [];
  for (let i = 1; i < x.length; i++) diffs.push(x[i] - x[i - 1]);
  diffs.sort((a, b) => a - b);
  const mid = diffs[Math.floor(diffs.length / 2)];
  return mid > 0 ? mid : 1;
}
