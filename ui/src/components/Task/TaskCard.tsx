import type { CodingTask, CodingTaskStatus, TaskStepStatus } from '../../types/index.js';
import styles from './TaskCard.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map task status to the corresponding CSS module class. */
function statusBadgeClass(status: CodingTaskStatus): string {
  const map: Record<CodingTaskStatus, string> = {
    pending: styles.statusPending,
    in_progress: styles.statusInProgress,
    completed: styles.statusCompleted,
    failed: styles.statusFailed,
    canceled: styles.statusCanceled,
  };
  return `${styles.statusBadge} ${map[status] ?? styles.statusPending}`;
}

/** Human-readable label for a task status. */
function statusLabel(status: CodingTaskStatus): string {
  const map: Record<CodingTaskStatus, string> = {
    pending: 'Pending',
    in_progress: 'In Progress',
    completed: 'Completed',
    failed: 'Failed',
    canceled: 'Canceled',
  };
  return map[status] ?? status;
}

/** CSS class for the step index circle based on step status. */
function stepIndexClass(
  status: TaskStepStatus,
  isCurrent: boolean,
): string {
  if (status === 'completed') return `${styles.stepIndex} ${styles.stepIndexCompleted}`;
  if (status === 'failed') return `${styles.stepIndex} ${styles.stepIndexFailed}`;
  if (isCurrent) return `${styles.stepIndex} ${styles.stepIndexCurrent}`;
  return styles.stepIndex;
}

/** Terminal-state border class for the card. */
function terminalClass(status: CodingTaskStatus): string {
  switch (status) {
    case 'completed':
      return styles.terminalCompleted;
    case 'failed':
      return styles.terminalFailed;
    case 'canceled':
      return styles.terminalCanceled;
    default:
      return '';
  }
}

const TERMINAL_STATES: CodingTaskStatus[] = ['completed', 'failed', 'canceled'];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TaskCardProps {
  task: CodingTask;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Collapsible task card that displays task status, assigned agent,
 * current step position, and step details.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */
export function TaskCard({ task, isExpanded, onToggleExpand }: TaskCardProps) {
  const { steps, currentStepIndex, status, assignedAgentId } = task;
  const currentStep = steps[currentStepIndex];
  const isTerminal = TERMINAL_STATES.includes(status);
  const isExecuting = currentStep?.status === 'executing';

  const cardClassName = [
    styles.taskCard,
    isTerminal ? terminalClass(status) : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cardClassName}
      data-testid={`task-card-${task.id}`}
      data-status={status}
    >
      {/* Header — always visible, acts as expand/collapse toggle */}
      <div
        className={styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`Task ${task.id}, ${statusLabel(status)}`}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
      >
        <span
          className={`${styles.expandIcon} ${isExpanded ? styles.expandIconExpanded : ''}`}
          aria-hidden="true"
        >
          ▶
        </span>

        <div className={styles.headerInfo}>
          <div className={styles.titleRow}>
            <span className={statusBadgeClass(status)} data-testid="task-status">
              {statusLabel(status)}
            </span>

            {assignedAgentId && (
              <span className={styles.agentId} data-testid="task-agent-id">
                Agent: {assignedAgentId}
              </span>
            )}
          </div>

          {steps.length > 0 && (
            <span className={styles.stepPosition} data-testid="task-step-position">
              Step {currentStepIndex + 1} of {steps.length}
            </span>
          )}
        </div>
      </div>

      {/* Current step summary — always visible when steps exist */}
      {currentStep && (
        <div className={styles.currentStep}>
          <div
            className={styles.currentStepInstruction}
            data-testid="current-step-instruction"
          >
            {currentStep.instructions}
          </div>
          <div className={styles.currentStepMeta}>
            <span data-testid="current-step-status">{currentStep.status}</span>
            {isExecuting && (
              <span
                className={styles.progressIndicator}
                role="status"
                aria-label="Step executing"
                data-testid="progress-indicator"
              >
                <span className={styles.spinner} aria-hidden="true" />
                Executing…
              </span>
            )}
          </div>
        </div>
      )}

      {/* Expanded step list */}
      {isExpanded && steps.length > 0 && (
        <ol className={styles.stepList} data-testid="step-list">
          {steps.map((step, idx) => (
            <li key={step.id} className={styles.stepItem}>
              <span className={stepIndexClass(step.status, idx === currentStepIndex)}>
                {idx + 1}
              </span>
              <div className={styles.stepContent}>
                <span className={styles.stepInstruction}>{step.instructions}</span>
                <span className={styles.stepStatus}>{step.status}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
