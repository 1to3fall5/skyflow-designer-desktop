import { describe, it, expect } from 'vitest';
import { resolveShortcut, isTextEntry, shouldPrevent, NON_PAINTING_TOOLS, KeyEventLike } from './shortcuts';

const key = (k: string, extra: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, ...extra });

describe('text entry guard', () => {
  it('treats form controls as text entry', () => {
    expect(isTextEntry('INPUT')).toBe(true);
    expect(isTextEntry('TEXTAREA')).toBe(true);
    expect(isTextEntry('SELECT')).toBe(true);
    expect(isTextEntry('input')).toBe(true); // case-insensitive
  });

  it('does not treat canvas or body as text entry', () => {
    expect(isTextEntry('CANVAS')).toBe(false);
    expect(isTextEntry('BODY')).toBe(false);
    expect(isTextEntry('BUTTON')).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(undefined)).toBe(false);
  });

  it('respects contentEditable', () => {
    expect(isTextEntry('DIV', true)).toBe(true);
  });

  it('emits no action while typing in a slider', () => {
    // Typing in a range input must never switch tools or views.
    expect(resolveShortcut(key('b', { targetTag: 'INPUT' }))).toEqual({ type: 'none' });
    expect(resolveShortcut(key(' ', { targetTag: 'INPUT' }))).toEqual({ type: 'none' });
    expect(resolveShortcut(key('3', { targetTag: 'SELECT' }))).toEqual({ type: 'none' });
  });
});

describe('tool shortcuts', () => {
  it('maps B/E/M', () => {
    expect(resolveShortcut(key('b'))).toEqual({ type: 'tool', tool: 'brush' });
    expect(resolveShortcut(key('e'))).toEqual({ type: 'tool', tool: 'eraser' });
    expect(resolveShortcut(key('m'))).toEqual({ type: 'tool', tool: 'magic_wand' });
  });

  it('is case and shift insensitive for single characters', () => {
    // Shift+B produces key === 'B'
    expect(resolveShortcut(key('B', { shift: true }))).toEqual({ type: 'tool', tool: 'brush' });
    expect(resolveShortcut(key('M', { shift: true }))).toEqual({ type: 'tool', tool: 'magic_wand' });
  });

  it('does not fire tool shortcuts while Ctrl is held', () => {
    expect(resolveShortcut(key('b', { ctrl: true }))).toEqual({ type: 'none' });
  });
});

describe('view shortcuts', () => {
  it('maps 1/2/3', () => {
    expect(resolveShortcut(key('1'))).toEqual({ type: 'view', mode: '2d' });
    expect(resolveShortcut(key('2'))).toEqual({ type: 'view', mode: 'split' });
    expect(resolveShortcut(key('3'))).toEqual({ type: 'view', mode: '3d' });
  });
});

describe('toggles', () => {
  it('maps A / R / O / Space', () => {
    expect(resolveShortcut(key('a'))).toEqual({ type: 'toggle', what: 'arrows' });
    expect(resolveShortcut(key('r'))).toEqual({ type: 'toggle', what: 'reference' });
    expect(resolveShortcut(key('o'))).toEqual({ type: 'toggle', what: 'flowmap' });
    expect(resolveShortcut(key(' '))).toEqual({ type: 'toggle', what: 'anim' });
  });

  it('maps ? and / to the help panel', () => {
    expect(resolveShortcut(key('?'))).toEqual({ type: 'toggle', what: 'help' });
    expect(resolveShortcut(key('/'))).toEqual({ type: 'toggle', what: 'help' });
  });

  it('maps Escape to closing help', () => {
    expect(resolveShortcut(key('Escape'))).toEqual({ type: 'closeHelp' });
  });
});

describe('modifier combos', () => {
  it('maps file operations', () => {
    expect(resolveShortcut(key('n', { ctrl: true }))).toEqual({ type: 'file', op: 'new' });
    expect(resolveShortcut(key('o', { ctrl: true }))).toEqual({ type: 'file', op: 'open' });
    expect(resolveShortcut(key('s', { ctrl: true }))).toEqual({ type: 'file', op: 'save' });
    expect(resolveShortcut(key('s', { ctrl: true, shift: true }))).toEqual({ type: 'file', op: 'saveAs' });
    expect(resolveShortcut(key('e', { ctrl: true }))).toEqual({ type: 'file', op: 'export' });
  });

  it('treats the meta key like ctrl (macOS)', () => {
    expect(resolveShortcut(key('s', { meta: true }))).toEqual({ type: 'file', op: 'save' });
  });

  it('maps undo/redo in both conventions', () => {
    expect(resolveShortcut(key('z', { ctrl: true }))).toEqual({ type: 'undo' });
    expect(resolveShortcut(key('z', { ctrl: true, shift: true }))).toEqual({ type: 'redo' });
    expect(resolveShortcut(key('y', { ctrl: true }))).toEqual({ type: 'redo' });
    expect(resolveShortcut(key('Z', { ctrl: true }))).toEqual({ type: 'undo' });
  });

  it('maps Ctrl+F to brush strength adjust', () => {
    expect(resolveShortcut(key('f', { ctrl: true }))).toEqual({ type: 'brushAdjust', param: 'strength' });
  });

  it('ignores Alt combos so the OS keeps them', () => {
    expect(resolveShortcut(key('b', { alt: true }))).toEqual({ type: 'none' });
    expect(resolveShortcut(key('s', { ctrl: true, alt: true }))).toEqual({ type: 'none' });
  });
});

