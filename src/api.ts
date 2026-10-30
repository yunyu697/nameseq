import { invoke } from "@tauri-apps/api/core";
import type {
  BatchInfo,
  BatchResult,
  ChainFile,
  FileEntry,
  InterruptedBatch,
  Plan,
  RenameConfig,
  RenameOp,
} from "./types";

export interface ScanFlags {
  recursive: boolean;
  includeDirs: boolean;
  readMedia: boolean;
  /** 把传入的文件夹本身当成一个可改名条目，而不是展开它的内容 */
  foldersSelf?: boolean;
}

export const scanPaths = (paths: string[], f: ScanFlags) =>
  invoke<FileEntry[]>("scan_paths", {
    paths,
    recursive: f.recursive,
    includeDirs: f.includeDirs,
    readMedia: f.readMedia,
    foldersSelf: !!f.foldersSelf,
  });

export const planRename = (entries: FileEntry[], config: RenameConfig) =>
  invoke<Plan>("plan_rename", { entries, config });

export const executePlan = (ops: RenameOp[], dryRun = false) =>
  invoke<BatchResult>("execute_plan", { ops, dryRun });

export const undoBatch = (batchId: string) =>
  invoke<BatchResult>("undo_batch", { batchId });

export const listBatches = () => invoke<BatchInfo[]>("list_batches");

/* ---------- 规则链 .nsq ---------- */

/** 把当前配置序列化成 .nsq 文本（版本号与校验在 Rust 侧，前后端不会各写一套） */
export const exportChain = (config: RenameConfig, name: string) =>
  invoke<string>("export_chain", { config, name });

export const importChain = (text: string) =>
  invoke<ChainFile>("import_chain", { text });

export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });

export const writeTextFile = (path: string, text: string) =>
  invoke<void>("write_text_file", { path, text });

/** 启动时查：有没有崩溃留下的、卡在临时名上的批次 */
export const interruptedBatches = () =>
  invoke<InterruptedBatch[]>("interrupted_batches");

/** 把没跑完的批次还原成原名 */
export const recoverBatch = (batchId: string) =>
  invoke<BatchResult>("recover_batch", { batchId });

/** 用系统默认程序打开文件（右键菜单） */
export const openPath = (path: string) =>
  invoke<void>("plugin:opener|open_path", { path });

/** 在资源管理器里显示该文件并选中 */
export const revealPath = (path: string) =>
  invoke<void>("plugin:opener|reveal_item_in_dir", { path });

/** 写系统剪贴板（走 Rust arboard，绕开 WebView2 的剪贴板权限） */
export const copyText = (text: string) => invoke<void>("copy_text", { text });
