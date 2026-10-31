/**
 * UI 测试 harness：零依赖（Node 22 自带 WebSocket + 项目自带 vite）。
 *
 * 为什么不用 Playwright：
 *   - 要额外下 ~150MB chromium；本机已有 Chrome，且项目历来就是 Chrome + CDP 验证
 *   - 这里只需要「加载页面 + 读 DOM 几何 + 发真实指针事件」，用不到它的大部分能力
 *
 * 关键点：
 *   - vite 用编程式 API 起在 port 0（系统分配），每个测试文件自包含、无端口冲突
 *   - Chrome 用 --remote-debugging-port=0，端口从 <user-data-dir>/DevToolsActivePort 读，
 *     避免固定端口被别的实例占用
 *   - 走 browser 级 WebSocket + Target.attachToTarget(flatten)，所有页面命令带 sessionId
 *   - mock 用 Page.addScriptToEvaluateOnNewDocument 注入，必须早于任何页面脚本
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ARTIFACT_DIR = join(ROOT, "tests", "ui", ".artifacts");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      "找不到 Chrome。设 CHROME_PATH 环境变量，或安装 Chrome/Chromium。",
    );
  }
  return hit;
}

/** 极简 CDP 客户端（browser 级连接，页面命令靠 sessionId 分发） */
class Cdp {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url, timeoutMs = 10_000) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("连接 DevTools WebSocket 超时")),
        timeoutMs,
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`DevTools WebSocket 连接失败：${url}`));
      });
    });
    return cdp;
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const slot = this.#pending.get(msg.id);
        if (!slot) return;
        this.#pending.delete(msg.id);
        if (msg.error) {
          slot.reject(
            new Error(`${slot.method}: ${msg.error.message ?? "CDP 错误"}`),
          );
        } else {
          slot.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const slot of this.#pending.values()) {
        slot.reject(new Error("DevTools 连接已断开"));
      }
      this.#pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn) {
    const list = this.#listeners.get(method) ?? [];
    list.push(fn);
    this.#listeners.set(method, list);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* 已关 */
    }
  }
}

