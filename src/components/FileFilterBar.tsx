import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, RenameConfig, SortBy } from "../types";
import { FILE_TYPE_GROUPS, entryMatchKey, typeStats } from "../fileTypes";
import { t } from "../i18n";
import { IconChevron, IconX } from "./Icons";

export interface FileFilterState {
  /** include = 只改名命中的；exclude = 命中的跳过 */
  mode: "include" | "exclude";
  /** 小写扩展名（不带点）；"__dir" 代表文件夹；"" 代表无扩展名 */
  exts: string[];
}

export const EMPTY_FILE_FILTER: FileFilterState = { mode: "exclude", exts: [] };

export const SORT_OPTIONS: { id: SortBy; label: string }[] = [
  { id: "original", label: "添加顺序" },
  { id: "name", label: "文件名" },
  { id: "pinyin", label: "文件名（按拼音）" },
  { id: "folder", label: "所在文件夹" },
  { id: "ext", label: "扩展名" },
  { id: "modified", label: "修改时间" },
  { id: "size", label: "文件大小" },
];

/** 次级键少一些：再嵌一层拼音之类的组合没有实际意义 */
const SORT2_OPTIONS = SORT_OPTIONS.filter((o) => o.id !== "pinyin");

interface Props {
  entries: FileEntry[];
  filter: FileFilterState;
  /** 当前筛选命中的文件数（App 算好传进来，口径和排除集合一致） */
  matched: number;
  onFilterChange: (f: FileFilterState) => void;
  sort: Pick<RenameConfig, "sortBy" | "sortBy2" | "descending" | "naturalSort">;
  onSortChange: (
    p: Partial<
      Pick<RenameConfig, "sortBy" | "sortBy2" | "descending" | "naturalSort">
    >,
  ) => void;
}

