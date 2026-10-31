import { t } from "./i18n";
import type { Action, CaseMode, Filter, Rule, RuleGroup } from "./types";

export const ACTION_LABELS: Record<Action["kind"], string> = {
  template: "模板",
  replace: "查找替换",
  remove: "删除匹配",
  case: "大小写",
  counter: "序号",
  prefix: "加前缀",
  suffix: "加后缀",
  insert: "插入文本",
  trim: "去首尾字符",
  normalize: "字符清洗",
  date: "插入日期",
  setExt: "改扩展名",
  truncate: "截断",
  chineseNumber: "中文数字",
};

/** 规则库分组：按「用户想做什么」排，而不是按代码里的枚举顺序。 */
export const ACTION_GROUPS: { title: string; kinds: Action["kind"][] }[] = [
  {
    title: "重排与替换",
    kinds: ["template", "replace", "remove"],
  },
  {
    title: "拼接与格式",
    kinds: ["prefix", "suffix", "insert", "setExt", "case"],
  },
  {
    title: "编号与日期",
    kinds: ["counter", "date"],
  },
  {
    title: "清理与截断",
    kinds: ["trim", "normalize", "truncate"],
  },
  {
    title: "中文处理",
    kinds: ["chineseNumber"],
  },
];

export const ACTION_ORDER: Action["kind"][] = ACTION_GROUPS.flatMap(
  (g) => g.kinds,
);

export const CASE_LABELS: Record<CaseMode, string> = {
  lower: "全小写",
  upper: "全大写",
  title: "每词首字母大写",
  sentence: "句首大写",
  camel: "camelCase",
  snake: "snake_case",
  kebab: "kebab-case",
  toggle: "大小写反转",
};

export function emptyFilter(): Filter {
  return {
    exts: [],
    nameMatches: "",
    minSize: null,
    maxSize: null,
    modifiedAfter: null,
    modifiedBefore: null,
  };
}

/** 分组配色。按分组在列表里的次序取色，同一个组在规则卡片和分组条上才会是同一个颜色。 */
const GROUP_HUES = [212, 268, 152, 32, 340, 190, 96, 16, 250, 128];

export function groupHue(id: string, groups: RuleGroup[]): string {
  const i = groups.findIndex((g) => g.id === id);
  const h = GROUP_HUES[(i < 0 ? 0 : i) % GROUP_HUES.length];
  return `hsl(${h} 70% 58%)`;
}

export function filterIsActive(f: Filter): boolean {
  return (
    f.exts.length > 0 ||
    f.nameMatches.trim() !== "" ||
    f.minSize !== null ||
    f.maxSize !== null ||
    f.modifiedAfter !== null ||
    f.modifiedBefore !== null
  );
}

export function defaultAction(kind: Action["kind"]): Action {
  switch (kind) {
    case "template":
      return { kind, template: "{name}-{index:3}" };
    case "replace":
      return { kind, find: "", with: "", regex: false, caseSensitive: true };
    case "remove":
      return { kind, pattern: "", regex: false, caseSensitive: true };
    case "case":
      return { kind, mode: "lower" };
    case "counter":
      return {
        kind,
        start: 1,
        step: 1,
        width: 3,
        at: null,
        perFolder: false,
        base: "decimal",
      };
    case "prefix":
      return { kind, text: "" };
    case "suffix":
      return { kind, text: "" };
    case "insert":
      return { kind, text: "", at: 0 };
    case "trim":
      return { kind, chars: "" };
    case "normalize":
      return {
        kind,
        fullwidth: true,
        diacritics: false,
        emoji: true,
        collapseSpace: true,
      };
    case "date":
      return { kind, source: "modified", format: "%Y%m%d", at: 0 };
    case "setExt":
      return { kind, ext: "jpg" };
    case "truncate":
      return { kind, maxChars: 64, fromEnd: false };
    case "chineseNumber":
      return { kind, mode: "toArabic" };
  }
}

let seq = 0;
export function newRule(kind: Action["kind"]): Rule {
  seq += 1;
  return {
    id: `r${Date.now().toString(36)}${seq}`,
    enabled: true,
    target: "stem",
    filter: emptyFilter(),
    action: defaultAction(kind),
  };
}

/** 摘要里的引号：中文用「」，其它语言各自换成本地习惯的引号。 */
const q = (s: string, n = 18) => {
  const v = s.length > n ? `${s.slice(0, n)}…` : s;
  return t("「{v}」", { v: v || t("空") });
};

