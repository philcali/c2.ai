import { create } from 'zustand';
import type { AuthState, AuthToken, LoginCredentials } from '../types/index.js';
import type { ApiClient } from '../api/client.js';

/**
 * Actions exposed by the auth store.
 */
export interface AuthActions {
  /** Authenticate with the backend and store the resulting token. */
  login: (credentials: LoginCredentials) => Promise<void>;
  /** Clear the token and reset auth state. */
  logout: () => void;
  /** Dismiss the current error message. */
  clearError: () => void;
}

export type AuthStore = AuthState & AuthActions;

/** Timer handle for the auto-logout expiry check. */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule an auto-logout that fires when the token expires.
 * If a timer is already running it is cleared first.
 */
function scheduleAutoLogout(expiresAt: string, logout: () => void): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  const expiresMs = new Date(expiresAt).getTime();
  const nowMs = Date.now();
  const delay = expiresMs - nowMs;

  if (delay <= 0) {
    // Token already expired — log out immediately.
    logout();
    return;
  }

  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    logout();
  }, delay);
}

/** Clear any pending expiry timer. */
function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

/**
 * Factory that creates the auth store.
 *
 * The store requires an `ApiClient` instance so it can call
 * `authenticate()` during login.  This avoids a circular dependency
 * between the store and the API client (the client reads the token
 * from the store via a `getToken` callback).
 */
export function createAuthStore(apiClient: ApiClient) {
  return create<AuthStore>((set, get) => ({
    // -- State --
    token: null,
    operatorId: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,

    // -- Actions --

    login: async (credentials: LoginCredentials) => {
      set({ isLoading: true, error: null });

      try {
        const authToken: AuthToken = await apiClient.authenticate(credentials);

        set({
          token: authToken.token,
          operatorId: authToken.operatorId,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });

        // Schedule auto-logout when the token expires.
        scheduleAutoLogout(authToken.expiresAt, get().logout);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Authentication failed';

        set({
          token: null,
          operatorId: null,
          isAuthenticated: false,
          isLoading: false,
          error: message,
        });
      }
    },

    logout: () => {
      clearExpiryTimer();
      set({
        token: null,
        operatorId: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    },

    clearError: () => {
      set({ error: null });
    },
  }));
}
