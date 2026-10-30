//! 文件名模板引擎。
//!
//! 语法：
//! ```text
//! {name}                      原主名
//! {ext}                       原扩展名（不含点）
//! {dir}                       所在目录名
//! {index} / {index:3} / {index:03}   序号，默认从 1 开始
//! {total}                     本批总数
//! {size} / {sizehr}           字节 / 人类可读
//! {date} / {date:%Y-%m-%d}    修改时间，默认 %Y%m%d
//! {time}                      修改时间，默认 %H%M%S
//! {mtime}                     修改时间戳（秒）
//! {title} {artist} {album} {track}   音视频标签（需开启「读取媒体标签」）
//! {duration} / {duration:clock}      时长，默认秒数，clock 输出 03-45
//! {width} {height}            视频 / 图片分辨率
//! ```
//!
//! 修饰符用 `|` 串联，从左到右依次生效：
//! ```text
//! {name|lower}                小写
//! {name|upper}                大写
//! {name|trim}                 去首尾空白
//! {name|capitalize}           首字母大写
//! {name|slug}                 空格和特殊字符转连字符
//! {name|pad:3}                左侧补零到 3 位
//! {name|replace:a:b}          替换
//! {name|substr:0:8}           截取（起点, 长度）
//! {name|default:未命名}        空值时兜底
//! ```
//!
//! `{{` 和 `}}` 用来输出字面量的花括号。
//!
//! 关键设计：解析一次得到 AST，渲染时只做纯字符串计算，不碰文件系统。
//! 预览和执行共用同一个 `Template` 实例，从根本上杜绝「预览显示 A、实际改成 B」。

use chrono::{Local, TimeZone};
use crate::model::MediaMeta;
use serde::{Deserialize, Serialize};

const KNOWN_FIELDS: [&str; 18] = [
    "name",
    "ext",
    "dir",
    "index",
    "counter",
    "total",
    "size",
    "sizehr",
    "date",
    "time",
    "title",
    "artist",
    "album",
    "track",
    "duration",
    "width",
    "height",
    "mtime",
];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TemplateError {
    #[error("模板中有未闭合的 {{ 或 }}")]
    UnclosedBrace,
    #[error("占位符不能为空，写 {{name}} 这样")]
    EmptyField,
    #[error("未知的占位符 {{{0}}}")]
    UnknownField(String),
    #[error("未知的修饰符 |{0}")]
    UnknownModifier(String),
    #[error("修饰符 |{0} 的参数不正确")]
    BadModifierArg(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Lit(String),
    Field(Field),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Field {
    key: String,
    fmt: Option<String>,
    mods: Vec<Modifier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Modifier {
    Lower,
    Upper,
    Trim,
    Capitalize,
    Slug,
    Pad(usize),
    Replace(String, String),
    Substr(i64, usize),
    Default(String),
    Pinyin,
}

/// 渲染上下文。由 planner 按文件逐个填充。
#[derive(Debug, Clone)]
pub struct RenderCtx<'a> {
    pub stem: &'a str,
    pub ext: &'a str,
    pub dir: &'a str,
    pub index: usize,
    pub total: usize,
    pub size: u64,
    pub modified_ms: i64,
    /// 媒体标签，没读或读不到时为 None（对应占位符渲染成空串）
    pub media: Option<&'a MediaMeta>,
}

/// 解析后的模板。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    source: String,
    tokens: Vec<Token>,
    /// 模板里是否显式引用了 {ext}，planner 用它决定要不要自动补扩展名
    pub uses_ext: bool,
}

impl Template {
    pub fn source(&self) -> &str {
        &self.source
    }

    /// 渲染成字符串。纯计算，不会失败。
    pub fn render(&self, ctx: &RenderCtx) -> String {
        let mut out = String::with_capacity(64);
        for tok in &self.tokens {
            match tok {
                Token::Lit(s) => out.push_str(s),
                Token::Field(f) => {
                    let mut v = field_value(f, ctx);
                    for m in &f.mods {
                        v = apply_modifier(v, m);
                    }
                    out.push_str(&v);
                }
            }
        }
        out
    }
}

/// 解析模板字符串。
pub fn parse(src: &str) -> Result<Template, TemplateError> {
    let bytes = src.as_bytes();
    let mut tokens: Vec<Token> = Vec::new();
    let mut lit = String::new();
    let mut uses_ext = false;
    let mut i = 0usize;

    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                // {{ 转义
                if bytes.get(i + 1) == Some(&b'{') {
                    lit.push('{');
                    i += 2;
                    continue;
                }
                let close = src[i + 1..]
                    .find('}')
                    .map(|p| i + 1 + p)
                    .ok_or(TemplateError::UnclosedBrace)?;
                if !lit.is_empty() {
                    tokens.push(Token::Lit(std::mem::take(&mut lit)));
                }
                let field = parse_field(&src[i + 1..close])?;
                if field.key == "ext" {
                    uses_ext = true;
                }
                tokens.push(Token::Field(field));
                i = close + 1;
            }
            b'}' => {
                if bytes.get(i + 1) == Some(&b'}') {
                    lit.push('}');
                    i += 2;
                    continue;
                }
                return Err(TemplateError::UnclosedBrace);
            }
            b => {
                let n = utf8_len(b);
                lit.push_str(&src[i..i + n]);
                i += n;
            }
        }
    }
    if !lit.is_empty() {
        tokens.push(Token::Lit(lit));
    }

    Ok(Template {
        source: src.to_string(),
        tokens,
        uses_ext,
    })
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

