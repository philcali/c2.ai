import { v4 as uuidv4 } from 'uuid';
import type {
  IACPAdapter,
  ACPAgentCard,
  ACPTaskSubmission,
  ACPTask,
  ACPTaskStatus,
  ACPTaskEvent,
} from '../interfaces/acp-adapter.js';
import type { ValidationResult } from '../interfaces/manifest-validator.js';
import type { ICommunicationBus, ACPMessagePayload } from '../interfaces/communication-bus.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { IAgentDiscoveryRegistry } from '../interfaces/agent-discovery-registry.js';

/**
 * Valid ACP task state transitions.
 *
 * The ACP task state machine:
 *   submitted → working → (completed | failed | canceled)
 *                       → input-required → working
 *   submitted → canceled
 *   submitted → failed (policy denied / unreachable)
 */
const VALID_TRANSITIONS: Record<ACPTaskStatus, ACPTaskStatus[]> = {
  submitted: ['working', 'canceled', 'failed'],
  working: ['completed', 'failed', 'canceled', 'input-required'],
  'input-required': ['working'],
  completed: [],
  failed: [],
  canceled: [],
};

/**
 * Required top-level fields on an ACP Agent Card.
 */
const REQUIRED_CARD_FIELDS: (keyof ACPAgentCard)[] = [
  'name',
  'url',
  'version',
  'capabilities',
  'skills',
  'defaultInputContentTypes',
  'defaultOutputContentTypes',
];

/**
 * Required capability flags on an ACP Agent Card.
 */
const REQUIRED_CAPABILITY_FIELDS: (keyof ACPAgentCard['capabilities'])[] = [
  'streaming',
  'pushNotifications',
  'stateTransitionHistory',
];

/**
 * In-memory ACP Adapter implementation.
 *
 * Translates between the Agent Communication Protocol's REST-based task
 * lifecycle and the Command Center's internal Communication Bus. Enables
 * external agents (built in any framework) to participate in C2
 * orchestration via the ACP standard.
 *
 * Guarantees:
 *  - Agent Card schema validation on registration (required fields, types).
 *  - Task submission requires Policy Engine authorization.
 *  - All task lifecycle events are recorded in the Audit Log.
 *  - Task state machine enforces valid transitions only.
 *  - SSE-style streaming of task updates via AsyncIterable.
 *  - Agent cards are stored in the Agent Discovery Registry.
 *
 * Requirements: 11.1, 11.2, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9
 */
export class ACPAdapter implements IACPAdapter {
  /** Agent Discovery Registry for card storage and lookup. */
  private readonly discoveryRegistry: IAgentDiscoveryRegistry;

  /** Communication Bus for routing messages between agents. */
  private readonly communicationBus: ICommunicationBus;

  /** Policy Engine for authorization checks on task submissions. */
  private readonly policyEngine: IPolicyEngine;

  /** Audit Log for recording ACP events. */
  private readonly auditLog: IAuditLog;

  /** Active tasks indexed by task ID. */
  private readonly tasks: Map<string, ACPTask> = new Map();

  /**
   * Listeners for task update events, keyed by task ID.
   * Each listener set receives ACPTaskEvent notifications when the task
   * transitions state.
   */
  private readonly taskListeners: Map<string, Set<(event: ACPTaskEvent) => void>> = new Map();

  constructor(options: {
    discoveryRegistry: IAgentDiscoveryRegistry;
    communicationBus: ICommunicationBus;
    policyEngine: IPolicyEngine;
    auditLog: IAuditLog;
  }) {
    this.discoveryRegistry = options.discoveryRegistry;
    this.communicationBus = options.communicationBus;
    this.policyEngine = options.policyEngine;
    this.auditLog = options.auditLog;
  }

  // ------------------------------------------------------------------
  // IACPAdapter — Agent Registration
  // ------------------------------------------------------------------

