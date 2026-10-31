/**
 * 冒烟：harness + mock 能真的把应用跑起来。
 * 这一条挂了，后面的布局/交互测试都没有意义，所以放最前面单独一个文件。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./harness.mjs";
import { buildMockScript } from "./mock.mjs";

let app;

before(async () => {
  app = await launch({ mock: buildMockScript({ count: 12, folders: 0 }) });
  await app.page.waitFor('document.querySelector(".app")', {
    desc: "应用根节点挂载",
  });
});

after(async () => {
  await app?.close();
});

test("页面挂载，没有白屏", async () => {
  const info = await app.page.eval(`(() => ({
    panes: document.querySelectorAll(".pane").length,
    hasWorkspace: !!document.querySelector(".workspace"),
    hasPreview: !!document.querySelector(".preview"),
    hasTopBar: !!document.querySelector(".topbar") || !!document.querySelector(".top-bar"),
    text: (document.body.innerText || "").trim().length,
  }))()`);
  assert.equal(info.panes, 3, "应该有三个分区（文件 / 规则 / 执行）");
  assert.ok(info.hasWorkspace, "工作区存在");
  assert.ok(info.hasPreview, "预览区存在");
  assert.ok(info.text > 50, `页面有实际内容（现在 ${info.text} 字）`);
});

test("启动时按预期调用了后端（mock 契约对齐）", async () => {
  const calls = await app.page.eval(
    `(window.__MOCK_CALLS__ || []).map((c) => c.cmd)`,
  );
  assert.ok(calls.includes("list_batches"), `启动应查历史批次，实际：${calls}`);
  assert.ok(
    calls.includes("interrupted_batches"),
    `启动应查未完成批次，实际：${calls}`,
  );
});

test("选择文件后预览表出现行", async () => {
  await app.page.click(".add-row .btn.primary");
  await app.page.waitFor('document.querySelectorAll(".trow").length > 0', {
    timeout: 10_000,
    desc: "预览表出现数据行",
  });
  const rows = await app.page.eval(`document.querySelectorAll(".trow").length`);
  assert.equal(rows, 12, "mock 返回 12 个文件，预览表应全部列出");
});

test("实测最小宽度已算出并挂在调试钩子上", async () => {
  const minWs = await app.page.eval(`window.__MINWS__ || 0`);
  assert.ok(
    typeof minWs === "number" && minWs > 200,
    `__MINWS__ 应为合理的实测值，实际 ${minWs}`,
  );
});
