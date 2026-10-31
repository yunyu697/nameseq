//! 规则链的数据模型与动作实现。
//!
//! 一条规则 = 目标（主名 / 扩展名）+ 可选过滤条件 + 一个动作。
//! 一批文件按顺序穿过所有启用的规则，前一条规则的输出就是后一条的输入。
//!
//! 这样设计的好处：单个动作都很简单、可测试，但组合起来能覆盖绝大多数真实场景。

use crate::model::FileEntry;
use crate::template::{self, RenderCtx, Template};
use chrono::Local;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

fn d_true() -> bool {
    true
}
fn d_one() -> usize {
    1
}
fn d_three() -> usize {
    3
}
fn d_date_fmt() -> String {
    "%Y%m%d".to_string()
}

/// 规则作用在文件名的哪一部分。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    #[default]
    Stem,
    Ext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseMode {
    Upper,
    Lower,
    Title,
    Sentence,
    Camel,
    Snake,
    Kebab,
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DateSource {
    /// 文件修改时间
    #[default]
    Modified,
    /// 当前时间
    Now,
    /// 照片 EXIF 拍摄时间，读不到则回退到修改时间
    Exif,
}

/// 序号进制。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CounterBase {
    #[default]
    Decimal,
    AlphaUpper,
    AlphaLower,
}

/// 目标名被占用时怎么办。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// 标记冲突并跳过
    #[default]
    Skip,
    /// 自动加 " (1)" " (2)" 直到不冲突
    Suffix,
}

/// 规则生效的条件。全部为空表示无条件。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// 只对指定扩展名生效（不带点，大小写不敏感）
    #[serde(default)]
    pub exts: Vec<String>,
    /// 文件名正则，空表示不限
    #[serde(default)]
    pub name_matches: String,
    #[serde(default)]
    pub min_size: Option<u64>,
    #[serde(default)]
    pub max_size: Option<u64>,
    #[serde(default)]
    pub modified_after: Option<i64>,
    #[serde(default)]
    pub modified_before: Option<i64>,
}

impl Filter {
    pub fn is_active(&self) -> bool {
        !self.exts.is_empty()
            || !self.name_matches.trim().is_empty()
            || self.min_size.is_some()
            || self.max_size.is_some()
            || self.modified_after.is_some()
            || self.modified_before.is_some()
    }