  /**
   * Register an external agent by its ACP Agent Card.
   *
   * Validates the card schema (required fields: name, url, version,
   * capabilities, skills, defaultInputContentTypes, defaultOutputContentTypes)
   * and stores it in the Agent Discovery Registry.
   *
   * Requirements: 11.2, 11.9
   */
  async registerAgent(card: ACPAgentCard): Promise<ValidationResult> {
    const validation = this.validateAgentCard(card);
    if (!validation.valid) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        eventType: 'acp_discovery',
        operation: 'register_agent',
        resource: `acp:agent:${card?.url ?? 'unknown'}`,
        decision: 'deny',
        details: {
          reason: 'Agent Card validation failed',
          errors: validation.errors,
        },
      });
      return validation;
    }

    await this.discoveryRegistry.register(card);

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      eventType: 'acp_discovery',
      operation: 'register_agent',
      resource: `acp:agent:${card.url}`,
      decision: 'allow',
      details: {
        agentName: card.name,
        agentUrl: card.url,
        agentVersion: card.version,
        skillCount: card.skills.length,
      },
    });

    return { valid: true, errors: [] };
  }

  /**
   * Unregister an external agent by URL.
   *
   * Removes the agent from the Discovery Registry and logs the event.
   */
  unregisterAgent(agentUrl: string): void {
    this.discoveryRegistry.deregister(agentUrl);

    // Fire-and-forget audit log (synchronous caller contract).
    void this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      eventType: 'acp_discovery',
      operation: 'unregister_agent',
      resource: `acp:agent:${agentUrl}`,
      details: { agentUrl },
    });
  }

  // ------------------------------------------------------------------
  // IACPAdapter — Task Lifecycle
  // ------------------------------------------------------------------

  /**
   * Submit a task to a target agent via the ACP task lifecycle.
   *
   * Flow:
   *  1. Verify the target agent is registered.
   *  2. Authorize the sender via the Policy Engine.
   *  3. Route the task message through the Communication Bus.
   *  4. Create the ACP task in 'submitted' state.
   *  5. Record the event in the Audit Log.
   *
   * Requirements: 11.4, 11.8
   */
  async submitTask(
    senderId: string,
    targetAgentUrl: string,
    task: ACPTaskSubmission,
  ): Promise<ACPTask> {
    const now = new Date();
    const taskId = uuidv4();

    // 1. Verify target agent is registered.
    const targetCard = this.discoveryRegistry.getCard(targetAgentUrl);
    if (!targetCard) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: senderId,
        eventType: 'acp_task',
        operation: 'submit_task',
        resource: `acp:task:${taskId}`,
        decision: 'deny',
        details: {
          taskId,
          targetAgentUrl,
          reason: `Target agent '${targetAgentUrl}' is not registered`,
        },
      });

      throw new Error(`Target agent '${targetAgentUrl}' is not registered`);
    }

    // 2. Policy Engine authorization.
    const authzDecision = this.policyEngine.evaluate({
      agentId: senderId,
      operation: 'submit_task',
      resource: `acp:task:${targetAgentUrl}`,
      context: {
        skill: task.skill,
        targetAgentUrl,
      },
    });

    if (!authzDecision.allowed) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: senderId,
        eventType: 'acp_task',
        operation: 'submit_task',
        resource: `acp:task:${taskId}`,
        decision: 'deny',
        details: {
          taskId,
          targetAgentUrl,
          policyId: authzDecision.policyId,
          reason: authzDecision.reason,
        },
      });

      throw new Error(`Task submission denied: ${authzDecision.reason}`);
    }

    // 3. Route through Communication Bus.
    const deliveryResult = await this.communicationBus.sendMessage(
      senderId,
      targetAgentUrl,
      task.message,
    );

    // 4. Create the ACP task.
    const acpTask: ACPTask = {
      id: taskId,
      senderId,
      targetAgentUrl,
      status: deliveryResult.delivered ? 'submitted' : 'failed',
      message: task.message,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(taskId, acpTask);

    // 5. Record in Audit Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: senderId,
      eventType: 'acp_task',
      operation: 'submit_task',
      resource: `acp:task:${taskId}`,
      decision: 'allow',
      details: {
        taskId,
        targetAgentUrl,
        status: acpTask.status,
        skill: task.skill,
        delivered: deliveryResult.delivered,
        failureReason: deliveryResult.failureReason,
      },
    });

    // Emit initial task event for stream listeners.
    this.emitTaskEvent({
      taskId,
      status: acpTask.status,
      message: task.message,
      timestamp: now,
    });

    return acpTask;
  }

  /**
   * Poll for task status.
   *
   * Requirements: 11.5
   */
  getTaskStatus(taskId: string): ACPTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Cancel a running task.
   *
   * Transitions the task to 'canceled' state if the current state allows it,
   * and records the cancellation in the Audit Log.
   *
   * Requirements: 11.5, 11.6
   */
  async cancelTask(taskId: string, reason: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    const validNext = VALID_TRANSITIONS[task.status];
    if (!validNext.includes('canceled')) {
      throw new Error(
        `Cannot cancel task '${taskId}' in state '${task.status}'. ` +
        `Valid transitions from '${task.status}': ${validNext.join(', ') || 'none'}`,
      );
    }

    const now = new Date();
    task.status = 'canceled';
    task.updatedAt = now;

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: task.senderId,
      eventType: 'acp_task',
      operation: 'cancel_task',
      resource: `acp:task:${taskId}`,
      details: {
        taskId,
        targetAgentUrl: task.targetAgentUrl,
        reason,
        previousStatus: task.status,
      },
    });

    this.emitTaskEvent({
      taskId,
      status: 'canceled',
      timestamp: now,
    });
  }

  /**
   * Stream task updates via an AsyncIterable (SSE-style).
   *
   * Returns an async iterable that yields ACPTaskEvent objects whenever
   * the task transitions state. The iterable completes when the task
   * reaches a terminal state (completed, failed, canceled).
   *
   * Requirements: 11.5
   */
  streamTaskUpdates(taskId: string): AsyncIterable<ACPTaskEvent> {
    const task = this.tasks.get(taskId);
    const taskListeners = this.taskListeners;

    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<ACPTaskEvent> {
        const buffer: ACPTaskEvent[] = [];
        let waiting: ((value: IteratorResult<ACPTaskEvent>) => void) | null = null;
        let done = false;

        // If the task is already in a terminal state, yield it immediately.
        if (task && isTerminalStatus(task.status)) {
          buffer.push({
            taskId,
            status: task.status,
            message: task.result,
            timestamp: task.updatedAt,
          });
          done = true;
        }

        const listener = (event: ACPTaskEvent): void => {
          if (done) return;

          if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve({ value: event, done: false });
          } else {
            buffer.push(event);
          }

          // If the event is terminal, mark the stream as done.
          if (isTerminalStatus(event.status)) {
            done = true;
          }
        };

        // Register listener for this task.
        if (!done) {
          let listeners = taskListeners.get(taskId);
          if (!listeners) {
            listeners = new Set();
            taskListeners.set(taskId, listeners);
          }
          listeners.add(listener);
        }

        return {
          next(): Promise<IteratorResult<ACPTaskEvent>> {
            if (buffer.length > 0) {
              const event = buffer.shift()!;
              return Promise.resolve({ value: event, done: false });
            }

            if (done) {
              return Promise.resolve({
                value: undefined as unknown as ACPTaskEvent,
                done: true,
              });
            }

            return new Promise<IteratorResult<ACPTaskEvent>>((resolve) => {
              waiting = resolve;
            });
          },

          return(): Promise<IteratorResult<ACPTaskEvent>> {
            done = true;
            const listeners = taskListeners.get(taskId);
            if (listeners) {
              listeners.delete(listener);
              if (listeners.size === 0) {
                taskListeners.delete(taskId);
              }
            }
            if (waiting) {
              waiting({ value: undefined as unknown as ACPTaskEvent, done: true });
              waiting = null;
            }
            return Promise.resolve({
              value: undefined as unknown as ACPTaskEvent,
              done: true,
            });
          },

          throw(err?: unknown): Promise<IteratorResult<ACPTaskEvent>> {
            done = true;
            const listeners = taskListeners.get(taskId);
            if (listeners) {
              listeners.delete(listener);
              if (listeners.size === 0) {
                taskListeners.delete(taskId);
              }
            }
            if (waiting) {
              waiting({ value: undefined as unknown as ACPTaskEvent, done: true });
              waiting = null;
            }
            return Promise.reject(err);
          },

          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  /**
   * List all registered external agents.
   *
   * Delegates to the Agent Discovery Registry.
   */
  listRegisteredAgents(): ACPAgentCard[] {
    return this.discoveryRegistry.listAll();
  }

  // ------------------------------------------------------------------
  // Task state management (used by other subsystems or tests)
  // ------------------------------------------------------------------

  /**
   * Transition a task to a new status.
   *
   * Validates the transition against the ACP task state machine and
   * records the event in the Audit Log.
   *
   * This method is intended for use by subsystems that process task
   * results (e.g., the Communication Bus delivering a response from
   * the target agent).
   */
  async transitionTask(
    taskId: string,
    newStatus: ACPTaskStatus,
    result?: ACPMessagePayload,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    const validNext = VALID_TRANSITIONS[task.status];
    if (!validNext.includes(newStatus)) {
      throw new Error(
        `Invalid task transition: '${task.status}' → '${newStatus}'. ` +
        `Valid transitions from '${task.status}': ${validNext.join(', ') || 'none'}`,
      );
    }

    const now = new Date();
    const previousStatus = task.status;
    task.status = newStatus;
    task.updatedAt = now;

    if (result !== undefined) {
      task.result = result;
    }

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: task.senderId,
      eventType: 'acp_task',
      operation: 'transition_task',
      resource: `acp:task:${taskId}`,
      details: {
        taskId,
        targetAgentUrl: task.targetAgentUrl,
        previousStatus,
        newStatus,
        hasResult: result !== undefined,
      },
    });

    this.emitTaskEvent({
      taskId,
      status: newStatus,
      message: result,
      timestamp: now,
    });
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Validate an ACP Agent Card against the required schema.
   *
   * Required fields: name, url, version, capabilities, skills,
   * defaultInputContentTypes, defaultOutputContentTypes.
   *
   * Requirements: 11.9
   */
  private validateAgentCard(card: ACPAgentCard): ValidationResult {
    const errors: string[] = [];

    if (!card || typeof card !== 'object') {
      return { valid: false, errors: ['Agent Card must be a non-null object'] };
    }

    // Check required top-level fields.
    for (const field of REQUIRED_CARD_FIELDS) {
      if (card[field] === undefined || card[field] === null) {
        errors.push(`Missing required field '${field}'`);
      }
    }

    // Validate string fields.
    if (card.name !== undefined && (typeof card.name !== 'string' || card.name.trim() === '')) {
      errors.push("Field 'name' must be a non-empty string");
    }

    if (card.url !== undefined && (typeof card.url !== 'string' || card.url.trim() === '')) {
      errors.push("Field 'url' must be a non-empty string");
    }

    if (card.version !== undefined && (typeof card.version !== 'string' || card.version.trim() === '')) {
      errors.push("Field 'version' must be a non-empty string");
    }

    // Validate capabilities object.
    if (card.capabilities !== undefined && card.capabilities !== null) {
      if (typeof card.capabilities !== 'object') {
        errors.push("Field 'capabilities' must be an object");
      } else {
        for (const capField of REQUIRED_CAPABILITY_FIELDS) {
          if (typeof card.capabilities[capField] !== 'boolean') {
            errors.push(`Field 'capabilities.${capField}' must be a boolean`);
          }
        }
      }
    }

    // Validate skills array.
    if (card.skills !== undefined && card.skills !== null) {
      if (!Array.isArray(card.skills)) {
        errors.push("Field 'skills' must be an array");
      } else {
        for (let i = 0; i < card.skills.length; i++) {
          const skill = card.skills[i];
          if (!skill.id || typeof skill.id !== 'string') {
            errors.push(`Skill at index ${i}: 'id' is required and must be a non-empty string`);
          }
          if (!skill.name || typeof skill.name !== 'string') {
            errors.push(`Skill at index ${i}: 'name' is required and must be a non-empty string`);
          }
          if (!skill.description || typeof skill.description !== 'string') {
            errors.push(`Skill at index ${i}: 'description' is required and must be a non-empty string`);
          }
        }
      }
    }

    // Validate content type arrays.
    if (card.defaultInputContentTypes !== undefined && card.defaultInputContentTypes !== null) {
      if (!Array.isArray(card.defaultInputContentTypes)) {
        errors.push("Field 'defaultInputContentTypes' must be an array");
      } else if (card.defaultInputContentTypes.length === 0) {
        errors.push("Field 'defaultInputContentTypes' must not be empty");
      } else if (card.defaultInputContentTypes.some((ct: unknown) => typeof ct !== 'string' || (ct as string).trim() === '')) {
        errors.push("Each entry in 'defaultInputContentTypes' must be a non-empty string");
      }
    }

    if (card.defaultOutputContentTypes !== undefined && card.defaultOutputContentTypes !== null) {
      if (!Array.isArray(card.defaultOutputContentTypes)) {
        errors.push("Field 'defaultOutputContentTypes' must be an array");
      } else if (card.defaultOutputContentTypes.length === 0) {
        errors.push("Field 'defaultOutputContentTypes' must not be empty");
      } else if (card.defaultOutputContentTypes.some((ct: unknown) => typeof ct !== 'string' || (ct as string).trim() === '')) {
        errors.push("Each entry in 'defaultOutputContentTypes' must be a non-empty string");
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Emit a task event to all registered listeners for the given task.
   */
  private emitTaskEvent(event: ACPTaskEvent): void {
    const listeners = this.taskListeners.get(event.taskId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }

      // Clean up listeners for terminal states.
      if (isTerminalStatus(event.status)) {
        this.taskListeners.delete(event.taskId);
      }
    }
  }
}

// ------------------------------------------------------------------
// Standalone helpers
// ------------------------------------------------------------------

/**
 * Check whether an ACP task status is terminal (no further transitions).
 */
function isTerminalStatus(status: ACPTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}
