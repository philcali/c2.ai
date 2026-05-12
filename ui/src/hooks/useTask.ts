import { useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTaskStore } from '../stores/taskStore.js';
import { getOrCreateAuthDeps } from './useAuth.js';
import type { CodingTask } from '../types/index.js';
import type { StepDefinition } from '../api/client.js';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const taskKeys = {
  all: ['tasks'] as const,
  detail: (taskId: string) => [...taskKeys.all, 'detail', taskId] as const,
  list: (sessionId: string) => [...taskKeys.all, 'list', sessionId] as const,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseTaskResult {
  /** The task data (from the Zustand store, kept in sync via query + WebSocket). */
  task: CodingTask | undefined;
  /** Whether the task is being fetched. */
  isLoading: boolean;
  /** Whether the task card is expanded. */
  isExpanded: boolean;
  /** Toggle the expanded/collapsed state. */
  toggleExpanded: () => void;

  // -- Review mutations --

  /** Advance the task to the next step (approve). */
  advanceTask: () => void;
  /** Whether an advance request is in flight. */
  isAdvancing: boolean;

  /** Retry the current step with operator feedback. */
  retryStep: (feedback: string) => void;
  /** Whether a retry request is in flight. */
  isRetrying: boolean;

  /** Redirect the task with new step definitions. */
  redirectTask: (steps: StepDefinition[], fromIndex: number) => void;
  /** Whether a redirect request is in flight. */
  isRedirecting: boolean;

  /** Cancel the task with a reason. */
  cancelTask: (reason: string) => void;
  /** Whether a cancel request is in flight. */
  isCanceling: boolean;

  /** The last mutation error, if any. */
  mutationError: string | null;
}

/**
 * React hook for task data and review-cycle mutations.
 *
 * Fetches the task via TanStack Query and syncs it into the Zustand
 * task store.  Real-time updates arrive via WebSocket and are applied
 * directly to the store by the `useWebSocket` hook, so the UI stays
 * current without polling.
 *
 * Requirements: 4.1, 6.1, 6.2, 6.3, 6.4
 */
export function useTask(taskId: string | null): UseTaskResult {
  const { apiClient } = getOrCreateAuthDeps();

  const task = useTaskStore((s) =>
    taskId ? s.tasks.get(taskId) : undefined,
  );
  const isExpanded = useTaskStore((s) =>
    taskId ? s.expandedTasks.has(taskId) : false,
  );
  const setTask = useTaskStore((s) => s.setTask);
  const toggleExpandedAction = useTaskStore((s) => s.toggleExpanded);

  // -- Fetch task data --
  const taskQuery = useQuery<CodingTask>({
    queryKey: taskKeys.detail(taskId ?? '__none__'),
    queryFn: async () => {
      if (!taskId) throw new Error('No task ID');
      return apiClient.getTask(taskId);
    },
    enabled: !!taskId,
  });

  // Sync fetched task into the store.
  useEffect(() => {
    if (taskQuery.data) {
      setTask(taskQuery.data);
    }
  }, [taskQuery.data, setTask]);

  // -- Advance (approve) --
  const advanceMutation = useMutation<void, Error>({
    mutationFn: async () => {
      if (!taskId) throw new Error('No task ID');
      return apiClient.advanceTask(taskId);
    },
  });

  // -- Retry step --
  const retryMutation = useMutation<void, Error, string>({
    mutationFn: async (feedback: string) => {
      if (!taskId) throw new Error('No task ID');
      return apiClient.retryStep(taskId, feedback);
    },
  });

  // -- Redirect task --
  const redirectMutation = useMutation<
    void,
    Error,
    { steps: StepDefinition[]; fromIndex: number }
  >({
    mutationFn: async ({ steps, fromIndex }) => {
      if (!taskId) throw new Error('No task ID');
      return apiClient.redirectTask(taskId, steps, fromIndex);
    },
  });

  // -- Cancel task --
  const cancelMutation = useMutation<void, Error, string>({
    mutationFn: async (reason: string) => {
      if (!taskId) throw new Error('No task ID');
      return apiClient.cancelTask(taskId, reason);
    },
  });

  // Aggregate the latest mutation error.
  const mutationError =
    advanceMutation.error?.message ??
    retryMutation.error?.message ??
    redirectMutation.error?.message ??
    cancelMutation.error?.message ??
    null;

  return {
    task,
    isLoading: taskQuery.isLoading,
    isExpanded,
    toggleExpanded: () => {
      if (taskId) toggleExpandedAction(taskId);
    },

    advanceTask: () => advanceMutation.mutate(),
    isAdvancing: advanceMutation.isPending,

    retryStep: (feedback: string) => retryMutation.mutate(feedback),
    isRetrying: retryMutation.isPending,

    redirectTask: (steps: StepDefinition[], fromIndex: number) =>
      redirectMutation.mutate({ steps, fromIndex }),
    isRedirecting: redirectMutation.isPending,

    cancelTask: (reason: string) => cancelMutation.mutate(reason),
    isCanceling: cancelMutation.isPending,

    mutationError,
  };
}
