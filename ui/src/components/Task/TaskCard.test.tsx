import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskCard } from './TaskCard.js';
import type { CodingTask, TaskStep } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = '2026-06-01T10:00:00Z';

function makeStep(overrides: Partial<TaskStep> & { id: string }): TaskStep {
  return {
    taskId: 'task-1',
    sequenceIndex: 0,
    instructions: 'Do something',
    status: 'pending',
    artifacts: [],
    feedbackHistory: [],
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeTask(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    id: 'task-1',
    operatorId: 'op-1',
    status: 'in_progress',
    assignedAgentId: 'agent-alpha',
    steps: [
      makeStep({ id: 'step-1', sequenceIndex: 0, instructions: 'Init repo', status: 'completed' }),
      makeStep({ id: 'step-2', sequenceIndex: 1, instructions: 'Write tests', status: 'executing' }),
      makeStep({ id: 'step-3', sequenceIndex: 2, instructions: 'Implement feature', status: 'pending' }),
    ],
    currentStepIndex: 1,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskCard', () => {
  it('renders task status badge', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.getByTestId('task-status')).toHaveTextContent('In Progress');
  });

  it('renders assigned agent ID', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.getByTestId('task-agent-id')).toHaveTextContent('Agent: agent-alpha');
  });

  it('does not render agent ID when not assigned', () => {
    const task = makeTask({ assignedAgentId: undefined });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.queryByTestId('task-agent-id')).not.toBeInTheDocument();
  });

  it('renders step position "Step X of N"', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.getByTestId('task-step-position')).toHaveTextContent('Step 2 of 3');
  });

  it('renders current step instruction and status', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.getByTestId('current-step-instruction')).toHaveTextContent('Write tests');
    expect(screen.getByTestId('current-step-status')).toHaveTextContent('executing');
  });

  it('shows progress indicator when current step is executing', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.getByTestId('progress-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('progress-indicator')).toHaveTextContent('Executing…');
  });

  it('does not show progress indicator when current step is not executing', () => {
    const task = makeTask({
      steps: [
        makeStep({ id: 'step-1', sequenceIndex: 0, instructions: 'Review code', status: 'review' }),
      ],
      currentStepIndex: 0,
    });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.queryByTestId('progress-indicator')).not.toBeInTheDocument();
  });

  // ---- Expand / Collapse ----

  it('does not show step list when collapsed', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.queryByTestId('step-list')).not.toBeInTheDocument();
  });

  it('shows full step list when expanded', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={true} onToggleExpand={() => {}} />);

    const stepList = screen.getByTestId('step-list');
    expect(stepList).toBeInTheDocument();

    const items = stepList.querySelectorAll('li');
    expect(items).toHaveLength(3);
  });

  it('displays step instructions in expanded view', () => {
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={true} onToggleExpand={() => {}} />);

    expect(screen.getByText('Init repo')).toBeInTheDocument();
    expect(screen.getByText('Implement feature')).toBeInTheDocument();
  });

  it('calls onToggleExpand when header is clicked', () => {
    let toggled = false;
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => { toggled = true; }} />);

    const header = screen.getByRole('button', { name: /Task task-1/ });
    fireEvent.click(header);

    expect(toggled).toBe(true);
  });

  it('calls onToggleExpand on Enter key', () => {
    let toggled = false;
    const task = makeTask();
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => { toggled = true; }} />);

    const header = screen.getByRole('button', { name: /Task task-1/ });
    fireEvent.keyDown(header, { key: 'Enter' });

    expect(toggled).toBe(true);
  });

  // ---- Terminal states ----

  it('applies success styling for completed task', () => {
    const task = makeTask({
      status: 'completed',
      steps: [makeStep({ id: 's1', sequenceIndex: 0, status: 'completed' })],
      currentStepIndex: 0,
    });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    const card = screen.getByTestId('task-card-task-1');
    expect(card).toHaveAttribute('data-status', 'completed');
    expect(card.className).toContain('terminalCompleted');
  });

  it('applies failure styling for failed task', () => {
    const task = makeTask({
      status: 'failed',
      steps: [makeStep({ id: 's1', sequenceIndex: 0, status: 'failed' })],
      currentStepIndex: 0,
    });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    const card = screen.getByTestId('task-card-task-1');
    expect(card).toHaveAttribute('data-status', 'failed');
    expect(card.className).toContain('terminalFailed');
  });

  it('applies cancellation styling for canceled task', () => {
    const task = makeTask({
      status: 'canceled',
      steps: [makeStep({ id: 's1', sequenceIndex: 0, status: 'skipped' })],
      currentStepIndex: 0,
    });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    const card = screen.getByTestId('task-card-task-1');
    expect(card).toHaveAttribute('data-status', 'canceled');
    expect(card.className).toContain('terminalCanceled');
  });

  it('does not apply terminal styling for in-progress task', () => {
    const task = makeTask({ status: 'in_progress' });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    const card = screen.getByTestId('task-card-task-1');
    expect(card.className).not.toContain('terminalCompleted');
    expect(card.className).not.toContain('terminalFailed');
    expect(card.className).not.toContain('terminalCanceled');
  });

  // ---- All status labels ----

  it.each([
    ['pending', 'Pending'],
    ['in_progress', 'In Progress'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['canceled', 'Canceled'],
  ] as const)('renders status label for %s', (status, label) => {
    const task = makeTask({
      status,
      steps: [makeStep({ id: 's1', sequenceIndex: 0, status: 'pending' })],
      currentStepIndex: 0,
    });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.getByTestId('task-status')).toHaveTextContent(label);
  });

  // ---- Edge case: task with no steps ----

  it('handles task with empty steps array', () => {
    const task = makeTask({ steps: [], currentStepIndex: 0 });
    render(<TaskCard task={task} isExpanded={false} onToggleExpand={() => {}} />);

    expect(screen.queryByTestId('task-step-position')).not.toBeInTheDocument();
    expect(screen.queryByTestId('current-step-instruction')).not.toBeInTheDocument();
  });
});
