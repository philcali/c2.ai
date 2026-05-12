import type { ExecutionArtifact } from '../../types/index.js';
import styles from './ArtifactView.module.css';

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

function ArtifactTimestamp({ iso }: { iso: string }) {
  return (
    <time className={styles.artifactTimestamp} dateTime={iso} data-testid="artifact-timestamp">
      {new Date(iso).toLocaleTimeString()}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Diff artifact
// ---------------------------------------------------------------------------

function DiffArtifactView({
  artifact,
}: {
  artifact: Extract<ExecutionArtifact, { type: 'diff' }>;
}) {
  return (
    <div
      className={`${styles.artifact} ${styles.diffArtifact}`}
      data-testid={`artifact-diff-${artifact.id}`}
    >
      <div className={styles.artifactHeader}>
        <span className={styles.artifactTypeLabel}>Diff</span>
        <ArtifactTimestamp iso={artifact.timestamp} />
      </div>

      <div className={styles.filePath} data-testid="diff-file-path">
        {artifact.filePath}
      </div>

      <div className={styles.diffContent}>
        <div className={`${styles.diffSection} ${styles.diffBefore}`}>
          <span className={styles.diffLabel}>Before</span>
          <code className={styles.diffCode} data-testid="diff-before">
            {artifact.before}
          </code>
        </div>
        <div className={`${styles.diffSection} ${styles.diffAfter}`}>
          <span className={styles.diffLabel}>After</span>
          <code className={styles.diffCode} data-testid="diff-after">
            {artifact.after}
          </code>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal artifact
// ---------------------------------------------------------------------------

function TerminalArtifactView({
  artifact,
}: {
  artifact: Extract<ExecutionArtifact, { type: 'terminal' }>;
}) {
  const exitSuccess = artifact.exitCode === 0;

  return (
    <div
      className={`${styles.artifact} ${styles.terminalArtifact}`}
      data-testid={`artifact-terminal-${artifact.id}`}
    >
      <div className={styles.artifactHeader}>
        <span className={styles.artifactTypeLabel}>Terminal</span>
        <ArtifactTimestamp iso={artifact.timestamp} />
      </div>

      <div className={styles.terminalBlock}>
        <div className={styles.terminalCommand}>
          <span className={styles.terminalPrompt} aria-hidden="true">
            $
          </span>
          <span className={styles.terminalCommandText} data-testid="terminal-command">
            {artifact.command}
          </span>
        </div>

        {artifact.stdout && (
          <div
            className={`${styles.terminalOutput} ${styles.terminalStdout}`}
            data-testid="terminal-stdout"
          >
            {artifact.stdout}
          </div>
        )}

        {artifact.stderr && (
          <div
            className={`${styles.terminalOutput} ${styles.terminalStderr}`}
            data-testid="terminal-stderr"
          >
            {artifact.stderr}
          </div>
        )}
      </div>

      <div
        className={`${styles.exitCode} ${exitSuccess ? styles.exitCodeSuccess : styles.exitCodeFailure}`}
        data-testid="terminal-exit-code"
      >
        Exit code: {artifact.exitCode}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool invocation artifact
// ---------------------------------------------------------------------------

function ToolInvocationArtifactView({
  artifact,
}: {
  artifact: Extract<ExecutionArtifact, { type: 'tool_invocation' }>;
}) {
  return (
    <div
      className={`${styles.artifact} ${styles.toolArtifact}`}
      data-testid={`artifact-tool-${artifact.id}`}
    >
      <div className={styles.artifactHeader}>
        <span className={styles.artifactTypeLabel}>Tool Invocation</span>
        <ArtifactTimestamp iso={artifact.timestamp} />
      </div>

      <div className={styles.toolBody}>
        <div className={styles.toolSection}>
          <span className={styles.toolSectionLabel}>Tool</span>
          <span className={styles.toolName} data-testid="tool-name">
            {artifact.toolName}
          </span>
        </div>

        <div className={styles.toolSection}>
          <span className={styles.toolSectionLabel}>Parameters</span>
          <pre className={styles.toolData} data-testid="tool-parameters">
            {JSON.stringify(artifact.parameters, null, 2)}
          </pre>
        </div>

        <div className={styles.toolSection}>
          <span className={styles.toolSectionLabel}>Result</span>
          <pre className={styles.toolData} data-testid="tool-result">
            {typeof artifact.result === 'string'
              ? artifact.result
              : JSON.stringify(artifact.result, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error artifact
// ---------------------------------------------------------------------------

function ErrorArtifactView({
  artifact,
}: {
  artifact: Extract<ExecutionArtifact, { type: 'error' }>;
}) {
  return (
    <div
      className={`${styles.artifact} ${styles.errorArtifact}`}
      data-testid={`artifact-error-${artifact.id}`}
      role="alert"
    >
      <div className={styles.artifactHeader}>
        <span className={styles.artifactTypeLabel}>Error</span>
        <ArtifactTimestamp iso={artifact.timestamp} />
      </div>

      <div className={styles.errorBody}>
        <span className={styles.errorCodeBadge} data-testid="error-code">
          {artifact.code}
        </span>
        <span className={styles.errorMessage} data-testid="error-message">
          {artifact.message}
        </span>
        {artifact.details && (
          <pre className={styles.errorDetails} data-testid="error-details">
            {artifact.details}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArtifactView — discriminated union renderer
// ---------------------------------------------------------------------------

export interface ArtifactViewProps {
  artifact: ExecutionArtifact;
}

/**
 * Renders a single execution artifact based on its discriminated `type` field.
 *
 * Supports: diff, terminal, tool_invocation, and error artifact types.
 * Each variant displays all required fields plus a timestamp.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
 */
export function ArtifactView({ artifact }: ArtifactViewProps) {
  switch (artifact.type) {
    case 'diff':
      return <DiffArtifactView artifact={artifact} />;
    case 'terminal':
      return <TerminalArtifactView artifact={artifact} />;
    case 'tool_invocation':
      return <ToolInvocationArtifactView artifact={artifact} />;
    case 'error':
      return <ErrorArtifactView artifact={artifact} />;
  }
}
