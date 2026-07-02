// Response-surface heatmap (panel C): predicted Ra over spindle × feed, viridis
// (dark = smooth, bright = rough), with iso-feed-per-rev lines, measured points,
// a smoothest ★, a live crosshair, and a colorbar. Pure Canvas 2D.
import type { Dataset, Settings, WorkingPoint } from '../types';
import type { ModeFit } from '../interp/index';
import { predict } from '../interp/index';
import { rgbCss, viridis } from '../color';
import { canvasPalette, theme } from '../theme';

export interface SurfaceGeom {
  plot: { x: number; y: number; w: number; h: number };
  rpmMin: number;
  rpmMax: number;
  feedMin: number;
  feedMax: number;
  toPx(spindle: number, feed: number): [number, number];
  toData(px: number, py: number): [number, number];
}

export interface SurfaceState {
  datasets: Dataset[];
  fit: ModeFit;
  working: WorkingPoint;
  settings: Settings;
  raMax: number;
  smoothestId: string | null;
  hoverId: string | null;
}

const CB_W = 54; // colorbar strip width (CSS px)

/** Fit rpm/feed domain to the measured data, padded ~12%. */
function domain(datasets: Dataset[]): {
  rpmMin: number;
  rpmMax: number;
  feedMin: number;
  feedMax: number;
} {
  const pts = datasets.filter(
    (d) => d.spindleSpeed != null && d.feedRate != null && d.millingMode !== 'reference',
  );
  if (pts.length === 0) {
    return { rpmMin: 200, rpmMax: 2000, feedMin: 50, feedMax: 1000 };
  }
  const rpm = pts.map((d) => d.spindleSpeed as number);
  const feed = pts.map((d) => d.feedRate as number);
  const rpmMin = Math.min(...rpm);
  const rpmMax = Math.max(...rpm);
  const feedMin = Math.min(...feed);
  const feedMax = Math.max(...feed);
  const rpad = (rpmMax - rpmMin || rpmMin) * 0.12;
  const fpad = (feedMax - feedMin || feedMin) * 0.12;
  return {
    rpmMin: Math.max(0, rpmMin - rpad),
    rpmMax: rpmMax + rpad,
    feedMin: Math.max(0, feedMin - fpad),
    feedMax: feedMax + fpad,
  };
}

