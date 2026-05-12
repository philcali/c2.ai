import fc from 'fast-check';
import type {
  ExecutionArtifact,
  DiffArtifact,
  TerminalArtifact,
  ToolInvocationArtifact,
  ErrorArtifact,
} from '../../src/interfaces/agent-connector.js';
import type {
  FeedbackEntry,
  ArtifactQuery,
} from '../../src/interfaces/task-orchestrator.js';

/** Generate a DiffArtifact */
export const arbitraryDiffArtifact = (): fc.Arbitrary<DiffArtifact> =>
  fc.record({
    filePath: fc.constantFrom(
      'src/index.ts', 'src/utils.ts', 'src/main.py', 'README.md',
      'package.json', 'tests/unit/example.test.ts', 'src/components/App.tsx',
    ),
    beforeContent: fc.string({ minLength: 0, maxLength: 500 }),
    afterContent: fc.string({ minLength: 0, maxLength: 500 }),
  });

/** Generate a TerminalArtifact */
export const arbitraryTerminalArtifact = (): fc.Arbitrary<TerminalArtifact> =>
  fc.record({
    command: fc.constantFrom(
      'npm run build', 'npm test', 'git status', 'tsc --noEmit',
      'eslint .', 'vitest --run', 'python -m pytest', 'cargo build',
    ),
    exitCode: fc.oneof(
      fc.constant(0),
      fc.constant(1),
      fc.integer({ min: 0, max: 255 }),
    ),
    stdout: fc.string({ minLength: 0, maxLength: 300 }),
    stderr: fc.string({ minLength: 0, maxLength: 200 }),
  });

/** Generate a ToolInvocationArtifact */
export const arbitraryToolInvocationArtifact = (): fc.Arbitrary<ToolInvocationArtifact> =>
  fc.record({
    toolName: fc.constantFrom(
      'readFile', 'writeFile', 'executeCommand', 'searchFiles',
      'listDirectory', 'webSearch', 'createFile', 'deleteFile',
    ),
    params: fc.oneof(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 15 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      fc.constant(null),
    ),
    result: fc.oneof(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 15 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      fc.constant(null),
    ),
  });

/** Generate an ErrorArtifact */
export const arbitraryErrorArtifact = (): fc.Arbitrary<ErrorArtifact> =>
  fc.record({
    code: fc.constantFrom(
      'AGENT_TIMEOUT', 'BUILD_FAILURE', 'TEST_FAILURE', 'PERMISSION_DENIED',
      'NETWORK_ERROR', 'INTERNAL_ERROR', 'INVALID_INPUT', 'RESOURCE_NOT_FOUND',
    ),
    message: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
    details: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 15 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      { nil: undefined }
    ),
  });

/** Generate an ExecutionArtifact with a typed data payload matching its type field */
export const arbitraryExecutionArtifact = (): fc.Arbitrary<ExecutionArtifact> =>
  fc.oneof(
    arbitraryDiffArtifact().chain(data =>
      fc.record({
        id: fc.uuid(),
        taskId: fc.uuid(),
        stepId: fc.uuid(),
        type: fc.constant('diff' as const),
        timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        data: fc.constant(data),
      })
    ),
    arbitraryTerminalArtifact().chain(data =>
      fc.record({
        id: fc.uuid(),
        taskId: fc.uuid(),
        stepId: fc.uuid(),
        type: fc.constant('terminal_output' as const),
        timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        data: fc.constant(data),
      })
    ),
    arbitraryToolInvocationArtifact().chain(data =>
      fc.record({
        id: fc.uuid(),
        taskId: fc.uuid(),
        stepId: fc.uuid(),
        type: fc.constant('tool_invocation' as const),
        timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        data: fc.constant(data),
      })
    ),
    arbitraryErrorArtifact().chain(data =>
      fc.record({
        id: fc.uuid(),
        taskId: fc.uuid(),
        stepId: fc.uuid(),
        type: fc.constant('error' as const),
        timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        data: fc.constant(data),
      })
    ),
  );

/** Generate a FeedbackEntry */
export const arbitraryFeedbackEntry = (): fc.Arbitrary<FeedbackEntry> =>
  fc.record({
    id: fc.uuid(),
    stepId: fc.uuid(),
    operatorId: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
    content: fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
  });

/** Generate an ArtifactQuery with optional filters */
export const arbitraryArtifactQuery = (): fc.Arbitrary<ArtifactQuery> =>
  fc.record({
    taskId: fc.uuid(),
    stepId: fc.option(fc.uuid(), { nil: undefined }),
    type: fc.option(
      fc.constantFrom('diff', 'terminal_output', 'tool_invocation', 'error' as const),
      { nil: undefined }
    ),
    timeRange: fc.option(
      fc.tuple(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2028-12-31') }),
        fc.date({ min: new Date('2029-01-01'), max: new Date('2030-12-31') }),
      ).map(([start, end]) => ({ start, end })),
      { nil: undefined }
    ),
  });
