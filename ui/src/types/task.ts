/** Status of a Coding_Task. */
export type CodingTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';

/** Status of an individual Task_Step. */
export type TaskStepStatus = 'pending' | 'executing' | 'review' | 'completed' | 'failed' | 'skipped';

/** Feedback entry attached to a task step by an operator. */
export interface FeedbackEntry {
  id: string;
  stepId: string;
  operatorId: string;
  content: string;
  timestamp: string;
}

/** A single step within a CodingTask. */
export interface TaskStep {
  id: string;
  taskId: string;
  sequenceIndex: number;
  instructions: string;
  status: TaskStepStatus;
  artifacts: import('./artifact.js').ExecutionArtifact[];
  feedbackHistory: FeedbackEntry[];
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A multi-step coding task assigned to an agent. */
export interface CodingTask {
  id: string;
  operatorId: string;
  status: CodingTaskStatus;
  assignedAgentId?: string;
  steps: TaskStep[];
  currentStepIndex: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Discriminated union of task-related events received via WebSocket.
 */
export type TaskEvent =
  | { type: 'task_status_change'; taskId: string; status: CodingTaskStatus; timestamp: string }
  | { type: 'step_status_change'; taskId: string; stepId: string; status: TaskStepStatus; timestamp: string }
  | { type: 'artifact_received'; taskId: string; stepId: string; artifact: import('./artifact.js').ExecutionArtifact; timestamp: string }
  | { type: 'feedback_added'; taskId: string; stepId: string; feedback: FeedbackEntry; timestamp: string };
