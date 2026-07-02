// MillScape entry point — builds the 4-panel layout and orchestrates the
// recompute / render pipeline. Heavy roughness+anomaly recomputation runs only
// when data or compute-settings change (tracked by a signature); working-point
// and display changes take the cheap render path.
import './style.css';
import type { Dataset } from './types';
import { store } from './store/index';
import { recomputeAll, kinematics } from './compute';
import { buildFit, predict, smoothestPoint, weightedNeighbors } from './interp/index';
import type { ModeFit, Prediction } from './interp/index';
import { drawSurface } from './render2d/surface';
import { drawProfile, drawTradeoff } from './render2d/profile';
import { Viewer } from './render3d/viewer';
import { FieldBlendCache, FIELD_DIM } from './render3d/fieldBlend';
import { createControls } from './ui/controls';
import type { Controls } from './ui/controls';
import { renderDataManager } from './ui/dataManager';
import { handleFiles } from './ui/import';
import { buildExampleDatasets } from './data/example';
import { el, clear } from './ui/dom';
import { theme } from './theme';

theme.apply();

const app = document.getElementById('app')!;

// ---------- build skeleton ----------
const honesty = el('div', { class: 'honesty' });
const themeBtn = el('button', {
  class: 'btn compact theme-toggle',
  title: 'Switch between light and dark mode',
  'aria-label': 'Switch between light and dark mode',
}, ['']);
function syncThemeBtn(): void {
  themeBtn.textContent = theme.get() === 'dark' ? '☀ Light' : '☾ Dark';
}
syncThemeBtn();
const header = el('header', { class: 'app-header' }, [
  el('div', { class: 'brand' }, [
    el('span', { class: 'brand-mark' }, ['◈']),
    el('span', { class: 'brand-name' }, ['MillScape']),
    el('span', { class: 'brand-sub' }, ['Milling Roughness Explorer + 3D Anomaly Viewer']),
  ]),
  el('div', { class: 'header-right' }, [honesty, themeBtn]),
]);

// Panel A — import bar
const importBar = el('div', { class: 'import-bar', tabindex: '0' }, [
  el('div', { class: 'import-bar-inner' }, [
    el('span', { class: 'import-icon' }, ['⤓']),
    el('span', {}, ['Drag CSV/TXT profiles here to import']),
    el('span', { class: 'import-or' }, ['or use “+ Add data” / “Load example” below']),
  ]),
]);

// Panel B — controls
const controlsMount = el('aside', { class: 'col-left' });

// Panel C — response surface + tradeoff
const surfaceCanvas = el('canvas', { class: 'surface-canvas' }) as HTMLCanvasElement;
const tradeoffCanvas = el('canvas', { class: 'tradeoff-canvas' }) as HTMLCanvasElement;
const surfaceCard = el('section', { class: 'card card-surface' }, [
  el('div', { class: 'card-head' }, [
    el('h3', {}, ['Response surface — predicted Ra over spindle × feed']),
    el('span', { class: 'card-hint' }, ['click / drag to set working point']),
  ]),
  el('div', { class: 'surface-wrap' }, [surfaceCanvas]),
  el('div', { class: 'tradeoff-wrap' }, [
    el('div', { class: 'card-subhead' }, ['Speed trade-off — Ra vs spindle at current feed/rev']),
    tradeoffCanvas,
  ]),
]);

// Panel D — profile + 3D relief
const profileCanvas = el('canvas', { class: 'profile-canvas' }) as HTMLCanvasElement;
const viewerMount = el('div', { class: 'viewer-mount' });
const heightRange = el('span', { class: 'v-range' }, ['']);
const exagInput = el('input', {
  type: 'range',
  class: 'slider',
  min: '1',
  max: '200',
  step: '1',
  value: '60',
}) as HTMLInputElement;
const exagVal = el('span', { class: 'slider-val' }, ['×60']);
const cmapSel = el('select', { class: 'field-input compact' }, [
  el('option', { value: 'viridis' }, ['viridis']),
  el('option', { value: 'turbo' }, ['turbo']),
]) as HTMLSelectElement;
const anomToggle = el('input', { type: 'checkbox', checked: 'true' }) as HTMLInputElement;
const resetViewBtn = el('button', { class: 'btn compact' }, ['Reset view']);
const reliefLabel = el('span', { class: 'relief-label' }, ['']);

