//! 文件名合法性校验。
//!
//! 这里的规则**始终按 Windows 最严格的那一套来判**，即使当前跑在 Linux 上。
//! 理由：批量改名工具产出的名字经常会通过网盘、U 盘、压缩包跨平台流转，
//! 在 Linux 上能建出来的 `a:b.txt` 到了 Windows 就打不开。宁可提前拦住。

use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// 归一化到 NFC。
///
/// macOS 的 HFS+/APFS 返回的是 NFD（`é` = `e` + U+0301），Windows 是 NFC（`é` = U+00E9）。
/// 两者肉眼完全一样但字节不同，直接比较会得出「没变化」或「重名」的错误结论。
pub fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// 用于「是否重名」比较的归一化键：NFC + 小写折叠。
pub fn fold(s: &str) -> String {
    nfc(s).to_lowercase()
}

/// 当前平台的文件系统是否大小写不敏感（Windows / macOS 默认是）。
pub fn is_case_insensitive() -> bool {
    cfg!(any(windows, target_os = "macos"))
}

const INVALID_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验文件名主干（不含扩展名）。返回 `Some(原因)` 表示非法。
pub fn check_stem(stem: &str) -> Option<String> {
    if stem.is_empty() {
        return Some("文件名为空".into());
    }
    if stem == "." || stem == ".." {
        return Some("不能使用 . 或 ..".into());
    }
    if let Some(c) = stem.chars().find(|c| INVALID_CHARS.contains(c)) {
        return Some(format!("包含非法字符 {c}"));
    }
    if let Some(c) = stem.chars().find(|c| (*c as u32) < 0x20) {
        return Some(format!("包含控制字符 U+{:04X}", c as u32));
    }
    if stem.ends_with(' ') || stem.ends_with('.') {
        return Some("不能以空格或点结尾".into());
    }
    // 保留名判断要忽略扩展名：`CON.txt` 同样非法
    let head = stem.split('.').next().unwrap_or(stem).to_uppercase();
    if RESERVED.contains(&head.as_str()) {
        return Some(format!("{head} 是系统保留名"));
    }
    if stem.len() > 255 {
        return Some("文件名超过 255 字节".into());
    }
    None
}

/// 校验完整目标路径。返回 `Some(原因)` 表示有问题。
pub fn check_path(path: &Path) -> Option<String> {
    let s = path.to_string_lossy();
    // Windows 传统上限 260 个字符，除非启用长路径或加了 \\?\ 前缀
    if cfg!(windows) && s.len() > 260 && !s.starts_with(r"\\?\") {
        return Some(format!("完整路径 {} 字符，超过 Windows 260 限制", s.len()));
    }
    if s.len() > 4096 {
        return Some("路径过长".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfc_merges_decomposed() {
        // e + 组合尖音符  vs  预组合的 é
        let decomposed = "cafe\u{0301}";
        let composed = "caf\u{00e9}";
        assert_ne!(decomposed, composed);
        assert_eq!(nfc(decomposed), nfc(composed));
        assert_eq!(fold(decomposed), fold(composed));
    }

    #[test]
    fn rejects_windows_invalid_chars() {
        assert!(check_stem("a:b").is_some());
        assert!(check_stem("a?b").is_some());
        assert!(check_stem("a/b").is_some());
        assert!(check_stem("normal name").is_none());
    }

    #[test]
    fn rejects_reserved_names_with_extension() {
        assert!(check_stem("CON").is_some());
        assert!(check_stem("con.txt").is_some());
        assert!(check_stem("console").is_none());
        assert!(check_stem("COM1").is_some());
        assert!(check_stem("COM10").is_none());
    }

    #[test]
    fn rejects_trailing_dot_or_space() {
        assert!(check_stem("abc.").is_some());
        assert!(check_stem("abc ").is_some());
        assert!(check_stem("abc").is_none());
    }

    #[test]
    fn rejects_empty_and_dots() {
        assert!(check_stem("").is_some());
        assert!(check_stem(".").is_some());
        assert!(check_stem("..").is_some());
    }
}
