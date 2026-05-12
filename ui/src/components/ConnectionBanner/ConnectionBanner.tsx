import { useWebSocket } from '../../hooks/useWebSocket.js';
import type { ConnectionStatus } from '../../types/index.js';
import styles from './ConnectionBanner.module.css';

/**
 * Map each non-connected status to its display label and style variant.
 */
const statusConfig: Record<
  Exclude<ConnectionStatus, 'connected'>,
  { label: string; variant: string }
> = {
  connecting: { label: 'Connecting\u2026', variant: styles.warning },
  reconnecting: { label: 'Reconnecting\u2026', variant: styles.warning },
  disconnected: { label: 'Disconnected', variant: styles.error },
};

/**
 * Displays a banner indicating the current WebSocket connection status.
 *
 * Hidden when the connection is healthy (`connected`). Shows a warning
 * banner for `connecting` / `reconnecting` and an error banner for
 * `disconnected`.
 *
 * Requirements: 7.4
 */
export function ConnectionBanner() {
  const { status } = useWebSocket();

  if (status === 'connected') {
    return null;
  }

  const { label, variant } = statusConfig[status];

  return (
    <div
      className={`${styles.banner} ${variant}`}
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
    >
      {label}
    </div>
  );
}
