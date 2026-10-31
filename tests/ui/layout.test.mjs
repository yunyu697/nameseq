/**
 * 布局零变形回归。
 *
 * 这是历史上返工最多的一项：窄窗口下按钮被压缩换行、文字遮挡。
 * 与其逐个猜 CSS，不如在真实宽度范围内客观枚举所有交互控件的几何尺寸，
 * 跨宽度比对——高度变了就是变形，scrollWidth 超了就是被裁。
 *
 * 判定口径（与项目 MEMORY.md 的 UI 布局铁律一致）：
 *   1. 同一控件在不同宽度下的高度必须完全一致
 *   2. 控件自身不能出现横向裁切（scrollWidth > clientWidth）
 *   3. 最窄宽度下，不可换行的关键行不能横向溢出容器
 *
 * 排除项：关闭的设置抽屉（整块在视口外）、本来就用省略号截断的描述性文字。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./harness.mjs";
import { buildMockScript } from "./mock.mjs";

let app;
let minWs;

/** 扫描当前宽度下所有交互控件的几何 */
const SCAN = `(() => {
  const SKIP = [
    ".drawer",          // 关闭时整块在视口右侧外，坐标判定没意义
    ".toolbar-hint", ".chain-hint", ".chain-count", ".card-count",
    ".add-hint", ".pane-titles i", ".empty-note", ".root-path",
    ".group-bar-hint", ".preview-hint",
  ].join(",");
  // 头部标题也要扫：它们不是控件，但同样「不许压缩换行」——
  // 「分组」两个字被挤成竖排两行（高 15→30）就是这么漏掉的
  const TITLES = [
    ".group-bar-head > b", ".chain-head h3", ".card-head h3",
    ".preview-head h3", ".pane-titles b",
  ].join(",");
  const agg = new Map();
  for (const el of document.querySelectorAll(
    "button, .chk, .seg-item, .tab, select, " + TITLES,
  )) {
    if (el.closest(SKIP)) continue;
    if (el.offsetParent === null) continue;   // 折叠区里的内容
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const text = (el.innerText || el.getAttribute("title") || "")
      .trim().replace(/\\s+/g, " ").slice(0, 18);
    const cls = Array.from(el.classList)
      .filter((c) => !/^(on|off|active|selected|disabled)$/.test(c))
      .join(".") || el.tagName.toLowerCase();
    const key = cls + "|" + text;
    const a = agg.get(key) || { key, h: 0, clip: false, sw: 0, cw: 0 };
    a.h = Math.max(a.h, Math.round(r.height * 10) / 10);
    if (el.scrollWidth > el.clientWidth + 1) {
      a.clip = true;
      a.sw = Math.max(a.sw, el.scrollWidth);
      a.cw = Math.max(a.cw, el.clientWidth);
    }
    agg.set(key, a);
  }
  return [...agg.values()];
})()`;

/** 关键行是否横向溢出容器 */
const ROW_OVERFLOW = `(() => {
  const sel = ".rules-toolbar, .chain-head, .card-head, .add-row, .pane-head, .ff-row, .preview-head, .group-bar-head, .group-chip-main";
  const bad = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.offsetParent === null) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      bad.push({
        cls: el.className,
        sw: el.scrollWidth,
        cw: el.clientWidth,
      });
    }
  }
  return bad;
})()`;

