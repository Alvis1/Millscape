// Robust dual-format parser for surface line-scan files (CSV/TXT), plus
// areal-grid auto-detection. One rule: split on comma OR semicolon; keep a row
// only if the first two tokens are finite floats. Header lines like
// `Variation`, `x;y`, `[m];[m]` are auto-skipped because they don't parse.
import type { Profile, UnitsConfig } from '../types';

export interface RawParse {
  /** Raw x/y before unit scaling (file's own numbers). */
  x: number[];
  y: number[];
  /** If detected, the areal grid shape. */
  grid?: { rows: number; cols: number };
  warnings: string[];
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function toNum(tok: string): number {
  const t = tok.trim();
  if (!NUM.test(t)) return NaN;
  return parseFloat(t);
}

/**
 * Parse raw text into x/y arrays. Auto-detects an areal grid: if most rows have
 * many numeric columns (≥ 4) and a consistent column count, treat the file as a
 * rows×cols height matrix and flatten it (x becomes a synthetic sample index).
 */
export function parseRaw(text: string): RawParse {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  // Tokenize numeric rows.
  const rows: number[][] = [];
  for (const line of lines) {
    if (!line || line.trim().length === 0) continue;
    const tokens = line.split(/[;,]/);
    if (tokens.length < 2) continue;
    const nums = tokens.map(toNum);
    // A "data row" needs its first two tokens to be finite.
    if (Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
      rows.push(nums);
    }
  }

  if (rows.length === 0) {
    return { x: [], y: [], warnings: ['No numeric data rows found.'] };
  }

  // Grid detection: many wide rows of equal width → areal height map. But a
  // line scan exported with extra columns (e.g. `x,y,slope,quality`) also has
  // ≥4 consistent columns — so we additionally require that the FIRST column is
  // NOT monotonically increasing. A real height matrix has heights (non-monotone)
  // in column 0; a profile has its ascending x there. This keeps genuine grids
  // while routing multi-column line scans to the 2-column path (x = col0).
  const widths = rows.map((r) => r.filter((v) => Number.isFinite(v)).length);
  const maxW = Math.max(...widths);
  const wideRows = widths.filter((w) => w >= 4).length;
  const consistent = widths.every((w) => w === widths[0]);
  const firstColMonotone = isMonotoneIncreasing(rows.map((r) => r[0]));
  if (
    maxW >= 4 &&
    consistent &&
    wideRows === rows.length &&
    rows.length >= 4 &&
    !firstColMonotone
  ) {
    return parseGrid(rows, warnings);
  }

  // Otherwise: standard 2-column profile (ignore extra columns).
  const x: number[] = [];
  const y: number[] = [];
  for (const r of rows) {
    x.push(r[0]);
    y.push(r[1]);
  }

  if (x.length < 200) {
    warnings.push(
      `Only ${x.length} points parsed (expected ≥200). Check the file/delimiter.`,
    );
  }
  checkSpacing(x, warnings);
  return { x, y, warnings };
}

function parseGrid(rows: number[][], warnings: string[]): RawParse {
  const cols = rows[0].length;
  const heights: number[] = [];
  for (const r of rows) for (let c = 0; c < cols; c++) heights.push(r[c]);
  // Synthetic x index (0,1,2,…) — the true lateral scale comes from unit
  // factors applied downstream. y holds the flattened grid, row-major.
  const x = heights.map((_, i) => i);
  warnings.push(
    `Detected areal grid ${rows.length}×${cols}; rendering as a true 2-D height map.`,
  );
  return {
    x,
    y: heights,
    grid: { rows: rows.length, cols },
    warnings,
  };
}

/** True if the sequence is strictly increasing (a line-scan x column). */
function isMonotoneIncreasing(col: number[]): boolean {
  if (col.length < 2) return false;
  for (let i = 1; i < col.length; i++) {
    if (!(col[i] > col[i - 1])) return false;
  }
  return true;
}

function checkSpacing(x: number[], warnings: string[]): void {
  if (x.length < 3) return;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < x.length; i++) {
    const dx = x[i] - x[i - 1];
    if (dx < min) min = dx;
    if (dx > max) max = dx;
  }
  if (min <= 0) {
    warnings.push('x is not strictly increasing — data may be out of order.');
    return;
  }
  if (max / min > 1.5) {
    warnings.push('Non-uniform x spacing detected; roughness assumes uniform dx.');
  }
}

/** Apply per-axis input factors (raw → µm) to produce an internal Profile. */
export function toProfile(raw: RawParse, units: UnitsConfig): Profile {
  const x = raw.x.map((v) => v * units.xInputFactor);
  const y = raw.y.map((v) => v * units.yInputFactor);
  const profile: Profile = { x, y };
  if (raw.grid) profile.grid = raw.grid;
  return profile;
}

/** Convenience: parse text straight into an internal-µm Profile. */
export function parseToProfile(
  text: string,
  units: UnitsConfig,
): { profile: Profile; warnings: string[] } {
  const raw = parseRaw(text);
  return { profile: toProfile(raw, units), warnings: raw.warnings };
}
