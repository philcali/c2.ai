import { useThemeStore } from '../stores/themeStore.js';
import type { ThemeMode } from '../types/index.js';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseThemeResult {
  /** The current theme mode. */
  mode: ThemeMode;
  /** Toggle between light and dark mode. */
  toggleTheme: () => void;
  /** Set the theme to a specific mode. */
  setTheme: (mode: ThemeMode) => void;
}

/**
 * React hook that wraps the theme store.
 *
 * Provides the current theme mode and actions to toggle or set it.
 * The underlying store handles persistence to localStorage and
 * applying the `data-theme` attribute to the document root.
 *
 * Requirements: 10.4, 10.5
 */
export function useTheme(): UseThemeResult {
  const mode = useThemeStore((s) => s.mode);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return { mode, toggleTheme, setTheme };
}
