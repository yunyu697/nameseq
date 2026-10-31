import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** 更新检查频率；manual = 只在用户点「检查更新」时查 */
export type UpdateFreq = "startup" | "daily" | "weekly" | "manual";

const LAST_CHECK_KEY = "renamesmith.updatecheck.v1";
/** Release notes 缓存（1 小时），键与时间戳分开存 */
const NOTES_KEY = "renamesmith.releases.v1";
const NOTES_TTL = 3600_000;

const REPO_API = "https://api.github.com/repos/yunyu697/nameseq/releases";
export const RELEASE_PAGE = "https://github.com/yunyu697/nameseq/releases/latest";

export interface UpdatePhase {
  status:
    | "idle" // 还没查过
    | "checking"
    | "available" // 有更新，等用户选
    | "downloading"
    | "downloaded" // 仅下载完成，等安装
    | "installing"
    | "uptodate"
    | "error";
  /** 新版本号（available / downloaded 时有） */
  version: string;
  /** 更新说明：优先取 updater 返回的 body，空则去 GitHub releases 捞 */
  notes: string;
  /** 下载进度 0-100 */
  progress: number;
  error: string;
}

type RawUpdate = {
  version: string;
  body?: string;
  download: (cb?: (e: DownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  downloadAndInstall: (cb?: (e: DownloadEvent) => void) => Promise<void>;
};

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

function dueFor(freq: UpdateFreq): boolean {
  if (freq === "manual") return false;
  const last = Number(localStorage.getItem(LAST_CHECK_KEY) || 0);
  const span =
    freq === "startup" ? 0 : freq === "daily" ? 86_400_000 : 604_800_000;
  return Date.now() - last >= span;
}

/** 下载进度回调：Started 里拿总大小，Progress 累加算真实百分比。
    doneStatus = 下载完成后进入的状态（downloaded = 仅下载；installing = 连装）。 */
function onDownloadEvent(
  doneStatus: "downloaded" | "installing",
  setPhase: Dispatch<SetStateAction<UpdatePhase>>,
): (e: DownloadEvent) => void {
  const acc = { got: 0, total: 0 };
  return (e) => {
    if (e.event === "Started") {
      acc.got = 0;
      acc.total = e.data.contentLength ?? 0;
    } else if (e.event === "Progress") {
      acc.got += e.data.chunkLength;
      const pct =
        acc.total > 0 ? Math.round((acc.got / acc.total) * 100) : -1;
      setPhase((s) => ({
        ...s,
        progress: pct >= 0 ? Math.min(99, pct) : Math.min(99, s.progress + 3),
      }));
    } else if (e.event === "Finished") {
      setPhase((s) => ({ ...s, status: doneStatus, progress: 100 }));
    }
  };
}

/** 更新体验的总入口：启动自动检查（按频率）、三按钮动作、release notes。
    全部动态 import —— 浏览器预览里没有 Tauri 插件，静默降级不白屏。 */
export function useUpdater(freq: UpdateFreq) {
  const [phase, setPhase] = useState<UpdatePhase>({
    status: "idle",
    version: "",
    notes: "",
    progress: 0,
    error: "",
  });
  // 拿到更新对象后一直攥在手里：仅下载后「安装」还要用它
  const rawRef = useRef<RawUpdate | null>(null);
  // 防止 StrictMode/依赖抖动导致重复检查
  const autoRan = useRef(false);

  const relaunch = async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      /* 浏览器里没有这插件 */
    }
  };

  /** 主动检查。silent = 启动时的自动检查，失败不打扰。返回是否发现更新。 */
  const check = useCallback(async (silent = false): Promise<boolean> => {
    setPhase((s) => ({
      ...s,
      status: "checking",
      error: "",
      progress: 0,
    }));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = (await check()) as RawUpdate | null;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (!update) {
        setPhase((s) => ({ ...s, status: "uptodate" }));
        return false;
      }
      rawRef.current = update;
      const notes = update.body?.trim() ?? "";
      setPhase((s) => ({
        ...s,
        status: "available",
        version: update.version,
        notes,
      }));
      return true;
    } catch (e) {
      if (silent) {
        setPhase((s) => (s.status === "checking" ? { ...s, status: "idle" } : s));
      } else {
        setPhase((s) => ({ ...s, status: "error", error: String(e) }));
      }
      return false;
    }
  }, []);

  // 启动自动检查：到点才查，查到由调用方（App）弹提示
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (!dueFor(freq)) return;
    void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 立即更新：下载 + 安装 + 重启 */
  const installNow = useCallback(async () => {
    const update = rawRef.current;
    if (!update) return;
    setPhase((s) => ({ ...s, status: "downloading", progress: 0 }));
    try {
      await update.downloadAndInstall(onDownloadEvent("installing", setPhase));
      await relaunch();
    } catch (e) {
      setPhase((s) => ({ ...s, status: "error", error: String(e) }));
    }
  }, []);

  /** 仅下载：装不装等用户确认 */
  const downloadOnly = useCallback(async () => {
    const update = rawRef.current;
    if (!update) return;
    setPhase((s) => ({ ...s, status: "downloading", progress: 0 }));
    try {
      await update.download(onDownloadEvent("downloaded", setPhase));
    } catch (e) {
      setPhase((s) => ({ ...s, status: "error", error: String(e) }));
    }
  }, []);

  /** 安装已下载的包 */
  const installDownloaded = useCallback(async () => {
    const update = rawRef.current;
    if (!update) return;
    setPhase((s) => ({ ...s, status: "installing" }));
    try {
      await update.install();
      await relaunch();
    } catch (e) {
      setPhase((s) => ({ ...s, status: "error", error: String(e) }));
    }
  }, []);

  /** 打开浏览器看 Release 页（与 api.ts 一致，直接 invoke opener 插件） */
  const openReleasePage = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("plugin:opener|open_url", { url: RELEASE_PAGE });
    } catch {
      window.open(RELEASE_PAGE, "_blank");
    }
  }, []);

  return {
    phase,
    check,
    installNow,
    downloadOnly,
    installDownloaded,
    openReleasePage,
  };
}

/* ---------------- Release notes ---------------- */

export interface ReleaseInfo {
  tag: string;
  name: string;
  date: string;
  body: string;
}

/** 拉最近几条 Release 说明。失败返回 null（界面显示「暂时拿不到」）。 */
export async function fetchReleases(): Promise<ReleaseInfo[] | null> {
  try {
    const cached = localStorage.getItem(NOTES_KEY);
    if (cached) {
      const { at, data } = JSON.parse(cached) as {
        at: number;
        data: ReleaseInfo[];
      };
      if (Date.now() - at < NOTES_TTL && Array.isArray(data)) return data;
    }
  } catch {
    /* 缓存坏了就当没有 */
  }
  try {
    const r = await fetch(`${REPO_API}?per_page=8`);
    if (!r.ok) return null;
    const list = (await r.json()) as {
      tag_name: string;
      name: string | null;
      published_at: string;
      body: string | null;
    }[];
    const data: ReleaseInfo[] = list.map((x) => ({
      tag: x.tag_name,
      name: x.name || x.tag_name,
      date: x.published_at,
      body: x.body ?? "",
    }));
    localStorage.setItem(
      NOTES_KEY,
      JSON.stringify({ at: Date.now(), data }),
    );
    return data;
  } catch {
    return null;
  }
}
