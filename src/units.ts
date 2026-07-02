// Unit helpers. Internally everything is µm. These functions handle the two
// distinct concerns the spec separates:
//   1. INPUT factors  — scale raw file numbers → µm (set in the import popup).
//   2. DISPLAY units   — how µm values are shown to the user (Units panel).
import type { DisplayUnit, UnitsConfig } from './types';

/** µm per display unit. */
export const UNIT_TO_UM: Record<DisplayUnit, number> = {
  m: 1e6,
  mm: 1e3,
  µm: 1,
};

/** The metrology standard: x in mm, height in µm; raw x metres, raw y mm. */
export function standardUnits(): UnitsConfig {
  return {
    xInputFactor: 1e6, // raw metres → µm
    yInputFactor: 1e3, // raw millimetres → µm
    xDisplay: 'mm',
    yDisplay: 'µm',
  };
}

/** Convert an internal µm value to the given display unit. */
export function fromUm(um: number, unit: DisplayUnit): number {
  return um / UNIT_TO_UM[unit];
}

/** Convert a display-unit value back to internal µm. */
export function toUm(value: number, unit: DisplayUnit): number {
  return value * UNIT_TO_UM[unit];
}

/** Human label for a display unit. */
export function unitLabel(unit: DisplayUnit): string {
  return unit;
}

/** Format an internal-µm value for display with sensible precision. */
export function fmtUm(um: number, unit: DisplayUnit, digits = 3): string {
  const v = fromUm(um, unit);
  return `${v.toFixed(digits)} ${unit}`;
}
