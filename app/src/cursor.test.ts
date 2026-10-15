import { describe, it, expect } from 'vitest';
import { nextCursor, shouldClearOnLeave } from './cursor';

describe('cursor freeze while scrubbing', () => {
  it('follows the pointer when not adjusting', () => {
    expect(nextCursor(false, { u: 0.4, v: 0.6 }, { u: 0.1, v: 0.1 }))
      .toEqual({ u: 0.4, v: 0.6 });
  });

  it('holds its position while adjusting', () => {
    // The ring must not chase the mouse: you cannot judge a size you are
    // dialling in if the reference circle is also moving.
    const prev = { u: 0.25, v: 0.75 };
    expect(nextCursor(true, { u: 0.9, v: 0.1 }, prev)).toBe(prev);
  });

  it('adopts the current spot on the first move of a scrub', () => {
    // The OS cursor is hidden while scrubbing, so an unplaced ring would leave
    // the user with no pointer at all.
    expect(nextCursor(true, { u: 0.5, v: 0.5 }, null)).toEqual({ u: 0.5, v: 0.5 });
  });

  it('then holds that spot for the rest of the scrub', () => {
    const first = nextCursor(true, { u: 0.5, v: 0.5 }, null);
    expect(nextCursor(true, { u: 0.9, v: 0.9 }, first)).toEqual({ u: 0.5, v: 0.5 });
  });

  it('starts following again as soon as the scrub ends', () => {
    const held = nextCursor(true, { u: 0.9, v: 0.1 }, { u: 0.25, v: 0.75 });
    expect(nextCursor(false, { u: 0.9, v: 0.1 }, held)).toEqual({ u: 0.9, v: 0.1 });
  });
});

describe('pointer leaving a view', () => {
  it('clears the cursor normally', () => {
    expect(shouldClearOnLeave(false)).toBe(true);
  });

  it('keeps the ring when the pointer leaves mid-scrub', () => {
    expect(shouldClearOnLeave(true)).toBe(false);
  });
});
