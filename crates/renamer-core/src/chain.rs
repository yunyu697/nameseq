//! 规则链文件（`.nsq`）。
//!
//! 为什么单独做一层：`RenameConfig` 里有 `excluded` 这种「当前这批文件」的临时状态，
//! 不该被存进可复用的规则链；而规则链又需要自己的名字、备注和版本号，
//! 才能在别人机器上打开时给出说得清的提示。
//!
//! 文件就是 UTF-8 的 JSON，用 `.nsq` 后缀是为了双击/拖进窗口时能和普通 json 区分开。

use crate::planner::{compile_filter_re, RenameConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 当前能读写的格式版本。读到更大的版本号直接拒绝——
/// 用新版本存的规则链在旧版本里少读几个字段，改出来的名字可能是错的。
pub const CHAIN_VERSION: u32 = 1;

pub const CHAIN_EXT: &str = "nsq";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub config: RenameConfig,
}

fn default_version() -> u32 {
    CHAIN_VERSION
}

impl ChainFile {
    /// 从当前界面配置导出。`excluded` 属于「这一批文件」，不进文件。
    pub fn from_config(name: &str, cfg: &RenameConfig) -> Self {
        let mut config = cfg.clone();
        config.excluded.clear();
        // 没有规则引用的分组也一并丢掉：留着它，下次打开会看到一个
        // 「谁都不属于它」的开关，改了却不影响任何结果，徒增困惑。
        let used: HashSet<&str> = config
            .rules
            .iter()
            .filter_map(|r| r.group.as_deref())
            .collect();
        config.groups.retain(|g| used.contains(g.id.as_str()));
        Self {
            version: CHAIN_VERSION,
            name: name.trim().to_string(),
            note: String::new(),
            config,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let file: Self =
            serde_json::from_str(text).map_err(|e| format!("不是有效的规则链文件：{e}"))?;
        file.validate()?;
        Ok(file)
    }

    /// 版本、规则条数、每条规则能否编译，都在打开时一次查完。
    /// 等到规划阶段才发现「第 3 条规则的正则写错了」，用户已经不知道该改哪。
    pub fn validate(&self) -> Result<(), String> {
        if self.version > CHAIN_VERSION {
            return Err(format!(
                "这个规则链来自更新的版本（v{}），当前只认到 v{CHAIN_VERSION}，请先升级名序",
                self.version
            ));
        }
        if self.config.rules.is_empty() {
            return Err("规则链里一条规则都没有".into());
        }
        // 组 id 重复时「谁说了算」是不确定的，趁早挡住
        let mut seen: HashSet<&str> = HashSet::new();
        for g in self.config.groups.iter() {
            if g.id.trim().is_empty() {
                return Err(format!("分组「{}」没有 id", g.display_name()));
            }
            if !seen.insert(g.id.as_str()) {
                return Err(format!("分组 id 重复了：{}", g.id));
            }
            // 组条件里的正则同样当场编译一遍：它虽然挂在组上，报错却会一路推迟到改名方案
            compile_filter_re(&g.filter)
                .map_err(|e| format!("分组「{}」：{e}", g.display_name()))?;
        }
        for (i, r) in self.config.rules.iter().enumerate() {
            r.compile()
                .map_err(|e| format!("第 {} 条规则有问题：{e}", i + 1))?;
        }
        Ok(())
    }

    /// 文件名建议值：去掉不能做文件名的字符
    pub fn file_stem(&self) -> String {
        let base = if self.name.trim().is_empty() {
            "规则链"
        } else {
            self.name.trim()
        };
        let cleaned: String = base
            .chars()
            .map(|c| {
                if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                    '-'
                } else {
                    c
                }
            })
            .collect();
        cleaned.trim().trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule::{Action, Filter, Rule, Target};

    fn cfg() -> RenameConfig {
        RenameConfig {
            rules: vec![Rule {
                id: "r1".into(),
                enabled: true,
                target: Target::Stem,
                filter: Filter::default(),
                group: None,
                action: Action::Template {
                    template: "{name}-{index:3}".into(),
                },
            }],
            ..Default::default()
        }
    }

    #[test]
    fn roundtrip_keeps_rules_and_drops_excluded() {
        let mut c = cfg();
        c.excluded = vec![3, 7];
        let f = ChainFile::from_config("照片编号", &c);
        let json = f.to_json();
        assert!(json.contains("照片编号"));

        let back = ChainFile::parse(&json).unwrap();
        assert_eq!(back.name, "照片编号");
        assert_eq!(back.config.rules.len(), 1);
        assert!(back.config.excluded.is_empty(), "排除项不该写进规则链");
        assert_eq!(back.version, CHAIN_VERSION);
    }

    #[test]
    fn rejects_newer_version() {
        let mut f = ChainFile::from_config("x", &cfg());
        f.version = CHAIN_VERSION + 1;
        let err = ChainFile::parse(&f.to_json()).unwrap_err();
        assert!(err.contains("更新的版本"), "{err}");
    }

    #[test]
    fn rejects_empty_chain() {
        let mut c = cfg();
        c.rules.clear();
        let f = ChainFile::from_config("空", &c);
        assert!(ChainFile::parse(&f.to_json())
            .unwrap_err()
            .contains("一条规则"));
    }

    #[test]
    fn rejects_broken_rule_with_index() {
        let mut c = cfg();
        c.rules.push(Rule {
            id: "r2".into(),
            enabled: true,
            target: Target::Stem,
            filter: Filter::default(),
            group: None,
            action: Action::Replace {
                find: "([".into(),
                with: "".into(),
                regex: true,
                case_sensitive: true,
            },
        });
        let err = ChainFile::parse(&ChainFile::from_config("坏", &c).to_json()).unwrap_err();
        assert!(err.contains("第 2 条规则"), "{err}");
    }

    #[test]
    fn file_stem_sanitizes() {
        let mut f = ChainFile::from_config("a/b:c*d", &cfg());
        assert_eq!(f.file_stem(), "a-b-c-d");
        f.name = "   ".into();
        assert_eq!(f.file_stem(), "规则链");
    }

    #[test]
    fn roundtrip_keeps_groups() {
        // 分组要跟着导出：整组停用和整组条件是这套功能的核心，丢了就白设了
        let mut c = cfg();
        c.rules[0].group = Some("g1".into());
        c.groups = vec![crate::rule::RuleGroup {
            id: "g1".into(),
            name: "照片专用".into(),
            enabled: false,
            filter: Filter {
                name_matches: r"\.(jpg|png)$".into(),
                ..Default::default()
            },
        }];
        let back = ChainFile::parse(&ChainFile::from_config("带分组", &c).to_json()).unwrap();
        assert_eq!(back.config.groups.len(), 1);
        assert_eq!(back.config.groups[0].id, "g1");
        assert!(!back.config.groups[0].enabled, "整组停用的状态要保留");
        assert_eq!(
            back.config.groups[0].filter.name_matches, r"\.(jpg|png)$",
            "整组条件要保留"
        );
        assert_eq!(back.config.rules[0].group.as_deref(), Some("g1"));
    }

    #[test]
    fn export_drops_orphan_groups() {
        // 规则早就删光了、只剩空壳的分组不该跟着存进文件
        let mut c = cfg();
        c.groups = vec![crate::rule::RuleGroup {
            id: "ghost".into(),
            name: "没人用".into(),
            enabled: true,
            filter: Filter::default(),
        }];
        let back = ChainFile::parse(&ChainFile::from_config("x", &c).to_json()).unwrap();
        assert!(back.config.groups.is_empty());
    }

    #[test]
    fn rejects_duplicate_group_ids() {
        let mut c = cfg();
        c.rules[0].group = Some("g".into());
        c.groups = vec![
            crate::rule::RuleGroup {
                id: "g".into(),
                name: "".into(),
                enabled: true,
                filter: Filter::default(),
            },
            crate::rule::RuleGroup {
                id: "g".into(),
                name: "".into(),
                enabled: true,
                filter: Filter::default(),
            },
        ];
        let err = ChainFile::parse(&ChainFile::from_config("x", &c).to_json()).unwrap_err();
        assert!(err.contains("分组 id 重复"), "{err}");
    }

    #[test]
    fn rejects_broken_group_filter() {
        let mut c = cfg();
        c.rules[0].group = Some("g".into());
        c.groups = vec![crate::rule::RuleGroup {
            id: "g".into(),
            name: "坏了的条件".into(),
            enabled: true,
            filter: Filter {
                name_matches: "([".into(),
                ..Default::default()
            },
        }];
        let err = ChainFile::parse(&ChainFile::from_config("x", &c).to_json()).unwrap_err();
        assert!(err.contains("坏了的条件"), "{err}");
    }

    #[test]
    fn accepts_plain_config_json() {
        // 手写的简版文件（没有 version/name）也要能读
        let raw = serde_json::to_string(&cfg()).unwrap();
        let text = format!(r#"{{"config":{raw}}}"#);
        let f = ChainFile::parse(&text).unwrap();
        assert_eq!(f.version, CHAIN_VERSION);
        assert_eq!(f.config.rules.len(), 1);
    }
}
