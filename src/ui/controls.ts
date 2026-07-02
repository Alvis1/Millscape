// Controls column (panel B): working-point sliders, milling-mode toggle, live
// read-outs (kinematics, predicted Ra ± uncertainty, anomaly count, flags), the
// Units panel with Reset, "Jump to smoothest", and global tool/method settings.
import type { DisplayUnit, Kinematics, Settings, WorkingPoint } from '../types';
import type { Prediction } from '../interp/index';
import { store } from '../store/index';
import { standardUnits, fromUm } from '../units';
import { el, sliderField, numberField } from './dom';

export interface ControlsState {
  working: WorkingPoint;
  settings: Settings;
  kin: Kinematics;
  pred: Prediction;
  loo: number | null;
  looRel: number | null;
  modeCount: number;
  zoneCount: number | null;
  reliefLabel: string;
  rpmRange: [number, number];
  feedRange: [number, number];
  smoothestName: string | null;
  /** Units sanity warnings (trace length, kinematic height-scale floor). */
  sanityWarnings: string[];
}

export interface Controls {
  root: HTMLElement;
  update: (s: ControlsState) => void;
}

export function createControls(
  refresh: () => void,
  jumpSmoothest: () => void,
  onWorking: () => void,
): Controls {
  // --- working point ---
  const downBtn = el('button', { class: 'seg-btn', 'data-mode': 'down' }, ['Down']);
  const upBtn = el('button', { class: 'seg-btn', 'data-mode': 'up' }, ['Up']);
  const setMode = (m: 'down' | 'up'): void => {
    store.setWorking({ millingMode: m });
    onWorking();
  };
  downBtn.addEventListener('click', () => setMode('down'));
  upBtn.addEventListener('click', () => setMode('up'));

  const spindle = sliderField(
    'Spindle speed',
    store.working.spindleSpeed,
    100,
    2000,
    1,
    (v) => {
      store.setWorking({ spindleSpeed: v });
      onWorking();
    },
    (v) => `${Math.round(v)} rpm`,
  );
  const feed = sliderField(
    'Feed rate',
    store.working.feedRate,
    10,
    1200,
    1,
    (v) => {
      store.setWorking({ feedRate: v });
      onWorking();
    },
    (v) => `${Math.round(v)} mm/min`,
  );

  const jumpBtn = el('button', { class: 'btn btn-accent full' }, ['★ Jump to smoothest']);
  jumpBtn.addEventListener('click', jumpSmoothest);

  // --- read-outs ---
  const ro = {
    vc: mkReadout('Cutting speed vc', 'm/min'),
    fpr: mkReadout('Feed / rev', 'mm'),
    fz: mkReadout('Feed / tooth', 'mm'),
  };
  const raBig = el('div', { class: 'ra-value' }, ['—']);
  const raUnc = el('div', { class: 'ra-unc' }, ['']);
  const rqrz = el('div', { class: 'ra-secondary' }, ['']);
  const zones = el('div', { class: 'ra-secondary' }, ['']);
  const flag = el('div', { class: 'conf-flag' }, ['']);
  const looLine = el('div', { class: 'hint' }, ['']);
  const sanity = el('div', { class: 'sanity-box' }, ['']);

  // --- units panel ---
  const unitPanel = createUnitsPanel(refresh);

  // --- global settings ---
  const settingsPanel = createSettingsPanel(refresh);

  const root = el('div', { class: 'controls' }, [
    section('Working point', [
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Milling mode' }, [
        downBtn,
        upBtn,
      ]),
      spindle.row,
      feed.row,
      jumpBtn,
    ]),
    section('Predicted finish', [
      el('div', { class: 'ra-card' }, [
        el('div', { class: 'ra-label' }, ['Ra (predicted)']),
        raBig,
        raUnc,
        rqrz,
        zones,
        flag,
        looLine,
        sanity,
      ]),
    ]),
    section('Process read-outs', [ro.vc.row, ro.fpr.row, ro.fz.row]),
    collapsible('Units', unitPanel.root, true),
    collapsible('Global settings', settingsPanel.root, false),
  ]);

  const update = (s: ControlsState): void => {
    downBtn.classList.toggle('active', s.working.millingMode === 'down');
    upBtn.classList.toggle('active', s.working.millingMode === 'up');

    setRange(spindle, s.rpmRange, s.working.spindleSpeed, (v) => `${Math.round(v)} rpm`);
    setRange(feed, s.feedRange, s.working.feedRate, (v) => `${Math.round(v)} mm/min`);

    ro.vc.set(s.kin.vc.toFixed(1));
    ro.fpr.set(s.kin.fpr.toFixed(4));
    ro.fz.set(s.kin.fz.toFixed(4));

    const yu = s.settings.units.yDisplay;
    if (s.modeCount === 0 || !isFinite(s.pred.Ra)) {
      raBig.textContent = '—';
      raUnc.textContent = 'no data in this mode';
      rqrz.textContent = '';
      zones.textContent = '';
    } else {
      raBig.textContent = `${fromUm(s.pred.Ra, yu).toFixed(3)} ${yu}`;
      raUnc.textContent =
        s.loo != null ? `± ${fromUm(s.loo, yu).toFixed(2)} ${yu} (LOO)` : '± n/a';
      rqrz.textContent = `Rq ${fromUm(s.pred.Rq, yu).toFixed(3)} · Rz ${fromUm(
        s.pred.Rz,
        yu,
      ).toFixed(2)} ${yu}`;
      zones.textContent =
        s.zoneCount != null ? `${s.zoneCount} anomaly zones · ${s.reliefLabel}` : '';
    }

    // confidence flag
    flag.className = 'conf-flag';
    if (s.modeCount < 4) {
      flag.classList.add('flag-warn');
      flag.textContent = `⚠ only ${s.modeCount} point(s) in this mode — interpolation not meaningful yet`;
    } else if (s.pred.extrapolated) {
      flag.classList.add('flag-warn');
      flag.textContent = '⚠ extrapolation — outside measured range (low confidence)';
    } else if (s.pred.onMeasured) {
      flag.classList.add('flag-ok');
      flag.textContent = '● measured condition (trusted)';
    } else {
      flag.classList.add('flag-interp');
      flag.textContent = '● interpolated (indicative)';
    }

    looLine.textContent =
      s.loo != null
        ? `Down/up modeled separately. LOO MAE ≈ ${fromUm(s.loo, yu).toFixed(2)} ${yu}` +
          (s.looRel != null ? ` (${(s.looRel * 100).toFixed(0)}% of mean Ra)` : '')
        : 'Add ≥4 points per mode for an uncertainty estimate.';

    jumpBtn.textContent = s.smoothestName
      ? `★ Jump to smoothest (${s.smoothestName})`
      : '★ Jump to smoothest';
    jumpBtn.toggleAttribute('disabled', !s.smoothestName);

    // Units sanity guards (trace length, kinematic height-scale floor).
    while (sanity.firstChild) sanity.removeChild(sanity.firstChild);
    for (const w of s.sanityWarnings) {
      const line = document.createElement('div');
      line.className = 'sanity-line';
      line.textContent = w;
      sanity.appendChild(line);
    }

    unitPanel.update();
    settingsPanel.update();
  };

  return { root, update };
}

