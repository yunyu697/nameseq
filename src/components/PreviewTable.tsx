import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { STATUS_LABEL, type RenameOp } from "../types";
import { t } from "../i18n";
import { diffName } from "../util";
import { IconFolder, IconSearch, IconX } from "./Icons";

type Tab = "all" | "changed" | "problem" | "off";

interface Props {
  ops: RenameOp[];
  excluded: Set<number>;
  rowHeight: number;
  onToggle: (id: number) => void;
  /** 手动排序：把 dragIds（按原顺序组成的块）插到第 insertAt 行之前。
      仅在「全部」且未搜索时启用 */
  onReorder?: (dragIds: number[], insertAt: number) => void;
  /** 右键菜单 */
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
  onCopy?: (text: string, label: string) => void;
  onSetExcluded?: (ids: number[], off: boolean) => void;
}

export default function PreviewTable({
  ops,
  excluded,
  rowHeight,
  onToggle,
  onReorder,
  onOpen,
  onReveal,
  onCopy,
  onSetExcluded,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [flash, setFlash] = useState<Set<number>>(new Set());
  // 手动排序：正在拖的文件 id（按 ops 顺序排列）+ 落点（插入到第几行之前）
  const [sortDrag, setSortDrag] = useState<{ ids: number[]; at: number } | null>(
    null,
  );
  // 多选状态：普通点击单选，Ctrl+点击切换，Shift+点击范围选择
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // shift 范围选择的锚点行。存 id 而不是索引——重排后索引会变，行不变
  const anchorIdRef = useRef<number | null>(null);
  // 右键菜单
  const [menu, setMenu] = useState<{ x: number; y: number; op: RenameOp } | null>(
    null,
  );

  // 新文件名一变就闪一下：让「改了规则 → 结果变了」这件事有明确的视觉回应
  const prevNames = useRef(new Map<number, string>());
  useEffect(() => {
    const prev = prevNames.current;
    const changed = new Set<number>();
    if (ops.length <= 4000) {
      for (const o of ops) {
        const old = prev.get(o.id);
        if (old !== undefined && old !== o.newName) changed.add(o.id);
      }
    }
    prevNames.current = new Map(ops.map((o) => [o.id, o.newName]));
    if (changed.size === 0) return;
    setFlash(changed);
    const t = window.setTimeout(() => setFlash(new Set()), 560);
    return () => window.clearTimeout(t);
  }, [ops]);

  const counts = useMemo(() => {
    let changed = 0;
    let problem = 0;
    for (const o of ops) {
      if (o.status === "ok") changed += 1;
      if (o.status === "conflict" || o.status === "invalid" || o.status === "missing")
        problem += 1;
    }
    return {
      all: ops.length,
      changed,
      problem,
      off: ops.filter((o) => excluded.has(o.id)).length,
    };
  }, [ops, excluded]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ops.filter((o) => {
      if (tab === "changed" && o.status !== "ok") return false;
      if (tab === "problem" && !["conflict", "invalid", "missing"].includes(o.status))
        return false;
      if (tab === "off" && !excluded.has(o.id)) return false;
      if (!needle) return true;
      return (
        o.oldName.toLowerCase().includes(needle) ||
        o.newName.toLowerCase().includes(needle)
      );
    });
  }, [ops, q, tab, excluded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 14,
  });

  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [q, tab, virtualizer]);

  // 密度切换会改变行高，必须让虚拟列表重新测量，否则滚动位置会错位
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: "all", label: "全部", n: counts.all },
    { id: "changed", label: "会改名", n: counts.changed },
    { id: "problem", label: "有问题", n: counts.problem },
    { id: "off", label: "已排除", n: counts.off },
  ];

  // 手动排序只在「全部 + 无搜索」时开放：过滤视图里行序和真实顺序对不上，
  // 拖了会让人以为文件真的被移动了。
  const canDrag = tab === "all" && !q.trim() && !!onReorder && ops.length > 1;

  // 文件列表变化时清掉已经不存在的选中项（重新扫描 / 清空后残留会出错）
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const alive = new Set(ops.map((o) => o.id));
      const next = new Set([...s].filter((id) => alive.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [ops]);

  // 拖动中的 id 集合，渲染时查行样式用
  const dragSet = useMemo(
    () => new Set(sortDrag?.ids ?? []),
    [sortDrag],
  );

  /**
   * 拖动时的实时预览：整张列表按「松手后的样子」排好。
   * 和 App.reorderToIndex 同一套换算：rawAt 减去它前面被拖走的行数，再整块插入。
   * 返回 id → 最终行号；行渲染时直接位移到最终位置，松手零跳变。
   */
  const finalIndex = useMemo(() => {
    if (!sortDrag) return null;
    const idsSet = new Set(sortDrag.ids);
    const blockLen = sortDrag.ids.length;
    const beforeCount = ops
      .slice(0, sortDrag.at)
      .filter((o) => idsSet.has(o.id)).length;
    const at = Math.max(
      0,
      Math.min(ops.length - blockLen, sortDrag.at - beforeCount),
    );
    const map = new Map<number, number>();
    let r = 0;
    for (const op of ops) {
      if (idsSet.has(op.id)) continue;
      if (r === at) r += blockLen; // 跳过块要占的位置
      map.set(op.id, r++);
    }
    let b = 0;
    for (const op of ops) if (idsSet.has(op.id)) map.set(op.id, at + b++);
    return map;
  }, [sortDrag, ops]);

  /** 右键菜单：点在已选中的多选组里就按组操作，否则单行 */
  const menuTargets = useMemo(() => {
    if (!menu) return [];
    if (selected.has(menu.op.id) && selected.size > 1) {
      return ops.filter((o) => selected.has(o.id));
    }
    return [menu.op];
  }, [menu, selected, ops]);

  // 菜单开着时：点外面 / Esc / 滚动列表都收起
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    parentRef.current?.addEventListener("scroll", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      parentRef.current?.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const runMenu = <A extends unknown[]>(fn?: (...args: A) => void, ...args: A) => {
    setMenu(null);
    fn?.(...args);
  };

  /**
   * 行排序用指针事件而不是 HTML5 DnD：
   * Tauri/WebView2 开着原生文件拖放时，页面内的 dragstart/drop 会被原生层吞掉，
   * 而且行内拖动会误触发整个窗口的「添加文件」拖放高亮。指针方案两条都不沾。
   * 整行都可以按下拖动，只有选择框例外（它有自己的点击语义）。
   */
  const rowPointerDown = (e: React.PointerEvent, op: RenameOp) => {
    if (!canDrag || e.button !== 0) return;
    // 选择框保留原语义：勾选/取消排除，不参与拖动和选择
    if ((e.target as HTMLElement).closest(".pick")) return;
    // 拖动排序和文件名文本选择二选一，这里选前者
    e.preventDefault();
    const index = ops.findIndex((o) => o.id === op.id);

    // Ctrl/⌘ + 按下：切换选中，不启动拖动
    if (e.ctrlKey || e.metaKey) {
      anchorIdRef.current = op.id;
      setSelected((s) => {
        const n = new Set(s);
        n.has(op.id) ? n.delete(op.id) : n.add(op.id);
        return n;
      });
      return;
    }
    // Shift + 按下：从锚点行到当前行的范围选择
    if (e.shiftKey) {
      const anchorIdx =
        anchorIdRef.current != null
          ? ops.findIndex((o) => o.id === anchorIdRef.current)
          : index;
      const a = anchorIdx >= 0 ? anchorIdx : index;
      const [lo, hi] = a <= index ? [a, index] : [index, a];
      setSelected(new Set(ops.slice(lo, hi + 1).map((o) => o.id)));
      return;
    }

    // 普通按下：
    // - 按在已选中的多选组里 → 拖整组，选择保持
    // - 否则 → 选中这一行并拖它
    let ids: Set<number>;
    if (selected.has(op.id) && selected.size > 1) {
      ids = selected;
    } else {
      ids = new Set([op.id]);
      setSelected(ids);
      anchorIdRef.current = op.id;
    }
    startSort(e, ids);
  };

  const startSort = (e: React.PointerEvent, ids: Set<number>) => {
    e.preventDefault();
    // 拖动块按 ops 里的原顺序组成，松手后整块插到目标位置
    const ordered = ops.filter((o) => ids.has(o.id)).map((o) => o.id);
    if (ordered.length === 0) return;
    setSortDrag({
      ids: ordered,
      at: ops.findIndex((o) => o.id === ordered[0]),
    });
    const tbody = parentRef.current;
    if (!tbody) return;

    const move = (ev: PointerEvent) => {
      const rect = tbody.getBoundingClientRect();
      // 落点 = 指针在滚动内容里的纵向位置，落在某行的上/下半格决定插到它前/后
      const y = ev.clientY - rect.top + tbody.scrollTop;
      const at = Math.max(0, Math.min(ops.length, Math.round(y / rowHeight)));
      // 靠近上下边缘时自动滚动，长列表也能拖到看不见的行
      const edge = 30;
      if (ev.clientY - rect.top < edge) tbody.scrollTop -= 10;
      else if (rect.bottom - ev.clientY < edge) tbody.scrollTop += 10;
      setSortDrag((d) => (d && d.at !== at ? { ...d, at } : d));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setSortDrag((d) => {
        if (d && d.ids.length > 0) {
          // 锚点跟到被拖块的第一行，shift 范围选择以它为基准
          anchorIdRef.current = d.ids[0];
          onReorder?.(d.ids, d.at);
        }
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className="table">
      <div className="table-tools">
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "on" : ""}`}
              onClick={() => setTab(t.id)}
              disabled={t.n === 0 && t.id !== "all"}
            >
              {t.label}
              <i>{t.n}</i>
            </button>
          ))}
        </div>
        <div className="search">
          <IconSearch />
          <input
            value={q}
            placeholder="搜索文件名"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button className="search-clear" onClick={() => setQ("")} title="清空">
              <IconX size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="thead">
        <span />
        <span>原文件名</span>
        <span />
        <span>新文件名</span>
        <span>状态</span>
      </div>

      {rows.length === 0 ? (
        <div className="table-empty">
          {ops.length === 0 ? (
            <>
              <p>还没有文件</p>
              <p className="hint">在左边「文件」里拖入文件或文件夹</p>
            </>
          ) : (
            <>
              <p>没有匹配的文件</p>
              <p className="hint">换个关键词，或切回「全部」</p>
            </>
          )}
        </div>
      ) : (
        <div className={`tbody ${sortDrag ? "sorting" : ""}`} ref={parentRef}>
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {sortDrag && (
              <div
                className="sort-line"
                style={{ transform: `translateY(${sortDrag.at * rowHeight}px)` }}
              >
                {sortDrag.ids.length > 1 && (
                  <i className="sort-n">{sortDrag.ids.length}</i>
                )}
              </div>
            )}
            {virtualizer.getVirtualItems().map((vi) => {
              const op = rows[vi.index];
              const isOff = excluded.has(op.id);
              const d = diffName(op.oldName, op.newName);
              // 拖动中：整行实时位移到「松手后」的位置，所见即所得
              const fi = finalIndex
                ? (finalIndex.get(op.id) ?? vi.index) * rowHeight
                : vi.start;
              return (
                <div
                  className={`trow st-${op.status} ${isOff ? "is-off" : ""} ${
                    flash.has(op.id) ? "flash" : ""
                  } ${canDrag ? "draggable" : ""} ${
                    selected.has(op.id) ? "selected" : ""
                  } ${dragSet.has(op.id) ? "dragging" : ""}`}
                  key={vi.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${fi}px)`,
                  }}
                  onPointerDown={(e) => rowPointerDown(e, op)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (sortDrag) return;
                    // 右键没选中的行 = 单选它；选中的组里则保持组
                    if (!selected.has(op.id)) {
                      setSelected(new Set([op.id]));
                      anchorIdRef.current = op.id;
                    }
                    setMenu({ x: e.clientX, y: e.clientY, op });
                  }}
                >
                  <span className="grip" title={t("拖动排序")} />
                  <span className="pick">
                    <input
                      type="checkbox"
                      checked={!isOff}
                      title={
                        isOff
                          ? t("已排除，点一下恢复")
                          : t("取消勾选可排除这个文件")
                      }
                      onChange={() => onToggle(op.id)}
                    />
                  </span>
                  <span className="name old" title={op.from}>
                    {op.isDir && <IconFolder size={11} className="dir-ico" />}
                    {d.oldPre}
                    {d.oldMid && <mark className="del">{d.oldMid}</mark>}
                    {d.oldSuf}
                  </span>
                  <span className="arrow">→</span>
                  <span className="name new" title={op.to}>
                    {d.newPre}
                    {d.newMid && <mark className="ins">{d.newMid}</mark>}
                    {d.newSuf}
                  </span>
                  <span className="status">
                    <span className={`badge ${op.status}`}>
                      {STATUS_LABEL[op.status]}
                    </span>
                    {op.reason && <em className="reason">{op.reason}</em>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {menu && (
        <div
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 230),
            top: Math.min(menu.y, window.innerHeight - 300),
          }}
        >
          {menuTargets.length > 1 && (
            <div className="ctx-label">已选 {menuTargets.length} 行</div>
          )}
          {menuTargets.length === 1 && (
            <>
              <button
                className="ctx-item"
                onClick={() => runMenu(onOpen, menu.op.from)}
              >
                打开文件
              </button>
              <button
                className="ctx-item"
                onClick={() =>
                  runMenu(onReveal, menu.op.from)
                }
              >
                在资源管理器中显示
              </button>
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() =>
                  runMenu(onCopy, menu.op.oldName, "原文件名")
                }
              >
                复制原文件名
              </button>
              <button
                className="ctx-item"
                onClick={() =>
                  runMenu(onCopy, menu.op.newName, "新文件名")
                }
              >
                复制新文件名
              </button>
              <button
                className="ctx-item"
                onClick={() =>
                  runMenu(onCopy, menu.op.from, "完整路径")
                }
              >
                复制完整路径
              </button>
            </>
          )}
          {menuTargets.length > 1 && (
            <>
              <button
                className="ctx-item"
                onClick={() =>
                  runMenu(
                    onCopy,
                    menuTargets.map((o) => o.oldName).join("\r\n") ,
                    `${menuTargets.length} 个文件名` ,
                  )
                }
              >
                复制 {menuTargets.length} 个文件名
              </button>
              <button
                className="ctx-item"
                onClick={() =>
                  runMenu(
                    onCopy,
                    menuTargets.map((o) => o.from).join("\r\n") ,
                    `${menuTargets.length} 个完整路径` ,
                  )
                }
              >
                复制 {menuTargets.length} 个完整路径
              </button>
            </>
          )}
          <div className="ctx-sep" />
          {(() => {
            const ids = menuTargets.map((o) => o.id);
            const allOff = ids.every((id) => excluded.has(id));
            return (
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null);
                  if (ids.length === 1) onToggle(ids[0]);
                  else onSetExcluded?.(ids, !allOff);
                }}
              >
                {allOff
                  ? ids.length > 1
                    ? t("恢复 {n} 个文件", { n: ids.length })
                    : t("恢复这个文件")
                  : ids.length > 1
                    ? t("排除 {n} 个文件", { n: ids.length })
                    : t("排除这个文件")}
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
