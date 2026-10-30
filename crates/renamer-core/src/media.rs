//! 音视频 / 图片元数据读取。
//!
//! 只用标准库手写解析，不引入额外依赖：格式化规则很稳定，而依赖一多，
//! 打包体积和跨平台编译都会跟着变复杂。
//!
//! 覆盖范围（都是「读不到就留空」，绝不报错中断）：
//! - MP3：ID3v2.2/2.3/2.4 的 TIT2/TPE1/TALB/TRCK，读不到再退到 ID3v1
//! - FLAC：STREAMINFO 取样率与总采样数算时长，VORBIS_COMMENT 取标签
//! - MP4 / M4A / MOV：mvhd 算时长、tkhd 取分辨率、ilst 取标签
//! - JPEG / PNG：分辨率
//!
//! 完全不碰视频像素数据，只读文件头和元数据盒，几百 MB 的视频也是毫秒级。

use crate::model::MediaMeta;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 按扩展名分派。返回 `None` 表示「这个文件没有可用的元数据」。
pub fn read(path: &Path) -> Option<MediaMeta> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let mut meta = MediaMeta::default();
    match ext.as_str() {
        "mp3" => read_mp3(path, &mut meta),
        "flac" => read_flac(path, &mut meta),
        "mp4" | "m4a" | "m4v" | "mov" | "3gp" => read_mp4(path, &mut meta),
        "jpg" | "jpeg" => read_jpeg(path, &mut meta),
        "png" => read_png(path, &mut meta),
        _ => return None,
    }
    if meta.is_empty() {
        None
    } else {
        Some(meta)
    }
}

/* ---------------- MP3 / ID3 ---------------- */

fn read_mp3(path: &Path, meta: &mut MediaMeta) {
    let Ok(mut f) = File::open(path) else { return };

    let mut head = [0u8; 10];
    if f.read_exact(&mut head).is_ok() && &head[0..3] == b"ID3" {
        let major = head[3];
        let flags = head[5];
        let size = syncsafe(&head[6..10]) as usize;
        // 防御：标签声明的大小不能离谱
        if size > 0 && size < 32 * 1024 * 1024 {
            let mut buf = vec![0u8; size];
            if f.read_exact(&mut buf).is_ok() {
                parse_id3_frames(&buf, major, flags, meta);
            }
        }
    }

    if meta.title.is_empty() && meta.artist.is_empty() && meta.album.is_empty() {
        read_id3v1(path, meta);
    }
}

/// ID3 的大小字段是「同步安全整数」：每字节只用低 7 位。
fn syncsafe(b: &[u8]) -> u32 {
    ((b[0] as u32 & 0x7f) << 21)
        | ((b[1] as u32 & 0x7f) << 14)
        | ((b[2] as u32 & 0x7f) << 7)
        | (b[3] as u32 & 0x7f)
}

fn parse_id3_frames(buf: &[u8], major: u8, flags: u8, meta: &mut MediaMeta) {
    let id_len = if major == 2 { 3 } else { 4 };
    let head_len = if major == 2 { 6 } else { 10 };
    let mut i = 0usize;

    // v2.3/2.4 的扩展头要跳过。注意标志位在 ID3 头里（flags & 0x40），
    // 不在帧正文里——拿正文前两字节当标志会误判成扩展头，直接读不到任何帧。
    if major >= 3 && flags & 0x40 != 0 && buf.len() >= 4 {
        let ext = if major == 4 {
            syncsafe(&buf[0..4]) as usize
        } else {
            be32(&buf[0..4]) as usize
        };
        i = (4 + ext).min(buf.len());
    }

    while i + head_len <= buf.len() {
        let id = &buf[i..i + id_len];
        if id[0] == 0 {
            break; // 填充区，后面不会再有帧
        }
        let (size, body_at) = if major == 2 {
            (
                ((buf[i + 3] as usize) << 16) | ((buf[i + 4] as usize) << 8) | buf[i + 5] as usize,
                i + 6,
            )
        } else if major == 4 {
            (syncsafe(&buf[i + 4..i + 8]) as usize, i + 10)
        } else {
            (be32(&buf[i + 4..i + 8]) as usize, i + 10)
        };
        if size == 0 || body_at + size > buf.len() {
            break;
        }
        let body = &buf[body_at..body_at + size];
        let text = decode_text(body);
        match id {
            b"TIT2" | b"TT2" => meta.title = text,
            b"TPE1" | b"TP1" => meta.artist = text,
            b"TALB" | b"TAL" => meta.album = text,
            b"TRCK" | b"TRK" => meta.track = text,
            _ => {}
        }
        i = body_at + size;
    }
}

