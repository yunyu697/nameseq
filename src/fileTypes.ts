/** 文件类型分组：预设类型筛选与「常用扩展名」点选共用这一份。
    exts 全部小写；"__dir" 是文件夹的伪扩展名（FileEntry.isDir 时按它匹配）。
    一个扩展名只归入一个组（groupOfKey 取第一个命中），改分组前先查重。 */
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
      "mpg", "mpeg", "ts", "m2ts", "mts", "rm", "rmvb", "3gp", "3g2",
      "vob", "ogv", "f4v", "asf", "divx",
    ],
  },
  {
    id: "audio",
    name: "音频",
    exts: [
      "mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "ape",
      "opus", "aiff", "aif", "mid", "midi", "mka", "alac",
      "dsf", "dff", "ac3", "dts", "amr", "cue",
    ],
  },
  {
    id: "image",
    name: "图片",
    exts: [
      "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "svgz",
      "heic", "heif", "avif", "tif", "tiff", "ico", "jfif",
      "raw", "cr2", "cr3", "nef", "arw", "dng", "rw2", "orf", "raf", "srw",
      "tga", "ppm", "pnm",
    ],
  },
  {
    id: "doc",
    name: "文档",
    exts: [
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
      "md", "markdown", "csv", "rtf", "odt", "ods", "odp",
      "wps", "et", "dps", "pages", "numbers", "key", "log", "xmind",
    ],
  },
  {
    id: "ebook",
    name: "电子书",
    exts: ["epub", "mobi", "azw", "azw3", "prc", "fb2", "djvu", "cbz", "cbr"],
  },
  {
    id: "archive",
    name: "压缩包",
    exts: [
      "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2",
      "xz", "zst", "lz4", "cab", "jar",
    ],
  },
  {
    id: "disk",
    name: "磁盘镜像",
    exts: ["iso", "img", "dmg", "vhd", "vdi", "vmdk"],
  },
  {
    id: "code",
    name: "代码",
    exts: [
      "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java",
      "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs", "rb", "php",
      "html", "htm", "css", "scss", "less", "json", "xml",
      "yml", "yaml", "toml", "ini", "conf", "sh", "bash", "zsh",
      "bat", "cmd", "ps1", "sql", "swift", "kt", "kts", "lua",
      "pl", "r", "m", "vue", "svelte", "proto",
    ],
  },
  {
    id: "design",
    name: "设计源文件",
    exts: ["psd", "ai", "sketch", "fig", "xd", "cdr", "indd", "xcf"],
  },
  {
    id: "font",
    name: "字体",
    exts: ["ttf", "otf", "woff", "woff2", "eot", "fon"],
  },
  {
    id: "subtitle",
    name: "字幕",
    exts: ["srt", "ass", "ssa", "sub", "vtt", "scc"],
  },
  {
    id: "program",
    name: "程序与安装包",
    exts: [
      "exe", "msi", "appx", "msix", "apk", "appimage",
      "deb", "rpm", "bin", "elf", "dylib",
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