before(async () => {
  app = await launch({
    mock: buildMockScript({ count: 60, folders: 3 }),
    width: 1440,
    height: 900,
  });
  const page = app.page;
  await page.waitFor('document.querySelector(".app")', { desc: "应用挂载" });

  // 造出真实内容：列表有行、文件区收起、规则卡存在
  await page.click(".add-row .btn.primary");
  await page.waitFor('document.querySelectorAll(".trow").length > 0', {
    timeout: 15_000,
    desc: "预览表有数据",
  });

  // 展开所有折叠分区，让扫描覆盖到执行区的按钮
  for (let guard = 0; guard < 5; guard++) {
    const closed = await page.eval(`document.querySelectorAll(".pane.closed").length`);
    if (closed === 0) break;
    await page.click(".pane.closed .pane-head");
    await page.frames(2);
  }

  minWs = await page.eval(`window.__MINWS__ || 0`);

  // 建一个分组：分组芯片行（勾选框 + 名字 + 条数 + 条件 + 删除）也要被扫到，
  // 空列表时它整行不渲染，等于这块布局没有回归覆盖
  const added = await page.eval(`(() => {
    const btn = document.querySelector(".group-bar-head .link-btn");
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  assert.ok(added, "找不到「新建分组」按钮");
  await page.frames(2);
});

after(async () => {
  await app?.close();
});

test("实测最小宽度是合理的（不是兜底值）", async () => {
  assert.ok(minWs > 0, "__MINWS__ 未设置");
  assert.ok(
    minWs > 360,
    `__MINWS__ = ${minWs}，等于兜底值 360，说明 min-content 测量没生效`,
  );
  assert.ok(minWs < 900, `__MINWS__ = ${minWs}，大得不像实测值`);
});

test("全宽度范围内控件零变形、零裁切", async () => {
  const page = app.page;
  // 从「理论最小窗口」扫到 1600：低于这个值预览区会被压到 MIN_PREVIEW 以下
  const start = Math.max(700, Math.ceil(minWs) + 264);
  const widths = [];
  for (let w = start; w < 1600; w += 110) widths.push(w);
  widths.push(1600);

  /** key -> { h, w } 第一次见到的几何 */
  const baseline = new Map();
  const deform = [];
  const clipped = [];

  for (const w of widths) {
    await page.setViewport(w, 820);
    await page.frames(3);
    await sleep(120);

    const items = await page.eval(SCAN);
    // 实测：默认状态约 76 个控件（129 个节点）。低于 40 说明选择器或展开逻辑失效了
    assert.ok(
      items.length > 40,
      `宽度 ${w} 只扫到 ${items.length} 个控件，扫描器可能失效`,
    );

    for (const it of items) {
      if (it.clip) clipped.push({ w, ...it });
      const base = baseline.get(it.key);
      if (!base) {
        baseline.set(it.key, { h: it.h, w });
      } else if (Math.abs(base.h - it.h) > 0.5) {
        deform.push({ key: it.key, from: base.h, atW: base.w, to: it.h, nowW: w });
      }
    }
  }

  const fmt = (list, n = 8) =>
    list
      .slice(0, n)
      .map((d) =>
        d.key !== undefined
          ? `  · ${d.key}：${d.from}px（宽 ${d.atW}）→ ${d.to}px（宽 ${d.nowW}）`
          : `  · ${d.cls}：内容 ${d.sw}px > 容器 ${d.cw}px（宽 ${d.w}）`,
      )
      .join("\n");

  assert.deepEqual(
    deform,
    [],
    `有控件在不同宽度下高度变了（文字换行或被压扁）：\n${fmt(deform)}`,
  );
  assert.deepEqual(
    clipped,
    [],
    `有控件被横向裁切（内容宽度超过自身）：\n${fmt(clipped)}`,
  );
});

test("预览列压到最窄时，筛选条不横向溢出", async () => {
  const page = app.page;
  // 窗口刚好等于「功能区下限 + 预览下限 + 分隔条」，此时预览列被压到 260px
  const w = Math.ceil(minWs) + 260 + 4;
  await page.setViewport(w, 820);
  await page.frames(3);
  await sleep(150);

  const diag = await page.eval(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { w: Math.round(el.getBoundingClientRect().width), sw: el.scrollWidth, cw: el.clientWidth };
    };
    return { inner: innerWidth, preview: box(".preview"), ffRow: box(".ff-row"), ffSort: box(".ff-row.ff-sort") };
  })()`);

  const bad = await page.eval(ROW_OVERFLOW);
  assert.deepEqual(
    bad,
    [],
    `窗口 ${w}（预览列被压到最窄）时这些行溢出：\n` +
      bad.map((b) => `  · ${b.cls}：${b.sw} > ${b.cw}`).join("\n") +
      `\n实测宽度：${JSON.stringify(diag)}`,
  );
});

test("最窄宽度下关键行不横向溢出", async () => {
  const page = app.page;
  const narrow = Math.max(700, Math.ceil(minWs) + 264);
  await page.setViewport(narrow, 820);
  await page.frames(3);
  await sleep(120);

  // 失败时把关键宽度一起报出来：只报「谁溢出」不够，得知道当时各列到底多宽
  const diag = await page.eval(`(() => {
    const w = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().width) : null;
    };
    return {
      minWs: window.__MINWS__,
      inner: innerWidth,
      workspace: w(".workspace"),
      preview: w(".preview"),
      paneFiles: w(".pane-files"),
      ffBar: w(".ff-bar"),
    };
  })()`);

  const bad = await page.eval(ROW_OVERFLOW);
  assert.deepEqual(
    bad,
    [],
    `宽度 ${narrow} 下这些行溢出了容器（会遮挡右侧内容）：\n` +
      bad.map((b) => `  · ${b.cls}：${b.sw} > ${b.cw}`).join("\n") +
      `\n实测宽度：${JSON.stringify(diag)}`,
  );

  // 功能区不能被压到实测下限以下
  const ws = await page.eval(
    `document.querySelector(".workspace").getBoundingClientRect().width`,
  );
  assert.ok(
    ws >= minWs - 1,
    `功能区被压到 ${Math.round(ws)}px，低于实测下限 ${minWs}px（${JSON.stringify(diag)}）`,
  );
});
