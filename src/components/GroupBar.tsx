import { useState } from "react";
import { t } from "../i18n";
import { filterIsActive, groupHue } from "../rules";
import type { Rule, RuleGroup } from "../types";
import FilterFields from "./FilterFields";
import { IconFilter, IconLayers, IconPlus, IconX } from "./Icons";

interface Props {
  groups: RuleGroup[];
  rules: Rule[];
  onChange: (g: RuleGroup) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

/**
 * 分组管理条。规则链本身是平铺的，分组只是在规则上贴了个标签，
 * 所以这里不去重排规则版面——它只负责「整组停用」和「整组加条件」两件事。
 */
export default function GroupBar({
  groups,
  rules,
  onChange,
  onRemove,
  onAdd,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  const count = (id: string) => rules.filter((r) => r.group === id).length;
  const disabled = groups.filter((g) => !g.enabled).length;

  return (
    <section className="group-bar">
      <header className="group-bar-head">
        <IconLayers size={13} />
        <b>{t("分组")}</b>
        <span className="group-bar-hint">{t("整组停用、整组限定条件；规则的上下顺序不变")}</span>
        <span className="grow" />
        {disabled > 0 && (
          <span className="group-stat off">{t("{n} 组已停用", { n: disabled })}</span>
        )}
        <span className="group-stat">{t("{n} 组", { n: groups.length })}</span>
        <button className="link-btn" onClick={onAdd}>
          <IconPlus size={12} />
          {t("新建分组")}
        </button>
      </header>

      {groups.length === 0 ? (
        <p className="group-empty">{t("还没有分组。规则攒多了之后，把处理同一类文件的几条打包成一组， 就能一次全部关掉、或者限定它们只作用在照片上。")}</p>
      ) : (
        <div className="group-chips">
          {groups.map((g) => {
            const n = count(g.id);
            const open = openId === g.id;
            const fOn = filterIsActive(g.filter);
            return (
              <div
                key={g.id}
                className={`group-chip ${g.enabled ? "" : "off"} ${
                  open ? "is-open" : ""
                }`}
                style={{ ["--gc" as string]: groupHue(g.id, groups) }}
              >
                <div className="group-chip-main">
                  <label className="chk" title={t("整组启用 / 停用")}>
                    <input
                      type="checkbox"
                      checked={g.enabled}
                      onChange={(e) =>
                        onChange({ ...g, enabled: e.target.checked })
                      }
                    />
                  </label>
                  <i className="dot" />
                  <input
                    className="group-name"
                    value={g.name}
                    spellCheck={false}
                    placeholder={t("分组名")}
                    aria-label={t("分组名")}
                    onChange={(e) => onChange({ ...g, name: e.target.value })}
                  />
                  <span className="group-count" title={t("组内规则条数")}>
                    {t("{n} 条", { n })}
                  </span>
                  <button
                    className={`pill-btn sm ${fOn ? "on" : ""}`}
                    title={t("给整组加条件：不满足条件的文件，组内规则全部跳过")}
                    onClick={() => setOpenId(open ? null : g.id)}
                  >
                    <IconFilter size={12} />
                    {fOn ? t("条件 · 已设") : t("条件")}
                  </button>
                  <button
                    className="icon-btn sm danger"
                    title={t("删除分组（组内规则保留，只是回到不分组）")}
                    onClick={() => onRemove(g.id)}
                  >
                    <IconX size={12} />
                  </button>
                </div>

                {open && (
                  <div className="group-chip-body">
                    <p className="tip">{t("这一组里的规则只会对满足条件的文件生效；删掉分组不会删规则。")}</p>
                    <FilterFields
                      filter={g.filter}
                      onChange={(p) =>
                        onChange({ ...g, filter: { ...g.filter, ...p } })
                      }
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