const viewerCard = el('section', { class: 'card card-viewer' }, [
  el('div', { class: 'card-head' }, [
    el('h3', {}, ['3D roughness relief']),
    reliefLabel,
  ]),
  el('div', { class: 'profile-wrap' }, [profileCanvas]),
  el('div', { class: 'viewer-wrap' }, [viewerMount]),
  el('div', { class: 'viewer-controls' }, [
    el('label', { class: 'vc-item' }, [
      el('span', {}, ['Vertical exaggeration']),
      exagInput,
      exagVal,
    ]),
    heightRange,
    el('label', { class: 'vc-item' }, [el('span', {}, ['Colour']), cmapSel]),
    el('label', { class: 'vc-item vc-check' }, [anomToggle, el('span', {}, ['Anomalies (red)'])]),
    resetViewBtn,
  ]),
]);

const center = el('div', { class: 'col-center' }, [surfaceCard, viewerCard]);
const layout = el('div', { class: 'layout' }, [controlsMount, center]);

// Data manager (full width)
const dmMount = el('section', { class: 'card card-dm' }, [
  el('div', { class: 'card-head' }, [el('h3', {}, ['Datasets'])]),
  el('div', { class: 'dm-mount' }),
]);
const dmInner = dmMount.querySelector('.dm-mount') as HTMLElement;

app.append(header, importBar, layout, dmMount);

// ---------- 3D viewer ----------
const viewer = new Viewer(viewerMount);
// Photo displacement maps decode asynchronously; refresh the height read-out
// once the relief (and its height range) is ready.
viewer.onInfo = () => updateHeightRange();
exagInput.addEventListener('input', () => {
  const v = parseFloat(exagInput.value);
  exagVal.textContent = `×${v}`;
  viewer.setExaggeration(v);
  updateHeightRange();
});
cmapSel.addEventListener('change', () =>
  viewer.setColormap(cmapSel.value as 'viridis' | 'turbo'),
);
anomToggle.addEventListener('change', () => viewer.setShowAnomalies(anomToggle.checked));
resetViewBtn.addEventListener('click', () => viewer.resetView());
themeBtn.addEventListener('click', () => {
  theme.toggle();
  syncThemeBtn();
  viewer.setTheme(theme.get());
  renderAll();
});

function updateHeightRange(): void {
  const info = viewer.getInfo();
  const yu = store.settings.units.yDisplay;
  const toU = (um: number) => (yu === 'µm' ? um : yu === 'mm' ? um / 1e3 : um / 1e6);
  const kind = currentReliefKind;
  if (info.maxH === 0 && info.minH === 0) {
    heightRange.textContent =
      kind === 'interpolated'
        ? 'interpolated relief: —'
        : kind === 'extrapolated'
          ? 'extrapolated relief: —'
          : info.isImage
            ? 'photo relief: —'
            : 'true height: —';
    return;
  }
  // Interpolated/photo reliefs have no metrology depth calibration — their
  // amplitude is the interpolated (or measured) Ra, so they are labelled as
  // estimates, never as a "true height". The D4 amplitude morph scales the raw
  // field heights by currentAmpScale (blend bakes Ra in, so its scale is 1).
  const lo = toU(info.minH * currentAmpScale);
  const hi = toU(info.maxH * currentAmpScale);
  const prefix =
    kind === 'interpolated'
      ? 'interpolated relief ≈'
      : kind === 'extrapolated'
        ? 'extrapolated relief · low-confidence ≈'
        : info.isImage
          ? 'photo relief ≈'
          : 'true height';
  heightRange.textContent = `${prefix} ${lo.toFixed(3)} … ${hi.toFixed(3)} ${yu} (×${exagInput.value} shown)`;
}

// ---------- controls ----------
const clearSelAndRender = (): void => {
  store.select(null);
  renderAll();
};
const controls: Controls = createControls(renderAll, jumpToSmoothest, clearSelAndRender);
controlsMount.append(controls.root);

