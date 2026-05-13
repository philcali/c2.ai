import fc from 'fast-check';
import type { PlatformEvent } from '../../src/interfaces/orchestration-config.js';

/** Generate a realistic git push payload */
export const arbitraryGitPushPayload = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
  ).chain(([owner, repo]) =>
    fc.record({
      ref: fc.constantFrom('refs/heads/main', 'refs/heads/develop', 'refs/heads/feature/new'),
      repository: fc.constant({
        full_name: `${owner}/${repo}`,
        clone_url: `https://github.com/${owner}/${repo}.git`,
        ssh_url: `git@github.com:${owner}/${repo}.git`,
      }),
      pusher: fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        email: fc.constant('user@example.com'),
      }),
      commits: fc.array(
        fc.record({
          id: fc.hexaString({ minLength: 40, maxLength: 40 }),
          message: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          url: fc.constant(`https://github.com/${owner}/${repo}/commit/abc123`),
        }),
        { minLength: 1, maxLength: 5 }
      ),
      head_commit: fc.record({
        id: fc.hexaString({ minLength: 40, maxLength: 40 }),
        message: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
      }),
    })
  );

/** Generate a realistic PR comment payload */
export const arbitraryPRCommentPayload = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
  ).chain(([owner, repo]) =>
    fc.record({
      action: fc.constantFrom('created', 'edited'),
      comment: fc.record({
        body: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
        user: fc.record({
          login: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        }),
      }),
      pull_request: fc.record({
        number: fc.integer({ min: 1, max: 9999 }),
        head: fc.record({ ref: fc.constantFrom('feature/auth', 'fix/bug-42', 'develop') }),
        base: fc.record({ ref: fc.constantFrom('main', 'master', 'develop') }),
      }),
      repository: fc.constant({
        full_name: `${owner}/${repo}`,
        clone_url: `https://github.com/${owner}/${repo}.git`,
      }),
    })
  );

/** Generate a realistic workflow run payload */
export const arbitraryWorkflowRunPayload = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
  ).chain(([owner, repo]) =>
    fc.record({
      action: fc.constant('completed'),
      workflow_run: fc.record({
        conclusion: fc.constantFrom('success', 'failure', 'cancelled'),
        head_branch: fc.constantFrom('main', 'develop', 'feature/auth'),
        head_sha: fc.hexaString({ minLength: 40, maxLength: 40 }),
        name: fc.constantFrom('CI', 'Build', 'Test', 'Deploy'),
      }),
      repository: fc.constant({
        full_name: `${owner}/${repo}`,
        clone_url: `https://github.com/${owner}/${repo}.git`,
      }),
    })
  );

/** Generate a valid PlatformEvent with realistic payloads matching the event type */
export const arbitraryPlatformEvent = (): fc.Arbitrary<PlatformEvent> =>
  fc.constantFrom('push', 'pull_request_comment', 'workflow_run').chain(eventType => {
    const payloadArb = eventType === 'push'
      ? arbitraryGitPushPayload()
      : eventType === 'pull_request_comment'
        ? arbitraryPRCommentPayload()
        : arbitraryWorkflowRunPayload();

    return fc.record({
      id: fc.uuid(),
      sourceId: fc.uuid(),
      eventType: fc.constant(eventType),
      payload: payloadArb,
      signature: fc.option(
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        { nil: undefined }
      ),
      receivedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
    });
  });
