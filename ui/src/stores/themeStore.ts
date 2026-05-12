import { create } from 'zustand';
import type { ThemeMode } from '../types/index.js';

const STORAGE_KEY = 'c2-theme-mode';

/**
 * Actions exposed by the theme store.
 */
export interface ThemeActions {
  /** Toggle between light and dark mode. */
  toggleTheme: () => void;
  /** Set the theme to a specific mode. */
  setTheme: (mode: ThemeMode) => void;
}

export interface ThemeStoreState {
  mode: ThemeMode;
}

export type ThemeStore = ThemeStoreState & ThemeActions;

/**
 * Read the persisted theme preference from localStorage.
 * Falls back to `'light'` when no preference is stored or
 * localStorage is unavailable.
 */
export function readPersistedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (e.g. in SSR or restricted contexts).
  }
  return 'light';
}

/**
 * Persist the theme preference to localStorage.
 */
export function persistTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Silently ignore write failures.
  }
}

/**
 * Apply the theme mode to the document root element as a
 * `data-theme` attribute so CSS custom properties can switch.
 */
export function applyThemeToDocument(mode: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

export const useThemeStore = create<ThemeStore>((set) => {
  // Read persisted preference on store creation and apply it.
  const initial = readPersistedTheme();
  applyThemeToDocument(initial);

  return {
    // -- State --
    mode: initial,

    // -- Actions --

    toggleTheme: () =>
      set((state) => {
        const next: ThemeMode = state.mode === 'light' ? 'dark' : 'light';
        persistTheme(next);
        applyThemeToDocument(next);
        return { mode: next };
      }),

    setTheme: (mode) => {
      persistTheme(mode);
      applyThemeToDocument(mode);
      set({ mode });
    },
  };
});
