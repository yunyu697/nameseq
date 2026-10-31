/**
 * 执行前报告：把预览清单导成 CSV / Markdown，用于交付与审计。
 *
 * 设计取舍：
 *   - **只导清单，不导规则**。规则链有 .nsq（可回放），报告要给的是「谁被改成什么」，
 *     两者的读者不同：.nsq 是给名序自己用的，报告是给人/审计看的。
 *   - **CSV 只放表头 + 数据行**，不写标题和汇总——加一行标题就没法直接喂给表格软件了。
 *     汇总信息放进 Markdown（那份是给人读的）。
 *   - CSV 带 UTF-8 BOM：Excel 双击打开中文不乱码，这是 Windows 用户的第一反应动作。
 *   - 大小用人类可读（1.2 MB），时间用本地时区的 `YYYY-MM-DD HH:mm:ss`。
 *     审计场景要的是「看得懂」，精确到字节没意义。
 *
 * 纯函数、不碰文件系统：真正的写盘在 App 里走 dialog + write_text_file，
 * 这样这份逻辑能在 tests/unit 里直接单测。
 */
import { t } from "./i18n";
import { STATUS_LABEL, type OpStatus, type RenameOp } from "./types";
import { humanSize } from "./util";

export type ReportFormat = "csv" | "md";

/** 报告的一行（已经格式化好，CSV / Markdown 共用） */
export interface ReportRow {
  no: number;
  status: string;
  oldName: string;
  newName: string;
  dir: string;
  size: string;
  mtime: string;
  note: string;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** 本地时区的 `YYYY-MM-DD HH:mm:ss`；0 表示没有时间（目录条目） */
export function stamp(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 文件名里的时间戳（不带分隔符，避免某些系统不认冒号） */
export function fileStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

export function reportRows(ops: RenameOp[]): ReportRow[] {
  return ops.map((o, i) => {
    const cut = Math.max(o.to.lastIndexOf("\\"), o.to.lastIndexOf("/"));
    return {
      no: i + 1,
      status: STATUS_LABEL[o.status as OpStatus] ?? o.status,
      oldName: o.oldName,
      newName: o.newName,
      dir: cut > 0 ? o.to.slice(0, cut) : "",
      // 目录的 size/mtime 不参与执行校验（引擎铁律），报告里也不假装有
      size: o.isDir ? "—" : humanSize(o.size),
      mtime: o.isDir ? "—" : stamp(o.modifiedMs),
      note: o.reason ?? "",
    };
  });
}

export const CSV_HEADER = () => [
  t("序号"),
  t("状态"),
  t("原文件名"),
  t("新文件名"),
  t("所在目录"),
  t("大小"),
  t("修改时间"),
  t("说明"),
];

/**
 * CSV 转义：含逗号/引号/换行的字段用双引号包起来，内部引号翻倍（RFC 4180）。
 * 另外把前导 `=`/`+`/`-`/`@` 的单元格加一个前导单引号——文件名以 `=` 开头时，
 * Excel 会当成公式求值，那是真会出事的（CSV 注入）。
 */
function csvCell(v: string): string {
  let s = v;
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(ops: RenameOp[]): string {
  const lines = [CSV_HEADER().map(csvCell).join(",")];
  for (const r of reportRows(ops)) {
    lines.push(
      [String(r.no), r.status, r.oldName, r.newName, r.dir, r.size, r.mtime, r.note]
        .map(csvCell)
        .join(","),
    );
  }
  // BOM：Excel 靠它识别 UTF-8，否则中文列名会变乱码
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

/** Markdown 表格里 `|` 会截断单元格，换行会破表格，都得转义 */
function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function buildMarkdown(ops: RenameOp[], now = new Date()): string {
  const rows = reportRows(ops);
  const count = (s: OpStatus) => ops.filter((o) => o.status === s).length;
  const summary = [
    t("可执行"),
    t("冲突"),
    t("非法"),
    t("无变化"),
    t("已排除"),
  ]
    .map((label, i) => {
      const n = [
        count("ok"),
        count("conflict"),
        count("invalid"),
        count("unchanged"),
        count("excluded"),
      ][i];
      return `${label} ${n}`;
    })
    .join(" · ");

  const out: string[] = [
    `# ${t("名序 · 改名报告")}`,
    "",
    `- ${t("生成时间")}：${stamp(now.getTime())}`,
    `- ${t("条目")}：${ops.length}（${summary}）`,
    "",
    `| ${t("序号")} | ${t("状态")} | ${t("原文件名")} | ${t("新文件名")} | ${t(
      "所在目录",
    )} | ${t("大小")} | ${t("修改时间")} | ${t("说明")} |`,
    "|---:|---|---|---|---|---:|---|---|",
  ];
  for (const r of rows) {
    out.push(
      `| ${r.no} | ${mdCell(r.status)} | ${mdCell(r.oldName)} | ${mdCell(
        r.newName,
      )} | ${mdCell(r.dir)} | ${mdCell(r.size)} | ${mdCell(r.mtime)} | ${mdCell(
        r.note,
      )} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

/** 按格式生成文件名（不含目录） */
export function reportFileName(format: ReportFormat, d = new Date()): string {
  return `${t("名序报告")}-${fileStamp(d)}.${format}`;
}

/** 按保存对话框返回的扩展名决定格式，认不出就按 CSV */
export function formatOf(path: string): ReportFormat {
  return /\.md$/i.test(path) ? "md" : "csv";
}
