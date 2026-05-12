import { useState, useCallback } from 'react';
import styles from './ReviewControls.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepDefinition {
  instructions: string;
}

export interface ReviewControlsProps {
  /** Called when the operator approves the current step. */
  onApprove: () => void;
  /** Called when the operator retries the current step with feedback. */
  onRetry: (feedback: string) => void;
  /** Called when the operator redirects the task with new steps. */
  onRedirect: (steps: StepDefinition[], fromIndex: number) => void;
  /** The current step index (used as the fromIndex for redirect). */
  currentStepIndex: number;
  /** Whether an approve action is in flight. */
  isAdvancing: boolean;
  /** Whether a retry action is in flight. */
  isRetrying: boolean;
  /** Whether a redirect action is in flight. */
  isRedirecting: boolean;
  /** The last mutation error message, if any. */
  error: string | null;
}

type ActiveForm = 'none' | 'retry' | 'redirect';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Interactive review controls that allow the operator to approve, retry
 * with feedback, or redirect a task step during the human-in-the-loop
 * review cycle.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export function ReviewControls({
  onApprove,
  onRetry,
  onRedirect,
  currentStepIndex,
  isAdvancing,
  isRetrying,
  isRedirecting,
  error,
}: ReviewControlsProps) {
  const [activeForm, setActiveForm] = useState<ActiveForm>('none');
  const [feedback, setFeedback] = useState('');
  const [redirectSteps, setRedirectSteps] = useState<string[]>(['']);

  const isProcessing = isAdvancing || isRetrying || isRedirecting;

  // ---- Handlers ----

  const handleApprove = useCallback(() => {
    onApprove();
  }, [onApprove]);

  const handleRetryClick = useCallback(() => {
    setActiveForm((prev) => (prev === 'retry' ? 'none' : 'retry'));
    setFeedback('');
  }, []);

  const handleRedirectClick = useCallback(() => {
    setActiveForm((prev) => (prev === 'redirect' ? 'none' : 'redirect'));
    setRedirectSteps(['']);
  }, []);

  const handleRetrySubmit = useCallback(() => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    onRetry(trimmed);
  }, [feedback, onRetry]);

  const handleRedirectSubmit = useCallback(() => {
    const steps: StepDefinition[] = redirectSteps
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((instructions) => ({ instructions }));
    if (steps.length === 0) return;
    onRedirect(steps, currentStepIndex);
  }, [redirectSteps, currentStepIndex, onRedirect]);

  const handleAddStep = useCallback(() => {
    setRedirectSteps((prev) => [...prev, '']);
  }, []);

  const handleRemoveStep = useCallback((index: number) => {
    setRedirectSteps((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleStepChange = useCallback((index: number, value: string) => {
    setRedirectSteps((prev) =>
      prev.map((s, i) => (i === index ? value : s)),
    );
  }, []);

  const handleCancel = useCallback(() => {
    setActiveForm('none');
    setFeedback('');
    setRedirectSteps(['']);
  }, []);

  return (
    <div className={styles.reviewControls} data-testid="review-controls">
      <span className={styles.label}>Review Required</span>

      {/* Action buttons */}
      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnApprove}`}
          onClick={handleApprove}
          disabled={isProcessing}
          data-testid="review-approve-btn"
          aria-label="Approve step"
        >
          Approve
        </button>
        <button
          className={`${styles.btn} ${styles.btnRetry}`}
          onClick={handleRetryClick}
          disabled={isProcessing}
          data-testid="review-retry-btn"
          aria-label="Retry step with feedback"
        >
          Retry
        </button>
        <button
          className={`${styles.btn} ${styles.btnRedirect}`}
          onClick={handleRedirectClick}
          disabled={isProcessing}
          data-testid="review-redirect-btn"
          aria-label="Redirect task with new steps"
        >
          Redirect
        </button>
      </div>

      {/* Processing indicator */}
      {isProcessing && (
        <div
          className={styles.processing}
          role="status"
          aria-label="Processing review action"
          data-testid="review-processing"
        >
          <span className={styles.spinner} aria-hidden="true" />
          Processing…
        </div>
      )}

      {/* Inline error */}
      {error && !isProcessing && (
        <div
          className={styles.error}
          role="alert"
          data-testid="review-error"
        >
          {error}
        </div>
      )}

      {/* Retry feedback form */}
      {activeForm === 'retry' && (
        <div className={styles.feedbackForm} data-testid="retry-form">
          <label className={styles.feedbackLabel} htmlFor="retry-feedback">
            Provide feedback for retry
          </label>
          <textarea
            id="retry-feedback"
            className={styles.feedbackInput}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what should be changed…"
            disabled={isProcessing}
            data-testid="retry-feedback-input"
          />
          <div className={styles.feedbackActions}>
            <button
              className={styles.btn}
              onClick={handleCancel}
              disabled={isProcessing}
              data-testid="retry-cancel-btn"
            >
              Cancel
            </button>
            <button
              className={`${styles.btn} ${styles.btnRetry}`}
              onClick={handleRetrySubmit}
              disabled={isProcessing || feedback.trim().length === 0}
              data-testid="retry-submit-btn"
            >
              Submit Retry
            </button>
          </div>
        </div>
      )}

      {/* Redirect form */}
      {activeForm === 'redirect' && (
        <div className={styles.redirectForm} data-testid="redirect-form">
          <span className={styles.redirectLabel}>
            Define new steps to replace from current position
          </span>
          {redirectSteps.map((step, idx) => (
            <div key={idx} className={styles.stepEntry}>
              <span className={styles.stepNumber}>{idx + 1}</span>
              <textarea
                className={styles.stepInput}
                value={step}
                onChange={(e) => handleStepChange(idx, e.target.value)}
                placeholder={`Step ${idx + 1} instructions…`}
                disabled={isProcessing}
                data-testid={`redirect-step-input-${idx}`}
                aria-label={`Step ${idx + 1} instructions`}
              />
              {redirectSteps.length > 1 && (
                <button
                  className={styles.removeStepBtn}
                  onClick={() => handleRemoveStep(idx)}
                  disabled={isProcessing}
                  aria-label={`Remove step ${idx + 1}`}
                  data-testid={`redirect-remove-step-${idx}`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            className={styles.addStepBtn}
            onClick={handleAddStep}
            disabled={isProcessing}
            data-testid="redirect-add-step-btn"
          >
            + Add Step
          </button>
          <div className={styles.redirectActions}>
            <button
              className={styles.btn}
              onClick={handleCancel}
              disabled={isProcessing}
              data-testid="redirect-cancel-btn"
            >
              Cancel
            </button>
            <button
              className={`${styles.btn} ${styles.btnRedirect}`}
              onClick={handleRedirectSubmit}
              disabled={
                isProcessing ||
                redirectSteps.every((s) => s.trim().length === 0)
              }
              data-testid="redirect-submit-btn"
            >
              Submit Redirect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