/** 一个页面的操作封装 */
export class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** 在页面里求值。expression 里可以写多语句，最后一句是返回值 */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = d.exception?.description ?? d.text ?? "页面求值抛错";
      throw new Error(text);
    }
    return r.result.value;
  }

  /**
   * 轮询直到表达式为真。返回最后一次的值（真值），超时则抛错并带诊断。
   * 导航过程中 execution context 会被销毁，所以求值失败也继续轮询。
   */
  async waitFor(expression, { timeout = 15_000, desc = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(`Boolean(${expression})`);
        if (v) return v;
        lastErr = null;
      } catch (e) {
        lastErr = e;
      }
      await sleep(50);
    }
    throw new Error(
      `等待超时（${timeout}ms）：${desc}` +
        (lastErr ? `\n最后一次错误：${lastErr.message}` : ""),
    );
  }

  /** 等若干帧，让 React 重渲染 + 浏览器完成 reflow */
  async frames(n = 2) {
    await this.eval(
      `new Promise((r) => {
         let i = 0;
         const tick = () => (++i >= ${n} ? r(true) : requestAnimationFrame(tick));
         requestAnimationFrame(tick);
       })`,
    );
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor('document.readyState === "complete"', {
      timeout: 40_000,
      desc: "页面加载完成",
    });
  }

  /** JS 点击（自动滚入视口）。比真实鼠标稳：不受视口坐标限制 */
  async click(selector, { index = 0, timeout = 8000 } = {}) {
    await this.waitFor(`document.querySelectorAll(${JSON.stringify(selector)}).length > ${index}`, {
      timeout,
      desc: `元素出现：${selector}[${index}]`,
    });
    const ok = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`点击失败：${selector}[${index}]`);
  }

  /** 真实鼠标事件（pointer 拖拽必须走这条：合成事件过不了 React 的捕获/时序） */
  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      ...extra,
    });
  }

  /**
   * 按住左键从 from 拖到 to。
   * 每一步都等一帧真实渲染（而不是固定 sleep）：React 的状态提交与浏览器 reflow
   * 是异步的，纯靠 sleep(16) 会在慢机器上偶发「拖了但顺序没变」。
   */
  async drag(from, to, { steps = 12, holdMs = 60 } = {}) {
    await this.mouse("mouseMoved", from.x, from.y);
    await this.frames(1);
    await this.mouse("mousePressed", from.x, from.y, {
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    // 让 pointerdown 里的 setState 先提交，否则第一步 move 读到的是空状态
    if (holdMs) await sleep(holdMs);
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.mouse("mouseMoved", x, y, { button: "left", buttons: 1 });
      await this.frames(1);
    }
    // 松手前留一帧：最后一次 move 的落点要先反映到插入线上
    await sleep(40);
    await this.mouse("mouseReleased", to.x, to.y, {
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  /** 元素中心点的视口坐标（供 drag 用） */
  async center(selector, index = 0) {
    const box = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`找不到元素：${selector}[${index}]`);
    await this.frames(1);
    return box;
  }

  async screenshot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const file = join(ARTIFACT_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(r.data, "base64"));
    return file;
  }
}

/** 让系统给一个空闲端口（拿到就关，立刻给 Chrome 用） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 起 vite + Chrome，加载应用。
 * @param {object} opts
 * @param {number} [opts.width]  初始视口宽
 * @param {number} [opts.height] 初始视口高
 * @param {string} [opts.mock]   注入到页面最前面的脚本（mock.mjs 的 buildMockScript()）
 * @param {string} [opts.lang]   钉死的界面语言（默认 zh-CN）；测英文界面时传 "en"
 */
export async function launch({
  width = 1280,
  height = 820,
  mock = "",
  lang = "zh-CN",
} = {}) {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: ROOT,
    logLevel: "error",
    clearScreen: false,
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  const userDataDir = await mkdtemp(join(tmpdir(), "nameseq-ui-"));
  const chromePath = findChrome();
  // 不用 --remote-debugging-port=0 + DevToolsActivePort：那个文件在某些环境
  // （CI runner 上遇到过）不写出来。自己挑端口再轮询 HTTP，能直接确认端口在服务
  const debugPort = await freePort();
  const proc = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      // 界面语言：应用首次启动会跟随 navigator.language 选语言（i18n.ts）。
      // 不钉死的话，CI runner（en-US）上界面是英文、本机（zh-CN）上是中文，
      // 任何按中文文案定位元素的用例都会变成「只有 CI 挂」的玄学。
      `--lang=${lang}`,
      `--accept-lang=${lang}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter",
      "--hide-crash-restore-bubble",
      "about:blank",
    ],
    // stderr 要收着：CI 上 Chrome 起不来时，这是唯一能看到原因的地方
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let exited = false;
  let stderr = "";
  proc.on("exit", () => {
    exited = true;
  });
  proc.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  let version = null;
  for (let i = 0; i < 300 && !exited; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  if (!version) {
    proc.kill();
    await server.close();
    throw new Error(
      [
        `Chrome 没起来（端口 ${debugPort} 一直没响应）`,
        `  可执行文件：${chromePath}`,
        `  进程已退出：${exited}`,
        `  用户数据目录：${userDataDir}`,
        `  stderr：${stderr.trim() || "(空)"}`,
      ].join("\n"),
    );
  }

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const page = new Page(cdp, sessionId);

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  // 语言必须在页面脚本之前钉死：应用首次启动跟随 navigator.language 选语言
  // （src/i18n.ts 的 resolveLocale）。CI runner 是 en-US、本机是 zh-CN，
  // 不钉死就会出现「只有 CI 挂」的用例——按中文文案定位元素在英文界面下必然找不到。
  // Chrome 的 --lang 参数在 Windows 上不一定改到 navigator.language，所以这里直接改属性。
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      try {
        Object.defineProperty(navigator, "language", {
          get: () => ${JSON.stringify(lang)}, configurable: true,
        });
        Object.defineProperty(navigator, "languages", {
          get: () => [${JSON.stringify(lang)}], configurable: true,
        });
      } catch {}
    `,
  });
  if (mock) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  }
  await page.setViewport(width, height);
  await page.goto(url);

  return {
    page,
    url,
    async close() {
      cdp.close();
      proc.kill();
      await server.close();
      // Chrome 退出前会一直占着 user-data-dir，给一点时间再删
      for (let i = 0; i < 20; i++) {
        try {
          await rm(userDataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(50);
        }
      }
    },
  };
}
