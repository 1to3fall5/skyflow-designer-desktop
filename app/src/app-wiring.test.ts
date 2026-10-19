/**
 * Guard against the class of bug where a *structural* command (one that changes
 * projection, size, polar angle or the layer list) is consumed by the
 * pixels-only `applySnap`, leaving React state on its initial value.
 *
 * Symptom: switching 球面 / 极坐标 / 平面 visibly changed nothing, because
 * `state.projection` never moved off `equirectangular` and the 3D preview kept
 * rendering the sphere with `uProjectionType = 0`.
 *
 * These are source-level assertions rather than runtime ones because the
 * wiring lives in a React component that is not worth mounting headlessly.
 */
import { describe, it, expect } from 'vitest';
import rawSrc from './App.tsx?raw';
import rawPaintView from './components/PaintView.tsx?raw';
import rawPreview3D from './components/Preview3D.tsx?raw';
import rawPen from './pen?raw';
import rawApi from './api?raw';
import rawShortcuts from './shortcuts?raw';
import rawIcons from './icons?raw';
// Vite's CSS plugin turns `styles.css?raw` into an empty string, so read
// the source straight off disk. Everything else here uses `?raw`.
import { readFileSync } from 'node:fs';
const rawStyles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/**
 * Comments in App.tsx explain *why* the bad pattern is avoided, so they name
 * it. Strip them before asserting, otherwise the explanation trips the guard.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = strip(rawSrc);
const paintView = strip(rawPaintView);
const preview3D = strip(rawPreview3D);

/** Commands whose result must be pushed into React state, not just pixels. */
const STRUCTURAL = [
  'setProjection',
  'setSize',
  'updateLayer',
  'addLayer',
  'removeLayer',
  'reorder',
  'clearLayer',
  'undo',
  'redo',
  'newProject',
  'loadProject',
  // Rewriting a layer's geometry also rewrites its thumbnail, its undo entry
  // and what the overlay is allowed to show; routing it through applySnap
  // would leave React editing a path list the engine had already replaced.
  'setPaths',
  // An effect changes what the engine does to the layer's pixels, so the
  // snapshot comes back with a new composite *and* a new layer record; the
  // fx badge and the effect rows both read that record.
  'setEffects',
];

/** Commands that may bypass state: they only move paint pixels. */
const HOT = ['stroke', 'floodFill'];

describe('App wiring: structural commands refresh React state', () => {
  it.each(STRUCTURAL)('%s is never routed through the pixels-only path', (cmd) => {
    expect(src).not.toMatch(new RegExp(`applySnap\\(\\s*await\\s+api\\.${cmd}\\b`));
    expect(src).not.toMatch(new RegExp(`applySnap\\(\\s*api\\.${cmd}\\b`));
  });

  it('the projection buttons use applyUpdate', () => {
    expect(src).toMatch(/applyUpdate\(await api\.setProjection/);
  });

  it('applyUpdate pushes state before pixels', () => {
    const body = src.slice(src.indexOf('const applyUpdate'), src.indexOf('const applyUpdate') + 400);
    expect(body.indexOf('setState')).toBeLessThan(body.indexOf('applySnap'));
  });

  it('hot-path commands still bypass setState', () => {
    for (const cmd of HOT) {
      expect(src).not.toMatch(new RegExp(`applyUpdate\\([^)]*api\\.${cmd}\\b`));
    }
  });

  it('no manual polar_angle patch is left behind', () => {
    // A local setState hack used to mask the missing state refresh.
    expect(src).not.toMatch(/polar_angle:\s*v\s*\}\s*:/);
  });
});

