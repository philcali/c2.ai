import fc from 'fast-check';
import type { WorkspaceContext, WorkspaceMetadata } from '../../src/interfaces/orchestration-config.js';

/** Generate a valid WorkspaceContext with realistic paths and URLs */
export const arbitraryWorkspaceContext = (): fc.Arbitrary<WorkspaceContext> =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
  ).chain(([owner, repo]) =>
    fc.record({
      id: fc.uuid(),
      repositoryUrl: fc.constant(`https://github.com/${owner}/${repo}.git`),
      localPath: fc.constant(`/workspace/${owner}/${repo}`),
      branch: fc.constantFrom('main', 'develop', 'feature/auth', 'fix/bug-42', 'release/v1.0'),
      defaultBranch: fc.constantFrom('main', 'master', 'develop'),
      environment: fc.dictionary(
        fc.constantFrom('NODE_ENV', 'CI', 'WORKSPACE_DIR', 'LOG_LEVEL'),
        fc.constantFrom('development', 'production', 'true', 'false', '/workspace', 'info', 'debug'),
        { minKeys: 0, maxKeys: 3 }
      ),
      lastUsedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
      createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
    })
  );

/** Generate a valid WorkspaceMetadata object */
export const arbitraryWorkspaceMetadata = (): fc.Arbitrary<WorkspaceMetadata> =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
  ).chain(([owner, repo]) =>
    fc.record({
      repositoryUrl: fc.constant(`https://github.com/${owner}/${repo}.git`),
      localPath: fc.constant(`/workspace/${owner}/${repo}`),
      defaultBranch: fc.constantFrom('main', 'master', 'develop'),
      environment: fc.dictionary(
        fc.constantFrom('NODE_ENV', 'CI', 'WORKSPACE_DIR', 'LOG_LEVEL'),
        fc.constantFrom('development', 'production', 'true', 'false', '/workspace', 'info', 'debug'),
        { minKeys: 0, maxKeys: 3 }
      ),
      lastUsedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
    })
  );
