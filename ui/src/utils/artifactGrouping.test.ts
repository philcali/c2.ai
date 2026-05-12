import { describe, it, expect } from 'vitest';
import { groupArtifactsByType } from './artifactGrouping.js';
import type { ExecutionArtifact } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = '2026-06-01T10:00:00Z';

const diff1: ExecutionArtifact = {
  type: 'diff',
  id: 'diff-1',
  filePath: 'a.ts',
  before: 'old',
  after: 'new',
  timestamp: ts,
};

const diff2: ExecutionArtifact = {
  type: 'diff',
  id: 'diff-2',
  filePath: 'b.ts',
  before: 'old2',
  after: 'new2',
  timestamp: ts,
};

const terminal1: ExecutionArtifact = {
  type: 'terminal',
  id: 'term-1',
  command: 'npm test',
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  timestamp: ts,
};

const tool1: ExecutionArtifact = {
  type: 'tool_invocation',
  id: 'tool-1',
  toolName: 'readFile',
  parameters: { path: 'x.ts' },
  result: 'content',
  timestamp: ts,
};

const error1: ExecutionArtifact = {
  type: 'error',
  id: 'err-1',
  code: 'E001',
  message: 'fail',
  details: 'details',
  timestamp: ts,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('groupArtifactsByType', () => {
  it('returns empty array for empty input', () => {
    expect(groupArtifactsByType([])).toEqual([]);
  });

  it('groups artifacts by type', () => {
    const groups = groupArtifactsByType([diff1, terminal1, diff2, error1, tool1]);

    expect(groups).toHaveLength(4);
    expect(groups[0].type).toBe('diff');
    expect(groups[0].artifacts).toHaveLength(2);
    expect(groups[1].type).toBe('terminal');
    expect(groups[1].artifacts).toHaveLength(1);
    expect(groups[2].type).toBe('tool_invocation');
    expect(groups[2].artifacts).toHaveLength(1);
    expect(groups[3].type).toBe('error');
    expect(groups[3].artifacts).toHaveLength(1);
  });

  it('preserves original order within groups', () => {
    const groups = groupArtifactsByType([diff2, diff1]);

    expect(groups[0].artifacts[0].id).toBe('diff-2');
    expect(groups[0].artifacts[1].id).toBe('diff-1');
  });

  it('returns groups in canonical order (diff, terminal, tool_invocation, error)', () => {
    // Input in reverse canonical order
    const groups = groupArtifactsByType([error1, tool1, terminal1, diff1]);

    expect(groups.map((g) => g.type)).toEqual([
      'diff',
      'terminal',
      'tool_invocation',
      'error',
    ]);
  });

  it('omits types not present in input', () => {
    const groups = groupArtifactsByType([terminal1, error1]);

    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe('terminal');
    expect(groups[1].type).toBe('error');
  });

  it('includes human-readable labels', () => {
    const groups = groupArtifactsByType([diff1, terminal1, tool1, error1]);

    expect(groups[0].label).toBe('Diffs');
    expect(groups[1].label).toBe('Terminal Output');
    expect(groups[2].label).toBe('Tool Invocations');
    expect(groups[3].label).toBe('Errors');
  });

  it('preserves all artifacts — no missing, no duplicates', () => {
    const input = [diff1, terminal1, diff2, error1, tool1];
    const groups = groupArtifactsByType(input);

    const allOutputIds = groups.flatMap((g) => g.artifacts.map((a) => a.id));
    const inputIds = input.map((a) => a.id);

    // Same set of IDs
    expect(allOutputIds.sort()).toEqual(inputIds.sort());
    // No duplicates
    expect(new Set(allOutputIds).size).toBe(allOutputIds.length);
  });

  it('every artifact in a group shares the same type', () => {
    const groups = groupArtifactsByType([diff1, terminal1, diff2, error1, tool1]);

    for (const group of groups) {
      for (const artifact of group.artifacts) {
        expect(artifact.type).toBe(group.type);
      }
    }
  });

  it('handles single artifact', () => {
    const groups = groupArtifactsByType([tool1]);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('tool_invocation');
    expect(groups[0].artifacts).toHaveLength(1);
  });
});
