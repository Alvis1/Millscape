// Surface photographs for the example set. Each condition in datasamples/ ships
// a confocal micrograph `<NAME>_pic.jpg` of the milled surface; the 3D viewer
// uses it as a displacement map (luminance → relief) instead of sweeping the
// 1-D line scan. Vite fingerprints and copies each referenced image into the
// build, so datasamples/ is the single source of truth (no public/ duplication).
//
// Keys come back as the absolute project path, e.g. '/datasamples/AD1_pic.jpg'.
const modules = import.meta.glob('/datasamples/*_pic.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** stem (the part before `_pic.jpg`) → bundled URL, e.g. 'AD1' → '/assets/…'. */
const byStem = new Map<string, string>();
for (const [path, url] of Object.entries(modules)) {
  const file = path.slice(path.lastIndexOf('/') + 1); // AD1_pic.jpg
  const stem = file.replace(/_pic\.jpg$/i, ''); // AD1
  byStem.set(stem, url);
}

// The as-printed reference is named F1 in the dataset but ships as F_pic.jpg.
const NAME_ALIASES: Record<string, string> = { F1: 'F' };

/** Bundled photo URL for an example dataset name, or null if none ships. */
export function imageForName(name: string): string | null {
  const stem = NAME_ALIASES[name] ?? name;
  return byStem.get(stem) ?? null;
}
