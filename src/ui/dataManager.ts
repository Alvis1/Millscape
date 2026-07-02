// Data manager (spec §12): list all datasets with metrics, edit/delete, plus
// Add data, Load example, and Export/Import session.
import { store } from '../store/index';
import { buildExampleDatasets } from '../data/example';
import { openEditPopup, handleFiles } from './import';
import { el, clear } from './dom';
import { fmtUm } from '../units';

export function renderDataManager(container: HTMLElement, onChange: () => void): void {
  clear(container);
  const units = store.settings.units;

  // --- toolbar ---
  const fileInput = el('input', {
    type: 'file',
    accept: '.csv,.txt,.dat,.asc,text/plain',
    multiple: 'true',
    style: 'display:none',
  }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) {
      void handleFiles(fileInput.files, onChange);
      fileInput.value = '';
    }
  });

  const addBtn = el('button', { class: 'btn' }, ['+ Add data']);
  addBtn.addEventListener('click', () => fileInput.click());

  const exampleBtn = el('button', { class: 'btn' }, ['Load example']);
  exampleBtn.addEventListener('click', () => {
    // Replace any prior example set so repeated clicks don't duplicate.
    for (const d of [...store.datasets]) if (d.isExample) store.removeDataset(d.id);
    store.addDatasets(buildExampleDatasets(store.settings));
    onChange();
  });

  const exportBtn = el('button', { class: 'btn' }, ['Export session']);
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'millscape-session.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  const importInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    style: 'display:none',
  }) as HTMLInputElement;
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      store.importJSON(await f.text());
      onChange();
    } catch {
      alert('Could not read session file (invalid JSON).');
    }
    importInput.value = '';
  });
  const importBtn = el('button', { class: 'btn' }, ['Import session']);
  importBtn.addEventListener('click', () => importInput.click());

  const clearBtn = el('button', { class: 'btn btn-danger' }, ['Clear all']);
  clearBtn.addEventListener('click', () => {
    if (store.datasets.length && confirm('Remove all datasets?')) {
      store.clearDatasets();
      onChange();
    }
  });

  container.append(
    el('div', { class: 'dm-toolbar' }, [
      addBtn,
      exampleBtn,
      exportBtn,
      importBtn,
      clearBtn,
      fileInput,
      importInput,
    ]),
  );

  // --- table ---
  if (store.datasets.length === 0) {
    container.append(
      el('div', { class: 'dm-empty' }, [
        'No datasets yet. Drag CSV/TXT profiles onto the bar above, ',
        '“+ Add data”, or “Load example”.',
      ]),
    );
    return;
  }

  const head = el('div', { class: 'dm-row dm-head' }, [
    cell('Name', 'name'),
    cell('rpm', 'num'),
    cell('feed', 'num'),
    cell('mode', 'mode'),
    cell('Ra', 'num'),
    cell('Rq', 'num'),
    cell('Rz', 'num'),
    cell('zones', 'num'),
    cell('Δ vs F1', 'num'),
    cell('', 'act'),
  ]);
  const table = el('div', { class: 'dm-table' }, [head]);

  for (const d of store.datasets) {
    const r = d.roughness;
    const a = d.anomaly;
    const selected = store.selectedId === d.id;
    const modeTag = el('span', { class: `tag tag-${d.millingMode}` }, [
      d.millingMode === 'reference' ? 'ref' : d.millingMode,
    ]);
    const delta = d.delta
      ? `${d.delta.reduction >= 0 ? '−' : '+'}${Math.abs(
          d.delta.reduction * 100,
        ).toFixed(0)}%`
      : '—';

    const editBtn = el('button', { class: 'btn-icon', title: 'Edit' }, ['✎']);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditPopup(d, onChange);
    });
    const delBtn = el('button', { class: 'btn-icon', title: 'Delete' }, ['🗑']);
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${d.name}"?`)) {
        store.removeDataset(d.id);
        onChange();
      }
    });

    const row = el('div', { class: `dm-row${selected ? ' dm-sel' : ''}` }, [
      cell(d.name + (d.isExample ? ' ·ex' : ''), 'name'),
      cell(d.spindleSpeed == null ? '—' : String(d.spindleSpeed), 'num'),
      cell(d.feedRate == null ? '—' : String(d.feedRate), 'num'),
      el('div', { class: 'dm-cell mode' }, [modeTag]),
      cell(r ? fmtUmNum(r.Ra, units) : '—', 'num'),
      cell(r ? fmtUmNum(r.Rq, units) : '—', 'num'),
      cell(r ? fmtUmNum(r.Rz, units) : '—', 'num'),
      cell(a ? String(a.zoneCount) : '—', 'num'),
      cell(delta, 'num'),
      el('div', { class: 'dm-cell act' }, [editBtn, delBtn]),
    ]);
    row.addEventListener('click', () => {
      store.select(d.id);
      onChange();
    });
    table.append(row);
  }
  container.append(table);
}

function cell(text: string, cls: string): HTMLElement {
  return el('div', { class: `dm-cell ${cls}` }, [text]);
}

function fmtUmNum(um: number, units: { yDisplay: 'm' | 'mm' | 'µm' }): string {
  return fmtUm(um, units.yDisplay, 3).replace(` ${units.yDisplay}`, '');
}