/// ID3 文本帧：第 1 字节是编码，后面才是内容。
fn decode_text(body: &[u8]) -> String {
    if body.is_empty() {
        return String::new();
    }
    let enc = body[0];
    let raw = &body[1..];
    let s = match enc {
        1 => decode_utf16(raw),
        2 => decode_utf16_be(raw),
        3 => String::from_utf8_lossy(raw).to_string(),
        _ => raw.iter().map(|&b| b as char).collect(),
    };
    // 多值（如 "A/B"）只取第一个，避免把斜杠带进文件名
    let s = s.replace('\0', "");
    s.trim().to_string()
}

fn decode_utf16(b: &[u8]) -> String {
    if b.len() < 2 {
        return String::new();
    }
    // 有 BOM 按 BOM 来，没有就按规范默认大端
    let (le, start) = match (b[0], b[1]) {
        (0xFF, 0xFE) => (true, 2),
        (0xFE, 0xFF) => (false, 2),
        _ => (false, 0),
    };
    let units: Vec<u16> = b[start..]
        .chunks_exact(2)
        .map(|c| {
            if le {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

fn decode_utf16_be(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

fn read_id3v1(path: &Path, meta: &mut MediaMeta) {
    let Ok(mut f) = File::open(path) else { return };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return;
    };
    if len < 128 {
        return;
    }
    if f.seek(SeekFrom::End(-128)).is_err() {
        return;
    }
    let mut b = [0u8; 128];
    if f.read_exact(&mut b).is_err() || &b[0..3] != b"TAG" {
        return;
    }
    let field = |s: &[u8]| -> String {
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf8_lossy(&s[..end]).trim().to_string()
    };
    meta.title = field(&b[3..33]);
    meta.artist = field(&b[33..63]);
    meta.album = field(&b[63..93]);
    // ID3v1.1：注释第 29 字节为 0 且第 30 字节非 0 时，最后一位是音轨号
    if b[125] == 0 && b[126] != 0 {
        meta.track = b[126].to_string();
    }
}

/* ---------------- FLAC ---------------- */

fn read_flac(path: &Path, meta: &mut MediaMeta) {
    let Ok(mut f) = File::open(path) else { return };
    let mut sig = [0u8; 4];
    if f.read_exact(&mut sig).is_err() || &sig != b"fLaC" {
        return;
    }
    let mut sample_rate = 0u32;
    let mut total_samples = 0u64;

    for _ in 0..64 {
        let mut h = [0u8; 4];
        if f.read_exact(&mut h).is_err() {
            break;
        }
        let last = h[0] & 0x80 != 0;
        let kind = h[0] & 0x7f;
        let size = ((h[1] as usize) << 16) | ((h[2] as usize) << 8) | h[3] as usize;
        if size > 16 * 1024 * 1024 {
            break;
        }
        let mut body = vec![0u8; size];
        if f.read_exact(&mut body).is_err() {
            break;
        }
        match kind {
            0 if body.len() >= 18 => {
                // STREAMINFO：取样率占 20 位，总采样数占 36 位
                let b = &body;
                sample_rate = ((b[10] as u32) << 12) | ((b[11] as u32) << 4) | (b[12] as u32 >> 4);
                total_samples = (((b[13] & 0x0f) as u64) << 32)
                    | ((b[14] as u64) << 24)
                    | ((b[15] as u64) << 16)
                    | ((b[16] as u64) << 8)
                    | b[17] as u64;
            }
            4 => parse_vorbis_comment(&body, meta),
            _ => {}
        }
        if last {
            break;
        }
    }

    if sample_rate > 0 && total_samples > 0 {
        meta.duration_ms = total_samples * 1000 / sample_rate as u64;
    }
}

fn parse_vorbis_comment(body: &[u8], meta: &mut MediaMeta) {
    if body.len() < 8 {
        return;
    }
    let vendor = le32(&body[0..4]) as usize;
    let count_at = 4 + vendor;
    if count_at + 4 > body.len() {
        return;
    }
    let count = le32(&body[count_at..count_at + 4]) as usize;
    let mut i = count_at + 4;
    for _ in 0..count.min(512) {
        if i + 4 > body.len() {
            break;
        }
        let len = le32(&body[i..i + 4]) as usize;
        i += 4;
        if i + len > body.len() {
            break;
        }
        let kv = String::from_utf8_lossy(&body[i..i + len]).to_string();
        i += len;
        if let Some((k, v)) = kv.split_once('=') {
            match k.to_ascii_uppercase().as_str() {
                "TITLE" if meta.title.is_empty() => meta.title = v.trim().to_string(),
                "ARTIST" if meta.artist.is_empty() => meta.artist = v.trim().to_string(),
                "ALBUM" if meta.album.is_empty() => meta.album = v.trim().to_string(),
                "TRACKNUMBER" if meta.track.is_empty() => meta.track = v.trim().to_string(),
                _ => {}
            }
        }
    }
}

/* ---------------- MP4 / M4A / MOV ---------------- */

fn read_mp4(path: &Path, meta: &mut MediaMeta) {
    let Ok(mut f) = File::open(path) else { return };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return;
    };
    walk_mp4(&mut f, 0, len, 0, meta);
}

/// 递归走 moov 里的盒子。视频文件的 moov 可能在文件尾，所以必须按偏移读，
/// 不能「把文件读进内存」——那边一下就几百 MB。
fn walk_mp4(f: &mut File, start: u64, end: u64, depth: u8, meta: &mut MediaMeta) {
    if depth > 6 {
        return;
    }
    let mut pos = start;
    while pos + 8 <= end {
        if f.seek(SeekFrom::Start(pos)).is_err() {
            return;
        }
        let mut h = [0u8; 8];
        if f.read_exact(&mut h).is_err() {
            return;
        }
        let mut size = be32(&h[0..4]) as u64;
        let kind = [h[4], h[5], h[6], h[7]];
        let mut head = 8u64;
        if size == 1 {
            let mut ext = [0u8; 8];
            if f.read_exact(&mut ext).is_err() {
                return;
            }
            size = be64(&ext);
            head = 16;
        } else if size == 0 {
            size = end - pos;
        }
        if size < head || pos + size > end {
            return;
        }
        let body = pos + head;
        let body_end = pos + size;

        match &kind {
            b"moov" | b"trak" | b"udta" | b"ilst" => walk_mp4(f, body, body_end, depth + 1, meta),
            // meta 是 full box，前面多 4 字节版本号
            b"meta" => walk_mp4(f, body + 4, body_end, depth + 1, meta),
            b"mvhd" => read_mvhd(f, body, meta),
            b"tkhd" => read_tkhd(f, body, meta),
            b"data" => {} // 由 ilst 的父级处理
            _ => {
                // ilst 里的条目：©nam / ©ART / ©alb / trkn ……
                // 这些盒子的 body 里只有一个 data 盒，直接按标签名归位
                if depth >= 3 && is_ilst_tag(&kind) {
                    read_ilst_item(f, &kind, body, body_end, meta);
                }
            }
        }
        pos = body_end;
    }
}

fn is_ilst_tag(k: &[u8]) -> bool {
    matches!(
        k,
        b"\xa9nam" | b"\xa9ART" | b"\xa9alb" | b"trkn" | b"\xa9day" | b"aART"
    )
}

fn read_ilst_item(f: &mut File, tag: &[u8], start: u64, end: u64, meta: &mut MediaMeta) {
    let mut pos = start;
    while pos + 8 <= end {
        if f.seek(SeekFrom::Start(pos)).is_err() {
            return;
        }
        let mut h = [0u8; 8];
        if f.read_exact(&mut h).is_err() {
            return;
        }
        let size = be32(&h[0..4]) as u64;
        if size < 8 || pos + size > end {
            return;
        }
        if &h[4..8] == b"data" && size >= 16 {
            let mut dh = [0u8; 8];
            if f.read_exact(&mut dh).is_err() {
                return;
            }
            let payload_len = (size - 16) as usize;
            let mut payload = vec![0u8; payload_len.min(4096)];
            let n = payload.len();
            if f.read_exact(&mut payload[..n]).is_err() {
                return;
            }
            match tag {
                b"trkn" => {
                    if payload.len() >= 4 {
                        let track = u16::from_be_bytes([payload[2], payload[3]]);
                        if meta.track.is_empty() && track > 0 {
                            meta.track = track.to_string();
                        }
                    }
                }
                _ => {
                    let v = String::from_utf8_lossy(&payload)
                        .trim_matches('\0')
                        .trim()
                        .to_string();
                    match tag {
                        b"\xa9nam" if meta.title.is_empty() => meta.title = v,
                        b"\xa9ART" if meta.artist.is_empty() => meta.artist = v,
                        b"\xa9alb" if meta.album.is_empty() => meta.album = v,
                        _ => {}
                    }
                }
            }
        }
        pos += size;
    }
}

fn read_mvhd(f: &mut File, body: u64, meta: &mut MediaMeta) {
    if f.seek(SeekFrom::Start(body)).is_err() {
        return;
    }
    let mut b = [0u8; 32];
    if f.read_exact(&mut b).is_err() {
        return;
    }
    let version = b[0];
    let (timescale, duration) = if version == 1 {
        (be32(&b[20..24]), be64(&b[24..32]))
    } else {
        (be32(&b[12..16]), be32(&b[16..20]) as u64)
    };
    if timescale > 0 && duration > 0 {
        meta.duration_ms = duration * 1000 / timescale as u64;
    }
}

fn read_tkhd(f: &mut File, body: u64, meta: &mut MediaMeta) {
    if f.seek(SeekFrom::Start(body)).is_err() {
        return;
    }
    let mut b = [0u8; 84];
    let Ok(()) = f.read_exact(&mut b) else { return };
    let version = b[0];
    // 宽度 / 高度是定点数 16.16，位置随版本不同
    let (w_at, h_at) = if version == 1 { (84, 88) } else { (72, 76) };
    if h_at + 4 > b.len() {
        return;
    }
    let w = be32(&b[w_at..w_at + 4]) >> 16;
    let h = be32(&b[h_at..h_at + 4]) >> 16;
    if meta.width == 0 && w > 0 {
        meta.width = w;
        meta.height = h;
    }
}

/* ---------------- 图片 ---------------- */

fn read_png(path: &Path, meta: &mut MediaMeta) {
    let Ok(mut f) = File::open(path) else { return };
    let mut b = [0u8; 24];
    if f.read_exact(&mut b).is_err() {
        return;
    }
    if &b[0..8] != b"\x89PNG\r\n\x1a\n" || &b[12..16] != b"IHDR" {
        return;
    }
    meta.width = be32(&b[16..20]);
    meta.height = be32(&b[20..24]);
}

fn read_jpeg(path: &Path, meta: &mut MediaMeta) {
    let Ok(mut f) = File::open(path) else { return };
    let mut b = [0u8; 2];
    if f.read_exact(&mut b).is_err() || b != [0xFF, 0xD8] {
        return;
    }
    // 顺着段走，遇到 SOFn 就拿到尺寸
    for _ in 0..256 {
        let mut m = [0u8; 2];
        if f.read_exact(&mut m).is_err() {
            return;
        }
        if m[0] != 0xFF {
            return;
        }
        let marker = m[1];
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue; // 无长度字段
        }
        if marker == 0xD9 || marker == 0xDA {
            return; // 图像数据开始，后面没有尺寸信息了
        }
        let mut lb = [0u8; 2];
        if f.read_exact(&mut lb).is_err() {
            return;
        }
        let seg_len = be16(&lb) as u64;
        if seg_len < 2 {
            return;
        }
        let is_sof = matches!(
            marker,
            0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF
        );
        if is_sof {
            let mut d = [0u8; 5];
            if f.read_exact(&mut d).is_err() {
                return;
            }
            meta.height = be16(&d[1..3]) as u32;
            meta.width = be16(&d[3..5]) as u32;
            return;
        }
        if f.seek(SeekFrom::Current((seg_len - 2) as i64)).is_err() {
            return;
        }
    }
}

/* ---------------- 字节序小工具 ---------------- */

fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let d =
                std::env::temp_dir().join(format!("renamer-media-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            Tmp(d)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self.0.join(name);
            fs::write(&p, bytes).unwrap();
            p
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 造一个 ID3v2.3 标签：帧大小是普通大端
    fn id3v23(frames: &[(&str, u8, Vec<u8>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (id, enc, text) in frames {
            let mut payload = vec![*enc];
            payload.extend_from_slice(text);
            body.extend_from_slice(id.as_bytes());
            body.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            body.extend_from_slice(&[0, 0]);
            body.extend_from_slice(&payload);
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"ID3");
        out.extend_from_slice(&[3, 0, 0]);
        let n = body.len() as u32;
        out.extend_from_slice(&[
            ((n >> 21) & 0x7f) as u8,
            ((n >> 14) & 0x7f) as u8,
            ((n >> 7) & 0x7f) as u8,
            (n & 0x7f) as u8,
        ]);
        out.extend_from_slice(&body);
        out
    }

    fn utf16le(s: &str) -> Vec<u8> {
        let mut v = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    #[test]
    fn reads_id3v23_utf16_frames() {
        let t = Tmp::new("id3v23");
        let bytes = id3v23(&[
            ("TIT2", 1, utf16le("夜曲")),
            ("TPE1", 1, utf16le("周杰伦")),
            ("TALB", 1, utf16le("十一月的萧邦")),
            ("TRCK", 0, b"3/12".to_vec()),
        ]);
        let p = t.write("a.mp3", &bytes);
        let m = read(&p).expect("应能读出标签");
        assert_eq!(m.title, "夜曲");
        assert_eq!(m.artist, "周杰伦");
        assert_eq!(m.album, "十一月的萧邦");
        assert_eq!(m.track, "3/12");
    }

    #[test]
    fn reads_id3v24_syncsafe_size() {
        // v2.4 帧大小是 syncsafe，用一个大于 127 字节的正文来验证
        let long = "长".repeat(80); // 240 字节 UTF-8
        let mut payload = vec![3u8];
        payload.extend_from_slice(long.as_bytes());
        let mut body = Vec::new();
        body.extend_from_slice(b"TIT2");
        let n = payload.len() as u32;
        body.extend_from_slice(&[
            ((n >> 21) & 0x7f) as u8,
            ((n >> 14) & 0x7f) as u8,
            ((n >> 7) & 0x7f) as u8,
            (n & 0x7f) as u8,
        ]);
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&payload);

        let mut out = Vec::new();
        out.extend_from_slice(b"ID3");
        out.extend_from_slice(&[4, 0, 0]);
        let bn = body.len() as u32;
        out.extend_from_slice(&[
            ((bn >> 21) & 0x7f) as u8,
            ((bn >> 14) & 0x7f) as u8,
            ((bn >> 7) & 0x7f) as u8,
            (bn & 0x7f) as u8,
        ]);
        out.extend_from_slice(&body);

        let t = Tmp::new("id3v24");
        let p = t.write("b.mp3", &out);
        let m = read(&p).unwrap();
        assert_eq!(m.title.chars().count(), 80);
    }

    #[test]
    fn falls_back_to_id3v1() {
        let mut bytes = vec![0u8; 200];
        let tag_at = 200 - 128;
        bytes[tag_at..tag_at + 3].copy_from_slice(b"TAG");
        bytes[tag_at + 3..tag_at + 3 + 5].copy_from_slice(b"Hello");
        bytes[tag_at + 33..tag_at + 33 + 6].copy_from_slice(b"Artist");
        bytes[tag_at + 125] = 0;
        bytes[tag_at + 126] = 7;

        let t = Tmp::new("id3v1");
        let p = t.write("c.mp3", &bytes);
        let m = read(&p).unwrap();
        assert_eq!(m.title, "Hello");
        assert_eq!(m.artist, "Artist");
        assert_eq!(m.track, "7");
    }

    #[test]
    fn reads_png_size() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&640u32.to_be_bytes());
        bytes.extend_from_slice(&360u32.to_be_bytes());
        let t = Tmp::new("png");
        let p = t.write("d.png", &bytes);
        let m = read(&p).unwrap();
        assert_eq!((m.width, m.height), (640, 360));
    }

    #[test]
    fn reads_jpeg_size() {
        let mut bytes = vec![0xFF, 0xD8];
        // APP0 段，长度 16
        bytes.extend_from_slice(&[0xFF, 0xE0]);
        bytes.extend_from_slice(&16u16.to_be_bytes());
        bytes.extend_from_slice(&[0u8; 14]);
        // SOF0
        bytes.extend_from_slice(&[0xFF, 0xC0]);
        bytes.extend_from_slice(&11u16.to_be_bytes());
        bytes.push(8);
        bytes.extend_from_slice(&480u16.to_be_bytes());
        bytes.extend_from_slice(&800u16.to_be_bytes());
        let t = Tmp::new("jpg");
        let p = t.write("e.jpg", &bytes);
        let m = read(&p).unwrap();
        assert_eq!((m.width, m.height), (800, 480));
    }

    /// 造一个最小 MP4：moov/mvhd(1 秒) + trak/tkhd(1920x1080) + udta/meta/ilst
    fn minimal_mp4() -> Vec<u8> {
        fn boxed(kind: &[u8], body: Vec<u8>) -> Vec<u8> {
            let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            v.extend_from_slice(kind);
            v.extend_from_slice(&body);
            v
        }
        // mvhd: version+flags(4) creation(4) modification(4) timescale(4) duration(4)
        let mut mvhd = vec![0u8; 4];
        mvhd.extend_from_slice(&[0u8; 4]);
        mvhd.extend_from_slice(&[0u8; 4]);
        mvhd.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd.extend_from_slice(&2500u32.to_be_bytes()); // duration
        mvhd.extend_from_slice(&[0u8; 80]);

        // tkhd: version0 下宽高在 72/76
        let mut tkhd = vec![0u8; 72];
        tkhd.extend_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd.extend_from_slice(&(1080u32 << 16).to_be_bytes());

        let mut data_payload = vec![0u8; 8];
        data_payload.extend_from_slice("Song".as_bytes());
        let nam_item = boxed(b"\xa9nam", boxed(b"data", data_payload));
        let ilst = boxed(b"ilst", nam_item);
        let mut meta_body = vec![0u8; 4];
        meta_body.extend_from_slice(&ilst);
        let udta = boxed(b"udta", boxed(b"meta", meta_body));

        let mut moov_body = boxed(b"mvhd", mvhd);
        moov_body.extend_from_slice(&boxed(b"trak", boxed(b"tkhd", tkhd)));
        moov_body.extend_from_slice(&udta);
        boxed(b"moov", moov_body)
    }

    #[test]
    fn reads_mp4_duration_size_and_tag() {
        let t = Tmp::new("mp4");
        let p = t.write("f.mp4", &minimal_mp4());
        let m = read(&p).expect("mp4 应能读出元数据");
        assert_eq!(m.duration_ms, 2500);
        assert_eq!((m.width, m.height), (1920, 1080));
        assert_eq!(m.title, "Song");
    }

    #[test]
    fn unknown_extension_returns_none() {
        let t = Tmp::new("none");
        let p = t.write("g.txt", b"hello");
        assert!(read(&p).is_none());
    }
}
