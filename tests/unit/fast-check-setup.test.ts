import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

describe('fast-check Setup', () => {
  it('should run a basic property test', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(a + b).toBe(b + a);
      })
    );
  });
});
