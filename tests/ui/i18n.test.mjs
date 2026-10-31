/**
 * i18n 完整性：源码里出现的每一条 t("...") 都必须有 zh-TW / en / ja / es 四个译法。
 *
 * 为什么需要它：i18n 是 gettext 风格（简体中文原文就是 key），查不到时静默回落
 * 中文原文——不报错、不露键名，所以漏翻不会有人发现，只有英文用户会莫名其妙
 * 看到中文。这条测试是唯一的守门人。
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
const I18N = join(SRC, "i18n.ts");

const LANGS = ["zhTW", "en", "ja", "es"];

/** key 行：缩进 + （带引号的 key | 裸标识符 key）+ 冒号 + （字符串开始 | 行尾） */
const KEY_LINE = /^\s*(?:"((?:[^"\\]|\\.)+)"|([^\s"'][^:]*?))\s*:\s*(?:$|["'`])/;

/** 从 i18n.ts 里切出某张表的行 */
function tableLines(source, name) {
  const lines = source.split("\n");
  const startRe = new RegExp(`const\\s+${name}\\s*:\\s*Record<string, string>\\s*=\\s*\\{`);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`i18n.ts 里找不到 ${name} 表`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\};/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${name} 表没有闭合（找不到顶格的 };）`);
  return lines.slice(start + 1, end);
}

function keysOf(lines) {
  const out = new Set();
  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const key = m[1] ?? m[2];
    if (key) out.add(key);
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

/** 动态 key 的静态来源：这些数据表的字符串会被 t(x.name) 之类消费，
    所以也要算进「用到的文案」，否则它们的翻译漏了不会被发现。 */
const DYNAMIC_SOURCES = [
  {
    file: "src/fileTypes.ts",
    re: /\bname:\s*"([^"]+)"/g,
    note: "FILE_TYPE_GROUPS 的组名（渲染时走 t(g.name)）",
  },
  {
    file: "src/components/FileFilterBar.tsx",
    re: /\blabel:\s*"([^"]+)"/g,
    note: "排序选项的 label（渲染时走 t(o.label)）",
  },
];

/** 允许的动态调用：key 已由 DYNAMIC_SOURCES 覆盖 */
const ALLOWED_DYNAMIC = [/^t\(g\.name\)$/, /^t\(o\.label\)$/];

/** 收集源码里所有静态 t("...") 的 key */
async function collectUsedKeys() {
  const files = (await walk(SRC)).filter((f) => f !== I18N);
  const used = new Map(); // key -> 第一次出现的位置
  const dynamic = []; // t(`...${x}...`) 或 t(variable)：无法静态校验
  const staticRe = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
  const dynamicRe = /\bt\(\s*([`a-zA-Z_$][^)]*)\)/g;

  for (const file of files) {
    const src = await readFile(file, "utf8");
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    for (const m of src.matchAll(staticRe)) {
      if (!used.has(m[1])) used.set(m[1], rel);
    }
    // 静态调用换成同样带引号的占位符，避免被下面的动态检测误抓
    const stripped = src.replace(staticRe, 't("__STATIC__")');
    for (const m of stripped.matchAll(dynamicRe)) {
      const call = `t(${m[1]})`.replace(/\s+/g, "");
      if (ALLOWED_DYNAMIC.some((re) => re.test(call))) continue;
      dynamic.push(`${rel}: ${call}`);
    }
  }

  // 数据表里的字符串也是文案 key
  for (const src of DYNAMIC_SOURCES) {
    const text = await readFile(join(ROOT, src.file), "utf8");
    for (const m of text.matchAll(src.re)) {
      if (!used.has(m[1])) used.set(m[1], `${src.file}（${src.note}）`);
    }
  }

  return { used, dynamic };
}

test("源码里每条 t(\"...\") 都有四语言译法", async () => {
  const source = await readFile(I18N, "utf8");
  const tables = Object.fromEntries(
    LANGS.map((lang) => [lang, keysOf(tableLines(source, lang))]),
  );
  const { used } = await collectUsedKeys();

  const missing = {};
  for (const lang of LANGS) {
    const lack = [];
    for (const key of used.keys()) {
      if (!tables[lang].has(key)) lack.push(key);
    }
    if (lack.length) missing[lang] = lack;
  }

  const total = used.size;
  assert.ok(total > 50, `扫描到的文案太少（${total} 条），解析逻辑可能失效了`);

  if (Object.keys(missing).length > 0) {
    const lines = Object.entries(missing).map(([lang, keys]) => {
      const shown = keys.slice(0, 12).map((k) => `    · ${k}`).join("\n");
      const more = keys.length > 12 ? `\n    …还有 ${keys.length - 12} 条` : "";
      return `  ${lang} 缺 ${keys.length} 条：\n${shown}${more}`;
    });
    assert.fail(
      `有 ${total} 条文案，以下语言表没覆盖（缺词条会静默回落中文）：\n${lines.join("\n")}`,
    );
  }
});

test("四张表的条目数不应相差太大（防整段漏翻）", async () => {
  const source = await readFile(I18N, "utf8");
  const counts = LANGS.map((lang) => ({
    lang,
    n: keysOf(tableLines(source, lang)).size,
  }));
  const max = Math.max(...counts.map((c) => c.n));
  const min = Math.min(...counts.map((c) => c.n));
  const detail = counts.map((c) => `${c.lang}=${c.n}`).join(" ");
  assert.ok(
    max - min <= Math.ceil(max * 0.15),
    `各语言条目数差距过大（${detail}），可能有整段没翻`,
  );
});

test("没有无法静态校验的动态文案（有的话在此列出）", async () => {
  const { dynamic } = await collectUsedKeys();
  assert.deepEqual(
    dynamic,
    [],
    `这些 t() 调用用了模板串或变量，无法被上面两条测试覆盖，需要改成静态 key：\n` +
      dynamic.map((d) => `  · ${d}`).join("\n"),
  );
});
