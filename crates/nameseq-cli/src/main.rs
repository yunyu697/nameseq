//! nsq —— 名序的命令行前端。
//!
//! 为什么要有它：规则链在界面里调好、存成 `.nsq` 之后，同一份文件应该能在
//! 脚本、定时任务、CI 里跑。引擎（`renamer-core`）本来就是不依赖 GUI 的，
//! 这里补的只是一层参数解析和终端输出。
//!
//! 日志和图形界面共用同一份文件（`rename-journal.jsonl`），所以 CLI 改的名字
//! 在界面里能撤销，反过来也一样。

use renamer_core::chain::ChainFile;
use renamer_core::model::OpStatus;
use renamer_core::planner::build_plan;
use renamer_core::scanner::{scan, ScanOptions};
use renamer_core::{executor, BatchResult, ExecOptions, Journal};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
nsq —— 名序的命令行批量改名

用法:
  nsq run <规则链.nsq> <路径...> [选项]   按规则链改名
  nsq undo [批次号]                       撤销某一批（不写批次号 = 最近一批）
  nsq batches                             看历史批次
  nsq help | --version

run 的选项:
  -r, --recursive   递归子目录
  -d, --dirs        文件夹也改名
  -m, --media       读取音视频标签（只有模板用到 {title} 这类占位符时才需要）
  -n, --dry-run     只打印计划，不改文件
  -y, --yes         不再询问，直接执行（脚本里必须加）
  -q, --quiet       不打印逐个文件的计划，只打印结果汇总

例子:
  nsq run 照片编号.nsq ./photos -r -n
  nsq run 照片编号.nsq ./photos -r -y
  nsq undo
";

#[derive(Debug, Default, Clone)]
struct RunFlags {
    recursive: bool,
    dirs: bool,
    media: bool,
    dry_run: bool,
    yes: bool,
    quiet: bool,
}

#[derive(Debug)]
enum Cmd {
    Run {
        chain: PathBuf,
        paths: Vec<PathBuf>,
        flags: RunFlags,
    },
    Undo {
        batch: Option<String>,
    },
    Batches,
    Help,
    Version,
}

fn parse_args(argv: &[String]) -> Result<Cmd, String> {
    if argv.is_empty() {
        return Ok(Cmd::Help);
    }
    match argv[0].as_str() {
        "help" | "-h" | "--help" => Ok(Cmd::Help),
        "-V" | "--version" => Ok(Cmd::Version),
        "batches" => Ok(Cmd::Batches),
        "undo" => Ok(Cmd::Undo {
            batch: argv.get(1).cloned(),
        }),
        "run" => {
            let mut it = argv[1..].iter();
            let chain = it.next().ok_or("run 需要一个规则链文件（.nsq）")?.clone();
            let mut flags = RunFlags::default();
            let mut paths = Vec::new();
            for a in it {
                match a.as_str() {
                    "-r" | "--recursive" => flags.recursive = true,
                    "-d" | "--dirs" => flags.dirs = true,
                    "-m" | "--media" => flags.media = true,
                    "-n" | "--dry-run" => flags.dry_run = true,
                    "-y" | "--yes" => flags.yes = true,
                    "-q" | "--quiet" => flags.quiet = true,
                    other if other.starts_with('-') => {
                        return Err(format!("不认识的选项 {other}"));
                    }
                    other => paths.push(PathBuf::from(other)),
                }
            }
            if paths.is_empty() {
                return Err("至少给一个要改名的路径".into());
            }
            Ok(Cmd::Run {
                chain: PathBuf::from(chain),
                paths,
                flags,
            })
        }
        other => Err(format!("不认识子命令 {other}（试 nsq help）")),
    }
}

/// 日志位置必须和图形界面一致：Windows 上 Tauri 的 app_data_dir 就是
/// `%APPDATA%\<identifier>`。两边指向同一个文件，撤销才能互通。
fn journal_path() -> PathBuf {
    if let Some(p) = std::env::var_os("NSQ_JOURNAL") {
        return PathBuf::from(p);
    }
    let id = "com.nameseq.app";
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.unwrap_or_else(|| PathBuf::from("."))
        .join(id)
        .join("rename-journal.jsonl")
}

fn status_label(s: OpStatus) -> &'static str {
    match s {
        OpStatus::Ok => "改名",
        OpStatus::Unchanged => "跳过",
        OpStatus::Conflict => "冲突",
        OpStatus::Invalid => "非法",
        OpStatus::Missing => "变化",
        OpStatus::Excluded => "排除",
    }
}