describe('App wiring: no browser chrome', () => {
  it('never calls requestPointerLock', () => {
    // Chromium draws "tauri.localhost — 要显示光标，请按 Esc" over the canvas for
    // as long as pointer lock is held. It is browser UI outside the DOM, so it
    // cannot be styled or hidden away — the only fix is not to lock at all.
    expect(src).not.toMatch(/requestPointerLock/);
    expect(src).not.toMatch(/exitPointerLock/);
  });

  it('the brush-adjust drag still toggles the scrub class', () => {
    expect(src).toMatch(/classList\.add\('adjusting'\)/);
    expect(src).toMatch(/classList\.remove\('adjusting'\)/);
  });

  it('every brush-parameter source sets the scrub flag', () => {
    // The flag is what freezes the ring; a param added without it would let the
    // ring run away with the mouse mid-scrub.
    expect(src).toMatch(/adjusting\.current = true/);
    expect(src).toMatch(/adjusting\.current = false/);
  });

  it('releases the scrub flag if the window loses focus', () => {
    expect(src).toMatch(/addEventListener\('blur'/);
  });
});

describe('brush cursor: frozen while scrubbing', () => {
  it('never assigns cursorUV directly', () => {
    // Both views must go through nextCursor(), which holds the previous
    // position while a parameter is being scrubbed.
    expect(paintView).not.toMatch(/cursorUV\.current\s*=\s*\{/);
    expect(preview3D).not.toMatch(/cursorUV\.current\s*=\s*\{/);
    expect(paintView).toMatch(/nextCursor\(/);
    expect(preview3D).toMatch(/nextCursor\(/);
  });

  it('never clears the cursor on leave without checking the flag', () => {
    expect(paintView).toMatch(/shouldClearOnLeave\(/);
    expect(preview3D).toMatch(/shouldClearOnLeave\(/);
  });

  it('gates the ring position update on the flag', () => {
    expect(paintView).toMatch(/if \(!frozen\)/);
  });
});

describe('the brush ring must never get stuck as an eyedropper', () => {
  /**
   * `.paint-cursor.picking` forces the ring to a 14px crosshair with
   * `!important`, so it overrides the brush size outright. Which means a class
   * that outlives its Alt key pins the ring at crosshair size indefinitely:
   * 大小, F and `[` `]` all look dead, while the 3D ring — drawn in the shader,
   * with no such class — stays correct. That asymmetry is the symptom.
   *
   * Alt+Tab, or a click on another window, delivers the keydown and eats the
   * keyup. So the class has to be reconciled from more than one place.
   */
  it('drops the class when the window loses focus', () => {
    // The missing keyup is exactly the case blur covers.
    expect(paintView).toMatch(/window\.addEventListener\('blur', blur\)/);
    expect(paintView).toMatch(/const blur = \(\) => showPicking\(false\);/);
  });

  it('reconciles against the pointer, which carries the truth about Alt', () => {
    // Belt and braces: even a keyup lost some other way cannot survive one
    // move of the mouse over the canvas.
    expect(paintView).toMatch(/if \(e\.altKey !== altHeld\.current\) showPicking\(e\.altKey\);/);
  });

  it('heals on any key that arrives without Alt', () => {
    // Scrubbing with F or nudging with `[` `]` is how you notice the ring is
    // stuck, so those very keys have to clear it.
    expect(paintView).toMatch(/if \(!e\.altKey\) showPicking\(false\);/);
  });

  it('has exactly one place that writes the class', () => {
    // Two writers with two different ideas of "am I an eyedropper" is how it
    // got stuck: the behaviour read the pointer, the appearance read the key.
    expect(paintView.match(/classList\.toggle\('picking'/g) ?? []).toHaveLength(1);
    expect(paintView).toMatch(/const showPicking = useCallback\(\(on: boolean\) => \{/);
    expect(paintView).toMatch(/cursorRef\.current\?\.classList\.toggle\('picking', on\);/);
  });
});

describe('brush scrub: releasing F must not reset the views', () => {
  it('ignores key auto-repeat when arming the scrub', () => {
    // Holding F fires keydown every ~30 ms. Re-arming on each repeat zeroed
    // `moved` and refreshed `t` milliseconds before the release, so the "was
    // this a tap?" check could never fail and scrubbing the brush reset the 2D
    // view (and the 3D camera) every time.
    // Capture everything from the case label up to the arming assignment: the
    // guard has to sit before it.
    const arm = src.match(/case 'brushAdjust':([\s\S]*?)brushAdjust\.current\s*=\s*\{/);
    expect(arm, "the brushAdjust case must exist").toBeTruthy();
    expect(arm![1]).toMatch(/if \(brushAdjust\.current\) break;/);
  });

  it('keeps both guards on the tap-to-reset check', () => {
    expect(src).toMatch(/st\.moved\s*<\s*\d+/);
    expect(src).toMatch(/Date\.now\(\) - st\.t\s*<\s*\d+/);
  });
});

describe('App wiring: adjustment layers', () => {
  it('an adjustment layer always paints its mask', () => {
    // `effTarget` must be derived, never a user-switchable state that can
    // disagree with the engine and make the brush do nothing.
    expect(src).toMatch(/effTarget[^=]*=\s*isAdj\s*\?\s*'mask'\s*:\s*'content'/);
    expect(src).not.toMatch(/setEditTarget/);
  });
});

describe('brush flow: each pointer stroke gets its own id', () => {
  /**
   * Strength is a deposit rate, not a magnitude, so the engine has to be able
   * to tell "more of the same drag" from "a second pass over the same spot".
   * That is what `stroke_id` is for: the engine resets its per-stroke deposit
   * record whenever it changes.
   *
   * If the id never changed, every drag after the first would deposit nothing
   * and a low-strength brush could never build up. If it changed *within* a
   * drag, the middle of a stroke would saturate while its ends stayed faint.
   */
  it('bumps the id on pointer-down, not per flushed batch', () => {
    // nextStrokeId() is called where `drawing` is set, i.e. once per press.
    const down = paintView.slice(paintView.indexOf('drawing.current = true;'));
    const head = down.slice(0, 400);
    expect(head).toMatch(/strokeId\.current = nextStrokeId\(\)/);
    // ...and the flush loop only ever *reads* it.
    const flush = paintView.slice(paintView.indexOf('const flush = () => {'));
    expect(flush.slice(0, 900)).not.toMatch(/strokeId\.current\s*=/);
  });

  it('passes the id through to the engine', () => {
    expect(paintView).toMatch(/api\.stroke\([\s\S]*?strokeId\.current/);
    expect(src).toMatch(/api\.stroke\([\s\S]*?stroke3d\.current/);
    // snake_case on the wire, matching StrokeReq in Rust.
    expect(src).not.toMatch(/strokeId:/);
  });

  it('retires the 3D id on paint-end so one drag counts as one stroke', () => {
    const end = src.slice(src.indexOf('onPaintEnd='));
    expect(end.slice(0, 300)).toMatch(/stroke3d\.current = nextStrokeId\(\)/);
  });
});

describe('brush flow: strength is the ceiling, flow is the rate', () => {
  /**
   * These are two different things and both have to reach the engine. Strength
   * is the flow vector length you are aiming at (Photoshop's foreground
   * colour); flow is how much of the remaining distance one stroke covers
   * (Photoshop's flow). Collapsing them is what made a gentle brush creep up
   * to full strength the longer you painted.
   */
  it('exposes a flow slider, defaulting to a full-strength stroke', () => {
    expect(src).toMatch(/useState\(1\.0\)/);
    expect(src).toMatch(/label="流量"/);
    // ...and it is not wired to the same state as strength.
    expect(src).toMatch(/const \[brushFlow, setBrushFlow\]/);
    expect(src).toMatch(/const \[brushStrength, setBrushStrength\]/);
  });

  it('sends flow from both painters', () => {
    expect(paintView).toMatch(/api\.stroke\([\s\S]*?p\.brushFlow\)/);
    expect(src).toMatch(/api\.stroke\([\s\S]*?brushFlow\)/);
  });
});

describe('eyedropper: Alt picks up the flow strength, like Photoshop', () => {
  /**
   * Alt used to be an alias for panning in the 2D view (the original web app
   * did that). It now belongs to the eyedropper, and panning keeps the middle
   * button — which is what the original bound it to as well, so nothing is
   * lost.
   */
  it('no longer pans with Alt', () => {
    const pan = paintView.slice(paintView.indexOf('panning.current = true;') - 300);
    expect(pan).not.toMatch(/e\.button === 1 \|\| e\.altKey/);
    expect(pan).toMatch(/if \(e\.button === 1\)/);
  });

  it('samples on Alt in the 2D view, and on the eyedropper tool itself', () => {
    // Alt is the *temporary* eyedropper; picking the tool makes it stick for
    // the whole drag, hence the sticky flag next to `picking`.
    expect(paintView).toMatch(
      /if \(e\.altKey \|\| p\.tool === 'eyedropper'\) \{\s*picking\.current = true;/);
    expect(paintView).toMatch(/pickSticky\.current = p\.tool === 'eyedropper'/);
    // ...and keeps sampling while dragged, the way Photoshop's eyedropper does.
    expect(paintView).toMatch(/if \(picking\.current\) \{\s*if \(e\.altKey \|\| pickSticky\.current\) sample\(u, v\);/);
  });

  it('samples on Alt in the 3D view too', () => {
    expect(preview3D).toMatch(
      /if \(e\.altKey \|\| p\.tool === 'eyedropper'\) \{\s*pickingRef\.current = true;/);
  });

  it('has no brush ring for the tools that never paint', () => {
    // An eyedropper or hand tool with the OS cursor hidden and a brush ring
    // showing is unusable — you cannot see where you are pointing.
    expect(paintView).toMatch(/NON_PAINTING_TOOLS\.has\(p\.tool\)/);
    expect(preview3D).toMatch(/NON_PAINTING_TOOLS\.has\(props\.tool\)/);
  });

  it('reads from the layer you are on by default', () => {
    expect(src).toMatch(/useState<'layer' \| 'composite'>\('layer'\)/);
    expect(src).toMatch(/sampleSource=\{sampleSource\}/);
  });

  it('offers a Photoshop-style sampling-source control', () => {
    expect(src).toMatch(/<option value="layer">当前图层<\/option>/);
    expect(src).toMatch(/<option value="composite">合成结果<\/option>/);
  });

  it('feeds the picked value into brush strength', () => {
    expect(src).toMatch(/onPickStrength=\{setBrushStrength\}/);
    expect(src).toMatch(/api\.sampleStrength\(u, v, sampleSource\)/);
  });

  it('is still the eyedropper when the pen is the tool', () => {
    // The pen gets first refusal on a press, because Alt on an anchor or a
    // curve means add / remove — but on empty space there is no anchor to
    // spend it on, and swallowing the click there both started a path the user
    // did not ask for and left Alt doing nothing at all.
    //
    // `penDown` therefore reports whether it consumed the press, and only a
    // press it *did* consume ends the handler.
    expect(paintView).toMatch(/const penDown = useCallback\(\(u: number, v: number, alt: boolean\): boolean =>/);
    expect(paintView).toMatch(/if \(p\.tool === 'pen' && penDown\(u, v, e\.altKey\)\) return;/);
    expect(paintView).toMatch(/if \(alt\) return false;/);
    // ...and every other exit from penDown took the press: closing on the
    // first anchor, grabbing a path, and dropping an anchor.
    const fn = paintView.slice(
      paintView.indexOf('const penDown = useCallback'),
      paintView.indexOf('const onPointerDown = '));
    expect(fn.match(/return true;/g) ?? []).toHaveLength(3);
  });

  it('shows the crosshair whenever a pick is actually happening', () => {
    // Two sources for "am I an eyedropper" is how the ring came to disagree
    // with the behaviour: the key said one thing while the pick said another,
    // so Alt looked dead even while it was sampling.
    expect(paintView).toMatch(/picking\.current = true;\s*pickSticky\.current = p\.tool === 'eyedropper';[\s\S]*?showPicking\(true\);/);
    // Releasing the mouse is not releasing Alt, so the crosshair outlives the
    // click while the key is still down.
    expect(paintView).toMatch(/picking\.current = false;\s*[\s\S]*?showPicking\(e\.altKey\);/);
  });
});

describe('view zoom: about the pointer, and from anywhere in the pane', () => {
  /**
   * Scaling about the middle of the image meant the thing you were aiming at
   * slid out from under the cursor — you zoom in, lose your place, zoom out
   * again. And because the gesture was owned by the canvas, it died the moment
   * the pointer left the square, which is exactly when you want to pull back
   * and see the whole flowmap.
   */
  it('does the arithmetic in a pure function, where it can be tested', () => {
    // `zoomAbout` holds a screen point fixed across a change of scale; that is
    // the whole contract, and it is arithmetic rather than DOM.
    expect(paintView).toMatch(/import \{ stageCentre, zoomAbout \} from '\.\.\/view';/);
    expect(paintView).toMatch(/transform\.current = zoomAbout\(t, next, c\.x, c\.y, mx, my\);/);
    expect(paintView).not.toMatch(/t\.scale = s;/);
  });

  it('recovers the untransformed centre from the box it can measure', () => {
    // Not the offsetParent chain: the centre of a box scaled about its centre
    // is exactly `centre + translate`.
    expect(paintView).toMatch(/stageCentre\(el\.getBoundingClientRect\(\), t\)/);
  });

  it('anchors a drag on where it started, not on the live cursor', () => {
    // The point you aimed at when you pressed is the one that has to stay put;
    // following the cursor would slide the whole view sideways while zooming.
    expect(paintView).toMatch(/zoomAt\(zs\.startScale \* \(1 - \(e\.clientY - zs\.y\) \* 0\.005\), zs\.x, zs\.y\)/);
    expect(paintView).toMatch(/zoomStart\.current = \{ x: e\.clientX, y: e\.clientY, startScale:/);
  });

  it('zooms the wheel about the pointer too', () => {
    // A wheel that zooms about the middle of the image alongside a drag that
    // zooms about the cursor is two gestures disagreeing about what "zoom"
    // means.
    expect(paintView).toMatch(/zoomAt\(transform\.current\.scale - e\.deltaY \* 0\.0015, e\.clientX, e\.clientY\)/);
  });

  it('starts a middle drag off the artwork, not only on it', () => {
    // Capture phase on the pane, so the canvas never sees a press that was not
    // on the image — otherwise it would read a UV off it.
    expect(paintView).toMatch(/onPointerDownCapture=\{onViewDown\}/);
    expect(paintView).toMatch(/const onViewDown = \(e: React\.PointerEvent\) => \{/);
    expect(paintView).toMatch(/if \(e\.button !== 1\) return;/);
    expect(paintView).toMatch(/e\.currentTarget as Element\)\.setPointerCapture\?\.\(e\.pointerId\)/);
    expect(paintView).toMatch(/e\.stopPropagation\(\);/);
  });

  it('shares one move handler between the canvas and the pane', () => {
    // Whichever element holds the capture, the drag runs the same code — and
    // the target scale is absolute, so a move seen by both is applied once.
    expect(paintView).toMatch(/onPointerMove=\{\(e\) => moveView\(e\)\}/);
    expect(paintView).toMatch(/if \(moveView\(e\)\) return;/);
  });
});

describe('2D stage: the flowmap square must never be distorted', () => {
  /**
   * The flowmap is a square UV space, so the stage has to stay square whatever
   * shape the pane is - otherwise the image is squashed, the brush ring turns
   * into an ellipse, and pointer->UV maps differently on the two axes.
   *
   * `width: 100%` + `aspect-ratio: 1/1` + `max-height: 100%` looked right but
   * was not: when the pane was wider than tall the height got clamped while the
   * width stayed at 100%. Going full-screen 2D from a split view was enough to
   * trigger it, which is why it only showed up "sometimes".
   */
  const stage = rawStyles.slice(rawStyles.indexOf('.paint-stage'));

  // Plain substring checks: the CSS source is whitespace-formatted, so a regex
  // would only be buying backslash noise.
  it('sizes both axes from the same min()', () => {
    expect(stage).toContain('width: min(100cqw, 100cqh)');
    expect(stage).toContain('height: min(100cqw, 100cqh)');
  });

  it('drops the clamps that used to squash it', () => {
    expect(stage).toContain('max-width: none');
    expect(stage).toContain('max-height: none');
    expect(stage).toContain('aspect-ratio: auto');
  });

  it('declares the pane as a size container, or cq units mean nothing', () => {
    const view = rawStyles.slice(rawStyles.indexOf('.paint-view'));
    expect(view).toContain('container-type: size');
  });

  it('guards the container-query rules behind @supports', () => {
    expect(rawStyles).toContain('@supports (width: 1cqw)');
  });
});

describe('layer order: the stack has to be rearrangeable', () => {
  /**
   * Two independent problems made order feel fixed.
   *
   * 1. Order had no effect on the composite anyway: see the Rust tests for
   *    `a_flow_layer_above_an_obstacle_covers_it`.
   * 2. Dragging did nothing at all. It was built on HTML5 drag-and-drop, and
   *    **`dragstart` never arrives in this WebView2** — the row was wired up
   *    correctly and still never moved. Reordering now runs on pointer events,
   *    which is what the splitter and every brush stroke already use.
   */
  it('drags the row with pointer events, not HTML5 drag-and-drop', () => {
    expect(src).toMatch(/onPointerDown=\{beginRowDrag\(l\.id\)\}/);
    expect(src).toMatch(/const beginRowDrag = \(lid: string\) => \(e: React\.PointerEvent<HTMLElement>\) => \{/);
    // The whole HTML5 path is gone, and with it the dataTransfer plumbing.
    expect(src).not.toMatch(/onDragStart/);
    expect(src).not.toMatch(/dataTransfer/);
  });

  it('reorders on release using the visual row it landed on', () => {
    expect(src).toMatch(/const from = layers\.findIndex\(\(l\) => l\.id === lid\);/);
    expect(src).toMatch(/const to = layers\.findIndex\(\(l\) => l\.id === over\);/);
    expect(src).toMatch(/if \(from >= 0 && to >= 0\) structural\(api\.reorder\(from, to\)\);/);
  });

  it('highlights the row it would land on', () => {
    expect(src).toMatch(/rowDrag && rowDrag\.over === l\.id && rowDrag\.id !== l\.id \? 'drop-target' : ''/);
    expect(rawStyles).toMatch(/\.layer\.drop-target \{ box-shadow: inset 0 0 0 2px var\(--accent\); \}/);
    // ...and dims the one you picked up, the same feedback the dock gives.
    expect(rawStyles).toMatch(/\.layer\.dragging \{ opacity: \.5; \}/);
  });

  it('needs a threshold, or a click could never select a layer', () => {
    expect(src).toMatch(/const DRAG_MIN_PX = 4;/);
    expect(src).toMatch(/if \(Math\.abs\(ev\.clientY - startY\) < DRAG_MIN_PX\) return;/);
  });

  it('offers buttons as well, because a drag handle is undiscoverable', () => {
    expect(src).toMatch(/disabled=\{!canMoveUp\} onClick=\{\(\) => moveActive\(-1\)\}/);
    expect(src).toMatch(/disabled=\{!canMoveDown\} onClick=\{\(\) => moveActive\(1\)\}/);
  });

  it('derives the buttons from the visual (top-first) index', () => {
    // `layers` is the reversed engine list, so row 0 is the top of the stack.
    // Using the raw index would move the wrong layer for every row but one.
    expect(src).toMatch(/\[\.\.\.state\.layers\]\.reverse\(\)/);
    expect(src).toMatch(/const activeRow = layers\.findIndex/);
    expect(src).toMatch(/const canMoveUp = activeRow > 0/);
    expect(src).toMatch(/const canMoveDown = activeRow >= 0 && activeRow < layers\.length - 1/);
  });
});

describe('Photoshop-style shell', () => {
  /**
   * The previous shell was "web admin console": one long sidebar down the left
   * holding six unrelated sections, with the canvas shoved to the right and
   * the brush parameters stranded in a footer bar. Four things matter about
   * PS's layout and none of them are cosmetic:
   *
   *   1. the canvas is the centre, panels orbit it
   *   2. panels fold, so you keep only what you are using
   *   3. the options bar follows the selected tool
   *   4. Tab hides everything at once
   */
  it('puts a vertical toolbox on the left', () => {
    expect(src).toMatch(/<nav className="toolbox">/);
    expect(src).toMatch(/TOOLS\.map\(\(t\) =>/);
    expect(src).toMatch(/<ToolIcon name=\{t\.icon\} \/>/);
    expect(src).toMatch(/className="tool-key"/);
  });

  it('lists every tool the shortcut resolver knows about', () => {
    // A tool in the box with no key (or the reverse) is a silent dead end.
    for (const t of ['brush', 'pen', 'eraser', 'magic_wand', 'eyedropper', 'pan']) {
      expect(src).toContain(`tool: '${t}'`);
    }
    // The union lives in shortcuts.ts, so check it there — otherwise the box
    // and the resolver can drift apart and one tool silently does nothing.
    expect(rawShortcuts).toMatch(
      /export type Tool = 'brush' \| 'pen' \| 'eraser' \| 'magic_wand' \| 'eyedropper' \| 'pan';/);
    // ...and the icon has to exist, or the button is blank.
    expect(rawIcons).toMatch(/['"]?pen['"]?: \[/);
  });

  it('has an options bar that follows the selected tool', () => {
    expect(src).toMatch(/<div className="optionsbar">/);
    // Brush sliders live here now, not in the footer.
    expect(src).toMatch(/\(tool === 'brush' \|\| tool === 'eraser'\)/);
    // ...and the wand gets its own parameter instead of being appended.
    expect(src).toMatch(/tool === 'magic_wand' && \(\s*<Slider label="容差"/);
  });

  it('makes the right-hand panels collapsible', () => {
    expect(src).toMatch(/<aside className="panels" ref={dockRef}>/);
    // Keyed off the dock id now: the column renders from `panelOrder`, so no
    // panel can have a hardcoded `collapsed.layers`.
    expect(src).toMatch(/collapsed=\{!!collapsed\[pid\]\}/);
    expect(src).toMatch(/onToggle=\{\(\) => \{[\s\S]*?togglePanel\(pid\);[\s\S]*?\}\}/);
    // The header has to be a real button or it is unreachable by keyboard.
    expect(src).toMatch(/<button className="panel-head" onClick=\{onToggle\}[\s\S]*?aria-expanded=\{!collapsed\}/);
    expect(src).toMatch(/\{!collapsed && <div className="panel-body">/);
  });

  it('replaces the footer brush bar with a read-only status bar', () => {
    expect(src).toMatch(/<footer className="statusbar">/);
    expect(src).not.toMatch(/<footer className="brushbar">/);
    // Read-only on purpose: a control here would steal focus from the canvas.
    expect(src).toMatch(/<span className="st-item">\{state\.size\}²<\/span>/);
    expect(src).toMatch(/缩放 \{Math\.round\(zoom2d \* 100\)\}%/);
  });

  it('lets the 2D / 3D divider be dragged', () => {
    expect(src).toMatch(/className="splitter"/);
    expect(src).toMatch(/onPointerDown=\{startSplit\}/);
    expect(src).toMatch(/setSplitRatio\(clamp\(\(e\.clientX - r\.left\) \/ r\.width, 0\.15, 0\.85\)\)/);
    // Clamped: an accidental 0 would collapse a pane to nothing with no way
    // to grab the handle back.
    expect(src).toMatch(/paneFlex = \(which: '2d' \| '3d'\)/);
  });

  it('hides the whole shell on Tab', () => {
    expect(src).toMatch(/case 'togglePanels': setShellHidden\(\(v\) => !v\); break;/);
    // Toolbox, panels and options bar all go; the canvas keeps everything.
    expect(src).toMatch(/\{!shellHidden && \(\s*<nav className="toolbox">/);
    expect(src).toMatch(/\{!shellHidden && \(\s*<aside className="panels" ref={dockRef}>/);
    expect(src).toMatch(/\{!shellHidden && \(\s*<div className="optionsbar">/);
  });
});

describe('the pen: a path whose tangent is the flow direction', () => {
  /**
   * A brush's direction is whatever your hand did, which is right for dabbing
   * and wrong for the thing a flowmap needs most — a long, even sweep across
   * a sky. The pen makes that exact by construction: anchors, a curve through
   * them, and the curve's own tangent as the flow vector.
   *
   * It costs no new engine plumbing, because a polyline is already the
   * engine's unit of work and it derives direction from each segment's travel.
   */

  it('places anchors instead of dragging ink', () => {
    // The pen must not fall through to the brush branch: a click would stamp a
    // dab and there would be no path to edit. It *hand back* the press only
    // when Alt wanted the eyedropper, hence the return value.
    expect(rawPaintView).toMatch(/if \(p\.tool === 'pen' && penDown\(u, v, e\.altKey\)\) return;/);
    expect(rawPaintView).toMatch(/const a = \[\.\.\.cur\.a, \{ x: u, y: v, hx: 0, hy: 0 \}\];/);
    expect(rawPaintView).toMatch(/penDrag\.current = a\.length - 1;/);
    // ...and `drawing` — the flag that feeds the brush's flush loop — stays down.
    expect(rawPaintView).not.toMatch(/drawing\.current = true;\s*\n\s*if \(p\.tool === 'pen'\)/);
  });

  it('lets a drag off a fresh anchor pull out its handle', () => {
    // The signature pen gesture. Without it every anchor is a corner and the
    // tool is a polyline drawer.
    expect(rawPaintView).toMatch(/a\[i\] = \{ \.\.\.p0, hx: u - p0\.x, hy: v - p0\.y \};/);
    // A click with no drag leaves the handle at zero, which pen.ts reads as
    // "derive it from the neighbours" — so a plain click still curves.
    expect(rawPen).toMatch(/if \(p\.hx !== 0 \|\| p\.hy !== 0\) return \{ hx: p\.hx, hy: p\.hy \};/);
  });

  it('closes a loop by clicking the first anchor', () => {
    expect(rawPaintView).toMatch(/uvDistPx\(u, v, cur\.a\[0\]\.x, cur\.a\[0\]\.y, sizePx\) <= CLOSE_PX/);
    // In screen pixels, not canvas ones: it is a click, so it has to feel the
    // same whether the view is zoomed in or out.
    expect(rawPen).toMatch(/export const CLOSE_PX = 10;/);
  });

  it('commits geometry, not pixels', () => {
    // The whole non-destructive contract: Enter adds a PathData to the layer
    // and the engine renders it. Stamping a polyline would leave pixels that
    // no longer know where their anchors were.
    // The draft used to be flattened into a stamping polyline here; now the
    // anchors go out whole and the engine does the rasterising.
    expect(paintView).not.toMatch(/flattenPath\(a, closed, p\.size\)/);
    expect(rawPaintView).toMatch(/const next = \[\.\.\.p\.paths, \{/);
    expect(rawPaintView).toMatch(/anchors: a,/);
    expect(rawPaintView).toMatch(/pushPaths\(next, true\);/);
    // And one history entry per path, not per sample.
    expect(src).toMatch(/if \(done\) \{\s*\n\s*api\.saveHistory\(\);/);
  });

  it('travels with the brush it was drawn with', () => {
    // Otherwise "make this one stroke wider" means redrawing it by hand: the
    // brush is part of the object, not an accident of what the slider was at.
    expect(rawPaintView).toMatch(/size: p\.brushSize,/);
    expect(rawPaintView).toMatch(/hardness: p\.brushHardness,/);
    expect(rawPaintView).toMatch(/strength: p\.brushStrength,/);
  });

  it('abandons the path when you leave the tool', () => {
    // Otherwise an invisible path sits there for the next Enter to stamp
    // somewhere you have forgotten about.
    expect(rawPaintView).toMatch(/\}, \[props\.tool, drawPen, publishPen\]\);/);
    expect(rawPaintView).toMatch(/setPen\(NO_PATH\);/);
  });

  it('lets Esc drop the path before it closes the help panel', () => {
    // The pen methods answer whether they had anything to act on, so the key
    // is never swallowed twice.
    expect(src).toMatch(/case 'closeHelp':\s*\n\s*if \(!paintRef\.current\?\.penCancel\(\)\) setShowShortcuts\(false\);/);
    expect(src).toMatch(/if \(action\.op === 'commit'\) paintRef\.current\?\.penCommit\(\);/);
    expect(src).toMatch(/else paintRef\.current\?\.penPop\(\);/);
    expect(rawPaintView).toMatch(/penCommit: commitPen,/);
  });

  it('keeps the pen off the 3D view rather than letting it act as a brush', () => {
    // `onPaint` is a catch-all: anything that is not the wand, the dropper or
    // the hand gets treated as a drag. A pen has no overlay in the 3D view —
    // it would paint blind, which is worse than not painting at all.
    expect(src).toMatch(/paintEnabled=\{canPaint && viewMode !== '2d' && tool !== 'pen'\}/);
  });

  it('counts the anchors in the options bar', () => {
    // A path in progress with no read-out leaves you unsure whether the click
    // registered at all.
    expect(src).toMatch(/onPenInfo=\{setPenInfo\}/);
    expect(src).toMatch(/\$\{penInfo\.anchors\} 个锚点/);
    expect(rawPaintView).toMatch(/anchors: penRef\.current\.a\.length,/);
  });

  it('draws the path on its own overlay, in the same space as the pixels', () => {
    // Not SVG over the stage: a canvas at the flowmap's resolution pans and
    // zooms with the artwork for free, the way the arrow overlay already does.
    expect(rawPaintView).toMatch(/<canvas ref=\{penCanvasRef\} width=\{props\.size\} height=\{props\.size\} className="paint-pen" \/>/);
    expect(rawStyles).toMatch(/\.paint-pen \{ position: absolute; inset: 0;/);
  });
});

/**
 * The pen is a Substance-Painter tool, not a Photoshop one: a stroke has to
 * stay editable after it lands.
 *
 * That is the difference between "a path" and "a stroke that happened to be
 * straight". These assert the pieces that make it true — the anchors outlive
 * the commit, the engine owns them, and every edit goes back as geometry.
 */
describe('the pen: a path stays editable after it lands', () => {
  it('grabs what is on the layer before starting a new path', () => {
    // Order is the whole interaction. A click that always began a new path
    // would bury the old one under drafts and make it unselectable.
    expect(paintView).toMatch(/if \(cur\.a\.length === 0\) \{\s*\n\s*const hit = hitPath\(p\.paths, u, v, sizePx\);/);
    // Only when nothing is hit does a click drop a fresh anchor.
    expect(paintView).toMatch(/sel\.current = -1;\s*\}\s*\n\s*const a = \[\.\.\.cur\.a,/);
  });

  it('drags against the pre-drag copy, not the last frame', () => {
    // Incremental deltas accumulate rounding and, worse, drift if a frame is
    // dropped. Absolute means the path is exactly where you put it.
    expect(paintView).toMatch(/orig: base,/);
    expect(paintView).toMatch(/translatePath\(e\.orig, u - e\.u0, v - e\.v0\)/);
    expect(paintView).toMatch(/x: a\.x \+ \(u - e\.u0\), y: a\.y \+ \(v - e\.v0\)/);
  });

  it('sends one round trip per frame while dragging', () => {
    // Dragging an anchor is the same budget as dragging a brush. Two in flight
    // would let a slow reply land after a fast one and put the old anchor back.
    expect(paintView).toMatch(/editBusy\.current = true;/);
    expect(paintView).toMatch(/onPathsChange\?\.\(next, false\)/);
  });

  it('only takes a history entry when the gesture ends', () => {
    // A click that never moved only selected the path; recording it would put
    // a no-op into the undo stack for every time you touched the artwork.
    expect(paintView).toMatch(/if \(e\.moved\) pushPaths\(e\.paths, true\);/);
  });

  it('Alt adds an anchor to the curve and removes one from it', () => {
    // "Keep editing this" without deleting it and starting over, which throws
    // away the shape you were trying to refine.
    expect(paintView).toMatch(/insertAnchor\(base, hit\.seg, hit\.x, hit\.y\)/);
    expect(paintView).toMatch(/removeAnchor\(base, hit\.ai\)/);
  });

  it('Backspace deletes the selected path when nothing is down', () => {
    // The key always removes the most recent thing you did, and the draft is
    // more recent than the selection.
    expect(paintView).toMatch(/p\.paths\.filter\(\(_, i\) => i !== sel\.current\)/);
  });

  it('retunes the selected path from the options bar', () => {
    // The decisive test of non-destructive: the stroke keeps its own brush, so
    // you can widen path 3 without redrawing it or disturbing path 4.
    expect(src).toMatch(/paintRef\.current\?\.setPathBrush\(\{ \[key\]: v \}/);
    expect(paintView).toMatch(/withBrush\(p\.paths\[i\], patch\)/);
    // Sliders read the selected path's values, not the global brush's.
    expect(src).toMatch(/penInfo\.brush\?\.size \?\? brushSize/);
  });

  it('brings its own layer, because a path cannot live on a paint layer', () => {
    // Pixels are the one thing a path must not be reduced to. Rather than
    // refuse to draw, the pen reuses the topmost path layer or makes one.
    expect(src).toMatch(/if \(tool !== 'pen'\) return;/);
    expect(src).toMatch(/void structural\(api\.addLayer\('path'\)\);/);
  });

  it('hands the geometry to the engine and takes the state back', () => {
    expect(rawApi).toMatch(/invoke<Snapshot>\('set_paths'/);
    expect(src).toMatch(/applyUpdate\(await api\.setPaths\(id, paths\)\);/);
  });

  it('carries the paths on the layer itself', () => {
    // The overlay hit-tests against them, so they have to arrive with the rest
    // of the layer rather than in a side channel that can go stale.
    expect(rawApi).toMatch(/paths: PathData\[\];/);
    expect(src).toMatch(/paths=\{activePaths\}/);
  });

  it('drops the selection when the layer changes', () => {
    // Index 3 of the old layer is a different path on the new one, and keeping
    // it would move geometry you cannot see.
    expect(paintView).toMatch(/\}, \[props\.layerId, drawPen, publishPen\]\);/);
  });
});

describe('panels hold state, the menu holds actions', () => {
  /**
   * The panel column had six sections, and three of them were not document
   * state: 图片源 duplicated the 导入天空图 button, 导出 duplicated 导出贴图, and
   * 最近打开 is File > Open Recent in any program that has a File menu. PS keeps
   * panels for what you keep touching (图层, 属性, 视图) and puts one-time
   * operations in the menu bar.
   */
  it('groups one-time setup into a folded 文档 panel', () => {
    // 投影 and 图片源 are both "what kind of document is this": set once.
    // They are panel *sections* rather than sub-headings now — PS divides a
    // panel with full-bleed rules, not with small caps.
    expect(src).toMatch(/const panelTitle: Record<PanelId, string> = \{[\s\S]*?document: '文档',/);
    expect(src).toMatch(/<Section title="投影">/);
    expect(src).toMatch(/<Section title="天空贴图">/);
    // ...and it starts folded, so 图层 is not a scroll away.
    expect(src).toMatch(/START_COLLAPSED: Record<string, boolean> = \{ document: true, export: true \}/);
    expect(src).toMatch(/useState<Record<string, boolean>>\(START_COLLAPSED\)/);
  });

  it('no longer carries a 最近打开 panel', () => {
    // It is 文件 > 打开最近 now. A list of paths is not document state.
    expect(src).not.toMatch(/id="recent"/);
    expect(src).not.toMatch(/PANEL_IDS = \[[^\]]*'recent'/);
  });

  it('moves the view toggles off the canvas and into a 视图 panel', () => {
    expect(src).toMatch(/const panelTitle: Record<PanelId, string> = \{[\s\S]*?view: '视图',/);
    // All four, as switches — no floating bar to make icons legible. Now on the
    // rows they govern rather than in their own grid, hence `on=` not `checked=`.
    for (const what of ['showReference', 'showFlowMap', 'showArrows', 'animating']) {
      expect(src, `${what} should have a switch`).toMatch(
        new RegExp(`on=\\{${what}\\}`));
    }
  });

  it('keeps nothing floating over the canvas', () => {
    // The bar across the middle of a skybox hid the thing you were painting.
    expect(src).not.toMatch(/className="float-bar"/);
    expect(rawStyles).not.toMatch(/^\.float-bar \{/m);
    expect(src).not.toMatch(/icon-btn/);
  });

  it('drops the duplicate HTML title bar', () => {
    // The window has a native one and it carries the menu; a second row of
    // file buttons was two bars of chrome and a shorter canvas.
    expect(src).not.toMatch(/<header className="titlebar">/);
    expect(rawStyles).not.toMatch(/^\.titlebar \{/m);
    // ...but what it held moved rather than vanished: the document name went
    // to the app bar and the screen-mode switch to the options bar.
    expect(src).toMatch(/docName=\{/);
    expect(src).toMatch(/<div className="optionsbar">[\s\S]*menu-group segmented/);
  });
});

describe('panel contents, laid out the way Photoshop lays them out', () => {
  /**
   * The panels used to be flat lists of `label | bare range | coloured number`
   * on rounded cards. That is a settings page. Photoshop's panels are a
   * different grammar, and three parts of it are what make the column readable
   * at a glance:
   *
   *   1. sections — a chevron header over a rule that spans the full width
   *   2. fields   — the value sits in its own inset box, not as tinted text
   *   3. glyphs   — a panel's own toolbar is icon buttons, so the width goes
   *                 to the content (here: layer thumbnails)
   */

  it('divides a panel into sections with a full-bleed rule', () => {
    expect(src).toMatch(/function Section\(\{ title, children \}/);
    expect(src).toMatch(/<section className="sect">/);
    expect(src).toMatch(/<button className="sect-head" aria-expanded=\{open\}/);
    // Full-bleed: the rule spans the panel while the header text stays inset.
    // Equal to `.panel-body`'s side padding, which is the whole mechanism.
    expect(rawStyles).toMatch(/\.sect \{ margin: 0 -9px; \}/);
    expect(rawStyles).toMatch(/\.sect \+ \.sect \{ border-top: 1px solid var\(--separator\); \}/);
    expect(rawStyles).toMatch(/\.sect:first-child \{ margin-top: -9px; \}/);
  });

  it('makes a section header fold, like PS does', () => {
    // A chevron that does not fold is a lie about affordance.
    expect(src).toMatch(/const \[open, setOpen\] = useState\(true\);/);
    expect(src).toMatch(/onClick=\{\(\) => setOpen\(\(v\) => !v\)\}/);
    expect(src).toMatch(/\{open && <div className="sect-body">\{children\}<\/div>\}/);
  });

  it('draws the disclosure chevron as an icon, not as text', () => {
    // ▸ / ▾ are not in every UI font; at 9px on Windows ▾ came out as a speck
    // that read as a bullet rather than as a control.
    expect(src).toMatch(/<ToolIcon name=\{collapsed \? 'right' : 'down'\} size=\{12\} \/>/);
    expect(src).toMatch(/<ToolIcon name=\{open \? 'down' : 'right'\} size=\{12\} \/>/);
    expect(rawStyles).not.toMatch(/\.chev \{ font-size/);
  });

  it('leaves 属性 holding only what the layer is', () => {
    // 不透明度 moved to the 图层 panel (it is a question about the stack) and
    // 模糊 became an effect. What is left is one section: the kind-specific
    // generator. Two of the three sections are gone on purpose.
    expect(src).toMatch(/<Section title=\{PARAM_SECT\[activeLayer\.kind\]\}>/);
    expect(src).not.toMatch(/<Section title="边缘">/);
    expect(src).not.toMatch(/<Section title="混合">/);
    // A paint layer has no parameters of its own; an empty panel reads as
    // broken, so it explains where its parameters actually live.
    expect(src).toMatch(/<p className="note">/);
    expect(rawStyles).toMatch(/\.note \{ margin: 0; font-size: 11px;/);
  });

  it('does not offer 不透明度 in 属性 at all', () => {
    // It is legal for it to appear twice only if both are the same control;
    // they are not — one would go stale. Count the label instead of trusting
    // that a match was found in the right panel.
    const i = src.indexOf('props: activeLayer ?');
    const propsPanel = src.slice(i, src.indexOf('\n    layers:', i));
    expect(i).toBeGreaterThan(0);
    expect(propsPanel).not.toMatch(/不透明度/);
  });

  it('puts a value in an inset field, not in tinted text', () => {
    // The box is what carries "this is a value you own". Coloured text on the
    // panel surface reads as a caption, which is how it read before.
    expect(rawStyles).toMatch(/\.row-value \{[\s\S]*?background: var\(--field\);/);
    expect(rawStyles).toMatch(/\.row-value \{[\s\S]*?border: 1px solid var\(--field-border\);/);
    expect(rawStyles).toMatch(/\.row-value \{[\s\S]*?font-variant-numeric: tabular-nums;/);
  });

  it('writes the row label in sentence case', () => {
    // Uppercase + letter-spacing on every label made the panel shout and made
    // the values recede — exactly backwards.
    const label = rawStyles.match(/\.row-label \{[^}]*\}/)![0];
    expect(label).not.toContain('text-transform');
    expect(label).not.toContain('letter-spacing');
  });

  it('fills the slider track from the left, PS style', () => {
    // A range input's track *is* its background, so one custom property is all
    // it takes. A wrapper element would clip the thumb.
    expect(src).toMatch(/function Range\(\{ value, min, max, step = 0\.01, onChange, title, disabled \}/);
    expect(src).toMatch(/const pct = max > min \? \(\(value - min\) \/ \(max - min\)\) \* 100 : 0;/);
    expect(src).toMatch(/style=\{\{ '--p': `\$\{pct\}%` \} as React\.CSSProperties\}/);
    expect(rawStyles).toMatch(/linear-gradient\(to right, var\(--accent\) 0 var\(--p, 0%\)/);
    // `input[type=range].rng`, not `.rng`: the base range rule is an element
    // plus an attribute selector and outranks a lone class, so a bare `.rng`
    // silently keeps the options-bar styling and draws no fill at all.
    expect(rawStyles).toMatch(/^input\[type=range\]\.rng \{/m);
    expect(rawStyles).not.toMatch(/^\.rng \{/m);
    // Every panel row goes through it; a bare <input type=range> inside a
    // panel would come out unfilled and give the panel two slider styles.
    expect(src).not.toMatch(/<Row[^>]*>\s*<input type="range"/);
  });

  it('builds the 图层 toolbar out of glyph buttons', () => {
    expect(src).toMatch(/function IconBtn\(\{ icon, title, onClick, disabled, danger \}/);
    // A glyph with no label is a guess, so every call site passes a title.
    expect(src).toMatch(/className=\{`pbtn \$\{danger \? 'danger' : ''\}`\}/);
    expect(src).toMatch(/aria-label=\{title\}/);
    for (const icon of ['brush', 'wind', 'box', 'up', 'down', 'trash']) {
      expect(src, `the layer toolbar is missing ${icon}`).toContain(`icon="${icon}"`);
    }
    // The icons have to actually exist in the set, or the button is blank.
    for (const name of ['wind', 'box', 'trash', 'up', 'down', 'eye', 'sq']) {
      expect(rawIcons, `icons.tsx is missing ${name}`).toMatch(
        new RegExp(`['"]?${name}['"]?: \\[`));
    }
    expect(src).not.toMatch(/layer-tools/);
  });

  it('shows one thumbnail per layer', () => {
    // The single most PS-looking thing in the layer panel, and the reason the
    // text badge that used to sit there was redundant: the names already say
    // 流向 / 风向 / 障碍物.
    expect(src).toMatch(/const \[thumbs, setThumbs\] = useState<Record<string, string>>\(\{\}\);/);
    expect(src).toMatch(/const refreshThumbs = useCallback\(async \(\) => \{/);
    expect(src).toMatch(/className="layer-thumb"/);
    expect(src).not.toMatch(/className="badge"/);
    // Checkerboard behind it, PS's language for "no pixels here yet".
    expect(rawStyles).toMatch(/\.layer-thumb \{[\s\S]*?background-size: 12px 12px;/);
    // The column only lines up if the eye has a fixed width too.
    expect(rawStyles).toMatch(/\.eye \{[\s\S]*?flex: 0 0 18px;/);
    expect(rawStyles).toMatch(/\.layer-thumb \{[\s\S]*?flex: 0 0 26px;/);
  });

  it('marks visibility with an eye and a hollow square, the way PS does', () => {
    // A struck-through eye is one shape you have to decode per row. Eyes
    // against boxes is a column you can scan straight down, and the shown
    // state gets the brighter colour so the answer is "which are on", not
    // "what does this glyph mean".
    expect(src).toMatch(/<ToolIcon name=\{l\.visible \? 'eye' : 'sq'\} size=\{15\} \/>/);
    expect(src).toMatch(/className=\{`eye \$\{l\.visible \? 'shown' : ''\}`\}/);
    expect(rawIcons, 'there must be no struck-through eye left').not.toContain('eye-off');
    // Brightness step, so the two states differ in more than outline.
    expect(rawStyles).toMatch(/\.eye \{[\s\S]*?color: var\(--txt-faint\);/);
    expect(rawStyles).toMatch(/\.eye\.shown \{ color: #ececec; \}/);
    // ...and the glyph has to inherit that, or `.tool-glyph`'s own colour wins.
    expect(rawStyles).toMatch(/\.eye \.tool-glyph \{ color: inherit;/);
  });

  it('refreshes thumbnails on pixel changes only', () => {
    // Photoshop's thumbnails show content, so dragging 不透明度 leaves them
    // alone. A round trip per slider frame would buy nothing.
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    expect(api).toMatch(/layerThumbs: \(size = 32\) =>/);
    expect(api).toMatch(/invoke<LayerThumb\[\]>\('layer_thumbs', \{ size \}\)/);
    for (const hook of ['onStrokeEnd', 'onFillEnd']) {
      expect(src, `${hook} should refresh thumbnails`).toMatch(
        new RegExp(`${hook}=\\{\\(\\) => \\{ api\\.saveHistory\\(\\); void refreshThumbs\\(\\); \\}\\}`));
    }
    expect(src).toMatch(/api\.floodFill\(u, v, magicThreshold, effTarget\)\s*\n\s*\.then\(\(s\) => \{ applySnap\(s\); api\.saveHistory\(\); void refreshThumbs\(\); \}\);/);
    // Structural edits too: add/remove/reorder changes which picture belongs
    // to which row.
    expect(src).toMatch(/void refreshThumbs\(\);\s*\n\s*\}, \[applyUpdate, refreshThumbs\]\);/);
  });
});

describe('a switch sits on the parameters it governs', () => {
  /**
   * 视图 used to be a grid of four checkboxes in one section and five sliders
   * in another, labelled 贴图 / 叠加 / 密度 / 速度 / 强度. Nothing said which
   * switch went with which slider — and 速度 / 强度 both answered to 播放动画
   * while only one of them was anywhere near it.
   *
   * This is PS's 图层样式 grammar instead: ticking an effect reveals that
   * effect's own settings, indented underneath it, so ownership is geometry
   * rather than something you have to remember.
   */
  const view = src.match(/    view: \([\s\S]*?\n    \),/)![0];

  it('binds each switch to its own slider', () => {
    expect(src).toMatch(/function Toggle\(\{ label, on, onChange, children \}/);
    expect(src).toMatch(/<div className="tog-group">/);
    expect(src).toMatch(/<label className="tog"/);
    // The switch is a real <label>, so its text is part of the hit target — a
    // 13px checkbox on its own is a fiddly click, and the name is what you are
    // aiming at anyway.
    expect(src).toMatch(/<span className="ellipsis">\{label\}<\/span>/);

    // Four switches, and no separate grid of checkboxes left in 视图.
    expect(view.match(/<Toggle label=/g)).toHaveLength(4);
    expect(view).not.toContain('className="checks"');
    for (const label of ['天空贴图', '叠加 Flowmap', '流向箭头', '播放动画']) {
      expect(view, `视图 is missing the ${label} switch`).toContain(`<Toggle label="${label}"`);
    }
  });

  it('nests 速度 and 强度 under 播放动画, not next to it', () => {
    // Two rows, one switch — the case a flat list cannot express.
    const anim = view.match(/<Toggle label="播放动画"[\s\S]*?<\/Toggle>/)![0];
    expect(anim).toContain('<Row label="速度"');
    expect(anim).toContain('<Row label="强度"');
    expect(anim.match(/<Row label=/g)).toHaveLength(2);
    // The three overlays get exactly one parameter each.
    for (const label of ['天空贴图', '叠加 Flowmap', '流向箭头']) {
      const g = view.match(new RegExp(`<Toggle label="${label}"[\\s\\S]*?</Toggle>`))![0];
      expect(g.match(/<Row label=/g), `${label} should own one row`).toHaveLength(1);
    }
  });

  it('indents the parameters under the switch text, and keeps the switch lit', () => {
    // 19px = checkbox plus gap, so the rows align with the switch's *word*
    // rather than with its box — aligning to the box leaves them hanging
    // further left than the thing they belong to.
    expect(rawStyles).toMatch(/\.tog-body \{ padding-left: 19px;/);
    // The switch stays at full brightness: it is the control you use to turn
    // the group back on, and a dimmed control you are supposed to click is a
    // contradiction.
    expect(rawStyles).not.toMatch(/\.tog\.off|\.tog-group\.off/);
    const tog = rawStyles.match(/\.tog \{[^}]*\}/)![0];
    expect(tog).toContain('color: var(--txt);');
  });
});

describe('a control that does not apply is dimmed, not removed', () => {
  /**
   * Conditional controls are what make a panel jump. Ticking 叠加 Flowmap in
   * 视图 used to *insert* a section — header, rule and all — plus a row, which
   * shoved the whole column down by ~60px. You click a checkbox and the thing
   * you were about to click has moved out from under the pointer.
   *
   * Photoshop's rule is the opposite: a panel has a fixed set of controls and
   * greys out the ones that do not apply right now. Constant height is also
   * more informative — it says 叠加 Flowmap *has* an opacity at all, which a
   * row that only exists while it is on can never tell you.
   */
  const view = src.match(/    view: \([\s\S]*?\n    \),/)![0];

  it('renders every slider unconditionally and gates it with `off`', () => {
    // The bug: a `参数` section that existed only while one of the overlays was
    // on, plus one row per *enabled* overlay.
    expect(src).not.toMatch(/<Section title="参数">/);
    expect(src).not.toMatch(/\(showReference \|\| showFlowMap \|\| showArrows \|\| animating\)/);
    expect(view).not.toMatch(/\{(showReference|showFlowMap|showArrows|animating) &&/);

    // Five sliders, always present, each dimmed by the flag that gates it.
    expect(view.match(/<Row label=/g)).toHaveLength(5);
    for (const flag of ['showReference', 'showFlowMap', 'showArrows', 'animating']) {
      expect(view, `${flag} must dim its own row`).toContain(`off={!${flag}}`);
    }
    // 动画 owns two, so `animating` appears twice.
    expect(view.match(/off=\{!animating\}/g)).toHaveLength(2);
  });

  it('disables the slider too, so a dimmed row is actually inert', () => {
    // Dimming alone is a lie about state: the row looks unavailable but still
    // takes drags, and moving it would change a value you cannot see applied.
    expect(view.match(/disabled=\{!\w+\}/g)).toHaveLength(5);
    expect(src).toMatch(/function Range\(\{[\s\S]*?disabled \}/);
    expect(src).toMatch(/disabled=\{disabled\}/);
    // ...and the inert look has to exist, or `disabled` is a no-op here:
    // `appearance: none` means the UA's own dimming never applies.
    expect(rawStyles).toMatch(/input\[type=range\]\.rng:disabled \{/);
    expect(rawStyles).toMatch(/\.row\.off \.row-label \{ color: var\(--txt-faint\); \}/);
    expect(rawStyles).toMatch(/\.row\.off \.row-value \{[^}]*color: var\(--txt-faint\);/);
  });

  it('applies the same rule to the two other conditional rows', () => {
    // 障碍层's 范围 appeared only once 绕开障碍物流动 was ticked, and 文档的
    // 张角 only for 极坐标. Both pushed everything below them down.
    expect(src).toMatch(/<Row label="范围" off=\{!activeLayer\.disturbance_enabled\}/);
    expect(src).not.toMatch(/activeLayer\.disturbance_enabled && \(\s*\n\s*<Row label="范围"/);
    expect(src).toMatch(/<Row label="张角" off=\{state\.projection !== 'polar'\}/);
    expect(src).not.toMatch(/state\.projection === 'polar' && \(\s*\n\s*<Row label="张角"/);
  });

  it('dims the row, not the whole card', () => {
    // A uniform `opacity` on `.row` would take the *value* down with it, and
    // the value is the part worth keeping legible — it tells you what the
    // setting will come back as.
    const off = rawStyles.match(/\.row\.off[^\n]*/g) ?? [];
    expect(off.length).toBeGreaterThan(0);
    expect(off.join('\n')).not.toContain('opacity');
  });
});

describe('layer effects: something you hang on a layer', () => {
  /**
   * 模糊 used to be a slider in 属性 called 模糊. That is the wrong noun. A
   * layer's parameters are what it *is*; a blur is something done to its
   * pixels afterwards, and Photoshop keeps those apart — parameters in
   * Properties, effects behind the `fx` badge on the layer row.
   *
   * The consequence is that an effect is a *record* (kind + on/off + amount)
   * rather than a number: it can be added, switched off while keeping the
   * number it was tuned to, and removed again.
   */
  const i = src.indexOf('    layers: (');
  const layersPanel = src.slice(i, src.indexOf('\n    view:', i));

  it('puts 不透明度 in the 图层 panel, above the list', () => {
    // Above the rows, the way PS has it: a single control that always means
    // "the selected layer", so there is no ambiguity about which row it owns.
    expect(layersPanel).toMatch(/<Row label="不透明度"/);
    expect(layersPanel.indexOf('<Row label="不透明度"'))
      .toBeLessThan(layersPanel.indexOf('<div className="layer-list'));
    // ...and it is still a real layer write, not a local preview value.
    expect(layersPanel).toMatch(/updateLayer\(activeLayer\.id, \{ opacity: v \}\)/);
  });

  it('adds an effect with an action, not by revealing a slider', () => {
    // PS's "add a layer style" is a button in the panel footer; a hidden
    // slider would only ever appear once you already knew it was there.
    expect(layersPanel).toMatch(/<IconBtn icon="fx"/);
    expect(layersPanel).toMatch(/changeEffects\(addEffect\(activeLayer\.effects, 'blur'\), true\)/);
  });

  it('refuses the one kind that has no pixels to blur', () => {
    // An obstacle layer contributes a mask, so there is nothing for a blur to
    // act on; offering it would produce a control that does nothing.
    expect(src).toMatch(/const NO_FX: ReadonlySet<LayerKind> = new Set<LayerKind>\(\['obstacle'\]\);/);
    expect(src).toMatch(/const canFx = activeLayer \? !NO_FX\.has\(activeLayer\.kind\) : false;/);
    expect(layersPanel).toMatch(/disabled=\{!canFx\}/);
  });

  it('badges every layer that has effects, not just the active one', () => {
    // The point of the mark is to answer "which layers are doing something to
    // their pixels" while you are looking at a different one.
    expect(layersPanel).toMatch(/\{l\.effects\.length > 0 && \(/);
    expect(layersPanel).toMatch(/className="chip fx-badge"/);
    expect(rawStyles).toMatch(/\.chip\.fx-badge \{/);
  });

  it('lists the selected layer\'s effects under it, each with an eye of its own', () => {
    // Indented under the layer, per-effect eye / name / amount / delete — the
    // same shape as a layer row, because that is what it parallels.
    expect(layersPanel).toMatch(/<div className="fx-list">/);
    expect(layersPanel).toMatch(/className=\{`fx-row \$\{e\.enabled \? '' : 'off'\}`\}/);
    expect(layersPanel).toMatch(/setEffectEnabled\(activeLayer\.effects, ei, !e\.enabled\)/);
    expect(layersPanel).toMatch(/setEffectAmount\(activeLayer\.effects, ei, v\)/);
    expect(layersPanel).toMatch(/removeEffect\(activeLayer\.effects, ei\)/);
    // Indent 31px = the thumbnail column, so effect eyes land under layer eyes.
    expect(rawStyles).toMatch(/\.fx-list \{[\s\S]*?padding: 3px 5px 5px 31px;/);
  });

  it('dims a switched-off effect instead of removing its row', () => {
    // Same rule as everywhere else: switching one off must not move the rows
    // below it out from under the pointer, and the amount has to stay
    // readable — it is the number the effect will come back at.
    expect(layersPanel).toMatch(/disabled=\{!e\.enabled\}/);
    expect(rawStyles).toMatch(/\.fx-row\.off \.fx-name \{ color: var\(--txt-faint\); \}/);
    expect(rawStyles).toMatch(/\.fx-row\.off \.fx-val \{ color: var\(--txt-faint\); \}/);
    // ...and the row keeps its height, so nothing below it shifts.
    expect(rawStyles).toMatch(/\.fx-row \{[\s\S]*?min-height: 24px;/);
  });

  it('sends every effect edit through setEffects and into React state', () => {
    // One command for all four edits, so an effect list can never disagree
    // with the engine about how many effects a layer has.
    expect(src).toMatch(/const changeEffects = useCallback\(\(effects: LayerEffect\[\], history = false\) =>/);
    expect(src).toMatch(/applyUpdate\(await api\.setEffects\(id, next\.effects\)\)/);
  });

  it('never has more than one setEffects in flight', () => {
    // A blur is whole-canvas, so one round trip is tens of milliseconds while
    // a slider emits an input event every frame. Sending them all queues work
    // whose tail is always stale; the newest value waits behind the one that
    // is running and replaces whatever came before it.
    expect(src).toMatch(/const fxPending = useRef<\{ effects: LayerEffect\[\]; history: boolean \} \| null>\(null\);/);
    expect(src).toMatch(/const fxBusy = useRef\(false\);/);
    expect(src).toMatch(/if \(fxBusy\.current\) return;/);
    // Draining what arrived while this one ran is what makes "latest wins"
    // true rather than merely "not queued".
    expect(src).toMatch(/if \(fxPending\.current\) void flushFx\(\);/);
  });

  it('gives a history entry to clicks, not to slider frames', () => {
    // Add / remove / toggle are discrete and must be undoable. Dragging the
    // amount is not: one entry per frame would be forty entries per gesture,
    // each costing a zstd of the whole layer. This is what 不透明度 and 方向
    // already do — `updateLayer` never writes history.
    expect(src).toMatch(/if \(next\.history\) api\.saveHistory\(\);/);
    expect(layersPanel).toMatch(/changeEffects\(addEffect\(activeLayer\.effects, 'blur'\), true\)/);
    expect(layersPanel).toMatch(/changeEffects\(removeEffect\(activeLayer\.effects, ei\), true\)/);
    expect(layersPanel).toMatch(/changeEffects\(setEffectEnabled\(activeLayer\.effects, ei, !e\.enabled\), true\)/);
    // ...and the amount drag specifically asks for none.
    expect(layersPanel).not.toMatch(/setEffectAmount\(activeLayer\.effects, ei, v\), true/);
  });

  it('echoes the amount under the pointer instead of waiting for the engine', () => {
    // The slider is controlled by engine state, so without an echo the thumb
    // snaps back to the last value the engine acknowledged — a hundred
    // milliseconds behind the pointer at 4096².
    expect(src).toMatch(/const \[fxScrub, setFxScrub\] = useState<\{ i: number; v: number \} \| null>\(null\);/);
    expect(src).toMatch(/const amount = fxScrub && fxScrub\.i === ei \? fxScrub\.v : e\.amount;/);
    expect(src).toMatch(/setFxScrub\(\{ i: ei, v \}\);/);
    // ...and it has to let go once the engine caught up, or a later undo
    // would keep showing a value the layer no longer has.
    expect(src).toMatch(/if \(amt !== undefined && Math\.abs\(amt - fxScrub\.v\) < 0\.5\) setFxScrub\(null\);/);
  });
});

describe('the panel column is a dock, not a fixed stack', () => {
  /**
   * A fixed order is a fixed opinion about what you are about to do, and it
   * is wrong whenever you are doing something else. Moving 导出 to the top
   * while you iterate on exports is the whole point of PS's dock.
   */

  it('renders the panels from state, in dock order', () => {
    expect(src).toMatch(/const \[panelOrder, setPanelOrder\] = useState<PanelId\[\]>\(\[\.\.\.PANEL_IDS\]\);/);
    expect(src).toMatch(/panelOrder\.filter\(\(pid\) => panels\[pid\] !== null\)\.map\(\(pid\) => \(/);
    // 属性 describes the selected layer, so with nothing selected there is no
    // panel — not an empty one.
    expect(src).toMatch(/props: activeLayer \? \(/);
    expect(src).toMatch(/\) : null,/);
  });

  it('makes the title bar the drag handle', () => {
    // On the header, not on the section wrapper: the wrapper would turn every
    // slider in the panel body into a drag source too.
    expect(src).toMatch(/onPointerDown=\{onHeadDown\}/);
    expect(src).toMatch(/onHeadDown=\{beginDockDrag\(pid\)\}/);
  });

  it('accepts a drop anywhere on the card, not just on the 30px header', () => {
    // HTML5 drag-and-drop forced the drop onto the header, because only the
    // header had a handler. The hit-test is now "nearest card", which also
    // resolves the 4px gaps between cards instead of dropping the reorder.
    expect(src).toMatch(/const hitDockPanel = \(y: number\): string \| null => \{/);
    expect(src).toMatch(/const d = y < r\.top \? r\.top - y : y > r\.bottom \? y - r\.bottom : 0;/);
  });

  it('swallows the click a drag leaves behind', () => {
    // A drag ends with a click on the header it started from — and that click
    // would fold the panel you just moved.
    expect(src).toMatch(/if \(swallowClick\.current\) \{ swallowClick\.current = false; return; \}/);
  });

  it('reorders by moving 到 the slot it was dropped on', () => {
    expect(src).toMatch(/const reorderPanel = \(from: string, to: string\) => \{/);
    expect(src).toMatch(/if \(from === to\) return;/);
    // Splice at the target's index, so dropping on a panel lands above it —
    // which is what `drop-above` advertises.
    expect(src).toMatch(/next\.splice\(at, 0, from as PanelId\);/);
  });

  it('shows where the panel will land', () => {
    // Without the rule a reorder is invisible until it is already done.
    expect(src).toMatch(/dockDrag && dockDrag\.over === pid && dockDrag\.id !== pid \? 'drop-above' : '',/);
    expect(rawStyles).toMatch(/\.panel\.drop-above \{ box-shadow: 0 -2px 0 var\(--accent\); \}/);
    expect(rawStyles).toMatch(/\.panel\.dragging \{ opacity: \.5; \}/);
    // ...and the title bar says it is draggable, because nothing else does.
    expect(src).toMatch(/title=\{`\$\{title\} · 点击折叠，拖动标题栏可重排`\}/);
  });

  it('keeps the gap between cards tight', () => {
    const body = rawStyles.match(/\.panels \{[^}]*\}/)![0];
    expect(body).toMatch(/padding: 4px;/);
    expect(body).toMatch(/gap: 4px;/);
  });
});

describe('menu bar merged into the title bar', () => {
  const rawMenu = readFileSync(new URL('./menu.ts', import.meta.url), 'utf8');
  const rawBar = readFileSync(new URL('./AppBar.tsx', import.meta.url), 'utf8');

  it('turns window decorations off so there is no separate window bar', () => {
    // The whole point: one chrome row, not a native frame plus a menu below it.
    const conf = readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
    expect(conf).toMatch(/"decorations": false/);
    // ...which means the app has to draw its own window buttons.
    expect(rawBar).toMatch(/win\(\)\.minimize\(\)/);
    expect(rawBar).toMatch(/win\(\)\.toggleMaximize\(\)/);
    expect(rawBar).toMatch(/win\(\)\.close\(\)/);
  });

  it('has the five PS menus', () => {
    for (const label of ['文件', '编辑', '视图', '图层', '帮助']) {
      expect(rawMenu).toContain(`label: '${label}'`);
    }
    expect(src).toMatch(/<AppBar/);
  });

  it('keeps the drag region away from the buttons', () => {
    // A button inside a drag region is a coin flip between dragging the window
    // and firing its click, so the region is a dedicated filler instead.
    expect(rawBar).toMatch(/className="appbar-fill"\s*\n?\s*data-tauri-drag-region/);
    expect(rawBar).not.toMatch(/className="appbar"[^>]*data-tauri-drag-region/);
  });

  it('routes every menu command through one dispatcher refreshed per render', () => {
    expect(src).toMatch(/menuCmd\.current = \(cmd: MenuCmd\) =>/);
    expect(src).toMatch(/run=\{\(cmd\) => menuCmd\.current\(cmd\)\}/);
  });

  it('does not register accelerators that the keyboard handler already owns', () => {
    // Binding Ctrl+S here would fire it twice: the WebView still sees the
    // keydown, and `shortcuts.ts` acts on it too.
    expect(strip(rawMenu)).not.toMatch(/accelerator/i);
  });

  it('puts the recent files in 文件 > 打开最近', () => {
    expect(rawMenu).toContain("label: '打开最近'");
    expect(rawMenu).toMatch(/kind: 'path'/);
  });

  it('opens by default into the 3D view', () => {
    // A flowmap only reads as a flowmap once it is moving on a sky.
    expect(src).toMatch(/useState<ViewMode>\('3d'\)/);
  });

  it('puts 属性 above 图层, the way PS does', () => {
    // Contextual to the selected layer, so it belongs at the top of the column
    // rather than under the list it describes.
    //
    // This is the *default* order only — the column is a dock now, so the
    // order is state and can be dragged into anything. See `panelOrder`.
    expect(src).toMatch(/PANEL_IDS = \['props', 'layers',/);
    expect(src).toMatch(/useState<PanelId\[\]>\(\[\.\.\.PANEL_IDS\]\)/);
    const propsAt = src.indexOf('    props: activeLayer ? (');
    const layersAt = src.indexOf('    layers: (');
    expect(propsAt).toBeGreaterThan(0);
    expect(propsAt).toBeLessThan(layersAt);
  });
});

describe('Photoshop "Pro (Dark)" palette', () => {
  /**
   * Values taken from PhotoCraft's `crates/ui-egui/src/theme.rs`
   * (ThemeKind::Pro), which is itself sampled off Photoshop.
   *
   * The thing being tested is not the exact hex — it is that the chrome is
   * *neutral grey*. The old palette was near-black (#0f0f12) with a blue-violet
   * accent (#6366f1), which reads as "web app with a dark theme". Photoshop has
   * no hue in its chrome at all.
   */
  const root = rawStyles.slice(0, rawStyles.indexOf('* { box-sizing'));

  it('uses neutral greys for every surface', () => {
    for (const [name, hex] of [
      ['--dock', '#1e1e1e'],
      ['--chrome', '#323232'],
      ['--card', '#323232'],
      ['--field', '#242424'],
      ['--hover', '#424242'],
      ['--pressed', '#4e4e4e'],
      ['--row-selected', '#525252'],
    ]) {
      expect(root, `${name} should be ${hex}`).toContain(`${name}: ${hex}`);
    }
  });

  it('keeps the greys neutral — equal R, G and B', () => {
    // Any channel spread here means a tint has crept back in.
    const greys = ['--dock', '--chrome', '--card', '--field', '--hover', '--pressed', '--separator'];
    for (const name of greys) {
      const m = root.match(new RegExp(`${name}: #([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})`));
      expect(m, `${name} must be defined`).not.toBeNull();
      const [r, g, b] = m!.slice(1, 4);
      expect(r, `${name} is not neutral`).toBe(g);
      expect(g, `${name} is not neutral`).toBe(b);
    }
  });

  it('has dropped the old blue-violet accent', () => {
    expect(rawStyles).not.toContain('#6366f1');
    expect(rawStyles).not.toContain('#818cf8');
    // ...in favour of Photoshop's single blue.
    expect(root).toContain('--accent: #378ef0');
  });

  it('marks a selected tool with grey, not colour', () => {
    // Blue is reserved for the one primary action; PS selects tools by value.
    expect(rawStyles).toMatch(/button\.on \{ background: var\(--row-selected\)/);
    expect(rawStyles).toMatch(/\.toolbox \.tool\.on \{ background: var\(--row-selected\)/);
  });

  it('rounds corners the way Photoshop does', () => {
    // 7-12px radii were a web-component habit and a big part of why it did
    // not look like an image editor.
    expect(root).toContain('--r-sm: 3px');
    expect(root).toContain('--r: 4px');
    expect(root).toContain('--r-lg: 6px');
  });

  it('has no decorative gradients or glow in the chrome', () => {
    // Three gradients exist, and none decorates a surface: the slider's filled
    // track, its inert twin (a dimmed row still shows *where* the value is),
    // and the layer thumbnail's transparency checkerboard. A range input's
    // track *is* its background, so a gradient is the only way to draw one.
    // Anything else appearing here is an "app store" gradient creeping back in.
    const owners = [...rawStyles.matchAll(/(?:^|\n)([^\n{}]*)\{[^}]*linear-gradient/g)]
      .map((m) => m[1].trim());
    expect(owners.sort()).toEqual([
      '.layer-thumb', 'input[type=range].rng', 'input[type=range].rng:disabled']);
    expect(rawStyles).not.toMatch(/box-shadow: 0 1px 4px/);
  });
});

describe("tool icons", () => {
  const icons = rawIcons;
  // Unicode glyphs came from five different fonts, so they never lined up and
  // two fell back to emoji on some machines.
  it('ships real SVG paths, one per tool', () => {
    expect(icons).toMatch(/stroke="currentColor"/);
    expect(icons).toMatch(/viewBox="0 0 24 24"/);
    for (const name of ['brush', 'eraser', 'wand', 'pipette', 'hand']) {
      expect(icons, `missing ${name}`).toContain(`${name}: [`);
    }
  });

  it('attributes Lucide, since the icons are not ours', () => {
    expect(icons).toContain('lucide-icons/lucide');
    expect(icons).toContain('ISC');
  });
});