describe('brush sizing', () => {
  it('maps F to brush size adjust', () => {
    expect(resolveShortcut(key('f'))).toEqual({ type: 'brushAdjust', param: 'size' });
  });

  it('maps Shift+F to brush hardness adjust', () => {
    // Softness is what decides whether consecutive dabs blend, so it needs a
    // keyboard path of its own rather than a slider trip.
    expect(resolveShortcut(key('f', { shift: true })))
      .toEqual({ type: 'brushAdjust', param: 'hardness' });
  });

  it('Shift+F works even though Shift upper-cases the key', () => {
    expect(resolveShortcut(key('F', { shift: true })))
      .toEqual({ type: 'brushAdjust', param: 'hardness' });
  });

  it('maps bracket and minus/equals nudges', () => {
    expect(resolveShortcut(key('['))).toEqual({ type: 'brushSize', delta: -4 });
    expect(resolveShortcut(key(']'))).toEqual({ type: 'brushSize', delta: 4 });
    expect(resolveShortcut(key('-'))).toEqual({ type: 'brushSize', delta: -4 });
    expect(resolveShortcut(key('='))).toEqual({ type: 'brushSize', delta: 4 });
    expect(resolveShortcut(key('+'))).toEqual({ type: 'brushSize', delta: 4 });
  });
});

describe('pen path keys', () => {
  it('maps Enter to committing the path', () => {
    expect(resolveShortcut(key('Enter'))).toEqual({ type: 'pen', op: 'commit' });
  });

  it('maps Backspace to dropping the last anchor', () => {
    expect(resolveShortcut(key('Backspace'))).toEqual({ type: 'pen', op: 'pop' });
  });

  it('maps P to the pen, Photoshop\'s letter', () => {
    expect(resolveShortcut(key('p'))).toEqual({ type: 'tool', tool: 'pen' });
  });

  it('keeps the pen keys out of text fields', () => {
    // Backspace in a field is editing, not path editing.
    expect(resolveShortcut(key('Backspace', { targetTag: 'INPUT' }))).toEqual({ type: 'none' });
    expect(resolveShortcut(key('Enter', { targetTag: 'SELECT' }))).toEqual({ type: 'none' });
  });

  it('prevents Backspace from reaching the WebView', () => {
    // Without this it is the browser's "back".
    expect(shouldPrevent(key('Backspace'))).toBe(true);
  });
});

describe('unhandled keys', () => {
  it('returns none for anything else', () => {
    for (const k of ['q', 'w', 'x', '9', 'F1', 'ArrowUp']) {
      expect(resolveShortcut(key(k))).toEqual({ type: 'none' });
    }
  });
});

describe('Tab collapses every panel', () => {
  it('maps Tab to the panel toggle', () => {
    expect(resolveShortcut(key('Tab'))).toEqual({ type: 'togglePanels' });
  });

  it('is swallowed, or focus walks into the toolbar instead', () => {
    // Worse than not working: focus lands on a button and every later
    // shortcut gets eaten by it.
    expect(shouldPrevent(key('Tab'))).toBe(true);
  });
});

describe('eyedropper and hand tool', () => {
  it('uses Photoshop letters I and H', () => {
    expect(resolveShortcut(key('i'))).toEqual({ type: 'tool', tool: 'eyedropper' });
    expect(resolveShortcut(key('h'))).toEqual({ type: 'tool', tool: 'pan' });
  });

  it('treats them as non-painting, like the magic wand', () => {
    expect(NON_PAINTING_TOOLS.has('eyedropper')).toBe(true);
    expect(NON_PAINTING_TOOLS.has('pan')).toBe(true);
    expect(NON_PAINTING_TOOLS.has('magic_wand')).toBe(true);
    expect(NON_PAINTING_TOOLS.has('brush')).toBe(false);
    expect(NON_PAINTING_TOOLS.has('eraser')).toBe(false);
  });
});

describe('preventDefault policy', () => {
  it('blocks default for modifier combos and scroll/type keys', () => {
    expect(shouldPrevent(key('s', { ctrl: true }))).toBe(true);
    expect(shouldPrevent(key(' '))).toBe(true);
    expect(shouldPrevent(key('?'))).toBe(true);
  });

  it('allows default for plain letters', () => {
    expect(shouldPrevent(key('b'))).toBe(false);
    expect(shouldPrevent(key('3'))).toBe(false);
  });
});
