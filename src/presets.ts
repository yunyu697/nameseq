import { newRule } from "./rules";
import type { Action, Rule, Target } from "./types";

export type PresetGroup = "number" | "date" | "clean" | "format" | "structure";

export interface Preset {
  id: string;
  name: string;
  hint: string;
  group: PresetGroup;
  rules: Rule[];
  builtin: boolean;
}

export interface PresetGroupDef {
  id: PresetGroup;
  name: string;
  hint: string;
}

/**
 * 分组按「用户想解决什么问题」划分，而不是按功能罗列。
 * 预设数量会持续增长，平铺成一张网格就找不到想要的那条了。
 */
export const PRESET_GROUPS: PresetGroupDef[] = [
  { id: "number", name: "编号排序", hint: "给一批文件排出顺序" },
  { id: "date", name: "日期时间", hint: "按时间重排、归档" },
  { id: "clean", name: "字符清理", hint: "去掉不该有的字符" },
  { id: "format", name: "格式转换", hint: "大小写与命名风格" },
  { id: "structure", name: "结构调整", hint: "拆分、拼接、重排字段" },
];

function mk(
  kind: Action["kind"],
  patch: Record<string, unknown> = {},
  target: Target = "stem",
): Rule {
  const r = newRule(kind);
  r.action = { ...r.action, ...patch } as Action;
  r.target = target;
  return r;
}

/** 统一的计数器规则，省得每条都写全 7 个字段。 */
function counter(patch: Record<string, unknown> = {}): Rule {
  return mk("counter", {
    start: 1,
    step: 1,
    width: 3,
    at: null,
    perFolder: false,
    base: "decimal",
    ...patch,
  });
}

/**
 * 内置预设。
 *
 * 每条都必须能在引擎里真跑通，所以：
 * - 模板只用 template.rs 里存在的占位符与修饰符
 * - 正则只用 Rust regex 支持的语法（\p{L} 这类 Unicode 类可用）
 * - 动作字段名和 Rust 端的 serde 名一一对应
 *
 * hint 显示在卡片第二行，尽量控制在 12 个字以内，超了会被省略号截掉。
 */
