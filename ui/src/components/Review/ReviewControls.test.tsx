import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewControls } from './ReviewControls.js';
import type { ReviewControlsProps } from './ReviewControls.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<ReviewControlsProps> = {}): ReviewControlsProps {
  return {
    onApprove: vi.fn(),
    onRetry: vi.fn(),
    onRedirect: vi.fn(),
    currentStepIndex: 0,
    isAdvancing: false,
    isRetrying: false,
    isRedirecting: false,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewControls', () => {
  // ---- Rendering ----

  it('renders all three action buttons', () => {
    render(<ReviewControls {...defaultProps()} />);

    expect(screen.getByTestId('review-approve-btn')).toBeInTheDocument();
    expect(screen.getByTestId('review-retry-btn')).toBeInTheDocument();
    expect(screen.getByTestId('review-redirect-btn')).toBeInTheDocument();
  });

  it('renders the "Review Required" label', () => {
    render(<ReviewControls {...defaultProps()} />);
    expect(screen.getByText('Review Required')).toBeInTheDocument();
  });

  it('has accessible labels on buttons', () => {
    render(<ReviewControls {...defaultProps()} />);
    expect(screen.getByLabelText('Approve step')).toBeInTheDocument();
    expect(screen.getByLabelText('Retry step with feedback')).toBeInTheDocument();
    expect(screen.getByLabelText('Redirect task with new steps')).toBeInTheDocument();
  });

  // ---- Approve ----

  it('calls onApprove when Approve button is clicked', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ReviewControls {...defaultProps({ onApprove })} />);

    await user.click(screen.getByTestId('review-approve-btn'));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  // ---- Retry ----

  it('shows retry form when Retry button is clicked', async () => {
    const user = userEvent.setup();
    render(<ReviewControls {...defaultProps()} />);

    expect(screen.queryByTestId('retry-form')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('review-retry-btn'));
    expect(screen.getByTestId('retry-form')).toBeInTheDocument();
    expect(screen.getByTestId('retry-feedback-input')).toBeInTheDocument();
  });

  it('calls onRetry with feedback when retry form is submitted', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ReviewControls {...defaultProps({ onRetry })} />);

    await user.click(screen.getByTestId('review-retry-btn'));

    const input = screen.getByTestId('retry-feedback-input');
    await user.type(input, 'Fix the variable name');

    await user.click(screen.getByTestId('retry-submit-btn'));
    expect(onRetry).toHaveBeenCalledWith('Fix the variable name');
  });

  it('does not submit retry with empty feedback', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ReviewControls {...defaultProps({ onRetry })} />);

    await user.click(screen.getByTestId('review-retry-btn'));

    const submitBtn = screen.getByTestId('retry-submit-btn');
    expect(submitBtn).toBeDisabled();

    await user.click(submitBtn);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('hides retry form when cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<ReviewControls {...defaultProps()} />);

    await user.click(screen.getByTestId('review-retry-btn'));
    expect(screen.getByTestId('retry-form')).toBeInTheDocument();

    await user.click(screen.getByTestId('retry-cancel-btn'));
    expect(screen.queryByTestId('retry-form')).not.toBeInTheDocument();
  });

  it('toggles retry form off when Retry button is clicked again', async () => {
    const user = userEvent.setup();
    render(<ReviewControls {...defaultProps()} />);

    await user.click(screen.getByTestId('review-retry-btn'));
    expect(screen.getByTestId('retry-form')).toBeInTheDocument();

    await user.click(screen.getByTestId('review-retry-btn'));
    expect(screen.queryByTestId('retry-form')).not.toBeInTheDocument();
  });

  // ---- Redirect ----

  it('shows redirect form when Redirect button is clicked', async () => {
    const user = userEvent.setup();
    render(<ReviewControls {...defaultProps()} />);

    expect(screen.queryByTestId('redirect-form')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('review-redirect-btn'));
    expect(screen.getByTestId('redirect-form')).toBeInTheDocument();
    expect(screen.getByTestId('redirect-step-input-0')).toBeInTheDocument();
  });

  it('allows adding and removing redirect steps', async () => {
    const user = userEvent.setup();
    render(<ReviewControls {...defaultProps()} />);

    await user.click(screen.getByTestId('review-redirect-btn'));

    // Initially one step
    expect(screen.getByTestId('redirect-step-input-0')).toBeInTheDocument();
    expect(screen.queryByTestId('redirect-step-input-1')).not.toBeInTheDocument();

    // Add a step
    await user.click(screen.getByTestId('redirect-add-step-btn'));
    expect(screen.getByTestId('redirect-step-input-1')).toBeInTheDocument();

    // Remove the first step
    await user.click(screen.getByTestId('redirect-remove-step-0'));
    expect(screen.queryByTestId('redirect-step-input-0')).toBeInTheDocument(); // re-indexed
    expect(screen.queryByTestId('redirect-step-input-1')).not.toBeInTheDocument();
  });

  it('calls onRedirect with step definitions and fromIndex', async () => {
    const user = userEvent.setup();
    const onRedirect = vi.fn();
    render(<ReviewControls {...defaultProps({ onRedirect, currentStepIndex: 2 })} />);

    await user.click(screen.getByTestId('review-redirect-btn'));

    await user.type(screen.getByTestId('redirect-step-input-0'), 'Refactor the module');

    await user.click(screen.getByTestId('redirect-add-step-btn'));
    await user.type(screen.getByTestId('redirect-step-input-1'), 'Add unit tests');

    await user.click(screen.getByTestId('redirect-submit-btn'));

    expect(onRedirect).toHaveBeenCalledWith(
      [{ instructions: 'Refactor the module' }, { instructions: 'Add unit tests' }],
      2,
    );
  });

  it('does not submit redirect with all empty steps', async () => {
    const user = userEvent.setup();
    const onRedirect = vi.fn();
    render(<ReviewControls {...defaultProps({ onRedirect })} />);

    await user.click(screen.getByTestId('review-redirect-btn'));

    const submitBtn = screen.getByTestId('redirect-submit-btn');
    expect(submitBtn).toBeDisabled();

    await user.click(submitBtn);
    expect(onRedirect).not.toHaveBeenCalled();
  });

  it('hides redirect form when cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<ReviewControls {...defaultProps()} />);

    await user.click(screen.getByTestId('review-redirect-btn'));
    expect(screen.getByTestId('redirect-form')).toBeInTheDocument();

    await user.click(screen.getByTestId('redirect-cancel-btn'));
    expect(screen.queryByTestId('redirect-form')).not.toBeInTheDocument();
  });

  // ---- Processing state ----

  it('disables all buttons when isAdvancing is true', () => {
    render(<ReviewControls {...defaultProps({ isAdvancing: true })} />);

    expect(screen.getByTestId('review-approve-btn')).toBeDisabled();
    expect(screen.getByTestId('review-retry-btn')).toBeDisabled();
    expect(screen.getByTestId('review-redirect-btn')).toBeDisabled();
  });

  it('disables all buttons when isRetrying is true', () => {
    render(<ReviewControls {...defaultProps({ isRetrying: true })} />);

    expect(screen.getByTestId('review-approve-btn')).toBeDisabled();
    expect(screen.getByTestId('review-retry-btn')).toBeDisabled();
    expect(screen.getByTestId('review-redirect-btn')).toBeDisabled();
  });

  it('disables all buttons when isRedirecting is true', () => {
    render(<ReviewControls {...defaultProps({ isRedirecting: true })} />);

    expect(screen.getByTestId('review-approve-btn')).toBeDisabled();
    expect(screen.getByTestId('review-retry-btn')).toBeDisabled();
    expect(screen.getByTestId('review-redirect-btn')).toBeDisabled();
  });

  it('shows processing indicator when any action is in flight', () => {
    render(<ReviewControls {...defaultProps({ isAdvancing: true })} />);

    expect(screen.getByTestId('review-processing')).toBeInTheDocument();
    expect(screen.getByText('Processing…')).toBeInTheDocument();
  });

  it('does not show processing indicator when idle', () => {
    render(<ReviewControls {...defaultProps()} />);
    expect(screen.queryByTestId('review-processing')).not.toBeInTheDocument();
  });

  // ---- Error display ----

  it('displays error message when error prop is set', () => {
    render(<ReviewControls {...defaultProps({ error: 'Network error' })} />);

    const errorEl = screen.getByTestId('review-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl).toHaveTextContent('Network error');
  });

  it('error has role="alert" for accessibility', () => {
    render(<ReviewControls {...defaultProps({ error: 'Something failed' })} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not display error when error is null', () => {
    render(<ReviewControls {...defaultProps({ error: null })} />);
    expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
  });

  it('hides error while processing', () => {
    render(
      <ReviewControls
        {...defaultProps({ error: 'Previous error', isAdvancing: true })}
      />,
    );
    expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
  });
});