    pub fn matches(&self, e: &FileEntry, name_re: Option<&Regex>) -> bool {
        if !self.exts.is_empty() {
            let ext = e.ext.to_lowercase();
            let hit = self
                .exts
                .iter()
                .any(|x| x.trim().trim_start_matches('.').to_lowercase() == ext);
            if !hit {
                return false;
            }
        }
        if let Some(re) = name_re {
            if !re.is_match(&e.name) {
                return false;
            }
        }
        if let Some(min) = self.min_size {
            if e.size < min {
                return false;
            }
        }
        if let Some(max) = self.max_size {
            if e.size > max {
                return false;
            }
        }
        if let Some(after) = self.modified_after {
            if e.modified_ms < after {
                return false;
            }
        }
        if let Some(before) = self.modified_before {
            if e.modified_ms > before {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// 占位符模板，见 template.rs
    Template {
        template: String,
    },
    /// 查找替换，支持正则与 $1 捕获组
    Replace {
        find: String,
        #[serde(default)]
        with: String,
        #[serde(default)]
        regex: bool,
        #[serde(default = "d_true")]
        case_sensitive: bool,
    },
    /// 删除匹配的部分
    Remove {
        pattern: String,
        #[serde(default)]
        regex: bool,
        #[serde(default = "d_true")]
        case_sensitive: bool,
    },
    Case {
        mode: CaseMode,
    },
    /// 序号。每个规则有自己的计数器，可按时目录重置
    Counter {
        #[serde(default = "d_one")]
        start: usize,
        #[serde(default = "d_one")]
        step: usize,
        #[serde(default = "d_three")]
        width: usize,
        /// None 表示追加到末尾，Some(n) 表示插到第 n 个字符处
        #[serde(default)]
        at: Option<usize>,
        #[serde(default)]
        per_folder: bool,
        #[serde(default)]
        base: CounterBase,
    },
    Prefix {
        text: String,
    },
    Suffix {
        text: String,
    },
    /// 在指定字符位置插入文本
    Insert {
        text: String,
        #[serde(default)]
        at: usize,
    },
    /// 去首尾空白，或去首尾指定字符
    Trim {
        #[serde(default)]
        chars: String,
    },
    /// 字符层面的清洗
    Normalize {
        #[serde(default)]
        fullwidth: bool,
        #[serde(default)]
        diacritics: bool,
        #[serde(default)]
        emoji: bool,
        #[serde(default)]
        collapse_space: bool,
    },
    /// 插入日期
    Date {
        #[serde(default)]
        source: DateSource,
        #[serde(default = "d_date_fmt")]
        format: String,
        #[serde(default)]
        at: Option<usize>,
    },
    /// 直接设定扩展名，比如 jpeg → jpg
    SetExt {
        ext: String,
    },
    Truncate {
        max_chars: usize,
        #[serde(default)]
        from_end: bool,
    },
    /// 中文数字 ↔ 阿拉伯数字，比如「第十二章」↔「第12章」
    ChineseNumber {
        #[serde(default)]
        mode: ChineseNumberMode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChineseNumberMode {
    /// 中文 → 数字（第十二章 → 第12章）
    #[default]
    ToArabic,
    /// 数字 → 中文（第12章 → 第十二章）
    ToChinese,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default)]
    pub target: Target,
    #[serde(default)]
    pub filter: Filter,
    /// 所属分组 id。None = 不分组（最外层，永远生效）
    #[serde(default)]
    pub group: Option<String>,
    pub action: Action,
}

/// 规则分组：把若干条规则打包，能整组停用、整组加条件。
///
/// 分组只是「附加在规则上的标签 + 一组开关」，规则链本身仍然是平铺的 Vec：
/// 顺序就是执行顺序，分组不会打乱它。这样规划器只多两行判断，
/// 而 `.nsq` 文件也保持向后兼容（老文件没有 groups 字段，全部规则视为不分组）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleGroup {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "d_true")]
    pub enabled: bool,
    /// 组条件：不满足条件的文件，组内所有规则都不生效
    #[serde(default)]
    pub filter: Filter,
}

impl RuleGroup {
    /// 给用户看的名字：没起名就退回 id，免得报错里出现一串空字符串。
    pub fn display_name(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.id
        } else {
            self.name.trim()
        }
    }
}

impl Rule {
    /// 编译期把正则和模板都准备好，避免在几万个文件上反复解析。
    pub fn compile(&self) -> Result<CompiledRule, String> {
        let filter_re = if self.filter.name_matches.trim().is_empty() {
            None
        } else {
            Some(
                RegexBuilder::new(&self.filter.name_matches)
                    .case_insensitive(true)
                    .build()
                    .map_err(|e| format!("条件里的正则写错了: {e}"))?,
            )
        };

        let mut action_re = None;
        let mut tpl = None;

        match &self.action {
            Action::Template { template } => {
                tpl = Some(template::parse(template).map_err(|e| e.to_string())?);
            }
            Action::Replace {
                find,
                regex,
                case_sensitive,
                ..
            }
            | Action::Remove {
                pattern: find,
                regex,
                case_sensitive,
            } => {
                if *regex {
                    action_re = Some(
                        RegexBuilder::new(find)
                            .case_insensitive(!*case_sensitive)
                            .build()
                            .map_err(|e| format!("正则写错了: {e}"))?,
                    );
                }
            }
            _ => {}
        }

        Ok(CompiledRule {
            rule: self.clone(),
            filter_re,
            action_re,
            template: tpl,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub rule: Rule,
    filter_re: Option<Regex>,
    action_re: Option<Regex>,
    template: Option<Template>,
}

/// 当前正在改的名字。
#[derive(Debug, Clone)]
pub struct NameState {
    pub stem: String,
    pub ext: String,
    /// 模板里显式写了 {ext} 时记下当时的扩展名。
    ///
    /// 有了它，planner 才知道最终拼接时不该再补一次扩展名，
    /// 否则 `{name}.{ext}` 配上「保留扩展名」会变成 a.jpg.jpg。
    pub ext_emitted: Option<String>,
}

pub struct EvalCtx<'a> {
    pub entry: &'a FileEntry,
    pub index: usize,
    pub total: usize,
    pub counter: usize,
    /// {index} 无显式格式时的零补位数（0/1 = 不补）
    pub index_width: usize,
}

impl CompiledRule {
    pub fn accepts(&self, e: &FileEntry) -> bool {
        self.rule.filter.matches(e, self.filter_re.as_ref())
    }

    /// 把这条规则作用到名字上。
    pub fn apply(&self, state: &mut NameState, ctx: &EvalCtx) -> Result<(), String> {
        // 改扩展名天然只作用于扩展名，不受 target 影响
        if matches!(self.rule.action, Action::SetExt { .. }) {
            let cur = state.ext.clone();
            state.ext = self.apply_to(String::new(), &cur, ctx)?;
            return Ok(());
        }

        let mut s = match self.rule.target {
            Target::Stem => state.stem.clone(),
            Target::Ext => state.ext.clone(),
        };

        // 模板里写了 {ext} 的话，记下来，planner 拼最终名字时就不会再补一次
        if self.rule.target == Target::Stem {
            if let Some(tpl) = self.template.as_ref() {
                if tpl.uses_ext {
                    state.ext_emitted = Some(state.ext.clone());
                }
            }
        }

        s = self.apply_to(s, &state.ext, ctx)?;

        match self.rule.target {
            Target::Stem => state.stem = s,
            Target::Ext => state.ext = s.trim_start_matches('.').to_string(),
        }
        Ok(())
    }

    fn apply_to(&self, s: String, ext_now: &str, ctx: &EvalCtx) -> Result<String, String> {
        Ok(match &self.rule.action {
            Action::Template { .. } => {
                let tpl = self.template.as_ref().ok_or("模板未编译")?;
                tpl.render(&RenderCtx {
                    stem: &s,
                    ext: ext_now,
                    dir: parent_name(&ctx.entry.dir),
                    index: ctx.index,
                    index_width: ctx.index_width,
                    total: ctx.total,
                    size: ctx.entry.size,
                    modified_ms: ctx.entry.modified_ms,
                    media: ctx.entry.media.as_ref(),
                })
            }

            Action::Replace {
                find,
                with,
                regex,
                case_sensitive,
            } => {
                if find.is_empty() {
                    s
                } else if *regex {
                    match self.action_re.as_ref() {
                        Some(re) => re.replace_all(&s, with.as_str()).to_string(),
                        None => s,
                    }
                } else if *case_sensitive {
                    s.replace(find, with)
                } else {
                    replace_ci(&s, find, with)
                }
            }

            Action::Remove {
                pattern,
                regex,
                case_sensitive,
            } => {
                if pattern.is_empty() {
                    s
                } else if *regex {
                    match self.action_re.as_ref() {
                        Some(re) => re.replace_all(&s, "").to_string(),
                        None => s,
                    }
                } else if *case_sensitive {
                    s.replace(pattern, "")
                } else {
                    replace_ci(&s, pattern, "")
                }
            }

            Action::Case { mode } => apply_case(&s, *mode),

            Action::Counter {
                start,
                step,
                width,
                at,
                base,
                ..
            } => {
                let _ = (start, step); // 具体数值由 planner 算好后放进 ctx.counter
                let token = match base {
                    CounterBase::Decimal => format!("{:0width$}", ctx.counter, width = *width),
                    CounterBase::AlphaUpper => alpha_counter(ctx.counter, true),
                    CounterBase::AlphaLower => alpha_counter(ctx.counter, false),
                };
                insert_at(&s, &token, *at)
            }

            Action::Prefix { text } => format!("{text}{s}"),
            Action::Suffix { text } => format!("{s}{text}"),

            Action::Insert { text, at } => insert_at(&s, text, Some(*at)),

            Action::Trim { chars } => {
                if chars.is_empty() {
                    s.trim().to_string()
                } else {
                    let set: Vec<char> = chars.chars().collect();
                    s.trim_matches(|c| set.contains(&c)).to_string()
                }
            }

            Action::Normalize {
                fullwidth,
                diacritics,
                emoji,
                collapse_space,
            } => {
                let mut out = s;
                if *fullwidth {
                    out = to_halfwidth(&out);
                }
                if *diacritics {
                    out = strip_diacritics(&out);
                }
                if *emoji {
                    out = strip_emoji(&out);
                }
                if *collapse_space {
                    out = collapse_spaces(&out);
                }
                out
            }

            Action::Date { source, format, at } => {
                let text = date_text(ctx.entry, *source, format);
                insert_at(&s, &text, *at)
            }

            Action::SetExt { ext } => ext.trim().trim_start_matches('.').to_string(),

            Action::Truncate {
                max_chars,
                from_end,
            } => {
                let chars: Vec<char> = s.chars().collect();
                if chars.len() <= *max_chars {
                    s
                } else if *from_end {
                    chars[chars.len() - max_chars..].iter().collect()
                } else {
                    chars[..*max_chars].iter().collect()
                }
            }

            Action::ChineseNumber { mode } => match mode {
                ChineseNumberMode::ToArabic => crate::cn::to_arabic(&s),
                ChineseNumberMode::ToChinese => crate::cn::to_chinese(&s),
            },
        })
    }
}

fn parent_name(dir: &str) -> &str {
    std::path::Path::new(dir)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
}

/// 大小写不敏感的替换：逐字符比较，保持原串其余部分不变。
fn replace_ci(hay: &str, needle: &str, rep: &str) -> String {
    let hay_l = hay.to_lowercase();
    let needle_l = needle.to_lowercase();
    if needle_l.is_empty() {
        return hay.to_string();
    }
    let mut out = String::with_capacity(hay.len());
    let mut i = 0usize;
    while i < hay.len() {
        if hay_l[i..].starts_with(&needle_l) && hay.is_char_boundary(i + needle.len()) {
            out.push_str(rep);
            i += needle.len();
        } else {
            let ch = hay[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn apply_case(s: &str, mode: CaseMode) -> String {
    match mode {
        CaseMode::Upper => s.to_uppercase(),
        CaseMode::Lower => s.to_lowercase(),
        CaseMode::Toggle => s
            .chars()
            .map(|c| {
                if c.is_uppercase() {
                    c.to_lowercase().to_string()
                } else if c.is_lowercase() {
                    c.to_uppercase().to_string()
                } else {
                    c.to_string()
                }
            })
            .collect(),
        CaseMode::Title => split_words(s)
            .iter()
            .map(|w| capitalize(w))
            .collect::<Vec<_>>()
            .join(" "),
        CaseMode::Sentence => {
            let lower = s.to_lowercase();
            capitalize(&lower)
        }
        CaseMode::Camel => {
            let words = split_words(s);
            let mut out = String::new();
            for (i, w) in words.iter().enumerate() {
                if i == 0 {
                    out.push_str(&w.to_lowercase());
                } else {
                    out.push_str(&capitalize(&w.to_lowercase()));
                }
            }
            out
        }
        CaseMode::Snake => split_words(s)
            .iter()
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join("_"),
        CaseMode::Kebab => split_words(s)
            .iter()
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join("-"),
    }
}

fn split_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            // 驼峰边界：小写后跟大写时切一刀
            if prev_lower && c.is_uppercase() && !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            prev_lower = c.is_lowercase() || c.is_numeric();
            cur.push(c);
        } else if !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
            prev_lower = false;
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn alpha_counter(n: usize, upper: bool) -> String {
    // 1 → A, 26 → Z, 27 → AA
    let mut n = n.max(1);
    let mut out = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push(if upper {
            (b'A' + rem as u8) as char
        } else {
            (b'a' + rem as u8) as char
        });
        n = (n - 1) / 26;
    }
    out.iter().rev().collect()
}

fn insert_at(s: &str, text: &str, at: Option<usize>) -> String {
    match at {
        None => format!("{s}{text}"),
        Some(idx) => {
            let byte = char_index_to_byte(s, idx);
            let mut out = String::with_capacity(s.len() + text.len());
            out.push_str(&s[..byte]);
            out.push_str(text);
            out.push_str(&s[byte..]);
            out
        }
    }
}

fn char_index_to_byte(s: &str, idx: usize) -> usize {
    s.char_indices().nth(idx).map(|(b, _)| b).unwrap_or(s.len())
}

fn to_halfwidth(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect()
}

fn strip_diacritics(s: &str) -> String {
    s.nfd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect()
}

fn strip_emoji(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let u = *c as u32;
            !matches!(u,
                0x1F000..=0x1FAFF
                | 0x2600..=0x27BF
                | 0xFE00..=0xFE0F
                | 0x200D
            )
        })
        .collect()
}

fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out.trim_end().to_string()
}

fn date_text(entry: &FileEntry, source: DateSource, fmt: &str) -> String {
    match source {
        DateSource::Now => Local::now().format(fmt).to_string(),
        DateSource::Modified => fmt_ms(entry.modified_ms, fmt),
        DateSource::Exif => exif_datetime(&entry.path)
            .map(|d| d.format(fmt).to_string())
            .unwrap_or_else(|| fmt_ms(entry.modified_ms, fmt)),
    }
}

fn fmt_ms(ms: i64, fmt: &str) -> String {
    use chrono::TimeZone;
    match Local.timestamp_millis_opt(ms).single() {
        Some(dt) => dt.format(fmt).to_string(),
        None => String::new(),
    }
}

fn exif_datetime(path: &str) -> Option<chrono::NaiveDateTime> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut buf).ok()?;
    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    if let exif::Value::Ascii(ref v) = field.value {
        let bytes = v.first()?;
        let s = std::str::from_utf8(bytes).ok()?.trim_end_matches('\0');
        return chrono::NaiveDateTime::parse_from_str(s, "%Y:%m:%d %H:%M:%S").ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> FileEntry {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), e.to_string()),
            None => (name.to_string(), String::new()),
        };
        FileEntry {
            id: 1,
            path: format!("/t/{name}"),
            dir: "/t".into(),
            stem,
            ext,
            name: name.to_string(),
            size: 1000,
            modified_ms: 1_700_000_000_000,
            is_dir: false,
            error: None,
            media: None,
        }
    }

    fn run(rule: Rule, input: &str, counter: usize) -> String {
        let e = entry(input);
        let c = rule.compile().unwrap();
        let mut state = NameState {
            stem: e.stem.clone(),
            ext: e.ext.clone(),
            ext_emitted: None,
        };
        c.apply(
            &mut state,
            &EvalCtx {
                entry: &e,
                index: 1,
                total: 1,
                counter,
                index_width: 0,
            },
        )
        .unwrap();
        state.stem
    }

    fn r(action: Action) -> Rule {
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
    fn replace_literal_and_ci() {
        let a = Action::Replace {
            find: "IMG".into(),
            with: "照片".into(),
            regex: false,
            case_sensitive: true,
        };
        assert_eq!(run(r(a.clone()), "IMG_001.jpg", 1), "照片_001");

        let ci = Action::Replace {
            find: "img".into(),
            with: "X".into(),
            regex: false,
            case_sensitive: false,
        };
        assert_eq!(run(r(ci), "IMG_001.jpg", 1), "X_001");
    }

    #[test]
    fn replace_with_capture_groups() {
        // 注意 $2_ 会被当成组名 "2_"，必须写成 ${2}_${1}
        let a = Action::Replace {
            find: r"^(\d+)-(\w+)$".into(),
            with: "${2}_${1}".into(),
            regex: true,
            case_sensitive: true,
        };
        assert_eq!(run(r(a), "2024-trip.jpg", 1), "trip_2024");
    }

    #[test]
    fn replace_capture_group_without_braces_still_works_when_not_ambiguous() {
        let a = Action::Replace {
            find: r"(\d+)".into(),
            with: "#$1#".into(),
            regex: true,
            case_sensitive: true,
        };
        assert_eq!(run(r(a), "a12b.jpg", 1), "a#12#b");
    }

    #[test]
    fn remove_pattern() {
        let a = Action::Remove {
            pattern: r"\[\d+\]".into(),
            regex: true,
            case_sensitive: true,
        };
        assert_eq!(run(r(a), "song[1].mp3", 1), "song");
    }

    #[test]
    fn case_modes() {
        assert_eq!(
            run(
                r(Action::Case {
                    mode: CaseMode::Upper
                }),
                "abc.txt",
                1
            ),
            "ABC"
        );
        assert_eq!(
            run(
                r(Action::Case {
                    mode: CaseMode::Snake
                }),
                "My Photo File.jpg",
                1
            ),
            "my_photo_file"
        );
        assert_eq!(
            run(
                r(Action::Case {
                    mode: CaseMode::Kebab
                }),
                "MyPhotoFile.jpg",
                1
            ),
            "my-photo-file"
        );
        assert_eq!(
            run(
                r(Action::Case {
                    mode: CaseMode::Camel
                }),
                "my photo file.jpg",
                1
            ),
            "myPhotoFile"
        );
        assert_eq!(
            run(
                r(Action::Case {
                    mode: CaseMode::Title
                }),
                "my photo.jpg",
                1
            ),
            "My Photo"
        );
    }

    #[test]
    fn counter_padding_and_position() {
        let a = Action::Counter {
            start: 1,
            step: 1,
            width: 3,
            at: None,
            per_folder: false,
            base: CounterBase::Decimal,
        };
        assert_eq!(run(r(a.clone()), "a.jpg", 7), "a007");

        let at0 = Action::Counter {
            start: 1,
            step: 1,
            width: 2,
            at: Some(0),
            per_folder: false,
            base: CounterBase::Decimal,
        };
        assert_eq!(run(r(at0), "a.jpg", 7), "07a");
    }

    #[test]
    fn counter_alpha_base() {
        let a = Action::Counter {
            start: 1,
            step: 1,
            width: 1,
            at: None,
            per_folder: false,
            base: CounterBase::AlphaUpper,
        };
        assert_eq!(run(r(a.clone()), "x.jpg", 1), "xA");
        assert_eq!(run(r(a.clone()), "x.jpg", 26), "xZ");
        assert_eq!(run(r(a), "x.jpg", 27), "xAA");
    }

    #[test]
    fn prefix_suffix_insert() {
        assert_eq!(
            run(r(Action::Prefix { text: "P-".into() }), "a.jpg", 1),
            "P-a"
        );
        assert_eq!(
            run(r(Action::Suffix { text: "-S".into() }), "a.jpg", 1),
            "a-S"
        );
        assert_eq!(
            run(
                r(Action::Insert {
                    text: "_X_".into(),
                    at: 1
                }),
                "abcd.jpg",
                1
            ),
            "a_X_bcd"
        );
    }

    #[test]
    fn chinese_number_action_converts_both_ways() {
        assert_eq!(
            run(
                r(Action::ChineseNumber {
                    mode: ChineseNumberMode::ToArabic
                }),
                "第十二章",
                1
            ),
            "第12章"
        );
        assert_eq!(
            run(
                r(Action::ChineseNumber {
                    mode: ChineseNumberMode::ToChinese
                }),
                "第12章",
                1
            ),
            "第十二章"
        );
        // 不用这条规则时，中文原名原样保留
        assert_eq!(
            run(r(Action::Prefix { text: "x".into() }), "第一章", 1),
            "x第一章"
        );
    }

    #[test]
    fn trim_and_truncate() {
        assert_eq!(
            run(
                r(Action::Trim {
                    chars: String::new()
                }),
                "  a  .txt",
                1
            ),
            "a"
        );
        assert_eq!(
            run(r(Action::Trim { chars: "_-".into() }), "__a__-b--", 1),
            "a__-b"
        );
        assert_eq!(
            run(
                r(Action::Truncate {
                    max_chars: 3,
                    from_end: false
                }),
                "abcdef.jpg",
                1
            ),
            "abc"
        );
        assert_eq!(
            run(
                r(Action::Truncate {
                    max_chars: 3,
                    from_end: true
                }),
                "abcdef.jpg",
                1
            ),
            "def"
        );
    }

    #[test]
    fn normalize_fullwidth_and_spaces() {
        let a = Action::Normalize {
            fullwidth: true,
            diacritics: false,
            emoji: false,
            collapse_space: true,
        };
        assert_eq!(run(r(a), "ＡＢＣ   文件.jpg", 1), "ABC 文件");
    }

    #[test]
    fn normalize_diacritics_and_emoji() {
        let a = Action::Normalize {
            fullwidth: false,
            diacritics: true,
            emoji: true,
            collapse_space: false,
        };
        assert_eq!(run(r(a), "café😀.jpg", 1), "cafe");
    }

    #[test]
    fn set_ext_targets_ext() {
        let rule = Rule {
            id: "r".into(),
            enabled: true,
            target: Target::Ext,
            filter: Filter::default(),
            group: None,
            action: Action::SetExt { ext: ".jpg".into() },
        };
        let e = entry("photo.jpeg");
        let c = rule.compile().unwrap();
        let mut state = NameState {
            stem: e.stem.clone(),
            ext: e.ext.clone(),
            ext_emitted: None,
        };
        c.apply(
            &mut state,
            &EvalCtx {
                entry: &e,
                index: 1,
                total: 1,
                counter: 1,
                index_width: 0,
            },
        )
        .unwrap();
        assert_eq!(state.ext, "jpg");
        assert_eq!(state.stem, "photo");
    }

    #[test]
    fn date_from_modified() {
        let a = Action::Date {
            source: DateSource::Modified,
            format: "%Y".into(),
            at: Some(0),
        };
        let out = run(r(a), "a.jpg", 1);
        assert!(out.starts_with("202"), "实际 {out}");
        assert!(out.ends_with("a"));
    }

    #[test]
    fn filter_by_ext_and_size() {
        let mut rule = r(Action::Prefix { text: "X".into() });
        rule.filter = Filter {
            exts: vec!["JPG".into()],
            min_size: Some(500),
            ..Default::default()
        };
        let c = rule.compile().unwrap();
        assert!(c.accepts(&entry("a.jpg")));
        assert!(!c.accepts(&entry("a.png")));

        let mut small = entry("b.jpg");
        small.size = 10;
        assert!(!c.accepts(&small));
    }

    #[test]
    fn bad_regex_is_reported() {
        let rule = r(Action::Replace {
            find: "([".into(),
            with: "".into(),
            regex: true,
            case_sensitive: true,
        });
        assert!(rule.compile().is_err());
    }

    #[test]
    fn unicode_safe_insert() {
        assert_eq!(
            run(
                r(Action::Insert {
                    text: "-".into(),
                    at: 2
                }),
                "中文名.jpg",
                1
            ),
            "中文-名"
        );
    }
}
