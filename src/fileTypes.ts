/** 文件类型分组：预设类型筛选与「常用扩展名」点选共用这一份。
    exts 全部小写；"__dir" 是文件夹的伪扩展名（FileEntry.isDir 时按它匹配）。 */
export interface FileTypeGroup {
  id: string;
  name: string;
  exts: string[];
}

export const DIR_TOKEN = "__dir";

export const FILE_TYPE_GROUPS: FileTypeGroup[] = [
  {
    id: "video",
    name: "视频",
    exts: [
      "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v",
      "mpg", "mpeg", "ts", "rmvb", "3gp", "vob",
    ],
  },
  {
    id: "audio",
    name: "音频",
    exts: [
      "mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "ape",
      "opus", "aiff", "mid", "mka",
    ],
  },
  {
    id: "image",
    name: "图片",
    exts: [
      "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic",
      "tif", "tiff", "ico", "raw", "cr2", "cr3", "nef", "arw", "dng", "psd",
    ],
  },
  {
    id: "doc",
    name: "文档",
    exts: [
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
      "md", "csv", "rtf", "odt", "ods", "epub", "mobi", "wps", "et", "dps",
    ],
  },
  {
    id: "archive",
    name: "压缩包",
    exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso", "cab"],
  },
  {
    id: "code",
    name: "代码",
    exts: [
      "js", "mjs", "ts", "tsx", "jsx", "py", "java", "c", "cpp", "h", "hpp",
      "cs", "go", "rs", "rb", "php", "html", "htm", "css", "scss", "json",
      "xml", "yml", "yaml", "toml", "sh", "bat", "ps1", "sql", "swift", "kt",
      "lua", "ini", "conf",
    ],
  },
  {
    id: "dir",
    name: "文件夹",
    exts: [DIR_TOKEN],
  },
];

/** 某个条目的「匹配键」：文件夹用伪 token，其它用小写扩展名（无扩展名 = ""） */
export function entryMatchKey(isDir: boolean, ext: string): string {
  return isDir ? DIR_TOKEN : ext.replace(/^\./, "").toLowerCase();
}

/** 扩展名属于哪个类型分组（文件夹 → dir 组） */
export function groupOfKey(key: string): FileTypeGroup | undefined {
  return FILE_TYPE_GROUPS.find((g) => g.exts.includes(key));
}

/** 从一批条目统计：每个类型组命中多少、出现了哪些扩展名 */
export function typeStats(
  entries: { isDir: boolean; ext: string }[],
): { groups: Map<string, number>; exts: Set<string> } {
  const groups = new Map<string, number>();
  const exts = new Set<string>();
  for (const e of entries) {
    const key = entryMatchKey(e.isDir, e.ext);
    exts.add(key);
    const g = groupOfKey(key);
    if (g) groups.set(g.id, (groups.get(g.id) ?? 0) + 1);
  }
  return { groups, exts };
}
