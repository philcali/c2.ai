import fc from 'fast-check';
import type {
  OrchestrationSession,
  OrchestrationState,
  OrchestrationEvent,
} from '../../src/interfaces/orchestration-config.js';
import { arbitraryStructuredIntent } from './structured-intent.generator.js';
import { arbitraryWorkspaceContext } from './workspace-context.generator.js';

/** Generate a valid OrchestrationState */
export const arbitraryOrchestrationState = (): fc.Arbitrary<OrchestrationState> =>
  fc.constantFrom(
    'intent_received',
    'pending_approval',
    'resolving_workspace',
    'spawning_agent',
    'planning_task',
    'executing',
    'completed',
    'failed',
  );

/** Generate a valid OrchestrationSession in various states */
export const arbitraryOrchestrationSession = (): fc.Arbitrary<OrchestrationSession> =>
  arbitraryOrchestrationState().chain(state => {
    const hasWorkspace = [
      'spawning_agent', 'planning_task', 'executing', 'completed', 'failed',
    ].includes(state);
    const hasAgent = [
      'planning_task', 'executing', 'completed',
    ].includes(state);
    const hasCodingTask = [
      'executing', 'completed',
    ].includes(state);
    const hasFailed = state === 'failed';
    const hasCompleted = state === 'completed';

    return fc.record({
      id: fc.uuid(),
      state: fc.constant(state),
      intent: arbitraryStructuredIntent(),
      operatorId: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      workspaceContext: hasWorkspace
        ? arbitraryWorkspaceContext().map(ws => ws as OrchestrationSession['workspaceContext'])
        : fc.constant(undefined),
      agentId: hasAgent
        ? fc.uuid().map(id => id as string | undefined)
        : fc.constant(undefined),
      agentSessionId: hasAgent
        ? fc.uuid().map(id => id as string | undefined)
        : fc.constant(undefined),
      codingTaskId: hasCodingTask
        ? fc.uuid().map(id => id as string | undefined)
        : fc.constant(undefined),
      failureReason: hasFailed
        ? fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0).map(r => r as string | undefined)
        : fc.constant(undefined),
      createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
      updatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
      completedAt: hasCompleted
        ? fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map(d => d as Date | undefined)
        : fc.constant(undefined),
    });
  });

/** Generate a valid OrchestrationEvent */
export const arbitraryOrchestrationEvent = (): fc.Arbitrary<OrchestrationEvent> =>
  fc.record({
    sessionId: fc.uuid(),
    fromState: arbitraryOrchestrationState(),
    toState: arbitraryOrchestrationState(),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
    metadata: fc.option(
      fc.dictionary(
        fc.constantFrom('reason', 'agentId', 'taskId', 'error'),
        fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), fc.integer(), fc.boolean()),
        { minKeys: 1, maxKeys: 3 }
      ),
      { nil: undefined }
    ),
  });