fn confirm(prompt: &str) -> bool {
    print!("{prompt} [y/N] ");
    let _ = io::stdout().flush();
    let mut s = String::new();
    if io::stdin().read_line(&mut s).unwrap_or(0) == 0 {
        return false; // 非交互环境没加 --yes，一律不动手
    }
    matches!(s.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

fn run(chain_path: &Path, paths: &[PathBuf], flags: &RunFlags) -> Result<u8, String> {
    let text = std::fs::read_to_string(chain_path)
        .map_err(|e| format!("读不了规则链 {}：{e}", chain_path.display()))?;
    let chain = ChainFile::parse(&text)?;

    let entries = scan(
        paths,
        &ScanOptions {
            recursive: flags.recursive,
            include_dirs: flags.dirs,
            include_hidden: true,
            read_media: flags.media,
            dir_roots_as_entries: false,
        },
    );
    if entries.is_empty() {
        return Err("这些路径里没有可处理的文件（递归模式要加 -r）".into());
    }

    let plan = build_plan(&entries, &chain.config).map_err(|e| e.to_string())?;

    if !flags.quiet {
        println!(
            "规则链：{}（{} 条规则）",
            chain.name,
            chain.config.rules.len()
        );
        println!("共 {} 项，其中可执行 {} 项\n", plan.total, plan.executable);
        for op in &plan.ops {
            if op.status == OpStatus::Unchanged && flags.quiet {
                continue;
            }
            let note = op
                .reason
                .as_deref()
                .map(|r| format!("  （{r}）"))
                .unwrap_or_default();
            println!(
                "{:<4} {}  →  {}{}",
                status_label(op.status),
                op.old_name,
                op.new_name,
                note
            );
        }
        println!();
    }

    if plan.executable == 0 {
        println!("没有需要改名的项。");
        return Ok(0);
    }
    if flags.dry_run {
        println!(
            "预演模式：以上 {} 项会被改名，文件没有动。",
            plan.executable
        );
        return Ok(0);
    }
    if !flags.yes && !confirm(&format!("确认改名 {} 项？", plan.executable)) {
        println!("已取消。");
        return Ok(0);
    }

    let journal = Journal::open(journal_path()).map_err(|e| format!("打不开日志：{e}"))?;
    let mut last = 0usize;
    let mut on_progress = |done: usize, total: usize, phase: &str| {
        // 只在阶段切换和每 10% 打一次，避免几千行刷屏
        let pct = if total == 0 { 100 } else { done * 100 / total };
        if pct / 10 != last / 10 || done == total {
            last = done;
            eprint!("\r{phase} {done}/{total}");
            let _ = io::stderr().flush();
        }
    };
    let r = executor::execute(
        &plan,
        &journal,
        &ExecOptions { dry_run: false },
        &mut on_progress,
    );
    eprintln!();

    report(&r);
    Ok(if r.failed > 0 { 1 } else { 0 })
}

fn report(r: &BatchResult) {
    println!(
        "完成：成功 {} 个{}",
        r.succeeded,
        if r.failed > 0 {
            format!("，失败 {} 个", r.failed)
        } else {
            String::new()
        }
    );
    println!(
        "批次号 {}（用 `nsq undo {}` 可以还原）",
        r.batch_id, r.batch_id
    );
    for bad in r.results.iter().filter(|x| !x.ok) {
        if let Some(e) = &bad.error {
            println!("  ✗ {}：{e}", bad.from);
        }
        // 分类建议单独一行，脚本里看日志时最容易忽略的就是「该关掉哪个程序」
        if let Some(h) = &bad.hint {
            println!("      {h}");
        }
    }
    if r.results.iter().any(|x| !x.ok && x.retryable) {
        println!(
            "提示：被占用 / 被改过的条目，处理好之后重跑同一条命令即可（会按当前状态重新校验）"
        );
    }
}

fn do_undo(batch: Option<&str>) -> Result<u8, String> {
    let journal = Journal::open(journal_path()).map_err(|e| format!("打不开日志：{e}"))?;
    let id = match batch {
        Some(b) => b.to_string(),
        None => journal
            .batches()
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .map(|b| b.batch)
            .ok_or("日志里还没有任何批次")?,
    };
    let mut nop = |_: usize, _: usize, _: &str| {};
    let r = executor::undo(&id, &journal, &mut nop).map_err(|e| e.to_string())?;
    println!("撤销 {id}");
    report(&r);
    Ok(if r.failed > 0 { 1 } else { 0 })
}

fn do_batches() -> Result<u8, String> {
    let journal = Journal::open(journal_path()).map_err(|e| format!("打不开日志：{e}"))?;
    let list = journal.batches().map_err(|e| e.to_string())?;
    if list.is_empty() {
        println!("（还没有批次）");
        return Ok(0);
    }
    for b in list.iter().take(20) {
        println!(
            "{}  {:>4} 步  {}",
            b.batch,
            b.steps,
            if b.completed {
                "完成"
            } else {
                "未完成（可 nsq undo 恢复）"
            }
        );
    }
    Ok(0)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match parse_args(&argv) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}\n");
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    let result = match &cmd {
        Cmd::Help => {
            print!("{USAGE}");
            Ok(0)
        }
        Cmd::Version => {
            println!("nsq {}（名序 NameSeq）", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
        Cmd::Batches => do_batches(),
        Cmd::Undo { batch } => do_undo(batch.as_deref()),
        Cmd::Run {
            chain,
            paths,
            flags,
        } => run(chain, paths, flags),
    };

    match result {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("错误：{e}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_run_with_flags() {
        let cmd = parse_args(&args(&["run", "a.nsq", "./p", "-r", "-y", "--dirs"])).unwrap();
        match cmd {
            Cmd::Run {
                chain,
                paths,
                flags,
            } => {
                assert_eq!(chain, PathBuf::from("a.nsq"));
                assert_eq!(paths, vec![PathBuf::from("./p")]);
                assert!(flags.recursive && flags.yes && flags.dirs);
                assert!(!flags.dry_run);
            }
            other => panic!("解析错了：{other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_flag_and_missing_paths() {
        assert!(parse_args(&args(&["run", "a.nsq", "./p", "--wat"])).is_err());
        assert!(parse_args(&args(&["run", "a.nsq"])).is_err());
        assert!(parse_args(&args(&["run"])).is_err());
        assert!(parse_args(&args(&["nope"])).is_err());
    }

    #[test]
    fn undo_takes_optional_batch() {
        assert!(matches!(
            parse_args(&args(&["undo"])).unwrap(),
            Cmd::Undo { batch: None }
        ));
        assert!(matches!(
            parse_args(&args(&["undo", "20261030-1"])).unwrap(),
            Cmd::Undo { batch: Some(_) }
        ));
    }

    #[test]
    fn journal_path_ends_with_expected_name() {
        let p = journal_path();
        assert_eq!(
            p.file_name().unwrap().to_string_lossy(),
            "rename-journal.jsonl"
        );
    }
}
