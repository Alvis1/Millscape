// Central data model for MillScape.
//
// UNIT CONVENTION: all internal computation is in micrometres (µm) on both
// axes. `Profile.x` / `Profile.y` are always µm. Raw file values are scaled to
// µm on import via per-axis `inputFactor`s (see units.ts). Display units are a
// separate, purely-cosmetic concern (see UnitsConfig).

export type MillingMode = 'down' | 'up' | 'reference';

/** A 1-D line scan (or a flattened areal grid) in internal µm units. */
export interface Profile {
  /** Lateral position, µm, monotonically increasing. */
  x: number[];
  /** Height, µm. */
  y: number[];
  /** Present only for areal/grid imports: original grid shape (rows × cols). */
  grid?: { rows: number; cols: number };
}

/** Roughness result, all in µm, computed on the ISO-filtered residual. */
export interface RoughnessResult {
  Ra: number;
  Rq: number;
  Rz: number;
  /** ISO-filtered roughness residual r = y − w, trimmed by λc/2 each end. */
  residual: number[];
  /** x positions matching `residual` (µm). */
  x: number[];
  /** Waviness (mean line) over the same trimmed window (µm). */
  waviness: number[];
  /** Evaluation length used (µm). */
  evalLength: number;
  /** True if evaluation length < 5·λc (ISO recommends ≥5 sampling lengths). */
  shortEval: boolean;
}

/** A discrete anomaly zone in profile-x space (µm). */
export interface AnomalyZone {
  /** Start x (µm). */
  x0: number;
  /** End x (µm). */
  x1: number;
  /** Width (µm). */
  width: number;
  /** Peak robust Z-score inside the zone (from the Hampel stage). */
  peakZ: number;
  /** Source: point (Hampel), window (structural), or both. */
  source: 'point' | 'window' | 'both';
}

/** Full anomaly-detection output for one profile. */
export interface AnomalyResult {
  zones: AnomalyZone[];
  zoneCount: number;
  meanWidth: number;
  maxWidth: number;
  /** Ra/Rq/Rz restricted to flagged regions (µm). */
  Ra: number;
  Rq: number;
  Rz: number;
  /** Per-sample flags aligned to the roughness residual, for plotting. */
  pointFlags: boolean[];
}

/** Before/after comparison of a milled profile vs the as-printed reference. */
export interface AnomalyDelta {
  dZoneCount: number;
  dMeanWidth: number;
  dRa: number;
  dRq: number;
  dRz: number;
  /** Zone-count reduction fraction (0..1); positive means fewer anomalies. */
  reduction: number;
}

/** One imported / example dataset. */
export interface Dataset {
  id: string;
  name: string;
  /** Part number (0 for the as-printed reference). */
  part: number;
  spindleSpeed: number | null; // rpm
  feedRate: number | null; // mm/min
  millingMode: MillingMode;
  /** Raw profile stored in internal µm units (already unit-scaled). */
  profile: Profile;
  /** Surface-photo URL used as a 3D displacement map (example set only). */
  imageUrl?: string;
  /** True for the seeded example set. */
  isExample?: boolean;
  /** Cached computed results (recomputed on settings/edit changes). */
  roughness?: RoughnessResult;
  anomaly?: AnomalyResult;
  /** Delta vs reference F1 (undefined for the reference itself). */
  delta?: AnomalyDelta;
}

/** Display + input unit configuration. */
export interface UnitsConfig {
  /** Multiplier converting a raw file x value → µm (default 1e6: metres→µm). */
  xInputFactor: number;
  /** Multiplier converting a raw file y value → µm (default 1e3: mm→µm). */
  yInputFactor: number;
  /** Display unit for x axis. */
  xDisplay: DisplayUnit;
  /** Display unit for height/roughness axis. */
  yDisplay: DisplayUnit;
}

export type DisplayUnit = 'm' | 'mm' | 'µm';

/** Global tool + method settings (editable). */
export interface Settings {
  toolDiameter: number; // mm
  effectiveTeeth: number;
  /** Cut-off wavelength λc in µm. */
  lambdaC: number;
  /** Roughness filter method. */
  roughnessMethod: 'gaussian' | 'movingAverage' | 'linearDetrend';
  /** Nadaraya–Watson bandwidth. */
  bandwidth: number;
  units: UnitsConfig;
  anomaly: AnomalySettings;
}

/** Adjustable anomaly-pipeline thresholds (defaults per the paper). */
export interface AnomalySettings {
  /** Hampel rolling window (samples). */
  hampelWindow: number;
  /** Hampel robust-Z threshold. */
  hampelZ: number;
  /** Structural window length (µm) — lower bound. */
  windowMin: number;
  /** Structural window length (µm) — upper bound. */
  windowMax: number;
  /** Local-Rq multiple of global Rq that flags a window. */
  rqMultiple: number;
  /** Merge gap: flags separated by ≤ this many µm join one zone. */
  mergeGap: number;
}

/** Current working point selected in the response surface / controls. */
export interface WorkingPoint {
  spindleSpeed: number; // rpm
  feedRate: number; // mm/min
  millingMode: 'down' | 'up';
}

/** Persisted session — round-trips exactly through Export/Import. */
export interface Session {
  version: number;
  datasets: Dataset[];
  settings: Settings;
  working: WorkingPoint;
  /** True once the example set has been auto-seeded, so a user who clears
   *  everything is not re-seeded on reload. */
  seeded?: boolean;
}

/** Derived kinematic quantities for a working point. */
export interface Kinematics {
  vc: number; // cutting speed, m/min
  fpr: number; // feed per rev, mm
  fz: number; // feed per tooth, mm
  /** Kinematic cusp-height floor h ≈ fz²/(8·(D/2)), µm. */
  cuspFloor: number;
}
