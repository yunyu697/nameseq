/**
 * 导出执行前报告的端到端回归。
 *
 * 单测（tests/unit/report.test.mjs）守的是文本格式本身；这里守的是接线：
 * 按钮能点、保存对话框拿到路径后真的把内容写进去、格式按扩展名分流。
 * 这条链路以前完全没有——报告功能本身是新加的，最容易错的是「导出的东西不是屏幕上那份」。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./harness.mjs";
import { buildMockScript } from "./mock.mjs";

let app;

/** 取最后一次 write_text_file 的入参 */
const lastWrite = `(() => {
  const calls = (window.__MOCK_CALLS__ || []).filter((c) => c.cmd === "write_text_file");
  return calls.length ? calls[calls.length - 1].args : null;
})()`;

before(async () => {
  app = await launch({
    mock: buildMockScript({ count: 6, folders: 0 }),
    width: 1280,
    height: 860,
  });
  const page = app.page;
  await page.waitFor('document.querySelector(".app")', { desc: "应用挂载" });
  await page.click(".add-row .btn.primary");
  await page.waitFor('document.querySelectorAll(".trow").length === 6', {
    timeout: 15_000,
    desc: "6 个文件都进列表",
  });

  // 套一个一定会改名的预设（{name}-{index:3}），这样报告里既有旧名也有新名
  const ok = await page.eval(`(() => {
    const btns = [...document.querySelectorAll(".rules-toolbar .toolbar-btn")];
    const preset = btns.find((el) => el.querySelector(".toolbar-count"));
    if (!preset) return false;
    preset.click();
    return true;
  })()`);
  assert.ok(ok, "找不到「预设」按钮");
  await page.waitFor('document.querySelector(".pop-presets")', { desc: "预设浮层" });
  const applied = await page.eval(`(() => {
    const btn = [...document.querySelectorAll(".pop-presets .preset")].find(
      (el) => el.querySelector(".preset-name")?.textContent.trim() === "原名加序号",
    );
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  assert.ok(applied, "找不到「原名加序号」预设");
  await sleep(500);
});

after(async () => {
  await app?.close();
});

test("导出 CSV：按钮可用，内容带 BOM 与表头，且与预览一致", async () => {
  const page = app.page;
  await page.eval(`window.__MOCK_SAVE_AS__ = "csv"`);

  const names = await page.eval(
    `[...document.querySelectorAll(".trow .name.old")].map((el) => el.textContent.trim())`,
  );
  const targets = await page.eval(
    `[...document.querySelectorAll(".trow .name.new")].map((el) => el.textContent.trim())`,
  );
  assert.ok(names.length > 0, "预览是空的，导出没有意义");

  const before = await page.eval(
    `(window.__MOCK_CALLS__ || []).filter((c) => c.cmd === "write_text_file").length`,
  );
  await page.click(".report-btn");
  await page.waitFor(
    `(window.__MOCK_CALLS__ || []).filter((c) => c.cmd === "write_text_file").length > ${before}`,
    { desc: "写文件被调用" },
  );

  const args = await page.eval(lastWrite);
  assert.ok(args, "没有调用 write_text_file");
  assert.match(args.path, /\.csv$/i, `保存路径不对：${args.path}`);
  assert.ok(args.text.startsWith("\ufeff"), "CSV 缺 UTF-8 BOM，Excel 打开会乱码");

  const lines = args.text.split("\r\n").filter(Boolean);
  assert.equal(
    lines[0].replace(/^\ufeff/, ""),
    "序号,状态,原文件名,新文件名,所在目录,大小,修改时间,说明",
    `表头不对：${lines[0]}`,
  );
  assert.equal(lines.length, 1 + names.length, "数据行数与预览行数不一致");

  // 逐行核对：报告里的旧名/新名必须就是屏幕上那两列（按同一顺序）
  for (let i = 0; i < names.length; i++) {
    const cells = lines[i + 1].split(",");
    assert.equal(cells[2], names[i], `第 ${i + 1} 行旧名对不上：${cells[2]}`);
    assert.equal(cells[3], targets[i], `第 ${i + 1} 行新名对不上：${cells[3]}`);
  }
});

test("导出 Markdown：按扩展名分流，含标题与汇总", async () => {
  const page = app.page;
  await page.eval(`window.__MOCK_SAVE_AS__ = "md"`);

  const before = await page.eval(
    `(window.__MOCK_CALLS__ || []).filter((c) => c.cmd === "write_text_file").length`,
  );
  await page.click(".report-btn");
  await page.waitFor(
    `(window.__MOCK_CALLS__ || []).filter((c) => c.cmd === "write_text_file").length > ${before}`,
    { desc: "写文件被调用" },
  );

  const args = await page.eval(lastWrite);
  assert.match(args.path, /\.md$/i, `保存路径不对：${args.path}`);
  assert.ok(args.text.startsWith("# 名序 · 改名报告"), "Markdown 缺标题");
  assert.ok(args.text.includes("条目：6"), `汇总行不对：\n${args.text.slice(0, 200)}`);
  assert.ok(args.text.includes("| 序号 | 状态 |"), "缺表头");
  assert.ok(!args.text.startsWith("\ufeff"), "Markdown 不该带 BOM");
});
