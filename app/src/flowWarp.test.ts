// @vitest-environment jsdom
/**
 * The one thing worth testing at runtime: losing WebGL must cost the animation
 * and nothing else. jsdom has no context at all, which is the same situation as
 * a machine with a blacklisted driver — the caller keeps the still image.
 */
import { describe, it, expect } from 'vitest';
import { createFlowWarp } from './flowWarp';

describe('createFlowWarp', () => {
  it('returns null instead of throwing where there is no WebGL', () => {
    // jsdom's own getContext prints a stack trace per call; a stub that just
    // answers "no" is the same situation and keeps the output readable.
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as
      HTMLCanvasElement['getContext'];
    const canvas = document.createElement('canvas');
    expect(() => createFlowWarp(canvas)).not.toThrow();
    expect(createFlowWarp(canvas)).toBeNull();
  });
});