export default function FileFilterBar({
  entries,
  filter,
  matched,
  onFilterChange,
  sort,
  onSortChange,
}: Props) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [manual, setManual] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 关掉面板：点外面 / Esc
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  const stats = useMemo(() => typeStats(entries), [entries]);

  const toggleExt = (key: string) => {
    const has = filter.exts.includes(key);
    const next = has
      ? filter.exts.filter((x) => x !== key)
      : [...filter.exts, key];
    onFilterChange({ ...filter, exts: next });
  };

  const toggleGroup = (gid: string) => {
    const g = FILE_TYPE_GROUPS.find((x) => x.id === gid);
    if (!g) return;
    const present = g.exts.filter((k) => stats.exts.has(k));
    const allOn =
      present.length > 0 && present.every((k) => filter.exts.includes(k));
    const next = allOn
      ? filter.exts.filter((k) => !present.includes(k))
      : Array.from(new Set([...filter.exts, ...present]));
    onFilterChange({ ...filter, exts: next });
  };

  const addManual = () => {
    const parts = manual
      .split(/[,\s;，；]+/)
      .map((s) => s.replace(/^\./, "").trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    onFilterChange({
      ...filter,
      exts: Array.from(new Set([...filter.exts, ...parts])),
    });
    setManual("");
  };

  // 展开面板时分组按「当前文件里有没有」过滤（按需显示），并按命中数排序
  const panelGroups = useMemo(
    () =>
      FILE_TYPE_GROUPS.map((g) => ({
        ...g,
        present: g.exts.filter((k) => stats.exts.has(k)),
      })).filter((g) => g.present.length > 0),
    [stats],
  );

  if (entries.length === 0) return null;

  const selectedSet = new Set(filter.exts);

  return (
    <div className="ff-bar" ref={wrapRef}>
      <div className="ff-row">
        <div className="seg ff-mode">
          <button
            className={`seg-item ${filter.mode === "include" ? "on" : ""}`}
            onClick={() => onFilterChange({ ...filter, mode: "include" })}
            title={t("只保留命中的类型，其余全部排除")}
          >
            {t("包含")}
          </button>
          <button
            className={`seg-item ${filter.mode === "exclude" ? "on" : ""}`}
            onClick={() => onFilterChange({ ...filter, mode: "exclude" })}
            title={t("命中的类型跳过，其余照常改名")}
          >
            {t("排除")}
          </button>
        </div>

        {/* 预设类型：当前文件里存在该类型才显示 */}
        <div className="ff-chips">
          {FILE_TYPE_GROUPS.map((g) => {
            const n = stats.groups.get(g.id) ?? 0;
            if (n === 0) return null;
            const on = g.exts.every((k) => selectedSet.has(k));
            return (
              <button
                key={g.id}
                className={`ff-chip ${on ? "on" : ""}`}
                onClick={() => toggleGroup(g.id)}
              >
                {t(g.name)}
                <i>{n}</i>
              </button>
            );
          })}
          {filter.exts
            .filter((k) => !FILE_TYPE_GROUPS.some((g) => g.exts.includes(k)))
            .map((k) => (
              <button
                key={k}
                className="ff-chip on manual"
                title={t("手动添加的扩展名，点一下移除")}
                onClick={() => toggleExt(k)}
              >
                {k === "" ? t("无扩展名") : `.${k}`}
                <IconX size={10} />
              </button>
            ))}
        </div>

        <button
          className={`ff-more ${panelOpen ? "open" : ""}`}
          onClick={() => setPanelOpen((v) => !v)}
        >
          {t("扩展名")}
          <IconChevron size={11} />
        </button>
        {filter.exts.length > 0 && (
          <button
            className="ff-clear"
            title={t("清空筛选")}
            onClick={() => onFilterChange({ ...filter, exts: [] })}
          >
            <IconX size={11} />
            {t("清空")}
          </button>
        )}
        <span className={`ff-count ${matched > 0 ? "on" : ""}`}>
          {t("命中")} {matched}
        </span>
      </div>

      {panelOpen && (
        <div className="ff-panel" ref={panelRef}>
          <div className="ff-panel-input">
            <input
              value={manual}
              placeholder={t("输入扩展名，如 mp4 或 mp4, mkv，回车添加")}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManual();
                }
              }}
            />
            <button
              className="btn tiny"
              onClick={addManual}
              disabled={!manual.trim()}
            >
              {t("添加")}
            </button>
          </div>
          <p className="ff-panel-hint">
            {t("只列出这批文件里出现的扩展名；类型分组可整组勾选")}
          </p>
          <div className="ff-panel-groups">
            {panelGroups.map((g) => {
              const allOn = g.present.every((k) => selectedSet.has(k));
              return (
                <div key={g.id} className="ff-panel-group">
                  <button
                    className={`ff-group-name ${allOn ? "on" : ""}`}
                    onClick={() => toggleGroup(g.id)}
                    title={allOn ? t("取消整组") : t("选中整组")}
                  >
                    {t(g.name)}
                  </button>
                  <div className="ff-group-exts">
                    {g.present.map((k) => (
                      <button
                        key={k}
                        className={`ff-ext ${selectedSet.has(k) ? "on" : ""}`}
                        onClick={() => toggleExt(k)}
                      >
                        {k === "" ? t("（无扩展名）") : k}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="ff-row ff-sort">
        <span className="ff-label">{t("排序")}</span>
        <select
          value={sort.sortBy}
          onChange={(e) => onSortChange({ sortBy: e.target.value as SortBy })}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {t(o.label)}
            </option>
          ))}
        </select>
        <span className="ff-label dim">{t("再按")}</span>
        <select
          value={sort.sortBy2 ?? ""}
          onChange={(e) =>
            onSortChange({
              sortBy2: (e.target.value || null) as SortBy | null,
            })
          }
          title={t("主排序相同时再按这个排")}
        >
          <option value="">{t("不细分")}</option>
          {SORT2_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {t(o.label)}
            </option>
          ))}
        </select>
        <label className="chk" title={t("整体倒过来（IMG_10 排到 IMG_2 前）")}>
          <input
            type="checkbox"
            checked={sort.descending}
            onChange={(e) => onSortChange({ descending: e.target.checked })}
          />
          {t("倒序")}
        </label>
        <label className="chk" title={t("IMG_2 排在 IMG_10 前")}>
          <input
            type="checkbox"
            checked={sort.naturalSort}
            onChange={(e) => onSortChange({ naturalSort: e.target.checked })}
          />
          {t("自然排序")}
        </label>
      </div>
    </div>
  );
}

/** 求当前筛选命中的 entry id 集合（App 用来并进排除集合） */
export function matchFilterIds(
  entries: FileEntry[],
  filter: FileFilterState,
): Set<number> {
  if (filter.exts.length === 0) return new Set();
  const keys = new Set(filter.exts);
  const hit = new Set<number>();
  for (const e of entries) {
    if (keys.has(entryMatchKey(e.isDir, e.ext))) hit.add(e.id);
  }
  return hit;
}
