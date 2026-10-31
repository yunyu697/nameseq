import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm as confirmDialog, open, save } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import FileFilterBar, {
  EMPTY_FILE_FILTER,
  matchFilterIds,
  type FileFilterState,
} from "./components/FileFilterBar";
import FilesStep from "./components/FilesStep";
import PreviewTable from "./components/PreviewTable";
import RulesStep from "./components/RulesStep";
import RunStep from "./components/RunStep";
import SettingsDrawer from "./components/SettingsDrawer";
import Toast, { type ToastData } from "./components/Toast";
import TopBar from "./components/TopBar";
import {
  IconChevron,
  IconFiles,
  IconPlay,
  IconRules,
  IconUndo,
} from "./components/Icons";
import {
  cloneRules,
  loadPresets,
  savePresets,
  type Preset,
  type PresetGroup,
} from "./presets";
import { emptyFilter, newRule } from "./rules";
import {
  applySettings,
  loadSettings,
  saveSettings,
  resolveDark,
  type Settings,
} from "./theme";
import { useUpdater } from "./updateManager";
import type {
  Action,
  BatchInfo,
  BatchResult,
  FileEntry,
  InterruptedBatch,
  OpResult,
  Plan,
  Progress,
  RenameConfig,
  RenameOp,
  Rule,
  RuleGroup,
} from "./types";
import { humanSize } from "./util";
import { applyLang, t } from "./i18n";

const DEFAULT_CONFIG: RenameConfig = {
  rules: [newRule("template")],
  keepExt: true,
  sortBy: "original",
  sortBy2: null,
  descending: false,
  naturalSort: true,
  startIndex: 1,
  indexStep: 1,
  indexWidth: 0,
  indexPerFolder: false,
  conflict: "skip",
  groups: [],
  excluded: [],
};

let toastSeq = 0;

/** 超过这个数量就二次确认。取 200 是因为一屏预览大约能看十几行，
    再多就不可能「逐条核对」了，这时候确认框才有意义。 */
const BIG_BATCH = 200;

/** 大批量的确认框。浏览器里预览界面时没有原生对话框，退化成 window.confirm。 */
async function askBigBatch(n: number): Promise<boolean> {
  const msg =
    `即将改名 ${n} 个文件。\n\n` +
    "批量改名没法逐条核对，虽然可以用「撤销」整批回滚，建议先看一眼右侧预览里的差异。";
  try {
    return await confirmDialog(msg, {
      title: "确认批量改名",
      kind: "warning",
      okLabel: "继续执行",
      cancelLabel: "再看看",
    });
  } catch {
    return window.confirm(`即将改名 ${n} 个文件，继续？`);
  }
}

/** 与 styles.css 里各密度档的 --row-h 保持一致，虚拟列表靠它算高度 */
const ROW_H: Record<Settings["density"], number> = {
  compact: 28,
  normal: 34,
  relaxed: 40,
};

/* ---------------- 单页分区与分隔条 ---------------- */

type PaneKey = "files" | "rules" | "run";

const PANES_KEY = "renamesmith.panes.v1";
const SPLIT_KEY = "renamesmith.preview.w.v1";
const FILTER_KEY = "renamesmith.filefilter.v1";
const SCAN_KEY = "renamesmith.scanopts.v1";

/** 分区是否收起。默认：文件/规则展开，执行选项收起（低频） */
const DEFAULT_PANES: Record<PaneKey, boolean> = {
  files: false,
  rules: false,
  run: true,
};

/** 预览列宽度钳制：实测值就绪前的兜底（预览至少 260） */
const MIN_WS_FALLBACK = 360;
const MIN_PREVIEW = 260;

/** 参与决定功能区最小宽度的「不可换行行」：
    这些行里的按钮都不许压缩，行宽下限 = 内容刚好放得下 */
const MINROW_SELECTOR = ".rules-toolbar, .chain-head, .card-head";

const defaultPreviewW = () =>
  Math.max(MIN_PREVIEW, Math.round(window.innerWidth * 0.4));

/** 合并扫描结果。
    扫描器每次都从 1 开始编号，直接合并会和已有条目撞 id，而「排除某项」正是按 id
    记的——撞了就会连带排除别的文件。所以新来的条目统一重新发号。 */
function mergeEntries(prev: FileEntry[], found: FileEntry[]): FileEntry[] {
  const seen = new Set(prev.map((e) => e.path.toLowerCase()));
  let nextId = prev.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  const merged = [...prev];
  for (const f of found) {
    const k = f.path.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      merged.push({ ...f, id: nextId++ });
    }
  }
  return merged;
}

