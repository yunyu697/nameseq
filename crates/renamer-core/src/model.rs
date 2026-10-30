use serde::{Deserialize, Serialize};

/// 从文件里读出来的媒体信息。
///
/// 全部是「尽力而为」：读不到就是空串 / 0，不报错——批量改名时某个文件没标签，
/// 不应该让整条规则链算不出结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 音轨号，可能带总数（如 "3/12"）
    pub track: String,
    /// 时长，毫秒；拿不到为 0
    pub duration_ms: u64,
    /// 视频 / 图片宽度，拿不到为 0
    pub width: u32,
    pub height: u32,
}

impl MediaMeta {
    pub fn is_empty(&self) -> bool {
        self.title.is_empty()
            && self.artist.is_empty()
            && self.album.is_empty()
            && self.track.is_empty()
            && self.duration_ms == 0
            && self.width == 0
            && self.height == 0
    }
}

/// 扫描得到的一个文件（或目录）条目。
///
/// 注意：`name` / `stem` / `ext` 全部已经做过 NFC 归一化，
/// 前端拿到的字符串可以直接比较，不会出现 macOS 的 NFD 与 Windows 的 NFC 打架。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: u64,
    /// 完整绝对路径
    pub path: String,
    /// 所在目录
    pub dir: String,
    /// 不含扩展名的主名
    pub stem: String,
    /// 扩展名，不含点；无扩展名为空串
    pub ext: String,
    /// 完整文件名
    pub name: String,
    pub size: u64,
    /// 修改时间，Unix 毫秒
    pub modified_ms: i64,
    pub is_dir: bool,
    /// 读取元数据时的错误，不阻塞其它文件
    pub error: Option<String>,
    /// 音视频 / 图片标签，只有开启「读取媒体标签」时才填
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaMeta>,
}

/// 单条改名操作的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpStatus {
    /// 可以执行
    Ok,
    /// 新名与旧名完全相同，跳过
    Unchanged,
    /// 与批次内其它目标重名，或目标已存在于磁盘
    Conflict,
    /// 文件名本身非法（非法字符、保留名、超长等）
    Invalid,
    /// 执行时源文件已不存在或已被修改
    Missing,
    /// 用户手动取消勾选
    Excluded,
}

impl OpStatus {
    pub fn is_executable(self) -> bool {
        matches!(self, OpStatus::Ok)
    }

    pub fn label(self) -> &'static str {
        match self {
            OpStatus::Ok => "可执行",
            OpStatus::Unchanged => "无需改名",
            OpStatus::Conflict => "冲突",
            OpStatus::Invalid => "非法",
            OpStatus::Missing => "源已变化",
            OpStatus::Excluded => "已排除",
        }
    }
}

/// 一条改名计划。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOp {
    pub id: u64,
    pub from: String,
    pub to: String,
    pub old_name: String,
    pub new_name: String,
    pub status: OpStatus,
    pub reason: Option<String>,
    /// 这一条改的是目录而不是文件
    #[serde(default)]
    pub is_dir: bool,
    /// 规划时记录的元数据，执行前用来检测「文件在预览期间被改动」
    pub size: u64,
    pub modified_ms: i64,
}
