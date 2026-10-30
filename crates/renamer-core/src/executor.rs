//! 两阶段改名执行器。
//!
//! 为什么不能逐个直接改：一批文件的目标名可能互相占用（a→b 同时 b→c），
//! 或者干脆形成环（a→b, b→a）。直接改在第二种情况下必然失败，在第一种情况下
//! 会静默覆盖文件（Linux/macOS 的 rename 允许覆盖目标）。
//!
//! 所以统一走：
//! ```text
//! 阶段一：所有源文件先改名到同目录下的临时名  a.txt -> .rnm-<batch>-0
//! 阶段二：临时名再改名到最终目标名            .rnm-<batch>-0 -> b.txt
//! ```
//! 阶段一跑完，所有目标路径都已经空出来了，阶段二就不可能撞车。
//!
//! 每一小步都「先写日志再动文件」，因此崩溃后可以用 undo 逆推。

use crate::journal::Journal;
use crate::model::{OpStatus, RenameOp};
use crate::planner::Plan;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    /// 只走一遍流程不真正改文件，用来验证
    pub dry_run: bool,
}

/// 失败原因分类。
///
/// 为什么要分类：`OS error 32` 对用户毫无意义，但「文件被其它程序占用」他能立刻去关掉那个程序。
/// 分类还顺带回答了「重试有没有意义」——被占用、被改过可以重试，源文件没了重试多少次都一样。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailKind {
    /// 文件被别的进程占着（Windows 的共享冲突 / 锁冲突，Unix 的 EBUSY）
    Occupied,
    /// 权限不够：只读属性、ACL、目录不可写
    Permission,
    /// 源文件已经不在了
    Missing,
    /// 目标名在执行那一刻被别的文件占了
    Exists,
    /// 预览之后文件被改过，元数据和计划对不上
    Drifted,
    /// 名字或完整路径太长
    NameTooLong,
    /// 其它（保留原始错误信息）
    Other,
}

impl FailKind {
    /// 重试有没有意义。Missing / Exists / NameTooLong 得先由用户动手改点什么。
    pub fn retryable(self) -> bool {
        matches!(
            self,
            FailKind::Occupied | FailKind::Permission | FailKind::Drifted | FailKind::Other
        )
    }

    /// 给用户看的、能照着做的一句话
    pub fn hint(self) -> &'static str {
        match self {
            FailKind::Occupied => {
                "文件正被其它程序占用：关掉正在用它/预览它的程序（播放器、编辑器、同步盘）再重试"
            }
            FailKind::Permission => {
                "没有权限改这个文件：检查它是不是只读，或者当前账户能不能写这个目录"
            }
            FailKind::Missing => "源文件已经不在了，可能被移动或删除；刷新文件列表后重新规划",
            FailKind::Exists => "目标名在执行那一刻被占用了，改用「重名时自动加 (1)(2)」再执行",
            FailKind::Drifted => "文件在预览之后被改过，重新预览确认结果后再执行",
            FailKind::NameTooLong => "新名字或完整路径太长，缩短规则输出（比如减少固定前缀）再试",
            FailKind::Other => "系统没给出更具体的原因，可以直接重试一次",
        }
    }
}

