import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ACTION_GROUPS, ACTION_LABELS } from "../rules";
import {
  BUILTIN_PRESETS,
  PRESET_GROUPS,
  groupPresets,
  type Preset,
  type PresetGroup,
} from "../presets";
import type { Action, Rule } from "../types";
import RuleEditor from "./RuleEditor";
import {
  IconChevron,
  IconLayers,
  IconPlus,
  IconSave,
  IconSpark,
  IconX,
} from "./Icons";

interface Props {
  rules: Rule[];
  presets: Preset[];
  openIds: Set<string>;
  removing: Set<string>;
  onToggleOpen: (id: string) => void;
  onSetAllOpen: (open: boolean) => void;
  onAddRule: (kind: Action["kind"]) => void;
  onChangeRule: (r: Rule) => void;
  onRemoveRule: (id: string) => void;
  onMoveRule: (id: string, dir: -1 | 1) => void;
  onApplyPreset: (p: Preset) => void;
  onSavePreset: (name: string, group: PresetGroup) => void;
  onDeletePreset: (id: string) => void;
  onImportChain: () => void;
  onExportChain: () => void;
}

type Panel = "lib" | "presets" | null;

export default function RulesStep({
  rules,
  presets,
  openIds,
  removing,
  onToggleOpen,
  onSetAllOpen,
  onAddRule,
  onChangeRule,
  onRemoveRule,
  onMoveRule,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onImportChain,
  onExportChain,
}: Props) {
  // 规则库和预设不再常驻版面，需要时点按钮唤出。
  // 规则链还是空的就先自动展开预设，给用户一个直接可点的起点。
  const [panel, setPanel] = useState<Panel>(
    rules.length === 0 ? "presets" : null,
  );
  // 预设按分组展开。null 表示「全部展开」，也可以只展开某一组。
  const [openGroups, setOpenGroups] = useState<Set<PresetGroup> | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftGroup, setDraftGroup] = useState<PresetGroup>("structure");
  const toolbarRef = useRef<HTMLDivElement>(null);
  const libBtnRef = useRef<HTMLButtonElement>(null);
  const presetBtnRef = useRef<HTMLButtonElement>(null);
  // 浮层用 portal 渲染到 body + fixed 定位：分区容器 overflow:hidden 折叠动画
  // 会裁掉 absolute 浮层，portal 顺便也解决了旧版被滚动容器裁剪的问题
  const [popPos, setPopPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const popRef = useRef<HTMLDivElement>(null);
  const allOpen = rules.length > 0 && rules.every((r) => openIds.has(r.id));

  const groups = useMemo(
    () => groupPresets(BUILTIN_PRESETS, presets),
    [presets],
  );
  const presetTotal = groups.reduce((n, g) => n + g.items.length, 0);

  // 点浮层外面或按 Esc 就收起——不拦浮层内部的点击（浮层已 portal，单独查）
  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!toolbarRef.current?.contains(t) && !popRef.current?.contains(t)) {
        setPanel(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    // 页面任何滚动都收起浮层：fixed 定位不跟着内容走，留着会飘错位置
    const onScroll = () => setPanel(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [panel]);

  // 浮层坐标：锚定触发按钮下方，渲染后按实际宽度收回右缘
  useLayoutEffect(() => {
    if (!panel) {
      setPopPos(null);
      return;
    }
    if (popPos) return;
    const btn = (panel === "lib" ? libBtnRef : presetBtnRef).current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setPopPos({ left: r.left, top: r.bottom + 8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  useLayoutEffect(() => {
    if (!panel || !popPos || !popRef.current) return;
    const w = popRef.current.offsetWidth;
    const left = Math.max(
      8,
      Math.min(popPos.left, window.innerWidth - w - 8),
    );
    if (left !== popPos.left) setPopPos({ ...popPos, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, popPos]);

  const isGroupOpen = (g: PresetGroup) => openGroups === null || openGroups.has(g);

  const toggleGroup = (g: PresetGroup) => {
    if (openGroups === null) {
      // 当前是「全部展开」，点一下就只留这一组
      setOpenGroups(new Set([g]));
      return;
    }
    const next = new Set(openGroups);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    // 全都收起来了就回到「全部展开」，否则用户会以为预设没了
    setOpenGroups(next.size === 0 ? null : next);
  };

  const togglePanel = (p: Exclude<Panel, null>) =>
    setPanel((cur) => (cur === p ? null : p));

  const commit = () => {
    const name = draft.trim();
    if (name) onSavePreset(name, draftGroup);
    setDraft("");
    setSaving(false);
  };

  return (
    <div className="step-body">
      <div className="rules-toolbar" ref={toolbarRef}>
        <button
          ref={libBtnRef}
          className={`btn toolbar-btn ${panel === "lib" ? "on" : ""}`}
          onClick={() => togglePanel("lib")}
        >
          <IconPlus size={14} />
          添加规则
          <span className={`chev ${panel === "lib" ? "open" : ""}`}>
            <IconChevron />
          </span>
        </button>
        <button
          ref={presetBtnRef}
          className={`btn toolbar-btn ${panel === "presets" ? "on" : ""}`}
          onClick={() => togglePanel("presets")}
        >
          <IconSpark size={14} />
          预设
          <span className="toolbar-count">{presetTotal}</span>
          <span className={`chev ${panel === "presets" ? "open" : ""}`}>
            <IconChevron />
          </span>
        </button>
        <button
          className="link-btn"
          disabled={rules.length === 0}
          onClick={() => {
            setSaving(true);
            setPanel("presets");
          }}
        >
          <IconSave size={13} />
          存为预设
        </button>
        <span className="grow" />
        <span className="toolbar-hint">
          {rules.length === 0
            ? "从规则库挑一条，或直接套用预设"
            : `共 ${rules.length} 条规则`}
        </span>

        {panel === "lib" && popPos && (
          createPortal(
            <div
              ref={popRef}
              className="pop pop-lib fixed"
              style={{ left: popPos.left, top: popPos.top }}
            >
              <div className="lib-body">
                {ACTION_GROUPS.map((g) => (
                  <div className="lib-group" key={g.title}>
                    <span className="lib-title">{g.title}</span>
                    <div className="lib-items">
                      {g.kinds.map((k) => (
                        <button
                          key={k}
                          className="lib-item"
                          onClick={() => onAddRule(k)}
                        >
                          <IconPlus size={13} />
                          {ACTION_LABELS[k]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        )}

        {panel === "presets" && popPos && (
          createPortal(
            <div
              ref={popRef}
              className="pop pop-presets fixed"
              style={{ left: popPos.left, top: popPos.top }}
            >
            {saving && (
              <div className="save-row">
                <input
                  autoFocus
                  className="mono"
                  value={draft}
                  placeholder="给这套规则起个名字"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") {
                      setSaving(false);
                      setDraft("");
                    }
                  }}
                />
                <select
                  className="save-group"
                  value={draftGroup}
                  onChange={(e) => setDraftGroup(e.target.value as PresetGroup)}
                  title="放到哪个分组"
                >
                  {PRESET_GROUPS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button className="btn tiny primary" onClick={commit}>
                  保存
                </button>
                <button
                  className="btn tiny"
                  onClick={() => {
                    setSaving(false);
                    setDraft("");
                  }}
                >
                  取消
                </button>
              </div>
            )}
            <div className="preset-groups">
              {groups.map((g) => {
                const def = PRESET_GROUPS.find((d) => d.id === g.group)!;
                const open = isGroupOpen(g.group);
                return (
                  <section className="preset-group" key={g.group}>
                    <header
                      className="preset-group-head"
                      onClick={() => toggleGroup(g.group)}
                      title={def.hint}
                    >
                      <span className={`chev ${open ? "open" : ""}`}>
                        <IconChevron />
                      </span>
                      <b>{def.name}</b>
                      <span className="preset-group-count">
                        {g.items.length}
                      </span>
                    </header>
                    {open && (
                      <div className="preset-grid">
                        {g.items.map((p) =>
                          p.builtin ? (
                            <button
                              key={p.id}
                              className="preset"
                              title={p.hint}
                              onClick={() => onApplyPreset(p)}
                            >
                              <span className="preset-name">{p.name}</span>
                              <span className="preset-hint">{p.hint}</span>
                            </button>
                          ) : (
                            <div
                              key={p.id}
                              className="preset mine"
                              title={p.hint}
                            >
                              <button
                                className="preset-main"
                                onClick={() => onApplyPreset(p)}
                              >
                                <span className="preset-name">{p.name}</span>
                                <span className="preset-hint">
                                  {p.rules.length} 条规则
                                </span>
                              </button>
                              <button
                                className="preset-del"
                                title="删除这个预设"
                                onClick={() => onDeletePreset(p.id)}
                              >
                                <IconX size={11} />
                              </button>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
            {/* 规则链是可以用文件带走的：换机器、给同事、交给命令行跑 */}
            <div className="chain-io">
              <button className="btn tiny" onClick={onImportChain}>
                <IconLayers size={12} />
                导入 .nsq
              </button>
              <button
                className="btn tiny"
                onClick={onExportChain}
                disabled={rules.length === 0}
              >
                <IconSave size={12} />
                导出当前链
              </button>
              <span className="io-hint">也可以把 .nsq 直接拖进窗口</span>
            </div>
            </div>,
            document.body,
          )
        )}
      </div>

      <section className="chain">
        <header className="chain-head">
          <h3>规则链</h3>
          <span className="chain-count">
            {rules.length} 条
            {rules.some((r) => !r.enabled) &&
              ` · ${rules.filter((r) => !r.enabled).length} 条已停用`}
          </span>
          <span className="chain-hint">从上到下依次执行</span>
          {rules.length > 1 && (
            <button className="link-btn" onClick={() => onSetAllOpen(!allOpen)}>
              {allOpen ? "全部折叠" : "全部展开"}
            </button>
          )}
        </header>

        {rules.length === 0 ? (
          <div className="chain-empty">
            <p>规则链是空的</p>
            <p className="hint">
              点上方「添加规则」挑一条，或者打开「预设」一键套用。
            </p>
          </div>
        ) : (
          <div className="rules">
            {rules.map((r, i) => (
              <RuleEditor
                key={r.id}
                rule={r}
                index={i}
                canUp={i > 0}
                canDown={i < rules.length - 1}
                open={openIds.has(r.id)}
                removing={removing.has(r.id)}
                onToggleOpen={() => onToggleOpen(r.id)}
                onChange={onChangeRule}
                onRemove={() => onRemoveRule(r.id)}
                onMove={(d) => onMoveRule(r.id, d)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