export function drawSurface(
  canvas: HTMLCanvasElement,
  state: SurfaceState,
): SurfaceGeom {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 360;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pal = canvasPalette(theme.get());

  const m = { l: 52, r: CB_W + 30, t: 14, b: 40 };
  const plot = { x: m.l, y: m.t, w: cssW - m.l - m.r, h: cssH - m.t - m.b };
  const dom = domain(state.datasets);

  const toPx = (spindle: number, feed: number): [number, number] => {
    const px =
      plot.x + ((spindle - dom.rpmMin) / (dom.rpmMax - dom.rpmMin)) * plot.w;
    const py =
      plot.y + (1 - (feed - dom.feedMin) / (dom.feedMax - dom.feedMin)) * plot.h;
    return [px, py];
  };
  const toData = (px: number, py: number): [number, number] => {
    const spindle =
      dom.rpmMin + ((px - plot.x) / plot.w) * (dom.rpmMax - dom.rpmMin);
    const feed =
      dom.feedMin + (1 - (py - plot.y) / plot.h) * (dom.feedMax - dom.feedMin);
    return [spindle, feed];
  };

  // --- heatmap ---
  const cols = Math.max(24, Math.floor(plot.w / 6));
  const rows = Math.max(18, Math.floor(plot.h / 6));
  const cw = plot.w / cols;
  const ch = plot.h / rows;
  const rpmMinM = Math.min(...state.fit.points.map((p) => p.n), Infinity);
  const rpmMaxM = Math.max(...state.fit.points.map((p) => p.n), -Infinity);
  const fprMinM = Math.min(...state.fit.points.map((p) => p.fpr), Infinity);
  const fprMaxM = Math.max(...state.fit.points.map((p) => p.fpr), -Infinity);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const spindle =
        dom.rpmMin + ((c + 0.5) / cols) * (dom.rpmMax - dom.rpmMin);
      const feed =
        dom.feedMin + (1 - (r + 0.5) / rows) * (dom.feedMax - dom.feedMin);
      if (state.fit.points.length === 0) continue;
      const pr = predict(state.fit, spindle, feed, state.settings.bandwidth);
      const t = state.raMax > 0 ? Math.min(1, pr.Ra / state.raMax) : 0;
      const [rr, gg, bb] = viridis(t);
      const fpr = feed / spindle;
      const extrap =
        spindle < rpmMinM || spindle > rpmMaxM || fpr < fprMinM || fpr > fprMaxM;
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.globalAlpha = extrap ? 0.45 : 1;
      ctx.fillRect(plot.x + c * cw, plot.y + r * ch, cw + 0.6, ch + 0.6);
      ctx.globalAlpha = 1;
    }
  }

  // extrapolation hatch overlay
  drawExtrapHatch(ctx, plot, dom, toPx, rpmMinM, rpmMaxM, fprMinM, fprMaxM);

  // --- iso feed-per-rev lines (feed = fpr · rpm) ---
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px ui-monospace, monospace';
  for (const fpr of niceFprLines(dom)) {
    const p0 = toPx(dom.rpmMin, dom.rpmMin * fpr);
    const p1 = toPx(dom.rpmMax, dom.rpmMax * fpr);
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.stroke();
    const lbl = `${fpr.toFixed(2)} mm/rev`;
    const lp = toPx(dom.rpmMax * 0.72, dom.rpmMax * 0.72 * fpr);
    if (lp[1] > plot.y + 8 && lp[1] < plot.y + plot.h - 4)
      ctx.fillText(lbl, lp[0], lp[1] - 3);
  }
  ctx.restore();
  ctx.setLineDash([]);

  // --- axes frame + ticks ---
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  ctx.fillStyle = pal.text;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const rpm = dom.rpmMin + (i / 4) * (dom.rpmMax - dom.rpmMin);
    const [px] = toPx(rpm, dom.feedMin);
    ctx.fillText(String(Math.round(rpm)), px, plot.y + plot.h + 14);
  }
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const feed = dom.feedMin + (i / 4) * (dom.feedMax - dom.feedMin);
    const [, py] = toPx(dom.rpmMin, feed);
    ctx.fillText(String(Math.round(feed)), plot.x - 6, py + 3);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = pal.textDim;
  ctx.fillText('Spindle speed [rpm]', plot.x + plot.w / 2, cssH - 6);
  ctx.save();
  ctx.translate(12, plot.y + plot.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Feed rate [mm/min]', 0, 0);
  ctx.restore();

  // --- measured points ---
  for (const d of state.datasets) {
    if (d.spindleSpeed == null || d.feedRate == null) continue;
    if (d.millingMode !== state.fit.mode) continue;
    const ra = d.roughness?.Ra ?? 0;
    const [px, py] = toPx(d.spindleSpeed, d.feedRate);
    const t = state.raMax > 0 ? Math.min(1, ra / state.raMax) : 0;
    const hovered = d.id === state.hoverId;
    ctx.beginPath();
    ctx.arc(px, py, hovered ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = rgbCss(viridis(t));
    ctx.fill();
    ctx.lineWidth = hovered ? 2.5 : 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    if (d.id === state.smoothestId) drawStar(ctx, px, py, pal.accent);
  }

  // --- crosshair at working point ---
  const [cx, cy] = toPx(state.working.spindleSpeed, state.working.feedRate);
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(plot.x, cy);
  ctx.lineTo(plot.x + plot.w, cy);
  ctx.moveTo(cx, plot.y);
  ctx.lineTo(cx, plot.y + plot.h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = pal.accent;
  ctx.fill();
  ctx.strokeStyle = '#0e1116';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // --- colorbar ---
  drawColorbar(ctx, cssW - CB_W - 8, plot.y, CB_W - 24, plot.h, state.raMax, pal);

  return {
    plot,
    ...dom,
    toPx,
    toData,
  };
}

function drawExtrapHatch(
  ctx: CanvasRenderingContext2D,
  plot: { x: number; y: number; w: number; h: number },
  dom: { rpmMin: number; rpmMax: number; feedMin: number; feedMax: number },
  toPx: (s: number, f: number) => [number, number],
  rpmMinM: number,
  rpmMaxM: number,
  fprMinM: number,
  fprMaxM: number,
): void {
  if (!isFinite(rpmMinM)) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  // Mark the measured rpm envelope; extrapolated cells are already dimmed above.
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  for (const rpm of [rpmMinM, rpmMaxM]) {
    const a = toPx(rpm, dom.feedMin);
    const b = toPx(rpm, dom.feedMax);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
  void fprMinM;
  void fprMaxM;
}

function drawColorbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  raMax: number,
  pal: ReturnType<typeof canvasPalette>,
): void {
  const n = 64;
  for (let i = 0; i < n; i++) {
    const t = 1 - i / (n - 1);
    ctx.fillStyle = rgbCss(viridis(t));
    ctx.fillRect(x, y + (i / n) * h, w, h / n + 1);
  }
  ctx.strokeStyle = pal.lineStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = pal.text;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const val = (raMax * (4 - i)) / 4;
    const yy = y + (i / 4) * h;
    ctx.fillText(val.toFixed(2), x + w + 4, yy + 3);
  }
  ctx.save();
  ctx.translate(x + w + 30, y + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = pal.textDim;
  ctx.fillText('Ra [µm]', 0, 0);
  ctx.restore();
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 9 : 4;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#0e1116';
  ctx.stroke();
  ctx.restore();
}

function niceFprLines(dom: {
  rpmMin: number;
  rpmMax: number;
  feedMin: number;
  feedMax: number;
}): number[] {
  // fpr = feed / rpm; span across the visible box corners.
  const cand = [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0];
  const fprLo = dom.feedMin / dom.rpmMax;
  const fprHi = dom.feedMax / dom.rpmMin;
  return cand.filter((f) => f >= fprLo * 0.8 && f <= fprHi * 1.2);
}
