// In-memory session store mirrored to localStorage, with a tiny pub/sub so the
// UI can re-render on change. JSON Export/Import round-trips the whole session.
import type { Dataset, Session, Settings, WorkingPoint } from '../types';
import { standardUnits } from '../units';

const STORAGE_KEY = 'millscape.session.v2';
const SESSION_VERSION = 2;

export function defaultSettings(): Settings {
  return {
    toolDiameter: 20,
    effectiveTeeth: 2,
    lambdaC: 200,
    roughnessMethod: 'gaussian',
    bandwidth: 0.16,
    units: standardUnits(),
    anomaly: {
      hampelWindow: 31,
      hampelZ: 3.5,
      windowMin: 50,
      windowMax: 100,
      rqMultiple: 2,
      mergeGap: 20,
    },
  };
}

function defaultWorking(): WorkingPoint {
  return { spindleSpeed: 800, feedRate: 320, millingMode: 'down' };
}

function emptySession(): Session {
  return {
    version: SESSION_VERSION,
    datasets: [],
    settings: defaultSettings(),
    working: defaultWorking(),
    seeded: false,
  };
}

type Listener = () => void;

class Store {
  private session: Session;
  private listeners = new Set<Listener>();
  /** Currently selected dataset id (for the 3D viewer / editing), or null. */
  selectedId: string | null = null;
  /** Bumps whenever the dataset set/profiles/mode change (⇒ recompute needed). */
  dataEpoch = 0;

  constructor() {
    this.session = this.load() ?? emptySession();
  }

  // --- accessors ---
  get datasets(): Dataset[] {
    return this.session.datasets;
  }
  get settings(): Settings {
    return this.session.settings;
  }
  get working(): WorkingPoint {
    return this.session.working;
  }
  getSession(): Session {
    return this.session;
  }

  datasetById(id: string): Dataset | undefined {
    return this.session.datasets.find((d) => d.id === id);
  }

  reference(): Dataset | undefined {
    return this.session.datasets.find((d) => d.millingMode === 'reference');
  }

  isSeeded(): boolean {
    return !!this.session.seeded;
  }
  markSeeded(): void {
    this.session.seeded = true;
    this.commit();
  }

  // --- mutations ---
  addDatasets(items: Dataset[]): void {
    this.session.datasets.push(...items);
    this.dataEpoch++;
    this.commit();
  }

  updateDataset(id: string, patch: Partial<Dataset>): void {
    const d = this.datasetById(id);
    if (!d) return;
    Object.assign(d, patch);
    this.dataEpoch++;
    this.commit();
  }

  removeDataset(id: string): void {
    this.session.datasets = this.session.datasets.filter((d) => d.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.dataEpoch++;
    this.commit();
  }

  clearDatasets(): void {
    this.session.datasets = [];
    this.selectedId = null;
    this.dataEpoch++;
    this.commit();
  }

  setSettings(patch: Partial<Settings>): void {
    this.session.settings = { ...this.session.settings, ...patch };
    this.commit();
  }

  setWorking(patch: Partial<WorkingPoint>): void {
    this.session.working = { ...this.session.working, ...patch };
    this.commit();
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.emit();
  }

  replaceSession(next: Session): void {
    this.session = normalizeSession(next);
    this.selectedId = null;
    this.dataEpoch++;
    this.commit();
  }

  // --- persistence ---
  private commit(): void {
    this.save();
    this.emit();
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    } catch {
      /* storage may be unavailable (private mode / quota) — non-fatal */
    }
  }

  private load(): Session | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeSession(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  exportJSON(): string {
    // Strip cached derived fields; they are recomputed on import.
    const clean: Session = {
      version: SESSION_VERSION,
      settings: this.session.settings,
      working: this.session.working,
      seeded: this.session.seeded,
      datasets: this.session.datasets.map((d) => ({
        id: d.id,
        name: d.name,
        part: d.part,
        spindleSpeed: d.spindleSpeed,
        feedRate: d.feedRate,
        millingMode: d.millingMode,
        profile: d.profile,
        isExample: d.isExample,
      })),
    };
    return JSON.stringify(clean, null, 2);
  }

  importJSON(text: string): void {
    const parsed = JSON.parse(text) as Session;
    this.replaceSession(parsed);
  }

  // --- pub/sub ---
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Fill in any missing fields so old/partial sessions load safely. */
function normalizeSession(s: Session): Session {
  const base = emptySession();
  const merged: Session = {
    version: SESSION_VERSION,
    datasets: Array.isArray(s.datasets) ? s.datasets : [],
    settings: {
      ...base.settings,
      ...(s.settings ?? {}),
      units: { ...base.settings.units, ...(s.settings?.units ?? {}) },
      anomaly: { ...base.settings.anomaly, ...(s.settings?.anomaly ?? {}) },
    },
    working: { ...base.working, ...(s.working ?? {}) },
    // A loaded/imported session that already carries datasets is treated as
    // seeded, so the boot auto-seed never overwrites a returning user's set.
    seeded: s.seeded ?? (Array.isArray(s.datasets) && s.datasets.length > 0),
  };
  // Drop cached derived fields — force recompute.
  for (const d of merged.datasets) {
    delete d.roughness;
    delete d.anomaly;
    delete d.delta;
  }
  return merged;
}

export const store = new Store();

let idCounter = 0;
/** Deterministic-ish id generator (Date.now/Math.random are avoided in some
 *  harnesses; a counter + performance clock is enough for local uniqueness). */
export function makeId(prefix = 'ds'): string {
  idCounter += 1;
  const t = Math.floor(performance.now() * 1000) % 1_000_000;
  return `${prefix}_${t}_${idCounter}`;
}
