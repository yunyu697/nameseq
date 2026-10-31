/**
 * 让 Node 能直接 import `src/` 里的模块。
 *
 * 两个障碍：
 *   1. `src/` 里是 Vite 风格的无扩展名导入（`import { t } from "./i18n"`），
 *      Node 的 ESM 解析器要求写全扩展名，会直接 ERR_MODULE_NOT_FOUND
 *   2. TypeScript 源码靠 Node 22 的类型擦除跑（--experimental-strip-types）
 *
 * 这个钩子只补第一条：遇到相对路径且没有扩展名的导入，依次试 .ts / .tsx / index.ts。
 * 不改 `src/` 里的写法——给测试让步去污染业务代码不值得。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HAS_EXT = /\.[cm]?[jt]sx?$/i;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !HAS_EXT.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    for (const cand of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const url = new URL(base.href + cand);
      if (existsSync(fileURLToPath(url))) {
        return next(specifier + cand, context);
      }
    }
  }
  return next(specifier, context);
}
