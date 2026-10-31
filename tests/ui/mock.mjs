/**
 * Tauri IPC 的浏览器端 mock。
 *
 * 契约来自 @tauri-apps/api v2（node_modules/@tauri-apps/api/core.js）：
 *   window.__TAURI_INTERNALS__.invoke(cmd, args, options) -> Promise
 *   window.__TAURI_INTERNALS__.transformCallback(cb, once)  -> number
 *   window.__TAURI_INTERNALS__.unregisterCallback(id)
 *   window.__TAURI_INTERNALS__.convertFileSrc(path, protocol)
 *
 * 关于 plan_rename：这里有一个**精简 planner**，只实现 UI 测试用到的动作
 * （prefix / suffix / template / replace / case-lower / setExt）。
 * 改名结果的正确性以 Rust 侧 122 个测试为准，这里只负责让界面「有真实反应」——
 * 规则改了预览跟着变、拖拽后序号跟着动。新增动作时**不必**在这里补齐，
 * 除非某个 UI 用例需要它。
 */

const DEFAULT_DIRS = [
  "C:\\mock\\photos\\2024",
  "C:\\mock\\photos\\2025",
  "C:\\mock\\music",
];

const EXTS = ["jpg", "jpg", "png", "mp3", "txt", "mp4"];

/** 在 Node 侧把数据造好再 JSON.stringify 注入（不要在页面里拼字符串） */
function makeFiles({ count, dirs, folders }) {
  const files = [];
  let id = 1;
  for (let i = 0; i < count; i++) {
    const dir = dirs[i % dirs.length];
    const ext = EXTS[i % EXTS.length];
    const stem = `IMG_${String(i + 1).padStart(3, "0")}`;
    files.push({
      id: id++,
      path: `${dir}\\${stem}.${ext}`,
      dir,
      stem,
      ext,
      name: `${stem}.${ext}`,
      size: 1024 * (i + 1),
      modifiedMs: 1_700_000_000_000 + i * 86_400_000,
      isDir: false,
      error: null,
    });
  }
  for (let i = 0; i < folders; i++) {
    const dir = dirs[i % dirs.length];
    const name = `相册-${i + 1}`;
    files.push({
      id: id++,
      path: `${dir}\\${name}`,
      dir,
      stem: name,
      ext: "",
      name,
      size: 0,
      modifiedMs: 1_700_000_000_000,
      isDir: true,
      error: null,
    });
  }
  return files;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.count]   造多少个文件
 * @param {string[]} [opts.dirs]
 * @param {number} [opts.folders] 造多少个文件夹条目
 */