export const BUILTIN_PRESETS: Preset[] = [
  /* ---------------- 编号排序 ---------------- */
  {
    id: "b-seq-suffix",
    name: "原名加序号",
    hint: "IMG_0001-001.jpg",
    group: "number",
    builtin: true,
    rules: [mk("template", { template: "{name}-{index:3}" })],
  },
  {
    id: "b-seq-only",
    name: "纯序号",
    hint: "photo → IMG_0001",
    group: "number",
    builtin: true,
    rules: [mk("template", { template: "IMG_{index:4}" })],
  },
  {
    id: "b-seq-front",
    name: "序号放最前",
    hint: "001_IMG_0001",
    group: "number",
    builtin: true,
    rules: [mk("template", { template: "{index:3}_{name}" })],
  },
  {
    id: "b-date-seq",
    name: "日期加序号",
    hint: "20240101_001.jpg",
    group: "number",
    builtin: true,
    rules: [mk("template", { template: "{date:%Y%m%d}_{index:3}" })],
  },
  {
    id: "b-per-folder",
    name: "每目录单独编号",
    hint: "各自从 001 开始",
    group: "number",
    builtin: true,
    rules: [mk("suffix", { text: "_" }), counter({ perFolder: true })],
  },
  {
    id: "b-alpha",
    name: "字母编号",
    hint: "IMG_0001 → IMG_0001_A",
    group: "number",
    builtin: true,
    rules: [mk("suffix", { text: "_" }), counter({ width: 1, base: "alphaUpper" })],
  },
  {
    id: "b-alpha-lower",
    name: "小写字母编号",
    hint: "第 26 个 → z",
    group: "number",
    builtin: true,
    rules: [mk("suffix", { text: "_" }), counter({ width: 1, base: "alphaLower" })],
  },
  {
    id: "b-start-zero",
    name: "从 0 开始编号",
    hint: "IMG_0001-0.jpg",
    group: "number",
    builtin: true,
    rules: [mk("suffix", { text: "-" }), counter({ start: 0 })],
  },
  {
    id: "b-start-hundred",
    name: "从 100 开始编号",
    hint: "IMG_0001-100.jpg",
    group: "number",
    builtin: true,
    rules: [mk("suffix", { text: "-" }), counter({ start: 100 })],
  },
  {
    id: "b-step-ten",
    name: "步长为 10",
    hint: "1、11、21…",
    group: "number",
    builtin: true,
    rules: [mk("suffix", { text: "-" }), counter({ step: 10 })],
  },
  {
    id: "b-of-total",
    name: "带总数后缀",
    hint: "photo-of-48.jpg",
    group: "number",
    builtin: true,
    rules: [mk("template", { template: "{name}-of-{total}" })],
  },

  /* ---------------- 日期时间 ---------------- */
  {
    id: "b-date-name",
    name: "日期加原名",
    hint: "20240101_IMG_0001",
    group: "date",
    builtin: true,
    rules: [mk("template", { template: "{date:%Y%m%d}_{name}" })],
  },
  {
    id: "b-date-name-seq",
    name: "日期加原名加序号",
    hint: "20240101_IMG_0001_001",
    group: "date",
    builtin: true,
    rules: [mk("template", { template: "{date:%Y%m%d}_{name}_{index:3}" })],
  },
  {
    id: "b-year-month",
    name: "按年月分组",
    hint: "202401_IMG_0001",
    group: "date",
    builtin: true,
    rules: [mk("template", { template: "{date:%Y%m}_{name}" })],
  },
  {
    id: "b-second",
    name: "精确到秒",
    hint: "20240101_083000_xxx",
    group: "date",
    builtin: true,
    rules: [mk("template", { template: "{date:%Y%m%d_%H%M%S}_{name}" })],
  },
  {
    id: "b-chinese-date",
    name: "中文日期",
    hint: "2024年01月01日_xxx",
    group: "date",
    builtin: true,
    rules: [mk("template", { template: "{date:%Y年%m月%d日}_{name}" })],
  },
  {
    id: "b-exif-seq",
    name: "按拍摄日期",
    hint: "读 EXIF，20240101_001",
    group: "date",
    builtin: true,
    rules: [
      mk("date", { source: "exif", format: "%Y%m%d", at: 0 }),
      mk("suffix", { text: "_" }),
      counter(),
    ],
  },
  {
    id: "b-modified-head",
    name: "修改时间打头",
    hint: "按文件修改时间前缀",
    group: "date",
    builtin: true,
    rules: [mk("date", { source: "modified", format: "%Y%m%d", at: 0 })],
  },
  {
    id: "b-now-head",
    name: "当前日期打头",
    hint: "全部标成今天",
    group: "date",
    builtin: true,
    rules: [mk("date", { source: "now", format: "%Y%m%d", at: 0 })],
  },

  /* ---------------- 字符清理 ---------------- */
  {
    id: "b-clean-illegal",
    name: "清理非法字符",
    hint: "Windows 不允许的字符",
    group: "clean",
    builtin: true,
    rules: [
      mk("remove", {
        pattern: '[<>:"/\\\\|?*]',
        regex: true,
        caseSensitive: true,
      }),
    ],
  },
  {
    id: "b-clean-all",
    name: "清理文件名",
    hint: "全角 · emoji · 多空格",
    group: "clean",
    builtin: true,
    rules: [
      mk("normalize", {
        fullwidth: true,
        diacritics: false,
        emoji: true,
        collapseSpace: true,
      }),
      mk("trim", { chars: "" }),
    ],
  },
  {
    id: "b-strip-prefix",
    name: "去相机前缀",
    hint: "IMG_0001 → 0001",
    group: "clean",
    builtin: true,
    rules: [mk("remove", { pattern: "IMG_", regex: false, caseSensitive: true })],
  },
  {
    id: "b-strip-paren",
    name: "去括号内容",
    hint: "照片(1) → 照片",
    group: "clean",
    builtin: true,
    rules: [
      mk("remove", { pattern: "\\([^)]*\\)", regex: true, caseSensitive: true }),
    ],
  },
  {
    id: "b-strip-copy",
    name: "去「副本」",
    hint: "报告 - 副本 → 报告",
    group: "clean",
    builtin: true,
    rules: [
      mk("remove", { pattern: " ?-? ?副本", regex: true, caseSensitive: true }),
    ],
  },
  {
    id: "b-truncate",
    name: "截断长名",
    hint: "只留前 64 个字符",
    group: "clean",
    builtin: true,
    rules: [mk("truncate", { maxChars: 64, fromEnd: false })],
  },
  {
    id: "b-trim-space",
    name: "去首尾空白",
    hint: " abc → abc",
    group: "clean",
    builtin: true,
    rules: [mk("trim", { chars: "" })],
  },
  {
    id: "b-trim-underscore",
    name: "去首尾下划线",
    hint: "__abc__ → abc",
    group: "clean",
    builtin: true,
    rules: [mk("trim", { chars: "_" })],
  },
  {
    id: "b-no-emoji",
    name: "去掉 emoji",
    hint: "🎉abc → abc",
    group: "clean",
    builtin: true,
    rules: [
      mk("normalize", {
        fullwidth: false,
        diacritics: false,
        emoji: true,
        collapseSpace: false,
      }),
    ],
  },
  {
    id: "b-halfwidth",
    name: "全角转半角",
    hint: "ＡＢＣ → ABC",
    group: "clean",
    builtin: true,
    rules: [
      mk("normalize", {
        fullwidth: true,
        diacritics: false,
        emoji: false,
        collapseSpace: false,
      }),
    ],
  },
  {
    id: "b-no-diacritics",
    name: "去重音符号",
    hint: "Café → Cafe",
    group: "clean",
    builtin: true,
    rules: [
      mk("normalize", {
        fullwidth: false,
        diacritics: true,
        emoji: false,
        collapseSpace: false,
      }),
    ],
  },
  {
    id: "b-merge-space",
    name: "合并连续空格",
    hint: "a   b → a b",
    group: "clean",
    builtin: true,
    rules: [
      mk("normalize", {
        fullwidth: false,
        diacritics: false,
        emoji: false,
        collapseSpace: true,
      }),
    ],
  },
  {
    id: "b-no-space",
    name: "去掉所有空格",
    hint: "a b → ab",
    group: "clean",
    builtin: true,
    rules: [
      mk("replace", { find: " ", with: "", regex: false, caseSensitive: true }),
    ],
  },

  /* ---------------- 格式转换 ---------------- */
  {
    id: "b-lower",
    name: "统一小写",
    hint: "IMG_0001 → img_0001",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "lower" })],
  },
  {
    id: "b-upper",
    name: "统一大写",
    hint: "img_0001 → IMG_0001",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "upper" })],
  },
  {
    id: "b-title",
    name: "每词首字母大写",
    hint: "my photo → My Photo",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "title" })],
  },
  {
    id: "b-sentence",
    name: "句首大写",
    hint: "my photo → My photo",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "sentence" })],
  },
  {
    id: "b-camel",
    name: "camelCase",
    hint: "my photo → myPhoto",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "camel" })],
  },
  {
    id: "b-snake-case",
    name: "snake_case",
    hint: "My Photo → my_photo",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "snake" })],
  },
  {
    id: "b-kebab",
    name: "kebab-case",
    hint: "My Photo → my-photo",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "kebab" })],
  },
  {
    id: "b-toggle",
    name: "大小写反转",
    hint: "iMG → Img",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "toggle" })],
  },
  {
    id: "b-snake",
    name: "空格转下划线",
    hint: "my photo → my_photo",
    group: "format",
    builtin: true,
    rules: [
      mk("replace", { find: " ", with: "_", regex: false, caseSensitive: true }),
    ],
  },
  {
    id: "b-space-dash",
    name: "空格转连字符",
    hint: "my photo → my-photo",
    group: "format",
    builtin: true,
    rules: [
      mk("replace", { find: " ", with: "-", regex: false, caseSensitive: true }),
    ],
  },
  {
    id: "b-slug",
    name: "URL 安全名",
    hint: "My Photo → my-photo",
    group: "format",
    builtin: true,
    rules: [mk("template", { template: "{name|slug}" })],
  },
  {
    id: "b-ext-lower",
    name: "扩展名小写",
    hint: "IMG.JPG → IMG.jpg",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "lower" }, "ext")],
  },
  {
    id: "b-ext-upper",
    name: "扩展名大写",
    hint: "IMG.jpg → IMG.JPG",
    group: "format",
    builtin: true,
    rules: [mk("case", { mode: "upper" }, "ext")],
  },
  {
    id: "b-alnum-only",
    name: "只留字母数字",
    hint: "a-b_c → abc",
    group: "format",
    builtin: true,
    rules: [
      mk("replace", {
        find: "[^\\p{L}\\p{N}]",
        with: "",
        regex: true,
        caseSensitive: true,
      }),
    ],
  },

  /* ---------------- 结构调整 ---------------- */
  {
    id: "b-keep-ext",
    name: "模板里带上扩展名",
    hint: "{name}.{ext}",
    group: "structure",
    builtin: true,
    rules: [mk("template", { template: "{name}.{ext}" })],
  },
  {
    id: "b-dir-name",
    name: "目录名加原名",
    hint: "旅行_IMG_0001",
    group: "structure",
    builtin: true,
    rules: [mk("template", { template: "{dir}_{name}" })],
  },
  {
    id: "b-dir-seq",
    name: "目录名加序号",
    hint: "旅行_001",
    group: "structure",
    builtin: true,
    rules: [mk("template", { template: "{dir}_{index:3}" })],
  },
  {
    id: "b-regex-swap",
    name: "正则重排",
    hint: "2024-trip → trip_2024",
    group: "structure",
    builtin: true,
    rules: [
      mk("replace", {
        find: "^([0-9]+)-(.+)$",
        with: "${2}_${1}",
        regex: true,
        caseSensitive: true,
      }),
    ],
  },
  {
    id: "b-strip-tail-num",
    name: "去掉尾部序号",
    hint: "abc_001 → abc",
    group: "structure",
    builtin: true,
    rules: [
      mk("remove", { pattern: "[-_]\\d+$", regex: true, caseSensitive: true }),
    ],
  },
  {
    id: "b-strip-head-date",
    name: "去掉开头日期",
    hint: "20240101_abc → abc",
    group: "structure",
    builtin: true,
    rules: [
      mk("remove", { pattern: "^\\d{8}[-_]", regex: true, caseSensitive: true }),
    ],
  },
  {
    id: "b-merge-dash",
    name: "合并连续连字符",
    hint: "a--b → a-b",
    group: "structure",
    builtin: true,
    rules: [
      mk("replace", { find: "-{2,}", with: "-", regex: true, caseSensitive: true }),
    ],
  },
  {
    id: "b-merge-underscore",
    name: "合并连续下划线",
    hint: "a__b → a_b",
    group: "structure",
    builtin: true,
    rules: [
      mk("replace", { find: "_{2,}", with: "_", regex: true, caseSensitive: true }),
    ],
  },
];

