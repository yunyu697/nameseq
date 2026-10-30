//! 改名规划：把「文件列表 + 规则链 + 选项」算成一份完整的改名方案。
//!
//! 规划阶段**不写任何文件**（只有只读的 exists 探测），因此可以随用户输入实时重算。
//!
//! 求值顺序：
//! ```text
//! 排序 -> 逐文件: [规则1 -> 规则2 -> ...] -> 组装最终名 -> 校验 -> 冲突消解
//! ```
//! 每条 Counter 规则有自己独立的计数器，互不干扰。

use crate::model::{FileEntry, OpStatus, RenameOp};
use crate::rule::{Action, ConflictPolicy, EvalCtx, Filter, NameState, Rule};
use crate::template::TemplateError;
use crate::validate;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 组条件里的「文件名正则」。和规则条件的处理方式一致：编译一次，逐文件复用。
pub(crate) fn compile_filter_re(f: &Filter) -> Result<Option<Regex>, String> {
    if f.name_matches.trim().is_empty() {
        return Ok(None);
    }
    regex::RegexBuilder::new(&f.name_matches)
        .case_insensitive(true)
        .build()
        .map(Some)
        .map_err(|e| format!("分组条件里的正则写错了: {e}"))
}

fn d_true() -> bool {
    true
}
fn d_one() -> usize {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SortBy {
    /// 保持扫描顺序
    #[default]
    Original,
    Name,
    /// 按汉字读音（拼音）排序，中文名的「按读音」才符合直觉
    Pinyin,
    Modified,
    Size,
    Ext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameConfig {
    pub rules: Vec<Rule>,
    /// 最终是否自动拼接扩展名
    #[serde(default = "d_true")]
    pub keep_ext: bool,
    #[serde(default)]
    pub sort_by: SortBy,
    #[serde(default)]
    pub descending: bool,
    /// IMG_2 排在 IMG_10 前面
    #[serde(default)]
    pub natural_sort: bool,
    /// 模板里 {index} 的起始值与步长
    #[serde(default = "d_one")]
    pub start_index: usize,
    #[serde(default = "d_one")]
    pub index_step: usize,
    #[serde(default)]
    pub conflict: ConflictPolicy,
    /// 规则分组（整组停用 / 整组条件）
    #[serde(default)]
    pub groups: Vec<crate::rule::RuleGroup>,
    /// 被用户手动取消勾选的文件 id
    #[serde(default)]
    pub excluded: Vec<u64>,
}

impl Default for RenameConfig {
    fn default() -> Self {
        Self {
            rules: vec![Rule {
                id: "rule-1".into(),
                enabled: true,
                target: crate::rule::Target::Stem,
                filter: Default::default(),
                group: None,
                action: Action::Template {
                    template: "{name}".into(),
                },
            }],
            keep_ext: true,
            sort_by: SortBy::Original,
            descending: false,
            natural_sort: true,
            start_index: 1,
            index_step: 1,
            conflict: ConflictPolicy::Skip,
            groups: Vec::new(),
            excluded: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("规则配置有误: {0}")]
    Rule(String),
    #[error("模板解析失败: {0}")]
    Template(#[from] TemplateError),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub ops: Vec<RenameOp>,
    pub total: usize,
    pub executable: usize,
    pub conflicts: usize,
    pub invalid: usize,
    pub unchanged: usize,
    pub excluded: usize,
}

pub fn build_plan(entries: &[FileEntry], cfg: &RenameConfig) -> Result<Plan, PlanError> {
    // 分组先编译：整组停用的规则直接不进列表，组条件留到逐个文件时再判
    let mut group_filters: HashMap<String, (Filter, Option<Regex>)> = HashMap::new();
    for g in cfg.groups.iter().filter(|g| g.enabled) {
        let re = compile_filter_re(&g.filter).map_err(PlanError::Rule)?;
        group_filters.insert(g.id.clone(), (g.filter.clone(), re));
    }
    let group_enabled: HashSet<&str> = cfg
        .groups
        .iter()
        .filter(|g| g.enabled)
        .map(|g| g.id.as_str())
        .collect();

    let mut compiled = Vec::new();
    for r in cfg.rules.iter().filter(|r| r.enabled) {
        // 规则挂在一个停用的组上，等于整组停用。
        // 挂在「不存在的组」上按不分组处理——手写的 .nsq 里 group 写错了不该让整批算不出来
        if let Some(gid) = &r.group {
            if cfg.groups.iter().any(|g| &g.id == gid) && !group_enabled.contains(gid.as_str()) {
                continue;
            }
        }
        compiled.push(r.compile().map_err(PlanError::Rule)?);
    }

    let total = entries.len();
    let mut order: Vec<usize> = (0..total).collect();
    sort_entries(&mut order, entries, cfg);

    let excluded: HashSet<u64> = cfg.excluded.iter().copied().collect();
    let step = cfg.index_step.max(1);

    // 每条规则一个独立计数器：key 是分组键（按目录重置时用目录，否则用空串）
    let mut counters: Vec<HashMap<String, usize>> = vec![HashMap::new(); compiled.len()];

    let mut ops: Vec<RenameOp> = Vec::with_capacity(total);

    for (k, &ei) in order.iter().enumerate() {
        let e = &entries[ei];
        let index = cfg.start_index + k * step;

        if excluded.contains(&e.id) {
            ops.push(make_op(
                e,
                e.name.clone(),
                OpStatus::Excluded,
                Some("已手动排除".into()),
            ));
            continue;
        }

        let mut state = NameState {
            stem: e.stem.clone(),
            ext: e.ext.clone(),
            ext_emitted: None,
        };
        let mut failure: Option<String> = None;

        for (ri, cr) in compiled.iter().enumerate() {
            // 组条件不满足 → 组内这条规则对这个文件不生效
            if let Some(gid) = &cr.rule.group {
                if let Some((gf, gre)) = group_filters.get(gid.as_str()) {
                    if gf.is_active() && !gf.matches(e, gre.as_ref()) {
                        continue;
                    }
                }
            }
            if !cr.accepts(e) {
                continue;
            }
            let counter_val = match &cr.rule.action {
                Action::Counter {
                    start,
                    step: cstep,
                    per_folder,
                    ..
                } => {
                    let key = if *per_folder {
                        e.dir.clone()
                    } else {
                        String::new()
                    };
                    next_counter(&mut counters[ri], &key, *start, *cstep)
                }
                _ => 0,
            };
            let ctx = EvalCtx {
                entry: e,
                index,
                total,
                counter: counter_val,
            };
            if let Err(msg) = cr.apply(&mut state, &ctx) {
                failure = Some(msg);
                break;
            }
        }

        if let Some(msg) = failure {
            ops.push(make_op(e, e.name.clone(), OpStatus::Invalid, Some(msg)));
            continue;
        }

        // 模板里已经写了 {ext} 就别再补一次，否则 a.jpg.jpg
        let ext_in_stem = state.ext_emitted.is_some();
        let assembled = if cfg.keep_ext && !state.ext.is_empty() && !ext_in_stem {
            format!("{}.{}", state.stem, state.ext)
        } else {
            state.stem.clone()
        };
        let new_name = validate::nfc(&assembled);

        let from = PathBuf::from(&e.path);
        let to = from
            .parent()
            .map(|p| p.join(&new_name))
            .unwrap_or_else(|| PathBuf::from(&new_name));

        let (status, reason) = if let Some(why) = validate::check_stem(&new_name) {
            (OpStatus::Invalid, Some(why))
        } else if let Some(why) = validate::check_path(&to) {
            (OpStatus::Invalid, Some(why))
        } else if new_name == e.name {
            (OpStatus::Unchanged, None)
        } else {
            (OpStatus::Ok, None)
        };

        let mut op = make_op(e, new_name, status, reason);
        op.to = validate::nfc(&to.to_string_lossy());
        ops.push(op);
    }

    resolve_conflicts(&mut ops, entries, cfg.conflict);
    // 目录改名会让目录里所有东西的路径一起变。本批里只要有「也会改名」的子项，
    // 目录就必须让位——否则阶段二用到的是改名前的旧路径，文件会找不到自己。
    skip_dirs_with_renamed_children(&mut ops);

    let executable = ops.iter().filter(|o| o.status == OpStatus::Ok).count();
    let conflicts = ops
        .iter()
        .filter(|o| o.status == OpStatus::Conflict)
        .count();
    let invalid = ops.iter().filter(|o| o.status == OpStatus::Invalid).count();
    let unchanged = ops
        .iter()
        .filter(|o| o.status == OpStatus::Unchanged)
        .count();
    let excluded_n = ops
        .iter()
        .filter(|o| o.status == OpStatus::Excluded)
        .count();

    Ok(Plan {
        ops,
        total,
        executable,
        conflicts,
        invalid,
        unchanged,
        excluded: excluded_n,
    })
}

fn make_op(e: &FileEntry, new_name: String, status: OpStatus, reason: Option<String>) -> RenameOp {
    let from = PathBuf::from(&e.path);
    let to = from
        .parent()
        .map(|p| p.join(&new_name))
        .unwrap_or_else(|| PathBuf::from(&new_name));
    RenameOp {
        id: e.id,
        from: e.path.clone(),
        to: to.to_string_lossy().to_string(),
        old_name: e.name.clone(),
        new_name,
        status,
        reason,
        is_dir: e.is_dir,
        // 目录的大小和时间会随里面的内容变化，拿它做「预览期间被改动」的比对
        // 会十有八九误报，所以目录不参与这项校验
        size: if e.is_dir { 0 } else { e.size },
        modified_ms: if e.is_dir { 0 } else { e.modified_ms },
    }
}

/// 目录不能和「它自己里面要改名的东西」同时改名。
///
/// 判定必须**从深到浅**做：深层的目录先定下「改还是不改」，浅层再根据深层的结果判断。
/// 反过来做会得出错误结论——A 含 B、B 含 C，C 要改名：先看 A 会看到 B 还在改，
/// 于是把 A 判成冲突，但 B 其实会因为 C 而让位，A 就白白被跳过了。
fn skip_dirs_with_renamed_children(ops: &mut [RenameOp]) {
    let mut dirs: Vec<(usize, usize)> = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| o.is_dir && o.status == OpStatus::Ok)
        .map(|(i, o)| (i, depth_of(&o.from)))
        .collect();
    dirs.sort_by(|a, b| b.1.cmp(&a.1));

    for (i, _) in dirs {
        let dir = validate::fold(&ops[i].from);
        let prefixes = [format!("{dir}\\"), format!("{dir}/")];
        let has_child = ops.iter().enumerate().any(|(j, o)| {
            if j == i || o.status != OpStatus::Ok {
                return false;
            }
            let p = validate::fold(&o.from);
            p != dir && prefixes.iter().any(|pre| p.starts_with(pre))
        });
        if has_child {
            ops[i].status = OpStatus::Conflict;
            ops[i].reason = Some("目录里有本批要改名的项，先改里面的内容".into());
        }
    }
}

fn depth_of(path: &str) -> usize {
    path.matches(['/', '\\']).count()
}

fn next_counter(map: &mut HashMap<String, usize>, key: &str, start: usize, step: usize) -> usize {
    let n = map.entry(key.to_string()).or_insert(0);
    let v = start + *n * step.max(1);
    *n += 1;
    v
}

/// 冲突消解。按计划顺序处理，先到先得。
fn resolve_conflicts(ops: &mut [RenameOp], entries: &[FileEntry], policy: ConflictPolicy) {
    // 本批次会被腾出来的路径
    let vacated: HashSet<String> = entries.iter().map(|e| validate::fold(&e.path)).collect();
    let mut taken: HashSet<String> = HashSet::new();

    for op in ops.iter_mut() {
        if op.status != OpStatus::Ok {
            continue;
        }
        let key = validate::fold(&op.to);
        let occupied =
            taken.contains(&key) || (Path::new(&op.to).exists() && !vacated.contains(&key));

        if !occupied {
            taken.insert(key);
            continue;
        }

        match policy {
            ConflictPolicy::Skip => {
                op.status = OpStatus::Conflict;
                op.reason = Some("目标名已被占用".into());
            }
            ConflictPolicy::Suffix => {
                let dir = Path::new(&op.to)
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_default();
                let (base, ext) = split_name(&op.new_name);
                let mut resolved = false;
                for n in 1..=9999usize {
                    let cand = if ext.is_empty() {
                        format!("{base} ({n})")
                    } else {
                        format!("{base} ({n}).{ext}")
                    };
                    let cand_path = dir.join(&cand);
                    let ck = validate::fold(&cand_path.to_string_lossy());
                    if taken.contains(&ck) {
                        continue;
                    }
                    if cand_path.exists() && !vacated.contains(&ck) {
                        continue;
                    }
                    taken.insert(ck);
                    op.new_name = cand;
                    op.to = validate::nfc(&cand_path.to_string_lossy());
                    op.reason = Some(format!("重名，自动改为 {n} 号"));
                    resolved = true;
                    break;
                }
                if !resolved {
                    op.status = OpStatus::Conflict;
                    op.reason = Some("无法自动消解重名".into());
                }
            }
        }
    }
}

fn split_name(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((b, e)) if !b.is_empty() => (b.to_string(), e.to_string()),
        _ => (name.to_string(), String::new()),
    }
}

fn sort_entries(order: &mut [usize], entries: &[FileEntry], cfg: &RenameConfig) {
    let cmp_name = |a: usize, b: usize| -> Ordering {
        let (x, y) = (
            validate::fold(&entries[a].name),
            validate::fold(&entries[b].name),
        );
        if cfg.natural_sort {
            natural_cmp(&x, &y)
        } else {
            x.cmp(&y)
        }
    };

    match cfg.sort_by {
        SortBy::Original => {}
        SortBy::Name => order.sort_by(|&a, &b| cmp_name(a, b)),
        SortBy::Pinyin => order.sort_by(|&a, &b| {
            let (x, y) = (
                crate::cn::pinyin_key(&entries[a].stem),
                crate::cn::pinyin_key(&entries[b].stem),
            );
            if cfg.natural_sort {
                natural_cmp(&x, &y)
            } else {
                x.cmp(&y)
            }
            .then_with(|| cmp_name(a, b))
        }),
        SortBy::Ext => order.sort_by(|&a, &b| {
            let (x, y) = (
                validate::fold(&entries[a].ext),
                validate::fold(&entries[b].ext),
            );
            x.cmp(&y).then_with(|| cmp_name(a, b))
        }),
        SortBy::Modified => order.sort_by_key(|&i| entries[i].modified_ms),
        SortBy::Size => order.sort_by_key(|&i| entries[i].size),
    }
    if cfg.descending {
        order.reverse();
    }
}

/// 自然排序：数字段按数值比较，所以 IMG_2 排在 IMG_10 前面。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let na = take_digits(&mut ai);
                    let nb = take_digits(&mut bi);
                    let ta = na.trim_start_matches('0');
                    let tb = nb.trim_start_matches('0');
                    let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                } else {
                    ai.next();
                    bi.next();
                    let la = ca.to_lowercase().next().unwrap_or(ca);
                    let lb = cb.to_lowercase().next().unwrap_or(cb);
                    if la != lb {
                        return la.cmp(&lb);
                    }
                }
            }
        }
    }
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek() {
        if c.is_ascii_digit() {
            s.push(*c);
            it.next();
        } else {
            break;
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule::{CounterBase, Filter, Target};

    fn entry(id: u64, dir: &str, name: &str) -> FileEntry {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), e.to_string()),
            None => (name.to_string(), String::new()),
        };
        FileEntry {
            id,
            path: format!("{dir}/{name}"),
            dir: dir.to_string(),
            stem,
            ext,
            name: name.to_string(),
            size: 100,
            modified_ms: 1_700_000_000_000,
            is_dir: false,
            error: None,
            media: None,
        }
    }

    /// 目录条目：没有扩展名，路径就是它自己
    fn dir_entry(id: u64, dir: &str, name: &str) -> FileEntry {
        FileEntry {
            id,
            path: format!("{dir}/{name}"),
            dir: dir.to_string(),
            stem: name.to_string(),
            ext: String::new(),
            name: name.to_string(),
            size: 4096,
            modified_ms: 1_700_000_000_000,
            is_dir: true,
            error: None,
            media: None,
        }
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

    fn cfg(rules: Vec<Rule>) -> RenameConfig {
        RenameConfig {
            rules,
            natural_sort: false,
            ..Default::default()
        }
    }

    #[test]
    fn chain_of_rules_applies_in_order() {
        // 先替换，再统一小写，再加前缀
        let c = cfg(vec![
            rule(Action::Replace {
                find: "IMG".into(),
                with: "photo".into(),
                regex: false,
                case_sensitive: true,
            }),
            rule(Action::Case {
                mode: crate::rule::CaseMode::Upper,
            }),
            rule(Action::Prefix { text: "P_".into() }),
        ]);
        let es = vec![entry(1, "/t", "IMG_001.jpg")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "P_PHOTO_001.jpg");
    }

    #[test]
    fn counter_per_folder_resets() {
        let c = cfg(vec![rule(Action::Counter {
            start: 1,
            step: 1,
            width: 2,
            at: Some(0),
            per_folder: true,
            base: CounterBase::Decimal,
        })]);
        let es = vec![
            entry(1, "/a", "x.txt"),
            entry(2, "/a", "y.txt"),
            entry(3, "/b", "z.txt"),
        ];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "01x.txt");
        assert_eq!(p.ops[1].new_name, "02y.txt");
        assert_eq!(p.ops[2].new_name, "01z.txt", "换了目录应重新从 1 开始");
    }

    #[test]
    fn counter_without_per_folder_keeps_counting() {
        let c = cfg(vec![rule(Action::Counter {
            start: 1,
            step: 1,
            width: 2,
            at: Some(0),
            per_folder: false,
            base: CounterBase::Decimal,
        })]);
        let es = vec![entry(1, "/a", "x.txt"), entry(2, "/b", "y.txt")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "01x.txt");
        assert_eq!(p.ops[1].new_name, "02y.txt");
    }

    #[test]
    fn two_counters_are_independent() {
        let c = cfg(vec![
            rule(Action::Counter {
                start: 1,
                step: 1,
                width: 1,
                at: Some(0),
                per_folder: false,
                base: CounterBase::Decimal,
            }),
            rule(Action::Suffix { text: "_".into() }),
            rule(Action::Counter {
                start: 100,
                step: 10,
                width: 3,
                at: None,
                per_folder: false,
                base: CounterBase::Decimal,
            }),
        ]);
        let es = vec![entry(1, "/t", "a.txt"), entry(2, "/t", "b.txt")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "1a_100.txt");
        assert_eq!(p.ops[1].new_name, "2b_110.txt");
    }

    #[test]
    fn conflict_skip_policy() {
        let c = cfg(vec![rule(Action::Template {
            template: "same".into(),
        })]);
        let es = vec![entry(1, "/t", "a.txt"), entry(2, "/t", "b.txt")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.executable, 1);
        assert_eq!(p.conflicts, 1);
        assert_eq!(p.ops[0].new_name, "same.txt");
    }

    #[test]
    fn conflict_suffix_policy() {
        let mut c = cfg(vec![rule(Action::Template {
            template: "same".into(),
        })]);
        c.conflict = ConflictPolicy::Suffix;
        let es = vec![
            entry(1, "/t", "a.txt"),
            entry(2, "/t", "b.txt"),
            entry(3, "/t", "c.txt"),
        ];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.executable, 3, "{:?}", p);
        assert_eq!(p.ops[0].new_name, "same.txt");
        assert_eq!(p.ops[1].new_name, "same (1).txt");
        assert_eq!(p.ops[2].new_name, "same (2).txt");
    }

    #[test]
    fn filter_limits_which_files_get_rule() {
        let mut r = rule(Action::Prefix { text: "X_".into() });
        r.filter = Filter {
            exts: vec!["jpg".into()],
            ..Default::default()
        };
        let c = cfg(vec![r]);
        let es = vec![entry(1, "/t", "a.jpg"), entry(2, "/t", "b.png")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "X_a.jpg");
        assert_eq!(p.ops[1].status, OpStatus::Unchanged);
    }

    #[test]
    fn excluded_files_are_skipped() {
        let mut c = cfg(vec![rule(Action::Prefix { text: "X_".into() })]);
        c.excluded = vec![2];
        let es = vec![entry(1, "/t", "a.txt"), entry(2, "/t", "b.txt")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.executable, 1);
        assert_eq!(p.excluded, 1);
        assert_eq!(p.ops[1].status, OpStatus::Excluded);
    }

    #[test]
    fn disabled_rules_are_ignored() {
        let mut r = rule(Action::Prefix { text: "X_".into() });
        r.enabled = false;
        let c = cfg(vec![r]);
        let es = vec![entry(1, "/t", "a.txt")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].status, OpStatus::Unchanged);
    }

    #[test]
    fn natural_sort_orders_numbers() {
        assert_eq!(natural_cmp("img2", "img10"), Ordering::Less);
        assert_eq!(natural_cmp("img10", "img2"), Ordering::Greater);
        assert_eq!(natural_cmp("img2", "img2"), Ordering::Equal);
        assert_eq!(natural_cmp("a1b2", "a1b10"), Ordering::Less);
    }

    #[test]
    fn natural_sort_applied_to_plan() {
        let mut c = cfg(vec![rule(Action::Counter {
            start: 1,
            step: 1,
            width: 1,
            at: Some(0),
            per_folder: false,
            base: CounterBase::Decimal,
        })]);
        c.sort_by = SortBy::Name;
        c.natural_sort = true;
        let es = vec![
            entry(1, "/t", "img10.jpg"),
            entry(2, "/t", "img2.jpg"),
            entry(3, "/t", "img1.jpg"),
        ];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].old_name, "img1.jpg");
        assert_eq!(p.ops[1].old_name, "img2.jpg");
        assert_eq!(p.ops[2].old_name, "img10.jpg");
    }

    #[test]
    fn ext_target_and_set_ext() {
        let c = cfg(vec![Rule {
            id: "r".into(),
            enabled: true,
            target: Target::Ext,
            filter: Filter::default(),
            group: None,
            action: Action::SetExt { ext: "jpg".into() },
        }]);
        let es = vec![entry(1, "/t", "photo.jpeg")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "photo.jpg");
    }

    #[test]
    fn invalid_name_is_reported() {
        let c = cfg(vec![rule(Action::Template {
            template: "CON".into(),
        })]);
        let es = vec![entry(1, "/t", "a.txt")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.invalid, 1);
    }

    #[test]
    fn bad_regex_returns_error() {
        let c = cfg(vec![rule(Action::Replace {
            find: "([".into(),
            with: "".into(),
            regex: true,
            case_sensitive: true,
        })]);
        let es = vec![entry(1, "/t", "a.txt")];
        assert!(build_plan(&es, &c).is_err());
    }

    #[test]
    fn dir_is_renamed_without_ext_suffix() {
        // 目录 "v1.2" 不能被当成 name=v1 + ext=2，改完变成 "项目.v1.2.2"
        let c = cfg(vec![rule(Action::Prefix {
            text: "项目-".into(),
        })]);
        let es = vec![dir_entry(1, "/t", "v1.2")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].new_name, "项目-v1.2");
        assert!(p.ops[0].is_dir);
        assert_eq!(p.ops[0].size, 0, "目录不该带 size 做漂移校验");
        assert_eq!(p.ops[0].modified_ms, 0);
    }

    #[test]
    fn dir_with_renamed_child_yields() {
        let c = cfg(vec![rule(Action::Prefix { text: "x_".into() })]);
        let es = vec![dir_entry(1, "/t", "album"), entry(2, "/t/album", "a.jpg")];
        let p = build_plan(&es, &c).unwrap();
        let dir_op = p.ops.iter().find(|o| o.is_dir).unwrap();
        assert_eq!(dir_op.status, OpStatus::Conflict);
        assert!(dir_op.reason.as_deref().unwrap().contains("先改里面"));
        let file_op = p.ops.iter().find(|o| !o.is_dir).unwrap();
        assert_eq!(file_op.status, OpStatus::Ok);
    }

    #[test]
    fn dir_with_unchanged_child_can_rename() {
        // 子项虽然在本批里，但它「无需改名」，所以目录改名是安全的
        let c = cfg(vec![rule(Action::Replace {
            find: "album".into(),
            with: "album-2021".into(),
            regex: false,
            case_sensitive: true,
        })]);
        let es = vec![dir_entry(1, "/t", "album"), entry(2, "/t/album", "x_a.jpg")];
        let p = build_plan(&es, &c).unwrap();
        let dir_op = p.ops.iter().find(|o| o.is_dir).unwrap();
        assert_eq!(dir_op.status, OpStatus::Ok, "{dir_op:?}");
        assert_eq!(
            p.ops.iter().find(|o| !o.is_dir).unwrap().status,
            OpStatus::Unchanged
        );
    }

    #[test]
    fn ancestor_of_renamed_file_must_yield() {
        // A 含 B，B 含 c.txt：c 要改名，则 B 和 A 都不能同时改——
        // 改了祖先目录，c 的源路径就失效了。这是「安全的跳过」，不是漏判
        let c = cfg(vec![rule(Action::Prefix { text: "x_".into() })]);
        let es = vec![
            dir_entry(1, "/t", "A"),
            dir_entry(2, "/t/A", "B"),
            entry(3, "/t/A/B", "c.txt"),
        ];
        let p = build_plan(&es, &c).unwrap();
        let a = p.ops.iter().find(|o| o.old_name == "A").unwrap();
        let b = p.ops.iter().find(|o| o.old_name == "B").unwrap();
        assert_eq!(a.status, OpStatus::Conflict, "{a:?}");
        assert_eq!(b.status, OpStatus::Conflict, "{b:?}");
        assert_eq!(p.executable, 1, "只有最里层的文件该被执行");
    }

    #[test]
    fn sibling_dirs_rename_together() {
        // 同级的两个目录互不包含，可以一起改
        let c = cfg(vec![rule(Action::Prefix {
            text: "2023-".into(),
        })]);
        let es = vec![dir_entry(1, "/t", "a"), dir_entry(2, "/t", "b")];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.executable, 2, "{:?}", p.ops);
    }

    #[test]
    fn pinyin_sort_orders_chinese_by_reading() {
        let mut c = cfg(vec![rule(Action::Counter {
            start: 1,
            step: 1,
            width: 1,
            at: Some(0),
            per_folder: false,
            base: CounterBase::Decimal,
        })]);
        c.sort_by = SortBy::Pinyin;
        c.natural_sort = false;
        let es = vec![
            entry(1, "/t", "张三.jpg"),
            entry(2, "/t", "李四.jpg"),
            entry(3, "/t", "阿七.jpg"),
        ];
        let p = build_plan(&es, &c).unwrap();
        assert_eq!(p.ops[0].old_name, "阿七.jpg");
        assert_eq!(p.ops[1].old_name, "李四.jpg");
        assert_eq!(p.ops[2].old_name, "张三.jpg");
    }

    #[test]
    fn disabled_group_skips_its_rules() {
        use crate::rule::RuleGroup;
        let mut c = cfg(vec![rule(Action::Prefix { text: "a-".into() })]);
        c.rules.push(Rule {
            id: "r2".into(),
            enabled: true,
            target: Target::Stem,
            filter: Filter::default(),
            group: Some("g1".into()),
            action: Action::Suffix { text: "-b".into() },
        });
        c.groups = vec![RuleGroup {
            id: "g1".into(),
            name: "停用的组".into(),
            enabled: false,
            filter: Filter::default(),
        }];
        let p = build_plan(&[entry(1, "/t", "x.jpg")], &c).unwrap();
        assert_eq!(p.ops[0].new_name, "a-x.jpg", "组停了，组内的后缀不该生效");
    }

    #[test]
    fn group_filter_gates_all_rules_inside() {
        use crate::rule::RuleGroup;
        let mut c = cfg(vec![rule(Action::Prefix { text: "p-".into() })]);
        c.rules[0].group = Some("jpg".into());
        c.groups = vec![RuleGroup {
            id: "jpg".into(),
            name: "只对 jpg".into(),
            enabled: true,
            filter: Filter {
                exts: vec!["jpg".into()],
                ..Default::default()
            },
        }];
        let es = vec![entry(1, "/t", "a.jpg"), entry(2, "/t", "b.png")];
        let p = build_plan(&es, &c).unwrap();
        let jpg = p.ops.iter().find(|o| o.old_name == "a.jpg").unwrap();
        let png = p.ops.iter().find(|o| o.old_name == "b.png").unwrap();
        assert_eq!(jpg.status, OpStatus::Ok);
        assert_eq!(
            png.status,
            OpStatus::Unchanged,
            "png 不满足组条件，规则整组跳过"
        );
    }

    #[test]
    fn unknown_group_id_is_treated_as_ungrouped() {
        // 手写的 .nsq 里 group 指向一个不存在的分组：不该让整批算不出来
        let mut c = cfg(vec![rule(Action::Prefix { text: "x-".into() })]);
        c.rules[0].group = Some("ghost".into());
        let p = build_plan(&[entry(1, "/t", "a.jpg")], &c).unwrap();
        assert_eq!(p.ops[0].new_name, "x-a.jpg");
    }

    #[test]
    fn broken_group_filter_reports_error() {
        use crate::rule::RuleGroup;
        let mut c = cfg(vec![rule(Action::Prefix { text: "x-".into() })]);
        c.rules[0].group = Some("g".into());
        c.groups = vec![RuleGroup {
            id: "g".into(),
            name: "坏正则".into(),
            enabled: true,
            filter: Filter {
                name_matches: "([".into(),
                ..Default::default()
            },
        }];
        let err = build_plan(&[entry(1, "/t", "a.jpg")], &c).unwrap_err();
        assert!(err.to_string().contains("分组条件"), "{err}");
    }

    #[test]
    fn media_placeholder_reaches_plan() {
        let c = cfg(vec![rule(Action::Template {
            template: "{artist} - {title}".into(),
        })]);
        let mut e = entry(1, "/t", "track01.mp3");
        e.media = Some(crate::model::MediaMeta {
            title: "夜曲".into(),
            artist: "周杰伦".into(),
            ..Default::default()
        });
        let p = build_plan(&[e], &c).unwrap();
        assert_eq!(p.ops[0].new_name, "周杰伦 - 夜曲.mp3");
    }
}
