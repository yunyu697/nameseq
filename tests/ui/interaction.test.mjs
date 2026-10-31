/**
 * 交互回归：拖拽排序、分区折叠、语言切换。
 *
 * 这三条都是历史上出过真 bug 的地方：
 *   - 拖拽：v7 在 Tauri 里被原生拖放吞掉，改指针事件才修好；落点换算也错过两次
 *   - 折叠：v11 重构时 .workspace 丢了 flex column，高度被内容撑开
 *   - 语言：gettext 回落机制下漏翻不会报错，只有真跑一遍才看得见
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./harness.mjs";
import { buildMockScript } from "./mock.mjs";

let app;

/** 每行的旧文件名（只读旧名列：整行文本里带序号，序号会随位置变，不能拿来比集合） */
const rowNames = `[...document.querySelectorAll(".trow .name.old")]
  .map((el) => el.textContent.trim())`;

before(async () => {
  app = await launch({
    mock: buildMockScript({ count: 30, folders: 0 }),
    width: 1280,
    height: 860,
  });
  const page = app.page;
  await page.waitFor('document.querySelector(".app")', { desc: "应用挂载" });
  await page.click(".add-row .btn.primary");
  await page.waitFor('document.querySelectorAll(".trow").length > 0', {
    timeout: 15_000,
    desc: "预览表有数据",
  });
  // plan 有 160ms 防抖：等它算完再操作，否则拖拽结果会被随后返回的 plan 覆盖
  await sleep(500);
});

after(async () => {
  await app?.close();
});

test("拖拽预览行：被拖的行确实换了位置", async () => {
  const page = app.page;
  const before = await page.eval(rowNames);
  assert.ok(before.length >= 5, `预览行太少（${before.length}），无法测拖拽`);

  // 一次取三行的坐标：center() 会 scrollIntoView，分次取会把坐标搞乱
  const pts = await page.eval(`(() => {
    const rows = [...document.querySelectorAll(".trow")].slice(0, 3);
    return rows.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.5 };
    });
  })()`);
  assert.equal(pts.length, 3, "前三行没有全部渲染");

  // 第一行拖到第三行的位置
  await page.drag(pts[0], pts[2], { steps: 14 });
  // 松手后 entries 重排会触发一次重新规划（160ms 防抖），等它算完再读顺序，
  // 否则读到的是重排前的旧 ops——这不是拖拽失效，而是读得太早
  await sleep(450);

  const after = await page.eval(rowNames);
  assert.equal(
    after.length,
    before.length,
    "拖拽后行数变了（可能有行被误删/重复）",
  );
  assert.deepEqual(
    [...after].sort(),
    [...before].sort(),
    "拖拽后文件名集合变了（只应该换顺序）",
  );
  assert.notDeepEqual(after, before, "拖拽没有生效，顺序完全没变");
  assert.notEqual(after[0], before[0], "被拖的第一行还停在第一位");
  assert.ok(
    after.indexOf(before[0]) > after.indexOf(before[1]),
    `被拖的行应排到原来第二行之后，实际顺序：${after.slice(0, 4).join(" / ")}`,
  );
});

test("分区折叠：点标题收起，再点展开", async () => {
  const page = app.page;
  // 加完文件后文件区会自动收起
  const closedAtStart = await page.eval(
    `!!document.querySelector(".pane-files.closed")`,
  );
  assert.ok(closedAtStart, "添加文件后文件区应自动收起");

  await page.click(".pane-files .pane-head");
  await page.frames(2);
  assert.equal(
    await page.eval(`!!document.querySelector(".pane-files.closed")`),
    false,
    "点标题后文件区应展开",
  );

  await page.click(".pane-files .pane-head");
  await page.frames(2);
  assert.equal(
    await page.eval(`!!document.querySelector(".pane-files.closed")`),
    true,
    "再点一次应重新收起",
  );
});

test("切换语言：界面文案跟着变，且不残留中文", async () => {
  const page = app.page;
  await page.click(".topbar-right .icon-btn:last-child");
  await page.waitFor('document.querySelector(".drawer.show")', {
    desc: "设置抽屉打开",
  });

  const ok = await page.eval(`(() => {
    const items = [...document.querySelectorAll(".drawer .seg-item")];
    const en = items.find((el) => el.textContent.trim() === "English");
    if (!en) return false;
    en.click();
    return true;
  })()`);
  assert.ok(ok, "设置里找不到 English 选项");
  await page.frames(3);

  const brand = await page.eval(
    `document.querySelector(".brand-text h1").textContent.trim()`,
  );
  assert.equal(brand, "NameSeq", "切到英文后品牌名应变成 NameSeq");

  // 抽几个关键位置检查是否还是中文（回落机制不会报错，只能这样抓）
  const leftovers = await page.eval(`(() => {
    const sel = ".pane-head b, .rules-toolbar button, .add-row .btn";
    const cn = /[\\u4e00-\\u9fa5]/;
    return [...document.querySelectorAll(sel)]
      .map((el) => el.textContent.trim())
      .filter((t) => cn.test(t));
  })()`);
  assert.deepEqual(
    leftovers,
    [],
    `切到英文后这些位置还是中文：\n${leftovers.map((t) => `  · ${t}`).join("\n")}`,
  );
});
