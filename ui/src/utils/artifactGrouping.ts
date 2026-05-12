import type { ExecutionArtifact } from '../types/index.js';

/**
 * A group of artifacts sharing the same type.
 */
export interface ArtifactGroup {
  /** The shared artifact type for this group. */
  type: ExecutionArtifact['type'];
  /** Human-readable label for the group. */
  label: string;
  /** Artifacts in this group, in their original order. */
  artifacts: ExecutionArtifact[];
}

/** Map artifact type discriminant to a human-readable label. */
const TYPE_LABELS: Record<ExecutionArtifact['type'], string> = {
  diff: 'Diffs',
  terminal: 'Terminal Output',
  tool_invocation: 'Tool Invocations',
  error: 'Errors',
};

/** Canonical ordering for artifact type groups. */
const TYPE_ORDER: ExecutionArtifact['type'][] = [
  'diff',
  'terminal',
  'tool_invocation',
  'error',
];

/**
 * Group a list of execution artifacts by their `type` discriminant.
 *
 * Returns an array of `ArtifactGroup` objects, one per distinct type
 * present in the input. Groups are ordered by a canonical type order
 * (diff → terminal → tool_invocation → error). Artifacts within each
 * group retain their original relative order.
 *
 * Guarantees:
 * - Every artifact in a group shares the same `type`.
 * - No artifacts from the input are missing from the output.
 * - No duplicate artifacts appear.
 *
 * Requirements: 5.5
 */
export function groupArtifactsByType(
  artifacts: ExecutionArtifact[],
): ArtifactGroup[] {
  // Build a map of type → artifacts, preserving insertion order.
  const map = new Map<ExecutionArtifact['type'], ExecutionArtifact[]>();

  for (const artifact of artifacts) {
    const existing = map.get(artifact.type);
    if (existing) {
      existing.push(artifact);
    } else {
      map.set(artifact.type, [artifact]);
    }
  }

  // Return groups in canonical order, skipping types not present.
  const groups: ArtifactGroup[] = [];

  for (const type of TYPE_ORDER) {
    const items = map.get(type);
    if (items && items.length > 0) {
      groups.push({
        type,
        label: TYPE_LABELS[type],
        artifacts: items,
      });
    }
  }

  return groups;
}