/// 从 io::Error 猜原因。Windows 的错误码比 ErrorKind 更细，
/// 比如共享冲突被归到 PermissionDenied，但处理方式完全不同——所以要单独看错误码。
fn classify(e: &std::io::Error) -> FailKind {
    use std::io::ErrorKind;
    // ErrorKind 已经能确定的，先按它走
    match e.kind() {
        ErrorKind::NotFound => return FailKind::Missing,
        ErrorKind::AlreadyExists => return FailKind::Exists,
        _ => {}
    }
    match e.raw_os_error() {
        // Windows：32 = ERROR_SHARING_VIOLATION，33 = ERROR_LOCK_VIOLATION
        Some(32) | Some(33) => FailKind::Occupied,
        // Windows：5 = ERROR_ACCESS_DENIED，19 = ERROR_WRITE_PROTECT
        Some(5) | Some(19) => FailKind::Permission,
        // Windows：206 = ERROR_FILENAME_EXCED_RANGE
        Some(206) => FailKind::NameTooLong,
        // Windows：2/3 = 找不到路径 / 路径不存在
        Some(2) | Some(3) => FailKind::Missing,
        // Unix：EBUSY / EACCES / ENAMETOOLONG / ENOTEMPTY
        Some(16) => FailKind::Occupied,
        Some(13) | Some(1) => FailKind::Permission,
        Some(36) | Some(63) => FailKind::NameTooLong,
        _ => {
            if e.kind() == ErrorKind::PermissionDenied {
                FailKind::Permission
            } else {
                FailKind::Other
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub id: u64,
    pub from: String,
    pub to: String,
    pub ok: bool,
    /// 技术性描述（含系统原文），直接给日志或高级用户看
    pub error: Option<String>,
    /// 失败原因分类，成功时为 None
    #[serde(default)]
    pub kind: Option<FailKind>,
    /// 一句能照着做的建议（由 kind 决定，前端直接展示）
    #[serde(default)]
    pub hint: Option<String>,
    /// 这个失败重试有没有意义（前端据此决定按钮是否可点）
    #[serde(default)]
    pub retryable: bool,
}

impl OpResult {
    fn ok(id: u64, from: &str, to: &str) -> Self {
        Self {
            id,
            from: from.to_string(),
            to: to.to_string(),
            ok: true,
            error: None,
            kind: None,
            hint: None,
            retryable: false,
        }
    }

    fn failed(mut self, kind: FailKind, detail: impl Into<String>) -> Self {
        self.ok = false;
        self.kind = Some(kind);
        self.retryable = kind.retryable();
        self.hint = Some(kind.hint().to_string());
        self.error = Some(detail.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub batch_id: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    /// 计划里本来就不是可执行状态的条目数（冲突 / 非法 / 无需改名）
    pub skipped: usize,
    pub results: Vec<OpResult>,
}

/// 执行一份改名计划。
pub fn execute(
    plan: &Plan,
    journal: &Journal,
    opts: &ExecOptions,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> BatchResult {
    let batch_id = new_batch_id();
    let skipped = plan.ops.iter().filter(|o| o.status != OpStatus::Ok).count();

    let mut results: Vec<OpResult> = Vec::new();
    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut owners: Vec<usize> = Vec::new();

    for op in plan.ops.iter().filter(|o| o.status == OpStatus::Ok) {
        let base = OpResult::ok(op.id, &op.from, &op.to);

        // 执行前复核：文件在用户预览的这几分钟里可能已经被外部删掉或改写了
        match std::fs::metadata(&op.from) {
            Ok(m) => {
                let size = m.len();
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let drifted = op.modified_ms > 0 && (size != op.size || mtime != op.modified_ms);
                if drifted {
                    results.push(base.failed(
                        FailKind::Drifted,
                        "文件在预览期间被修改，已跳过（重新预览后会按最新状态计算）",
                    ));
                    continue;
                }
            }
            Err(e) => {
                let kind = classify(&e);
                results.push(base.failed(kind, format!("源文件不可访问：{e}")));
                continue;
            }
        }

        owners.push(results.len());
        results.push(base);
        pairs.push((PathBuf::from(&op.from), PathBuf::from(&op.to)));
    }

    if opts.dry_run {
        let total = pairs.len();
        progress(total, total, "预演");
        return summarize(batch_id, results, skipped);
    }

    let outcomes = two_phase(&pairs, journal, &batch_id, progress);
    for (pair_idx, outcome) in outcomes.into_iter().enumerate() {
        if let Err((kind, msg)) = outcome {
            let slot = owners[pair_idx];
            results[slot] = results[slot].clone().failed(kind, msg);
        }
    }

    // 完成标记：崩溃恢复靠它区分「跑完的批次」和「跑到一半挂掉的批次」。
    // 即使有个别文件失败，这一批本身也是走完了的。
    let _ = journal.mark_done(&batch_id);

    summarize(batch_id, results, skipped)
}

/// 撤销某一批次。
///
/// 注意这里**不能**复用两阶段流程。两阶段的前提是「所有操作彼此独立、可以同时暂存」，
/// 而撤销是一串有先后依赖的链式操作：`a→t1`、`b→t0`、`t1→b`、`t0→a`，
/// 后一步要用的文件是前一步刚腾出来的。所以只能严格按逆序一步步串行执行。
///
/// 撤销本身也记成新批次，因此「撤销的撤销」就是重做。
pub fn undo(
    batch_id: &str,
    journal: &Journal,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> std::io::Result<BatchResult> {
    let steps = journal.steps_for(batch_id)?;
    if steps.is_empty() {
        return Ok(BatchResult {
            batch_id: batch_id.to_string(),
            total: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            results: Vec::new(),
        });
    }

    let new_batch = new_batch_id();
    let reversed: Vec<(PathBuf, PathBuf)> = steps
        .iter()
        .rev()
        .map(|s| (PathBuf::from(&s.to), PathBuf::from(&s.from)))
        .collect();

    let total = reversed.len();
    let mut results = Vec::with_capacity(total);

    for (i, (src, dst)) in reversed.iter().enumerate() {
        let mut res = OpResult::ok(0, &src.to_string_lossy(), &dst.to_string_lossy());

        if !src.exists() {
            res = res.failed(
                FailKind::Missing,
                "源文件已不存在（可能已被外部移动或删除）",
            );
        } else if dst.exists() {
            // 逆序链正常情况下目标一定是空的，非空说明有外部干扰，宁可不做
            res = res.failed(FailKind::Exists, "目标位置已有文件，为避免覆盖已跳过");
        } else if let Err(e) = journal.record(&new_batch, src, dst) {
            res = res.failed(FailKind::Other, format!("写撤销日志失败：{e}"));
        } else if let Err(e) = std::fs::rename(src, dst) {
            let kind = classify(&e);
            res = res.failed(kind, format!("还原失败：{e}"));
        }

        results.push(res);
        progress(i + 1, total, "撤销");
    }

    let _ = journal.mark_done(&new_batch);
    Ok(summarize(new_batch, results, 0))
}

/// 崩溃恢复：把没跑完的批次按日志逆序还原。
///
/// 复用 undo 的逆序逻辑是有意的——崩溃现场的步骤序列和「执行完成」的序列是同一种东西，
/// 区别只是后半段可能缺了几步。缺了的那几步对应「还没改名」，逆推时源文件不存在，
/// 会被逐条跳过并报告，不会破坏已经还原的部分。
pub fn recover(
    batch_id: &str,
    journal: &Journal,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> std::io::Result<BatchResult> {
    let r = undo(batch_id, journal, progress)?;
    // 复原完给原批次补一个完成标记，否则它会在列表里永远显示成「未完成」
    let _ = journal.mark_done(batch_id);
    Ok(r)
}

/// 重试前刷新每条 op 的元数据。
///
/// 上次因为「预览后被改动」或「被占用」失败的文件，直接拿旧 op 再跑一遍还会被同样的门槛拦住：
/// 漂移校验比的是旧 size/mtime。这里重新 stat 一遍更新成当前状态，并把状态重置成可执行。
/// 源文件已经不在的条目保持 0 元数据，执行时会如实报 Missing，而不是误判成「被改动」。
pub fn refresh_ops(ops: &[RenameOp]) -> Vec<RenameOp> {
    ops.iter()
        .map(|o| {
            let mut n = o.clone();
            n.status = OpStatus::Ok;
            n.reason = None;
            match std::fs::metadata(&o.from) {
                Ok(m) => {
                    n.is_dir = m.is_dir();
                    if n.is_dir {
                        n.size = 0;
                        n.modified_ms = 0;
                    } else {
                        n.size = m.len();
                        n.modified_ms = m
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                    }
                }
                Err(_) => {
                    n.size = 0;
                    n.modified_ms = 0;
                }
            }
            n
        })
        .collect()
}

/// 两阶段改名的本体。返回与 `pairs` 一一对应的结果。
fn two_phase(
    pairs: &[(PathBuf, PathBuf)],
    journal: &Journal,
    batch_id: &str,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Vec<Result<(), (FailKind, String)>> {
    let n = pairs.len();
    let mut out: Vec<Result<(), (FailKind, String)>> = (0..n).map(|_| Ok(())).collect();
    if n == 0 {
        return out;
    }
    let total = n * 2;
    let mut done = 0usize;
    let mut staged: Vec<usize> = Vec::with_capacity(n);

    // ── 阶段一：全部挪到临时名，把目标路径空出来 ──
    for i in 0..n {
        let orig = &pairs[i].0;
        let temp = temp_path(orig, batch_id, i);

        if let Err(e) = journal.record(batch_id, orig, &temp) {
            out[i] = Err((FailKind::Other, format!("写撤销日志失败：{e}")));
            done += 1;
            progress(done, total, "暂存");
            continue;
        }
        match std::fs::rename(orig, &temp) {
            Ok(()) => staged.push(i),
            Err(e) => {
                let kind = classify(&e);
                out[i] = Err((kind, format!("暂存（挪到临时名）失败：{e}")));
            }
        }
        done += 1;
        progress(done, total, "暂存");
    }

    // ── 阶段二：临时名落到最终目标名 ──
    for &i in &staged {
        let orig = &pairs[i].0;
        let fin = &pairs[i].1;
        let temp = temp_path(orig, batch_id, i);

        // Linux/macOS 的 rename 会静默覆盖目标，必须自己拦一道
        if fin.exists() {
            let _ = std::fs::rename(&temp, orig);
            out[i] = Err((FailKind::Exists, "目标文件在执行时已存在，已还原原名".into()));
            done += 1;
            progress(done, total, "写入目标名");
            continue;
        }

        if let Err(e) = journal.record(batch_id, &temp, fin) {
            let _ = std::fs::rename(&temp, orig);
            out[i] = Err((FailKind::Other, format!("写撤销日志失败：{e}")));
            done += 1;
            progress(done, total, "写入目标名");
            continue;
        }
        match std::fs::rename(&temp, fin) {
            Ok(()) => {}
            Err(e) => {
                // 尽力把文件还原回原名，别让它卡在临时名上
                let _ = std::fs::rename(&temp, orig);
                let kind = classify(&e);
                out[i] = Err((kind, format!("改名失败：{e}")));
            }
        }
        done += 1;
        progress(done, total, "写入目标名");
    }

    out
}

fn temp_path(orig: &Path, batch: &str, i: usize) -> PathBuf {
    let dir = orig.parent().unwrap_or_else(|| Path::new("."));
    dir.join(format!(".rnm-{batch}-{i}"))
}

fn new_batch_id() -> String {
    format!(
        "{}-{}",
        Local::now().format("%Y%m%d-%H%M%S%3f"),
        std::process::id()
    )
}

fn summarize(batch_id: String, results: Vec<OpResult>, skipped: usize) -> BatchResult {
    let succeeded = results.iter().filter(|r| r.ok).count();
    let failed = results.len() - succeeded;
    BatchResult {
        batch_id,
        total: results.len(),
        succeeded,
        failed,
        skipped,
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileEntry, RenameOp};
    use crate::planner::{Plan, RenameConfig};
    use crate::rule::{Action, Filter, Rule, Target};
    use std::fs;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir().join(format!("renamer-exec-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            Tmp(d)
        }
        fn file(&self, name: &str, body: &str) -> PathBuf {
            let p = self.0.join(name);
            fs::write(&p, body).unwrap();
            p
        }
        fn names(&self) -> Vec<String> {
            let mut v: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            v.sort();
            v
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 日志放在被测目录之外，免得干扰文件名断言
    fn journal_at(dir: &Path) -> Journal {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        Journal::open(std::env::temp_dir().join(format!("{name}-journal.jsonl"))).unwrap()
    }

    fn noop(_: usize, _: usize, _: &str) {}

    /// 直接按「旧名 → 新名」构造计划，方便测试换位、成环这类场景
    fn plan_from_pairs(dir: &Path, pairs: &[(&str, &str)]) -> Plan {
        let mut ops = Vec::new();
        for (i, (from, to)) in pairs.iter().enumerate() {
            let fp = dir.join(from);
            let meta = fs::metadata(&fp).unwrap();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            ops.push(RenameOp {
                id: i as u64 + 1,
                from: fp.to_string_lossy().to_string(),
                to: dir.join(to).to_string_lossy().to_string(),
                old_name: from.to_string(),
                new_name: to.to_string(),
                status: OpStatus::Ok,
                reason: None,
                is_dir: false,
                size: meta.len(),
                modified_ms: mtime,
            });
        }
        let n = ops.len();
        Plan {
            ops,
            total: n,
            executable: n,
            conflicts: 0,
            invalid: 0,
            unchanged: 0,
            excluded: 0,
        }
    }

    fn entry_of(p: &Path) -> FileEntry {
        let meta = fs::metadata(p).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), e.to_string()),
            None => (name.clone(), String::new()),
        };
        FileEntry {
            id: 1,
            path: p.to_string_lossy().to_string(),
            dir: p.parent().unwrap().to_string_lossy().to_string(),
            stem,
            ext,
            name,
            size: meta.len(),
            modified_ms: 0,
            is_dir: false,
            error: None,
            media: None,
        }
    }

    #[test]
    fn simple_batch_rename() {
        let t = Tmp::new("simple");
        t.file("a.txt", "A");
        t.file("b.txt", "B");
        let j = journal_at(&t.0);

        let entries = vec![
            entry_of(&t.0.join("a.txt")),
            entry_of(&t.0.join("b.txt")),
        ];
        let plan = crate::planner::build_plan(
            &entries,
            &RenameConfig {
                rules: vec![Rule {
                    id: "r1".into(),
                    enabled: true,
                    target: Target::Stem,
                    filter: Filter::default(),
                    action: Action::Template {
                        template: "photo-{index:2}".into(),
                    },
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        assert_eq!(r.succeeded, 2, "{:?}", r.results);
        assert_eq!(r.failed, 0);
        assert_eq!(t.names(), vec!["photo-01.txt", "photo-02.txt"]);
    }

    #[test]
    fn swaps_without_losing_files() {
        // 这是最经典的坑：a→b 的同时 b→a，逐个改一定会丢数据
        let t = Tmp::new("swap");
        t.file("a.txt", "AAA");
        t.file("b.txt", "BBB");
        let j = journal_at(&t.0);

        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt"), ("b.txt", "a.txt")]);
        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);

        assert_eq!(r.failed, 0, "{:?}", r.results);
        assert_eq!(fs::read_to_string(t.0.join("a.txt")).unwrap(), "BBB");
        assert_eq!(fs::read_to_string(t.0.join("b.txt")).unwrap(), "AAA");
    }

    #[test]
    fn three_way_rotation() {
        let t = Tmp::new("rotate");
        t.file("1.txt", "one");
        t.file("2.txt", "two");
        t.file("3.txt", "three");
        let j = journal_at(&t.0);

        let plan = plan_from_pairs(
            &t.0,
            &[("1.txt", "2.txt"), ("2.txt", "3.txt"), ("3.txt", "1.txt")],
        );
        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        assert_eq!(r.failed, 0, "{:?}", r.results);
        assert_eq!(fs::read_to_string(t.0.join("1.txt")).unwrap(), "three");
        assert_eq!(fs::read_to_string(t.0.join("2.txt")).unwrap(), "one");
        assert_eq!(fs::read_to_string(t.0.join("3.txt")).unwrap(), "two");
    }

    #[test]
    fn undo_restores_original_names() {
        let t = Tmp::new("undo");
        t.file("a.txt", "A");
        t.file("b.txt", "B");
        let j = journal_at(&t.0);

        let plan = plan_from_pairs(&t.0, &[("a.txt", "x.txt"), ("b.txt", "y.txt")]);
        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        assert_eq!(r.succeeded, 2);
        assert_eq!(t.names(), vec!["x.txt", "y.txt"]);

        let u = undo(&r.batch_id, &j, &mut noop).unwrap();
        assert_eq!(u.failed, 0, "{:?}", u.results);
        assert_eq!(t.names(), vec!["a.txt", "b.txt"]);
        assert_eq!(fs::read_to_string(t.0.join("a.txt")).unwrap(), "A");
    }

    #[test]
    fn undo_of_swap_restores_content() {
        let t = Tmp::new("undoswap");
        t.file("a.txt", "AAA");
        t.file("b.txt", "BBB");
        let j = journal_at(&t.0);

        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt"), ("b.txt", "a.txt")]);
        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        let u = undo(&r.batch_id, &j, &mut noop).unwrap();
        assert_eq!(u.failed, 0, "{:?}", u.results);
        assert_eq!(fs::read_to_string(t.0.join("a.txt")).unwrap(), "AAA");
        assert_eq!(fs::read_to_string(t.0.join("b.txt")).unwrap(), "BBB");
    }

    #[test]
    fn no_temp_files_left_behind() {
        let t = Tmp::new("clean");
        t.file("a.txt", "A");
        let j = journal_at(&t.0);
        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt")]);
        execute(&plan, &j, &ExecOptions::default(), &mut noop);

        let leftovers: Vec<String> = t.names().into_iter().filter(|n| n.starts_with(".rnm-")).collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
    }

    #[test]
    fn dry_run_touches_nothing() {
        let t = Tmp::new("dry");
        t.file("a.txt", "A");
        let j = journal_at(&t.0);
        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt")]);
        let r = execute(
            &plan,
            &j,
            &ExecOptions { dry_run: true },
            &mut noop,
        );
        assert_eq!(r.succeeded, 1);
        assert_eq!(t.names(), vec!["a.txt"]);
    }

    #[test]
    fn missing_source_is_reported_not_panicked() {
        let t = Tmp::new("missing");
        t.file("a.txt", "A");
        let j = journal_at(&t.0);
        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt")]);
        fs::remove_file(t.0.join("a.txt")).unwrap();

        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        assert_eq!(r.failed, 1);
        assert!(r.results[0].error.as_deref().unwrap().contains("不可访问"));
    }

    #[test]
    fn renames_directories_too() {
        let t = Tmp::new("dirs");
        fs::create_dir_all(t.0.join("album-2023")).unwrap();
        fs::write(t.0.join("album-2023").join("a.jpg"), b"x").unwrap();

        let mut e = file_entry_of(&t.0.join("album-2023"));
        e.is_dir = true;
        let plan = crate::planner::build_plan(
            &[e],
            &RenameConfig {
                rules: vec![Rule {
                    id: "r1".into(),
                    enabled: true,
                    target: Target::Stem,
                    filter: Filter::default(),
                    action: Action::Prefix {
                        text: "2023-".into(),
                    },
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let r = execute(&plan, &journal_at(&t.0), &ExecOptions::default(), &mut noop);
        assert_eq!(r.succeeded, 1, "{:?}", r.results);
        assert!(t.0.join("2023-album-2023").is_dir());
        // 目录里的东西跟着走
        assert!(t.0.join("2023-album-2023").join("a.jpg").exists());
    }

    /// 目录条目：Path::extension 不该被当成扩展名
    fn file_entry_of(p: &Path) -> FileEntry {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        FileEntry {
            id: 1,
            path: p.to_string_lossy().to_string(),
            dir: p.parent().unwrap().to_string_lossy().to_string(),
            stem: name.clone(),
            ext: String::new(),
            name,
            size: 0,
            modified_ms: 0,
            is_dir: true,
            error: None,
            media: None,
        }
    }

    #[test]
    fn classifies_common_io_errors() {
        // Windows：32 共享冲突、5 拒绝访问、206 名字过长
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(32)),
            FailKind::Occupied
        );
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(5)),
            FailKind::Permission
        );
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(206)),
            FailKind::NameTooLong
        );
        assert_eq!(
            classify(&std::io::Error::from_raw_os_error(2)),
            FailKind::Missing
        );
        // 重试语义：占用/权限/漂移值得重试，源文件没了重试也没用
        assert!(FailKind::Occupied.retryable());
        assert!(FailKind::Drifted.retryable());
        assert!(!FailKind::Missing.retryable());
        assert!(!FailKind::Exists.retryable());
    }

    #[test]
    fn drift_failure_can_be_retried_with_refreshed_metadata() {
        let t = Tmp::new("retry");
        t.file("a.txt", "A");
        let j = journal_at(&t.0);
        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt")]);

        // 预览之后文件被外面的程序改大了 → 执行时按漂移拦下
        fs::write(t.0.join("a.txt"), "AAA").unwrap();
        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        assert_eq!(r.failed, 1);
        assert_eq!(r.results[0].kind, Some(FailKind::Drifted));
        assert!(r.results[0].retryable);
        assert!(t.0.join("a.txt").exists(), "被拦下的文件不该被动");

        // 刷新元数据后重试，这次能改
        let retry = refresh_ops(&plan.ops);
        let r2 = execute(
            &Plan {
                ops: retry,
                ..plan.clone()
            },
            &j,
            &ExecOptions::default(),
            &mut noop,
        );
        assert_eq!(r2.succeeded, 1, "{:?}", r2.results);
        assert_eq!(fs::read_to_string(t.0.join("b.txt")).unwrap(), "AAA");
    }

    #[test]
    fn missing_source_is_not_retryable() {
        let t = Tmp::new("noretry");
        t.file("a.txt", "A");
        let j = journal_at(&t.0);
        let plan = plan_from_pairs(&t.0, &[("a.txt", "b.txt")]);
        fs::remove_file(t.0.join("a.txt")).unwrap();

        let r = execute(&plan, &j, &ExecOptions::default(), &mut noop);
        assert_eq!(r.results[0].kind, Some(FailKind::Missing));
        assert!(
            !r.results[0].retryable,
            "源文件没了，重试没有意义，不该给用户「重试」的希望"
        );
    }

    #[test]
    fn recover_restores_files_stuck_on_temp_names() {
        // 模拟崩溃现场：文件已经挪到临时名上，日志里有步、但没写完成标记
        let t = Tmp::new("recover");
        let j = journal_at(&t.0);
        let temp = t.0.join(".rnm-b9-0");
        fs::write(&temp, "AAA").unwrap();
        j.record("b9", &t.0.join("a.txt"), &temp).unwrap();

        let list = j.interrupted().unwrap();
        assert_eq!(list.len(), 1, "有活着的临时文件就该判成未完成");
        assert_eq!(list[0].pending.len(), 1);

        let r = recover("b9", &j, &mut noop).unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.results);
        assert_eq!(fs::read_to_string(t.0.join("a.txt")).unwrap(), "AAA");
        assert!(!temp.exists(), "临时文件应该已经还原掉");
        assert!(j.interrupted().unwrap().is_empty(), "还原后不该再报未完成");
    }
}
