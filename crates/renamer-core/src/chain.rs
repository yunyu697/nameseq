//! 规则链文件（`.nsq`）。
//!
//! 为什么单独做一层：`RenameConfig` 里有 `excluded` 这种「当前这批文件」的临时状态，
//! 不该被存进可复用的规则链；而规则链又需要自己的名字、备注和版本号，
//! 才能在别人机器上打开时给出说得清的提示。
//!
//! 文件就是 UTF-8 的 JSON，用 `.nsq` 后缀是为了双击/拖进窗口时能和普通 json 区分开。

use crate::planner::RenameConfig;
use serde::{Deserialize, Serialize};

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
        let file: Self = serde_json::from_str(text)
            .map_err(|e| format!("不是有效的规则链文件：{e}"))?;
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
        assert!(ChainFile::parse(&f.to_json()).unwrap_err().contains("一条规则"));
    }

    #[test]
    fn rejects_broken_rule_with_index() {
        let mut c = cfg();
        c.rules.push(Rule {
            id: "r2".into(),
            enabled: true,
            target: Target::Stem,
            filter: Filter::default(),
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
    fn accepts_plain_config_json() {
        // 手写的简版文件（没有 version/name）也要能读
        let raw = serde_json::to_string(&cfg()).unwrap();
        let text = format!(r#"{{"config":{raw}}}"#);
        let f = ChainFile::parse(&text).unwrap();
        assert_eq!(f.version, CHAIN_VERSION);
        assert_eq!(f.config.rules.len(), 1);
    }
}
