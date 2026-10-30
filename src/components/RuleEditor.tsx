import { useRef, useState } from "react";
import {
  ACTION_LABELS,
  CASE_LABELS,
  DATE_FORMATS,
  MODIFIERS,
  PLACEHOLDERS,
  filterIsActive,
  groupHue,
  ruleTags,
  summarizeRule,
  type TokenHint,
} from "../rules";
import type {
  Action,
  CaseMode,
  ChineseNumberMode,
  CounterBase,
  DateSource,
  Filter,
  Rule,
  RuleGroup,
  Target,
} from "../types";
import { Num } from "./FilterFields";
import FilterFields from "./FilterFields";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevron,
  IconFilter,
  IconTrash,
} from "./Icons";

/** 悬停/聚焦时更新说明的标签组。 */
function TokenRow({
  label,
  tokens,
  onHover,
  onPick,
}: {
  label: string;
  tokens: TokenHint[];
  onHover: (t: TokenHint) => void;
  onPick: (t: TokenHint) => void;
}) {
  return (
    <div className="tok-row">
      <span className="tok-label">{label}</span>
      <div className="tok-items">
        {tokens.map((t) => (
          <button
            key={t.token}
            type="button"
            className="tok"
            onMouseEnter={() => onHover(t)}
            onFocus={() => onHover(t)}
            onClick={() => onPick(t)}
            title={`${t.label} · ${t.desc}`}
          >
            {t.token}
          </button>
        ))}
      </div>
    </div>
  );
}

function HintBar({ hint }: { hint: TokenHint | null }) {
  return (
    <div className={`tok-hint ${hint ? "has" : ""}`}>
      {hint ? (
        <>
          <code>{hint.token}</code>
          <b>{hint.label}</b>
          <span className="tok-desc">{hint.desc}</span>
          <em>
            例 <i>{hint.example}</i>
          </em>
        </>
      ) : (
        <span className="tok-desc dim">
          把鼠标移到上面的标签上可以看它做什么，点一下会插到光标位置。
        </span>
      )}
    </div>
  );
}

interface Props {
  rule: Rule;
  index: number;
  canUp: boolean;
  canDown: boolean;
  open: boolean;
  removing?: boolean;
  /** 全部分组，用来把 group id 换成能看的名字 */
  groups: RuleGroup[];
  onToggleOpen: () => void;
  onChange: (r: Rule) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onSetGroup: (ruleId: string, groupId: string | null) => void;
  onCreateGroup: (ruleId: string) => void;
}