fn parse_field(inner: &str) -> Result<Field, TemplateError> {
    let mut parts = inner.split('|');
    let head = parts.next().unwrap_or("").trim();
    if head.is_empty() {
        return Err(TemplateError::EmptyField);
    }
    let (key, fmt) = match head.split_once(':') {
        Some((k, f)) => (k.trim().to_ascii_lowercase(), Some(f.trim().to_string())),
        None => (head.to_ascii_lowercase(), None),
    };
    if !KNOWN_FIELDS.contains(&key.as_str()) {
        return Err(TemplateError::UnknownField(key));
    }
    let mut mods = Vec::new();
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        mods.push(parse_modifier(p)?);
    }
    Ok(Field { key, fmt, mods })
}

fn parse_modifier(s: &str) -> Result<Modifier, TemplateError> {
    let (name, arg) = match s.split_once(':') {
        Some((n, a)) => (n.trim(), Some(a)),
        None => (s.trim(), None),
    };
    match name {
        "lower" => Ok(Modifier::Lower),
        "upper" => Ok(Modifier::Upper),
        "trim" => Ok(Modifier::Trim),
        "capitalize" => Ok(Modifier::Capitalize),
        "slug" => Ok(Modifier::Slug),
        "pad" => {
            let a = arg.ok_or_else(|| TemplateError::BadModifierArg("pad".into()))?;
            let w: usize = a
                .trim()
                .parse()
                .map_err(|_| TemplateError::BadModifierArg("pad".into()))?;
            Ok(Modifier::Pad(w.min(64)))
        }
        "replace" => {
            let a = arg.ok_or_else(|| TemplateError::BadModifierArg("replace".into()))?;
            let (from, to) = a
                .split_once(':')
                .ok_or_else(|| TemplateError::BadModifierArg("replace".into()))?;
            Ok(Modifier::Replace(from.to_string(), to.to_string()))
        }
        "substr" => {
            let a = arg.ok_or_else(|| TemplateError::BadModifierArg("substr".into()))?;
            let (start, len) = a
                .split_once(':')
                .ok_or_else(|| TemplateError::BadModifierArg("substr".into()))?;
            let start: i64 = start
                .trim()
                .parse()
                .map_err(|_| TemplateError::BadModifierArg("substr".into()))?;
            let len: usize = len
                .trim()
                .parse()
                .map_err(|_| TemplateError::BadModifierArg("substr".into()))?;
            Ok(Modifier::Substr(start, len))
        }
        "default" => Ok(Modifier::Default(arg.unwrap_or("").to_string())),
        // 汉字转拼音（无声调，小写），用来把中文名变成 ASCII
        "pinyin" => Ok(Modifier::Pinyin),
        other => Err(TemplateError::UnknownModifier(other.to_string())),
    }
}