export function buildMockScript(opts = {}) {
  const files = makeFiles({
    count: opts.count ?? 40,
    dirs: opts.dirs ?? DEFAULT_DIRS,
    folders: opts.folders ?? 2,
  });

  return `(() => {
  "use strict";
  const FILES = ${JSON.stringify(files)};
  const calls = [];
  const callbacks = new Map();
  let nextCb = 1;

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  /* ---------- 精简 planner（见文件头说明） ---------- */

  function pad(n, width) {
    return width > 0 ? String(n).padStart(width, "0") : String(n);
  }

  function renderTemplate(tpl, ctx) {
    return tpl.replace(/\\{(\\w+)(?::([^}]+))?\\}/g, (m, field, fmt) => {
      switch (field) {
        case "name":
        case "stem":
          return ctx.stem;
        case "ext":
          return ctx.ext;
        case "dir":
          return ctx.dir;
        case "original":
          return ctx.original;
        case "index":
        case "counter": {
          const width = fmt ? parseInt(fmt, 10) || 0 : ctx.indexWidth || 0;
          return pad(ctx.index, width);
        }
        default:
          return m;
      }
    });
  }

  function applyAction(action, value, ctx) {
    if (!action || !action.kind) return value;
    switch (action.kind) {
      case "prefix":
        return action.text + value;
      case "suffix":
        return value + action.text;
      case "template":
        return renderTemplate(action.template, ctx);
      case "replace": {
        if (!action.find) return value;
        if (action.regex) {
          try {
            return value.replace(
              new RegExp(action.find, action.caseSensitive ? "g" : "gi"),
              action.with ?? "",
            );
          } catch {
            return value;
          }
        }
        const hay = action.caseSensitive ? value : value.toLowerCase();
        const needle = action.caseSensitive ? action.find : action.find.toLowerCase();
        let out = "";
        let at = 0;
        for (;;) {
          const i = hay.indexOf(needle, at);
          if (i < 0) {
            out += value.slice(at);
            break;
          }
          out += value.slice(at, i) + (action.with ?? "");
          at = i + needle.length;
        }
        return out;
      }
      case "case":
        return action.mode === "lower" ? value.toLowerCase() : value.toUpperCase();
      default:
        return value;
    }
  }

  function groupOf(config, id) {
    return (config.groups || []).find((g) => g.id === id) || null;
  }

  function ruleApplies(rule, ext, config) {
    if (!rule.enabled) return false;
    if (rule.group) {
      const g = groupOf(config, rule.group);
      // 组 id 不存在 → 按不分组处理（与 Rust 侧一致）
      if (g) {
        if (!g.enabled) return false;
        const exts = (g.filter && g.filter.exts) || [];
        if (exts.length > 0) {
          const lower = (ext || "").toLowerCase();
          if (!exts.map((x) => String(x).toLowerCase()).includes(lower)) return false;
        }
      }
    }
    const own = (rule.filter && rule.filter.exts) || [];
    if (own.length > 0) {
      const lower = (ext || "").toLowerCase();
      if (!own.map((x) => String(x).toLowerCase()).includes(lower)) return false;
    }
    return true;
  }

  function buildPlan(entries, config) {
    const excluded = new Set(config.excluded || []);
    const ops = [];
    let index = config.startIndex || 1;
    const step = config.indexStep || 1;
    let executable = 0;
    let unchanged = 0;
    let excludedN = 0;

    for (const e of entries) {
      if (excluded.has(e.id)) {
        excludedN++;
        ops.push({
          id: e.id,
          from: e.path,
          to: e.path,
          oldName: e.name,
          newName: e.name,
          status: "excluded",
          reason: null,
          isDir: e.isDir,
          size: e.size,
          modifiedMs: e.modifiedMs,
        });
        continue;
      }

      let stem = e.stem;
      let ext = e.ext;
      for (const r of config.rules || []) {
        if (!ruleApplies(r, e.ext, config)) continue;
        const ctx = {
          stem,
          ext,
          dir: e.dir,
          original: e.stem,
          index,
          indexWidth: config.indexWidth || 0,
        };
        if (r.target === "ext") ext = applyAction(r.action, ext, ctx);
        else stem = applyAction(r.action, stem, ctx);
      }

      const newName = ext ? stem + "." + ext : stem;
      const status = newName === e.name ? "unchanged" : "ok";
      if (status === "ok") {
        executable++;
        index += step;
      } else {
        unchanged++;
      }
      ops.push({
        id: e.id,
        from: e.path,
        to: (e.dir ? e.dir + "\\\\" : "") + newName,
        oldName: e.name,
        newName,
        status,
        reason: null,
        isDir: e.isDir,
        size: e.size,
        modifiedMs: e.modifiedMs,
      });
    }

    return {
      ops,
      total: entries.length,
      executable,
      conflicts: 0,
      invalid: 0,
      unchanged,
      excluded: excludedN,
    };
  }

  /* ---------- IPC ---------- */

  const handlers = {
    scan_paths: (args) => {
      if (args && args.foldersSelf) {
        // 「把这个文件夹本身加进来」：只回它自己
        const p = (args.paths && args.paths[0]) || "C:\\\\mock\\\\photos";
        const name = p.split(/[\\\\/]/).pop() || "photos";
        return [
          {
            id: 9001,
            path: p,
            dir: p.slice(0, p.lastIndexOf("\\\\")),
            stem: name,
            ext: "",
            name,
            size: 0,
            modifiedMs: 1_700_000_000_000,
            isDir: true,
            error: null,
          },
        ];
      }
      return clone(FILES);
    },
    plan_rename: (args) => buildPlan(args.entries || [], args.config || {}),
    list_batches: () => [],
    interrupted_batches: () => [],
    execute_plan: (args) => {
      const ops = args.ops || [];
      return {
        batchId: "mock-batch-1",
        total: ops.length,
        succeeded: ops.length,
        failed: 0,
        skipped: 0,
        results: ops.map((o) => ({
          id: o.id,
          from: o.from,
          to: o.to,
          ok: true,
          error: null,
          kind: null,
          hint: null,
          retryable: false,
        })),
      };
    },
    retry_failed: (args) => handlers.execute_plan(args),
    undo_batch: (args) => ({
      batchId: args.batchId,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      results: [],
    }),
    recover_batch: (args) => handlers.undo_batch(args),
    export_chain: (args) =>
      JSON.stringify({
        version: 1,
        name: args.name || "规则链",
        note: "",
        config: args.config,
      }),
    import_chain: (args) => JSON.parse(args.text),
    read_text_file: () => "",
    write_text_file: () => null,
    copy_text: () => null,
    "plugin:event|listen": () => nextCb++,
    "plugin:event|unlisten": () => null,
    "plugin:event|emit": () => null,
    "plugin:opener|open_path": () => null,
    "plugin:opener|reveal_item_in_dir": () => null,
    "plugin:updater|check": () => null,
    "plugin:process|restart": () => null,
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback(cb, once) {
      const id = nextCb++;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(path) {
      return path;
    },
    invoke(cmd, args) {
      calls.push({ cmd, args: clone(args) });
      window.__MOCK_CALLS__ = calls;
      // 对话框：按 filters 分流（选文件 / 选规则链走同一个 cmd）
      if (cmd === "plugin:dialog|open") {
        const filters = (args && args.filters) || [];
        if (filters.some((f) => (f.extensions || []).includes("nsq"))) {
          return Promise.resolve(["C:\\\\mock\\\\规则链.nsq"]);
        }
        if (args && args.directory) return Promise.resolve(["C:\\\\mock\\\\photos"]);
        return Promise.resolve(["C:\\\\mock\\\\photos\\\\IMG_001.jpg"]);
      }
      if (cmd === "plugin:dialog|save") {
        // 保存对话框：用例可以设 __MOCK_SAVE_AS__ 决定回哪个扩展名（csv / md），
        // 默认还是规则链，保持既有用例不变
        const as = window.__MOCK_SAVE_AS__ || "nsq";
        if (as === "csv") return Promise.resolve("C:\\\\mock\\\\改名报告.csv");
        if (as === "md") return Promise.resolve("C:\\\\mock\\\\改名报告.md");
        return Promise.resolve("C:\\\\mock\\\\导出.nsq");
      }
      if (cmd === "plugin:dialog|confirm") return Promise.resolve("确定");

      const h = handlers[cmd];
      if (!h) return Promise.resolve(null);
      try {
        return Promise.resolve(h(args));
      } catch (e) {
        return Promise.reject(String(e));
      }
    },
  };

  window.__MOCK_READY__ = true;
})();`;
}