// ---------- helpers ----------
function section(title: string, children: HTMLElement[]): HTMLElement {
  return el('div', { class: 'ctl-section' }, [
    el('div', { class: 'ctl-title' }, [title]),
    ...children,
  ]);
}

function collapsible(title: string, content: HTMLElement, open: boolean): HTMLElement {
  const details = el('details', { class: 'ctl-collapsible' }, [
    el('summary', { class: 'ctl-title' }, [title]),
    content,
  ]) as HTMLDetailsElement;
  details.open = open;
  return details;
}

function mkReadout(label: string, unit: string): { row: HTMLElement; set: (v: string) => void } {
  const val = el('span', { class: 'ro-val' }, ['—']);
  const row = el('div', { class: 'ro-row' }, [
    el('span', { class: 'ro-label' }, [label]),
    el('span', { class: 'ro-num' }, [val, el('span', { class: 'ro-unit' }, [' ' + unit])]),
  ]);
  return { row, set: (v) => (val.textContent = v) };
}

function setRange(
  s: { row: HTMLElement; set: (v: number) => void },
  range: [number, number],
  value: number,
  fmt: (v: number) => string,
): void {
  const slider = s.row.querySelector('input') as HTMLInputElement;
  // Widen the range to always include the current working value, so the browser
  // never clamps the thumb away from where the read-out/crosshair actually sit.
  slider.min = String(Math.min(Math.floor(range[0]), Math.floor(value)));
  slider.max = String(Math.max(Math.ceil(range[1]), Math.ceil(value)));
  slider.value = String(value);
  const readout = s.row.querySelector('.slider-val') as HTMLElement;
  if (readout) readout.textContent = fmt(value);
}

