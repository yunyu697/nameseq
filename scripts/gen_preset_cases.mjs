// 从 src/presets.ts 抽出所有模板与正则，交给 Rust 引擎逐条编译验证。
// 目的：预设是写死的常量，语法写错时用户点下去才发现，得不偿失。
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("src/presets.ts", "utf8");

const grab = (key) => {
  const re = new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(JSON.parse(`"${m[1]}"`));
  return out;
};

const templates = grab("template");
const patterns = grab("pattern");
const finds = grab("find");

const payload = { templates, patterns, finds };
writeFileSync("crates/renamer-core/tests/preset_cases.json", JSON.stringify(payload, null, 2));
console.log(
  `templates=${templates.length} patterns=${patterns.length} finds=${finds.length}`,
);
console.log("templates:", templates.join(" | "));
console.log("patterns:", JSON.stringify(patterns));
console.log("finds:", JSON.stringify(finds));
