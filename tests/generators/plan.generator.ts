import fc from 'fast-check';
import type {
  GeneratedPlan,
  PlanRevisionEntry,
} from '../../src/interfaces/orchestration-config.js';
import { arbitraryTaskStepDefinition } from './coding-task.generator.js';

/** Generate a UUID-format plan ID */
export const arbitraryPlanId = (): fc.Arbitrary<string> => fc.uuid();

/** Generate a non-empty modification instruction string */
export const arbitraryPlanModification = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom(
      'Add a step to run unit tests before deployment',
      'Remove the database migration step',
      'Reorder steps so linting happens first',
      'Split the build step into separate compile and bundle steps',
      'Add error handling for the API call step',
      'Make the deployment step wait for CI approval',
      'Reduce the number of parallel steps to avoid rate limiting',
      'Add a rollback step in case deployment fails',
    ),
    fc.string({ minLength: 5, maxLength: 200 }).filter(s => s.trim().length >= 5),
  );

/** Generate a valid GeneratedPlan with 1-10 steps */
export const arbitraryGeneratedPlan = (): fc.Arbitrary<GeneratedPlan> =>
  fc.record({
    steps: fc.array(arbitraryTaskStepDefinition(), { minLength: 1, maxLength: 10 }),
    reasoning: fc.string({ minLength: 10, maxLength: 500 }).filter(s => s.trim().length >= 10),
    estimatedDuration: fc.option(
      fc.constantFrom(
        '5 minutes',
        '10 minutes',
        '15 minutes',
        '30 minutes',
        '1 hour',
        '2 hours',
        '4 hours',
      ),
      { nil: undefined },
    ),
  });

/** Generate a valid PlanRevisionEntry */
export const arbitraryPlanRevisionEntry = (): fc.Arbitrary<PlanRevisionEntry> =>
  fc.record({
    planId: arbitraryPlanId(),
    plan: arbitraryGeneratedPlan(),
    modificationInstructions: fc.option(arbitraryPlanModification(), { nil: undefined }),
    generatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
  });

/** Generate a non-empty array of PlanRevisionEntry objects representing a revision history */
export const arbitraryPlanRevisionHistory = (): fc.Arbitrary<PlanRevisionEntry[]> =>
  fc.array(arbitraryPlanRevisionEntry(), { minLength: 1, maxLength: 5 });

/** Generate a GeneratedPlan with an attached planId (as stored on the session) */
export const arbitraryCurrentPlan = (): fc.Arbitrary<GeneratedPlan & { planId: string }> =>
  fc.tuple(arbitraryGeneratedPlan(), arbitraryPlanId()).map(([plan, planId]) => ({
    ...plan,
    planId,
  }));