// ---------- Units panel ----------
function createUnitsPanel(refresh: () => void): { root: HTMLElement; update: () => void } {
  const mkSelect = (axis: 'x' | 'y'): HTMLSelectElement => {
    const sel = el('select', { class: 'field-input' }, [
      el('option', { value: 'm' }, ['m']),
      el('option', { value: 'mm' }, ['mm']),
      el('option', { value: 'µm' }, ['µm']),
    ]) as HTMLSelectElement;
    sel.addEventListener('change', () => {
      const units = { ...store.settings.units };
      if (axis === 'x') units.xDisplay = sel.value as DisplayUnit;
      else units.yDisplay = sel.value as DisplayUnit;
      store.setSettings({ units });
      refresh();
    });
    return sel;
  };
  const xSel = mkSelect('x');
  const ySel = mkSelect('y');

  const resetBtn = el('button', { class: 'btn full' }, ['Reset to standard']);
  resetBtn.addEventListener('click', () => {
    store.setSettings({ units: standardUnits() });
    refresh();
  });

  const root = el('div', { class: 'units-panel' }, [
    field('Lateral (x) display', xSel),
    field('Height / roughness display', ySel),
    el('div', { class: 'hint' }, [
      'Standard: x in mm, height in µm. Computation is always in µm. ',
      'Note: the manuscript’s Fig. 4 y-axis reads “mm” but the values are µm — a label typo; µm is correct.',
    ]),
    resetBtn,
  ]);

  const update = (): void => {
    xSel.value = store.settings.units.xDisplay;
    ySel.value = store.settings.units.yDisplay;
  };
  return { root, update };
}

// ---------- Global settings ----------
function createSettingsPanel(refresh: () => void): { root: HTMLElement; update: () => void } {
  const s = () => store.settings;

  const toolD = numberField('Tool Ø [mm]', s().toolDiameter, (v) => {
    store.setSettings({ toolDiameter: v });
    refresh();
  }, { min: 1, step: 0.5 });
  const teeth = numberField('Effective teeth z', s().effectiveTeeth, (v) => {
    store.setSettings({ effectiveTeeth: Math.max(1, Math.round(v)) });
    refresh();
  }, { min: 1, step: 1 });

  const lambdaSel = el('select', { class: 'field-input' }, [
    opt('200', 'λc 200 µm (paper)'),
    opt('250', 'λc 0.25 mm'),
    opt('800', 'λc 0.8 mm'),
    opt('2500', 'λc 2.5 mm'),
  ]) as HTMLSelectElement;
  lambdaSel.value = String(s().lambdaC);
  lambdaSel.addEventListener('change', () => {
    store.setSettings({ lambdaC: parseFloat(lambdaSel.value) });
    refresh();
  });

  const methodSel = el('select', { class: 'field-input' }, [
    opt('gaussian', 'ISO Gaussian filter'),
    opt('movingAverage', '201-pt moving average'),
    opt('linearDetrend', 'Linear detrend (non-standard)'),
  ]) as HTMLSelectElement;
  methodSel.value = s().roughnessMethod;
  methodSel.addEventListener('change', () => {
    store.setSettings({ roughnessMethod: methodSel.value as Settings['roughnessMethod'] });
    refresh();
  });

  const bw = sliderField('Smoothing (bandwidth h)', s().bandwidth, 0.05, 0.5, 0.01, (v) => {
    store.setSettings({ bandwidth: v });
    refresh();
  }, (v) => v.toFixed(2));

  // anomaly thresholds
  const aw = numberField('Hampel window [samples]', s().anomaly.hampelWindow, (v) => {
    store.setSettings({ anomaly: { ...s().anomaly, hampelWindow: Math.max(3, Math.round(v)) } });
    refresh();
  }, { min: 3, step: 2 });
  const az = numberField('Hampel Z threshold', s().anomaly.hampelZ, (v) => {
    store.setSettings({ anomaly: { ...s().anomaly, hampelZ: v } });
    refresh();
  }, { min: 1, step: 0.1 });
  const rqm = numberField('Window Rq multiple', s().anomaly.rqMultiple, (v) => {
    store.setSettings({ anomaly: { ...s().anomaly, rqMultiple: v } });
    refresh();
  }, { min: 1, step: 0.1 });
  const gap = numberField('Merge gap [µm]', s().anomaly.mergeGap, (v) => {
    store.setSettings({ anomaly: { ...s().anomaly, mergeGap: Math.max(0, v) } });
    refresh();
  }, { min: 0, step: 1 });

  const root = el('div', { class: 'settings-panel' }, [
    toolD.row,
    teeth.row,
    field('Roughness cut-off λc', lambdaSel),
    field('Roughness method', methodSel),
    bw.row,
    el('div', { class: 'ctl-subtitle' }, ['Anomaly thresholds']),
    aw.row,
    az.row,
    rqm.row,
    gap.row,
  ]);

  const update = (): void => {
    lambdaSel.value = String(s().lambdaC);
    methodSel.value = s().roughnessMethod;
    bw.set(s().bandwidth);
    // Re-sync number fields too (e.g. after Import session replaces settings).
    toolD.set(s().toolDiameter);
    teeth.set(s().effectiveTeeth);
    aw.set(s().anomaly.hampelWindow);
    az.set(s().anomaly.hampelZ);
    rqm.set(s().anomaly.rqMultiple);
    gap.set(s().anomaly.mergeGap);
  };
  return { root, update };
}

function opt(value: string, label: string): HTMLOptionElement {
  return el('option', { value }, [label]) as HTMLOptionElement;
}
function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label]),
    input,
  ]);
}
