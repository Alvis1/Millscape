// Embedded example dataset (spec §15): parts 1–5 (up + down traces) plus the
// as-printed reference F1. The study reports only scalar Ra/Rq/Rz, but the 3D
// viewer and the anomaly detector need real profiles — so we SYNTHESIZE a
// faithful 1-D line scan for each condition, scaled so the pipeline's *computed*
// Ra reproduces the reported value. This keeps the whole app honest: every
// number in the UI is computed from a profile, not hard-coded.
import type { Dataset, MillingMode, Profile, Settings } from '../types';
import { computeRoughness } from '../roughness/index';
import { makeId } from '../store/index';

interface Seed {
  name: string;
  part: number;
  spindleSpeed: number | null;
  feedRate: number | null;
  millingMode: MillingMode;
  Ra: number;
  Rq: number;
  Rz: number;
}

// Reported values from the source study (spec §15).
export const SEEDS: Seed[] = [
  { name: 'AD1', part: 1, spindleSpeed: 320, feedRate: 64, millingMode: 'down', Ra: 0.16, Rq: 0.2, Rz: 1.55 },
  { name: 'AU1', part: 1, spindleSpeed: 320, feedRate: 64, millingMode: 'up', Ra: 0.46, Rq: 0.56, Rz: 3.52 },
  { name: 'AD2', part: 1, spindleSpeed: 320, feedRate: 128, millingMode: 'down', Ra: 0.45, Rq: 0.57, Rz: 4.1 },
  { name: 'AU2', part: 1, spindleSpeed: 320, feedRate: 128, millingMode: 'up', Ra: 0.9, Rq: 1.14, Rz: 9.19 },
  { name: 'BD1', part: 2, spindleSpeed: 320, feedRate: 192, millingMode: 'down', Ra: 0.37, Rq: 0.47, Rz: 3.3 },
  { name: 'BU1', part: 2, spindleSpeed: 320, feedRate: 192, millingMode: 'up', Ra: 0.96, Rq: 1.21, Rz: 8.73 },
  { name: 'BD2', part: 2, spindleSpeed: 800, feedRate: 160, millingMode: 'down', Ra: 0.37, Rq: 0.46, Rz: 2.93 },
  { name: 'BU2', part: 2, spindleSpeed: 800, feedRate: 160, millingMode: 'up', Ra: 1.1, Rq: 1.39, Rz: 9.94 },
  { name: 'CD1', part: 3, spindleSpeed: 800, feedRate: 320, millingMode: 'down', Ra: 0.72, Rq: 0.9, Rz: 5.41 },
  { name: 'CU1', part: 3, spindleSpeed: 800, feedRate: 320, millingMode: 'up', Ra: 1.13, Rq: 1.44, Rz: 10.59 },
  { name: 'CD2', part: 3, spindleSpeed: 800, feedRate: 480, millingMode: 'down', Ra: 1.04, Rq: 1.32, Rz: 9.02 },
  { name: 'CU2', part: 3, spindleSpeed: 800, feedRate: 480, millingMode: 'up', Ra: 0.28, Rq: 0.35, Rz: 2.42 },
  { name: 'DD1', part: 4, spindleSpeed: 1600, feedRate: 320, millingMode: 'down', Ra: 1.74, Rq: 2.18, Rz: 15.17 },
  { name: 'DU1', part: 4, spindleSpeed: 1600, feedRate: 320, millingMode: 'up', Ra: 0.27, Rq: 0.35, Rz: 2.45 },
  { name: 'DD2', part: 4, spindleSpeed: 1600, feedRate: 640, millingMode: 'down', Ra: 0.97, Rq: 1.21, Rz: 8.28 },
  { name: 'DU2', part: 4, spindleSpeed: 1600, feedRate: 640, millingMode: 'up', Ra: 1.48, Rq: 1.85, Rz: 13.15 },
  { name: 'ED1', part: 5, spindleSpeed: 1600, feedRate: 960, millingMode: 'down', Ra: 0.39, Rq: 0.49, Rz: 3.39 },
  { name: 'EU1', part: 5, spindleSpeed: 1600, feedRate: 960, millingMode: 'up', Ra: 1.3, Rq: 1.63, Rz: 11.21 },
  { name: 'F1', part: 0, spindleSpeed: null, feedRate: null, millingMode: 'reference', Ra: 0.28, Rq: 0.35, Rz: 2.31 },
];