export default function RuleEditor({
  rule,
  index,
  canUp,
  canDown,
  open,
  removing,
  groups,
  onToggleOpen,
  onChange,
  onRemove,
  onMove,
  onSetGroup,
  onCreateGroup,
}: Props) {
  const a = rule.action;
  const [showFilter, setShowFilter] = useState(false);
  const [hint, setHint] = useState<TokenHint | null>(null);
  const filterOn = filterIsActive(rule.filter);
  // 组可能已经被删了：按「查得到才算有组」处理，和 Rust 侧一致
  const myGroup = groups.find((g) => g.id === rule.group) ?? null;
  const groupOff = myGroup ? !myGroup.enabled : false;

  const tplRef = useRef<HTMLInputElement>(null);
  const fmtRef = useRef<HTMLInputElement>(null);

  const patch = (p: Record<string, unknown>) =>
    onChange({ ...rule, action: { ...a, ...p } as Action });
  const setFilter = (p: Partial<Filter>) =>
    onChange({ ...rule, filter: { ...rule.filter, ...p } });

  /** 把文本插到光标处，插完把光标放到插入内容之后，方便接着点下一个。 */
  const insertAtCursor = (
    el: HTMLInputElement | null,
    current: string,
    text: string,
  ) => {
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const next = current.slice(0, start) + text + current.slice(end);
    const caret = start + text.length;
    return { next, caret };
  };

  const restore = (el: HTMLInputElement | null, caret: number) => {
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const pickPlaceholder = (t: TokenHint) => {
    const el = tplRef.current;
    const cur = a.kind === "template" ? a.template : "";
    const { next, caret } = insertAtCursor(el, cur, t.token);
    patch({ template: next });
    restore(el, caret);
  };

  /**
   * 修饰符要落在花括号里才有意义。
   * 光标紧跟在 } 后面时插到它前面，正好修饰刚点过的占位符；
   * 否则补一个 {name|xxx} 出来，避免用户点出 `|lower` 这种纯文本。
   */
  const pickModifier = (t: TokenHint) => {
    const el = tplRef.current;
    const cur = a.kind === "template" ? a.template : "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? start;
    const before = cur.slice(0, start);
    let next: string;
    let caret: number;

    if (start === end && before.endsWith("}")) {
      next = cur.slice(0, start - 1) + t.token + cur.slice(start - 1);
      caret = start + t.token.length;
    } else {
      const chunk = `{name${t.token}}`;
      next = cur.slice(0, start) + chunk + cur.slice(end);
      caret = start + chunk.length;
    }
    patch({ template: next });
    restore(el, caret);
  };

  const pickFormat = (t: TokenHint) => {
    patch({ format: t.token });
    restore(fmtRef.current, t.token.length);
  };

  const tags = ruleTags(a);

  const fields = (() => {
    switch (a.kind) {
      case "template":
        return (
          <>
            <label className="fld">
              <span>模板</span>
              <input
                ref={tplRef}
                className="mono"
                value={a.template}
                spellCheck={false}
                onChange={(e) => patch({ template: e.target.value })}
                placeholder="{name}-{index:3}"
              />
            </label>
            <div className="tok-block">
              <TokenRow
                label="占位符"
                tokens={PLACEHOLDERS}
                onHover={setHint}
                onPick={pickPlaceholder}
              />
              <TokenRow
                label="修饰符"
                tokens={MODIFIERS}
                onHover={setHint}
                onPick={pickModifier}
              />
              <HintBar hint={hint} />
            </div>
          </>
        );

      case "replace":
        return (
          <>
            <div className="grid2">
              <label className="fld">
                <span>查找</span>
                <input
                  className="mono"
                  value={a.find}
                  spellCheck={false}
                  onChange={(e) => patch({ find: e.target.value })}
                />
              </label>
              <label className="fld">
                <span>替换为</span>
                <input
                  className="mono"
                  value={a.with}
                  spellCheck={false}
                  onChange={(e) => patch({ with: e.target.value })}
                />
              </label>
            </div>
            <div className="checks">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={a.regex}
                  onChange={(e) => patch({ regex: e.target.checked })}
                />
                正则表达式
              </label>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={a.caseSensitive}
                  onChange={(e) => patch({ caseSensitive: e.target.checked })}
                />
                区分大小写
              </label>
            </div>
            {a.regex && (
              <p className="tip warn">
                捕获组请写 {"${1}"} 形式。写成 <code>$1_</code> 会被当成组名{" "}
                <code>$1_</code>，静默变成空字符串。
              </p>
            )}
          </>
        );

      case "remove":
        return (
          <>
            <label className="fld">
              <span>要删除的内容</span>
              <input
                className="mono"
                value={a.pattern}
                spellCheck={false}
                onChange={(e) => patch({ pattern: e.target.value })}
              />
            </label>
            <div className="checks">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={a.regex}
                  onChange={(e) => patch({ regex: e.target.checked })}
                />
                正则表达式
              </label>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={a.caseSensitive}
                  onChange={(e) => patch({ caseSensitive: e.target.checked })}
                />
                区分大小写
              </label>
            </div>
          </>
        );

      case "case":
        return (
          <label className="fld">
            <span>转换方式</span>
            <select
              value={a.mode}
              onChange={(e) => patch({ mode: e.target.value as CaseMode })}
            >
              {(Object.keys(CASE_LABELS) as CaseMode[]).map((m) => (
                <option key={m} value={m}>
                  {CASE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        );

      case "counter":
        return (
          <>
            <div className="grid3">
              <label className="fld">
                <span>起始值</span>
                <Num
                  value={a.start}
                  min={0}
                  onChange={(v) => patch({ start: v ?? 1 })}
                />
              </label>
              <label className="fld">
                <span>步长</span>
                <Num
                  value={a.step}
                  min={1}
                  onChange={(v) => patch({ step: v ?? 1 })}
                />
              </label>
              <label className="fld">
                <span>位数</span>
                <Num
                  value={a.width}
                  min={1}
                  onChange={(v) => patch({ width: v ?? 1 })}
                />
              </label>
            </div>
            <div className="grid2">
              <label className="fld">
                <span>编号形式</span>
                <select
                  value={a.base}
                  onChange={(e) =>
                    patch({ base: e.target.value as CounterBase })
                  }
                >
                  <option value="decimal">数字 1 2 3</option>
                  <option value="alphaUpper">字母 A B C</option>
                  <option value="alphaLower">字母 a b c</option>
                </select>
              </label>
              <label className="fld">
                <span>插入位置</span>
                <Num
                  value={a.at}
                  placeholder="末尾"
                  width={80}
                  onChange={(v) => patch({ at: v })}
                />
              </label>
            </div>
            <label className="chk">
              <input
                type="checkbox"
                checked={a.perFolder}
                onChange={(e) => patch({ perFolder: e.target.checked })}
              />
              每个目录重新从起始值计数
            </label>
          </>
        );

      case "prefix":
      case "suffix":
        return (
          <label className="fld">
            <span>{a.kind === "prefix" ? "前缀内容" : "后缀内容"}</span>
            <input
              className="mono"
              value={a.text}
              onChange={(e) => patch({ text: e.target.value })}
              placeholder={a.kind === "prefix" ? "放在最前面" : "追加到最后"}
            />
          </label>
        );

      case "insert":
        return (
          <div className="grid2">
            <label className="fld">
              <span>文本</span>
              <input
                className="mono"
                value={a.text}
                onChange={(e) => patch({ text: e.target.value })}
              />
            </label>
            <label className="fld">
              <span>第几个字符后</span>
              <Num
                value={a.at}
                min={0}
                onChange={(v) => patch({ at: v ?? 0 })}
              />
            </label>
          </div>
        );

      case "trim":
        return (
          <label className="fld">
            <span>要去掉的字符</span>
            <input
              className="mono"
              value={a.chars}
              onChange={(e) => patch({ chars: e.target.value })}
              placeholder="留空 = 去掉首尾空白"
            />
          </label>
        );

      case "normalize":
        return (
          <div className="checks wrap">
            <label className="chk">
              <input
                type="checkbox"
                checked={a.fullwidth}
                onChange={(e) => patch({ fullwidth: e.target.checked })}
              />
              全角转半角
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={a.diacritics}
                onChange={(e) => patch({ diacritics: e.target.checked })}
              />
              去音标 é→e
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={a.emoji}
                onChange={(e) => patch({ emoji: e.target.checked })}
              />
              去 emoji
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={a.collapseSpace}
                onChange={(e) => patch({ collapseSpace: e.target.checked })}
              />
              合并连续空格
            </label>
          </div>
        );

      case "date":
        return (
          <>
            <div className="grid2">
              <label className="fld">
                <span>时间来源</span>
                <select
                  value={a.source}
                  onChange={(e) =>
                    patch({ source: e.target.value as DateSource })
                  }
                >
                  <option value="modified">文件修改时间</option>
                  <option value="exif">照片拍摄时间 (EXIF)</option>
                  <option value="now">当前时间</option>
                </select>
              </label>
              <label className="fld">
                <span>插入位置</span>
                <Num
                  value={a.at}
                  placeholder="末尾"
                  width={80}
                  onChange={(v) => patch({ at: v })}
                />
              </label>
            </div>
            <label className="fld">
              <span>时间格式</span>
              <input
                ref={fmtRef}
                className="mono"
                value={a.format}
                spellCheck={false}
                onChange={(e) => patch({ format: e.target.value })}
              />
            </label>
            <div className="tok-block">
              <TokenRow
                label="常用格式"
                tokens={DATE_FORMATS}
                onHover={setHint}
                onPick={pickFormat}
              />
              <HintBar hint={hint} />
            </div>
          </>
        );

      case "setExt":
        return (
          <label className="fld short">
            <span>新扩展名（不写点）</span>
            <input
              className="mono"
              value={a.ext}
              onChange={(e) => patch({ ext: e.target.value })}
            />
          </label>
        );

      case "truncate":
        return (
          <div className="grid2">
            <label className="fld">
              <span>保留字符数</span>
              <Num
                value={a.maxChars}
                min={1}
                onChange={(v) => patch({ maxChars: v ?? 64 })}
              />
            </label>
            <label className="chk self-end">
              <input
                type="checkbox"
                checked={a.fromEnd}
                onChange={(e) => patch({ fromEnd: e.target.checked })}
              />
              从末尾开始截取
            </label>
          </div>
        );

      case "chineseNumber":
        return (
          <label className="fld">
            <span>转换方向</span>
            <select
              value={a.mode}
              onChange={(e) =>
                patch({ mode: e.target.value as ChineseNumberMode })
              }
            >
              <option value="toArabic">中文 → 数字（第十二章 → 第12章）</option>
              <option value="toChinese">数字 → 中文（第12章 → 第十二章）</option>
            </select>
          </label>
        );
    }
  })();

  return (
    <div
      className={`rule ${rule.enabled ? "" : "is-off"} ${open ? "is-open" : ""} ${
        removing ? "removing" : ""
      }`}
    >
      <div className="rule-head" onClick={onToggleOpen}>
        <label className="chk" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={rule.enabled}
            title="启用 / 停用这条规则"
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          />
        </label>

        <span className="rule-idx">{index + 1}</span>

        {myGroup && (
          <span
            className={`group-dot-tag ${groupOff ? "off" : ""}`}
            style={{ ["--gc" as string]: groupHue(myGroup.id, groups) }}
            title={
              groupOff
                ? `分组「${myGroup.name}」已停用，这条规则不会生效`
                : `属于分组「${myGroup.name}」`
            }
          >
            <i className="dot" />
            {myGroup.name}
            {groupOff && <em>已停用</em>}
          </span>
        )}

        <span className="rule-kind">{ACTION_LABELS[a.kind]}</span>

        <span className="rule-sum" title={summarizeRule(a)}>
          {summarizeRule(a)}
          {tags.map((t) => (
            <em key={t} className="tag">
              {t}
            </em>
          ))}
        </span>

        <div className="rule-tools" onClick={(e) => e.stopPropagation()}>
          <button
            className="icon-btn sm"
            disabled={!canUp}
            title="上移"
            onClick={() => onMove(-1)}
          >
            <IconArrowUp />
          </button>
          <button
            className="icon-btn sm"
            disabled={!canDown}
            title="下移"
            onClick={() => onMove(1)}
          >
            <IconArrowDown />
          </button>
          <button
            className="icon-btn sm danger"
            title="删除这条规则"
            onClick={onRemove}
          >
            <IconTrash />
          </button>
          <span className={`chev ${open ? "open" : ""}`}>
            <IconChevron />
          </span>
        </div>
      </div>

      <div className={`collapsible ${open ? "" : "closed"}`}>
        <div>
          <div className="rule-body">
            {fields}

            <div className="rule-foot">
              <label className="fld inline-short">
                <span>作用于</span>
                <select
                  value={a.kind === "setExt" ? "ext" : rule.target}
                  disabled={a.kind === "setExt"}
                  onChange={(e) =>
                    onChange({ ...rule, target: e.target.value as Target })
                  }
                >
                  <option value="stem">主名</option>
                  <option value="ext">扩展名</option>
                </select>
              </label>
              <button
                className={`pill-btn ${filterOn ? "on" : ""}`}
                onClick={() => setShowFilter((v) => !v)}
              >
                <IconFilter />
                条件{filterOn ? " · 已设" : ""}
              </button>
              <label className="fld inline-short group-pick">
                <span>分组</span>
                <select
                  value={rule.group ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__new") onCreateGroup(rule.id);
                    else onSetGroup(rule.id, v === "" ? null : v);
                  }}
                >
                  <option value="">不分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                  <option value="__new">+ 新建分组…</option>
                </select>
              </label>
            </div>

            {showFilter && (
              <div className="rule-filter">
                <FilterFields filter={rule.filter} onChange={setFilter} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
