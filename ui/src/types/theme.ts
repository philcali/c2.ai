/** Display mode for the application theme. */
export type ThemeMode = 'light' | 'dark';

/** Client-side theme state. */
export interface ThemeState {
  mode: ThemeMode;
}
