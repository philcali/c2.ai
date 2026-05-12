import fc from 'fast-check';
import type {
  StepTriggerType,
  StepExecutionMode,
  StepTrigger,
  TaskStepDefinition,
  CodingTaskSubmission,
} from '../../src/interfaces/task-orchestrator.js';
import type { CapabilityRequirements } from '../../src/interfaces/agent-connector.js';

/** Generate a random StepTriggerType */
export const arbitraryStepTriggerType = (): fc.Arbitrary<StepTriggerType> =>
  fc.constantFrom('operator', 'time-based', 'event-driven');

/** Generate a random StepExecutionMode */
export const arbitraryStepExecutionMode = (): fc.Arbitrary<StepExecutionMode> =>
  fc.constantFrom('agent', 'external-event');

/** Generate a StepTrigger with fields appropriate for its type */
export const arbitraryStepTrigger = (): fc.Arbitrary<StepTrigger> =>
  fc.oneof(
    // Operator trigger
    fc.record({
      type: fc.constant('operator' as StepTriggerType),
      timeoutMs: fc.option(
        fc.integer({ min: 5000, max: 600_000 }),
        { nil: undefined }
      ),
    }),
    // Time-based trigger
    fc.record({
      type: fc.constant('time-based' as StepTriggerType),
      eventSourceId: fc.option(fc.uuid(), { nil: undefined }),
      eventType: fc.option(
        fc.constantFrom('ci_status', 'build_status', 'deploy_status'),
        { nil: undefined }
      ),
      pollingIntervalMs: fc.integer({ min: 1000, max: 300_000 }),
      timeoutMs: fc.option(
        fc.integer({ min: 10_000, max: 3_600_000 }),
        { nil: undefined }
      ),
    }),
    // Event-driven trigger
    fc.record({
      type: fc.constant('event-driven' as StepTriggerType),
      eventSourceId: fc.uuid(),
      eventType: fc.constantFrom(
        'ci_passed', 'ci_failed', 'pr_merged', 'pr_approved',
        'deploy_succeeded', 'deploy_failed', 'review_completed',
      ),
      timeoutMs: fc.option(
        fc.integer({ min: 10_000, max: 3_600_000 }),
        { nil: undefined }
      ),
    }),
  );

/** Generate capability requirements for agent selection */
export const arbitraryCapabilityRequirements = (): fc.Arbitrary<CapabilityRequirements> =>
  fc.record({
    languages: fc.option(
      fc.array(
        fc.constantFrom('typescript', 'javascript', 'python', 'rust', 'go', 'java', 'c++'),
        { minLength: 1, maxLength: 4 }
      ),
      { nil: undefined }
    ),
    frameworks: fc.option(
      fc.array(
        fc.constantFrom('react', 'vue', 'angular', 'express', 'fastify', 'django', 'flask', 'nextjs'),
        { minLength: 1, maxLength: 3 }
      ),
      { nil: undefined }
    ),
    tools: fc.option(
      fc.array(
        fc.constantFrom('git', 'docker', 'npm', 'yarn', 'pnpm', 'webpack', 'vite', 'eslint', 'prettier'),
        { minLength: 1, maxLength: 4 }
      ),
      { nil: undefined }
    ),
  });

/** Generate a single TaskStepDefinition */
export const arbitraryTaskStepDefinition = (): fc.Arbitrary<TaskStepDefinition> =>
  arbitraryStepExecutionMode().chain(executionMode => {
    const base = {
      instructions: fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0),
      executionMode: fc.constant(executionMode as StepExecutionMode),
    };

    if (executionMode === 'external-event') {
      return fc.record({
        ...base,
        trigger: fc.option(arbitraryStepTrigger(), { nil: undefined }),
      });
    }

    return fc.record({
      ...base,
      trigger: fc.option(
        // Agent steps typically use operator triggers or no trigger
        fc.record({
          type: fc.constant('operator' as StepTriggerType),
          eventSourceId: fc.constant(undefined),
          eventType: fc.constant(undefined),
          pollingIntervalMs: fc.constant(undefined),
          timeoutMs: fc.option(
            fc.integer({ min: 5000, max: 600_000 }),
            { nil: undefined }
          ),
        }),
        { nil: undefined }
      ),
    });
  });

/** Generate a CodingTaskSubmission with a coherent step sequence */
export const arbitraryCodingTaskSubmission = (): fc.Arbitrary<CodingTaskSubmission> =>
  fc.record({
    operatorId: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
    steps: fc.array(arbitraryTaskStepDefinition(), { minLength: 1, maxLength: 8 }),
    agentId: fc.option(fc.uuid(), { nil: undefined }),
    requirements: fc.option(arbitraryCapabilityRequirements(), { nil: undefined }),
  });
