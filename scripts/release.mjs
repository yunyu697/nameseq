#!/usr/bin/env node
/**
 * 一键发布。
 *
 *   npm run release 0.6.0                 # 只改版本号（4 处），不打包
 *   npm run release 0.6.0 -- --build      # 改版本 + 签名打包 + 生成 latest.json
 *   npm run release 0.6.0 -- --build --notes "修了中文排序"
 *
 * 为什么要有这个脚本：版本号散在 package.json、tauri.conf.json 和两个 Cargo.toml 里，
 * 手改一定漏；漏了的后果是「安装包叫 0.6.0、程序里显示 0.5.0、自动更新比对的是 0.4.0」。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist-release");
const KEY = join(ROOT, ".keys", "nameseq.key");

const argv = process.argv.slice(2);
const notesIdx = argv.indexOf("--notes");
// 版本号是第一个不以 - 开头的参数，但要排掉 --notes 后面那句说明
const notesAt = notesIdx >= 0 ? notesIdx + 1 : -1;
const version = argv.find((a, i) => !a.startsWith("-") && i !== notesAt);
const build = argv.includes("--build");
const notes = notesIdx >= 0 ? argv[notesAt] ?? "" : "";

/** 需要同步版本号的四个文件 */
const TARGETS = [
  { path: "package.json", kind: "json" },
  { path: "src-tauri/tauri.conf.json", kind: "json" },
  { path: "src-tauri/Cargo.toml", kind: "cargo" },
  { path: "crates/nameseq-cli/Cargo.toml", kind: "cargo" },
];

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!version) {
  die("用法：npm run release <版本号> [-- --build] [-- --notes \"更新说明\"]\n     例：npm run release 0.6.0 -- --build");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  die(`版本号要写成 x.y.z，收到的是「${version}」`);
}

/* ---------- 1. 改版本号 ---------- */

const changed = [];
for (const t of TARGETS) {
  const abs = join(ROOT, t.path);
  const before = readFileSync(abs, "utf8");
  let after;
  if (t.kind === "json") {
    // 先解析一遍确认文件没坏，但**不要**重新序列化：JSON.stringify 会把
    // 一行写完的数组拆成多行，每次发版都多出一堆无关 diff
    const obj = JSON.parse(before);
    if (obj.version === version) continue;
    after = before.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
    if (after === before) continue;
  } else {
    // 只替换 [package] 段里的第一处 version，避免动到依赖的版本
    after = before.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
    if (after === before) continue;
  }
  writeFileSync(abs, after);
  changed.push(t.path);
}
console.log(changed.length ? `版本号 → ${version}\n  改动：${changed.join("、")}` : `版本号已经是 ${version}`);

if (!build) {
  console.log("\n没加 --build，只改了版本号。要打包就再跑：");
  console.log(`  npm run release ${version} -- --build`);
  process.exit(0);
}

/* ---------- 2. 签名打包 ---------- */

if (!existsSync(KEY)) {
  die(
    `找不到签名私钥 ${KEY}\n` +
      "  自动更新的安装包必须签名。先生成一次：\n" +
      "    npx tauri signer generate -w ./.keys/nameseq.key -p \"\" --ci"
  );
}

console.log("\n开始打包（release 全量编译约 3–5 分钟）…\n");
try {
  execFileSync("npm", ["run", "tauri", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true, // Windows 上 npm 是 .cmd
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: KEY,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    },
  });
} catch (e) {
  die(`打包失败：${e.message}`);
}

/* ---------- 3. 收集产物 + 生成 latest.json ---------- */

const rel = join(ROOT, "src-tauri", "target", "release");
const nsisDir = join(rel, "bundle", "nsis");
const msiDir = join(rel, "bundle", "msi");
const setupName = `nameseq_${version}_x64-setup.exe`;
const setup = join(nsisDir, setupName);
const sigFile = `${setup}.sig`;

if (!existsSync(setup) || !existsSync(sigFile)) {
  die(`没找到安装包或签名：${setup}\n  检查 tauri.conf.json 里 bundle.createUpdaterArtifacts 是否为 true`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const src of [setup, sigFile, join(msiDir, `nameseq_${version}_x64_zh-CN.msi`)]) {
  if (existsSync(src)) copyFileSync(src, join(OUT_DIR, src.split(/[\\/]/).pop()));
}

const base =
  process.env.NSQ_UPDATE_BASE?.replace(/\/$/, "") ??
  `https://github.com/yunyu697/nameseq/releases/download/v${version}`;

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigFile, "utf8").trim(),
      // 中文文件名在 URL 里要编码，否则某些 CDN 会 404
      url: `${base}/${encodeURIComponent(setupName)}`,
    },
  },
};
writeFileSync(join(OUT_DIR, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);

console.log(`
✓ ${version} 打包完成

产物（已收进 dist-release/）：
  ${setupName}
  ${setupName}.sig
  latest.json

发布步骤：
  1. 把 dist-release/ 里的三个文件传到更新服务器
  2. 确认 ${base}/${setupName} 能下载
  3. 更新服务器上的 latest.json 换成本次生成的这份
  4. 老版本客户端「检查更新」就会看到 ${version}
`);
