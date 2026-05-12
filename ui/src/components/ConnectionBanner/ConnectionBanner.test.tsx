import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionBanner } from './ConnectionBanner.js';

// ---------------------------------------------------------------------------
// Mock the useWebSocket hook so we can control the returned status
// ---------------------------------------------------------------------------

let mockStatus = 'connected' as string;

vi.mock('../../hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    status: mockStatus,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

beforeEach(() => {
  mockStatus = 'connected';
});

describe('ConnectionBanner', () => {
  it('renders nothing when status is "connected"', () => {
    mockStatus = 'connected';
    const { container } = render(<ConnectionBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('displays "Connecting…" when status is "connecting"', () => {
    mockStatus = 'connecting';
    render(<ConnectionBanner />);

    const banner = screen.getByTestId('connection-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Connecting\u2026');
  });

  it('displays "Reconnecting…" when status is "reconnecting"', () => {
    mockStatus = 'reconnecting';
    render(<ConnectionBanner />);

    const banner = screen.getByTestId('connection-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Reconnecting\u2026');
  });

  it('displays "Disconnected" when status is "disconnected"', () => {
    mockStatus = 'disconnected';
    render(<ConnectionBanner />);

    const banner = screen.getByTestId('connection-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Disconnected');
  });

  it('uses role="status" and aria-live="polite" for accessibility', () => {
    mockStatus = 'disconnected';
    render(<ConnectionBanner />);

    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('applies warning styling for "connecting" status', () => {
    mockStatus = 'connecting';
    render(<ConnectionBanner />);

    const banner = screen.getByTestId('connection-banner');
    // CSS Modules mangles class names, but the class attribute should contain the variant
    expect(banner.className).toContain('warning');
  });

  it('applies warning styling for "reconnecting" status', () => {
    mockStatus = 'reconnecting';
    render(<ConnectionBanner />);

    const banner = screen.getByTestId('connection-banner');
    expect(banner.className).toContain('warning');
  });

  it('applies error styling for "disconnected" status', () => {
    mockStatus = 'disconnected';
    render(<ConnectionBanner />);

    const banner = screen.getByTestId('connection-banner');
    expect(banner.className).toContain('error');
  });
});
