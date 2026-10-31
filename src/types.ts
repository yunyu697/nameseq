import { t } from "./i18n";

export type OpStatus =
  | "ok"
  | "unchanged"
  | "conflict"
  | "invalid"
  | "missing"
  | "excluded";

export type SortBy =
  | "original"
  | "name"
  | "pinyin"
  | "modified"
  | "size"
  | "ext"
  | "folder";
export type Target = "stem" | "ext";
export type CaseMode =
  | "upper"
  | "lower"
  | "title"
  | "sentence"
  | "camel"
  | "snake"
  | "kebab"
  | "toggle";
export type DateSource = "modified" | "now" | "exif";
export type CounterBase = "decimal" | "alphaUpper" | "alphaLower";
export type ConflictPolicy = "skip" | "suffix";

export interface MediaMeta {
  title: string;
  artist: string;
  album: string;
  track: string;
  durationMs: number;
  width: number;
  height: number;
}

export interface FileEntry {
  id: number;
  path: string;
  dir: string;
  stem: string;
  ext: string;
  name: string;
  size: number;
  modifiedMs: number;
  isDir: boolean;
  error: string | null;
  /** 只有开启「读取媒体标签」时才有 */
  media?: MediaMeta;
}

export interface Filter {
  exts: string[];
  nameMatches: string;
  minSize: number | null;
  maxSize: number | null;
  modifiedAfter: number | null;
  modifiedBefore: number | null;
}

export type Action =
  | { kind: "template"; template: string }
  | {
      kind: "replace";
      find: string;
      with: string;
      regex: boolean;
      caseSensitive: boolean;
    }
  | { kind: "remove"; pattern: string; regex: boolean; caseSensitive: boolean }
  | { kind: "case"; mode: CaseMode }
  | {
      kind: "counter";
      start: number;
      step: number;
      width: number;
      at: number | null;
      perFolder: boolean;
      base: CounterBase;
    }
  | { kind: "prefix"; text: string }
  | { kind: "suffix"; text: string }
  | { kind: "insert"; text: string; at: number }
  | { kind: "trim"; chars: string }
  | {
      kind: "normalize";
      fullwidth: boolean;
      diacritics: boolean;
      emoji: boolean;
      collapseSpace: boolean;
    }
  | { kind: "date"; source: DateSource; format: string; at: number | null }
  | { kind: "setExt"; ext: string }
  | { kind: "truncate"; maxChars: number; fromEnd: boolean }
  | { kind: "chineseNumber"; mode: ChineseNumberMode };

export type ChineseNumberMode = "toArabic" | "toChinese";

export interface Rule {
  id: string;
  enabled: boolean;
  target: Target;
  filter: Filter;
  /** 所属分组 id；undefined/null = 不分组 */
  group?: string | null;
  action: Action;
}

/** 规则分组：整组停用、整组加条件 */
export interface RuleGroup {
  id: string;
  name: string;
  enabled: boolean;
  filter: Filter;
}

export interface RenameConfig {
  rules: Rule[];
  keepExt: boolean;
  sortBy: SortBy;
  /** 次级排序键：主键相同的条目再按它细分；null = 不用 */
  sortBy2: SortBy | null;
  descending: boolean;
  naturalSort: boolean;
  startIndex: number;
  indexStep: number;
  /** {index} 无显式格式时的零补位数（0/1 = 不补；模板里写 {index:03} 则优先） */
  indexWidth: number;
  /** {index} 按文件夹重新计数 */
  indexPerFolder: boolean;
  conflict: ConflictPolicy;
  groups: RuleGroup[];
  excluded: number[];
}

export interface RenameOp {
  id: number;
  from: string;
  to: string;
  oldName: string;
  newName: string;
  status: OpStatus;
  reason: string | null;
  isDir?: boolean;
  size: number;
  modifiedMs: number;
}

export interface Plan {
  ops: RenameOp[];
  total: number;
  executable: number;
  conflicts: number;
  invalid: number;
  unchanged: number;
  excluded: number;
}

/** .nsq 规则链文件（可保存、共享、被 CLI 复用） */
export interface ChainFile {
  version: number;
  name: string;
  note: string;
  config: RenameConfig;
}

/** 失败原因分类。数值语义由 Rust 侧决定，这里只用来做文案与图标分组 */
export type FailKind =
  | "occupied"
  | "permission"
  | "missing"
  | "exists"
  | "drifted"
  | "nameTooLong"
  | "other";

export const FAIL_LABEL: Record<FailKind, string> = {
  get occupied() {
    return t("被占用");
  },
  get permission() {
    return t("没权限");
  },
  get missing() {
    return t("源已不在");
  },
  get exists() {
    return t("目标被占");
  },
  get drifted() {
    return t("文件被改过");
  },
  get nameTooLong() {
    return t("名字太长");
  },
  get other() {
    return t("其它");
  },
};

export interface OpResult {
  id: number;
  from: string;
  to: string;
  ok: boolean;
  error: string | null;
  /** 失败分类与建议，成功时为 null */
  kind?: FailKind | null;
  hint?: string | null;
  retryable?: boolean;
}

export interface BatchResult {
  batchId: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: OpResult[];
}

export interface BatchInfo {
  batch: string;
  steps: number;
  startedMs: number;
  finishedMs: number;
  /** false = 这一批没写完成标记（正在跑，或者进程半路挂了） */
  completed: boolean;
}

/** 崩溃后还卡在 .rnm-* 临时名上的批次 */
export interface InterruptedBatch {
  batch: string;
  startedMs: number;
  steps: number;
  pending: string[];
}

export interface Progress {
  done: number;
  total: number;
  phase: string;
}

/** 状态文案走 t()：调用时按当前语言求值 */
export const STATUS_LABEL: Record<OpStatus, string> = {
  get ok() {
    return t("可执行");
  },
  get unchanged() {
    return t("无变化");
  },
  get conflict() {
    return t("冲突");
  },
  get invalid() {
    return t("非法");
  },
  get missing() {
    return t("源已变化");
  },
  get excluded() {
    return t("已排除");
  },
};
