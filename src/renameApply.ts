/**
 * 改完名之后，把新路径写回已加载的列表。
 *
 * 为什么需要它：以前执行成功后会 `refresh()` 全量重扫。重扫能拿到正确路径，
 * 但代价是丢掉三样东西——手动拖拽的排序、逐个文件的排除勾选、以及大目录的扫描时间。
 * 这里直接按执行结果原地改，列表状态一点不丢。
 *
 * 三条必须遵守的规则：
 *
 * 1. **文件走精确替换、目录走前缀替换**。文件的 from 是改名前的完整路径，直接查表；
 *    目录还得把它下面所有子项的路径前缀一起换掉。
 *
 * 2. **目录从深到浅替换**。A 里含 A/B，先换 A/B→A2/B2 再换 A→A2；
 *    反过来先换父目录的话，子目录的旧前缀已经不存在了，子项会漏改。
 *
 * 3. **替换必须是「并行」的，不能顺着链条一路走到底**。同一批里 a→b、b→a 这种互换
 *    （改名引擎用临时名正是为了支持它）如果顺着 Map 链式追下去会 A→B→A 无限循环。
 *    所以精确替换只查一次表。
 *
 * 唯一的例外是**临时名**：撤销/崩溃恢复的结果来自日志，日志里每一步都是
 * `原名 → .rnm-<批次>-<序号> → 最终名`，两跳。不把这一跳收掉，前端会拿到一堆临时名。
 * 因此：只允许穿过临时名做链式收敛，普通名字绝不二次查表——这样既能收掉日志里的中间步，
 * 又不会把互换改坏。
 */
import type { FileEntry, OpResult } from "./types";

const SEP = /[\\/]/;

/** 引擎的临时名格式（executor.rs 的 temp_path）：同目录下的 .rnm-<batch>-<i> */
const TEMP_RE = /^\.rnm-/;

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i < 0 ? p : p.slice(i + 1);
}

function isTempName(p: string): boolean {
  return TEMP_RE.test(baseName(p));
}

function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

function depth(p: string): number {
  let n = 0;
  for (const ch of p) if (ch === "\\" || ch === "/") n++;
  return n;
}

/** 严格子项判定：p 在 dir 之下，且下一个字符是分隔符（避免 A 匹配到 A2） */
function isUnder(p: string, dir: string): boolean {
  return p.length > dir.length && p.startsWith(dir) && SEP.test(p[dir.length]);
}

/** 用新路径重建条目。目录的 ext 恒为空、stem = 目录名（引擎铁律） */
export function rebuildEntry(e: FileEntry, path: string): FileEntry {
  const { dir, name } = splitPath(path);
  if (e.isDir) return { ...e, path, dir, name, stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1;
  return {
    ...e,
    path,
    dir,
    name,
    stem: hasExt ? name.slice(0, dot) : name,
    ext: hasExt ? name.slice(dot + 1) : "",
  };
}

/**
 * 根据执行结果造一个「旧路径 → 新路径」的映射函数。
 *
 * 只吃 results，不需要 ops：撤销和崩溃恢复在前端拿不到 ops（后端只按批次号读日志），
 * 但结果里的 from/to 已经够用了。失败的结果不参与映射，所以没改成的文件保持原路径。
 */
export function makePathMapper(results: OpResult[]): (p: string) => string {
  const ok = results.filter((r) => r.ok);

  // 原始一步一跳的映射，只用来把日志里的「原名→临时名→最终名」收成一跳
  const nextOf = new Map<string, string>();
  for (const r of ok) nextOf.set(r.from, r.to);

  const resolved = new Map<string, string>();
  for (const r of ok) {
    let to = nextOf.get(r.from) ?? r.to;
    // 只有临时名允许继续往后追；追到非临时名立刻停（见文件头第 3 条）
    for (let guard = 0; guard < 64 && isTempName(to); guard++) {
      const nxt = nextOf.get(to);
      if (nxt === undefined) break; // 卡在临时名上：这就是磁盘的真实现状
      to = nxt;
    }
    resolved.set(r.from, to);
  }

  // 深到浅，避免父目录先替换把子目录的旧前缀抹掉
  const subs = [...resolved.entries()].sort((a, b) => depth(b[0]) - depth(a[0]));

  return (p: string) => {
    let out = resolved.get(p) ?? p; // 精确替换只查一次表
    for (const [from, to] of subs) {
      if (isUnder(out, from)) out = to + out.slice(from.length);
    }
    return out;
  };
}

/** 把执行结果应用到列表上；没有变化时返回原数组，免得触发多余渲染 */
export function applyRenamed(entries: FileEntry[], results: OpResult[]): FileEntry[] {
  if (!results.some((r) => r.ok)) return entries;
  const map = makePathMapper(results);
  let changed = false;
  const out = entries.map((e) => {
    const next = map(e.path);
    if (next === e.path) return e;
    changed = true;
    return rebuildEntry(e, next);
  });
  return changed ? out : entries;
}

/** 同样地重映射一组路径（用于「已添加的位置」：根目录本身也可能被改名） */
export function remapPaths(paths: string[], results: OpResult[]): string[] {
  if (!results.some((r) => r.ok)) return paths;
  const map = makePathMapper(results);
  let changed = false;
  const out = paths.map((p) => {
    const next = map(p);
    if (next !== p) changed = true;
    return next;
  });
  return changed ? out : paths;
}
