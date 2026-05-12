import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionEntry, formatTimestamp } from './SessionEntry.js';
import type { SessionSummary } from '../../types/index.js';

// ---------------------------------------------------------------------------
// formatTimestamp tests
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('returns "Just now" for timestamps less than a minute ago', () => {
    const now = new Date().toISOString();
    expect(formatTimestamp(now)).toBe('Just now');
  });

  it('returns minutes ago for timestamps within the last hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatTimestamp(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours ago for timestamps within the last day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatTimestamp(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days ago for timestamps within the last week', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(formatTimestamp(twoDaysAgo)).toBe('2d ago');
  });

  it('returns formatted date for timestamps older than a week', () => {
    const oldDate = new Date('2025-01-15T12:00:00Z').toISOString();
    const result = formatTimestamp(oldDate);
    // Should contain month and day
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/15/);
  });

  it('returns raw string for invalid timestamps', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// SessionEntry component tests
// ---------------------------------------------------------------------------

describe('SessionEntry', () => {
  const baseSession: SessionSummary = {
    id: 'sess-1',
    title: 'Test Session',
    lastMessagePreview: 'Hello, world!',
    updatedAt: new Date().toISOString(),
    hasActiveTasks: false,
  };

  it('renders session title', () => {
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={vi.fn()} />,
    );
    expect(screen.getByTestId('session-title')).toHaveTextContent('Test Session');
  });

  it('renders last message preview', () => {
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={vi.fn()} />,
    );
    expect(screen.getByTestId('session-preview')).toHaveTextContent('Hello, world!');
  });

  it('renders formatted timestamp', () => {
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={vi.fn()} />,
    );
    expect(screen.getByTestId('session-timestamp')).toBeInTheDocument();
    expect(screen.getByTestId('session-timestamp')).toHaveAttribute(
      'datetime',
      baseSession.updatedAt,
    );
  });

  it('shows active-task indicator when hasActiveTasks is true', () => {
    const session = { ...baseSession, hasActiveTasks: true };
    render(
      <SessionEntry session={session} isActive={false} onClick={vi.fn()} />,
    );
    expect(screen.getByTestId('active-tasks-indicator')).toBeInTheDocument();
    expect(screen.getByLabelText('Active tasks in progress')).toBeInTheDocument();
  });

  it('does not show active-task indicator when hasActiveTasks is false', () => {
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={vi.fn()} />,
    );
    expect(screen.queryByTestId('active-tasks-indicator')).not.toBeInTheDocument();
  });

  it('applies active styling when isActive is true', () => {
    render(
      <SessionEntry session={baseSession} isActive={true} onClick={vi.fn()} />,
    );
    const entry = screen.getByTestId(`session-entry-${baseSession.id}`);
    expect(entry.className).toContain('active');
    expect(entry).toHaveAttribute('aria-current', 'true');
  });

  it('does not apply active styling when isActive is false', () => {
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={vi.fn()} />,
    );
    const entry = screen.getByTestId(`session-entry-${baseSession.id}`);
    expect(entry.className).not.toContain('active');
    expect(entry).not.toHaveAttribute('aria-current');
  });

  it('calls onClick with session ID when clicked', () => {
    const handleClick = vi.fn();
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={handleClick} />,
    );
    fireEvent.click(screen.getByTestId(`session-entry-${baseSession.id}`));
    expect(handleClick).toHaveBeenCalledWith('sess-1');
  });

  it('renders as a button element for accessibility', () => {
    render(
      <SessionEntry session={baseSession} isActive={false} onClick={vi.fn()} />,
    );
    const entry = screen.getByTestId(`session-entry-${baseSession.id}`);
    expect(entry.tagName).toBe('BUTTON');
    expect(entry).toHaveAttribute('type', 'button');
  });
});
