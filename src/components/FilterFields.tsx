import { t } from "../i18n";
import type { Filter } from "../types";

/** 小号数字输入框。空串表示「不限制」，所以值允许为 null。 */
export function Num({
  value,
  onChange,
  placeholder,
  min = 0,
  width = 60,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  min?: number;
  width?: number;
}) {
  return (
    <input
      type="number"
      className="num"
      style={{ width }}
      min={min}
      value={value === null ? "" : value}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(null);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : null);
      }}
    />
  );
}

/**
 * 条件编辑表单。规则自己的条件和分组的整组条件长得完全一样，
 * 共用一份可以免得两边以后改出不同行为。
 */
export default function FilterFields({
  filter,
  onChange,
}: {
  filter: Filter;
  onChange: (p: Partial<Filter>) => void;
}) {
  return (
    <>
      <label className="fld">
        <span>{t("只对扩展名生效（逗号分隔，留空不限）")}</span>
        <input
          className="mono"
          value={filter.exts.join(",")}
          placeholder="jpg,png"
          onChange={(e) =>
            onChange({
              exts: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label className="fld">
        <span>{t("文件名需匹配正则")}</span>
        <input
          className="mono"
          value={filter.nameMatches}
          placeholder="^IMG_"
          onChange={(e) => onChange({ nameMatches: e.target.value })}
        />
      </label>
      <div className="grid2">
        <label className="fld">
          <span>{t("最小字节")}</span>
          <Num value={filter.minSize} onChange={(v) => onChange({ minSize: v })} />
        </label>
        <label className="fld">
          <span>{t("最大字节")}</span>
          <Num value={filter.maxSize} onChange={(v) => onChange({ maxSize: v })} />
        </label>
      </div>
    </>
  );
}
