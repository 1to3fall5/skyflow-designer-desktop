/**
 * Strip the browser affordances that betray a WebView.
 *
 * The UI runs in WebView2, so out of the box it still behaves like a page:
 * right-click opens a "刷新 / 另存为 / 检查" menu, F5 reloads, Ctrl+wheel zooms
 * the whole interface, and text/images can be selected and dragged around.
 * None of that exists in a real desktop app.
 *
 * There is one tell this file cannot remove: the pointer-lock bubble Chromium
 * prints over the page ("tauri.localhost — 要显示光标，请按 Esc"). It is browser
 * chrome drawn outside the DOM, so it cannot be styled or hidden — the only fix
 * is to never call `requestPointerLock`. The F-drag brush adjust therefore
 * tracks raw pointer deltas instead of locking the cursor.
 */

/** Keys the app never uses but the browser acts on. */
const BLOCKED_KEYS = new Set(['F5', 'F7']);

/** Ctrl/Cmd combinations the app never uses. `r` reload, `p` print, `u` source. */
const BLOCKED_CTRL = new Set(['r', 'p', 'u']);

/** Ctrl/Cmd combos the app *does* use and must keep working. */
const APP_CTRL = new Set(['z', 'y', 'f', 's', 'o', 'n', 'a', 'e']);

export interface DesktopShellHandles {
  dispose: () => void;
}

export function installDesktopShell(
  win: Window = window,
  doc: Document = document,
): DesktopShellHandles {
  // -- right-click menu ----------------------------------------------------
  // Also mandatory for the 3D view, where right-drag is the look control:
  // without this, releasing the right button pops WebView2's context menu.
  const onContextMenu = (e: Event) => e.preventDefault();

  // -- zoom ----------------------------------------------------------------
  // tauri.conf.json sets zoomHotkeysEnabled=false, but a trackpad pinch still
  // arrives as a ctrl+wheel page-zoom gesture.
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };

  // -- reload / print / view-source ---------------------------------------
  const onKeyDown = (e: KeyboardEvent) => {
    if (BLOCKED_KEYS.has(e.key)) {
      e.preventDefault();
      return;
    }
    const k = e.key.toLowerCase();
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    // Ctrl +/-/0 is the browser zoom trio; the app does not bind them.
    if (k === '+' || k === '-' || k === '=' || k === '0') {
      e.preventDefault();
      return;
    }
    if (BLOCKED_CTRL.has(k) && !APP_CTRL.has(k)) e.preventDefault();
  };

  // -- drag & drop of page content ----------------------------------------
  // File drops are handled by Tauri's own drag-drop event, so the DOM-level
  // default (navigate to the dropped file) must never fire.
  const onDragStart = (e: DragEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    // Walk up to the draggable ancestor.
    //
    // `e.target` is almost never the draggable element itself — you grab a
    // layer row by its name or its badge, and those children report
    // `draggable === false`. Cancelling the default there aborts the drag
    // before it starts, which is why reordering the layer list looked like it
    // was never wired up: only a grab on the row's own padding worked.
    if (t.closest('[draggable="true"]')) return;
    if (t.tagName === 'BUTTON') return;
    e.preventDefault();
  };
  const onDrop = (e: DragEvent) => e.preventDefault();
  const onDragOver = (e: DragEvent) => e.preventDefault();

  doc.addEventListener('contextmenu', onContextMenu);
  win.addEventListener('wheel', onWheel, { passive: false });
  win.addEventListener('keydown', onKeyDown);
  doc.addEventListener('dragstart', onDragStart);
  doc.addEventListener('drop', onDrop);
  doc.addEventListener('dragover', onDragOver);

  doc.documentElement.classList.add('desktop-shell');

  return {
    dispose() {
      doc.removeEventListener('contextmenu', onContextMenu);
      win.removeEventListener('wheel', onWheel);
      win.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('dragstart', onDragStart);
      doc.removeEventListener('drop', onDrop);
      doc.removeEventListener('dragover', onDragOver);
      doc.documentElement.classList.remove('desktop-shell');
    },
  };
}
