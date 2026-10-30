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
use crate::model::OpStatus;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub id: u64,
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
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
        let base = OpResult {
            id: op.id,
            from: op.from.clone(),
            to: op.to.clone(),
            ok: true,
            error: None,
        };

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
                    results.push(OpResult {
                        ok: false,
                        error: Some("文件在预览期间已被修改，已跳过".into()),
                        ..base
                    });
                    continue;
                }
            }
            Err(e) => {
                results.push(OpResult {
                    ok: false,
                    error: Some(format!("源文件不可访问: {e}")),
                    ..base
                });
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
        if let Err(msg) = outcome {
            let slot = owners[pair_idx];
            results[slot].ok = false;
            results[slot].error = Some(msg);
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
        let mut error = None;

        if !src.exists() {
            error = Some("源文件已不存在（可能已被外部移动或删除）".to_string());
        } else if dst.exists() {
            // 逆序链正常情况下目标一定是空的，非空说明有外部干扰，宁可不做
            error = Some("目标位置已有文件，为避免覆盖已跳过".to_string());
        } else if let Err(e) = journal.record(&new_batch, src, dst) {
            error = Some(format!("写撤销日志失败: {e}"));
        } else if let Err(e) = std::fs::rename(src, dst) {
            error = Some(format!("还原失败: {e}"));
        }

        results.push(OpResult {
            id: 0,
            from: src.to_string_lossy().to_string(),
            to: dst.to_string_lossy().to_string(),
            ok: error.is_none(),
            error,
        });
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

/// 两阶段改名的本体。返回与 `pairs` 一一对应的结果。
fn two_phase(
    pairs: &[(PathBuf, PathBuf)],
    journal: &Journal,
    batch_id: &str,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Vec<Result<(), String>> {
    let n = pairs.len();
    let mut out: Vec<Result<(), String>> = (0..n).map(|_| Ok(())).collect();
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
            out[i] = Err(format!("写撤销日志失败: {e}"));
            done += 1;
            progress(done, total, "暂存");
            continue;
        }
        match std::fs::rename(orig, &temp) {
            Ok(()) => staged.push(i),
            Err(e) => out[i] = Err(format!("暂存失败: {e}")),
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
            out[i] = Err("目标文件在执行时已存在，已还原".into());
            done += 1;
            progress(done, total, "写入目标名");
            continue;
        }

        if let Err(e) = journal.record(batch_id, &temp, fin) {
            let _ = std::fs::rename(&temp, orig);
            out[i] = Err(format!("写撤销日志失败: {e}"));
            done += 1;
            progress(done, total, "写入目标名");
            continue;
        }
        match std::fs::rename(&temp, fin) {
            Ok(()) => {}
            Err(e) => {
                // 尽力把文件还原回原名，别让它卡在临时名上
                let _ = std::fs::rename(&temp, orig);
                out[i] = Err(format!("改名失败: {e}"));
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
