/**
 * renameApply 的单元测试（纯函数，不需要浏览器）。
 *
 * 这里专测「重扫换原地更新」之后最容易出错的地方：路径前缀替换的边界、
 * 互换改名不能死循环、以及撤销结果里夹着的临时名必须被收掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyRenamed,
  makePathMapper,
  rebuildEntry,
  remapPaths,
} from "../../src/renameApply.ts";

/** 造一个条目（默认是文件） */
function entry(path, isDir = false) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dir = i < 0 ? "" : path.slice(0, i);
  const name = path.slice(i + 1);
  const dot = name.lastIndexOf(".");
  const hasExt = !isDir && dot > 0 && dot < name.length - 1;
  return {
    id: Math.abs(hash(path)),
    path,
    dir,
    name,
    stem: hasExt ? name.slice(0, dot) : name,
    ext: hasExt ? name.slice(dot + 1) : "",
    size: 1,
    modifiedMs: 1,
    isDir,
    error: null,
  };
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

const ok = (from, to, id = Math.abs(hash(from))) => ({ id, from, to, ok: true, error: null });
const bad = (from, to, id = Math.abs(hash(from))) => ({
  id,
  from,
  to,
  ok: false,
  error: "占用",
});

test("单个文件改名：只动命中的那条，其余条目原引用不变", () => {
  const a = entry("C:\\w\\a.txt");
  const b = entry("C:\\w\\b.txt");
  const out = applyRenamed([a, b], [ok("C:\\w\\a.txt", "C:\\w\\x_a.txt")]);
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "C:\\w\\x_a.txt");
  assert.equal(out[0].name, "x_a.txt");
  assert.equal(out[0].stem, "x_a");
  assert.equal(out[0].ext, "txt");
  assert.equal(out[1], b, "没被改名的条目应保持同一个对象引用");
});

test("没有任何成功结果时返回原数组（不触发多余渲染）", () => {
  const list = [entry("C:\\w\\a.txt")];
  const out = applyRenamed(list, [bad("C:\\w\\a.txt", "C:\\w\\b.txt")]);
  assert.equal(out, list);
});

test("失败结果不参与映射：改不成的文件路径保持原样", () => {
  const out = applyRenamed(
    [entry("C:\\w\\a.txt"), entry("C:\\w\\b.txt")],
    [ok("C:\\w\\a.txt", "C:\\w\\A.txt"), bad("C:\\w\\b.txt", "C:\\w\\B.txt")],
  );
  assert.deepEqual(
    out.map((e) => e.path),
    ["C:\\w\\A.txt", "C:\\w\\b.txt"],
  );
});

test("目录改名：子项前缀跟着换，深层目录也正确（深到浅）", () => {
  const entries = [
    entry("C:\\w\\A", true),
    entry("C:\\w\\A\\B", true),
    entry("C:\\w\\A\\B\\f.txt"),
    entry("C:\\w\\A\\g.txt"),
  ];
  const out = applyRenamed(entries, [
    ok("C:\\w\\A", "C:\\w\\A2", 1),
    ok("C:\\w\\A\\B", "C:\\w\\A2\\B2", 2),
  ]);
  assert.deepEqual(
    out.map((e) => e.path),
    ["C:\\w\\A2", "C:\\w\\A2\\B2", "C:\\w\\A2\\B2\\f.txt", "C:\\w\\A2\\g.txt"],
  );
});

test("前缀替换严格按分隔符判定：A 改名不波及 A2", () => {
  const out = applyRenamed(
    [entry("C:\\w\\A2\\keep.txt"), entry("C:\\w\\A\\take.txt")],
    [ok("C:\\w\\A", "C:\\w\\Z", 1)],
  );
  assert.deepEqual(
    out.map((e) => e.path),
    ["C:\\w\\A2\\keep.txt", "C:\\w\\Z\\take.txt"],
  );
});

test("互换改名（a→b、b→a）不会顺着链条循环", () => {
  const out = applyRenamed(
    [entry("C:\\w\\a.txt"), entry("C:\\w\\b.txt")],
    [ok("C:\\w\\a.txt", "C:\\w\\b.txt", 1), ok("C:\\w\\b.txt", "C:\\w\\a.txt", 2)],
  );
  assert.deepEqual(
    out.map((e) => e.path),
    ["C:\\w\\b.txt", "C:\\w\\a.txt"],
  );
});

test("撤销结果里的临时名两跳收成一跳（原名→.rnm-…→最终名）", () => {
  // 执行时日志记的是「原名 → 临时名」「临时名 → 最终名」，撤销把它们反着回放，
  // 所以结果里会出现 from=最终名 to=临时名、from=临时名 to=原名 两对
  const map = makePathMapper([
    ok("C:\\w\\new.txt", "C:\\w\\.rnm-b1-0", 1),
    ok("C:\\w\\.rnm-b1-0", "C:\\w\\old.txt", 2),
  ]);
  assert.equal(map("C:\\w\\new.txt"), "C:\\w\\old.txt");
  assert.equal(map("C:\\w\\.rnm-b1-0"), "C:\\w\\old.txt");
});

test("崩溃现场：列表里存的是临时名，也能映射回原名", () => {
  const out = applyRenamed(
    [entry("C:\\w\\.rnm-b1-0")],
    [ok("C:\\w\\.rnm-b1-0", "C:\\w\\old.txt", 2)],
  );
  assert.deepEqual(
    out.map((e) => e.path),
    ["C:\\w\\old.txt"],
  );
});

test("撤销目录改名：子项从新目录回到旧目录", () => {
  const out = applyRenamed(
    [entry("C:\\w\\A2\\B\\f.txt")],
    [
      ok("C:\\w\\A2\\B", "C:\\w\\A2\\.rnm-b1-1", 1),
      ok("C:\\w\\A2\\.rnm-b1-1", "C:\\w\\A\\B", 2),
      ok("C:\\w\\A2", "C:\\w\\A", 3),
    ],
  );
  assert.deepEqual(
    out.map((e) => e.path),
    ["C:\\w\\A\\B\\f.txt"],
  );
});

test("目录条目重建后 ext 恒为空、stem 等于目录名", () => {
  const d = rebuildEntry(entry("C:\\w\\old", true), "C:\\w\\new.dir");
  assert.equal(d.name, "new.dir");
  assert.equal(d.stem, "new.dir");
  assert.equal(d.ext, "");
  assert.equal(d.dir, "C:\\w");
});

test("根目录本身被改名时，「已添加的位置」也要跟着换", () => {
  const roots = ["C:\\w\\A", "C:\\w\\Other"];
  const out = remapPaths(roots, [ok("C:\\w\\A", "C:\\w\\A2", 1)]);
  assert.deepEqual(out, ["C:\\w\\A2", "C:\\w\\Other"]);
  assert.notEqual(out, roots, "有变化时应返回新数组");
});

test("remapPaths 没变化时返回原数组", () => {
  const roots = ["C:\\w\\A"];
  assert.equal(remapPaths(roots, [ok("C:\\x\\B", "C:\\x\\C", 1)]), roots);
});
