import { describe, it, expect } from 'vitest';
import { VERSION } from '../../src/index.js';

describe('Project Setup', () => {
  it('should export a version string', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