fn field_value(f: &Field, ctx: &RenderCtx) -> String {
    match f.key.as_str() {
        "name" => ctx.stem.to_string(),
        "ext" => ctx.ext.to_string(),
        "dir" => ctx.dir.to_string(),
        "index" | "counter" => match f.fmt.as_deref() {
            Some(fmt) => pad_number(ctx.index, fmt),
            None => ctx.index.to_string(),
        },
        "total" => ctx.total.to_string(),
        "size" => ctx.size.to_string(),
        "sizehr" => human_size(ctx.size),
        "date" => fmt_time(ctx.modified_ms, f.fmt.as_deref().unwrap_or("%Y%m%d")),
        "time" => fmt_time(ctx.modified_ms, f.fmt.as_deref().unwrap_or("%H%M%S")),
        "mtime" => (ctx.modified_ms / 1000).to_string(),
        "title" => media_field(ctx, |m| &m.title),
        "artist" => media_field(ctx, |m| &m.artist),
        "album" => media_field(ctx, |m| &m.album),
        "track" => media_field(ctx, |m| &m.track),
        "duration" => match ctx.media {
            Some(m) if m.duration_ms > 0 => match f.fmt.as_deref() {
                Some("clock") => clock_ms(m.duration_ms),
                Some("ms") => m.duration_ms.to_string(),
                _ => (m.duration_ms / 1000).to_string(),
            },
            _ => String::new(),
        },
        "width" => number_or_empty(ctx.media.map(|m| m.width)),
        "height" => number_or_empty(ctx.media.map(|m| m.height)),
        _ => String::new(),
    }
}

fn media_field(ctx: &RenderCtx, pick: impl Fn(&MediaMeta) -> &String) -> String {
    ctx.media.map(|m| pick(m).clone()).unwrap_or_default()
}

fn number_or_empty(v: Option<u32>) -> String {
    match v {
        Some(n) if n > 0 => n.to_string(),
        _ => String::new(),
    }
}

/// 毫秒 → `03-45`（用连字符，冒号在 Windows 文件名里非法）
fn clock_ms(ms: u64) -> String {
    let total = ms / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}-{m:02}-{s:02}")
    } else {
        format!("{m:02}-{s:02}")
    }
}

/// `{index:3}` 补到 3 位；`{index:03}` 同样补到 3 位（按整数解析，"03" → 3）。
fn pad_number(n: usize, fmt: &str) -> String {
    let width = fmt.parse::<usize>().unwrap_or(fmt.len()).clamp(1, 12);
    format!("{n:0width$}")
}

fn fmt_time(ms: i64, pattern: &str) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(dt) => dt.format(pattern).to_string(),
        None => String::new(),
    }
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{bytes}{}", UNITS[0])
    } else {
        format!("{v:.1}{}", UNITS[u])
    }
}

fn apply_modifier(s: String, m: &Modifier) -> String {
    match m {
        Modifier::Lower => s.to_lowercase(),
        Modifier::Upper => s.to_uppercase(),
        Modifier::Trim => s.trim().to_string(),
        Modifier::Capitalize => {
            let mut chars = s.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => s,
            }
        }
        Modifier::Slug => slugify(&s),
        Modifier::Pad(w) => {
            if s.chars().count() >= *w {
                s
            } else {
                let need = w - s.chars().count();
                format!("{}{}", "0".repeat(need), s)
            }
        }
        Modifier::Replace(a, b) => s.replace(a, b),
        Modifier::Substr(start, len) => {
            let chars: Vec<char> = s.chars().collect();
            let n = chars.len() as i64;
            let from = if *start < 0 {
                (n + *start).max(0)
            } else {
                (*start).min(n)
            } as usize;
            let to = (from + *len).min(chars.len());
            chars[from..to].iter().collect()
        }
        Modifier::Default(d) => {
            if s.trim().is_empty() {
                d.clone()
            } else {
                s
            }
        }
        Modifier::Pinyin => crate::cn::to_pinyin_plain(&s).to_lowercase(),
    }
}

fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

// 让 Template 能直接挂在 Plan 上做诊断（不参与反序列化）
impl Serialize for Template {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.source)
    }
}

impl<'de> Deserialize<'de> for Template {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        parse(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>() -> RenderCtx<'a> {
        RenderCtx {
            stem: "My Photo",
            ext: "JPG",
            dir: "Trip",
            index: 7,
            total: 42,
            size: 2048,
            modified_ms: 1_700_000_000_000,
            media: None,
        }
    }

