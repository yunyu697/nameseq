/**
 * 主题系统。
 *
 * 设计要点：所有颜色都不写死成具体色值，而是拆成 HSL 通道（h / s）。
 * 「浅色/深色」只决定明度阶梯，通道决定色相与饱和度，
 * 同一套通道就能自动得到主色、悬停色、柔和底色等多个层次。
 *
 * 一共四根可调轴：
 * 1. 强调色 accent   —— 按钮、选中态、焦点环
 * 2. 浓淡   strength —— 强调色的饱和度倍率
 * 3. 界面色系 neutral —— 背景 / 面板 / 边框 / 文字的整套中性色
 * 4. 状态色 status   —— 成功 / 警告 / 危险
 *
 * 通道值同时存进 localStorage，index.html 的首帧脚本直接读数字，
 * 不需要任何查表逻辑，避免两处维护同一份色板。
 */

export type ThemeMode = "light" | "dark" | "system";
export type Density = "compact" | "normal" | "relaxed";
export type RadiusScale = "sharp" | "soft" | "round";
export type AccentStrength = "soft" | "normal" | "vivid";

export interface HueSat {
  h: number;
  s: number;
}

export interface Settings {
  mode: ThemeMode;
  /** 自动检查更新的频率；manual = 只手动检查 */
  updateCheck: "startup" | "daily" | "weekly" | "manual";
  /** 界面语言；system = 跟随系统，系统语言不在支持列表时回落英语 */
  language: "system" | "zh-CN" | "zh-TW" | "en" | "ja" | "es";
  /** 强调色预设 id，选了自定义就是 "custom" */
  accent: string;
  /** 通道值始终与预设保持同步，首帧脚本直接读它们，不用查表 */
  accentH: number;
  accentS: number;
  strength: AccentStrength;
  /** 界面中性色（背景/面板/边框/文字），预设 id 或 "custom" */
  neutral: string;
  neutralH: number;
  neutralS: number;
  /** 状态色方案（成功/警告/危险） */
  status: string;
  okH: number;
  okS: number;
  warnH: number;
  warnS: number;
  dangerH: number;
  dangerS: number;
  density: Density;
  radius: RadiusScale;
  motion: boolean;
}

export interface AccentDef {
  id: string;
  name: string;
  h: number;
  s: number;
}

/** 16 个强调色，覆盖冷暖与高低调，剩下的交给自定义滑块。 */
export const ACCENTS: AccentDef[] = [
  { id: "blue", name: "海蓝", h: 212, s: 74 },
  { id: "azure", name: "湖蓝", h: 205, s: 78 },
  { id: "cyan", name: "天青", h: 192, s: 72 },
  { id: "teal", name: "青碧", h: 176, s: 66 },
  { id: "green", name: "松绿", h: 154, s: 52 },
  { id: "moss", name: "苔绿", h: 118, s: 42 },
  { id: "amber", name: "琥珀", h: 38, s: 82 },
  { id: "mustard", name: "芥黄", h: 48, s: 88 },
  { id: "coral", name: "珊瑚", h: 12, s: 80 },
  { id: "rose", name: "朱红", h: 6, s: 70 },
  { id: "garnet", name: "石榴", h: 350, s: 68 },
  { id: "pink", name: "品红", h: 330, s: 66 },
  { id: "grape", name: "葡萄", h: 298, s: 60 },
  { id: "violet", name: "紫罗兰", h: 272, s: 60 },
  { id: "indigo", name: "靛青", h: 243, s: 62 },
  { id: "ink", name: "靛墨", h: 230, s: 58 },
];

export interface NeutralDef {
  id: string;
  name: string;
  h: number;
  s: number;
}

/**
 * 界面色系：一套通道同时决定背景、面板、边框、文字的色调。
 * s 越小越接近纯灰，越大彩色倾向越明显。
 */
export const NEUTRALS: NeutralDef[] = [
  { id: "cool", name: "冷灰", h: 214, s: 20 },
  { id: "warm", name: "暖灰", h: 32, s: 18 },
  { id: "graphite", name: "石墨", h: 222, s: 9 },
  { id: "gray", name: "纯灰", h: 220, s: 3 },
  { id: "indigo", name: "靛蓝", h: 228, s: 30 },
  { id: "pine", name: "墨绿", h: 168, s: 16 },
  { id: "plum", name: "绛紫", h: 292, s: 16 },
];

export interface StatusDef {
  id: string;
  name: string;
  ok: HueSat;
  warn: HueSat;
  danger: HueSat;
}

/** 状态色方案：成功 / 警告 / 危险 三色一起换，保证语义仍然可分辨。 */
export const STATUSES: StatusDef[] = [
  {
    id: "classic",
    name: "经典",
    ok: { h: 158, s: 66 },
    warn: { h: 37, s: 88 },
    danger: { h: 2, s: 64 },
  },
  {
    id: "vivid",
    name: "鲜明",
    ok: { h: 145, s: 78 },
    warn: { h: 34, s: 96 },
    danger: { h: 355, s: 84 },
  },
  {
    id: "soft",
    name: "柔和",
    ok: { h: 162, s: 42 },
    warn: { h: 42, s: 62 },
    danger: { h: 8, s: 46 },
  },
  {
    id: "cool",
    name: "冷调",
    ok: { h: 186, s: 58 },
    warn: { h: 48, s: 78 },
    danger: { h: 340, s: 66 },
  },
  {
    id: "warm",
    name: "暖调",
    ok: { h: 96, s: 48 },
    warn: { h: 28, s: 90 },
    danger: { h: 12, s: 72 },
  },
];

