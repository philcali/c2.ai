import { type ReactNode } from 'react';
import type { ChatMessage } from '../../types/index.js';
import { useTask } from '../../hooks/useTask.js';
import { TaskCard } from '../Task/TaskCard.js';
import { ReviewControls } from '../Review/ReviewControls.js';
import { ArtifactView } from '../Artifact/ArtifactView.js';
import { groupArtifactsByType } from '../../utils/artifactGrouping.js';
import styles from './MessageRenderer.module.css';

// ---------------------------------------------------------------------------
// Lightweight markdown parser — produces React elements (no dangerouslySetInnerHTML)
// ---------------------------------------------------------------------------

/** A parsed markdown token. */
type MdToken =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'inlineCode'; value: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'codeBlock'; language: string; code: string }
  | { kind: 'lineBreak' }
  | { kind: 'listItem'; value: string };

/**
 * Tokenise a markdown string into a flat list of tokens.
 *
 * Handles (in order of priority):
 *  - Fenced code blocks (``` ```lang\ncode``` ```)
 *  - Unordered list items (`- item`)
 *  - Bold (`**text**`)
 *  - Inline code (`` `code` ``)
 *  - Links (`[text](url)`)
 *  - Italic (`*text*`)
 *  - Line breaks
 */
export function tokeniseMarkdown(src: string): MdToken[] {
  const tokens: MdToken[] = [];
  const lines = src.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code block ---
    if (line.trimStart().startsWith('```')) {
      const language = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      // skip closing ```
      i += 1;
      tokens.push({ kind: 'codeBlock', language, code: codeLines.join('\n') });
      continue;
    }

    // --- Unordered list item ---
    if (/^- /.test(line)) {
      tokens.push({ kind: 'listItem', value: line.slice(2) });
      i += 1;
      continue;
    }

    // --- Inline content ---
    tokeniseInline(line, tokens);

    // Add a line break between lines (but not after the last line)
    if (i < lines.length - 1) {
      tokens.push({ kind: 'lineBreak' });
    }
    i += 1;
  }

  return tokens;
}

/**
 * Parse inline markdown elements from a single line and push tokens.
 */