/** 折叠状态下的单行摘要——让用户不展开也能读懂这条规则在做什么。 */
export function summarizeRule(a: Action): string {
  switch (a.kind) {
    case "template":
      return q(a.template, 26);
    case "replace":
      return `${q(a.find)} → ${q(a.with)}`;
    case "remove":
      return t("删除 {v}", { v: q(a.pattern) });
    case "case":
      return t("转为{v}", { v: t(CASE_LABELS[a.mode]) });
    case "counter":
      return t("从 {start} 起 · {width} 位 · 步长 {step}", {
        start: a.start,
        width: a.width,
        step: a.step,
      });
    case "prefix":
      return t("前缀 {v}", { v: q(a.text) });
    case "suffix":
      return t("后缀 {v}", { v: q(a.text) });
    case "insert":
      return t("第 {at} 字符处插入 {v}", { at: a.at, v: q(a.text) });
    case "trim":
      return a.chars
        ? t("去掉首尾 {v}", { v: q(a.chars) })
        : t("去掉首尾空白");
    case "normalize": {
      const on: string[] = [];
      if (a.fullwidth) on.push(t("全角→半角"));
      if (a.diacritics) on.push(t("去音标"));
      if (a.emoji) on.push(t("去 emoji"));
      if (a.collapseSpace) on.push(t("合并空格"));
      return on.length ? on.join(" · ") : t("未选择任何处理");
    }
    case "date": {
      const src =
        a.source === "exif"
          ? t("拍摄时间")
          : a.source === "now"
            ? t("当前时间")
            : t("修改时间");
      return t("{fmt}（{src}）", { fmt: a.format, src });
    }
    case "setExt":
      return t("扩展名 → {v}", { v: a.ext || t("（空）") });
    case "truncate":
      return a.fromEnd
        ? t("保留末尾 {n} 字符", { n: a.maxChars })
        : t("保留前 {n} 字符", { n: a.maxChars });
    case "chineseNumber":
      return a.mode === "toChinese"
        ? t("数字 → 中文（第12章 → 第十二章）")
        : t("中文 → 数字（第十二章 → 第12章）");
  }
}

/** 摘要里要额外标出来的开关型属性。 */
export function ruleTags(a: Action): string[] {
  const tags: string[] = [];
  if (
    (a.kind === "replace" || a.kind === "remove") &&
    a.regex
  )
    tags.push(t("正则"));
  if (
    (a.kind === "replace" || a.kind === "remove") &&
    !a.caseSensitive
  )
    tags.push(t("忽略大小写"));
  if (a.kind === "counter" && a.perFolder) tags.push(t("按目录"));
  if (a.kind === "counter" && a.base !== "decimal") tags.push(t("字母"));
  if (a.kind === "truncate" && a.fromEnd) tags.push(t("从尾部"));
  return tags;
}

/* ============================================================
   模板占位符与修饰符
   这里的内容必须和 crates/renamer-core/src/template.rs 保持一致，
   否则界面上点出来的语法会被引擎判成 UnknownModifier。
   ============================================================ */

export interface TokenHint {
  /** 点一下插入的文本 */
  token: string;
  /** 短名字，显示在提示区 */
  label: string;
  /** 作用说明 */
  desc: string;
  /** 结果示例 */
  example: string;
}