    fn media_ctx(m: &MediaMeta) -> RenderCtx<'_> {
        RenderCtx {
            media: Some(m),
            ..ctx()
        }
    }

    fn render(tpl: &str) -> String {
        parse(tpl).unwrap().render(&ctx())
    }

    #[test]
    fn plain_literal() {
        assert_eq!(render("prefix-"), "prefix-");
    }

    #[test]
    fn fields() {
        assert_eq!(render("{name}"), "My Photo");
        assert_eq!(render("{ext}"), "JPG");
        assert_eq!(render("{dir}"), "Trip");
        assert_eq!(render("{total}"), "42");
        assert_eq!(render("{size}"), "2048");
        assert_eq!(render("{sizehr}"), "2.0KB");
    }

    #[test]
    fn index_padding() {
        assert_eq!(render("{index}"), "7");
        assert_eq!(render("{index:3}"), "007");
        assert_eq!(render("{index:03}"), "007");
        assert_eq!(render("{index:5}"), "00007");
    }

    #[test]
    fn date_format() {
        // 本地时区可能不同，只校验格式长度
        let d = render("{date}");
        assert_eq!(d.len(), 8, "默认应为 YYYYMMDD，实际 {d}");
        let t = render("{date:%Y-%m-%d}");
        assert_eq!(t.len(), 10, "实际 {t}");
    }

    #[test]
    fn modifiers_chain_left_to_right() {
        assert_eq!(render("{name|lower}"), "my photo");
        assert_eq!(render("{name|lower|replace: :_}"), "my_photo");
        assert_eq!(render("{name|slug}"), "my-photo");
        assert_eq!(render("{name|substr:0:2}"), "My");
        assert_eq!(render("{name|substr:-5:5}"), "Photo");
        assert_eq!(render("{name|capitalize}"), "My Photo");
    }

    #[test]
    fn default_modifier_on_empty() {
        let empty = RenderCtx {
            stem: "",
            ..ctx()
        };
        let t = parse("{name|default:untitled}").unwrap();
        assert_eq!(t.render(&empty), "untitled");
    }

    #[test]
    fn brace_escape() {
        assert_eq!(render("{{name}}"), "{name}");
        assert_eq!(render("a}}b"), "a}b");
    }

    #[test]
    fn uses_ext_flag() {
        assert!(parse("{name}.{ext}").unwrap().uses_ext);
        assert!(!parse("{name}").unwrap().uses_ext);
    }

    #[test]
    fn errors() {
        assert_eq!(parse("{name"), Err(TemplateError::UnclosedBrace));
        assert_eq!(parse("a}b"), Err(TemplateError::UnclosedBrace));
        assert_eq!(parse("{}"), Err(TemplateError::EmptyField));
        assert_eq!(
            parse("{nope}"),
            Err(TemplateError::UnknownField("nope".into()))
        );
        assert_eq!(
            parse("{name|wat}"),
            Err(TemplateError::UnknownModifier("wat".into()))
        );
        assert!(matches!(
            parse("{name|substr:x:2}"),
            Err(TemplateError::BadModifierArg(_))
        ));
    }

    #[test]
    fn unicode_safe_slicing() {
        // 多字节字符不能被切开
        assert_eq!(render("{name|substr:0:2}").chars().count(), 2);
        let t = parse("前缀-{name|lower}").unwrap();
        assert_eq!(t.render(&ctx()), "前缀-my photo");
    }

    #[test]
    fn media_fields() {
        let m = MediaMeta {
            title: "夜曲".into(),
            artist: "周杰伦".into(),
            album: "十一月的萧邦".into(),
            track: "3".into(),
            duration_ms: 225_000,
            width: 1920,
            height: 1080,
        };
        let c = media_ctx(&m);
        assert_eq!(parse("{artist}-{title}").unwrap().render(&c), "周杰伦-夜曲");
        assert_eq!(parse("{album}|{track}").unwrap().render(&c), "十一月的萧邦|3");
        assert_eq!(parse("{duration}").unwrap().render(&c), "225");
        assert_eq!(parse("{duration:clock}").unwrap().render(&c), "03-45");
        assert_eq!(parse("{width}x{height}").unwrap().render(&c), "1920x1080");
    }

    #[test]
    fn media_fields_empty_without_tags() {
        // 没开标签读取 / 文件没有标签：占位符渲染成空串，靠 |default 兜底
        assert_eq!(render("{title}"), "");
        assert_eq!(render("{duration:clock}"), "");
        assert_eq!(render("{title|default:未命名}"), "未命名");
    }

    #[test]
    fn pinyin_modifier_makes_ascii() {
        assert_eq!(render("{name|pinyin}"), "my photo");
        let cn = RenderCtx {
            stem: "张伟的照片",
            ..ctx()
        };
        assert_eq!(parse("{name|pinyin}").unwrap().render(&cn), "zhangweidezhaopian");
        // 转完还能继续串其它修饰符
        assert_eq!(
            parse("{name|pinyin|replace: :_}").unwrap().render(&cn),
            "zhangweidezhaopian"
        );
    }

    #[test]
    fn long_duration_keeps_hours() {
        let m = MediaMeta {
            duration_ms: 3_930_000, // 1:05:30
            ..Default::default()
        };
        assert_eq!(parse("{duration:clock}").unwrap().render(&media_ctx(&m)), "1-05-30");
    }
}
