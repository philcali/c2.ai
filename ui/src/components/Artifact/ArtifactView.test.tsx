import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArtifactView } from './ArtifactView.js';
import type { ExecutionArtifact } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = '2026-06-01T10:00:00Z';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactView', () => {
  // ---- Diff artifact ----

  describe('diff artifact', () => {
    const diffArtifact: ExecutionArtifact = {
      type: 'diff',
      id: 'diff-1',
      filePath: 'src/utils/helper.ts',
      before: 'const x = 1;',
      after: 'const x = 2;',
      timestamp: ts,
    };

    it('renders file path', () => {
      render(<ArtifactView artifact={diffArtifact} />);
      expect(screen.getByTestId('diff-file-path')).toHaveTextContent('src/utils/helper.ts');
    });

    it('renders before content', () => {
      render(<ArtifactView artifact={diffArtifact} />);
      expect(screen.getByTestId('diff-before')).toHaveTextContent('const x = 1;');
    });

    it('renders after content', () => {
      render(<ArtifactView artifact={diffArtifact} />);
      expect(screen.getByTestId('diff-after')).toHaveTextContent('const x = 2;');
    });

    it('renders timestamp', () => {
      render(<ArtifactView artifact={diffArtifact} />);
      const time = screen.getByTestId('artifact-timestamp');
      expect(time).toHaveAttribute('datetime', ts);
    });

    it('renders type label', () => {
      render(<ArtifactView artifact={diffArtifact} />);
      expect(screen.getByText('Diff')).toBeInTheDocument();
    });
  });

  // ---- Terminal artifact ----

  describe('terminal artifact', () => {
    const terminalArtifact: ExecutionArtifact = {
      type: 'terminal',
      id: 'term-1',
      command: 'npm run build',
      exitCode: 0,
      stdout: 'Build successful',
      stderr: '',
      timestamp: ts,
    };

    it('renders command', () => {
      render(<ArtifactView artifact={terminalArtifact} />);
      expect(screen.getByTestId('terminal-command')).toHaveTextContent('npm run build');
    });

    it('renders exit code', () => {
      render(<ArtifactView artifact={terminalArtifact} />);
      expect(screen.getByTestId('terminal-exit-code')).toHaveTextContent('Exit code: 0');
    });

    it('renders stdout', () => {
      render(<ArtifactView artifact={terminalArtifact} />);
      expect(screen.getByTestId('terminal-stdout')).toHaveTextContent('Build successful');
    });

    it('renders stderr when present', () => {
      const withStderr: ExecutionArtifact = {
        ...terminalArtifact,
        id: 'term-2',
        stderr: 'Warning: deprecated API',
        exitCode: 1,
      };
      render(<ArtifactView artifact={withStderr} />);
      expect(screen.getByTestId('terminal-stderr')).toHaveTextContent('Warning: deprecated API');
    });

    it('does not render stderr when empty', () => {
      render(<ArtifactView artifact={terminalArtifact} />);
      expect(screen.queryByTestId('terminal-stderr')).not.toBeInTheDocument();
    });

    it('renders timestamp', () => {
      render(<ArtifactView artifact={terminalArtifact} />);
      const time = screen.getByTestId('artifact-timestamp');
      expect(time).toHaveAttribute('datetime', ts);
    });

    it('renders type label', () => {
      render(<ArtifactView artifact={terminalArtifact} />);
      expect(screen.getByText('Terminal')).toBeInTheDocument();
    });
  });

  // ---- Tool invocation artifact ----

  describe('tool invocation artifact', () => {
    const toolArtifact: ExecutionArtifact = {
      type: 'tool_invocation',
      id: 'tool-1',
      toolName: 'readFile',
      parameters: { path: 'src/index.ts', encoding: 'utf-8' },
      result: { content: 'export default {};', lines: 1 },
      timestamp: ts,
    };

    it('renders tool name', () => {
      render(<ArtifactView artifact={toolArtifact} />);
      expect(screen.getByTestId('tool-name')).toHaveTextContent('readFile');
    });

    it('renders parameters as JSON', () => {
      render(<ArtifactView artifact={toolArtifact} />);
      const params = screen.getByTestId('tool-parameters');
      expect(params.textContent).toContain('"path": "src/index.ts"');
      expect(params.textContent).toContain('"encoding": "utf-8"');
    });

    it('renders result', () => {
      render(<ArtifactView artifact={toolArtifact} />);
      const result = screen.getByTestId('tool-result');
      expect(result.textContent).toContain('"content": "export default {};"');
    });

    it('renders string result directly', () => {
      const stringResult: ExecutionArtifact = {
        ...toolArtifact,
        id: 'tool-2',
        result: 'plain string result',
      };
      render(<ArtifactView artifact={stringResult} />);
      expect(screen.getByTestId('tool-result')).toHaveTextContent('plain string result');
    });

    it('renders timestamp', () => {
      render(<ArtifactView artifact={toolArtifact} />);
      const time = screen.getByTestId('artifact-timestamp');
      expect(time).toHaveAttribute('datetime', ts);
    });

    it('renders type label', () => {
      render(<ArtifactView artifact={toolArtifact} />);
      expect(screen.getByText('Tool Invocation')).toBeInTheDocument();
    });
  });

  // ---- Error artifact ----

  describe('error artifact', () => {
    const errorArtifact: ExecutionArtifact = {
      type: 'error',
      id: 'err-1',
      code: 'EXEC_TIMEOUT',
      message: 'Step execution timed out after 30s',
      details: 'Process killed with SIGTERM',
      timestamp: ts,
    };

    it('renders error code', () => {
      render(<ArtifactView artifact={errorArtifact} />);
      expect(screen.getByTestId('error-code')).toHaveTextContent('EXEC_TIMEOUT');
    });

    it('renders error message', () => {
      render(<ArtifactView artifact={errorArtifact} />);
      expect(screen.getByTestId('error-message')).toHaveTextContent(
        'Step execution timed out after 30s',
      );
    });

    it('renders error details', () => {
      render(<ArtifactView artifact={errorArtifact} />);
      expect(screen.getByTestId('error-details')).toHaveTextContent(
        'Process killed with SIGTERM',
      );
    });

    it('does not render details when empty', () => {
      const noDetails: ExecutionArtifact = {
        ...errorArtifact,
        id: 'err-2',
        details: '',
      };
      render(<ArtifactView artifact={noDetails} />);
      expect(screen.queryByTestId('error-details')).not.toBeInTheDocument();
    });

    it('has role="alert" for accessibility', () => {
      render(<ArtifactView artifact={errorArtifact} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('renders timestamp', () => {
      render(<ArtifactView artifact={errorArtifact} />);
      const time = screen.getByTestId('artifact-timestamp');
      expect(time).toHaveAttribute('datetime', ts);
    });

    it('renders type label', () => {
      render(<ArtifactView artifact={errorArtifact} />);
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });
});
