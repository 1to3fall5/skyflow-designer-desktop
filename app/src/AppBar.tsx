/**
 * The one chrome row at the top: menu on the left, window buttons on the right.
 *
 * `decorations` is off (see tauri.conf.json), so this bar *is* the title bar —
 * there is no separate window bar above it. That is Photoshop's Windows
 * chrome, and it buys back a whole row of vertical space.
 *
 * The drag region is a dedicated filler element rather than the whole bar, so
 * the menu buttons and the window buttons are never inside it: a button that
 * both starts a window drag and fires a click is a coin flip.
 */
import React, { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { buildMenus, isChecked, type MenuCmd, type MenuEntry, type MenuState } from './menu';

export default function AppBar(props: {
  recent: string[];
  docName: string;
  dirty: boolean;
  state: MenuState;
  run: (cmd: MenuCmd) => void;
  openPath: (path: string) => void;
}) {
  const menus = buildMenus(props.recent);
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Click anywhere outside closes the open menu; Escape closes too. Both are
  // what every menu bar does and neither is optional — a menu that stays open
  // after you click into the canvas sits on top of the thing you are painting.
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const win = () => getCurrentWindow();

  return (
    <header className="appbar" ref={barRef}>
      {menus.map((m, i) => (
        <div className="menu-root" key={m.label}>
          <button
            className={`menu-btn ${open === i ? 'on' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              setOpen(open === i ? null : i);
            }}
            // Once one menu is open, hovering the others walks along the bar
            // the way every menu bar does. Without this you have to click each
            // label, which is two clicks per menu instead of one.
            onPointerEnter={() => { if (open !== null && open !== i) setOpen(i); }}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="menu-pop" role="menu">
              {m.items.map((entry, k) => (
                <MenuRow
                  key={k}
                  entry={entry}
                  state={props.state}
                  onCmd={(cmd) => { setOpen(null); props.run(cmd); }}
                  onPath={(p) => { setOpen(null); props.openPath(p); }}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Drag region: the empty middle of the bar. Double-click maximises,
          which is the one title-bar gesture people actually reach for. */}
      <div
        className="appbar-fill"
        data-tauri-drag-region
        onDoubleClick={() => void win().toggleMaximize()}
      />

      <span className="appbar-doc ellipsis" title={props.docName}>
        {props.docName}
        {props.dirty ? ' *' : ''}
      </span>

      <div className="appbar-controls">
        <button className="win-btn" title="最小化" aria-label="最小化"
          onClick={() => void win().minimize()}>─</button>
        <button className="win-btn" title="最大化" aria-label="最大化"
          onClick={() => void win().toggleMaximize()}>□</button>
        <button className="win-btn close" title="关闭" aria-label="关闭"
          onClick={() => void win().close()}>✕</button>
      </div>
    </header>
  );
}

function MenuRow({ entry, state, onCmd, onPath }: {
  entry: MenuEntry;
  state: MenuState;
  onCmd: (cmd: MenuCmd) => void;
  onPath: (path: string) => void;
}) {
  if (entry.kind === 'sep') return <div className="menu-sep" />;

  if (entry.kind === 'path') {
    return (
      <button className="menu-item" onClick={() => onPath(entry.path)} title={entry.path}>
        <span className="tick" />
        <span className="ellipsis">{entry.label}</span>
      </button>
    );
  }

  if (entry.kind === 'submenu') {
    return (
      <>
        <div className="menu-subhead">{entry.label}</div>
        {entry.items.map((sub, k) => (
          <MenuRow key={k} entry={sub} state={state} onCmd={onCmd} onPath={onPath} />
        ))}
      </>
    );
  }

  const ticked = entry.kind === 'check' && isChecked(entry.key, state);
  return (
    <button className="menu-item" onClick={() => onCmd(entry.cmd)}>
      {/* Reserved slot either way, so labels line up in one column instead of
          stepping sideways on the rows that happen to be ticked. */}
      <span className="tick">{ticked ? '✓' : ''}</span>
      <span>{entry.label}</span>
    </button>
  );
}
