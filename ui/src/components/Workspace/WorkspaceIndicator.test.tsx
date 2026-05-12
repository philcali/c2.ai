import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceIndicator } from './WorkspaceIndicator.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import type { WorkspaceEntry } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedWorkspaces(sessionId: string, entries: WorkspaceEntry[]) {
  const store = useWorkspaceStore.getState();
  for (const entry of entries) {
    store.addWorkspace(sessionId, entry);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceIndicator', () => {
  beforeEach(() => {
    // Reset the store between tests
    useWorkspaceStore.setState({ workspaces: new Map() });
  });

  // ---- Panel rendering ----

  it('renders the panel header with title', () => {
    render(<WorkspaceIndicator sessionId="s1" />);
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
  });

  it('displays workspace count badge', () => {
    seedWorkspaces('s1', [
      { repository: 'repo-a', path: '/home/repo-a', filesAccessed: [], filesModified: [] },
      { repository: 'repo-b', path: '/home/repo-b', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    expect(screen.getByTestId('workspace-count')).toHaveTextContent('2');
  });

  it('shows 0 count when no workspaces exist', () => {
    render(<WorkspaceIndicator sessionId="s1" />);
    expect(screen.getByTestId('workspace-count')).toHaveTextContent('0');
  });

  it('shows 0 count when sessionId is null', () => {
    render(<WorkspaceIndicator sessionId={null} />);
    expect(screen.getByTestId('workspace-count')).toHaveTextContent('0');
  });

  // ---- Collapsible panel ----

  it('does not show workspace list when panel is collapsed', () => {
    seedWorkspaces('s1', [
      { repository: 'repo-a', path: '/home/repo-a', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    expect(screen.queryByTestId('workspace-list')).not.toBeInTheDocument();
  });

  it('shows workspace list when panel is expanded', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      { repository: 'repo-a', path: '/home/repo-a', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);

    await user.click(screen.getByLabelText('Workspaces panel'));
    expect(screen.getByTestId('workspace-list')).toBeInTheDocument();
  });

  it('shows empty state when panel is expanded with no workspaces', async () => {
    const user = userEvent.setup();
    render(<WorkspaceIndicator sessionId="s1" />);

    await user.click(screen.getByLabelText('Workspaces panel'));
    expect(screen.getByTestId('workspace-empty')).toBeInTheDocument();
    expect(screen.getByText('No workspaces tracked yet')).toBeInTheDocument();
  });

  it('toggles panel closed on second click', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      { repository: 'repo-a', path: '/home/repo-a', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);

    const header = screen.getByLabelText('Workspaces panel');
    await user.click(header);
    expect(screen.getByTestId('workspace-list')).toBeInTheDocument();

    await user.click(header);
    expect(screen.queryByTestId('workspace-list')).not.toBeInTheDocument();
  });

  // ---- Workspace entry rendering ----

  it('renders repository name and path for each workspace', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      { repository: 'my-app', path: '/projects/my-app', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    await user.click(screen.getByLabelText('Workspaces panel'));

    expect(screen.getByText('my-app')).toBeInTheDocument();
    expect(screen.getByText('/projects/my-app')).toBeInTheDocument();
  });

  // ---- File details expansion ----

  it('shows files accessed and modified when workspace entry is expanded', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      {
        repository: 'my-app',
        path: '/projects/my-app',
        filesAccessed: ['src/index.ts', 'src/utils.ts'],
        filesModified: ['src/index.ts'],
      },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);

    // Open the panel
    await user.click(screen.getByLabelText('Workspaces panel'));

    // File details should not be visible yet
    expect(screen.queryByTestId('workspace-file-details')).not.toBeInTheDocument();

    // Click the workspace entry to expand it
    await user.click(screen.getByLabelText('Workspace my-app'));

    expect(screen.getByTestId('workspace-file-details')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-files-accessed')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-files-modified')).toBeInTheDocument();

    // Check file names within their respective sections
    const accessedList = screen.getByTestId('workspace-files-accessed');
    expect(accessedList).toHaveTextContent('src/index.ts');
    expect(accessedList).toHaveTextContent('src/utils.ts');

    const modifiedList = screen.getByTestId('workspace-files-modified');
    expect(modifiedList).toHaveTextContent('src/index.ts');
  });

  it('does not show expand icon when workspace has no files', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      { repository: 'empty-repo', path: '/projects/empty', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    await user.click(screen.getByLabelText('Workspaces panel'));

    // Click the entry — should not show file details
    await user.click(screen.getByLabelText('Workspace empty-repo'));
    expect(screen.queryByTestId('workspace-file-details')).not.toBeInTheDocument();
  });

  it('only shows accessed section when no files are modified', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      {
        repository: 'read-only',
        path: '/projects/read-only',
        filesAccessed: ['README.md'],
        filesModified: [],
      },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    await user.click(screen.getByLabelText('Workspaces panel'));
    await user.click(screen.getByLabelText('Workspace read-only'));

    expect(screen.getByTestId('workspace-files-accessed')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-files-modified')).not.toBeInTheDocument();
  });

  it('only shows modified section when no files are accessed', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      {
        repository: 'write-only',
        path: '/projects/write-only',
        filesAccessed: [],
        filesModified: ['config.json'],
      },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    await user.click(screen.getByLabelText('Workspaces panel'));
    await user.click(screen.getByLabelText('Workspace write-only'));

    expect(screen.queryByTestId('workspace-files-accessed')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-files-modified')).toBeInTheDocument();
  });

  // ---- Session isolation ----

  it('only shows workspaces for the given sessionId', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      { repository: 'repo-s1', path: '/s1', filesAccessed: [], filesModified: [] },
    ]);
    seedWorkspaces('s2', [
      { repository: 'repo-s2', path: '/s2', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);
    await user.click(screen.getByLabelText('Workspaces panel'));

    expect(screen.getByText('repo-s1')).toBeInTheDocument();
    expect(screen.queryByText('repo-s2')).not.toBeInTheDocument();
  });

  // ---- Keyboard accessibility ----

  it('panel header is keyboard accessible', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      { repository: 'repo-a', path: '/home/repo-a', filesAccessed: [], filesModified: [] },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);

    const header = screen.getByLabelText('Workspaces panel');
    header.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('workspace-list')).toBeInTheDocument();
  });

  it('workspace entry is keyboard accessible', async () => {
    const user = userEvent.setup();
    seedWorkspaces('s1', [
      {
        repository: 'kb-repo',
        path: '/kb',
        filesAccessed: ['file.ts'],
        filesModified: [],
      },
    ]);

    render(<WorkspaceIndicator sessionId="s1" />);

    // Open panel
    await user.click(screen.getByLabelText('Workspaces panel'));

    // Focus and press Enter on workspace entry
    const entry = screen.getByLabelText('Workspace kb-repo');
    entry.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('workspace-file-details')).toBeInTheDocument();
  });
});
