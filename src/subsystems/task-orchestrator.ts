import { v4 as uuidv4 } from 'uuid';
import type {
  ITaskOrchestrator,
  CodingTask,
  CodingTaskStatus,
  CodingTaskSubmission,
  TaskStep,
  TaskStepDefinition,
  TaskStepStatus,
  TaskContext,
  ArtifactQuery,
  ExternalEventPayload,
  TaskEvent,
  FeedbackEntry,
} from '../interfaces/task-orchestrator.js';
import type {
  IAgentConnector,
  ExecutionArtifact,
  AgentEvent,
} from '../interfaces/agent-connector.js';
import type { IMemoryStore } from '../interfaces/memory-store.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IMCPGateway } from '../interfaces/mcp-gateway.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { IOperatorInterface } from '../interfaces/operator-interface.js';
import type { IAgentDiscoveryRegistry } from '../interfaces/agent-discovery-registry.js';
import type { ISessionManager } from '../interfaces/session-manager.js';

/** Default maximum retry cycles per step. */
const DEFAULT_MAX_RETRIES = 3;

/** Default artifact retention: 30 days in milliseconds. */
const DEFAULT_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default maximum context size: 10 MB. */
const DEFAULT_MAX_CONTEXT_SIZE_BYTES = 10 * 1024 * 1024;

/** Default polling interval for time-based external event steps: 10 seconds. */
const DEFAULT_POLLING_INTERVAL_MS = 10_000;

/** Default timeout for external event steps: 5 minutes. */
const DEFAULT_EXTERNAL_EVENT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * In-memory Task Orchestrator implementation.
 *
 * Manages the full lifecycle of Coding_Tasks — accepting operator
 * submissions, selecting and dispatching to a Coding_Agent, collecting
 * results, and presenting them for operator review.
 *
 * Guarantees:
 *  - Task creation produces a unique pending task with the operator-defined
 *    step sequence.
 *  - Single-step implicit tasks are supported for simple prompt-response.
 *  - Agent auto-selection via Agent_Discovery_Registry when no agentId
 *    is specified, preferring idle agents over busy ones.
 *  - Dispatch delivers the current step's instructions and context to the
 *    assigned agent.
 *  - Step progression: advance, retry (with feedback and retry limit),
 *    redirect, cancel, and interrupt.
 *  - Task completes when all steps are completed and accepted.
 *  - All state transitions recorded in Audit_Log.
 *
 * Requirements: 2.1-2.11, 6.1-6.6, 7.3-7.5, 8.1-8.4, 10.1-10.6
 */
export class TaskOrchestrator implements ITaskOrchestrator {
  private readonly agentConnector: IAgentConnector;
  private readonly memoryStore: IMemoryStore;
  private readonly policyEngine: IPolicyEngine;
  private readonly mcpGateway: IMCPGateway;
  private readonly auditLog: IAuditLog;
  private readonly operatorInterface: IOperatorInterface;
  private readonly discoveryRegistry: IAgentDiscoveryRegistry;
  private readonly sessionManager?: ISessionManager;

  /** Tasks keyed by task ID. */
  private readonly tasks: Map<string, CodingTask> = new Map();

  /** Configurable max retries per step. */
  private readonly maxRetries: number;

  /** Configurable artifact retention period in milliseconds. */
  private readonly artifactRetentionMs: number;

  /** Configurable maximum context size in bytes. */
  private readonly maxContextSizeBytes: number;

  /** Task event subscribers. */
  private readonly eventHandlers: ((event: TaskEvent) => void)[] = [];

  /**
   * Artifact buffer for late-joining operators.
   *
   * Accumulates all ExecutionArtifacts streamed during task execution,
   * keyed by task ID. Late-joining operators call getArtifactBuffer()
   * to retrieve the full history for a task.
   *
   * Buffers are cleared when a task reaches a terminal state (completed,
   * canceled, failed) since artifacts are persisted in Memory_Store at
   * that point.
   *
   * Requirements: 8.4
   */
  private readonly artifactBuffers: Map<string, ExecutionArtifact[]> = new Map();

  /**
   * Polling timers for time-based external event steps.
   *
   * Keyed by `{taskId}:{stepId}`. Each entry holds the interval timer
   * that periodically polls the External_Event_Source via MCP_Gateway.
   *
   * Requirements: 11.2
   */
  private readonly pollingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /**
   * Timeout timers for external event steps (both polling and push).
   *
   * Keyed by `{taskId}:{stepId}`. Each entry holds the timeout timer
   * that transitions the step to `failed` if the event is not received
   * within the configured timeout.
   *
   * Requirements: 11.6, 11.7
   */
  private readonly timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(options: {
    agentConnector: IAgentConnector;
    memoryStore: IMemoryStore;
    policyEngine: IPolicyEngine;
    mcpGateway: IMCPGateway;
    auditLog: IAuditLog;
    operatorInterface: IOperatorInterface;
    discoveryRegistry: IAgentDiscoveryRegistry;
    /** Optional Session_Manager for resolving Isolation_Boundaries. */
    sessionManager?: ISessionManager;
    maxRetries?: number;
    /** Artifact retention period in milliseconds (default: 30 days). */
    artifactRetentionMs?: number;
    /** Maximum context size in bytes (default: 10 MB). */
    maxContextSizeBytes?: number;
  }) {
    this.agentConnector = options.agentConnector;
    this.memoryStore = options.memoryStore;
    this.policyEngine = options.policyEngine;
    this.mcpGateway = options.mcpGateway;
    this.auditLog = options.auditLog;
    this.operatorInterface = options.operatorInterface;
    this.discoveryRegistry = options.discoveryRegistry;
    this.sessionManager = options.sessionManager;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.artifactRetentionMs = options.artifactRetentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS;
    this.maxContextSizeBytes = options.maxContextSizeBytes ?? DEFAULT_MAX_CONTEXT_SIZE_BYTES;

    // Subscribe to agent events to collect step results.
    this.agentConnector.onAgentEvent((event) => this.handleAgentEvent(event));
  }

  // ------------------------------------------------------------------
  // ITaskOrchestrator — Task creation
  // ------------------------------------------------------------------