export const PLACEHOLDERS: TokenHint[] = [
  {
    token: "{name}",
    label: "当前主名",
    desc: "不含扩展名的文件名。前面规则改过的结果会体现在这里。",
    example: "IMG_0001",
  },
  {
    token: "{ext}",
    label: "扩展名",
    desc: "不带点。勾了「保留原扩展名」时会自动补回去。",
    example: "jpg",
  },
  {
    token: "{dir}",
    label: "目录名",
    desc: "文件所在文件夹的名字，只有最后一级，不是完整路径。",
    example: "2024旅行",
  },
  {
    token: "{index}",
    label: "序号",
    desc: "全局序号，起始值和步长在「执行」里的编号设置中调整。",
    example: "1",
  },
  {
    token: "{index:3}",
    label: "序号补零",
    desc: "同上，冒号后的数字是补零位数，写 3 就是三位。",
    example: "001",
  },
  {
    token: "{total}",
    label: "本批总数",
    desc: "这一批一共要处理多少个文件。",
    example: "48",
  },
  {
    token: "{size}",
    label: "字节数",
    desc: "文件大小，纯数字，单位字节。",
    example: "1258291",
  },
  {
    token: "{sizehr}",
    label: "可读体积",
    desc: "带单位的文件大小，适合放进文件名里看。",
    example: "1.2 MB",
  },
  {
    token: "{date}",
    label: "日期",
    desc: "文件修改时间，默认格式 %Y%m%d。",
    example: "20240101",
  },
  {
    token: "{date:%Y-%m-%d}",
    label: "自定义日期",
    desc: "冒号后写任意时间格式，可以自由组合年月日。",
    example: "2024-01-01",
  },
  {
    token: "{time}",
    label: "时间",
    desc: "文件修改时间里的时分秒，默认格式 %H%M%S。",
    example: "083000",
  },
  {
    token: "{title}",
    label: "标题",
    desc: "音视频标签里的标题。需要先在「文件」里勾上「读取媒体标签」。",
    example: "夜曲",
  },
  {
    token: "{artist}",
    label: "艺术家",
    desc: "音视频标签里的歌手 / 艺术家。没有标签时是空串。",
    example: "周杰伦",
  },
  {
    token: "{album}",
    label: "专辑",
    desc: "音视频标签里的专辑名。",
    example: "十一月的萧邦",
  },
  {
    token: "{track}",
    label: "音轨号",
    desc: "音轨序号，有的文件会带总数（3/12）。",
    example: "3",
  },
  {
    token: "{duration}",
    label: "时长（秒）",
    desc: "音频或视频时长，单位秒。配合 |pad 可以补零。",
    example: "225",
  },
  {
    token: "{duration:clock}",
    label: "时长（分-秒）",
    desc: "时长写成 03-45 这样，用连字符而不是冒号（冒号在文件名里非法）。",
    example: "03-45",
  },
  {
    token: "{width}",
    label: "宽度",
    desc: "视频或图片的像素宽度。",
    example: "1920",
  },
  {
    token: "{height}",
    label: "高度",
    desc: "视频或图片的像素高度。",
    example: "1080",
  },
];

export const MODIFIERS: TokenHint[] = [
  {
    token: "|lower",
    label: "转小写",
    desc: "把前面那段的结果整体转成小写。",
    example: "img_0001",
  },
  {
    token: "|upper",
    label: "转大写",
    desc: "把前面那段的结果整体转成大写。",
    example: "IMG_0001",
  },
  {
    token: "|trim",
    label: "去首尾空白",
    desc: "去掉结果两端的空格，中间的不动。",
    example: "IMG_0001",
  },
  {
    token: "|capitalize",
    label: "首字母大写",
    desc: "只把第一个字符转成大写，其余保持原样。",
    example: "IMG_0001",
  },
  {
    token: "|slug",
    label: "URL 友好",
    desc: "空格转连字符，去掉标点和符号，适合做网址或链接。",
    example: "img-0001",
  },
  {
    token: "|pinyin",
    label: "转拼音",
    desc: "汉字转成无声调拼音（小写），把中文名变成 ASCII，适合做网址或跨平台文件名。",
    example: "zhangwei",
  },
  {
    token: "|pad:3",
    label: "补零",
    desc: "补零到指定位数，对数字类占位符最有用。",
    example: "001",
  },
  {
    token: "|replace:a:b",
    label: "替换",
    desc: "把结果里的 a 换成 b，用冒号分隔，例如 {name|replace:_:-}。",
    example: "IMG-0001",
  },
  {
    token: "|substr:0:8",
    label: "截取",
    desc: "从第 0 个字符起取 8 个，两个数字分别是起点和长度。",
    example: "IMG_0001",
  },
  {
    token: "|default:untitled",
    label: "兜底",
    desc: "前面结果为空时用冒号后的内容代替，避免出现空文件名。",
    example: "未命名",
  },
];

/** 「插入日期」规则里点一下就能用的格式。 */
export const DATE_FORMATS: TokenHint[] = [
  {
    token: "%Y%m%d",
    label: "紧凑日期",
    desc: "年月日连写，最常用。",
    example: "20240101",
  },
  {
    token: "%Y-%m-%d",
    label: "带横线日期",
    desc: "年月日用横线分隔。",
    example: "2024-01-01",
  },
  {
    token: "%Y%m%d_%H%M%S",
    label: "日期 + 时间",
    desc: "精确到秒，适合做唯一性后缀。",
    example: "20240101_083000",
  },
  {
    token: "%Y%m",
    label: "年月",
    desc: "只要年月，适合按月归档。",
    example: "202401",
  },
  {
    token: "%Y年%m月%d日",
    label: "中文日期",
    desc: "带中文单位，读起来更直观。",
    example: "2024年01月01日",
  },
  {
    token: "%H%M%S",
    label: "时间",
    desc: "只要时分秒。",
    example: "083000",
  },
];