const KEY = "renamesmith.presets.v1";

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Preset[];
    if (!Array.isArray(list)) return [];
    // 老版本存的用户预设没有 group 字段，补一个默认分组，
    // 否则分组统计会算出 NaN，界面直接崩。
    return list.map((p) => ({
      ...p,
      group: p.group ?? ("structure" as PresetGroup),
    }));
  } catch {
    return [];
  }
}

export function savePresets(list: Preset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 忽略 */
  }
}

/**
 * 深拷贝规则并重新分配 id。
 * 预设被反复套用，如果沿用原 id，React 的 key 会重复，
 * 编辑一条会连带改到另一条。
 */
export function cloneRules(rules: Rule[]): Rule[] {
  return rules.map((r) => {
    const fresh = newRule(r.action.kind);
    return {
      ...fresh,
      enabled: r.enabled,
      target: r.target,
      filter: { ...r.filter, exts: [...r.filter.exts] },
      action: { ...r.action },
    };
  });
}

/** 按分组归拢，顺带统计每组数量。 */
export function groupPresets(
  builtins: Preset[],
  mine: Preset[],
): { group: PresetGroup; items: Preset[] }[] {
  return PRESET_GROUPS.map((g) => ({
    group: g.id,
    items: [
      ...builtins.filter((p) => p.group === g.id),
      ...mine.filter((p) => p.group === g.id),
    ],
  })).filter((g) => g.items.length > 0);
}
