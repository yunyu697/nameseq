/**
 * 生成多平台合并的 latest.json（Tauri 自动更新清单）。
 *
 * 为什么需要它：updater 的端点是
 *   https://github.com/yunyu697/nameseq/releases/latest/download/latest.json
 * 一个文件要同时服务三个平台，所以清单里必须有 windows-x86_64 /
 * darwin-* / linux-x86_64 三条，各带自己的签名。以前只有 Windows 会写
 * latest.json，macOS 和 Linux 的用户永远收不到更新。
 *
 * 用法（CI 里由 release.yml 调用，本地也能单独跑）：
 *   node scripts/latest.mjs --version 0.9.3 --dir release-assets
 *   node scripts/latest.mjs --version 0.9.3 --notes "修了 xxx" --base https://...
 *
 * 找不到某个平台的包时只警告、不失败：本地只装了 Windows 工具链时也能出清单。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 各平台的更新包文件名模式（productName = nameseq） */
function candidates(version) {
  return [
    {
      platform: "windows-x86_64",
      // Tauri 在 Windows 上用 NSIS 安装包做增量更新载体，不是 msi
      file: `nameseq_${version}_x64-setup.exe`,
    },
    {
      platform: "darwin-aarch64",
      file: "nameseq.app.tar.gz",
      alt: `nameseq_${version}_aarch64.app.tar.gz`,
    },
    {
      platform: "darwin-x86_64",
      file: `nameseq_${version}_x64.app.tar.gz`,
    },
    {
      platform: "linux-x86_64",
      file: `nameseq_${version}_amd64.AppImage`,
    },
  ];
}

/** macOS 的包名不带架构，得由调用方说明（CI 的 macos-latest 是 arm64） */
function resolveMacPlatform(name, macArch) {
  if (name.startsWith("darwin-x86_64")) return "darwin-x86_64";
  return macArch === "x86_64" ? "darwin-x86_64" : "darwin-aarch64";
}

/**
 * @param {object} opts
 * @param {string} opts.dir       产物目录
 * @param {string} opts.version   纯版本号（不带 v）
 * @param {string} [opts.notes]   发版说明；缺省时沿用目录里已有 latest.json 的
 * @param {string} [opts.base]    下载地址前缀
 * @param {string} [opts.macArch] macOS 架构（aarch64 | x86_64）
 * @returns {{ latest: object, used: string[], missing: string[] }}
 */
export function buildLatest({
  dir,
  version,
  notes = "",
  base,
  macArch = "aarch64",
}) {
  const baseUrl =
    base?.replace(/\/$/, "") ??
    `https://github.com/yunyu697/nameseq/releases/download/v${version}`;

  const files = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const platforms = {};
  const used = [];
  const missing = [];

  for (const c of candidates(version)) {
    const name = [c.file, c.alt].find((f) => f && files.has(f));
    if (!name) {
      // darwin-x86_64 与 darwin-aarch64 是二选一，缺一个不算问题
      missing.push(c.platform);
      continue;
    }
    const sig = `${name}.sig`;
    if (!files.has(sig)) {
      missing.push(`${c.platform}（缺 ${sig}）`);
      continue;
    }
    const platform =
      c.platform.startsWith("darwin") && !/x64|x86_64/.test(name)
        ? resolveMacPlatform(c.platform, macArch)
        : c.platform;
    platforms[platform] = {
      signature: readFileSync(join(dir, sig), "utf8").trim(),
      url: `${baseUrl}/${encodeURIComponent(name)}`,
    };
    used.push(`${platform} ← ${name}`);
  }

  // notes 缺省时沿用目录里已有的清单，免得本地重跑把发版说明抹掉
  let finalNotes = notes;
  const prevFile = join(dir, "latest.json");
  if (!finalNotes && existsSync(prevFile)) {
    try {
      finalNotes = JSON.parse(readFileSync(prevFile, "utf8")).notes ?? "";
    } catch {
      /* 旧文件坏了就空着 */
    }
  }
  // 压成单行：这条文案会显示在客户端「检查更新」里，换行只会让提示更难读。
  // 而且多行参数过 Windows 的 cmd 时会被截到第一行——本地发版就踩过，
  // 清单里只剩第一段，还不报错。CI 那边也做同样的压缩，两边行为要一致。
  finalNotes = String(finalNotes).replace(/\s+/g, " ").trim();

  const latest = {
    version,
    notes: finalNotes,
    pub_date: new Date().toISOString(),
    platforms,
  };
  // darwin 两个候选是二选一：只要有一条 darwin 记录，另一个不算「缺」
  const hasMac = Object.keys(platforms).some((p) => p.startsWith("darwin"));
  const realMissing = missing.filter(
    (m) => !(m in platforms) && !(hasMac && m.startsWith("darwin")),
  );
  return { latest, used, missing: realMissing };
}

/** 写清单并打印一份人看的摘要 */
export function writeLatest(opts) {
  const { latest, used, missing } = buildLatest(opts);
  const out = join(opts.dir, "latest.json");
  writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  return { out, latest, used, missing };
}

/* ---------------- 命令行入口 ---------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    // --mac-arch → macArch，命令行习惯与 JS 命名两边都照顾
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? (i++, next) : true;
  }
  return out;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = String(args.version ?? pkg.version);
  // 允许绝对路径（CI 里 --dir 指向 runner 的临时目录）
  const dir = resolve(ROOT, String(args.dir ?? "dist-release"));
  const notes = typeof args.notes === "string" ? args.notes : "";
  const { out, latest, used, missing } = writeLatest({
    dir,
    version,
    notes,
    base: typeof args.base === "string" ? args.base : undefined,
    macArch: typeof args.macArch === "string" ? args.macArch : "aarch64",
  });

  console.log(`✓ latest.json（${version}）→ ${out}`);
  for (const u of used) console.log(`  · ${u}`);
  for (const m of missing) console.log(`  ! 没有产物：${m}`);
  console.log(`  平台数：${Object.keys(latest.platforms).length}`);
  if (Object.keys(latest.platforms).length === 0) {
    console.error("✗ 一个平台都没找到，清单是空的");
    process.exit(1);
  }
}
