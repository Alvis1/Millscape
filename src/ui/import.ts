// Import + edit popups (spec §8, §12). Dropping/picking files opens a popup
// listing them, each with mill-settings fields (rpm, feed, mode, name) and, on
// first import, editable unit factors. Editing a dataset reopens the same form.
import type { Dataset, MillingMode, UnitsConfig } from '../types';
import { store, makeId } from '../store/index';
import { parseRaw, toProfile } from '../parse/index';
import { openModal } from './modal';
import { el } from './dom';

interface Staged {
  fileName: string;
  raw: ReturnType<typeof parseRaw>;
  name: string;
  spindleSpeed: string;
  feedRate: string;
  millingMode: MillingMode;
}

/** Read + parse dropped/picked files, then show the import popup. */
export async function handleFiles(files: FileList | File[], onDone: () => void): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  const staged: Staged[] = [];
  for (const f of list) {
    const text = await f.text();
    const raw = parseRaw(text);
    const base = f.name.replace(/\.[^.]+$/, '');
    staged.push({
      fileName: f.name,
      raw,
      name: base,
      spindleSpeed: '',
      feedRate: '',
      millingMode: 'down',
    });
  }
  showImportPopup(staged, onDone);
}

function unitFactorRow(units: UnitsConfig): {
  row: HTMLElement;
  read: () => { x: number; y: number };
} {
  const xIn = el('input', {
    type: 'number',
    class: 'field-input',
    value: String(units.xInputFactor),
    step: 'any',
  }) as HTMLInputElement;
  const yIn = el('input', {
    type: 'number',
    class: 'field-input',
    value: String(units.yInputFactor),
    step: 'any',
  }) as HTMLInputElement;
  const row = el('div', { class: 'import-units' }, [
    el('div', { class: 'import-units-title' }, ['Unit factors (raw → µm)']),
    el('div', { class: 'import-units-grid' }, [
      el('label', { class: 'field mini' }, [
        el('span', { class: 'field-label' }, ['x-axis × ']),
        xIn,
      ]),
      el('label', { class: 'field mini' }, [
        el('span', { class: 'field-label' }, ['height × ']),
        yIn,
      ]),
    ]),
    el('div', { class: 'hint' }, [
      'Standard: raw metres → µm is ×1e6 (x); raw mm → µm is ×1e3 (height).',
    ]),
  ]);
  return {
    row,
    read: () => ({
      x: parseFloat(xIn.value) || units.xInputFactor,
      y: parseFloat(yIn.value) || units.yInputFactor,
    }),
  };
}

function showImportPopup(staged: Staged[], onDone: () => void): void {
  const modal = openModal('Import profiles', true);
  const units = store.settings.units;
  const uf = unitFactorRow(units);
  modal.body.appendChild(uf.row);

  const rows: HTMLElement[] = [];
  const inputs: {
    name: HTMLInputElement;
    rpm: HTMLInputElement;
    feed: HTMLInputElement;
    mode: HTMLSelectElement;
  }[] = [];

  for (const s of staged) {
    const nameIn = el('input', { type: 'text', class: 'field-input', value: s.name }) as HTMLInputElement;
    const rpmIn = el('input', { type: 'number', class: 'field-input', min: '0', placeholder: 'rpm' }) as HTMLInputElement;
    const feedIn = el('input', { type: 'number', class: 'field-input', min: '0', placeholder: 'mm/min' }) as HTMLInputElement;
    const modeSel = el('select', { class: 'field-input' }, [
      el('option', { value: 'down' }, ['Down-milling']),
      el('option', { value: 'up' }, ['Up-milling']),
      el('option', { value: 'reference' }, ['Reference (as-printed)']),
    ]) as HTMLSelectElement;
    inputs.push({ name: nameIn, rpm: rpmIn, feed: feedIn, mode: modeSel });

    const npts = s.raw.x.length;
    const gridNote = s.raw.grid
      ? ` · areal grid ${s.raw.grid.rows}×${s.raw.grid.cols}`
      : '';
    const warnEls = s.raw.warnings.map((w) =>
      el('div', { class: 'warn' }, ['⚠ ' + w]),
    );

    const modeToggleRefFields = (): void => {
      const isRef = modeSel.value === 'reference';
      rpmIn.disabled = isRef;
      feedIn.disabled = isRef;
      rpmIn.style.opacity = isRef ? '0.4' : '1';
      feedIn.style.opacity = isRef ? '0.4' : '1';
    };
    modeSel.addEventListener('change', modeToggleRefFields);

    const row = el('div', { class: 'import-row' }, [
      el('div', { class: 'import-file' }, [
        el('div', { class: 'import-fname' }, [s.fileName]),
        el('div', { class: 'import-meta' }, [`${npts} points${gridNote}`]),
        ...warnEls,
      ]),
      el('div', { class: 'import-fields' }, [
        field('Name', nameIn),
        field('Spindle [rpm]', rpmIn),
        field('Feed [mm/min]', feedIn),
        field('Mode', modeSel),
      ]),
    ]);
    rows.push(row);
    modal.body.appendChild(row);
  }

  const errBox = el('div', { class: 'form-error' });
  const importBtn = el('button', { class: 'btn btn-accent' }, [
    `Import ${staged.length} profile${staged.length > 1 ? 's' : ''}`,
  ]);
  importBtn.addEventListener('click', () => {
    const factors = uf.read();
    const newUnits: UnitsConfig = {
      ...units,
      xInputFactor: factors.x,
      yInputFactor: factors.y,
    };
    const datasets: Dataset[] = [];
    for (let i = 0; i < staged.length; i++) {
      const s = staged[i];
      const inp = inputs[i];
      if (s.raw.x.length < 2) {
        errBox.textContent = `"${s.fileName}" has no usable data — skipped.`;
        continue;
      }
      const mode = inp.mode.value as MillingMode;
      const isRef = mode === 'reference';
      const rpm = isRef ? null : parseFloat(inp.rpm.value);
      const feed = isRef ? null : parseFloat(inp.feed.value);
      if (!isRef && (!isFinite(rpm as number) || (rpm as number) <= 0)) {
        errBox.textContent = `Enter a positive spindle speed for "${inp.name.value}".`;
        return;
      }
      if (!isRef && (!isFinite(feed as number) || (feed as number) <= 0)) {
        errBox.textContent = `Enter a positive feed rate for "${inp.name.value}".`;
        return;
      }
      datasets.push({
        id: makeId('ds'),
        name: inp.name.value || s.fileName,
        part: 0,
        spindleSpeed: rpm,
        feedRate: feed,
        millingMode: mode,
        profile: toProfile(s.raw, newUnits),
      });
    }
    if (datasets.length === 0) {
      errBox.textContent = 'Nothing to import.';
      return;
    }
    // Persist the chosen unit factors as the working default.
    store.setSettings({ units: newUnits });
    store.addDatasets(datasets);
    modal.close();
    onDone();
  });

  modal.body.appendChild(errBox);
  modal.body.appendChild(el('div', { class: 'modal-actions' }, [importBtn]));
}

