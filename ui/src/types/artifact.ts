/**
 * Discriminated union of execution artifact types.
 *
 * Each variant carries a `type` discriminant so renderers can
 * exhaustively switch on the artifact kind.
 */
export type ExecutionArtifact =
  | { type: 'diff'; id: string; filePath: string; before: string; after: string; timestamp: string }
  | { type: 'terminal'; id: string; command: string; exitCode: number; stdout: string; stderr: string; timestamp: string }
  | { type: 'tool_invocation'; id: string; toolName: string; parameters: Record<string, unknown>; result: unknown; timestamp: string }
  | { type: 'error'; id: string; code: string; message: string; details: string; timestamp: string };
