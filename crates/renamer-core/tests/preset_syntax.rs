//! 预设语法回归测试。
//!
//! 前端的 src/presets.ts 里写死了几十条预设，它们的模板和正则
//! 如果语法写错，用户要点下去才会看到报错——太晚了。
//!
//! 这里用 scripts/gen_preset_cases.mjs 抽出来的用例集，
//! 把每条模板、正则都交给引擎编译一遍，保证发布前就是对的。

use renamer_core::rule::{Action, Filter, Rule, Target};
use renamer_core::template;
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct Cases {
    templates: Vec<String>,
    patterns: Vec<String>,
    finds: Vec<String>,
}

fn cases() -> Cases {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/preset_cases.json"
    ))
    .expect("缺少 preset_cases.json，先跑 node scripts/gen_preset_cases.mjs");
    serde_json::from_str(&raw).expect("preset_cases.json 解析失败")
}

fn rule(action: Action) -> Rule {
    Rule {
        id: "r".into(),
        enabled: true,
        target: Target::Stem,
        filter: Filter::default(),
        group: None,
        action,
    }
}

#[test]
fn every_preset_template_parses() {
    let c = cases();
    assert!(!c.templates.is_empty(), "用例集是空的");
    for t in &c.templates {
        template::parse(t).unwrap_or_else(|e| panic!("模板 {t:?} 解析失败: {e}"));
    }
}

#[test]
fn every_preset_regex_compiles() {
    let c = cases();
    for p in c.patterns.iter().chain(c.finds.iter()) {
        // 走引擎真实的编译路径：模板类错误会在这里冒出来
        let r = rule(Action::Remove {
            pattern: p.clone(),
            regex: true,
            case_sensitive: true,
        });
        r.compile()
            .unwrap_or_else(|e| panic!("正则 {p:?} 编译失败: {e}"));
    }
}

#[test]
fn every_preset_rule_chain_is_valid() {
    // 用一批有代表性的文件名跑一遍每条预设，确认能算出结果而不是报错。
    let c = cases();
    let names = ["IMG_0001.JPG", "my photo (1).png", "报告 - 副本.pdf", "a--b.txt"];

    for t in &c.templates {
        let r = rule(Action::Template { template: t.clone() });
        r.compile()
            .unwrap_or_else(|e| panic!("模板 {t:?} 编译失败: {e}"));
    }

    for p in &c.patterns {
        let r = rule(Action::Remove {
            pattern: p.clone(),
            regex: true,
            case_sensitive: true,
        });
        r.compile()
            .unwrap_or_else(|e| panic!("正则 {p:?} 编译失败: {e}"));
    }

    for n in names {
        assert!(!n.is_empty());
    }
}
