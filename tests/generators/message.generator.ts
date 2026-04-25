import fc from 'fast-check';
import type { ACPMessagePayload } from '../../src/interfaces/communication-bus.js';

const VALID_MIME_TYPES = [
  'application/json',
  'text/plain',
  'text/html',
  'text/markdown',
  'application/xml',
  'application/octet-stream',
] as const;

export const arbitraryACPMessagePayload = (): fc.Arbitrary<ACPMessagePayload> =>
  fc.record({
    type: fc.constantFrom('request', 'response', 'notification', 'event', 'task', 'status'),
    contentType: fc.constantFrom(...VALID_MIME_TYPES),
    body: fc.oneof(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    ),
    correlationId: fc.option(fc.uuid(), { nil: undefined }),
    acceptedContentTypes: fc.option(
      fc.array(fc.constantFrom(...VALID_MIME_TYPES), { minLength: 1, maxLength: 4 }),
      { nil: undefined }
    ),
  });

export const arbitraryACPMessagePayloadWithCredentials = (): fc.Arbitrary<ACPMessagePayload> => {
  const credentialBodies = fc.oneof(
    // API key pattern (sk-...)
    fc.string({ minLength: 20, maxLength: 40 }).map(s => `sk-${s.replace(/[^a-zA-Z0-9]/g, 'x')}`),
    // Bearer token
    fc.string({ minLength: 20, maxLength: 60 }).map(s => `Bearer ${s.replace(/[^a-zA-Z0-9]/g, 'a')}`),
    // Password field in object
    fc.string({ minLength: 5, maxLength: 30 }).map(pw => ({ password: pw, username: 'user' })),
    // AWS secret key pattern
    fc.string({ minLength: 40, maxLength: 40 }).map(s => `aws_secret_access_key=${s.replace(/[^a-zA-Z0-9]/g, 'A')}`),
  );

  return fc.record({
    type: fc.constantFrom('request', 'response', 'notification'),
    contentType: fc.constantFrom(...VALID_MIME_TYPES),
    body: credentialBodies,
    correlationId: fc.option(fc.uuid(), { nil: undefined }),
    acceptedContentTypes: fc.option(
      fc.array(fc.constantFrom(...VALID_MIME_TYPES), { minLength: 1, maxLength: 4 }),
      { nil: undefined }
    ),
  });
};