/** Edit an existing dataset's mill settings (profile unchanged). */
export function openEditPopup(dataset: Dataset, onDone: () => void): void {
  const modal = openModal(`Edit "${dataset.name}"`);
  const nameIn = el('input', { type: 'text', class: 'field-input', value: dataset.name }) as HTMLInputElement;
  const rpmIn = el('input', { type: 'number', class: 'field-input', min: '0', value: dataset.spindleSpeed == null ? '' : String(dataset.spindleSpeed) }) as HTMLInputElement;
  const feedIn = el('input', { type: 'number', class: 'field-input', min: '0', value: dataset.feedRate == null ? '' : String(dataset.feedRate) }) as HTMLInputElement;
  const modeSel = el('select', { class: 'field-input' }, [
    el('option', { value: 'down' }, ['Down-milling']),
    el('option', { value: 'up' }, ['Up-milling']),
    el('option', { value: 'reference' }, ['Reference (as-printed)']),
  ]) as HTMLSelectElement;
  modeSel.value = dataset.millingMode;

  const syncRef = (): void => {
    const isRef = modeSel.value === 'reference';
    rpmIn.disabled = isRef;
    feedIn.disabled = isRef;
  };
  modeSel.addEventListener('change', syncRef);
  syncRef();

  const errBox = el('div', { class: 'form-error' });
  const saveBtn = el('button', { class: 'btn btn-accent' }, ['Save changes']);
  saveBtn.addEventListener('click', () => {
    const mode = modeSel.value as MillingMode;
    const isRef = mode === 'reference';
    const rpm = isRef ? null : parseFloat(rpmIn.value);
    const feed = isRef ? null : parseFloat(feedIn.value);
    if (!isRef && (!isFinite(rpm as number) || (rpm as number) <= 0)) {
      errBox.textContent = 'Spindle speed must be positive.';
      return;
    }
    if (!isRef && (!isFinite(feed as number) || (feed as number) <= 0)) {
      errBox.textContent = 'Feed rate must be positive.';
      return;
    }
    // Duplicate warning (non-blocking).
    const dup = store.datasets.find(
      (d) =>
        d.id !== dataset.id &&
        d.spindleSpeed === rpm &&
        d.feedRate === feed &&
        d.millingMode === mode,
    );
    store.updateDataset(dataset.id, {
      name: nameIn.value || dataset.name,
      spindleSpeed: rpm,
      feedRate: feed,
      millingMode: mode,
    });
    modal.close();
    onDone();
    if (dup) alert(`Note: same rpm+feed+mode as "${dup.name}".`);
  });

  modal.body.append(
    field('Name', nameIn),
    field('Spindle speed [rpm]', rpmIn),
    field('Feed rate [mm/min]', feedIn),
    field('Milling mode', modeSel),
    errBox,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-danger', id: '_del' }, ['Delete']),
      saveBtn,
    ]),
  );
  (modal.body.querySelector('#_del') as HTMLButtonElement).addEventListener(
    'click',
    () => {
      if (confirm(`Delete "${dataset.name}"?`)) {
        store.removeDataset(dataset.id);
        modal.close();
        onDone();
      }
    },
  );
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label]),
    input,
  ]);
}
