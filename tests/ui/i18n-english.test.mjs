/**
 * 英文界面里不该出现汉字。
 *
 * 这是 i18n 的端到端兜底：静态扫描（i18n-hardcoded.test.mjs）只能证明
 * 「源码里每个中文都包了 t()」，证明不了「包了 t() 的那个 key 真的有英文译法」，
 * 也证明不了「渲染出来的不是中文」——比如把 t() 的结果又拼回中文、或者
 * 某个数据表字段忘了在渲染点过 t()。这一条直接看真实 DOM。
 *
 * 覆盖三块界面：默认视图（文件/规则/预览/执行）、外观设置抽屉、规则库与预设浮层。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./harness.mjs";
import { buildMockScript } from "./mock.mjs";

let app;

before(async () => {
  // lang: "en" 会同时钉死 navigator.language 和 Chrome 的 --lang
  app = await launch({
    lang: "en",
    mock: buildMockScript({ count: 8, folders: 0 }),
  });
  await app.page.waitFor('document.querySelector(".app")', {
    desc: "应用根节点挂载",
  });
});

after(async () => {
  await app?.close();
});

/** 扫一遍可见文本 + title/placeholder/aria-label，返回含汉字的片段 */
const SCAN = `(() => {
  const CJK = /[\\u4e00-\\u9fa5]/;
  const out = [];
  const add = (where, text) => {
    const s = String(text || "").replace(/\\s+/g, " ").trim();
    if (s && CJK.test(s)) out.push(where + " → " + s.slice(0, 70));
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const el = n.parentElement;
    if (!el) continue;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    // 文件名、路径、规则名都是用户数据，可能是中文
    if (el.closest(".trow .name, .root-name, .root-path, .rule-sum, .upd-notes, .rel-body")) continue;
    // 语言选择器按惯例用母语写语言名（简体中文 / 日本語…），不跟随界面语言
    if (el.closest("[data-endonym]")) continue;
    add(el.tagName.toLowerCase(), n.nodeValue);
  }
  for (const el of document.querySelectorAll("[title], [placeholder], [aria-label]")) {
    for (const attr of ["title", "placeholder", "aria-label"]) {
      add(attr + ":" + el.tagName.toLowerCase(), el.getAttribute(attr));
    }
  }
  return [...new Set(out)];
})()`;

async function scan(label) {
  const hits = await app.page.eval(SCAN);
  assert.deepEqual(
    hits,
    [],
    `${label}里还有中文（英文界面不该出现）：\n` +
      hits.map((h) => `  · ${h}`).join("\n"),
  );
}

test("默认视图全英文", async () => {
  // 先确认真的切到英文了，否则这条测试会因为「界面是中文」而假失败/假通过
  const brand = await app.page.eval(
    `(document.body.innerText || "").includes("NameSeq")`,
  );
  assert.ok(brand, "界面没有切到英文（品牌名应显示 NameSeq）");
  await scan("默认视图");
});

test("添加文件后（预览表、状态徽章、计数）全英文", async () => {
  await app.page.click(".add-row .btn.primary");
  await app.page.waitFor('document.querySelectorAll(".trow").length > 0', {
    desc: "预览表出现数据行",
  });
  await scan("添加文件后的界面");
});

test("外观设置抽屉全英文", async () => {
  await app.page.eval(
    `window.dispatchEvent(new KeyboardEvent("keydown", {
       key: ",", ctrlKey: true, bubbles: true, cancelable: true,
     }))`,
  );
  await app.page.waitFor('document.querySelector(".drawer.show")', {
    desc: "设置抽屉打开",
  });
  await app.page.frames(3);
  await scan("外观设置抽屉");
  // 关掉，免得影响后面的用例
  await app.page.eval(
    `window.dispatchEvent(new KeyboardEvent("keydown", {
       key: "Escape", bubbles: true, cancelable: true,
     }))`,
  );
  await app.page.waitFor('!document.querySelector(".drawer.show")', {
    desc: "设置抽屉关闭",
  });
});

test("规则库浮层全英文", async () => {
  await app.page.click(".rules-toolbar .toolbar-btn", { index: 0 });
  await app.page.waitFor('document.querySelector(".pop-lib")', {
    desc: "规则库浮层出现",
  });
  await app.page.frames(3);
  await scan("规则库浮层");
});

test("预设浮层全英文", async () => {
  await app.page.click(".rules-toolbar .toolbar-btn", { index: 1 });
  await app.page.waitFor('document.querySelector(".pop-presets")', {
    desc: "预设浮层出现",
  });
  await app.page.frames(3);
  await scan("预设浮层");
});
