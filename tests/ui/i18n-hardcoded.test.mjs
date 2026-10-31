/**
 * 硬编码中文扫描：源码里出现的每一段中文字符串，都必须包在 t(...) 里。
 *
 * 为什么需要它：i18n.test.mjs 只校验「已经写了 t() 的 key 有没有译法」，
 * 完全没包 t() 的中文它看不见——那才是最常见的漏翻方式（新加一个按钮，
 * 顺手写了中文标签，英文界面就露馅）。这条测试补上这个缺口。
 *
 * 允许的例外只有两类，且都要能说清楚理由：
 *   1. 数据表文件里的文案常量（规则库/主题/预设/文件类型），它们的 key
 *      由 i18n.test.mjs 的 DYNAMIC_SOURCES 覆盖，渲染点统一 t(x.name)。
 *   2. 选项数组里的 name/label/hint/desc/example/title 字段值，同上。
 *
 * 不需要浏览器，纯静态扫描。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

const HAS_CJK = /[\u4e00-\u9fa5]/;

/** 整个文件都是「文案常量」的数据表：中文在这里是 key，不是漏翻 */
const DATA_FILES = new Set([
  "src/i18n.ts",
  "src/rules.ts",
  "src/theme.ts",
  "src/presets.ts",
  "src/fileTypes.ts",
]);

/** 这些文件里允许出现「字段值形态」的中文（渲染点会 t(x.field)） */
const FIELD_VALUE_FILES = new Set([
  "src/rules.ts",
  "src/theme.ts",
  "src/presets.ts",
  "src/fileTypes.ts",
  "src/components/FileFilterBar.tsx",
  "src/components/PreviewTable.tsx",
  "src/components/SettingsDrawer.tsx",
]);

const FIELD_NAMES = new Set([
  "name",
  "label",
  "hint",
  "desc",
  "example",
  "title",
]);

/**
 * 词法：注释抹成空格，收集字符串字面量。
 * 必须能认出正则字面量，否则 `/"/g` 里的引号会被当成字符串开头，
 * 后面整段代码都会错位（report.ts 就踩过这个坑）。
 */
function lex(src) {
  const n = src.length;
  const out = src.split("");
  const strings = [];
  let i = 0;
  let prev = ""; // 上一个有意义的字符，用来判断 / 是除号还是正则开头

  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);

    if (c2 === "//") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c2 === "/*") {
      while (i < n && src.slice(i, i + 2) !== "*/") {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        if (quote !== "`" && src[i] === "\n") break;
        i++;
      }
      strings.push({ start, end: i, value: src.slice(start + 1, i - 1) });
      for (let k = start + 1; k < i - 1; k++) {
        if (out[k] !== "\n") out[k] = " ";
      }
      prev = quote;
      continue;
    }
    // prev 是 < 时这是 JSX 闭合标签 </div>，不是正则字面量
    if (c === "/" && prev !== "<" && !/[\w$)\]}'"`]/.test(prev)) {
      // 正则字面量：整体跳过，不产生字符串
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) {
          i++;
          break;
        } else if (src[i] === "\n") break;
        i++;
      }
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { strings, masked: out.join("") };
}

/** 所有 t(...) 调用覆盖的字符区间（按括号配平，跳过字符串内部） */
function tRanges(src, strings) {
  const inString = new Uint8Array(src.length);
  for (const s of strings) {
    for (let k = s.start; k < s.end; k++) inString[k] = 1;
  }
  const ranges = [];
  for (const m of src.matchAll(/\bt\s*\(/g)) {
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < src.length; j++) {
      if (inString[j]) continue;
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([m.index, j]);
  }
  return ranges;
}

/** 字符串前面是不是 `字段名:` / `字段名=` —— 选项数组与 JSX 里的可翻译字段 */
function fieldOf(src, pos) {
  let k = pos - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  const sep = src[k];
  if (sep !== ":" && sep !== "=") return null;
  k--;
  while (k >= 0 && /\s/.test(src[k])) k--;
  const end = k + 1;
  while (k >= 0 && /[\w$]/.test(src[k])) k--;
  return { name: src.slice(k + 1, end), sep };
}

/** 这个字符串字面量内部所有汉字的偏移（不含两端引号） */
function cjkPositions(s) {
  const out = [];
  for (let i = s.start + 1; i < s.end - 1; i++) {
    const ch = s.value[i - s.start - 1] ?? "";
    if (HAS_CJK.test(ch)) out.push(i);
  }
  return out;
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos; i++) if (src[i] === "\n") line++;
  return line;
}

test("源码里没有漏包 t() 的中文文案", async () => {
  const offenders = [];
  let scanned = 0;

  for (const file of await walk(SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (DATA_FILES.has(rel)) continue;
    const src = await readFile(file, "utf8");
    const { strings } = lex(src);
    const ranges = tRanges(src, strings);
    const inT = (pos) => ranges.some(([a, b]) => pos >= a && pos <= b);
    const allowField = FIELD_VALUE_FILES.has(rel);

    for (const s of strings) {
      const positions = cjkPositions(s);
      if (positions.length === 0) continue;
      scanned++;
      // 逐字判定：模板串 `已添加 ${t("...")} 个文件` 里，只有真正在 t() 里的
      // 那些字才算翻过，外面的仍然要报——所以不能整串一刀切。
      const naked = positions.filter((p) => !inT(p));
      if (naked.length === 0) continue;
      const field = fieldOf(src, s.start);
      if (allowField && field && FIELD_NAMES.has(field.name)) continue;
      // JSX 的 label= 只有 TokenRow 在用，组件内部会 t(label)
      if (field && field.sep === "=" && field.name === "label") continue;
      offenders.push(
        `${rel}:${lineOf(src, s.start)}  ${s.value.replace(/\s+/g, " ").slice(0, 60)}`,
      );
    }
  }

  assert.ok(scanned > 100, `只扫到 ${scanned} 段中文，词法可能失效了`);
  assert.deepEqual(
    offenders,
    [],
    `以下中文没有包 t()（英文界面会直接露中文）：\n` +
      offenders.map((o) => `  · ${o}`).join("\n"),
  );
});

test("JSX 纯文本里没有漏包 t() 的中文", async () => {
  const offenders = [];

  for (const file of await walk(SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (DATA_FILES.has(rel)) continue;
    if (!rel.endsWith(".tsx")) continue;
    const src = await readFile(file, "utf8");
    // 注释和字符串内部都抹掉了，剩下的汉字只可能出现在 JSX 文本（或中文标识符）
    const { masked } = lex(src);
    for (let i = 0; i < masked.length; i++) {
      if (!HAS_CJK.test(masked[i])) continue;
      const from = masked.lastIndexOf("\n", i) + 1;
      const to = masked.indexOf("\n", i);
      offenders.push(
        `${rel}:${lineOf(src, i)}  ${masked.slice(from, to < 0 ? undefined : to).trim().slice(0, 70)}`,
      );
      i = to < 0 ? masked.length : to;
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下中文是 JSX 纯文本，没有包 t()（英文界面会直接露中文）：\n` +
      offenders.map((o) => `  · ${o}`).join("\n"),
  );
});
