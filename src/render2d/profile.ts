// Two small Canvas 2D plots:
//   drawProfile  — the selected profile's ISO roughness residual with anomaly
//                  zones highlighted red (mirrors the 3D relief, spec §6/§10).
//   drawTradeoff — predicted Ra vs spindle at the current feed-per-rev, marking
//                  the current point and the minimum (spec §9).
import type { Dataset, Settings, UnitsConfig, WorkingPoint } from '../types';
import type { ModeFit } from '../interp/index';
import { predict } from '../interp/index';
import { fromUm } from '../units';
import { canvasPalette, theme } from '../theme';

function setup(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
} {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 140;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function drawProfile(
  canvas: HTMLCanvasElement,
  dataset: Dataset | null,
  units: UnitsConfig,
  showAnomalies: boolean,
): void {
  const { ctx, w, h } = setup(canvas);
  const pal = canvasPalette(theme.get());
  const m = { l: 46, r: 10, t: 10, b: 22 };
  const plot = { x: m.l, y: m.t, w: w - m.l - m.r, h: h - m.t - m.b };

  if (!dataset || !dataset.roughness) {
    ctx.fillStyle = pal.textMute;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No profile selected', w / 2, h / 2);
    return;
  }

  const rough = dataset.roughness;
  const xs = rough.x;
  const rs = rough.residual;
  const n = xs.length;
  const x0 = xs[0];
  const x1 = xs[n - 1];
  let rmax = 1e-6;
  for (const v of rs) rmax = Math.max(rmax, Math.abs(v));
  rmax *= 1.1;

  const toPx = (xv: number, yv: number): [number, number] => [
    plot.x + ((xv - x0) / (x1 - x0)) * plot.w,
    plot.y + plot.h / 2 - (yv / rmax) * (plot.h / 2),
  ];

  // anomaly zones (red bands)
  if (showAnomalies && dataset.anomaly) {
    ctx.fillStyle = 'rgba(255,77,77,0.22)';
    for (const z of dataset.anomaly.zones) {
      const [xa] = toPx(z.x0, 0);
      const [xb] = toPx(z.x1, 0);
      ctx.fillRect(xa, plot.y, Math.max(1.5, xb - xa), plot.h);
    }
  }

  // frame + zero line
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  ctx.strokeStyle = pal.lineFaint;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y + plot.h / 2);
  ctx.lineTo(plot.x + plot.w, plot.y + plot.h / 2);
  ctx.stroke();

  // residual trace
  ctx.beginPath();
  const stride = Math.max(1, Math.floor(n / plot.w / 2));
  for (let i = 0; i < n; i += stride) {
    const [px, py] = toPx(xs[i], rs[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = pal.interp;
  ctx.lineWidth = 1;
  ctx.stroke();

  // red markers on flagged samples
  if (showAnomalies && dataset.anomaly) {
    ctx.fillStyle = pal.red;
    const flags = dataset.anomaly.pointFlags;
    for (let i = 0; i < n; i += 1) {
      if (flags[i]) {
        const [px, py] = toPx(xs[i], rs[i]);
        ctx.fillRect(px - 0.6, py - 0.6, 1.6, 1.6);
      }
    }
  }

  // axis labels
  ctx.fillStyle = pal.textDim;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`+${fromUm(rmax, units.yDisplay).toFixed(2)}`, plot.x - 4, plot.y + 8);
  ctx.fillText(`-${fromUm(rmax, units.yDisplay).toFixed(2)}`, plot.x - 4, plot.y + plot.h - 2);
  ctx.textAlign = 'left';
  ctx.fillText(
    `residual [${units.yDisplay}]`,
    plot.x + 2,
    plot.y + plot.h + 16,
  );
  ctx.textAlign = 'right';
  const zc = dataset.anomaly ? dataset.anomaly.zoneCount : 0;
  ctx.fillStyle = showAnomalies ? pal.red : pal.textMute;
  ctx.fillText(`${zc} anomaly zones`, plot.x + plot.w, plot.y + plot.h + 16);
}

export interface TradeoffState {
  fit: ModeFit;
  working: WorkingPoint;
  settings: Settings;
  rpmMin: number;
  rpmMax: number;
}

export function drawTradeoff(
  canvas: HTMLCanvasElement,
  state: TradeoffState,
): void {
  const { ctx, w, h } = setup(canvas);
  const pal = canvasPalette(theme.get());
  const m = { l: 46, r: 12, t: 10, b: 22 };
  const plot = { x: m.l, y: m.t, w: w - m.l - m.r, h: h - m.t - m.b };
  const { fit, working, settings } = state;

  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  if (fit.points.length === 0) {
    ctx.fillStyle = pal.textMute;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No data for this mode', w / 2, h / 2);
    return;
  }

  const fpr = working.feedRate / working.spindleSpeed;
  const N = 120;
  const ras: number[] = [];
  let raMax = 1e-6;
  let raMin = Infinity;
  let minIdx = 0;
  for (let i = 0; i < N; i++) {
    const rpm = state.rpmMin + (i / (N - 1)) * (state.rpmMax - state.rpmMin);
    const feed = rpm * fpr;
    const pr = predict(fit, rpm, feed, settings.bandwidth);
    ras.push(pr.Ra);
    raMax = Math.max(raMax, pr.Ra);
    if (pr.Ra < raMin) {
      raMin = pr.Ra;
      minIdx = i;
    }
  }
  raMax *= 1.1;

  const toPx = (rpm: number, ra: number): [number, number] => [
    plot.x + ((rpm - state.rpmMin) / (state.rpmMax - state.rpmMin)) * plot.w,
    plot.y + plot.h - (ra / raMax) * plot.h,
  ];

  // curve
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const rpm = state.rpmMin + (i / (N - 1)) * (state.rpmMax - state.rpmMin);
    const [px, py] = toPx(rpm, ras[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = pal.ok;
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // minimum marker (★-ish)
  const minRpm =
    state.rpmMin + (minIdx / (N - 1)) * (state.rpmMax - state.rpmMin);
  const [mx, my] = toPx(minRpm, raMin);
  ctx.fillStyle = pal.ok;
  ctx.beginPath();
  ctx.arc(mx, my, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = pal.text;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`min ${Math.round(minRpm)}rpm`, mx, my - 6);

  // current point
  const [cx, cy] = toPx(
    working.spindleSpeed,
    predict(fit, working.spindleSpeed, working.feedRate, settings.bandwidth).Ra,
  );
  ctx.strokeStyle = pal.accent;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, plot.y);
  ctx.lineTo(cx, plot.y + plot.h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = pal.accent;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // labels
  ctx.fillStyle = pal.textDim;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`Ra @ ${fpr.toFixed(3)} mm/rev`, plot.x + 2, plot.y + 10);
  ctx.textAlign = 'right';
  ctx.fillText(`${raMax.toFixed(2)}`, plot.x - 4, plot.y + 8);
  ctx.fillText('0', plot.x - 4, plot.y + plot.h - 1);
  ctx.textAlign = 'center';
  ctx.fillText('Spindle speed [rpm]', plot.x + plot.w / 2, plot.y + plot.h + 16);
}