export default function App() {
  const [collapsed, setCollapsed] = useState<Record<PaneKey, boolean>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PANES_KEY) || "");
      if (raw && typeof raw === "object") {
        return {
          files: !!raw.files,
          rules: !!raw.rules,
          run: !!raw.run,
        };
      }
    } catch {
      /* 首次使用，走默认 */
    }
    return DEFAULT_PANES;
  });

  const [previewW, setPreviewW] = useState<number>(() => {
    const raw = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(raw) && raw >= MIN_PREVIEW
      ? raw
      : defaultPreviewW();
  });
  const [splitting, setSplitting] = useState(false);
  // 功能区最小宽度：挂载后实测（内容刚好放得下），写死数字总会被新控件打脸
  const wsScrollRef = useRef<HTMLDivElement>(null);
  const minWsRef = useRef(MIN_WS_FALLBACK);
  const [minWs, setMinWs] = useState(MIN_WS_FALLBACK);

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [config, setConfig] = useState<RenameConfig>(DEFAULT_CONFIG);
  // 预览上方的文件筛选（包含/排除 + 扩展名），选择持久化
  const [fileFilter, setFileFilter] = useState<FileFilterState>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || "");
      if (raw && typeof raw === "object" && Array.isArray(raw.exts)) {
        return {
          mode: raw.mode === "include" ? "include" : "exclude",
          exts: raw.exts.filter((x: unknown) => typeof x === "string"),
        };
      }
    } catch {
      /* 首次使用，走默认 */
    }
    return EMPTY_FILE_FILTER;
  });
  // 扫描选项持久化：上次怎么扫的，这次接着用
  const loadScanOpts = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(SCAN_KEY) || "");
      if (raw && typeof raw === "object") {
        return {
          recursive: !!raw.recursive,
          includeDirs: !!raw.includeDirs,
          readMedia: !!raw.readMedia,
        };
      }
    } catch {
      /* 首次使用，走默认 */
    }
    return { recursive: false, includeDirs: false, readMedia: false };
  };
  const scanOpts0 = loadScanOpts();
  const [recursive, setRecursive] = useState(scanOpts0.recursive);
  // 文件夹也参与改名（扫描时把目录当条目收进来）
  const [includeDirs, setIncludeDirs] = useState(scanOpts0.includeDirs);
  // 读 MP3/FLAC/MP4 标签与分辨率（有 I/O 成本，默认关）
  const [readMedia, setReadMedia] = useState(scanOpts0.readMedia);
  useEffect(() => {
    localStorage.setItem(
      SCAN_KEY,
      JSON.stringify({ recursive, includeDirs, readMedia }),
    );
  }, [recursive, includeDirs, readMedia]);
  // 崩溃残留：启动时查一次，有就提示恢复
  const [interrupted, setInterrupted] = useState<InterruptedBatch[]>([]);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [batches, setBatches] = useState<BatchInfo[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // 上一次执行的失败项：留着给「重试」用（重试直接拿这批发给后端，不依赖重新规划）
  const [failedOps, setFailedOps] = useState<RenameOp[]>([]);
  const [lastFailures, setLastFailures] = useState<OpResult[]>([]);

  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(DEFAULT_CONFIG.rules.map((r) => r.id)),
  );
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  // 语言在每次渲染前应用：t() 是模块级的，子组件渲染时读到当前词条即可。
  // 幂等调用，语言没变就没有开销。
  applyLang(settings.language);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 更新检查放这里而不是设置抽屉里：抽屉关着也要按频率自动查
  const updater = useUpdater(settings.updateCheck);

  const notify = useCallback((kind: ToastData["kind"], text: string) => {
    toastSeq += 1;
    setToast({ id: toastSeq, kind, text });
  }, []);

  // 发现新版本时提示一次（自动检查在后台跑，用户可能根本没开设置抽屉）
  const prevUpdStatus = useRef<string>("idle");
  useEffect(() => {
    const st = updater.phase.status;
    if (st === "available" && prevUpdStatus.current !== "available") {
      notify(
        "ok",
        `发现新版本 v${updater.phase.version}，到「设置 → 关于与更新」里选择更新方式`,
      );
    }
    prevUpdStatus.current = st;
  }, [updater.phase.status, updater.phase.version, notify]);

  /* ---------------- 主题 ---------------- */

  const firstApply = useRef(true);
  useEffect(() => {
    applySettings(settings, !firstApply.current);
    saveSettings(settings);
    firstApply.current = false;
  }, [settings]);

  useEffect(() => {
    if (settings.mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applySettings(settings);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [settings]);

  const dark = resolveDark(settings.mode);
  const patchSettings = useCallback(
    (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })),
    [],
  );

  /* ---------------- 文件 ---------------- */

  /* ---------------- 文件筛选（预览上方的包含/排除条） ---------------- */

  // 筛选持久化
  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify(fileFilter));
  }, [fileFilter]);

  /** 筛选命中的 entry id（按扩展名匹配，含文件夹伪 token） */
  const filterHitIds = useMemo(() => {
    if (entries.length === 0 || fileFilter.exts.length === 0)
      return new Set<number>();
    return matchFilterIds(entries, fileFilter);
  }, [entries, fileFilter]);

  /** 筛选转成排除集合：排除模式 = 命中的排除；包含模式 = 没命中的全排除 */
  const filterExcluded = useMemo(() => {
    if (fileFilter.exts.length === 0) return new Set<number>();
    if (fileFilter.mode === "exclude") return filterHitIds;
    const inv = new Set<number>();
    for (const e of entries) if (!filterHitIds.has(e.id)) inv.add(e.id);
    return inv;
  }, [entries, fileFilter, filterHitIds]);

  /** 手动排除 ∪ 筛选排除：真正发给后端、预览里置灰的集合 */
  const effectiveExcluded = useMemo(
    () =>
      filterExcluded.size === 0
        ? config.excluded
        : Array.from(new Set([...config.excluded, ...filterExcluded])),
    [config.excluded, filterExcluded],
  );

  const excludedSet = useMemo(() => new Set(effectiveExcluded), [effectiveExcluded]);

  /** 发给后端规划用的配置：排除集合换成合并后的版本 */
  const planConfig = useMemo<RenameConfig>(
    () => ({ ...config, excluded: effectiveExcluded }),
    [config, effectiveExcluded],
  );

  /** 载入一个 .nsq 规则链文件（拖进来和菜单打开走同一条路） */
  const loadChain = useCallback(
    async (path: string) => {
      try {
        const chain = await api.importChain(await api.readTextFile(path));
        // 手写的/旧版本的规则链可能缺字段，补齐再用：
        // 少一个 filter.exts 就会在渲染时读到 undefined
        const rules = chain.config.rules.map((r) => ({
          ...r,
          enabled: r.enabled ?? true,
          target: r.target ?? "stem",
          group: r.group ?? null,
          filter: { ...emptyFilter(), ...(r.filter ?? {}) },
        }));
        // 分组同样可能整个缺失（0.7 之前存的规则链），不能假定它一定是数组
        const withCfg = chain.config as Partial<RenameConfig>;
        const rawGroups = Array.isArray(withCfg.groups) ? withCfg.groups : [];
        const groups = rawGroups.map((g) => ({
          id: g.id || `g${Math.random().toString(36).slice(2, 8)}`,
          name: g.name ?? "分组",
          enabled: g.enabled ?? true,
          filter: { ...emptyFilter(), ...(g.filter ?? {}) },
        }));
        setConfig({
          ...chain.config,
          rules,
          groups,
          // 0.9 之前存的规则链没有次级排序键和序号位数设置
          sortBy2: withCfg.sortBy2 ?? null,
          indexWidth: withCfg.indexWidth ?? 0,
          indexPerFolder: withCfg.indexPerFolder ?? false,
          excluded: [],
        });
        setOpenIds(new Set());
        setCollapsed((c) => ({ ...c, rules: false }));
        notify(
          "ok",
          `已载入规则链「${chain.name || "未命名"}」（${chain.config.rules.length} 条规则）`,
        );
      } catch (e) {
        notify("err", String(e));
      }
    },
    [notify],
  );

  const importChain = useCallback(async () => {
    const sel = await open({
      multiple: false,
      title: "选择规则链文件",
      filters: [{ name: "名序规则链", extensions: ["nsq", "json"] }],
    });
    if (!sel) return;
    await loadChain(Array.isArray(sel) ? sel[0] : sel);
  }, [loadChain]);

  const exportChain = useCallback(async () => {
    if (config.rules.length === 0) {
      notify("warn", "规则链是空的，先加一条规则再导出");
      return;
    }
    const stamp = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const path = await save({
      title: "导出规则链",
      defaultPath: `规则链-${stamp}.nsq`,
      filters: [{ name: "名序规则链", extensions: ["nsq"] }],
    });
    if (!path) return;
    try {
      const name = path.split(/[\\/]/).pop()!.replace(/\.nsq$/i, "");
      const text = await api.exportChain(config, name);
      await api.writeTextFile(path, text);
      notify("ok", `已导出到 ${path}`);
    } catch (e) {
      notify("err", String(e));
    }
  }, [config, notify]);

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      // 拖进来的是规则链文件就直接载入规则，不当成待改名的文件
      const chains = paths.filter((p) => /\.nsq$/i.test(p));
      if (chains.length > 0) {
        await loadChain(chains[0]);
        const rest = paths.filter((p) => !/\.nsq$/i.test(p));
        if (rest.length === 0) return;
        paths = rest;
      }
      setBusy(true);
      try {
        const found = await api.scanPaths(paths, {
          recursive,
          includeDirs,
          readMedia,
        });
        if (found.length === 0) {
          notify("warn", "这个位置没有找到文件，检查一下是否勾选了「包含子文件夹」");
        } else {
          notify("ok", `已添加 ${found.length} 个文件`);
        }
        setRoots((prev) => Array.from(new Set([...prev, ...paths])));
        setEntries((prev) => mergeEntries(prev, found));
      } catch (e) {
        notify("err", String(e));
      } finally {
        setBusy(false);
      }
    },
    [recursive, includeDirs, readMedia, notify, loadChain],
  );

  /** 把「这个文件夹本身」加进列表：不展开内容，只加它自己 */
  const addFolderItself = useCallback(
    async (p: string) => {
      setBusy(true);
      try {
        const found = await api.scanPaths([p], {
          recursive: false,
          includeDirs: true,
          readMedia: false,
          foldersSelf: true,
        });
        if (found.length === 0) {
          notify("warn", "这个文件夹加不进来，可能已经没有访问权限");
          return;
        }
        setEntries((prev) => mergeEntries(prev, found));
        notify("ok", `已把文件夹「${found[0].name}」本身加入列表`);
      } catch (e) {
        notify("err", String(e));
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  const refresh = useCallback(async () => {
    if (roots.length === 0) return;
    try {
      setEntries(await api.scanPaths(roots, { recursive, includeDirs, readMedia }));
      // 重新扫描会重排 id，旧的排除项已经对不上任何文件，直接清掉，
      // 否则会误排除刚改名后的别的文件。
      setConfig((c) => (c.excluded.length ? { ...c, excluded: [] } : c));
    } catch (e) {
      notify("err", String(e));
    }
  }, [roots, recursive, includeDirs, readMedia, notify]);

  // 扫描选项变了就按新选项重扫一遍：勾上「文件夹也改名」后列表要立刻跟着变，
  // 否则还得手动再添加一次位置
  const scanOptsKey = useRef("");
  useEffect(() => {
    const k = `${recursive}|${includeDirs}|${readMedia}`;
    if (scanOptsKey.current === k) return;
    scanOptsKey.current = k;
    if (roots.length > 0) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recursive, includeDirs, readMedia]);

  const reloadBatches = useCallback(async () => {
    try {
      setBatches(await api.listBatches());
    } catch {
      /* 日志还没建立，忽略 */
    }
  }, []);

  /** 查一下有没有上次崩溃留下的、卡在临时名上的批次 */
  const checkInterrupted = useCallback(async () => {
    try {
      const list = await api.interruptedBatches();
      setInterrupted(list);
      if (list.length > 0) {
        const n = list.reduce((s, b) => s + b.pending.length, 0);
        notify("warn", `上次有 ${n} 个文件卡在临时名上，去「执行选项」里可以恢复原名`);
      }
    } catch {
      /* 日志不可用时静默 */
    }
  }, [notify]);

  useEffect(() => {
    void reloadBatches();
    void checkInterrupted();
  }, [reloadBatches, checkInterrupted]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // 拖放事件依赖 Tauri 注入的 webview 对象。在纯浏览器里预览界面时它不存在，
    // 这里包一层，避免整个应用因为一个可选能力直接白屏。
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragOver(true);
          else if (p.type === "leave") setDragOver(false);
          else if (p.type === "drop") {
            setDragOver(false);
            void addPaths(p.paths);
          }
        })
        .then((f) => {
          unlisten = f;
        })
        .catch(() => {});
    } catch {
      /* 非 Tauri 环境，忽略 */
    }
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      unlisten?.();
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, [addPaths]);

  useEffect(() => {
    const un = listen<Progress>("rename://progress", (e) =>
      setProgress(e.payload),
    );
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  /* ---------------- 规划 ---------------- */

  useEffect(() => {
    if (entries.length === 0) {
      setPlan(null);
      setPlanError(null);
      setPlanning(false);
      return;
    }
    let alive = true;
    // 「计算中」延迟 350ms 才亮，否则边打字边闪，比不显示还吵
    const slow = window.setTimeout(() => {
      if (alive) setPlanning(true);
    }, 350);
    const timer = window.setTimeout(async () => {
      try {
        const p = await api.planRename(entries, planConfig);
        if (!alive) return;
        setPlan(p);
        setPlanError(null);
      } catch (e) {
        if (!alive) return;
        setPlan(null);
        setPlanError(String(e));
      } finally {
        window.clearTimeout(slow);
        if (alive) setPlanning(false);
      }
    }, 160);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearTimeout(slow);
    };
  }, [entries, planConfig]);

  /* ---------------- 分区折叠 ---------------- */

  // 折叠状态持久化
  useEffect(() => {
    localStorage.setItem(PANES_KEY, JSON.stringify(collapsed));
  }, [collapsed]);

  // 文件数 0 → N 时自动收起文件区（dropzone 的使命完成了），清空时再展开
  const prevCount = useRef(0);
  useEffect(() => {
    if (entries.length > 0 && prevCount.current === 0) {
      setCollapsed((c) => ({ ...c, files: true }));
    } else if (entries.length === 0 && prevCount.current > 0) {
      setCollapsed((c) => ({ ...c, files: false }));
    }
    prevCount.current = entries.length;
  }, [entries.length]);

  const togglePane = (k: PaneKey) =>
    setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  // Ctrl+1/2/3：展开对应分区并滚过去
  const paneRefs = useRef<Record<PaneKey, HTMLElement | null>>({
    files: null,
    rules: null,
    run: null,
  });
  const focusPane = useCallback((k: PaneKey) => {
    setCollapsed((c) => ({ ...c, [k]: false }));
    paneRefs.current[k]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /* ---------------- 分隔条：功能区 ↔ 预览 ---------------- */

  // 实测功能区最小宽度：把「不可换行行」逐行按 min-content 压一遍取最宽，
  // 加上滚动区与分区的内边距。规则工具栏（添加规则/预设/存为预设）是下限的主导者。
  useEffect(() => {
    const measure = () => {
      const scroll = wsScrollRef.current;
      if (!scroll) return;
      let need = 0;
      for (const row of scroll.querySelectorAll<HTMLElement>(MINROW_SELECTOR)) {
        // 可让位项（提示文字/计数）临时藏起来：它们在最窄时本来就该是 0 宽，
        // 但 min-content 测量仍会给它们留内容宽，导致下限虚高
        const yieldables = row.querySelectorAll<HTMLElement>(
          ".toolbar-hint, .chain-hint, .chain-count, .card-count",
        );
        const saved: string[] = [];
        for (const y of yieldables) {
          saved.push(y.style.display);
          y.style.display = "none";
        }
        const prev = row.style.width;
        row.style.width = "min-content";
        need = Math.max(need, row.scrollWidth, row.offsetWidth);
        row.style.width = prev;
        yieldables.forEach((y, i) => {
          y.style.display = saved[i];
        });
      }
      if (need <= 0) return;
      const cs = getComputedStyle(scroll);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      // +30 = pane 左右边框 2 + pane-inner 左右 padding 24 + 4px 余量
      const v = Math.ceil(need + pad + 30);
      minWsRef.current = v;
      setMinWs(v);
      // 调试钩子：供 CDP 回归脚本读取实测下限（生产无副作用）
      (window as unknown as { __MINWS__?: number }).__MINWS__ = v;
      // 算出下限后立刻把预览宽钳回有效范围：否则若 localStorage 存了上次
      // 的较宽值、本次窗口又更窄，首屏会把功能区压到下限以下（遮挡），
      // 而 resize 钳制只在窗口变化时触发，首屏不会跑
      setPreviewW((w) => clampPreview(w));
    };
    measure();
    // 字体就绪后文字宽度才真实，再量一次
    document.fonts?.ready.then(measure).catch(() => {});
  }, []);

  useEffect(() => {
    document.body.classList.toggle("col-resizing", splitting);
    return () => document.body.classList.remove("col-resizing");
  }, [splitting]);

  const clampPreview = (w: number) =>
    Math.max(
      MIN_PREVIEW,
      Math.min(window.innerWidth - minWsRef.current - 4, w),
    );

  // 窗口变窄时把预览宽钳回有效范围，别把功能区挤没
  useEffect(() => {
    const on = () => setPreviewW((w) => clampPreview(w));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startSplit = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = previewW;
    // 预览在右侧：往左拖（clientX 变小）= 预览变宽
    const onMove = (ev: PointerEvent) =>
      setPreviewW(clampPreview(startW + (startX - ev.clientX)));
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      setSplitting(false);
      localStorage.setItem(
        SPLIT_KEY,
        String(clampPreview(startW + (startX - ev.clientX))),
      );
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    setSplitting(true);
  };

  const resetSplit = () => {
    const w = defaultPreviewW();
    setPreviewW(w);
    localStorage.setItem(SPLIT_KEY, String(w));
  };

  /* ---------------- 执行 ---------------- */

  const run = useCallback(async () => {
    if (!plan || plan.executable === 0 || busy) return;
    // 大批量先问一句：这是唯一一个「点错要整批回滚」的入口。
    // 撤销能救，但用户往往先慌，多这一步成本很低。
    if (plan.executable > BIG_BATCH) {
      const go = await askBigBatch(plan.executable);
      if (!go) return;
    }
    setBusy(true);
    setProgress({ done: 0, total: plan.executable * 2, phase: "准备" });
    try {
      const r = await api.executePlan(plan.ops, false);
      const failedIds = new Set(r.results.filter((x) => !x.ok).map((x) => x.id));
      setFailedOps(plan.ops.filter((o) => failedIds.has(o.id)));
      setLastFailures(r.results.filter((x) => !x.ok));
      // 有失败就把「执行选项」展开并滚过去：失败原因卡片在那儿，
      // 折叠着的话用户只能看到一个「失败 N 个」的 toast，不知道该干嘛
      if (r.failed > 0) {
        setCollapsed((c) => (c.run ? { ...c, run: false } : c));
        // 等展开动画走完再滚，滚到卡片本身而不是分区顶部——
        // 分区里卡片在下面，滚到顶部等于没滚
        window.setTimeout(() => {
          const pane = paneRefs.current.run;
          const card = pane?.querySelector(".card.fail") ?? pane;
          card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 260);
      }
      const firstErr = r.results.find((x) => !x.ok);
      notify(
        r.failed > 0 ? "warn" : "ok",
        `成功 ${r.succeeded} 个` +
          (r.failed ? `，失败 ${r.failed} 个` : "") +
          (r.skipped ? `，跳过 ${r.skipped} 个` : "") +
          (firstErr?.hint ? `（${firstErr.hint}）` : ""),
      );
      await refresh();
      await reloadBatches();
    } catch (e) {
      notify("err", String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [plan, busy, notify, refresh, reloadBatches]);

  const undo = useCallback(
    async (batchId: string) => {
      if (!batchId || busy) return;
      setBusy(true);
      try {
        const r = await api.undoBatch(batchId);
        notify(
          r.failed > 0 ? "warn" : "ok",
          `已撤销：还原 ${r.succeeded} 个` +
            (r.failed ? `，失败 ${r.failed} 个` : ""),
        );
        await refresh();
        await reloadBatches();
      } catch (e) {
        notify("err", String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, notify, refresh, reloadBatches],
  );

  const lastBatch = batches[0]?.batch ?? null;

  /** 重试上次没成功的条目。后端会先按当前磁盘状态刷新元数据，再走完整的两阶段流程。 */
  const retry = useCallback(async () => {
    if (failedOps.length === 0 || busy) return;
    setBusy(true);
    setProgress({ done: 0, total: failedOps.length * 2, phase: "重试" });
    try {
      const r = await api.retryFailed(failedOps);
      const stillFailed = r.results.filter((x) => !x.ok);
      const ids = new Set(stillFailed.map((x) => x.id));
      setFailedOps(failedOps.filter((o) => ids.has(o.id)));
      setLastFailures(stillFailed);
      notify(
        r.failed > 0 ? "warn" : "ok",
        r.failed > 0
          ? `重试：成功 ${r.succeeded} 个，仍有 ${r.failed} 个没成功`
          : `重试成功，${r.succeeded} 个都改好了`,
      );
      await refresh();
      await reloadBatches();
    } catch (e) {
      notify("err", String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [failedOps, busy, notify, refresh, reloadBatches]);

  /** 用户主动关掉失败提示（重试仍然可用，只是不再占版面） */
  const dismissFailures = useCallback(() => setLastFailures([]), []);

  /** 崩溃恢复：把某个没跑完的批次按日志逆序还原 */
  const recover = useCallback(
    async (batchId: string) => {
      if (!batchId || busy) return;
      setBusy(true);
      try {
        const r = await api.recoverBatch(batchId);
        notify(
          r.failed > 0 ? "warn" : "ok",
          `已恢复：原名还原 ${r.succeeded} 个` +
            (r.failed ? `，${r.failed} 个没能还原（文件可能已被移动）` : ""),
        );
        await reloadBatches();
        await checkInterrupted();
        await refresh();
      } catch (e) {
        notify("err", String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, notify, reloadBatches, checkInterrupted, refresh],
  );

  /* ---------------- 规则操作 ---------------- */

  const addRule = (kind: Action["kind"]) => {
    const r = newRule(kind);
    setConfig((c) => ({ ...c, rules: [...c.rules, r] }));
    setOpenIds((s) => new Set(s).add(r.id));
  };

  const changeRule = (next: Rule) =>
    setConfig((c) => ({
      ...c,
      rules: c.rules.map((r) => (r.id === next.id ? next : r)),
    }));

  const removeRule = (id: string) => {
    setOpenIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setRemoving((s) => new Set(s).add(id));
    window.setTimeout(() => {
      setConfig((c) => ({ ...c, rules: c.rules.filter((r) => r.id !== id) }));
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }, 240);
  };

  const moveRule = (id: string, d: -1 | 1) =>
    setConfig((c) => {
      const i = c.rules.findIndex((r) => r.id === id);
      const j = i + d;
      if (i < 0 || j < 0 || j >= c.rules.length) return c;
      const rules = [...c.rules];
      [rules[i], rules[j]] = [rules[j], rules[i]];
      return { ...c, rules };
    });

  const toggleOpen = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ---- 规则分组 ----
  /** 返回新分组的 id，方便接着把某条规则塞进去 */
  const addGroup = () => {
    const id = `g${Date.now().toString(36)}`;
    setConfig((c) => ({
      ...c,
      groups: [
        ...c.groups,
        {
          id,
          name: `分组 ${c.groups.length + 1}`,
          enabled: true,
          filter: emptyFilter(),
        },
      ],
    }));
    return id;
  };

  const changeGroup = (g: RuleGroup) =>
    setConfig((c) => ({
      ...c,
      groups: c.groups.map((x) => (x.id === g.id ? g : x)),
    }));

  // 删组不删规则：组只是规则上的标签，规则本身该留着
  const removeGroup = (id: string) =>
    setConfig((c) => ({
      ...c,
      groups: c.groups.filter((g) => g.id !== id),
      rules: c.rules.map((r) => (r.group === id ? { ...r, group: null } : r)),
    }));

  const setGroupOf = (ruleId: string, groupId: string | null) =>
    setConfig((c) => ({
      ...c,
      rules: c.rules.map((r) =>
        r.id === ruleId ? { ...r, group: groupId } : r,
      ),
    }));

  /** 在规则卡片里选「新建分组」时：建好直接归进去，省一步 */
  const createGroupFor = (ruleId: string) => {
    const gid = addGroup();
    setGroupOf(ruleId, gid);
  };

  const setAllOpen = (open: boolean) =>
    setOpenIds(open ? new Set(config.rules.map((r) => r.id)) : new Set());

  const applyPreset = (p: Preset) => {
    // 预设不带分组信息，整条替换时旧的分组也一起丢掉，免得留下没人引用的空壳
    setConfig((c) => ({
      ...c,
      rules: cloneRules(p.rules),
      groups: [],
      excluded: [],
    }));
    setOpenIds(new Set());
    notify("ok", `已套用预设「${p.name}」`);
  };

  const savePreset = (name: string, group: PresetGroup = "structure") => {
    const p: Preset = {
      id: `u${Date.now().toString(36)}`,
      name,
      hint: `${config.rules.length} 条规则`,
      group,
      rules: cloneRules(config.rules),
      builtin: false,
    };
    const next = [p, ...presets];
    setPresets(next);
    savePresets(next);
    notify("ok", `已保存预设「${name}」`);
  };

  const deletePreset = (id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    savePresets(next);
  };

  /* ---------------- 快捷键 ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void run();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (lastBatch) void undo(lastBatch);
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key >= "1" && e.key <= "3") {
        e.preventDefault();
        focusPane((["files", "rules", "run"] as PaneKey[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, undo, lastBatch, focusPane]);

  /* ---------------- 派生 ---------------- */

  const totalSize = useMemo(
    () => entries.reduce((s, e) => s + e.size, 0),
    [entries],
  );

  const pickFiles = async () => {
    const sel = await open({ multiple: true, title: "选择文件" });
    if (sel) await addPaths(Array.isArray(sel) ? sel : [sel]);
  };

  const pickFolder = async () => {
    const sel = await open({
      directory: true,
      multiple: true,
      title: "选择文件夹",
    });
    if (sel) await addPaths(Array.isArray(sel) ? sel : [sel]);
  };

  const clearAll = () => {
    setEntries([]);
    setRoots([]);
    setPlan(null);
    setFailedOps([]);
    setLastFailures([]);
    setConfig((c) => ({ ...c, excluded: [] }));
  };

  const removeRoot = (p: string) => {
    const next = roots.filter((x) => x !== p);
    setRoots(next);
    if (next.length === 0) {
      setEntries([]);
      return;
    }
    // 移除一个来源后要重新扫剩下的，否则被移除目录里的文件还会留在列表里
    api
      .scanPaths(next, { recursive, includeDirs, readMedia })
      .then((found) => {
        setEntries(found);
        setConfig((c) => (c.excluded.length ? { ...c, excluded: [] } : c));
      })
      .catch((e) => notify("err", String(e)));
  };

  const patchConfig = (p: Partial<RenameConfig>) =>
    setConfig((c) => ({ ...c, ...p }));

  /** 预览表里拖动行 → 重排 entries。「添加顺序」的编号跟着这个顺序走。
      dragIds 是被拖的文件（多选时可能不连续），按原相对顺序整块移动；
      rawAt 是插入点（插到当前第 rawAt 行之前）。
      不连续的多选拖到一起后会变成连续块——顺序保持原来的先后。 */
  const reorderToIndex = (dragIds: number[], rawAt: number) => {
    const prev = entries;
    const moving = new Set(dragIds);
    const block = prev.filter((e) => moving.has(e.id));
    if (block.length === 0) return;
    // 换算插入点：rawAt 之前有几个被拖走的行，移除后插入点就前移几个
    const beforeCount = prev
      .slice(0, rawAt)
      .filter((e) => moving.has(e.id)).length;
    let at = Math.max(0, rawAt - beforeCount);
    const next = prev.filter((e) => !moving.has(e.id));
    at = Math.max(0, Math.min(next.length, at));
    next.splice(at, 0, ...block);
    // 和原序列逐一比较，没变就不动（拖回原位、插到块自身的边界都属于这类）
    let same = true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].id !== next[i].id) {
        same = false;
        break;
      }
    }
    if (same) return;
    setEntries(next);
    // 手动顺序只在「添加顺序」下生效；当前若是其它排序，切过来才不让人白拖
    if (config.sortBy !== "original") {
      patchConfig({ sortBy: "original", descending: false });
      notify("ok", "已切换为「添加顺序」，编号按你拖动的顺序分配");
    }
  };

  /* ---------------- 右键菜单 ---------------- */

  const openPath = (p: string) => {
    api.openPath(p).catch((e) => notify("err", `打开失败：${String(e)}`));
  };
  const revealPath = (p: string) => {
    api.revealPath(p).catch((e) => notify("err", `定位失败：${String(e)}`));
  };
  const copyToClipboard = (text: string, label: string) => {
    api
      .copyText(text)
      .then(() => notify("ok", `已复制${label}`))
      .catch((e) => notify("err", `复制失败：${String(e)}`));
  };
  const setExcluded = (ids: number[], off: boolean) =>
    patchConfig({
      excluded: off
        ? Array.from(new Set([...config.excluded, ...ids]))
        : config.excluded.filter((x) => !ids.includes(x)),
    });

  return (
    <div className={`app ${dragOver ? "dragging" : ""}`}>
      <TopBar
        count={entries.length}
        sizeText={humanSize(totalSize)}
        dark={dark}
        onToggleDark={() => patchSettings({ mode: dark ? "light" : "dark" })}
        onSettings={() => setSettingsOpen(true)}
      />

      <div className={`body ${splitting ? "splitting" : ""}`}>
        <section className="workspace" style={{ minWidth: minWs }}>
          <div className="ws-scroll" ref={wsScrollRef}>
            {/* 文件 */}
            <section
              className={`pane pane-files ${collapsed.files ? "closed" : ""}`}
              ref={(el) => {
                paneRefs.current.files = el;
              }}
            >
              <button
                className="pane-head"
                onClick={() => togglePane("files")}
                title={collapsed.files ? t("展开文件区") : t("收起文件区")}
              >
                <span className="pane-icon">
                  <IconFiles size={15} />
                </span>
                <span className="pane-titles">
                  <b>{t("文件")}</b>
                  <i>{t("选择要改名的文件")}</i>
                </span>
                <span className="pane-meta">
                  {entries.length > 0 ? t("{n} 个文件", { n: entries.length }) : t("未添加")}
                </span>
                <IconChevron className="pane-arrow" size={13} />
              </button>
              <div className="pane-body">
                <div className="pane-inner">
                  <FilesStep
                    entries={entries}
                    roots={roots}
                    recursive={recursive}
                    includeDirs={includeDirs}
                    readMedia={readMedia}
                    busy={busy}
                    dragOver={dragOver}
                    onToggleRecursive={() => setRecursive((v) => !v)}
                    onToggleDirs={() => setIncludeDirs((v) => !v)}
                    onToggleMedia={() => setReadMedia((v) => !v)}
                    onAddFolderItself={addFolderItself}
                    onPickFiles={pickFiles}
                    onPickFolder={pickFolder}
                    onRemoveRoot={removeRoot}
                    onClear={clearAll}
                  />
                </div>
              </div>
            </section>

            {/* 规则 */}
            <section
              className={`pane pane-rules ${collapsed.rules ? "closed" : ""}`}
              ref={(el) => {
                paneRefs.current.rules = el;
              }}
            >
              <button
                className="pane-head"
                onClick={() => togglePane("rules")}
                title={collapsed.rules ? t("展开规则区") : t("收起规则区")}
              >
                <span className="pane-icon">
                  <IconRules size={15} />
                </span>
                <span className="pane-titles">
                  <b>{t("规则")}</b>
                  <i>{t("从上到下依次执行，每条可单独加条件")}</i>
                </span>
                <span className="pane-meta">{t("{n} 条规则", { n: config.rules.length })}</span>
                <IconChevron className="pane-arrow" size={13} />
              </button>
              <div className="pane-body">
                <div className="pane-inner">
                  <RulesStep
                    rules={config.rules}
                    presets={presets}
                    openIds={openIds}
                    removing={removing}
                    onToggleOpen={toggleOpen}
                    onSetAllOpen={setAllOpen}
                    onAddRule={addRule}
                    onChangeRule={changeRule}
                    onRemoveRule={removeRule}
                    onMoveRule={moveRule}
                    onApplyPreset={applyPreset}
                    onSavePreset={savePreset}
                    onDeletePreset={deletePreset}
                    onImportChain={importChain}
                    onExportChain={exportChain}
                    groups={config.groups}
                    onChangeGroup={changeGroup}
                    onRemoveGroup={removeGroup}
                    onAddGroup={addGroup}
                    onSetGroupOf={setGroupOf}
                    onCreateGroupFor={createGroupFor}
                  />
                </div>
              </div>
            </section>

            {/* 执行选项与撤销历史（低频，默认收起） */}
            <section
              className={`pane pane-run ${collapsed.run ? "closed" : ""}`}
              ref={(el) => {
                paneRefs.current.run = el;
              }}
            >
              <button
                className="pane-head"
                onClick={() => togglePane("run")}
                title={collapsed.run ? t("展开执行选项") : t("收起执行选项")}
              >
                <span className="pane-icon">
                  <IconPlay size={15} />
                </span>
                <span className="pane-titles">
                  <b>{t("执行选项")}</b>
                  <i>{t("编号顺序、冲突策略与撤销历史")}</i>
                </span>
                <span className="pane-meta">
                  {interrupted.length > 0 ? (
                    <b className="pane-warn">
                      待恢复{" "}
                      {interrupted.reduce((s, b) => s + b.pending.length, 0)}
                    </b>
                  ) : plan ? (
                    t("可执行 {n}", { n: plan.executable })
                  ) : (
                    t("等待预览")
                  )}
                </span>
                <IconChevron className="pane-arrow" size={13} />
              </button>
              <div className="pane-body">
                <div className="pane-inner">
                  <RunStep
                    plan={plan}
                    config={config}
                    batches={batches}
                    interrupted={interrupted}
                    failures={lastFailures}
                    canRetry={failedOps.length > 0}
                    busy={busy}
                    onChange={patchConfig}
                    onUndo={undo}
                    onRecover={recover}
                    onRetry={retry}
                    onDismissFailures={dismissFailures}
                  />
                </div>
              </div>
            </section>
          </div>
        </section>

        <div
          className="splitter"
          title="拖动调整宽度 · 双击恢复默认"
          onPointerDown={startSplit}
          onDoubleClick={resetSplit}
        />

        <section className="preview" style={{ width: previewW }}>
          <header className="preview-head">
            <h3>{t("预览")}</h3>
            {planning && <span className="planning">{t("计算中…")}</span>}
            {planError && <span className="plan-err">{planError}</span>}
            <span className="preview-hint">
              {t("整行可拖动排序 · Ctrl/Shift 点选多行 · 勾掉选框可排除")}
            </span>
          </header>
          <FileFilterBar
            entries={entries}
            filter={fileFilter}
            matched={filterHitIds.size}
            onFilterChange={setFileFilter}
            sort={config}
            onSortChange={patchConfig}
          />
          <PreviewTable
            ops={plan?.ops ?? []}
            excluded={excludedSet}
            rowHeight={ROW_H[settings.density]}
            onToggle={(id) => {
              if (filterExcluded.has(id)) {
                notify(
                  "warn",
                  "这个文件由筛选条控制，要改它请调整预览上方的筛选",
                );
                return;
              }
              patchConfig({
                excluded: config.excluded.includes(id)
                  ? config.excluded.filter((x) => x !== id)
                  : [...config.excluded, id],
              });
            }}
            onReorder={reorderToIndex}
            onOpen={openPath}
            onReveal={revealPath}
            onCopy={copyToClipboard}
            onSetExcluded={setExcluded}
          />
        </section>
      </div>

      <footer className="statusbar">
        <div className="counts">
          {plan ? (
            <>
              <span className="c ok">{t("可执行 {n}", { n: plan.executable })}</span>
              {plan.conflicts > 0 && (
                <span className="c conflict">{t("冲突 {n}", { n: plan.conflicts })}</span>
              )}
              {plan.invalid > 0 && (
                <span className="c invalid">{t("非法 {n}", { n: plan.invalid })}</span>
              )}
              {plan.unchanged > 0 && (
                <span className="c muted">{t("无变化 {n}", { n: plan.unchanged })}</span>
              )}
              {plan.excluded > 0 && (
                <span className="c muted">{t("已排除 {n}", { n: plan.excluded })}</span>
              )}
            </>
          ) : (
            <span className="c muted">{t("等待添加文件")}</span>
          )}
        </div>

        <div className="progress-wrap">
          {progress && progress.total > 0 ? (
            <>
              <div className="bar">
                <div
                  className="fill"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <span className="phase">
                {progress.phase} {progress.done}/{progress.total}
              </span>
            </>
          ) : (
            <span className="phase dim">
              {t('Ctrl+Enter 执行 · Ctrl+Z 撤销 · Ctrl+1/2/3 定位分区')}
            </span>
          )}
        </div>

        <div className="run">
          <button
            className="btn ghost"
            onClick={() => lastBatch && undo(lastBatch)}
            disabled={!lastBatch || busy}
            title="撤销最近一次执行"
          >
            <IconUndo size={15} />
            {t("撤销")}
          </button>
          <button
            className="btn primary run-btn"
            onClick={run}
            disabled={busy || !plan || plan.executable === 0}
          >
            <IconPlay size={15} />
            {t("执行改名")}
            {plan ? `（${plan.executable}）` : ""}
          </button>
        </div>
      </footer>

      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        onChange={patchSettings}
        onClose={() => setSettingsOpen(false)}
        updater={updater}
      />

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