function jumpToSmoothest(): void {
  const best = smoothestPoint(store.datasets);
  if (!best || best.spindleSpeed == null || best.feedRate == null) return;
  store.setWorking({
    spindleSpeed: best.spindleSpeed,
    feedRate: best.feedRate,
    millingMode: best.millingMode === 'up' ? 'up' : 'down',
  });
  store.select(best.id);
  renderAll();
}

// ---------- import bar drag/drop ----------
for (const ev of ['dragenter', 'dragover']) {
  importBar.addEventListener(ev, (e) => {
    e.preventDefault();
    importBar.classList.add('drag');
  });
}
for (const ev of ['dragleave', 'drop']) {
  importBar.addEventListener(ev, (e) => {
    e.preventDefault();
    const related = (e as DragEvent).relatedTarget as Node | null;
    if (ev === 'dragleave' && related && importBar.contains(related)) return;
    importBar.classList.remove('drag');
  });
}
importBar.addEventListener('drop', (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (dt && dt.files.length) void handleFiles(dt.files, renderAll);
});
// whole-window drop guard so files don't navigate away
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- surface interaction ----------
let lastGeom: ReturnType<typeof drawSurface> | null = null;
let hoverId: string | null = null;
const tooltip = el('div', { class: 'surf-tooltip', style: 'display:none' });
document.body.appendChild(tooltip);

function surfacePick(e: MouseEvent): void {
  if (!lastGeom) return;
  const rect = surfaceCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const g = lastGeom;
  if (px < g.plot.x || px > g.plot.x + g.plot.w || py < g.plot.y || py > g.plot.y + g.plot.h)
    return;
  const [spindle, feed] = g.toData(px, py);
  store.setWorking({
    spindleSpeed: Math.round(spindle),
    feedRate: Math.round(feed),
  });
  store.select(null);
  renderAll();
}
let dragging = false;
surfaceCanvas.addEventListener('mousedown', (e) => {
  dragging = true;
  surfacePick(e);
});
surfaceCanvas.addEventListener('mousemove', (e) => {
  if (dragging) {
    surfacePick(e);
    return;
  }
  // hover measured points
  if (!lastGeom) return;
  const rect = surfaceCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  let found: Dataset | null = null;
  for (const d of store.datasets) {
    if (d.spindleSpeed == null || d.feedRate == null) continue;
    if (d.millingMode !== store.working.millingMode) continue;
    const [dx, dy] = lastGeom.toPx(d.spindleSpeed, d.feedRate);
    if (Math.hypot(px - dx, py - dy) < 9) {
      found = d;
      break;
    }
  }
  if (found) {
    const yu = store.settings.units.yDisplay;
    const ra = found.roughness ? found.roughness.Ra : 0;
    const fpr = found.feedRate! / found.spindleSpeed!;
    tooltip.innerHTML = `<b>${found.name}</b><br>${found.spindleSpeed} rpm · ${found.feedRate} mm/min<br>fpr ${fpr.toFixed(
      3,
    )} mm · Ra ${ra.toFixed(3)} ${yu}<br>${found.anomaly?.zoneCount ?? 0} anomaly zones`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.clientX + 12}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
    if (hoverId !== found.id) {
      hoverId = found.id;
      renderSurfaceOnly();
    }
  } else {
    tooltip.style.display = 'none';
    if (hoverId !== null) {
      hoverId = null;
      renderSurfaceOnly();
    }
  }
});
window.addEventListener('mouseup', () => (dragging = false));
surfaceCanvas.addEventListener('mouseleave', () => {
  tooltip.style.display = 'none';
  if (hoverId) {
    hoverId = null;
    renderSurfaceOnly();
  }
});

// ---------- render pipeline ----------
let lastSig = '';
let fits: { down: ModeFit; up: ModeFit } = {
  down: buildFit([], 'down', 0.16),
  up: buildFit([], 'up', 0.16),
};
type ReliefKind = 'measured' | 'interpolated' | 'extrapolated';
/** Stable identity of what the 3D viewer currently shows; a mesh rebuild fires
 *  only when this changes (the interpolated blend uses the constant key 'blend'
 *  so interior dragging updates in place, not by rebuilding). */
let reliefKey = '';
let currentAmpScale = 1;
let currentReliefKind: ReliefKind = 'measured';

