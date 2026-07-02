// Light/dark theme state, persisted to localStorage (independent of the
// session/export data — it's a device-level display preference, like the
// viewer's colormap choice, not research data).
//
// CSS custom properties style the DOM, but the hand-rolled Canvas 2D charts
// and the Three.js viewer paint with literal colors, so they can't read CSS
// variables. `canvasPalette()` is the matching color set for those renderers;
// keep it in sync with the `:root[data-theme]` blocks in style.css.
export type ThemeName = 'dark' | 'light';

const STORAGE_KEY = 'millscape.theme';

export interface CanvasPalette {
  text: string;
  textDim: string;
  textMute: string;
  line: string;
  lineStrong: string;
  lineFaint: string;
  accent: string;
  ok: string;
  warn: string;
  red: string;
  interp: string;
  /** Three.js scene/clear background. */
  three: number;
}

const DARK: CanvasPalette = {
  text: 'rgba(230,237,243,0.85)',
  textDim: 'rgba(230,237,243,0.7)',
  textMute: 'rgba(230,237,243,0.55)',
  line: 'rgba(255,255,255,0.28)',
  lineStrong: 'rgba(255,255,255,0.35)',
  lineFaint: 'rgba(255,255,255,0.18)',
  accent: '#ff7a2f',
  ok: '#5ec962',
  warn: '#ffcc55',
  red: '#ff4d4d',
  interp: '#8ab4f8',
  three: 0x0e1116,
};

const LIGHT: CanvasPalette = {
  text: 'rgba(23,32,45,0.88)',
  textDim: 'rgba(23,32,45,0.72)',
  textMute: 'rgba(23,32,45,0.55)',
  line: 'rgba(23,32,45,0.28)',
  lineStrong: 'rgba(23,32,45,0.4)',
  lineFaint: 'rgba(23,32,45,0.16)',
  accent: '#d35400',
  ok: '#2e7d32',
  warn: '#9a6a00',
  red: '#c62828',
  interp: '#2f6fd6',
  three: 0xf2f4f7,
};

export function canvasPalette(name: ThemeName): CanvasPalette {
  return name === 'light' ? LIGHT : DARK;
}

function systemPreference(): ThemeName {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function loadTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable (private mode / quota) — fall back to system pref */
  }
  return systemPreference();
}

type Listener = () => void;

class ThemeStore {
  private name: ThemeName = loadTheme();
  private listeners = new Set<Listener>();

  get(): ThemeName {
    return this.name;
  }

  /** Reflect the current theme onto <html data-theme="…">. Call once at boot. */
  apply(): void {
    document.documentElement.setAttribute('data-theme', this.name);
  }

  set(next: ThemeName): void {
    if (next === this.name) return;
    this.name = next;
    this.apply();
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* non-fatal */
    }
    for (const fn of this.listeners) fn();
  }

  toggle(): void {
    this.set(this.name === 'dark' ? 'light' : 'dark');
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const theme = new ThemeStore();
