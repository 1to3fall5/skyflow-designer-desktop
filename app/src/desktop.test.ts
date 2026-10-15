// @vitest-environment jsdom
/**
 * The WebView2 tells that make a Tauri window look like a web page. Each of
 * these is invisible until it fires, so they need explicit coverage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDesktopShell, type DesktopShellHandles } from './desktop';

let shell: DesktopShellHandles;

/** Dispatch on body (bubbles up to the document) and report if it was blocked. */
function fire(type: string): boolean {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  document.body.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** Dispatch on a specific element and report if the default was blocked. */
function fireOn(el: Element, type = 'dragstart'): boolean {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

beforeEach(() => { shell = installDesktopShell(); });
afterEach(() => { shell.dispose(); });

describe('desktop shell — no browser chrome', () => {
  it('marks the document so the stylesheet can drop selection behaviour', () => {
    expect(document.documentElement.classList.contains('desktop-shell')).toBe(true);
  });

  it('suppresses the right-click menu', () => {
    // Right-drag is the 3D look control, so releasing it must not pop
    // WebView2's "刷新 / 另存为" menu.
    expect(fire('contextmenu')).toBe(true);
  });

  it('suppresses F5 and F7', () => {
    for (const key of ['F5', 'F7']) {
      const ev = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented, `${key} must be swallowed`).toBe(true);
    }
  });

  it('suppresses Ctrl+R / Ctrl+P / Ctrl+U', () => {
    for (const key of ['r', 'p', 'u']) {
      const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true, bubbles: true });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented, `Ctrl+${key} must be swallowed`).toBe(true);
    }
  });

  it('leaves the app own Ctrl shortcuts alone', () => {
    // Ctrl+S / O / N / Z / Y / E / F belong to the app; swallowing them here
    // would break real features.
    for (const key of ['s', 'o', 'n', 'z', 'y', 'e', 'f']) {
      const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true, bubbles: true });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented, `Ctrl+${key} must reach the app`).toBe(false);
    }
  });

  it('suppresses ctrl+wheel page zoom (trackpad pinch)', () => {
    const ev = new WheelEvent('wheel', { ctrlKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('leaves a plain wheel alone so panes still scroll', () => {
    const ev = new WheelEvent('wheel', { cancelable: true, bubbles: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('suppresses DOM-level drop so the WebView never navigates to a file', () => {
    // Tauri's own drag-drop event is what actually opens the file.
    for (const type of ['drop', 'dragover']) {
      const ev = new Event(type, { cancelable: true, bubbles: true });
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented, `${type} must be swallowed`).toBe(true);
    }
  });

  it('lets a draggable element be dragged by any of its children', () => {
    // `e.target` is almost never the draggable element itself — you grab a row
    // by its name or its badge, and those children report `draggable === false`.
    // Cancelling the default there aborts the drag before it starts.
    //
    // Nothing in the app drags via HTML5 any more (reordering runs on pointer
    // events, because `dragstart` never arrives in this WebView2), but the
    // whitelist still has to be right: it is what keeps this guard from eating
    // a drag it should let through.
    document.body.innerHTML =
      '<div draggable="true"><span class="badge">流向</span><span class="name">图层 1</span><button class="eye">◉</button></div>';
    const row = document.body.firstElementChild!;
    for (const child of Array.from(row.children)) {
      expect(fireOn(child), `a drag starting on .${child.className} must survive`).toBe(false);
    }
    expect(fireOn(row), 'the row itself must be draggable').toBe(false);
  });

  it('still cancels a drag that starts outside a draggable row', () => {
    // Otherwise every drag in the app turns into a native file/text drop the
    // WebView would navigate to.
    document.body.innerHTML = '<p id="p">text</p><div draggable="true"><span id="in">ok</span></div>';
    expect(fireOn(document.getElementById('p')!)).toBe(true);
    expect(fireOn(document.getElementById('in')!)).toBe(false);
  });

  it('dispose() removes every listener and the class', () => {
    shell.dispose();
    expect(document.documentElement.classList.contains('desktop-shell')).toBe(false);
    const ev = new KeyboardEvent('keydown', { key: 'F5', cancelable: true, bubbles: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
