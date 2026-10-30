use renamer_core::journal::Journal;
use renamer_core::model::{FileEntry, OpStatus, RenameOp};
use renamer_core::planner::{self, Plan, RenameConfig};
use renamer_core::scanner::{self, ScanOptions};
use renamer_core::chain::ChainFile;
use renamer_core::{executor, BatchInfo, BatchResult, ExecOptions, InterruptedBatch};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static JOURNAL: OnceLock<Journal> = OnceLock::new();

/// 撤销日志放在系统标准的应用数据目录里，卸载重装也不会丢。
fn journal(app: &AppHandle) -> Result<&'static Journal, String> {
    if let Some(j) = JOURNAL.get() {
        return Ok(j);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let j = Journal::open(dir.join("rename-journal.jsonl"))
        .map_err(|e| format!("无法打开撤销日志: {e}"))?;
    // 并发下 set 失败说明别的线程已经写进去了，直接取那个即可
    let _ = JOURNAL.set(j);
    JOURNAL.get().ok_or_else(|| "撤销日志初始化失败".to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    phase: String,
}

/// 扫描一批路径。递归遍历在阻塞线程池里跑，不会卡住 UI。
#[tauri::command]
pub async fn scan_paths(
    paths: Vec<String>,
    recursive: bool,
    include_dirs: bool,
    read_media: bool,
    folders_self: bool,
) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        scanner::scan(
            &roots,
            &ScanOptions {
                recursive,
                include_dirs,
                include_hidden: true,
                read_media,
                dir_roots_as_entries: folders_self,
            },
        )
    })
    .await
    .map_err(|e| format!("扫描任务失败: {e}"))
}

/// 计算改名方案（纯计算 + 只读探测，不落盘）。
#[tauri::command]
pub async fn plan_rename(entries: Vec<FileEntry>, config: RenameConfig) -> Result<Plan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        planner::build_plan(&entries, &config).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("规划任务失败: {e}"))?
}

/// 执行改名。前端把预览时看到的 ops 原样传回来，保证所见即所改。
#[tauri::command]
pub async fn execute_plan(
    app: AppHandle,
    ops: Vec<RenameOp>,
    dry_run: bool,
) -> Result<BatchResult, String> {
    execute_ops(app, ops, dry_run).await
}

/// 重试上次没成功的条目。
///
/// 关键在 `refresh_ops`：失败往往是因为「预览后文件被改过」或「当时被占用」，
/// 直接拿旧计划重跑会被同样的门槛再拦一次。这里先按当前磁盘状态刷新元数据再执行。
#[tauri::command]
pub async fn retry_failed(app: AppHandle, ops: Vec<RenameOp>) -> Result<BatchResult, String> {
    let refreshed = executor::refresh_ops(&ops);
    execute_ops(app, refreshed, false).await
}

async fn execute_ops(
    app: AppHandle,
    ops: Vec<RenameOp>,
    dry_run: bool,
) -> Result<BatchResult, String> {
    let total = ops.len();
    let executable = ops.iter().filter(|o| o.status == OpStatus::Ok).count();
    let plan = Plan {
        ops,
        total,
        executable,
        conflicts: 0,
        invalid: 0,
        unchanged: total - executable,
        excluded: 0,
    };

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<BatchResult, String> {
        let j = journal(&handle)?;
        let emitter = handle.clone();
        let mut on_progress = move |done: usize, total: usize, phase: &str| {
            let _ = emitter.emit(
                "rename://progress",
                Progress {
                    done,
                    total,
                    phase: phase.to_string(),
                },
            );
        };
        Ok(executor::execute(
            &plan,
            j,
            &ExecOptions { dry_run },
            &mut on_progress,
        ))
    })
    .await
    .map_err(|e| format!("执行任务失败: {e}"))?
}

/// 撤销某一批次。
#[tauri::command]
pub async fn undo_batch(app: AppHandle, batch_id: String) -> Result<BatchResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<BatchResult, String> {
        let j = journal(&handle)?;
        let emitter = handle.clone();
        let mut on_progress = move |done: usize, total: usize, phase: &str| {
            let _ = emitter.emit(
                "rename://progress",
                Progress {
                    done,
                    total,
                    phase: phase.to_string(),
                },
            );
        };
        executor::undo(&batch_id, j, &mut on_progress).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("撤销任务失败: {e}"))?
}

/// 历史批次列表，用于「撤销上一次」按钮。
#[tauri::command]
pub async fn list_batches(app: AppHandle) -> Result<Vec<BatchInfo>, String> {
    let j = journal(&app)?;
    j.batches().map_err(|e| e.to_string())
}

/// 启动时查一下：有没有上次崩溃留下的、卡在临时名上的批次。
#[tauri::command]
pub async fn interrupted_batches(app: AppHandle) -> Result<Vec<InterruptedBatch>, String> {
    let j = journal(&app)?;
    j.interrupted().map_err(|e| e.to_string())
}

/// 崩溃恢复：把某个没跑完的批次按日志逆序还原成原名。
#[tauri::command]
pub async fn recover_batch(app: AppHandle, batch_id: String) -> Result<BatchResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<BatchResult, String> {
        let j = journal(&handle)?;
        let emitter = handle.clone();
        let mut on_progress = move |done: usize, total: usize, phase: &str| {
            let _ = emitter.emit(
                "rename://progress",
                Progress {
                    done,
                    total,
                    phase: phase.to_string(),
                },
            );
        };
        executor::recover(&batch_id, j, &mut on_progress).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("恢复任务失败: {e}"))?
}

/// 把文本放进系统剪贴板（右键菜单「复制文件名/路径」用）。
/// arboard 是纯本地实现，不经过网页 Clipboard API，绕开 WebView2 的权限问题。
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| format!("写入剪贴板失败: {e}"))
}

/* ---------------- 规则链 .nsq ---------------- */

/// 序列化当前规则链。版本号、排除项剥离、每条规则能否编译，全部在引擎里判定，
/// 前端只负责把结果写进文件——否则两边各写一套校验，迟早对不上。
#[tauri::command]
pub fn export_chain(config: RenameConfig, name: String) -> Result<String, String> {
    let file = ChainFile::from_config(&name, &config);
    file.validate()?;
    Ok(file.to_json())
}

#[tauri::command]
pub fn import_chain(text: String) -> Result<ChainFile, String> {
    ChainFile::parse(&text)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读不了这个文件: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))
}
