import { useState, type FormEvent } from 'react';
import { useAuth } from '../../hooks/useAuth.js';
import styles from './LoginForm.module.css';

/**
 * Login form that accepts an operator token and authenticates
 * against the Command Center backend.
 *
 * Requirements: 1.1, 1.2, 1.3
 * - Displays a token input field with a submit button
 * - Shows a generic error message on failure
 * - Disables the form while authentication is in progress
 */
export function LoginForm() {
  const { login, isLoading, error, clearError } = useAuth();
  const [token, setToken] = useState('');

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLoading) return;
    login({ token });
  };

  /**
   * Sanitise the error message so it never leaks the submitted
   * token back to the UI.  Always fall back to a generic message.
   */
  const getSafeErrorMessage = (rawError: string): string => {
    const generic = 'Authentication failed. Please check your token and try again.';

    // If the raw error contains the literal token the operator just
    // submitted, replace it with the generic message.
    if (token && rawError.includes(token)) {
      return generic;
    }

    // For any backend error, still prefer the generic message to avoid
    // leaking internal details.
    return generic;
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Command Center</h1>
        <p className={styles.subtitle}>Enter your operator token to continue</p>

        <form className={styles.form} onSubmit={handleSubmit} aria-label="Login">
          {error && (
            <div className={styles.error} role="alert" aria-live="assertive">
              {getSafeErrorMessage(error)}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-token">
              Token
            </label>
            <input
              id="login-token"
              className={styles.input}
              type="password"
              autoComplete="off"
              required
              disabled={isLoading}
              value={token}
              placeholder="Paste your operator token"
              onChange={(e) => {
                setToken(e.target.value);
                if (error) clearError();
              }}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          <button
            className={styles.submitButton}
            type="submit"
            disabled={isLoading}
            aria-busy={isLoading}
          >
            {isLoading ? 'Authenticating\u2026' : 'Authenticate'}
          </button>
        </form>
      </div>
    </div>
  );
}
