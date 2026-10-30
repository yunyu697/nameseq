//! 目录扫描。
//!
//! 递归模式用 jwalk 做多线程遍历，非递归模式直接 read_dir。
//! 默认跳过符号链接（避免跟随链接造成无限循环，也避免改到别处的文件）。

use crate::model::FileEntry;
use crate::validate;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub recursive: bool,
    pub include_dirs: bool,
    pub include_hidden: bool,
    /// 读 MP3/FLAC/MP4/图片的标签与分辨率（有 I/O 成本，默认关）
    pub read_media: bool,
    /// 把传入的目录本身当成一个可改名条目（而不是展开里面的内容）
    pub dir_roots_as_entries: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            recursive: false,
            include_dirs: false,
            include_hidden: true,
            read_media: false,
            dir_roots_as_entries: false,
        }
    }
}

/// 扫描一批路径（文件或目录），返回去重后的条目。
///
/// 单个文件读不到元数据不会中断整体，错误会挂在条目的 `error` 字段上。
pub fn scan(paths: &[PathBuf], opts: &ScanOptions) -> Vec<FileEntry> {
    let mut out: Vec<FileEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut next_id: u64 = 1;

    for root in paths {
        if !root.exists() {
            continue;
        }
        if root.is_file() {
            if let Some(e) = make_entry(root, next_id, &mut seen, opts) {
                next_id += 1;
                out.push(e);
            }
            continue;
        }
        if !root.is_dir() {
            continue;
        }

        // 「加入文件夹自身」：不展开内容，只把这一层目录当成条目
        if opts.dir_roots_as_entries {
            if let Some(e) = make_entry(root, next_id, &mut seen, opts) {
                next_id += 1;
                out.push(e);
            }
            continue;
        }

        if opts.recursive {
            let walker = jwalk::WalkDir::new(root)
                .skip_hidden(!opts.include_hidden)
                .follow_links(false);
            for item in walker.into_iter() {
                let Ok(entry) = item else { continue };
                if entry.depth() == 0 {
                    continue;
                }
                let ft = entry.file_type();
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() && !opts.include_dirs {
                    continue;
                }
                let p = entry.path();
                if is_temp_name(&p) {
                    continue;
                }
                if let Some(e) = make_entry(&p, next_id, &mut seen, opts) {
                    next_id += 1;
                    out.push(e);
                }
            }
        } else {
            let Ok(rd) = std::fs::read_dir(root) else {
                continue;
            };
            for item in rd.flatten() {
                let p = item.path();
                let Ok(ft) = item.file_type() else { continue };
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() && !opts.include_dirs {
                    continue;
                }
                if !opts.include_hidden && is_hidden(&p) {
                    continue;
                }
                if is_temp_name(&p) {
                    continue;
                }
                if let Some(e) = make_entry(&p, next_id, &mut seen, opts) {
                    next_id += 1;
                    out.push(e);
                }
            }
        }
    }
    out
}

/// 改名过程用的临时名（`.rnm-<batch>-<i>`）。
///
/// 崩溃后可能残留在目录里，绝不能让它们出现在文件列表里被用户再改一次名字。
fn is_temp_name(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with(".rnm-"))
        .unwrap_or(false)
}

fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

fn make_entry(
    path: &Path,
    id: u64,
    seen: &mut HashSet<String>,
    opts: &ScanOptions,
) -> Option<FileEntry> {
    // 同一路径被拖进来两次时去重
    let key = validate::fold(&path.to_string_lossy());
    if !seen.insert(key) {
        return None;
    }

    let raw_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = validate::nfc(&raw_name);

    let meta = std::fs::metadata(path);
    let (size, modified_ms, is_dir, error) = match &meta {
        Ok(m) => {
            let ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            (m.len(), ms, m.is_dir(), None)
        }
        Err(e) => (0, 0, false, Some(e.to_string())),
    };

    // 目录没有扩展名：不能按 Path::extension 拆，否则 "v1.2" 这种目录名会被拆成 stem+ext，
    // 改名后变成 "v1.2.2" 之类莫名其妙的形状
    let (stem, ext) = if is_dir {
        (name.clone(), String::new())
    } else {
        let ext = path
            .extension()
            .map(|e| validate::nfc(&e.to_string_lossy()))
            .unwrap_or_default();
        let stem = if ext.is_empty() {
            name.clone()
        } else {
            match name.rsplit_once('.') {
                Some((s, _)) => s.to_string(),
                None => name.clone(),
            }
        };
        (stem, ext)
    };

    let dir = path
        .parent()
        .map(|p| validate::nfc(&p.to_string_lossy()))
        .unwrap_or_default();

    let media = if opts.read_media && !is_dir {
        crate::media::read(path)
    } else {
        None
    };

    Some(FileEntry {
        id,
        path: validate::nfc(&path.to_string_lossy()),
        dir,
        stem,
        ext,
        name,
        size,
        modified_ms,
        is_dir,
        error,
        media,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("renamer-scan-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn scans_flat_and_dedups() {
        let d = tmpdir("flat");
        fs::write(d.join("a.txt"), b"1").unwrap();
        fs::write(d.join("b.jpg"), b"22").unwrap();
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub").join("c.txt"), b"333").unwrap();

        let flat = scan(&[d.clone()], &ScanOptions::default());
        assert_eq!(flat.len(), 2, "非递归只应看到 2 个文件");
        assert!(flat.iter().all(|e| !e.is_dir));

        // 重复传入同一目录不应产生重复条目
        let dup = scan(&[d.clone(), d.clone()], &ScanOptions::default());
        assert_eq!(dup.len(), 2);
    }

    #[test]
    fn recursive_sees_nested() {
        let d = tmpdir("rec");
        fs::write(d.join("a.txt"), b"1").unwrap();
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub").join("c.txt"), b"333").unwrap();

        let all = scan(
            &[d.clone()],
            &ScanOptions {
                recursive: true,
                ..Default::default()
            },
        );
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn splits_stem_and_ext() {
        let d = tmpdir("split");
        fs::write(d.join("archive.tar.gz"), b"x").unwrap();
        let r = scan(&[d.clone()], &ScanOptions::default());
        let e = r.iter().find(|e| e.name.starts_with("archive")).unwrap();
        assert_eq!(e.stem, "archive.tar");
        assert_eq!(e.ext, "gz");
    }
}
