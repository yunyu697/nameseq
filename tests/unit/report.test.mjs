/**
 * 报告生成的单元测试（纯函数，不需要浏览器）。
 *
 * 这里守的是「导出的文件能被别的软件正确读进去」：
 *   - CSV 必须有 BOM（否则 Excel 打开中文全是乱码）
 *   - 含逗号/引号/换行的字段必须按 RFC 4180 转义，否则列会错位
 *   - 以 = + - @ 开头的单元格要加前导单引号（CSV 注入：Excel 会当公式算）
 *   - Markdown 的 `|` 会截断表格
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCsv,
  buildMarkdown,
  fileStamp,
  formatOf,
  reportFileName,
  reportRows,
  stamp,
} from "../../src/report.ts";

const T0 = 1_700_000_000_000; // 固定时间戳，避免用 now

function op(patch = {}) {
  return {
    id: 1,
    from: "C:\\w\\a.txt",
    to: "C:\\w\\b.txt",
    oldName: "a.txt",
    newName: "b.txt",
    status: "ok",
    reason: null,
    isDir: false,
    size: 1536,
    modifiedMs: T0,
    ...patch,
  };
}

test("CSV：带 BOM、表头、CRLF 行尾", () => {
  const csv = buildCsv([op()]);
  assert.ok(csv.startsWith("\ufeff"), "缺少 UTF-8 BOM，Excel 会乱码");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "\ufeff序号,状态,原文件名,新文件名,所在目录,大小,修改时间,说明");
  assert.equal(lines[1].split(",")[0], "1");
  assert.ok(csv.endsWith("\r\n"), "末尾应有换行");
});

test("CSV：含逗号/引号的字段被正确包裹与翻倍", () => {
  const csv = buildCsv([
    op({ oldName: 'a,"b".txt', newName: "c.txt" }),
  ]);
  assert.ok(
    csv.includes('"a,""b"".txt"'),
    `引号没有翻倍：\n${csv.split("\r\n")[1]}`,
  );
});

test("CSV：以 = 开头的文件名加前导单引号（防 CSV 注入）", () => {
  const csv = buildCsv([op({ oldName: "=1+1.txt" })]);
  assert.ok(csv.includes("'=1+1.txt"), `公式注入没拦住：\n${csv.split("\r\n")[1]}`);
});

test("CSV：换行也会被包进引号，不会把一行拆成两行", () => {
  const csv = buildCsv([op({ newName: "a\nb.txt" })]);
  assert.equal(csv.split("\r\n").length, 3, "一个换行被当成了行分隔");
});

test("报告行：目录取自 to 的父目录，大小人类可读", () => {
  const [r] = reportRows([op()]);
  assert.equal(r.no, 1);
  assert.equal(r.dir, "C:\\w");
  assert.equal(r.size, "1.5 KB");
  assert.match(r.mtime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(r.status, "可执行");
  assert.equal(r.note, "");
});

test("报告行：路径没有分隔符时目录为空，不能把文件名截掉一个字", () => {
  const [r] = reportRows([op({ to: "b.txt", from: "a.txt" })]);
  assert.equal(r.dir, "");
});

test("报告行：目录条目的 size / mtime 显示为 —（引擎不记录它们）", () => {
  const [r] = reportRows([
    op({ isDir: true, oldName: "old", newName: "new", to: "C:\\w\\new" }),
  ]);
  assert.equal(r.size, "—");
  assert.equal(r.mtime, "—");
  assert.equal(r.status, "可执行");
});

test("报告行：状态与说明按当前语言取值，失败原因原样带出", () => {
  const rows = reportRows([
    op({ status: "conflict", reason: "目标名重复" }),
    op({ status: "excluded" }),
  ]);
  assert.equal(rows[0].status, "冲突");
  assert.equal(rows[0].note, "目标名重复");
  assert.equal(rows[1].status, "已排除");
});

test("Markdown：有标题、汇总计数和表格行", () => {
  const md = buildMarkdown(
    [
      op(),
      op({ id: 2, status: "conflict", reason: "目标名重复" }),
      op({ id: 3, status: "unchanged" }),
      op({ id: 4, status: "excluded" }),
    ],
    new Date(T0),
  );
  assert.ok(md.startsWith("# 名序 · 改名报告\n"), "标题不对");
  assert.ok(md.includes("条目：4（可执行 1 · 冲突 1 · 非法 0 · 无变化 1 · 已排除 1）"),
    `汇总行不对：\n${md.split("\n").slice(0, 5).join("\n")}`);
  // 表头 + 4 行数据（分隔行以 `|---` 开头，不算）
  const rows = md.split("\n").filter((l) => l.startsWith("| "));
  assert.equal(rows.length, 1 + 4, `表格行数不对：${rows.length}`);
});

test("Markdown：单元格里的竖线和换行不会破表格", () => {
  const md = buildMarkdown([op({ oldName: "a|b.txt", newName: "c\nd.txt" })], new Date(T0));
  const dataRow = md.split("\n").find((l) => l.includes("a\\|b.txt"));
  assert.ok(dataRow, "竖线没有转义");
  // 转义后的 `\|` 仍是一个字符，要数「未转义的竖线」：8 列 = 9 条
  assert.equal(
    (dataRow.match(/(?<!\\)\|/g) ?? []).length,
    9,
    `列数不对（8 列 → 9 条未转义竖线）：\n${dataRow}`,
  );
  assert.ok(dataRow.includes("c d.txt"), "换行没有替换成空格");
});

test("文件名：格式与扩展名跟着格式走，不含冒号", () => {
  const d = new Date(2026, 9, 31, 22, 5); // 2026-10-31 22:05
  assert.equal(fileStamp(d), "20261031-2205");
  assert.equal(reportFileName("csv", d), "名序报告-20261031-2205.csv");
  assert.equal(reportFileName("md", d), "名序报告-20261031-2205.md");
});

test("格式判定：看扩展名，认不出按 CSV", () => {
  assert.equal(formatOf("C:\\out\\报告.md"), "md");
  assert.equal(formatOf("C:\\out\\报告.MD"), "md");
  assert.equal(formatOf("C:\\out\\报告.csv"), "csv");
  assert.equal(formatOf("C:\\out\\报告"), "csv");
});

test("时间戳：0 表示没有时间（目录），显示为破折号", () => {
  assert.equal(stamp(0), "—");
  assert.match(stamp(T0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
