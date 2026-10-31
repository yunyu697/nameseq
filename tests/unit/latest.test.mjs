/**
 * 多平台 latest.json 的合并逻辑（scripts/latest.mjs）。
 *
 * 为什么值得单独测：这份清单是自动更新的唯一入口，端点固定为
 * releases/latest/download/latest.json，一个文件要同时服务三个平台。
 * 写错的表现是「Windows 能更新、mac/Linux 永远收不到」——线上没人报，
 * 只在用户的机器上默默失效，所以平台键名、签名来源、URL 拼法都得钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLatest, writeLatest } from "../../scripts/latest.mjs";

const VER = "1.2.3";

/** 造一个产物目录；entries 里的每个名字都会写一个内容为 SIG-<name> 的文件 */
function fixture(names) {
  const dir = mkdtempSync(join(tmpdir(), "nsq-latest-"));
  for (const n of names) writeFileSync(join(dir, n), `SIG-${n}`);
  return dir;
}

const WIN = [`nameseq_${VER}_x64-setup.exe`, `nameseq_${VER}_x64-setup.exe.sig`];
const MAC = ["nameseq.app.tar.gz", "nameseq.app.tar.gz.sig"];
const LINUX = [
  `nameseq_${VER}_amd64.AppImage`,
  `nameseq_${VER}_amd64.AppImage.sig`,
];

test("三平台齐全时，清单里有三条平台记录", () => {
  const dir = fixture([...WIN, ...MAC, ...LINUX, `nameseq_${VER}_x64_zh-CN.msi`]);
  const { latest, missing } = buildLatest({ dir, version: VER, notes: "x" });
  assert.deepEqual(Object.keys(latest.platforms).sort(), [
    "darwin-aarch64",
    "linux-x86_64",
    "windows-x86_64",
  ]);
  assert.deepEqual(missing, []);
  rmSync(dir, { recursive: true, force: true });
});

test("Windows 用 NSIS 安装包（不是 msi）做更新载体", () => {
  const dir = fixture([...WIN, ...MAC, ...LINUX]);
  const { latest } = buildLatest({ dir, version: VER });
  assert.match(latest.platforms["windows-x86_64"].url, /_x64-setup\.exe$/);
  assert.doesNotMatch(latest.platforms["windows-x86_64"].url, /\.msi$/);
  rmSync(dir, { recursive: true, force: true });
});

test("签名取自同名 .sig 文件，不是空串", () => {
  const dir = fixture([...WIN, ...MAC, ...LINUX]);
  const { latest } = buildLatest({ dir, version: VER });
  assert.equal(
    latest.platforms["linux-x86_64"].signature,
    `SIG-nameseq_${VER}_amd64.AppImage.sig`,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("URL 指向 tag 对应的 release 资源", () => {
  const dir = fixture([...WIN, ...MAC, ...LINUX]);
  const { latest } = buildLatest({ dir, version: VER });
  for (const p of Object.values(latest.platforms)) {
    assert.ok(
      p.url.startsWith(
        `https://github.com/yunyu697/nameseq/releases/download/v${VER}/`,
      ),
      `URL 不对：${p.url}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

test("macOS 的包名不带架构，由 macArch 决定平台键", () => {
  const dir = fixture([...MAC]);
  assert.deepEqual(
    Object.keys(buildLatest({ dir, version: VER, macArch: "aarch64" }).latest.platforms),
    ["darwin-aarch64"],
  );
  assert.deepEqual(
    Object.keys(buildLatest({ dir, version: VER, macArch: "x86_64" }).latest.platforms),
    ["darwin-x86_64"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("macOS 包名里带架构时以文件名为准", () => {
  const dir = fixture([
    `nameseq_${VER}_x64.app.tar.gz`,
    `nameseq_${VER}_x64.app.tar.gz.sig`,
  ]);
  const { latest } = buildLatest({ dir, version: VER, macArch: "aarch64" });
  assert.deepEqual(Object.keys(latest.platforms), ["darwin-x86_64"]);
  rmSync(dir, { recursive: true, force: true });
});

test("只有 Windows 产物时不报错，只缺其它平台", () => {
  const dir = fixture(WIN);
  const { latest, missing } = buildLatest({ dir, version: VER });
  assert.deepEqual(Object.keys(latest.platforms), ["windows-x86_64"]);
  assert.ok(missing.includes("linux-x86_64"));
  rmSync(dir, { recursive: true, force: true });
});

test("有包但没有 .sig 时不算该平台（宁可缺，不可给出无签名清单）", () => {
  const dir = fixture([`nameseq_${VER}_amd64.AppImage`]);
  const { latest, missing } = buildLatest({ dir, version: VER });
  assert.equal(latest.platforms["linux-x86_64"], undefined);
  assert.ok(
    missing.some((m) => m.includes("linux-x86_64") && m.includes(".sig")),
    `缺签名要明说，实际：${JSON.stringify(missing)}`,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("不传 notes 时沿用目录里已有清单的说明", () => {
  const dir = fixture(WIN);
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify({ version: "1.2.2", notes: "上一版的说明", platforms: {} }),
  );
  const { latest } = buildLatest({ dir, version: VER });
  assert.equal(latest.notes, "上一版的说明");
  rmSync(dir, { recursive: true, force: true });
});

test("传了 notes 就以传入的为准", () => {
  const dir = fixture(WIN);
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify({ version: "1.2.2", notes: "旧说明", platforms: {} }),
  );
  const { latest } = buildLatest({ dir, version: VER, notes: "新说明" });
  assert.equal(latest.notes, "新说明");
  rmSync(dir, { recursive: true, force: true });
});

test("writeLatest 落盘的是可解析的 JSON，且带 pub_date", () => {
  const dir = fixture([...WIN, ...MAC, ...LINUX]);
  const { out } = writeLatest({ dir, version: VER, notes: "落盘" });
  const parsed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(parsed.version, VER);
  assert.equal(parsed.notes, "落盘");
  assert.ok(!Number.isNaN(Date.parse(parsed.pub_date)), "pub_date 应是合法时间");
  rmSync(dir, { recursive: true, force: true });
});
