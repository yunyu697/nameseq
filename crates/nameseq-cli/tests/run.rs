//! 端到端：真的把 nsq 跑起来，在临时目录里改名 / 撤销。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_nsq");

struct Env {
    root: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "nsq-cli-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("files")).unwrap();
        Env { root }
    }
    fn files(&self) -> PathBuf {
        self.root.join("files")
    }
    fn chain(&self) -> PathBuf {
        let p = self.root.join("chain.nsq");
        fs::write(
            &p,
            r#"{"version":1,"name":"加前缀","config":{"rules":[{"id":"r1","enabled":true,"target":"stem","action":{"kind":"prefix","text":"x-"}}]}}"#,
        )
        .unwrap();
        p
    }
    fn journal(&self) -> PathBuf {
        self.root.join("journal.jsonl")
    }
    fn file(&self, name: &str) -> PathBuf {
        let p = self.files().join(name);
        fs::write(&p, name).unwrap();
        p
    }
    /// 跑子命令，顺带把日志指到临时文件，避免污染真实的应用数据目录
    fn run(&self, args: &[&str]) -> std::process::Output {
        Command::new(BIN)
            .args(args)
            .env("NSQ_JOURNAL", self.journal())
            .output()
            .expect("nsq 起不来")
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn dry_run_apply_undo() {
    let e = Env::new("e2e");
    e.file("a.txt");
    e.file("b.txt");
    let chain = e.chain();

    // 预演：打印计划，但一个文件都不动
    let out = e.run(&["run", s(&chain), s(&e.files()), "-n"]);
    assert!(
        out.status.success(),
        "预演失败：{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("x-a.txt"), "计划里应该出现新名字：{stdout}");
    assert!(e.files().join("a.txt").exists(), "预演不该动文件");

    // 真执行
    let out = e.run(&["run", s(&chain), s(&e.files()), "-y"]);
    assert!(
        out.status.success(),
        "执行失败：{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(e.files().join("x-a.txt").exists());
    assert!(e.files().join("x-b.txt").exists());
    assert!(!e.files().join("a.txt").exists());

    // 撤销：CLI 和 GUI 共用日志，这里走的是同一套逆序还原
    let out = e.run(&["undo"]);
    assert!(
        out.status.success(),
        "撤销失败：{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(e.files().join("a.txt").exists());
    assert!(e.files().join("b.txt").exists());
    assert!(!e.files().join("x-a.txt").exists());
}

#[test]
fn recursive_flag_reaches_into_subdirs() {
    let e = Env::new("rec");
    fs::create_dir_all(e.files().join("sub")).unwrap();
    fs::write(e.files().join("sub").join("c.txt"), "c").unwrap();
    let chain = e.chain();

    // 不加 -r 时看不到子目录里的文件：直接报错并提示加 -r，而不是静默「0 项」
    let out = e.run(&["run", s(&chain), s(&e.files()), "-n"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("加 -r"));

    let out = e.run(&["run", s(&chain), s(&e.files()), "-n", "-r"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("x-c.txt"), "{stdout}");
}

#[test]
fn bad_chain_exits_with_two_and_touches_nothing() {
    let e = Env::new("bad");
    e.file("a.txt");
    let bad = e.root.join("bad.nsq");
    fs::write(
        &bad,
        r#"{"config":{"rules":[{"id":"r","action":{"kind":"replace","find":"([","regex":true}}]}}"#,
    )
    .unwrap();

    let out = e.run(&["run", s(&bad), s(&e.files()), "-y"]);
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("第 1 条规则"), "{err}");
    assert!(e.files().join("a.txt").exists());
}

#[test]
fn batches_lists_executed_batch() {
    let e = Env::new("batches");
    e.file("a.txt");
    let chain = e.chain();
    assert!(e
        .run(&["run", s(&chain), s(&e.files()), "-y"])
        .status
        .success());

    let out = e.run(&["batches"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("完成"), "{stdout}");
}
