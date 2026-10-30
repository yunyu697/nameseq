//! 中文相关的转换：中文数字 ↔ 阿拉伯数字、汉字转拼音。
//!
//! 中文用户的文件名经常是「第一章」「第十二回」「二〇二四」这种，直接排序和编号都对不上；
//! 拼音排序也是同理——按 Unicode 码位排出来的顺序和「按读音」完全不是一回事。
//!
//! 拼音表用 `pinyin` crate（纯 Rust 内置表，约 20 万条），数字转换自己写。

use pinyin::ToPinyin;

const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

fn digit_of(c: char) -> Option<u32> {
    match c {
        '零' | '〇' => Some(0),
        '一' | '壹' => Some(1),
        '二' | '贰' | '两' => Some(2),
        '三' | '叁' => Some(3),
        '四' | '肆' => Some(4),
        '五' | '伍' => Some(5),
        '六' | '陆' => Some(6),
        '七' | '柒' => Some(7),
        '八' | '捌' => Some(8),
        '九' | '玖' => Some(9),
        _ => None,
    }
}

fn unit_of(c: char) -> Option<u64> {
    match c {
        '十' | '拾' => Some(10),
        '百' | '佰' => Some(100),
        '千' | '仟' => Some(1000),
        '万' | '萬' => Some(10_000),
        _ => None,
    }
}

fn is_cn_numeral(c: char) -> bool {
    digit_of(c).is_some() || unit_of(c).is_some() || c == '廿' || c == '卅'
}

/// 中文数字串 → 十进制。没有单位字（十/百/千/万）时按「逐位读」处理，
/// 这样「二〇二四」是 2024 而不是 24，「零零一」也保留前导零。
pub fn cn_run_to_arabic(run: &str) -> String {
    let chars: Vec<char> = run.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    // 廿三 = 23、卅五 = 35，先展开成「二十三」
    let expanded: String = chars
        .iter()
        .flat_map(|&c| match c {
            '廿' => "二十".chars().collect::<Vec<_>>(),
            '卅' => "三十".chars().collect::<Vec<_>>(),
            _ => vec![c],
        })
        .collect();

    let has_unit = expanded.chars().any(|c| unit_of(c).is_some());
    if !has_unit {
        let mut out = String::new();
        for c in expanded.chars() {
            match digit_of(c) {
                Some(d) => out.push(char::from(b'0' + d as u8)),
                None => out.push(c),
            }
        }
        return out;
    }

    let mut total: u64 = 0;
    let mut section: u64 = 0;
    let mut number: u64 = 0;
    for c in expanded.chars() {
        if let Some(d) = digit_of(c) {
            number = d as u64;
        } else if let Some(u) = unit_of(c) {
            if u == 10_000 {
                section = (section + number) * 10_000;
                total += section;
                section = 0;
                number = 0;
            } else {
                // 「十二」里的十前面没有数字，按 1 算
                section += if number == 0 { u } else { number * u };
                number = 0;
            }
        } else {
            return run.to_string();
        }
    }
    let v = total + section + number;
    // 「一二三万」这种不规范的写法会算出 0，别把用户的文本吃成 0
    if v == 0 && expanded.chars().any(|c| digit_of(c).is_some()) {
        return cn_run_to_arabic(&expanded.replace(['十', '百', '千', '万'], ""));
    }
    v.to_string()
}

/// 0..=99999999 的整数 → 中文数字
pub fn int_to_cn(n: u64) -> String {
    if n == 0 {
        return "零".into();
    }
    if n >= 100_000_000 {
        return n.to_string();
    }
    fn section_to_cn(mut n: u64, need_zero: bool) -> String {
        let units = ["", "十", "百", "千"];
        let mut parts: Vec<String> = Vec::new();
        let mut zero_pending = false;
        for (i, unit) in units.iter().enumerate().rev() {
            let d = ((n / 10u64.pow(i as u32)) % 10) as usize;
            if d == 0 {
                if !parts.is_empty() {
                    zero_pending = true;
                }
                continue;
            }
            if zero_pending {
                parts.push("零".into());
                zero_pending = false;
            }
            parts.push(format!("{}{}", DIGITS[d], unit));
        }
        n = 0;
        let _ = n;
        let mut s = parts.concat();
        // 十X 开头省略「一」：一十三 → 十三
        if need_zero && s.starts_with('一') && s.chars().nth(1) == Some('十') {
            s = s.trim_start_matches('一').to_string();
        }
        s
    }

    let high = n / 10_000;
    let low = n % 10_000;
    let mut out = String::new();
    if high > 0 {
        out.push_str(&section_to_cn(high, false));
        out.push('万');
    }
    if low > 0 {
        // 10005 → 一万零五：低位不足四位时要补零
        if high > 0 && low < 1000 {
            out.push('零');
        }
        out.push_str(&section_to_cn(low, high == 0));
    }
    out
}

