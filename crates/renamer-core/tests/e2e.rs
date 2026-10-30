//! 端到端集成测试：扫描 → 规划 → 执行 → 撤销，走的是真实文件系统。

use renamer_core::planner::{build_plan, RenameConfig, SortBy};
use renamer_core::rule::{Action, ConflictPolicy, CounterBase, Filter, Rule, Target};
use renamer_core::scanner::{scan, ScanOptions};
use renamer_core::{executor, ExecOptions, Journal};
use std::fs;
use std::path::{Path, PathBuf};

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let d = std::env::temp_dir().join(format!("renamer-e2e-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }
    fn write(&self, name: &str, body: &str) {
        fs::write(self.0.join(name), body).unwrap();
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
    fn journal(&self) -> Journal {
        Journal::open(std::env::temp_dir().join(format!(
            "e2e-{}-journal.jsonl",
            self.0.file_name().unwrap().to_string_lossy()
        )))
        .unwrap()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn noop(_: usize, _: usize, _: &str) {}

fn scan_dir(dir: &Path) -> Vec<renamer_core::FileEntry> {
    scan(&[dir.to_path_buf()], &ScanOptions::default())
}

fn rule(action: Action) -> Rule {
    Rule {
        id: "r1".into(),
        enabled: true,
        target: Target::Stem,
        filter: Filter::default(),
        group: None,
        action,
    }
}

fn tpl_cfg(template: &str) -> RenameConfig {
    RenameConfig {
        rules: vec![rule(Action::Template {
            template: template.into(),
        })],
        sort_by: SortBy::Name,
        ..Default::default()
    }
}

#[test]
fn full_pipeline_rename_then_undo() {
    let t = Tmp::new("pipeline");
    for (i, n) in ["a.jpg", "b.jpg", "c.jpg"].iter().enumerate() {
        t.write(n, &format!("body{i}"));
    }
    let j = t.journal();

    let entries = scan_dir(&t.0);
    assert_eq!(entries.len(), 3);

    let plan = build_plan(&entries, &tpl_cfg("{name|upper}-{index:2}")).unwrap();
    assert_eq!(plan.executable, 3, "计划: {:?}", plan);

    let r = executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    assert_eq!(r.succeeded, 3, "{:?}", r.results);
    assert_eq!(t.names(), vec!["A-01.jpg", "B-02.jpg", "C-03.jpg"]);

    assert_eq!(fs::read_to_string(t.0.join("A-01.jpg")).unwrap(), "body0");
    assert_eq!(fs::read_to_string(t.0.join("C-03.jpg")).unwrap(), "body2");

    let u = executor::undo(&r.batch_id, &j, &mut noop).unwrap();
    assert_eq!(u.failed, 0, "{:?}", u.results);
    assert_eq!(t.names(), vec!["a.jpg", "b.jpg", "c.jpg"]);
    assert_eq!(fs::read_to_string(t.0.join("a.jpg")).unwrap(), "body0");
}

#[test]
fn index_shift_into_occupied_names_does_not_lose_data() {
    // 1.txt 要改成 2.txt，而 2.txt 恰好也在本批里要被改成 3.txt。
    let t = Tmp::new("shift");
    t.write("1.txt", "one");
    t.write("2.txt", "two");
    t.write("3.txt", "three");
    let j = t.journal();

    let entries = scan_dir(&t.0);
    let cfg = RenameConfig {
        start_index: 2,
        ..tpl_cfg("{index}")
    };
    let plan = build_plan(&entries, &cfg).unwrap();
    assert_eq!(plan.conflicts, 0, "同批内互相占用不应算冲突: {:?}", plan);

    let r = executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    assert_eq!(r.failed, 0, "{:?}", r.results);

    assert_eq!(t.names(), vec!["2.txt", "3.txt", "4.txt"]);
    assert_eq!(fs::read_to_string(t.0.join("2.txt")).unwrap(), "one");
    assert_eq!(fs::read_to_string(t.0.join("4.txt")).unwrap(), "three");
}

#[test]
fn external_file_with_same_name_is_a_conflict() {
    let t = Tmp::new("conflict");
    t.write("a.txt", "A");
    t.write("target.txt", "外部文件");
    let j = t.journal();

    let entries: Vec<_> = scan_dir(&t.0)
        .into_iter()
        .filter(|e| e.name == "a.txt")
        .collect();
    let plan = build_plan(&entries, &tpl_cfg("target")).unwrap();

    assert_eq!(plan.conflicts, 1);
    assert_eq!(plan.executable, 0);

    let r = executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    assert_eq!(r.succeeded, 0);
    assert_eq!(
        fs::read_to_string(t.0.join("target.txt")).unwrap(),
        "外部文件"
    );
}

#[test]
fn suffix_policy_avoids_overwriting_external_file() {
    let t = Tmp::new("suffix");
    t.write("a.txt", "A");
    t.write("target.txt", "外部文件");
    let j = t.journal();

    let entries: Vec<_> = scan_dir(&t.0)
        .into_iter()
        .filter(|e| e.name == "a.txt")
        .collect();
    let mut cfg = tpl_cfg("target");
    cfg.conflict = ConflictPolicy::Suffix;

    let plan = build_plan(&entries, &cfg).unwrap();
    assert_eq!(plan.executable, 1);
    assert_eq!(plan.ops[0].new_name, "target (1).txt");

    let r = executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    assert_eq!(r.succeeded, 1, "{:?}", r.results);
    assert_eq!(
        fs::read_to_string(t.0.join("target.txt")).unwrap(),
        "外部文件"
    );
    assert_eq!(fs::read_to_string(t.0.join("target (1).txt")).unwrap(), "A");
}

#[test]
fn rule_chain_on_real_files() {
    // 真实场景：去掉前缀 IMG_、统一小写、再追加序号
    let t = Tmp::new("chain");
    t.write("IMG_One.jpg", "1");
    t.write("IMG_Two.jpg", "2");
    let j = t.journal();

    let entries = scan_dir(&t.0);
    let cfg = RenameConfig {
        rules: vec![
            rule(Action::Remove {
                pattern: "IMG_".into(),
                regex: false,
                case_sensitive: true,
            }),
            rule(Action::Case {
                mode: renamer_core::CaseMode::Lower,
            }),
            rule(Action::Suffix {
                text: "_final".into(),
            }),
        ],
        sort_by: SortBy::Name,
        ..Default::default()
    };

    let plan = build_plan(&entries, &cfg).unwrap();
    assert_eq!(plan.executable, 2, "{:?}", plan);

    let r = executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    assert_eq!(r.failed, 0, "{:?}", r.results);
    assert_eq!(t.names(), vec!["one_final.jpg", "two_final.jpg"]);
}

#[test]
fn counter_per_folder_on_real_tree() {
    let t = Tmp::new("perfolder");
    fs::create_dir_all(t.0.join("2023")).unwrap();
    fs::create_dir_all(t.0.join("2024")).unwrap();
    t.write("a.txt", "a");
    fs::write(t.0.join("2023").join("b.txt"), "b").unwrap();
    fs::write(t.0.join("2024").join("c.txt"), "c").unwrap();

    let entries = scan(
        &[t.0.clone()],
        &ScanOptions {
            recursive: true,
            ..Default::default()
        },
    );
    assert_eq!(entries.len(), 3);

    let cfg = RenameConfig {
        rules: vec![rule(Action::Counter {
            start: 1,
            step: 1,
            width: 2,
            at: Some(0),
            per_folder: true,
            base: CounterBase::Decimal,
        })],
        sort_by: SortBy::Name,
        ..Default::default()
    };

    let plan = build_plan(&entries, &cfg).unwrap();
    // 每个目录都从 01 开始
    let names: Vec<&str> = plan.ops.iter().map(|o| o.new_name.as_str()).collect();
    assert!(names.contains(&"01a.txt"), "{names:?}");
    assert!(names.contains(&"01b.txt"), "{names:?}");
    assert!(names.contains(&"01c.txt"), "{names:?}");
}

#[test]
fn no_temp_files_left_after_errors() {
    let t = Tmp::new("noerror");
    t.write("x.txt", "X");
    t.write("y.txt", "Y");
    let j = t.journal();

    let entries = scan_dir(&t.0);
    let plan = build_plan(&entries, &tpl_cfg("z{index}")).unwrap();

    executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    let leftovers: Vec<String> = t
        .names()
        .into_iter()
        .filter(|n| n.starts_with(".rnm-"))
        .collect();
    assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
}

#[test]
fn recursive_rename_across_subdirs() {
    let t = Tmp::new("recur");
    fs::create_dir_all(t.0.join("sub")).unwrap();
    t.write("a.txt", "A");
    fs::write(t.0.join("sub").join("b.txt"), "B").unwrap();
    let j = t.journal();

    let entries = scan(
        &[t.0.clone()],
        &ScanOptions {
            recursive: true,
            ..Default::default()
        },
    );
    assert_eq!(entries.len(), 2);

    let plan = build_plan(&entries, &tpl_cfg("f-{index:2}")).unwrap();
    let r = executor::execute(&plan, &j, &ExecOptions::default(), &mut noop);
    assert_eq!(r.failed, 0, "{:?}", r.results);

    assert!(t.0.join("f-01.txt").exists());
    assert!(t.0.join("sub").join("f-02.txt").exists());
}

#[test]
fn template_with_ext_is_not_duplicated_by_keep_ext() {
    // 模板里显式写了 {ext} 时，「保留扩展名」不该再补一次，
    // 否则 a.jpg 会变成 a.jpg.jpg。
    let t = Tmp::new("tmplext");
    t.write("a.jpg", "1");
    let entries = scan_dir(&t.0);

    let plan = build_plan(&entries, &tpl_cfg("{name}.{ext}")).unwrap();
    assert_eq!(plan.ops[0].new_name, "a.jpg");

    let plan2 = build_plan(&entries, &tpl_cfg("{name}_v2.{ext}")).unwrap();
    assert_eq!(plan2.ops[0].new_name, "a_v2.jpg");

    // 不写 {ext} 时，仍然由 keep_ext 补上
    let plan3 = build_plan(&entries, &tpl_cfg("{name}_v3")).unwrap();
    assert_eq!(plan3.ops[0].new_name, "a_v3.jpg");
}

#[test]
fn set_ext_and_keep_ext_compose() {
    // 改扩展名规则 + 保留扩展名：最终应是 stem.new_ext
    let t = Tmp::new("setext");
    t.write("a.jpg", "1");
    let entries = scan_dir(&t.0);

    let mut cfg = tpl_cfg("{name}");
    cfg.rules.push(Rule {
        id: "r2".into(),
        enabled: true,
        target: Target::Ext,
        filter: Filter::default(),
        group: None,
        action: Action::SetExt { ext: "png".into() },
    });
    let plan = build_plan(&entries, &cfg).unwrap();
    assert_eq!(plan.ops[0].new_name, "a.png");
}