function tokeniseInline(line: string, tokens: MdToken[]): void {
  // Regex matches (in priority order): bold, inline code, link, italic
  const inlineRe = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)]+?)\))|(\*(.+?)\*)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(line)) !== null) {
    // Push any plain text before this match
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: line.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      // Bold **text**
      tokens.push({ kind: 'bold', value: match[2] });
    } else if (match[3]) {
      // Inline code `code`
      tokens.push({ kind: 'inlineCode', value: match[4] });
    } else if (match[5]) {
      // Link [text](url)
      tokens.push({ kind: 'link', text: match[6], href: match[7] });
    } else if (match[8]) {
      // Italic *text*
      tokens.push({ kind: 'italic', value: match[9] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < line.length) {
    tokens.push({ kind: 'text', value: line.slice(lastIndex) });
  }
}

/**
 * Render a list of markdown tokens into React elements.
 */
function renderTokens(tokens: MdToken[]): ReactNode[] {
  const elements: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let keyCounter = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${keyCounter++}`} className={styles.markdownList}>
          {listItems}
        </ul>,
      );
      listItems = [];
    }
  };

  for (const token of tokens) {
    if (token.kind === 'listItem') {
      listItems.push(<li key={`li-${keyCounter++}`}>{token.value}</li>);
      continue;
    }

    // If we were accumulating list items and hit a non-list token, flush
    flushList();

    switch (token.kind) {
      case 'text':
        elements.push(<span key={`t-${keyCounter++}`}>{token.value}</span>);
        break;
      case 'bold':
        elements.push(<strong key={`b-${keyCounter++}`}>{token.value}</strong>);
        break;
      case 'italic':
        elements.push(<em key={`i-${keyCounter++}`}>{token.value}</em>);
        break;
      case 'inlineCode':
        elements.push(
          <code key={`ic-${keyCounter++}`} className={styles.inlineCode}>
            {token.value}
          </code>,
        );
        break;
      case 'link':
        elements.push(
          <a
            key={`a-${keyCounter++}`}
            href={token.href}
            className={styles.markdownLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            {token.text}
          </a>,
        );
        break;
      case 'codeBlock':
        elements.push(
          <div key={`cb-${keyCounter++}`}>
            {token.language && (
              <span className={styles.codeBlockLabel}>{token.language}</span>
            )}
            <code className={styles.codeBlock}>{token.code}</code>
          </div>,
        );
        break;
      case 'lineBreak':
        elements.push(<br key={`br-${keyCounter++}`} />);
        break;
    }
  }

  // Flush any trailing list items
  flushList();

  return elements;
}

// ---------------------------------------------------------------------------
// Markdown content renderer
// ---------------------------------------------------------------------------

function MarkdownContent({ content }: { content: string }) {
  const tokens = tokeniseMarkdown(content);
  return <div className={styles.markdown}>{renderTokens(tokens)}</div>;
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

function Timestamp({ iso, className }: { iso: string; className?: string }) {
  return (
    <time
      className={`${styles.timestamp}${className ? ` ${className}` : ''}`}
      dateTime={iso}
    >
      {new Date(iso).toLocaleTimeString()}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Inline task card with review controls and artifacts
// ---------------------------------------------------------------------------

function InlineTaskCard({ taskId, timestamp }: { taskId: string; timestamp: string }) {
  const {
    task,
    isLoading,
    isExpanded,
    toggleExpanded,
    advanceTask,
    isAdvancing,
    retryStep,
    isRetrying,
    redirectTask,
    isRedirecting,
    mutationError,
  } = useTask(taskId);

  if (isLoading || !task) {
    return (
      <div className={styles.taskMessage} data-testid={`task-loading-${taskId}`}>
        <div className={styles.taskBadge}>
          <span className={styles.taskIcon} aria-hidden="true">T</span>
          <span>Loading task {taskId}…</span>
        </div>
        <Timestamp iso={timestamp} />
      </div>
    );
  }

  const currentStep = task.steps[task.currentStepIndex];
  const isInReview = currentStep?.status === 'review';

  // Collect artifacts from the current step for inline display.
  const currentStepArtifacts = currentStep?.artifacts ?? [];
  const artifactGroups = currentStepArtifacts.length > 0
    ? groupArtifactsByType(currentStepArtifacts)
    : [];

  return (
    <div data-testid={`message-task-${taskId}`}>
      <TaskCard
        task={task}
        isExpanded={isExpanded}
        onToggleExpand={toggleExpanded}
      />

      {/* Render artifacts from the current step */}
      {artifactGroups.length > 0 && (
        <div className={styles.artifactSection} data-testid={`task-artifacts-${taskId}`}>
          {artifactGroups.map((group) => (
            <details key={group.type} open>
              <summary className={styles.artifactGroupSummary}>
                {group.label} ({group.artifacts.length})
              </summary>
              {group.artifacts.map((artifact) => (
                <ArtifactView key={artifact.id} artifact={artifact} />
              ))}
            </details>
          ))}
        </div>
      )}

      {/* Review controls when step is in review state */}
      {isInReview && (
        <ReviewControls
          onApprove={advanceTask}
          onRetry={retryStep}
          onRedirect={redirectTask}
          currentStepIndex={task.currentStepIndex}
          isAdvancing={isAdvancing}
          isRetrying={isRetrying}
          isRedirecting={isRedirecting}
          error={mutationError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory result renderer — structured tables/lists
// ---------------------------------------------------------------------------

function MemoryResultContent({ data }: { data: unknown }) {
  // If data is an array of entries with namespace/key/value, render as a table.
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'namespace' in data[0]) {
    return (
      <table className={styles.memoryTable} data-testid="memory-table">
        <thead>
          <tr>
            <th>Namespace</th>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((entry: Record<string, unknown>, idx: number) => (
            <tr key={idx}>
              <td>{String(entry.namespace ?? '')}</td>
              <td>{String(entry.key ?? '')}</td>
              <td>{typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // If data has a summary field, render it prominently.
  if (typeof data === 'object' && data !== null && 'summary' in data) {
    const obj = data as { summary: unknown; entries?: unknown[] };
    const hasEntries = Array.isArray(obj.entries) && obj.entries.length > 0;
    return (
      <div>
        <div className={styles.memorySummary} data-testid="memory-summary">
          {String(obj.summary)}
        </div>
        {hasEntries && (
          <MemoryResultContent data={obj.entries} />
        )}
      </div>
    );
  }

  // Fallback: render as formatted JSON or plain string.
  return (
    <pre className={styles.memoryData}>
      {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// MessageRenderer component
// ---------------------------------------------------------------------------

export interface MessageRendererProps {
  message: ChatMessage;
}

/**
 * Renders a single chat message based on its discriminated `type` field.
 *
 * Supports: operator, system (plain + markdown), task_created,
 * error (with role="alert"), and memory_result message types.
 *
 * Requirements: 3.1, 3.4, 3.7
 */
export function MessageRenderer({ message }: MessageRendererProps) {
  switch (message.type) {
    case 'operator':
      return (
        <div
          className={`${styles.message} ${styles.operatorMessage}`}
          data-testid={`message-${message.id}`}
        >
          <div>{message.content}</div>
          <Timestamp iso={message.timestamp} />
        </div>
      );

    case 'system':
      return (
        <div
          className={`${styles.message} ${styles.systemMessage}`}
          data-testid={`message-${message.id}`}
        >
          {message.format === 'markdown' ? (
            <MarkdownContent content={message.content} />
          ) : (
            <div>{message.content}</div>
          )}
          <Timestamp iso={message.timestamp} />
        </div>
      );

    case 'task_created':
      return (
        <div
          className={`${styles.message} ${styles.taskMessage}`}
          data-testid={`message-${message.id}`}
        >
          <InlineTaskCard taskId={message.taskId} timestamp={message.timestamp} />
          <Timestamp iso={message.timestamp} />
        </div>
      );

    case 'error':
      return (
        <div
          className={`${styles.message} ${styles.errorMessage}`}
          data-testid={`message-${message.id}`}
          role="alert"
        >
          <div>
            <span className={styles.errorCode}>{message.code}</span>
            {message.message}
          </div>
          <Timestamp iso={message.timestamp} />
        </div>
      );

    case 'memory_result':
      return (
        <div
          className={`${styles.message} ${styles.memoryMessage}`}
          data-testid={`message-${message.id}`}
        >
          <MemoryResultContent data={message.data} />
          <Timestamp iso={message.timestamp} />
        </div>
      );
  }
}
