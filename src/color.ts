// Perceptual colormaps (viridis + turbo) as anchor-stop interpolators.
export type RGB = [number, number, number];

const VIRIDIS: RGB[] = [
  [68, 1, 84],
  [71, 45, 123],
  [59, 82, 139],
  [44, 114, 142],
  [33, 145, 140],
  [40, 174, 128],
  [94, 201, 98],
  [170, 220, 50],
  [253, 231, 37],
];

const TURBO: RGB[] = [
  [48, 18, 59],
  [65, 69, 171],
  [57, 118, 240],
  [26, 168, 238],
  [21, 205, 181],
  [90, 228, 127],
  [165, 239, 74],
  [224, 219, 49],
  [249, 164, 45],
  [231, 86, 24],
  [122, 4, 3],
];

function sample(stops: RGB[], t: number): RGB {
  const x = Math.max(0, Math.min(1, t));
  const scaled = x * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  if (i >= stops.length - 1) return stops[stops.length - 1];
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function viridis(t: number): RGB {
  return sample(VIRIDIS, t);
}
export function turbo(t: number): RGB {
  return sample(TURBO, t);
}

export function rgbCss([r, g, b]: RGB): string {
  return `rgb(${r},${g},${b})`;
}
