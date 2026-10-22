import { useEffect, useState } from 'react';

/**
 * What to do with a flowmap that did not come from this app.
 *
 * Every one of these is a repair, and each one is a guess that has to be
 * offered rather than made silently — a file from another tool is the right
 * shape but the wrong conventions, and getting one wrong does not fail, it
 * just quietly imports something you did not ask for.
 */
export interface ImportOpts {
  /** A file with no alpha decodes to zero everywhere. */
  opaqueIfFlatAlpha: boolean;
  /** B means mobility here and blue out there. */
  freeMobility: boolean;
  invertX: boolean;
  invertY: boolean;
}

interface Props {
  path: string;
  defaults: ImportOpts;
  busy: boolean;
  onCancel: () => void;
  onOk: (o: ImportOpts) => void;
}

function basename(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

export default function ImportFlowmapDlg({ path, defaults, busy, onCancel, onOk }: Props) {
  const [o, setO] = useState<ImportOpts>(defaults);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk(o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [o, onCancel, onOk]);

  const toggle = (k: keyof ImportOpts) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setO((s) => ({ ...s, [k]: e.target.checked }));

  return (
    <div className="modal-scrim" onPointerDown={onCancel}>
      {/* Stop the scrim's own pointerdown from reaching this card — clicking
          inside must not count as clicking away. */}
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-title">导入 Flowmap 为图层</div>
        <div className="modal-file" title={path}>{basename(path)}</div>
        <div className="modal-hint">
          R / G 是流向偏移（128 是不流），A 是覆盖率。尺寸会拉伸到画布尺寸。
        </div>

        <label className="modal-row">
          <input type="checkbox" checked={o.opaqueIfFlatAlpha} onChange={toggle('opaqueIfFlatAlpha')} />
          <span>
            没有 alpha 就当作不透明
            <span className="modal-note">
              外部 flowmap 多数不带 alpha，读进来是全 0。字面理解就是一层完全看不见的图层。
            </span>
          </span>
        </label>

        <label className="modal-row">
          <input type="checkbox" checked={o.freeMobility} onChange={toggle('freeMobility')} />
          <span>
            B 通道按「完全可流动」处理
            <span className="modal-note">
              这里的 B 是可流动度，不是蓝色。照抄文件里的值等于凭空画一片障碍。
            </span>
          </span>
        </label>

        <div className="modal-sep" />

        <label className="modal-row">
          <input type="checkbox" checked={o.invertX} onChange={toggle('invertX')} />
          <span>反转 R（水平偏移）</span>
        </label>

        <label className="modal-row">
          <input type="checkbox" checked={o.invertY} onChange={toggle('invertY')} />
          <span>反转 G（垂直偏移）</span>
        </label>
        <div className="modal-note modal-note-block">
          和导出用的是同一个开关：导出时勾了，导入时勾同一个就能还原。
        </div>

        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={busy} onClick={() => onOk(o)}>
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