// Interpolation cache: each example photo decoded once → common-grid unit-RMS
// field, blended on demand as the working point moves.
const fieldCache = new FieldBlendCache();
const blendBuf = new Float32Array(FIELD_DIM * FIELD_DIM);
const BLEND_K = 3; // neighbours combined per blend (small ⇒ crisp tool marks)
let blendRafPending = false;
fieldCache.onReady = () => {
  // A photo finished decoding — re-render once (coalesced) so a cold-cache
  // amplitude-morph fallback upgrades to a genuine blend when fields arrive.
  if (blendRafPending) return;
  blendRafPending = true;
  requestAnimationFrame(() => {
    blendRafPending = false;
    renderAll();
  });
};

function warmFields(): void {
  fieldCache.preload(
    store.datasets
      .filter((d) => d.imageUrl)
      .map((d) => ({ id: d.id, url: d.imageUrl! })),
  );
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

function computeSig(): string {
  const s = store.settings;
  return [
    store.dataEpoch,
    s.lambdaC,
    s.roughnessMethod,
    JSON.stringify(s.anomaly),
  ].join('|');
}

function domainRanges(): { rpm: [number, number]; feed: [number, number] } {
  const pts = store.datasets.filter(
    (d) => d.spindleSpeed != null && d.feedRate != null && d.millingMode !== 'reference',
  );
  if (pts.length === 0) return { rpm: [100, 2000], feed: [10, 1200] };
  const rpm = pts.map((d) => d.spindleSpeed as number);
  const feed = pts.map((d) => d.feedRate as number);
  const pad = (a: number[], f: number, floor: number): [number, number] => {
    const lo = Math.min(...a);
    const hi = Math.max(...a);
    const p = (hi - lo || lo) * f;
    return [Math.max(floor, lo - p), hi + p];
  };
  // rpm floored at 1 so no downstream division uses a zero spindle speed.
  return { rpm: pad(rpm, 0.25, 1), feed: pad(feed, 0.25, 0) };
}

/** Choose which profile the 2D/3D relief shows. */
function reliefDataset(currentFit: ModeFit): { d: Dataset | null; label: string } {
  if (store.selectedId) {
    const d = store.datasetById(store.selectedId);
    if (d) {
      const lbl = d.millingMode === 'reference' ? 'as-printed reference' : 'measured';
      return { d, label: lbl };
    }
  }
  const pred = predict(
    currentFit,
    store.working.spindleSpeed,
    store.working.feedRate,
    store.settings.bandwidth,
  );
  if (pred.nearest) {
    const d = store.datasetById(pred.nearest.id);
    if (d) {
      return {
        d,
        label: pred.onMeasured ? 'measured' : `nearest measured (${d.name})`,
      };
    }
  }
  return { d: null, label: '' };
}

/** What the 3D relief should render at the current working point. */
type ReliefPlan =
  | {
      kind: 'dataset';
      d: Dataset | null;
      label: string; // full display text for the 3D card
      key: string;
      ampScale: number;
      reliefKind: ReliefKind;
    }
  | {
      kind: 'blend';
      neighborNames: string[];
      ra: number;
      extrapolated: boolean;
      key: 'blend';
    };

/**
 * Decide the 3D relief for the current working point:
 *   • explicit selection / on a measured point → the true measured photo;
 *   • an interior point with ≥1 cache-ready neighbour photo → a genuine
 *     weighted blend (morphs continuously as you drag);
 *   • otherwise (cold cache / photoless import) → the nearest surface with its
 *     height amplitude morphed toward the interpolated Ra.
 * Amplitude is always tied to the interpolated Ra so the µm scale stays honest.
 */
function decideRelief(currentFit: ModeFit, pred: Prediction): ReliefPlan {
  const bw = store.settings.bandwidth;
  const { spindleSpeed, feedRate } = store.working;

  if (store.selectedId) {
    const d = store.datasetById(store.selectedId);
    if (d) {
      const base = d.millingMode === 'reference' ? 'as-printed reference' : 'measured';
      const label = `${d.name} · ${base}${d.imageUrl ? ' · photo relief' : ''}`;
      return { kind: 'dataset', d, label, key: `ds:${d.id}`, ampScale: 1, reliefKind: 'measured' };
    }
  }
  if (!pred.nearest) {
    return { kind: 'dataset', d: null, label: '', key: 'none', ampScale: 1, reliefKind: 'measured' };
  }
  const nearest = store.datasetById(pred.nearest.id) ?? null;

  // Essentially coincident with a measured point → show its true photo.
  if (pred.onMeasured && nearest) {
    const label = `${nearest.name} · measured${nearest.imageUrl ? ' · photo relief' : ''}`;
    return { kind: 'dataset', d: nearest, label, key: `ds:${nearest.id}`, ampScale: 1, reliefKind: 'measured' };
  }

  // Interior/extrapolated point → try a genuine blend of cache-ready photos.
  const photo = weightedNeighbors(currentFit, spindleSpeed, feedRate, bw, BLEND_K)
    .map((n) => ({ id: n.point.id, name: n.point.name, weight: n.weight }))
    .filter((n) => !!store.datasetById(n.id)?.imageUrl && fieldCache.ready(n.id));
  if (photo.length >= 1) {
    const used = fieldCache.blend(photo, pred.Ra, BLEND_K, blendBuf);
    if (used >= 1) {
      return {
        kind: 'blend',
        neighborNames: photo.slice(0, used).map((p) => p.name),
        ra: pred.Ra,
        extrapolated: pred.extrapolated,
        key: 'blend',
      };
    }
  }

  // Fallback: amplitude morph of the nearest real surface (cold cache / no photo).
  const baseRa = nearest?.roughness?.Ra ?? 0;
  const amp = baseRa > 0 && isFinite(pred.Ra) ? clamp(pred.Ra / baseRa, 0.2, 5) : 1;
  const reliefKind: ReliefKind = pred.extrapolated ? 'extrapolated' : 'interpolated';
  const head = pred.extrapolated ? 'extrapolated (low-confidence)' : 'interpolated';
  const label = nearest
    ? `${nearest.name} · ${head} · nearest texture · Ra ≈ ${pred.Ra.toFixed(3)} µm`
    : '';
  return { kind: 'dataset', d: nearest, label, key: `ds:${nearest?.id ?? 'none'}`, ampScale: amp, reliefKind };
}

function reliefLabelText(plan: ReliefPlan): string {
  if (plan.kind === 'blend') {
    const head = plan.extrapolated ? 'extrapolated (low-confidence)' : 'interpolated';
    return `${head} · blend of ${plan.neighborNames.join(', ')} · Ra ≈ ${plan.ra.toFixed(3)} µm`;
  }
  return plan.d ? plan.label : 'no profile';
}

/** Units sanity guards (spec §3): trace-length and kinematic height-scale floor. */
function sanityWarnings(d: Dataset | null): string[] {
  const out: string[] = [];
  if (!d || !d.roughness) return out;
  const x = d.profile.x;
  if (x.length > 1) {
    const traceUm = Math.abs(x[x.length - 1] - x[0]);
    const traceMm = traceUm / 1000;
    if (traceUm < 100) {
      out.push(
        `⚠ trace length ${traceMm.toFixed(4)} mm < 0.1 mm — x-axis unit likely wrong`,
      );
    } else if (traceUm > 1e5) {
      out.push(
        `⚠ trace length ${traceMm.toFixed(1)} mm > 100 mm — x-axis unit likely wrong`,
      );
    }
  }
  // Kinematic floor: measured Ra must exceed the feed-mark cusp h≈fz²/(8·(D/2)).
  if (d.spindleSpeed != null && d.feedRate != null) {
    const floor = kinematics(d.spindleSpeed, d.feedRate, store.settings).cuspFloor;
    if (floor > 0 && d.roughness.Ra < floor) {
      out.push(
        `⚠ height scale likely wrong: Ra ${d.roughness.Ra.toFixed(
          3,
        )} µm below feed-mark cusp floor ${floor.toFixed(3)} µm`,
      );
    }
  }
  return out;
}

function renderSurfaceOnly(): void {
  const currentFit = store.working.millingMode === 'up' ? fits.up : fits.down;
  const raMax = raScale();
  lastGeom = drawSurface(surfaceCanvas, {
    datasets: store.datasets,
    fit: currentFit,
    working: store.working,
    settings: store.settings,
    raMax,
    smoothestId: smoothestPoint(store.datasets)?.id ?? null,
    hoverId,
  });
}

function raScale(): number {
  let max = 0.001;
  for (const d of store.datasets) {
    if (d.millingMode === 'reference') continue;
    if (d.roughness) max = Math.max(max, d.roughness.Ra);
  }
  return max * 1.05;
}

function renderAll(): void {
  const sig = computeSig();
  const recomputed = sig !== lastSig;
  if (recomputed) {
    recomputeAll(store.datasets, store.settings);
    warmFields(); // decode example photos into the blend cache (idempotent)
    lastSig = sig;
  }
  const bw = store.settings.bandwidth;
  fits = {
    down: buildFit(store.datasets, 'down', bw),
    up: buildFit(store.datasets, 'up', bw),
  };
  const currentFit = store.working.millingMode === 'up' ? fits.up : fits.down;
  const ranges = domainRanges();
  const pred = predict(
    currentFit,
    store.working.spindleSpeed,
    store.working.feedRate,
    bw,
  );
  const kin = kinematics(store.working.spindleSpeed, store.working.feedRate, store.settings);
  const best = smoothestPoint(store.datasets);
  const relief = reliefDataset(currentFit);

  // controls
  controls.update({
    working: store.working,
    settings: store.settings,
    kin,
    pred,
    loo: currentFit.looMae,
    looRel: currentFit.looRel,
    modeCount: currentFit.points.length,
    zoneCount: relief.d?.anomaly?.zoneCount ?? null,
    reliefLabel: relief.label,
    rpmRange: ranges.rpm,
    feedRange: ranges.feed,
    smoothestName: best ? best.name : null,
    sanityWarnings: sanityWarnings(relief.d),
  });

  // 2D
  renderSurfaceOnly();
  drawTradeoff(tradeoffCanvas, {
    fit: currentFit,
    working: store.working,
    settings: store.settings,
    rpmMin: Math.max(1, ranges.rpm[0]),
    rpmMax: ranges.rpm[1],
  });
  drawProfile(profileCanvas, relief.d, store.settings.units, anomToggle.checked);

  // 3D — interpolated blend / amplitude morph / true measured photo.
  const plan = decideRelief(currentFit, pred);
  currentAmpScale = plan.kind === 'blend' ? 1 : plan.ampScale;
  currentReliefKind =
    plan.kind === 'blend'
      ? plan.extrapolated
        ? 'extrapolated'
        : 'interpolated'
      : plan.reliefKind;
  // A mesh rebuild fires only when the shown identity changes (or on recompute);
  // the blend keeps the constant key 'blend', so interior dragging updates in
  // place via applyBlendField every frame instead of rebuilding the geometry.
  if (plan.key !== reliefKey || recomputed) {
    if (plan.kind === 'dataset') viewer.setDataset(plan.d);
    reliefKey = plan.key;
  }
  if (plan.kind === 'blend') {
    viewer.applyBlendField(blendBuf, FIELD_DIM, { extrapolated: plan.extrapolated });
  } else {
    viewer.setAmplitude(currentAmpScale);
  }
  updateHeightRange();
  reliefLabel.textContent = reliefLabelText(plan);

  // data manager
  clear(dmInner);
  renderDataManager(dmInner, renderAll);

  // honesty line
  const s = store.settings;
  const methodName =
    s.roughnessMethod === 'gaussian'
      ? 'ISO 16610-21 Gaussian'
      : s.roughnessMethod === 'movingAverage'
        ? '201-pt moving average'
        : 'linear detrend (non-standard)';
  honesty.textContent =
    `Roughness: ${methodName}, λc = ${s.lambdaC} µm · x in ${s.units.xDisplay}, height in ${s.units.yDisplay} · ` +
    `measured = trusted · interpolated = indicative · outside range = low-confidence`;
}

// ---------- resize ----------
let rAF = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(rAF);
  rAF = requestAnimationFrame(() => {
    viewer.resize();
    renderAll();
  });
});

// ---------- boot ----------
// Seed the example set on the first ever load so the app isn't empty. The
// `seeded` flag is persisted, so a user who clears everything and reloads keeps
// their empty set instead of being re-seeded.
if (store.datasets.length === 0 && !store.isSeeded()) {
  store.addDatasets(buildExampleDatasets(store.settings));
  store.markSeeded();
}
renderAll();