export const STRENGTHS: { id: AccentStrength; name: string; hint: string }[] = [
  { id: "soft", name: "柔和", hint: "饱和度压低，更内敛" },
  { id: "normal", name: "标准", hint: "默认" },
  { id: "vivid", name: "鲜明", hint: "饱和度拉高，更醒目" },
];

export const DENSITIES: { id: Density; name: string; hint: string }[] = [
  { id: "compact", name: "紧凑", hint: "一屏看更多" },
  { id: "normal", name: "标准", hint: "默认" },
  { id: "relaxed", name: "宽松", hint: "更易点击" },
];

export const RADII: { id: RadiusScale; name: string }[] = [
  { id: "sharp", name: "直角" },
  { id: "soft", name: "圆润" },
  { id: "round", name: "大圆角" },
];

export const MODES: { id: ThemeMode; name: string }[] = [
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
  { id: "system", name: "跟随系统" },
];

export const DEFAULT_SETTINGS: Settings = {
  mode: "system",
  updateCheck: "daily",
  language: "system",
  accent: "blue",
  accentH: 212,
  accentS: 74,
  strength: "normal",
  neutral: "cool",
  neutralH: 214,
  neutralS: 20,
  status: "classic",
  okH: 158,
  okS: 66,
  warnH: 37,
  warnS: 88,
  dangerH: 2,
  dangerS: 64,
  density: "normal",
  radius: "soft",
  motion: true,
};

const KEY = "renamesmith.settings.v1";

/** 把旧版存的颜色 id 同步成通道值，老用户升级后配色不丢。 */
function syncChannels(s: Settings): Settings {
  const a = ACCENTS.find((x) => x.id === s.accent);
  if (a) {
    s.accentH = a.h;
    s.accentS = a.s;
  }
  const n = NEUTRALS.find((x) => x.id === s.neutral);
  if (n) {
    s.neutralH = n.h;
    s.neutralS = n.s;
  }
  const st = STATUSES.find((x) => x.id === s.status);
  if (st) {
    s.okH = st.ok.h;
    s.okS = st.ok.s;
    s.warnH = st.warn.h;
    s.warnS = st.warn.s;
    s.dangerH = st.danger.h;
    s.dangerS = st.danger.s;
  }
  return s;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return syncChannels({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式下写不进去，忽略即可 */
  }
}

/** 把 mode=system 解析成实际生效的明暗。 */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * 把设置写到 <html> 上。
 * 只负责设置通道与 data-* 属性，明度阶梯全部由 CSS 根据 data-theme 推导。
 */
export function applySettings(s: Settings, animate = false) {
  const root = document.documentElement;

  root.dataset.theme = resolveDark(s.mode) ? "dark" : "light";
  root.dataset.density = s.density;
  root.dataset.radius = s.radius;
  root.dataset.motion = s.motion ? "on" : "off";
  root.dataset.strength = s.strength;

  root.style.setProperty("--a-h", String(s.accentH));
  root.style.setProperty("--a-s-base", `${s.accentS}%`);
  root.style.setProperty("--n-h", String(s.neutralH));
  root.style.setProperty("--n-s", `${s.neutralS}%`);
  root.style.setProperty("--ok-h", String(s.okH));
  root.style.setProperty("--ok-s", `${s.okS}%`);
  root.style.setProperty("--warn-h", String(s.warnH));
  root.style.setProperty("--warn-s", `${s.warnS}%`);
  root.style.setProperty("--danger-h", String(s.dangerH));
  root.style.setProperty("--danger-s", `${s.dangerS}%`);

  if (animate) {
    // 主题切换时给全局加一层过渡，320ms 后移除，避免影响后续交互性能
    root.classList.add("theming");
    window.setTimeout(() => root.classList.remove("theming"), 340);
  }
}

/** 供设置面板预览用：把某个强调色的实际主色算出来。 */
export function accentSwatch(accent: AccentDef, dark: boolean): string {
  return dark
    ? `hsl(${accent.h} ${accent.s}% 62%)`
    : `hsl(${accent.h} ${accent.s}% 44%)`;
}

/** 界面色系的预览色：一小块底色。 */
export function neutralSwatch(n: NeutralDef, dark: boolean): string {
  return dark ? `hsl(${n.h} ${n.s}% 10%)` : `hsl(${n.h} ${n.s}% 95%)`;
}

export function neutralSwatchText(n: NeutralDef, dark: boolean): string {
  const s = Math.min(n.s * 1.4, 60);
  return dark ? `hsl(${n.h} ${s}% 70%)` : `hsl(${n.h} ${s}% 30%)`;
}

/** 状态色方案的三个预览点。 */
export function statusSwatches(st: StatusDef, dark: boolean): string[] {
  const l = dark ? 66 : 42;
  return [st.ok, st.warn, st.danger].map((c) => `hsl(${c.h} ${c.s}% ${l}%)`);
}
