import type { ExecutionArtifact, CapabilityRequirements } from './agent-connector.js';

/** Coding_Task status */
export type CodingTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';

/** Task_Step status */
export type TaskStepStatus = 'pending' | 'executing' | 'review' | 'completed' | 'failed' | 'skipped';

/** Step trigger types */
export type StepTriggerType = 'operator' | 'time-based' | 'event-driven';

/** Step execution mode */
export type StepExecutionMode = 'agent' | 'external-event';

export interface TaskStep {
  id: string;
  taskId: string;
  sequenceIndex: number;
  instructions: string;
  status: TaskStepStatus;
  executionMode: StepExecutionMode;
  trigger?: StepTrigger;
  /** File paths to include in the Task_Context (from step definition). */
  filePaths?: string[];
  /** Memory_Store references to include in the Task_Context (from step definition). */
  memoryReferences?: { namespace: string; key: string }[];
  artifacts: ExecutionArtifact[];
  feedbackHistory: FeedbackEntry[];
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StepTrigger {
  type: StepTriggerType;
  /** For event-driven: the External_Event_Source ID */
  eventSourceId?: string;
  /** For event-driven: the event type to wait for */
  eventType?: string;
  /** For time-based: polling interval in milliseconds */
  pollingIntervalMs?: number;
  /** Timeout in milliseconds for event-driven and time-based triggers */
  timeoutMs?: number;
}

export interface FeedbackEntry {
  id: string;
  stepId: string;
  operatorId: string;
  content: string;
  timestamp: Date;
}

export interface CodingTask {
  id: string;
  operatorId: string;
  status: CodingTaskStatus;
  assignedAgentId?: string;
  steps: TaskStep[];
  currentStepIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Submission payload for creating a new Coding_Task */
export interface CodingTaskSubmission {
  operatorId: string;
  steps: TaskStepDefinition[];
  /** Optional: specific agent to assign. If omitted, auto-select. */
  agentId?: string;
  /** Optional: capability requirements for agent selection */
  requirements?: CapabilityRequirements;
}

export interface TaskStepDefinition {
  instructions: string;
  executionMode: StepExecutionMode;
  trigger?: StepTrigger;
  /** Optional file paths to include in the Task_Context (subject to Policy_Engine authorization). */
  filePaths?: string[];
  /** Optional Memory_Store references to include in the Task_Context (subject to namespace permissions). */
  memoryReferences?: { namespace: string; key: string }[];
}

/** Context delivered to a Coding_Agent for step execution */
export interface TaskContext {
  taskId: string;
  stepId: string;
  instructions: string;
  filePaths?: string[];
  fileContents?: Record<string, string>;
  memoryReferences?: { namespace: string; key: string }[];
  memoryData?: Record<string, unknown>;
  isolationBoundary: {
    allowedNamespaces: string[];
    allowedChannels: string[];
    allowedServices: string[];
  };
  priorStepArtifacts?: ExecutionArtifact[];
  operatorFeedback?: FeedbackEntry[];
  maxContextSizeBytes?: number;
}

/** Artifact query parameters */
export interface ArtifactQuery {
  taskId: string;
  stepId?: string;
  type?: ExecutionArtifact['type'];
  timeRange?: { start: Date; end: Date };
}

export interface ExternalEventPayload {
  sourceId: string;
  eventType: string;
  outcome: 'success' | 'failure';
  data: unknown;
  timestamp: Date;
}

export interface TaskEvent {
  type: 'task_created' | 'task_status_change' | 'step_status_change' | 'artifact_received' | 'feedback_added';
  taskId: string;
  stepId?: string;
  timestamp: Date;
  data: unknown;
}

export interface ITaskOrchestrator {
  /** Create a new Coding_Task with a step sequence */
  createTask(submission: CodingTaskSubmission): Promise<CodingTask>;

  /** Dispatch the current step of a task to the assigned agent */
  dispatchCurrentStep(taskId: string): Promise<void>;

  /** Advance a task to the next step after operator review */
  advanceTask(taskId: string, operatorId: string): Promise<void>;

  /** Retry the current step with operator feedback */
  retryStep(taskId: string, feedback: string, operatorId: string): Promise<void>;

  /** Redirect a task by modifying the remaining step sequence */
  redirectTask(taskId: string, newSteps: TaskStepDefinition[], fromIndex: number, operatorId: string): Promise<void>;

  /** Cancel a task */
  cancelTask(taskId: string, reason: string, operatorId: string): Promise<void>;

  /** Interrupt an executing step */
  interruptStep(taskId: string, operatorId: string): Promise<void>;

  /** Handle an external event for a waiting step */
  handleExternalEvent(taskId: string, stepId: string, event: ExternalEventPayload): Promise<void>;

  /** Get a task by ID */
  getTask(taskId: string): CodingTask | undefined;

  /** List tasks, optionally filtered by status */
  listTasks(filter?: { status?: CodingTaskStatus; operatorId?: string }): CodingTask[];

  /** Query execution artifacts */
  queryArtifacts(query: ArtifactQuery): Promise<ExecutionArtifact[]>;

  /** Subscribe to task events (step transitions, artifact streams) */
  onTaskEvent(handler: (event: TaskEvent) => void): void;
}
