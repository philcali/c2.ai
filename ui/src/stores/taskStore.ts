import { create } from 'zustand';
import type {
  CodingTask,
  CodingTaskStatus,
  TaskEvent,
  TaskStepStatus,
  ExecutionArtifact,
} from '../types/index.js';
import type { FeedbackEntry } from '../types/task.js';

/**
 * Actions exposed by the task store.
 */
export interface TaskActions {
  /** Set or replace a task in the store. */
  setTask: (task: CodingTask) => void;
  /** Apply a real-time task event received via WebSocket. */
  updateTaskFromEvent: (event: TaskEvent) => void;
  /** Toggle the expanded/collapsed state of a task card. */
  toggleExpanded: (taskId: string) => void;
}

export interface TaskStoreState {
  /** taskId → CodingTask */
  tasks: Map<string, CodingTask>;
  /** Set of task IDs whose cards are expanded. */
  expandedTasks: Set<string>;
}

export type TaskStore = TaskStoreState & TaskActions;

// ---------------------------------------------------------------------------
// Event application helpers
// ---------------------------------------------------------------------------

function applyTaskStatusChange(
  task: CodingTask,
  status: CodingTaskStatus,
  timestamp: string,
): CodingTask {
  return { ...task, status, updatedAt: timestamp };
}

function applyStepStatusChange(
  task: CodingTask,
  stepId: string,
  status: TaskStepStatus,
  timestamp: string,
): CodingTask {
  const steps = task.steps.map((step) =>
    step.id === stepId ? { ...step, status, updatedAt: timestamp } : step,
  );

  // Advance currentStepIndex if the current step completed and there is a next step.
  let { currentStepIndex } = task;
  const changedStep = steps.find((s) => s.id === stepId);
  if (
    changedStep &&
    changedStep.sequenceIndex === currentStepIndex &&
    (status === 'completed' || status === 'skipped') &&
    currentStepIndex < steps.length - 1
  ) {
    currentStepIndex += 1;
  }

  return { ...task, steps, currentStepIndex, updatedAt: timestamp };
}

function applyArtifactReceived(
  task: CodingTask,
  stepId: string,
  artifact: ExecutionArtifact,
  timestamp: string,
): CodingTask {
  const steps = task.steps.map((step) =>
    step.id === stepId
      ? { ...step, artifacts: [...step.artifacts, artifact], updatedAt: timestamp }
      : step,
  );
  return { ...task, steps, updatedAt: timestamp };
}

function applyFeedbackAdded(
  task: CodingTask,
  stepId: string,
  feedback: FeedbackEntry,
  timestamp: string,
): CodingTask {
  const steps = task.steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          feedbackHistory: [...step.feedbackHistory, feedback],
          updatedAt: timestamp,
        }
      : step,
  );
  return { ...task, steps, updatedAt: timestamp };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTaskStore = create<TaskStore>((set) => ({
  // -- State --
  tasks: new Map(),
  expandedTasks: new Set(),

  // -- Actions --

  setTask: (task) =>
    set((state) => {
      const updated = new Map(state.tasks);
      updated.set(task.id, task);
      return { tasks: updated };
    }),

  updateTaskFromEvent: (event) =>
    set((state) => {
      const task = state.tasks.get(event.taskId);
      if (!task) return state; // Unknown task — ignore.

      let updatedTask: CodingTask;

      switch (event.type) {
        case 'task_status_change':
          updatedTask = applyTaskStatusChange(task, event.status, event.timestamp);
          break;
        case 'step_status_change':
          updatedTask = applyStepStatusChange(
            task,
            event.stepId,
            event.status,
            event.timestamp,
          );
          break;
        case 'artifact_received':
          updatedTask = applyArtifactReceived(
            task,
            event.stepId,
            event.artifact,
            event.timestamp,
          );
          break;
        case 'feedback_added':
          updatedTask = applyFeedbackAdded(
            task,
            event.stepId,
            event.feedback,
            event.timestamp,
          );
          break;
        default:
          return state;
      }

      const updated = new Map(state.tasks);
      updated.set(event.taskId, updatedTask);
      return { tasks: updated };
    }),

  toggleExpanded: (taskId) =>
    set((state) => {
      const updated = new Set(state.expandedTasks);
      if (updated.has(taskId)) {
        updated.delete(taskId);
      } else {
        updated.add(taskId);
      }
      return { expandedTasks: updated };
    }),
}));
