import { useMemo } from "react";
import type { FileEntry } from "../types";
import { humanSize } from "../util";
import {
  IconFolder,
  IconFolderPlus,
  IconPlus,
  IconTrash,
  IconX,
} from "./Icons";

interface Props {
  entries: FileEntry[];
  roots: string[];
  recursive: boolean;
  includeDirs: boolean;
  readMedia: boolean;
  busy: boolean;
  dragOver: boolean;
  onToggleRecursive: () => void;
  onToggleDirs: () => void;
  onToggleMedia: () => void;
  onAddFolderItself: (p: string) => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onRemoveRoot: (p: string) => void;
  onClear: () => void;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export default function FilesStep({
  entries,
  roots,
  recursive,
  includeDirs,
  readMedia,
  busy,
  dragOver,
  onToggleRecursive,
  onToggleDirs,
  onToggleMedia,
  onAddFolderItself,
  onPickFiles,
  onPickFolder,
  onRemoveRoot,
  onClear,
}: Props) {
  const extStats = useMemo(() => {
    const m = new Map<string, { n: number; size: number }>();
    for (const e of entries) {
      const k = e.isDir ? "文件夹" : (e.ext || "无扩展名").toLowerCase();
      const cur = m.get(k) ?? { n: 0, size: 0 };
      cur.n += 1;
      cur.size += e.size;
      m.set(k, cur);
    }
    const list = [...m.entries()]
      .map(([ext, v]) => ({ ext, ...v }))
      .sort((a, b) => b.n - a.n);
    return { list: list.slice(0, 8), kinds: list.length, max: list[0]?.n ?? 1 };
  }, [entries]);

  const totalSize = useMemo(
    () => entries.reduce((s, e) => s + e.size, 0),
    [entries],
  );

  const dirCount = useMemo(
    () => entries.filter((e) => e.isDir).length,
    [entries],
  );

  return (
    <div className="step-body">
      {/* 紧凑单行：添加文件不是重点信息，不值得占一大块；
          拖放有全窗口提示层，这里只留入口 */}
      <div className={`add-row ${dragOver ? "over" : ""}`}>
        <button className="btn primary" onClick={onPickFiles} disabled={busy}>
          <IconPlus size={13} />
          选择文件
        </button>
        <button className="btn" onClick={onPickFolder} disabled={busy}>
          <IconFolder size={13} />
          选择文件夹
        </button>
        <label className="chk">
          <input
            type="checkbox"
            checked={recursive}
            onChange={onToggleRecursive}
          />
          包含子文件夹
        </label>
        <label className="chk" title="文件夹会作为可改名的一项进入列表">
          <input type="checkbox" checked={includeDirs} onChange={onToggleDirs} />
          文件夹也改名
        </label>
        <label
          className="chk"
          title="读 MP3/FLAC/MP4 标签和视频、图片分辨率，文件多时扫描会慢一点"
        >
          <input type="checkbox" checked={readMedia} onChange={onToggleMedia} />
          读取媒体标签
        </label>
        <span className="add-hint">也可把文件直接拖进窗口，重复的自动去重</span>
      </div>

      {roots.length > 0 && (
        <section className="card">
          <header className="card-head">
            <h3>已添加的位置</h3>
            <span className="card-count">{roots.length}</span>
            <button className="link-btn" onClick={onClear} disabled={busy}>
              全部清空
            </button>
          </header>
          <ul className="root-list">
            {roots.map((r) => (
              <li key={r} className="root-item">
                <span className="root-icon">
                  <IconFolder size={15} />
                </span>
                <span className="root-name" title={r}>
                  {baseName(r)}
                </span>
                <span className="root-path" title={r}>
                  {r}
                </span>
                <button
                  className="icon-btn sm"
                  title="把「这个文件夹本身」也加入改名列表"
                  onClick={() => onAddFolderItself(r)}
                  disabled={busy}
                >
                  <IconFolderPlus size={13} />
                </button>
                <button
                  className="icon-btn sm"
                  title="移除"
                  onClick={() => onRemoveRoot(r)}
                >
                  <IconX size={12} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {entries.length > 0 && (
        <section className="card">
          <header className="card-head">
            <h3>文件构成</h3>
            <span className="card-count">
              {extStats.kinds} 种类型
              {dirCount > 0 ? ` · ${dirCount} 个文件夹` : ""} · 共{" "}
              {humanSize(totalSize)}
            </span>
          </header>
          <ul className="ext-list">
            {extStats.list.map((e) => (
              <li key={e.ext} className="ext-item">
                <span className="ext-name">{e.ext}</span>
                <span className="ext-bar">
                  <i style={{ width: `${(e.n / extStats.max) * 100}%` }} />
                </span>
                <span className="ext-n">{e.n}</span>
                <span className="ext-size">{humanSize(e.size)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {entries.length === 0 && (
        <p className="empty-note">还没有添加任何文件，先把要改名的东西拖进来。</p>
      )}

      {entries.length > 0 && (
        <button
          className="link-btn danger center"
          onClick={onClear}
          disabled={busy}
        >
          <IconTrash />
          清空全部 {entries.length} 个文件
        </button>
      )}
    </div>
  );
}

