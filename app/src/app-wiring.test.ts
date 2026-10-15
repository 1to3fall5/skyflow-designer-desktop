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
   * 1. The desktop shell cancelled `dragstart` for any element that is not
   *    itself draggable, and you grab a layer row by its name or its badge, not
   *    by its padding. Covered in desktop.test.ts - here we only assert the row
   *    really is draggable.
   * 2. Order had no effect on the composite anyway: see the Rust tests for
   *    `a_flow_layer_above_an_obstacle_covers_it`.
   */
  it('exposes the row as a drag source', () => {
    expect(src).toMatch(/draggable\s+onDragStart/);
    expect(src).toMatch(/effectAllowed = 'move'/);
    expect(src).toMatch(/setData\('text\/plain', String\(i\)\)/);
  });

  it('reorders on drop using the row index it was dropped on', () => {
    expect(src).toMatch(/onDrop/);
    expect(src).toMatch(/if \(from !== i\) structural\(api\.reorder\(from, i\)\)/);
  });

  it('highlights the row being dropped onto', () => {
    expect(src).toMatch(/dragOver === i \? 'drop-target'/);
    expect(src).toMatch(/onDragLeave/);
    expect(src).toMatch(/onDragEnd/);
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
    for (const t of ['brush', 'eraser', 'magic_wand', 'eyedropper', 'pan']) {
      expect(src).toContain(`tool: '${t}'`);
    }
    // The union lives in shortcuts.ts, so check it there — otherwise the box
    // and the resolver can drift apart and one tool silently does nothing.
    expect(rawShortcuts).toMatch(
      /export type Tool = 'brush' \| 'eraser' \| 'magic_wand' \| 'eyedropper' \| 'pan';/);
  });

  it('has an options bar that follows the selected tool', () => {
    expect(src).toMatch(/<div className="optionsbar">/);
    // Brush sliders live here now, not in the footer.
    expect(src).toMatch(/\(tool === 'brush' \|\| tool === 'eraser'\)/);
    // ...and the wand gets its own parameter instead of being appended.
    expect(src).toMatch(/tool === 'magic_wand' && \(\s*<Slider label="容差"/);
  });

  it('makes the right-hand panels collapsible', () => {
    expect(src).toMatch(/<aside className="panels">/);
    // Keyed off the dock id now: the column renders from `panelOrder`, so no
    // panel can have a hardcoded `collapsed.layers`.
    expect(src).toMatch(/collapsed=\{!!collapsed\[pid\]\}/);
    expect(src).toMatch(/onToggle=\{\(\) => togglePanel\(pid\)\}/);
    // The header has to be a real button or it is unreachable by keyboard.
    expect(src).toMatch(/<button className="panel-head" onClick=\{onToggle\} aria-expanded=/);
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
    expect(src).toMatch(/\{!shellHidden && \(\s*<aside className="panels">/);
    expect(src).toMatch(/\{!shellHidden && \(\s*<div className="optionsbar">/);
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
    // All four, as checkboxes — no floating bar to make icons legible.
    for (const what of ['showReference', 'showFlowMap', 'showArrows', 'animating']) {
      expect(src, `${what} should have a checkbox`).toMatch(
        new RegExp(`checked=\\{${what}\\}`));
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

  it('gives 属性 three sections instead of one flat list', () => {
    // PS's Properties panel is 变换 / 对齐并分布 / 快速操作. Ours is the
    // kind-specific generator, then the two things every layer has.
    expect(src).toMatch(/<Section title=\{PARAM_SECT\[activeLayer\.kind\]\}>/);
    expect(src).toMatch(/<Section title="边缘">/);
    expect(src).toMatch(/<Section title="混合">/);
    // A paint layer has no parameters of its own; an empty panel reads as
    // broken, so it explains where its parameters actually live.
    expect(src).toMatch(/<p className="note">/);
    expect(rawStyles).toMatch(/\.note \{ margin: 0; font-size: 11px;/);
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
    expect(src).toMatch(/function Range\(\{ value, min, max, step = 0\.01, onChange, title \}/);
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
    // `eye-off` is a quoted key (it is not a valid identifier), so the check
    // has to accept both forms.
    for (const name of ['wind', 'box', 'trash', 'up', 'down', 'eye', 'eye-off']) {
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
    // On the header, not on the section wrapper: the wrapper would turn the
    // whole panel body — sliders included — into a drag source.
    expect(src).toMatch(/const dockProps = \(id: PanelId\) => \(\{/);
    expect(src).toMatch(/<button className="panel-head" onClick=\{onToggle\} aria-expanded=\{!collapsed\}[\s\S]*?\{\.\.\.dock\}/);
    expect(src).toMatch(/dock=\{dockProps\(pid\)\}/);
  });

  it('does not let the two drag sources in the same column collide', () => {
    // The layer list already owns `text/plain`, and `getData` is unreadable
    // during `dragover` — `types` is all a handler gets. Distinct types are
    // the only way one list can ignore the other's drag.
    expect(src).toMatch(/const DOCK_MIME = 'application\/x-sf-panel';/);
    expect(src).toMatch(/setData\(DOCK_MIME, id\)/);
    expect(src).toMatch(/if \(!e\.dataTransfer\.types\.includes\(DOCK_MIME\)\) return;/);
    expect(src).toMatch(/if \(!e\.dataTransfer\.types\.includes\('text\/plain'\)\) return;/);
    // ...and a panel payload must never be read as a layer index.
    expect(src).toMatch(/if \(!\/\^\\d\+\$\/\.test\(raw\)\) return;/);
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
    expect(src).toMatch(/panelOver === pid && panelDrag && panelDrag !== pid \? 'drop-above' : '',/);
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
    // Two gradients exist, and neither decorates a surface: the slider's
    // filled track (a range input's track *is* its background, so a gradient
    // is the only way to draw one) and the layer thumbnail's transparency
    // checkerboard. Anything else appearing here is an "app store" gradient
    // creeping back in.
    const owners = [...rawStyles.matchAll(/(?:^|\n)([^\n{}]*)\{[^}]*linear-gradient/g)]
      .map((m) => m[1].trim());
    expect(owners.sort()).toEqual(['.layer-thumb', 'input[type=range].rng']);
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
