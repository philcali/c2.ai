import fc from 'fast-check';
import type { TaskContext } from '../../src/interfaces/task-orchestrator.js';
import { arbitraryExecutionArtifact } from './execution-artifact.generator.js';
import { arbitraryFeedbackEntry } from './execution-artifact.generator.js';

/** Generate an isolation boundary */
export const arbitraryIsolationBoundary = (): fc.Arbitrary<TaskContext['isolationBoundary']> =>
  fc.record({
    allowedNamespaces: fc.array(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      { minLength: 0, maxLength: 5 }
    ),
    allowedChannels: fc.array(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      { minLength: 0, maxLength: 5 }
    ),
    allowedServices: fc.array(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      { minLength: 0, maxLength: 5 }
    ),
  });

/** Generate a TaskContext delivered to a Coding_Agent for step execution */
export const arbitraryTaskContext = (): fc.Arbitrary<TaskContext> =>
  fc.record({
    taskId: fc.uuid(),
    stepId: fc.uuid(),
    instructions: fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0),
    filePaths: fc.option(
      fc.array(
        fc.constantFrom(
          'src/index.ts', 'src/main.ts', 'src/utils.ts', 'package.json',
          'tsconfig.json', 'README.md', 'tests/unit/example.test.ts',
        ),
        { minLength: 1, maxLength: 5 }
      ),
      { nil: undefined }
    ),
    fileContents: fc.option(
      fc.dictionary(
        fc.constantFrom('src/index.ts', 'src/main.ts', 'package.json'),
        fc.string({ minLength: 0, maxLength: 300 }),
        { minKeys: 1, maxKeys: 3 }
      ),
      { nil: undefined }
    ),
    memoryReferences: fc.option(
      fc.array(
        fc.record({
          namespace: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
          key: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        }),
        { minLength: 1, maxLength: 5 }
      ),
      { nil: undefined }
    ),
    memoryData: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      { nil: undefined }
    ),
    isolationBoundary: arbitraryIsolationBoundary(),
    priorStepArtifacts: fc.option(
      fc.array(arbitraryExecutionArtifact(), { minLength: 1, maxLength: 5 }),
      { nil: undefined }
    ),
    operatorFeedback: fc.option(
      fc.array(arbitraryFeedbackEntry(), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
    maxContextSizeBytes: fc.option(
      fc.integer({ min: 1024, max: 10_485_760 }),
      { nil: undefined }
    ),
  });