// Deterministic PRNG (mulberry32) so the example set is identical every load.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Box–Muller normal from a uniform generator. */
function makeGaussian(rng: () => number): () => number {
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

const N_POINTS = 8001; // 1 µm sampling over an 8 mm scan (spec §2)
const DX = 1; // µm

/** Gaussian smoothing (reflect-padded) to band-limit white noise. */
function smooth1d(a: number[], sigma: number): number[] {
  const half = Math.max(1, Math.ceil(3 * sigma));
  const k: number[] = [];
  let s = 0;
  for (let t = -half; t <= half; t++) {
    const v = Math.exp(-(t * t) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const n = a.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let t = -half; t <= half; t++) {
      let j = i + t;
      if (j < 0) j = -j;
      if (j >= n) j = 2 * (n - 1) - j;
      acc += k[t + half] * a[j];
    }
    out[i] = acc;
  }
  return out;
}

/** Rescale an array to unit RMS (about its mean). */
function normalizeRms(a: number[]): number[] {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  const rms = Math.sqrt(s / a.length) || 1;
  return a.map((v) => (v - m) / rms);
}

/** Discrete-defect count per condition (drives the before/after story). */
function burrCount(seed: Seed, isRef: boolean): number {
  if (isRef) return 18; // as-printed reference: many print defects
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Math.round(v)));
  if (seed.millingMode === 'up') return clamp(4 + seed.Ra * 5, 3, 15); // chatter-prone
  return clamp(2 + seed.Ra * 3, 1, 11); // down-milling: cleanest
}

/**
 * Build a synthetic profile (µm) for a seed, scaled so computeRoughness returns
 * ~seed.Ra. Feed-mark spacing follows feed-per-tooth fz = vf/(n·z); the
 * reference has none. A handful of localized burrs seed the anomaly detector —
 * denser on the as-printed reference so before/after differencing tells a story.
 */
export function synthProfile(seed: Seed, settings: Settings): Profile {
  const rng = mulberry32(hashName(seed.name) ^ 0x9e3779b9);
  const gauss = makeGaussian(rng);

  const x = new Array<number>(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) x[i] = i * DX;

  // Feed-mark spacing (µm): fz = vf/(n·z). z = effective teeth.
  let spacing = 0;
  if (seed.spindleSpeed && seed.feedRate) {
    const fz = seed.feedRate / (seed.spindleSpeed * settings.effectiveTeeth); // mm
    spacing = fz * 1000; // µm
  }

  // Roughness component: BAND-LIMITED (spatially-correlated) Gaussian noise —
  // faithful to a confocal profilometer at 1 µm sampling, whose optical spot
  // gives a few-µm correlation length. Correlated noise keeps the realistic
  // Rq/Ra ≈ 1.25 while suppressing the spurious point-outliers that white noise
  // would feed to the Hampel identifier. A gentle periodic feed-mark ripple is
  // added on top (legitimate texture, not an anomaly).
  const white = new Array<number>(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) white[i] = gauss();
  const noise = normalizeRms(smooth1d(white, 5)); // ~5 µm correlation length
  const rough = new Array<number>(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) {
    let v = noise[i];
    if (spacing > 4) {
      const phase = (x[i] % spacing) / spacing;
      v += 0.3 * Math.cos(2 * Math.PI * phase);
    }
    rough[i] = v;
  }

  // Localized defects → anomaly zones. These are DISCRETE flaws (print blobs,
  // layer-line ridges, chatter/burrs) — distinct from overall Ra. The as-printed
  // reference carries many; milling replaces them with periodic tool marks, so
  // milled surfaces show FEWER discrete anomalies (before/after "reduction",
  // spec §6.5) even where their Ra is higher. Up-milling keeps more (chatter).
  const isRef = seed.millingMode === 'reference';
  const nBurrs = burrCount(seed, isRef);
  const minSep = 70; // µm — keep burrs farther apart than the merge gap
  const centers: number[] = [];
  let guard = 0;
  while (centers.length < nBurrs && guard < nBurrs * 40) {
    guard++;
    const c = 40 + Math.floor(rng() * (N_POINTS - 80));
    if (centers.every((p) => Math.abs(p - c) > minSep)) centers.push(c);
  }
  for (const center of centers) {
    // Narrow, tall spikes (debris / burr tips / layer-line ridges): sharp enough
    // that the point-wise Hampel identifier resolves each as a distinct zone.
    const width = 2 + rng() * 2.5; // µm
    const amp = 6 * (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 0.4);
    for (let i = Math.max(0, center - 40); i < Math.min(N_POINTS, center + 40); i++) {
      const d = x[i] - center;
      rough[i] += amp * Math.exp(-(d * d) / (2 * width * width));
    }
  }

  // Gentle waviness (removed by the ISO filter; only affects raw display).
  const waviness = new Array<number>(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) {
    const t = x[i] / (N_POINTS * DX);
    waviness[i] = 1.5 * Math.sin(Math.PI * t) + 0.6 * Math.sin(4 * Math.PI * t + 1);
  }

  // First pass at unit amplitude to learn the residual Ra, then scale to target.
  const draft: Profile = { x, y: rough.map((r, i) => r + waviness[i]) };
  const draftRough = computeRoughness(draft, settings);
  const k = draftRough.Ra > 1e-9 ? seed.Ra / draftRough.Ra : 1;

  const y = new Array<number>(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) y[i] = waviness[i] + k * rough[i];

  return { x, y };
}

/** Instantiate the full example dataset as Datasets (profiles in µm). */
export function buildExampleDatasets(settings: Settings): Dataset[] {
  return SEEDS.map((seed) => ({
    id: makeId('ex'),
    name: seed.name,
    part: seed.part,
    spindleSpeed: seed.spindleSpeed,
    feedRate: seed.feedRate,
    millingMode: seed.millingMode,
    profile: synthProfile(seed, settings),
    isExample: true,
  }));
}
