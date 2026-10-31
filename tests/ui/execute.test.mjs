/**
 * 执行改名之后列表怎么变（目录树同步的端到端回归）。
 *
 * 以前执行完是 `refresh()` 全量重扫：路径正确，但手动拖拽的排序、逐个文件的排除勾选
 * 全被抹掉，大目录还要再等一次扫描。现在改成按执行结果原地回写，
 * 这个文件就是守这条行为的——一旦有人把 `refresh()` 加回来，三条断言会同时红。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./harness.mjs";
import { buildMockScript } from "./mock.mjs";

let app;
/** 每行的旧名 / 目标名（只读名字列：整行文本里带序号和状态徽标，不能拿来比） */
const rowNames = `[...document.querySelectorAll(".trow .name.old")].map((el) => el.textContent.trim())`;
const newNames = `[...document.querySelectorAll(".trow .name.new")].map((el) => el.textContent.trim())`;
const scanCalls = `(window.__MOCK_CALLS__ || []).filter((c) => c.cmd === "scan_paths").length`;

before(async () => {
  app = await launch({
    mock: buildMockScript({ count: 8, folders: 0 }),
    width: 1280,
    height: 860,
  });
  const page = app.page;
  await page.waitFor('document.querySelector(".app")', { desc: "应用挂载" });
  await page.click(".add-row .btn.primary");
  await page.waitFor('document.querySelectorAll(".trow").length === 8', {
    timeout: 15_000,
    desc: "8 个文件都进列表",
  });
  await sleep(500); // plan 有 160ms 防抖
});

after(async () => {
  await app?.close();
});

test("执行改名：路径原地更新，排序与排除勾选都不丢", async () => {
  const page = app.page;

  /* ---- 1. 套一个一定会改名的预设（{name}-{index:3}） ---- */
  const opened = await page.eval(`(() => {
    const btns = [...document.querySelectorAll(".rules-toolbar .toolbar-btn")];
    const preset = btns.find((el) => el.textContent.includes("预设"));
    if (!preset) return false;
    preset.click();
    return true;
  })()`);
  assert.ok(opened, "规则工具栏里找不到「预设」按钮");
  await page.waitFor('document.querySelector(".pop-presets")', {
    desc: "预设浮层打开",
  });

  const applied = await page.eval(`(() => {
    const btn = [...document.querySelectorAll(".pop-presets .preset")].find(
      (el) => el.querySelector(".preset-name")?.textContent.trim() === "原名加序号",
    );
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  assert.ok(applied, "预设列表里找不到「原名加序号」");
  await sleep(500);

  const oldNames = await page.eval(rowNames);
  const targets = await page.eval(newNames);
  assert.equal(oldNames.length, 8, `预览行数不对：${oldNames.length}`);
  assert.notDeepEqual(targets, oldNames, "套用预设后预览没有产生任何改名");

  /* ---- 2. 手动拖一行，制造「用户自定义顺序」 ---- */
  const pts = await page.eval(`(() => {
    const rows = [...document.querySelectorAll(".trow")].slice(0, 3);
    return rows.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.5 };
    });
  })()`);
  await page.drag(pts[0], pts[2], { steps: 14 });
  await sleep(450); // 重排会触发重新规划（160ms 防抖）

  /* ---- 3. 排除其中一行（第 3 行），制造「用户自定义选择」 ---- */
  const toggled = await page.eval(`(() => {
    const row = document.querySelectorAll(".trow")[2];
    const box = row?.querySelector(".pick input");
    if (!box) return false;
    box.click();
    return true;
  })()`);
  assert.ok(toggled, "第 3 行没有勾选框");
  await sleep(450);

  const beforeOld = await page.eval(rowNames);
  const beforeNew = await page.eval(newNames);
  const beforeOff = await page.eval(
    `[...document.querySelectorAll(".trow .pick input")].map((el) => !el.checked)`,
  );
  assert.equal(
    beforeOff.filter(Boolean).length,
    1,
    `应该正好排除 1 个，实际 ${beforeOff.filter(Boolean).length}`,
  );
  const scansBefore = await page.eval(scanCalls);

  /* ---- 4. 执行 ---- */
  const runLabel = await page.eval(
    `document.querySelector(".run .btn.primary.run-btn")?.textContent || ""`,
  );
  assert.match(runLabel, /（7）/, `执行按钮上应是 7 个待改，实际「${runLabel}」`);

  await page.click(".run .btn.primary.run-btn");
  await sleep(800); // 执行是 mock 的（瞬时），留时间走完状态更新与重新规划

  /* ---- 5. 断言：顺序 = 执行前的顺序，名字 = 执行前的目标名（被排除的除外） ---- */
  const afterNames = await page.eval(rowNames);
  const afterOff = await page.eval(
    `[...document.querySelectorAll(".trow .pick input")].map((el) => !el.checked)`,
  );

  assert.equal(afterNames.length, 8, "执行后行数变了");
  assert.deepEqual(
    afterOff,
    beforeOff,
    "排除勾选没有保持（原地更新不该动用户的勾选）",
  );

  const expected = beforeOld.map((name, i) =>
    beforeOff[i] ? name : beforeNew[i],
  );
  assert.deepEqual(
    afterNames,
    expected,
    [
      "执行后的列表不对：应当「顺序不变、名字换成目标名、被排除的保持原名」",
      `  执行前：${beforeOld.join(" / ")}`,
      `  期望：  ${expected.join(" / ")}`,
      `  实际：  ${afterNames.join(" / ")}`,
    ].join("\n"),
  );

  /* ---- 6. 断言：没有触发全量重扫 ---- */
  const scansAfter = await page.eval(scanCalls);
  assert.equal(
    scansAfter,
    scansBefore,
    `执行后不该重新扫描（scan_paths 调用从 ${scansBefore} 变成了 ${scansAfter}）`,
  );
});