  /**
   * Create a new Coding_Task with a step sequence.
   *
   * Flow:
   *  1. Generate a unique task ID.
   *  2. Build the step sequence from the submission.
   *  3. Auto-select an agent if none specified.
   *  4. Set task status to pending.
   *  5. Record creation in Audit_Log.
   *
   * Requirements: 2.1, 2.11, 7.3, 7.4, 7.5
   */
  async createTask(submission: CodingTaskSubmission): Promise<CodingTask> {
    const now = new Date();
    const taskId = uuidv4();

    // Build step sequence from submission definitions.
    const steps: TaskStep[] = submission.steps.map((def, index) =>
      this.buildTaskStep(taskId, def, index, now),
    );

    // Auto-select agent if not specified.
    let assignedAgentId = submission.agentId;
    if (!assignedAgentId) {
      assignedAgentId = this.selectAgent(submission);
    }

    const task: CodingTask = {
      id: taskId,
      operatorId: submission.operatorId,
      status: 'pending',
      assignedAgentId,
      steps,
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(taskId, task);

    // Record creation in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId: submission.operatorId,
      agentId: assignedAgentId,
      eventType: 'coding_task',
      operation: 'create_task',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepCount: steps.length,
        assignedAgentId,
        status: 'pending',
      },
    });

    // Emit task_created event.
    this.emitEvent({
      type: 'task_created',
      taskId,
      timestamp: now,
      data: { operatorId: submission.operatorId, stepCount: steps.length },
    });

    return task;
  }

  // ------------------------------------------------------------------
  // ITaskOrchestrator — Dispatch
  // ------------------------------------------------------------------

  /**
   * Dispatch the current step of a task to the assigned agent.
   *
   * For agent-executable steps: assembles Task_Context and dispatches
   * via Agent_Connector.
   *
   * For external-event steps: delegates to startExternalEventStep()
   * which initiates polling or timeout timers.
   *
   * Flow:
   *  1. Validate task state (must be pending or in_progress).
   *  2. If external-event step, delegate to startExternalEventStep.
   *  3. Assemble Task_Context for the current step.
   *  4. Dispatch via Agent_Connector.
   *  5. Transition task to in_progress and step to executing.
   *
   * Requirements: 2.2, 10.1, 11.1, 11.2
   */
  async dispatchCurrentStep(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== 'pending' && task.status !== 'in_progress') {
      throw new Error(
        `Cannot dispatch step for task '${taskId}' in '${task.status}' status`,
      );
    }

    const step = task.steps[task.currentStepIndex];
    if (!step) {
      throw new Error(
        `Task '${taskId}' has no step at index ${task.currentStepIndex}`,
      );
    }

    if (step.status !== 'pending' && step.status !== 'failed') {
      throw new Error(
        `Cannot dispatch step '${step.id}' in '${step.status}' status`,
      );
    }

    // Handle external-event steps via startExternalEventStep.
    if (step.executionMode === 'external-event') {
      const now = new Date();
      // Transition task to in_progress if needed.
      const previousTaskStatus = task.status;
      if (task.status === 'pending') {
        task.status = 'in_progress';
        task.updatedAt = now;

        await this.recordStateTransition(
          task,
          step,
          'task_status',
          previousTaskStatus,
          'in_progress',
          now,
        );
      }

      await this.startExternalEventStep(task, step);
      return;
    }

    if (!task.assignedAgentId) {
      throw new Error(
        `Task '${taskId}' has no assigned agent. No capable agent is available.`,
      );
    }

    const now = new Date();

    // Assemble Task_Context (may throw if context exceeds size limit).
    const context = this.assembleTaskContext(task, step);

    // Dispatch via Agent_Connector.
    const result = await this.agentConnector.dispatchStep(
      task.assignedAgentId,
      context,
    );

    if (!result.success) {
      throw new Error(
        `Failed to dispatch step '${step.id}' to agent '${task.assignedAgentId}': ${result.error}`,
      );
    }

    // Transition task to in_progress.
    const previousTaskStatus = task.status;
    if (task.status === 'pending') {
      task.status = 'in_progress';
      task.updatedAt = now;

      await this.recordStateTransition(
        task,
        step,
        'task_status',
        previousTaskStatus,
        'in_progress',
        now,
      );
    }

    // Transition step to executing.
    const previousStepStatus = step.status;
    step.status = 'executing';
    step.updatedAt = now;

    await this.recordStateTransition(
      task,
      step,
      'step_status',
      previousStepStatus,
      'executing',
      now,
    );

    // Emit step status change event.
    this.emitEvent({
      type: 'step_status_change',
      taskId,
      stepId: step.id,
      timestamp: now,
      data: { previousStatus: previousStepStatus, newStatus: 'executing' },
    });

    // Broadcast step status change to operator via WebSocket (Req 8.2).
    this.operatorInterface.broadcastEvent(`task:${taskId}`, {
      channel: `task:${taskId}`,
      type: 'step_status_change',
      data: {
        taskId,
        stepId: step.id,
        previousStatus: previousStepStatus,
        newStatus: 'executing',
      },
      timestamp: now,
    });
  }

  // ------------------------------------------------------------------
  // ITaskOrchestrator — Step progression (Task 5.3)
  // ------------------------------------------------------------------

  /**
   * Advance a task to the next step after operator review.
   *
   * Flow:
   *  1. Validate current step is in review status.
   *  2. Transition current step to completed.
   *  3. If more steps remain, dispatch the next step.
   *  4. If all steps completed, transition task to completed.
   *
   * Requirements: 2.3, 2.4, 2.7, 6.2
   */
  async advanceTask(taskId: string, operatorId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== 'in_progress') {
      throw new Error(
        `Cannot advance task '${taskId}' in '${task.status}' status`,
      );
    }

    const currentStep = task.steps[task.currentStepIndex];
    if (!currentStep) {
      throw new Error(`Task '${taskId}' has no current step`);
    }

    if (currentStep.status !== 'review') {
      throw new Error(
        `Cannot advance: current step '${currentStep.id}' is in '${currentStep.status}' status, expected 'review'`,
      );
    }

    const now = new Date();

    // Transition current step to completed.
    const previousStepStatus = currentStep.status;
    currentStep.status = 'completed';
    currentStep.updatedAt = now;

    // Persist all step artifacts to Memory_Store on completion.
    await this.persistStepArtifacts(task, currentStep);

    await this.recordStateTransition(
      task,
      currentStep,
      'step_status',
      previousStepStatus,
      'completed',
      now,
      operatorId,
    );

    this.emitEvent({
      type: 'step_status_change',
      taskId,
      stepId: currentStep.id,
      timestamp: now,
      data: { previousStatus: previousStepStatus, newStatus: 'completed' },
    });

    // Record operator review action in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      agentId: task.assignedAgentId,
      eventType: 'coding_task',
      operation: 'operator_advance',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepId: currentStep.id,
        operatorId,
      },
    });

    // Check if all steps are completed.
    if (this.allStepsTerminal(task)) {
      await this.completeTask(task, now);
      return;
    }

    // Move to next non-terminal step.
    const nextIndex = this.findNextPendingStepIndex(task, task.currentStepIndex + 1);
    if (nextIndex === -1) {
      // All remaining steps are terminal — complete the task.
      await this.completeTask(task, now);
      return;
    }

    task.currentStepIndex = nextIndex;
    task.updatedAt = now;

    // Dispatch the next step.
    const nextStep = task.steps[nextIndex];
    if (nextStep.executionMode === 'agent') {
      await this.dispatchCurrentStep(taskId);
    }
    // For external-event steps, the step waits for an external event
    // (handled by handleExternalEvent). Start polling/timeout timers.
    if (nextStep.executionMode === 'external-event') {
      await this.startExternalEventStep(task, nextStep);
    }
  }

  /**
   * Retry the current step with operator feedback.
   *
   * Flow:
   *  1. Validate current step is in review or failed status.
   *  2. Record feedback entry.
   *  3. Increment retry count and enforce retry limit.
   *  4. Re-dispatch the step with feedback and prior artifacts.
   *
   * Requirements: 2.5, 6.2, 6.4, 6.5
   */
  async retryStep(
    taskId: string,
    feedback: string,
    operatorId: string,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== 'in_progress') {
      throw new Error(
        `Cannot retry step for task '${taskId}' in '${task.status}' status`,
      );
    }

    const currentStep = task.steps[task.currentStepIndex];
    if (!currentStep) {
      throw new Error(`Task '${taskId}' has no current step`);
    }

    if (currentStep.status !== 'review' && currentStep.status !== 'failed') {
      throw new Error(
        `Cannot retry step '${currentStep.id}' in '${currentStep.status}' status, expected 'review' or 'failed'`,
      );
    }

    const now = new Date();

    // Check retry limit before incrementing.
    if (currentStep.retryCount >= this.maxRetries) {
      // Transition step to failed with retry limit reason.
      const prevStatus = currentStep.status;
      currentStep.status = 'failed';
      currentStep.updatedAt = now;

      // Persist all step artifacts to Memory_Store on failure.
      await this.persistStepArtifacts(task, currentStep);

      await this.recordStateTransition(
        task,
        currentStep,
        'step_status',
        prevStatus,
        'failed',
        now,
        operatorId,
        'Retry limit exceeded',
      );

      this.emitEvent({
        type: 'step_status_change',
        taskId,
        stepId: currentStep.id,
        timestamp: now,
        data: {
          previousStatus: prevStatus,
          newStatus: 'failed',
          reason: 'Retry limit exceeded',
        },
      });

      throw new Error(
        `Step '${currentStep.id}' has reached the maximum retry limit of ${this.maxRetries}`,
      );
    }

    // Record feedback entry.
    const feedbackEntry: FeedbackEntry = {
      id: uuidv4(),
      stepId: currentStep.id,
      operatorId,
      content: feedback,
      timestamp: now,
    };
    currentStep.feedbackHistory.push(feedbackEntry);

    this.emitEvent({
      type: 'feedback_added',
      taskId,
      stepId: currentStep.id,
      timestamp: now,
      data: { feedbackId: feedbackEntry.id, operatorId },
    });

    // Increment retry count.
    currentStep.retryCount += 1;

    // Record operator retry action in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      agentId: task.assignedAgentId,
      eventType: 'coding_task',
      operation: 'operator_retry',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepId: currentStep.id,
        operatorId,
        feedback,
        retryCount: currentStep.retryCount,
      },
    });

    // Transition step back to pending so dispatchCurrentStep can pick it up.
    const prevStatus = currentStep.status;
    currentStep.status = 'pending';
    currentStep.updatedAt = now;

    await this.recordStateTransition(
      task,
      currentStep,
      'step_status',
      prevStatus,
      'pending',
      now,
      operatorId,
    );

    // Re-dispatch the step.
    await this.dispatchCurrentStep(taskId);
  }

  /**
   * Redirect a task by modifying the remaining step sequence.
   *
   * Replaces steps from `fromIndex` onward with the new step definitions.
   * Continues execution from the specified position.
   *
   * Requirements: 2.6, 6.6
   */
  async redirectTask(
    taskId: string,
    newSteps: TaskStepDefinition[],
    fromIndex: number,
    operatorId: string,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== 'pending' && task.status !== 'in_progress') {
      throw new Error(
        `Cannot redirect task '${taskId}' in '${task.status}' status`,
      );
    }

    if (fromIndex < 0 || fromIndex > task.steps.length) {
      throw new Error(
        `Invalid fromIndex ${fromIndex} for task '${taskId}' with ${task.steps.length} steps`,
      );
    }

    const now = new Date();

    // Build new steps starting from fromIndex.
    const newTaskSteps: TaskStep[] = newSteps.map((def, i) =>
      this.buildTaskStep(taskId, def, fromIndex + i, now),
    );

    // Keep completed/in-progress steps before fromIndex, replace the rest.
    const preserved = task.steps.slice(0, fromIndex);
    task.steps = [...preserved, ...newTaskSteps];

    // Re-index all steps.
    for (let i = 0; i < task.steps.length; i++) {
      task.steps[i].sequenceIndex = i;
    }

    // Set current step index to fromIndex.
    task.currentStepIndex = fromIndex;
    task.updatedAt = now;

    // Record redirect in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      agentId: task.assignedAgentId,
      eventType: 'coding_task',
      operation: 'operator_redirect',
      resource: `task:${taskId}`,
      details: {
        taskId,
        operatorId,
        fromIndex,
        newStepCount: newSteps.length,
        totalSteps: task.steps.length,
      },
    });

    this.emitEvent({
      type: 'task_status_change',
      taskId,
      timestamp: now,
      data: {
        operation: 'redirect',
        fromIndex,
        newStepCount: newSteps.length,
      },
    });
  }

  /**
   * Cancel a task.
   *
   * Flow:
   *  1. Validate task is in a non-terminal state.
   *  2. Notify the assigned agent to stop work.
   *  3. Transition task to canceled.
   *  4. Record cancellation in Audit_Log.
   *
   * Requirements: 2.8
   */
  async cancelTask(
    taskId: string,
    reason: string,
    operatorId: string,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status === 'completed' || task.status === 'canceled') {
      throw new Error(
        `Cannot cancel task '${taskId}' in terminal '${task.status}' status`,
      );
    }

    const now = new Date();
    const previousStatus = task.status;

    // Notify the assigned agent to stop work (best-effort).
    if (task.assignedAgentId && task.status === 'in_progress') {
      try {
        await this.agentConnector.disconnect(task.assignedAgentId, reason);
      } catch {
        // Best-effort — agent may already be disconnected.
      }
    }

    // Transition task to canceled.
    task.status = 'canceled';
    task.updatedAt = now;

    // Clear any active polling/timeout timers for all steps.
    for (const step of task.steps) {
      this.clearStepTimers(task.id, step.id);
    }

    // Persist all step artifacts to Memory_Store on cancellation.
    // Artifacts are retained per the configured retention policy.
    for (const step of task.steps) {
      if (step.artifacts.length > 0) {
        await this.persistStepArtifacts(task, step);
      }
    }

    // Clear the artifact buffer — artifacts are persisted in Memory_Store (Req 8.4).
    this.artifactBuffers.delete(task.id);

    await this.recordStateTransition(
      task,
      task.steps[task.currentStepIndex],
      'task_status',
      previousStatus,
      'canceled',
      now,
      operatorId,
      reason,
    );

    // Record operator cancel action in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      agentId: task.assignedAgentId,
      eventType: 'coding_task',
      operation: 'operator_cancel',
      resource: `task:${taskId}`,
      details: {
        taskId,
        operatorId,
        reason,
        previousStatus,
      },
    });

    this.emitEvent({
      type: 'task_status_change',
      taskId,
      timestamp: now,
      data: { previousStatus, newStatus: 'canceled', reason },
    });
  }

  /**
   * Interrupt an executing step.
   *
   * Forwards the interrupt to the agent and transitions the step to
   * review status with the artifacts collected so far.
   *
   * Requirements: 2.9, 8.3
   */
  async interruptStep(taskId: string, operatorId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== 'in_progress') {
      throw new Error(
        `Cannot interrupt step for task '${taskId}' in '${task.status}' status`,
      );
    }

    const currentStep = task.steps[task.currentStepIndex];
    if (!currentStep) {
      throw new Error(`Task '${taskId}' has no current step`);
    }

    if (currentStep.status !== 'executing') {
      throw new Error(
        `Cannot interrupt step '${currentStep.id}' in '${currentStep.status}' status, expected 'executing'`,
      );
    }

    const now = new Date();

    // Transition step to review with partial artifacts.
    const previousStepStatus = currentStep.status;
    currentStep.status = 'review';
    currentStep.updatedAt = now;

    // Persist all step artifacts to Memory_Store on review transition.
    await this.persistStepArtifacts(task, currentStep);

    await this.recordStateTransition(
      task,
      currentStep,
      'step_status',
      previousStepStatus,
      'review',
      now,
      operatorId,
      'Operator interrupt',
    );

    // Record operator interrupt action in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      agentId: task.assignedAgentId,
      eventType: 'coding_task',
      operation: 'operator_interrupt',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepId: currentStep.id,
        operatorId,
        artifactCount: currentStep.artifacts.length,
      },
    });

    this.emitEvent({
      type: 'step_status_change',
      taskId,
      stepId: currentStep.id,
      timestamp: now,
      data: {
        previousStatus: previousStepStatus,
        newStatus: 'review',
        reason: 'Operator interrupt',
      },
    });

    // Present step artifacts to operator via WebSocket_Interface.
    this.operatorInterface.broadcastEvent(`task:${taskId}`, {
      channel: `task:${taskId}`,
      type: 'step_review',
      data: {
        taskId,
        stepId: currentStep.id,
        artifacts: currentStep.artifacts,
        reason: 'Operator interrupt',
      },
      timestamp: now,
    });
  }

  // ------------------------------------------------------------------
  // ITaskOrchestrator — External events (Task 9)
  // ------------------------------------------------------------------

  /**
   * Handle an external event for a waiting step.
   *
   * Evaluates the event payload, routes through MCP_Gateway with
   * Policy_Engine authorization, transitions the step based on outcome,
   * and auto-advances to the next step if it is agent-executable.
   *
   * Requirements: 11.1, 11.3, 11.4, 11.5, 11.9
   */
  async handleExternalEvent(
    taskId: string,
    stepId: string,
    event: ExternalEventPayload,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    const step = task.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Step '${stepId}' not found in task '${taskId}'`);
    }

    if (step.status !== 'executing') {
      throw new Error(
        `Cannot handle external event for step '${stepId}' in '${step.status}' status`,
      );
    }

    const now = new Date();

    // Route through MCP_Gateway with Policy_Engine authorization (Req 11.5).
    const agentId = task.assignedAgentId ?? 'system';
    const mcpResult = await this.mcpGateway.executeOperation(
      agentId,
      event.sourceId,
      'receive_event',
      { eventType: event.eventType, outcome: event.outcome, data: event.data },
    );

    // Record external event interaction in Audit_Log (Req 11.8).
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: task.assignedAgentId,
      operatorId: task.operatorId,
      eventType: 'external_event',
      operation: 'webhook_received',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepId: step.id,
        sourceId: event.sourceId,
        eventType: event.eventType,
        outcome: event.outcome,
        mcpAuthorized: mcpResult.success,
      },
    });

    // If MCP_Gateway denied the operation, log and return without transitioning.
    if (!mcpResult.success) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: task.assignedAgentId,
        operatorId: task.operatorId,
        eventType: 'external_event',
        operation: 'event_authorization_denied',
        resource: `task:${taskId}`,
        decision: 'deny',
        details: {
          taskId,
          stepId: step.id,
          sourceId: event.sourceId,
          eventType: event.eventType,
          error: mcpResult.error,
        },
      });
      throw new Error(
        `External event authorization denied for step '${stepId}': ${mcpResult.error?.message ?? 'unknown'}`,
      );
    }

    // Stop any active polling or timeout timers for this step.
    this.clearStepTimers(taskId, stepId);

    const previousStepStatus = step.status;

    // Transition step based on event outcome (Req 11.3, 11.4).
    if (event.outcome === 'success') {
      step.status = 'completed';
    } else {
      step.status = 'failed';
    }
    step.updatedAt = now;

    // Persist all step artifacts to Memory_Store on terminal transition.
    await this.persistStepArtifacts(task, step);

    await this.recordStateTransition(
      task,
      step,
      'step_status',
      previousStepStatus,
      step.status,
      now,
      undefined,
      `External event: ${event.eventType} - ${event.outcome}`,
    );

    this.emitEvent({
      type: 'step_status_change',
      taskId,
      stepId: step.id,
      timestamp: now,
      data: {
        previousStatus: previousStepStatus,
        newStatus: step.status,
        externalEvent: event,
      },
    });

    // Notify operator via WebSocket.
    this.operatorInterface.broadcastEvent(`task:${taskId}`, {
      channel: `task:${taskId}`,
      type: 'external_event_resolved',
      data: {
        taskId,
        stepId: step.id,
        eventType: event.eventType,
        outcome: event.outcome,
        newStatus: step.status,
      },
      timestamp: now,
    });

    // Auto-advance: if the event resolved successfully and the next step
    // is agent-executable, dispatch it automatically (Req 11.9).
    if (event.outcome === 'success') {
      // Check if all steps are done.
      if (this.allStepsTerminal(task)) {
        await this.completeTask(task, now);
        return;
      }

      // Find and dispatch next step.
      const nextIndex = this.findNextPendingStepIndex(task, task.currentStepIndex + 1);
      if (nextIndex !== -1) {
        task.currentStepIndex = nextIndex;
        task.updatedAt = now;

        const nextStep = task.steps[nextIndex];
        if (nextStep.executionMode === 'agent') {
          await this.dispatchCurrentStep(taskId);
        } else if (nextStep.executionMode === 'external-event') {
          // Start the next external event step.
          await this.startExternalEventStep(task, nextStep);
        }
      } else {
        await this.completeTask(task, now);
      }
    }
  }

  /**
   * Start an external event step — initiate polling or timeout.
   *
   * For time-based triggers: starts a polling interval that queries the
   * External_Event_Source via MCP_Gateway at the configured interval.
   *
   * For event-driven triggers: starts a timeout timer that transitions
   * the step to `failed` if no matching event is received in time.
   *
   * For both: starts a timeout timer if configured.
   *
   * Requirements: 11.1, 11.2, 11.6, 11.7
   */
  async startExternalEventStep(task: CodingTask, step: TaskStep): Promise<void> {
    const now = new Date();
    const previousStatus = step.status;

    // Transition step to executing.
    step.status = 'executing';
    step.updatedAt = now;

    await this.recordStateTransition(
      task,
      step,
      'step_status',
      previousStatus,
      'executing',
      now,
    );

    this.emitEvent({
      type: 'step_status_change',
      taskId: task.id,
      stepId: step.id,
      timestamp: now,
      data: { previousStatus, newStatus: 'executing' },
    });

    // Broadcast step status change to operator via WebSocket.
    this.operatorInterface.broadcastEvent(`task:${task.id}`, {
      channel: `task:${task.id}`,
      type: 'step_status_change',
      data: {
        taskId: task.id,
        stepId: step.id,
        previousStatus,
        newStatus: 'executing',
      },
      timestamp: now,
    });

    const trigger = step.trigger;
    if (!trigger) {
      return;
    }

    const timerKey = `${task.id}:${step.id}`;

    // Start timeout timer if configured (Req 11.6, 11.7).
    const timeoutMs = trigger.timeoutMs ?? DEFAULT_EXTERNAL_EVENT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      const timeoutTimer = setTimeout(() => {
        void this.handleExternalEventTimeout(task.id, step.id, timeoutMs);
      }, timeoutMs);
      this.timeoutTimers.set(timerKey, timeoutTimer);
    }

    // Start polling for time-based triggers (Req 11.2).
    if (trigger.type === 'time-based' && trigger.eventSourceId) {
      const pollingIntervalMs = trigger.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;

      // Record polling start in Audit_Log.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: task.assignedAgentId,
        operatorId: task.operatorId,
        eventType: 'external_event',
        operation: 'polling_started',
        resource: `task:${task.id}`,
        details: {
          taskId: task.id,
          stepId: step.id,
          sourceId: trigger.eventSourceId,
          pollingIntervalMs,
          timeoutMs,
        },
      });

      const pollingTimer = setInterval(() => {
        void this.pollExternalEventSource(task.id, step.id, trigger);
      }, pollingIntervalMs);
      this.pollingTimers.set(timerKey, pollingTimer);
    }

    // For event-driven triggers, we just wait for the push notification.
    // Record that we're waiting in the Audit_Log.
    if (trigger.type === 'event-driven' && trigger.eventSourceId) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: task.assignedAgentId,
        operatorId: task.operatorId,
        eventType: 'external_event',
        operation: 'waiting_for_push',
        resource: `task:${task.id}`,
        details: {
          taskId: task.id,
          stepId: step.id,
          sourceId: trigger.eventSourceId,
          eventType: trigger.eventType,
          timeoutMs,
        },
      });
    }
  }

  /**
   * Poll an External_Event_Source via MCP_Gateway.
   *
   * Routes the poll request through MCP_Gateway with Policy_Engine
   * authorization. If the poll returns a terminal status, resolves
   * the step via handleExternalEvent.
   *
   * Requirements: 11.2, 11.4, 11.5
   */
  private async pollExternalEventSource(
    taskId: string,
    stepId: string,
    trigger: NonNullable<TaskStep['trigger']>,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const step = task.steps.find((s) => s.id === stepId);
    if (!step || step.status !== 'executing') {
      // Step is no longer waiting — clean up timers.
      this.clearStepTimers(taskId, stepId);
      return;
    }

    const now = new Date();
    const agentId = task.assignedAgentId ?? 'system';
    const sourceId = trigger.eventSourceId ?? 'unknown';

    // Route poll request through MCP_Gateway (Req 11.5).
    let pollResult;
    try {
      pollResult = await this.mcpGateway.executeOperation(
        agentId,
        sourceId,
        'poll_status',
        { eventType: trigger.eventType },
      );
    } catch (err) {
      // Log poll failure and continue — next interval will retry.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: task.assignedAgentId,
        operatorId: task.operatorId,
        eventType: 'external_event',
        operation: 'poll_error',
        resource: `task:${taskId}`,
        details: {
          taskId,
          stepId,
          sourceId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }

    // Record poll request/response in Audit_Log (Req 11.8).
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: task.assignedAgentId,
      operatorId: task.operatorId,
      eventType: 'external_event',
      operation: 'poll_response',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepId,
        sourceId,
        success: pollResult.success,
        data: pollResult.data,
      },
    });

    // Check if the poll returned a terminal status.
    if (pollResult.success && pollResult.data) {
      const data = pollResult.data as { status?: string; outcome?: string };
      const status = data.status ?? data.outcome;

      if (status === 'passed' || status === 'success' || status === 'completed') {
        // Terminal success — resolve the step.
        await this.handleExternalEvent(taskId, stepId, {
          sourceId,
          eventType: trigger.eventType ?? 'poll_result',
          outcome: 'success',
          data: pollResult.data,
          timestamp: now,
        });
      } else if (status === 'failed' || status === 'failure' || status === 'error') {
        // Terminal failure — resolve the step.
        await this.handleExternalEvent(taskId, stepId, {
          sourceId,
          eventType: trigger.eventType ?? 'poll_result',
          outcome: 'failure',
          data: pollResult.data,
          timestamp: now,
        });
      }
      // Non-terminal status (e.g., 'pending', 'running') — continue polling.
    }
  }

  /**
   * Handle timeout for an external event step.
   *
   * Transitions the step to `failed` with a timeout reason and
   * notifies the operator.
   *
   * Requirements: 11.6, 11.7
   */
  private async handleExternalEventTimeout(
    taskId: string,
    stepId: string,
    timeoutMs: number,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const step = task.steps.find((s) => s.id === stepId);
    if (!step || step.status !== 'executing') {
      // Step already resolved — nothing to do.
      return;
    }

    const now = new Date();

    // Clear all timers for this step.
    this.clearStepTimers(taskId, stepId);

    const previousStatus = step.status;
    step.status = 'failed';
    step.updatedAt = now;

    const timeoutReason = `External event timeout: step did not receive a matching event within ${timeoutMs}ms`;

    // Persist step artifacts on failure.
    await this.persistStepArtifacts(task, step);

    await this.recordStateTransition(
      task,
      step,
      'step_status',
      previousStatus,
      'failed',
      now,
      undefined,
      timeoutReason,
    );

    // Record timeout in Audit_Log (Req 11.8).
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: task.assignedAgentId,
      operatorId: task.operatorId,
      eventType: 'external_event',
      operation: 'event_timeout',
      resource: `task:${taskId}`,
      details: {
        taskId,
        stepId,
        timeoutMs,
        triggerType: step.trigger?.type,
        sourceId: step.trigger?.eventSourceId,
      },
    });

    this.emitEvent({
      type: 'step_status_change',
      taskId,
      stepId: step.id,
      timestamp: now,
      data: {
        previousStatus,
        newStatus: 'failed',
        reason: timeoutReason,
      },
    });

    // Notify operator via WebSocket.
    this.operatorInterface.broadcastEvent(`task:${taskId}`, {
      channel: `task:${taskId}`,
      type: 'step_failed',
      data: {
        taskId,
        stepId: step.id,
        reason: timeoutReason,
      },
      timestamp: now,
    });
  }

  /**
   * Clear polling and timeout timers for a step.
   */
  private clearStepTimers(taskId: string, stepId: string): void {
    const timerKey = `${taskId}:${stepId}`;

    const pollingTimer = this.pollingTimers.get(timerKey);
    if (pollingTimer) {
      clearInterval(pollingTimer);
      this.pollingTimers.delete(timerKey);
    }

    const timeoutTimer = this.timeoutTimers.get(timerKey);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      this.timeoutTimers.delete(timerKey);
    }
  }

  // ------------------------------------------------------------------
  // ITaskOrchestrator — Query methods
  // ------------------------------------------------------------------

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): CodingTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get the configured artifact retention period in milliseconds.
   */
  getArtifactRetentionMs(): number {
    return this.artifactRetentionMs;
  }

  /**
   * Get the configured maximum context size in bytes.
   */
  getMaxContextSizeBytes(): number {
    return this.maxContextSizeBytes;
  }

  /**
   * List tasks, optionally filtered by status and/or operatorId.
   */
  listTasks(filter?: {
    status?: CodingTaskStatus;
    operatorId?: string;
  }): CodingTask[] {
    let results = Array.from(this.tasks.values());

    if (filter?.status) {
      results = results.filter((t) => t.status === filter.status);
    }
    if (filter?.operatorId) {
      results = results.filter((t) => t.operatorId === filter.operatorId);
    }

    return results;
  }

  /**
   * Query execution artifacts.
   *
   * Queries both in-memory step artifacts and persisted artifacts in
   * Memory_Store. In-memory artifacts are the primary source; Memory_Store
   * provides persistence across restarts.
   *
   * Requirements: 5.5
   */
  async queryArtifacts(query: ArtifactQuery): Promise<ExecutionArtifact[]> {
    // Collect in-memory artifacts from the task's steps.
    const task = this.tasks.get(query.taskId);
    const inMemoryArtifacts: ExecutionArtifact[] = [];

    if (task) {
      for (const step of task.steps) {
        inMemoryArtifacts.push(...step.artifacts);
      }
    }

    // Query Memory_Store for persisted artifacts.
    const namespace = `task:${query.taskId}`;
    const tags: string[] = [`task:${query.taskId}`];

    if (query.stepId) {
      tags.push(`step:${query.stepId}`);
    }
    if (query.type) {
      tags.push(`type:${query.type}`);
    }

    const memoryQuery: import('../interfaces/memory-store.js').MemoryQuery = {
      namespace,
      tags,
      timeRange: query.timeRange,
    };

    // Use a system-level agent ID for querying artifacts.
    const agentId = task?.assignedAgentId ?? 'system';
    let memoryEntries: import('../interfaces/memory-store.js').MemoryEntry[] = [];
    try {
      memoryEntries = await this.memoryStore.query(agentId, memoryQuery);
    } catch {
      // If Memory_Store query fails, fall back to in-memory only.
    }

    // Build a set of in-memory artifact IDs for deduplication.
    const inMemoryIds = new Set(inMemoryArtifacts.map((a) => a.id));

    // Merge Memory_Store artifacts that aren't already in memory.
    const mergedArtifacts = [...inMemoryArtifacts];
    for (const entry of memoryEntries) {
      const artifact = entry.value as ExecutionArtifact;
      if (artifact && artifact.id && !inMemoryIds.has(artifact.id)) {
        mergedArtifacts.push(artifact);
      }
    }

    // Apply filters on the merged set.
    let filtered = mergedArtifacts;

    // Filter by stepId.
    if (query.stepId) {
      filtered = filtered.filter((a) => a.stepId === query.stepId);
    }

    // Filter by type.
    if (query.type) {
      filtered = filtered.filter((a) => a.type === query.type);
    }

    // Filter by time range.
    if (query.timeRange) {
      const { start, end } = query.timeRange;
      filtered = filtered.filter(
        (a) => a.timestamp >= start && a.timestamp <= end,
      );
    }

    return filtered;
  }

  /**
   * Subscribe to task events (step transitions, artifact streams).
   */
  onTaskEvent(handler: (event: TaskEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Retrieve the buffered artifacts for a task.
   *
   * Late-joining operators call this to get the full artifact history
   * for the current task execution. Returns a copy of the buffer so
   * callers cannot mutate the internal state.
   *
   * Requirements: 8.4
   */
  getArtifactBuffer(taskId: string): ExecutionArtifact[] {
    const buffer = this.artifactBuffers.get(taskId);
    return buffer ? [...buffer] : [];
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Build a TaskStep from a TaskStepDefinition.
   */
  private buildTaskStep(
    taskId: string,
    def: TaskStepDefinition,
    index: number,
    now: Date,
  ): TaskStep {
    return {
      id: uuidv4(),
      taskId,
      sequenceIndex: index,
      instructions: def.instructions,
      status: 'pending',
      executionMode: def.executionMode,
      trigger: def.trigger,
      filePaths: def.filePaths,
      memoryReferences: def.memoryReferences,
      artifacts: [],
      feedbackHistory: [],
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Select an agent for a task based on capability requirements.
   *
   * Queries the Agent_Discovery_Registry for agents whose capabilities
   * match the task requirements and whose health status is healthy.
   * Prefers idle agents over busy ones.
   *
   * Requirements: 7.3, 7.4, 7.5
   */
  private selectAgent(submission: CodingTaskSubmission): string | undefined {
    const requirements = submission.requirements ?? {};
    const capableAgents = this.agentConnector.findCapableAgents(requirements);

    if (capableAgents.length === 0) {
      return undefined;
    }

    // Prefer idle agents (no currentTaskId) over busy ones.
    const idleAgents = capableAgents.filter((a) => !a.currentTaskId);
    if (idleAgents.length > 0) {
      return idleAgents[0].agentId;
    }

    // Fall back to the first capable agent.
    return capableAgents[0].agentId;
  }

  /**
   * Assemble a Task_Context for the current step.
   *
   * Includes step instructions, file contents (policy-checked),
   * Memory_Store data (policy-checked), Isolation_Boundary from
   * the agent's session, prior step artifacts, operator feedback,
   * and enforces a configurable maximum context size.
   *
   * Requirements: 2.2, 2.4, 2.5, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
   */
  private assembleTaskContext(task: CodingTask, step: TaskStep): TaskContext {
    // Collect prior step artifacts (Req 10.5).
    const priorArtifacts: ExecutionArtifact[] = [];
    for (let i = 0; i < task.currentStepIndex; i++) {
      priorArtifacts.push(...task.steps[i].artifacts);
    }

    // Include current step's artifacts (from prior attempts on retry).
    if (step.artifacts.length > 0) {
      priorArtifacts.push(...step.artifacts);
    }

    // Collect operator feedback for the current step (Req 10.5).
    const feedback = step.feedbackHistory.length > 0
      ? [...step.feedbackHistory]
      : undefined;

    // Get the connected agent info.
    const agent = task.assignedAgentId
      ? this.agentConnector.getAgent(task.assignedAgentId)
      : undefined;

    // Resolve Isolation_Boundary from SessionManager via agent's sessionId (Req 10.4).
    let isolationBoundary: TaskContext['isolationBoundary'] = {
      allowedNamespaces: [],
      allowedChannels: [],
      allowedServices: [],
    };

    if (agent && this.sessionManager) {
      const session = this.sessionManager.getSession(agent.sessionId);
      if (session?.isolationBoundary) {
        isolationBoundary = {
          allowedNamespaces: session.isolationBoundary.allowedNamespaces,
          allowedChannels: session.isolationBoundary.allowedChannels,
          allowedServices: session.isolationBoundary.allowedServices,
        };
      }
    }

    // Resolve file contents with Policy_Engine authorization (Req 10.2).
    const filePaths = step.filePaths;
    let fileContents: Record<string, string> | undefined;

    if (filePaths && filePaths.length > 0 && task.assignedAgentId) {
      const authorized: Record<string, string> = {};
      for (const filePath of filePaths) {
        const decision = this.policyEngine.evaluate({
          agentId: task.assignedAgentId,
          operation: 'read',
          resource: `file:${filePath}`,
        });
        if (decision.allowed) {
          // In a real implementation, file contents would be read from disk.
          // Here we include the path as a placeholder — the actual file reading
          // is handled by the dispatch layer. We store the path to indicate
          // authorization was granted.
          authorized[filePath] = `[authorized:${filePath}]`;
        }
      }
      if (Object.keys(authorized).length > 0) {
        fileContents = authorized;
      }
    }

    // Resolve Memory_Store data with namespace permission checks (Req 10.3).
    const memoryRefs = step.memoryReferences;
    let memoryData: Record<string, unknown> | undefined;

    if (memoryRefs && memoryRefs.length > 0 && task.assignedAgentId) {
      const authorized: Record<string, unknown> = {};
      for (const ref of memoryRefs) {
        // Check namespace access via Policy_Engine.
        const decision = this.policyEngine.evaluate({
          agentId: task.assignedAgentId,
          operation: 'read',
          resource: `memory:${ref.namespace}`,
        });
        if (decision.allowed) {
          // Synchronous context assembly — we store a marker that the
          // reference is authorized. Actual async reads happen in the
          // async wrapper assembleTaskContextAsync if needed.
          authorized[`${ref.namespace}:${ref.key}`] = `[authorized:${ref.namespace}:${ref.key}]`;
        }
      }
      if (Object.keys(authorized).length > 0) {
        memoryData = authorized;
      }
    }

    const context: TaskContext = {
      taskId: task.id,
      stepId: step.id,
      instructions: step.instructions,
      isolationBoundary,
      maxContextSizeBytes: this.maxContextSizeBytes,
      ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
      ...(fileContents ? { fileContents } : {}),
      ...(memoryRefs && memoryRefs.length > 0 ? { memoryReferences: memoryRefs } : {}),
      ...(memoryData ? { memoryData } : {}),
      priorStepArtifacts: priorArtifacts.length > 0 ? priorArtifacts : undefined,
      operatorFeedback: feedback,
    };

    // Enforce maximum context size (Req 10.6).
    const contextSize = JSON.stringify(context).length;
    if (contextSize > this.maxContextSizeBytes) {
      throw new Error(
        `Task_Context size (${contextSize} bytes) exceeds maximum allowed size (${this.maxContextSizeBytes} bytes)`,
      );
    }

    return context;
  }

  /**
   * Handle agent events (step results, health changes, disconnections).
   *
   * When a step_result event is received, the artifacts are added to
   * the current step and the step transitions to review.
   */
  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === 'step_result') {
      const data = event.data as {
        artifact?: ExecutionArtifact;
        artifacts?: ExecutionArtifact[];
        success?: boolean;
        error?: string;
        taskId?: string;
        stepId?: string;
      };

      // Find the task associated with this agent.
      const task = this.findTaskByAgent(event.agentId);
      if (!task || task.status !== 'in_progress') {
        return;
      }

      const currentStep = task.steps[task.currentStepIndex];
      if (!currentStep || currentStep.status !== 'executing') {
        return;
      }

      const now = new Date();

      // Collect artifacts.
      if (data.artifact) {
        currentStep.artifacts.push(data.artifact);

        // Add to artifact buffer for late-joining operators (Req 8.4).
        this.addToArtifactBuffer(task.id, data.artifact);

        // Persist artifact to Memory_Store.
        void this.persistArtifactToMemoryStore(
          data.artifact,
          task.assignedAgentId ?? 'system',
        );

        this.emitEvent({
          type: 'artifact_received',
          taskId: task.id,
          stepId: currentStep.id,
          timestamp: now,
          data: { artifactId: data.artifact.id },
        });

        // Stream artifact to operator in real time.
        this.operatorInterface.broadcastEvent(`task:${task.id}`, {
          channel: `task:${task.id}`,
          type: 'artifact_stream',
          data: { artifact: data.artifact },
          timestamp: now,
        });
      }

      if (data.artifacts) {
        for (const artifact of data.artifacts) {
          currentStep.artifacts.push(artifact);

          // Add to artifact buffer for late-joining operators (Req 8.4).
          this.addToArtifactBuffer(task.id, artifact);

          // Persist artifact to Memory_Store.
          void this.persistArtifactToMemoryStore(
            artifact,
            task.assignedAgentId ?? 'system',
          );

          this.emitEvent({
            type: 'artifact_received',
            taskId: task.id,
            stepId: currentStep.id,
            timestamp: now,
            data: { artifactId: artifact.id },
          });

          // Stream each artifact to operator in real time (Req 8.1).
          this.operatorInterface.broadcastEvent(`task:${task.id}`, {
            channel: `task:${task.id}`,
            type: 'artifact_stream',
            data: { artifact },
            timestamp: now,
          });
        }
      }

      // If the agent reports completion, transition step to review.
      if (data.success !== undefined) {
        if (data.success) {
          const prevStatus = currentStep.status;
          currentStep.status = 'review';
          currentStep.updatedAt = now;

          // Persist all step artifacts to Memory_Store on review transition.
          void this.persistStepArtifacts(task, currentStep);

          void this.recordStateTransition(
            task,
            currentStep,
            'step_status',
            prevStatus,
            'review',
            now,
          );

          this.emitEvent({
            type: 'step_status_change',
            taskId: task.id,
            stepId: currentStep.id,
            timestamp: now,
            data: { previousStatus: prevStatus, newStatus: 'review' },
          });

          // Present artifacts to operator.
          this.operatorInterface.broadcastEvent(`task:${task.id}`, {
            channel: `task:${task.id}`,
            type: 'step_review',
            data: {
              taskId: task.id,
              stepId: currentStep.id,
              artifacts: currentStep.artifacts,
            },
            timestamp: now,
          });
        } else {
          // Step failed.
          const prevStatus = currentStep.status;
          currentStep.status = 'failed';
          currentStep.updatedAt = now;

          // Persist all step artifacts to Memory_Store on failure.
          void this.persistStepArtifacts(task, currentStep);

          void this.recordStateTransition(
            task,
            currentStep,
            'step_status',
            prevStatus,
            'failed',
            now,
            undefined,
            data.error,
          );

          this.emitEvent({
            type: 'step_status_change',
            taskId: task.id,
            stepId: currentStep.id,
            timestamp: now,
            data: {
              previousStatus: prevStatus,
              newStatus: 'failed',
              error: data.error,
            },
          });

          // Present failure artifacts to operator.
          this.operatorInterface.broadcastEvent(`task:${task.id}`, {
            channel: `task:${task.id}`,
            type: 'step_failed',
            data: {
              taskId: task.id,
              stepId: currentStep.id,
              artifacts: currentStep.artifacts,
              error: data.error,
            },
            timestamp: now,
          });
        }
      }
    }
  }

  /**
   * Find a task currently assigned to the given agent.
   */
  private findTaskByAgent(agentId: string): CodingTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.assignedAgentId === agentId && task.status === 'in_progress') {
        return task;
      }
    }
    return undefined;
  }

  /**
   * Transition a task to completed status.
   *
   * Artifacts are retained in Memory_Store per the configured retention
   * policy (artifactRetentionMs). They are NOT deleted on completion —
   * a separate cleanup process can use the retention policy to prune
   * old artifacts.
   *
   * Requirements: 2.7, 5.6
   */
  private async completeTask(task: CodingTask, now: Date): Promise<void> {
    const previousStatus = task.status;
    task.status = 'completed';
    task.updatedAt = now;

    // Ensure all step artifacts are persisted to Memory_Store.
    for (const step of task.steps) {
      if (step.artifacts.length > 0) {
        await this.persistStepArtifacts(task, step);
      }
    }

    // Clear the artifact buffer — artifacts are persisted in Memory_Store (Req 8.4).
    this.artifactBuffers.delete(task.id);

    await this.recordStateTransition(
      task,
      task.steps[task.currentStepIndex],
      'task_status',
      previousStatus,
      'completed',
      now,
    );

    this.emitEvent({
      type: 'task_status_change',
      taskId: task.id,
      timestamp: now,
      data: { previousStatus, newStatus: 'completed' },
    });
  }

  /**
   * Check whether all steps in a task are in a terminal state
   * (completed, failed, or skipped).
   */
  private allStepsTerminal(task: CodingTask): boolean {
    return task.steps.every(
      (s) =>
        s.status === 'completed' ||
        s.status === 'failed' ||
        s.status === 'skipped',
    );
  }

  /**
   * Find the next step in pending status starting from the given index.
   * Returns -1 if no pending step is found.
   */
  private findNextPendingStepIndex(
    task: CodingTask,
    fromIndex: number,
  ): number {
    for (let i = fromIndex; i < task.steps.length; i++) {
      if (task.steps[i].status === 'pending') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Record a state transition in the Audit_Log.
   *
   * Requirements: 2.10, 9.1
   */
  private async recordStateTransition(
    task: CodingTask,
    step: TaskStep | undefined,
    transitionType: 'task_status' | 'step_status',
    previousStatus: string,
    newStatus: string,
    timestamp: Date,
    operatorId?: string,
    reason?: string,
  ): Promise<void> {
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp,
      agentId: task.assignedAgentId,
      operatorId: operatorId ?? task.operatorId,
      eventType: 'coding_task',
      operation: transitionType === 'task_status'
        ? 'task_state_transition'
        : 'step_state_transition',
      resource: transitionType === 'task_status'
        ? `task:${task.id}`
        : `step:${step?.id ?? 'unknown'}`,
      details: {
        taskId: task.id,
        stepId: step?.id,
        transitionType,
        previousStatus,
        newStatus,
        reason,
      },
    });
  }

  /**
   * Persist a single artifact to Memory_Store under the task namespace.
   *
   * Namespace convention: `task:{taskId}`
   * Key convention: `artifact:{artifactId}`
   * Tags: `type:{artifactType}`, `step:{stepId}`, `task:{taskId}`
   *
   * Requirements: 5.1, 5.4
   */
  private async persistArtifactToMemoryStore(
    artifact: ExecutionArtifact,
    agentId: string,
  ): Promise<void> {
    const namespace = `task:${artifact.taskId}`;
    const key = `artifact:${artifact.id}`;
    const tags = [
      `type:${artifact.type}`,
      `step:${artifact.stepId}`,
      `task:${artifact.taskId}`,
    ];

    try {
      await this.memoryStore.write(agentId, namespace, key, artifact, tags);
    } catch {
      // Best-effort persistence — in-memory artifacts remain the primary source.
    }
  }

  /**
   * Persist all artifacts for a step to Memory_Store.
   *
   * Called when a step transitions to a terminal or review state
   * (review, completed, failed) to ensure durability.
   *
   * Requirements: 5.1, 5.4, 5.6
   */
  private async persistStepArtifacts(
    task: CodingTask,
    step: TaskStep,
  ): Promise<void> {
    const agentId = task.assignedAgentId ?? 'system';
    for (const artifact of step.artifacts) {
      await this.persistArtifactToMemoryStore(artifact, agentId);
    }
  }

  /**
   * Emit a task event to all registered handlers.
   */
  private emitEvent(event: TaskEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow handler errors to prevent cascading failures.
      }
    }
  }

  /**
   * Add an artifact to the buffer for a task.
   *
   * The buffer accumulates all artifacts streamed during task execution
   * so that late-joining operators can retrieve the full history.
   *
   * Requirements: 8.4
   */
  private addToArtifactBuffer(taskId: string, artifact: ExecutionArtifact): void {
    let buffer = this.artifactBuffers.get(taskId);
    if (!buffer) {
      buffer = [];
      this.artifactBuffers.set(taskId, buffer);
    }
    buffer.push(artifact);
  }
}