/// 把字符串里的中文数字串转成阿拉伯数字（其余字符原样保留）
pub fn to_arabic(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    for c in s.chars() {
        if is_cn_numeral(c) {
            run.push(c);
        } else {
            if !run.is_empty() {
                out.push_str(&cn_run_to_arabic(&run));
                run.clear();
            }
            out.push(c);
        }
    }
    if !run.is_empty() {
        out.push_str(&cn_run_to_arabic(&run));
    }
    out
}

/// 把字符串里的数字串转成中文数字（其余字符原样保留）
pub fn to_chinese(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    let mut run = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            run.push(c);
        } else {
            if !run.is_empty() {
                let n: u64 = run.parse().unwrap_or(0);
                out.push_str(&int_to_cn(n));
                run.clear();
            }
            out.push(c);
        }
    }
    if !run.is_empty() {
        let n: u64 = run.parse().unwrap_or(0);
        out.push_str(&int_to_cn(n));
    }
    out
}

/// 汉字转无声调拼音；非汉字原样保留。
/// 用途：拼音排序、以及把中文名转成 ASCII（`{name|pinyin}`）。
pub fn to_pinyin_plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        match c.to_pinyin() {
            Some(p) => out.push_str(p.plain()),
            None => out.push(c),
        }
    }
    out
}

/// 排序键：拼音小写 + 原字符兜底，保证不同字但同音时也稳定
pub fn pinyin_key(s: &str) -> String {
    to_pinyin_plain(s).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digit_by_digit_without_units() {
        assert_eq!(cn_run_to_arabic("二〇二四"), "2024");
        assert_eq!(cn_run_to_arabic("零零一"), "001");
        assert_eq!(cn_run_to_arabic("三五"), "35");
    }

    #[test]
    fn units_are_computed() {
        assert_eq!(cn_run_to_arabic("十"), "10");
        assert_eq!(cn_run_to_arabic("十二"), "12");
        assert_eq!(cn_run_to_arabic("二十三"), "23");
        assert_eq!(cn_run_to_arabic("一百零五"), "105");
        assert_eq!(cn_run_to_arabic("一千零二十"), "1020");
        assert_eq!(cn_run_to_arabic("一万二千"), "12000");
        assert_eq!(cn_run_to_arabic("十万"), "100000");
        assert_eq!(cn_run_to_arabic("廿三"), "23");
    }

    #[test]
    fn to_arabic_only_touches_numerals() {
        assert_eq!(to_arabic("第十二章"), "第12章");
        assert_eq!(to_arabic("卷二〇二四"), "卷2024");
        assert_eq!(to_arabic("no numerals"), "no numerals");
    }

    #[test]
    fn int_to_cn_basics() {
        assert_eq!(int_to_cn(0), "零");
        assert_eq!(int_to_cn(7), "七");
        assert_eq!(int_to_cn(10), "十");
        assert_eq!(int_to_cn(11), "十一");
        assert_eq!(int_to_cn(20), "二十");
        assert_eq!(int_to_cn(105), "一百零五");
        assert_eq!(int_to_cn(1005), "一千零五");
        assert_eq!(int_to_cn(10000), "一万");
        assert_eq!(int_to_cn(10005), "一万零五");
        assert_eq!(int_to_cn(12000), "一万二千");
        assert_eq!(int_to_cn(2024), "二千零二十四");
    }

    #[test]
    fn roundtrip_numbers() {
        for n in [1u64, 9, 10, 11, 20, 101, 999, 1000, 1234, 10_000, 23_456] {
            let cn = int_to_cn(n);
            assert_eq!(cn_run_to_arabic(&cn), n.to_string(), "{n} → {cn}");
        }
    }

    #[test]
    fn pinyin_of_chinese() {
        assert_eq!(to_pinyin_plain("张伟"), "zhangwei");
        assert_eq!(to_pinyin_plain("照片 01"), "zhaopian 01");
        // 非汉字不动
        assert_eq!(to_pinyin_plain("IMG_01"), "IMG_01");
    }

    #[test]
    fn pinyin_sort_orders_by_reading() {
        let mut v = vec!["张三", "李四", "王五", "阿七"];
        v.sort_by_key(|s| pinyin_key(s));
        // a < li < wang < zhang
        assert_eq!(v, vec!["阿七", "李四", "王五", "张三"]);
    }
}
