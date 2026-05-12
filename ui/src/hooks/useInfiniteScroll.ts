import { useEffect, useRef, type RefObject } from 'react';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseInfiniteScrollOptions {
  /** Callback invoked when the sentinel element becomes visible. */
  loadMore: () => void;
  /** Whether more data is available. When false the observer disconnects. */
  hasMore: boolean;
  /** Whether a load is currently in progress (prevents duplicate calls). */
  isLoading?: boolean;
  /**
   * IntersectionObserver `rootMargin` value.
   * Defaults to `'100px'` so the callback fires slightly before the
   * sentinel scrolls fully into view.
   */
  rootMargin?: string;
  /**
   * IntersectionObserver `threshold` value.
   * Defaults to `0` (trigger as soon as any part is visible).
   */
  threshold?: number;
}

export interface UseInfiniteScrollResult {
  /** Ref to attach to the sentinel element. */
  sentinelRef: RefObject<HTMLElement | null>;
}

/**
 * React hook that uses IntersectionObserver to trigger a `loadMore`
 * callback when a sentinel element scrolls into view.
 *
 * Attach the returned `sentinelRef` to a DOM element placed at the
 * scroll boundary (e.g. the top of a chat message list for loading
 * older messages).
 *
 * The observer automatically disconnects when `hasMore` is false and
 * reconnects when it becomes true again.
 *
 * Requirements: 3.6
 */
export function useInfiniteScroll(
  options: UseInfiniteScrollOptions,
): UseInfiniteScrollResult {
  const {
    loadMore,
    hasMore,
    isLoading = false,
    rootMargin = '100px',
    threshold = 0,
  } = options;

  const sentinelRef = useRef<HTMLElement | null>(null);

  // Keep a stable reference to the latest loadMore so the observer
  // callback always calls the current version without re-subscribing.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !isLoadingRef.current) {
          loadMoreRef.current();
        }
      },
      { rootMargin, threshold },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, rootMargin, threshold]);

  return { sentinelRef };
}
