/**
 * 内联 SVG 图标集。
 * 不引第三方图标库，是为了让安装包保持在 2 MB 级别——
 * 一个图标库动辄几百 KB，这里全部加起来不到 6 KB。
 */

type P = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconFiles = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7a2 2 0 0 1 2-2h3.2l1.6 2H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
    <path d="M8 13h8M8 16.5h5" />
  </svg>
);

export const IconRules = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h9M17 18h3" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="15" cy="18" r="2" />
  </svg>
);

export const IconPlay = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6 4.8v14.4a.6.6 0 0 0 .93.5l11.2-7.2a.6.6 0 0 0 0-1L6.93 4.3a.6.6 0 0 0-.93.5Z" />
  </svg>
);

export const IconUndo = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
    <path d="M7.5 5.5 4 9l3.5 3.5" />
  </svg>
);

export const IconSun = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);

export const IconMoon = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z" />
  </svg>
);

export const IconMonitor = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </svg>
);

export const IconSettings = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.1a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const IconSearch = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </svg>
);

export const IconX = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const IconPlus = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconChevron = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconArrowUp = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const IconArrowDown = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);

export const IconTrash = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
  </svg>
);

export const IconFolder = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2H19.5A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-11Z" />
  </svg>
);

/** 文件夹 + 加号：把「这个文件夹本身」加入改名列表 */
export const IconFolderPlus = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2H19.5A1.5 1.5 0 0 1 21 9.7v3" />
    <path d="M3 7.5v11A1.5 1.5 0 0 0 4.5 20H13" />
    <path d="M18 14v6M15 17h6" />
  </svg>
);

export const IconCheck = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
);

export const IconAlert = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4.5 21 20H3l9-15.5Z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </svg>
);

export const IconLayers = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
    <path d="m4 12.5 8 4.5 8-4.5M4 16.8 12 21l8-4.2" />
  </svg>
);

export const IconSpark = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.3l-1.8-5.7L4.5 10.8 10.2 9 12 3.5Z" />
  </svg>
);

export const IconEye = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

export const IconFilter = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 5.5h17l-6.6 7.6V19l-3.8 2v-7.9L3.5 5.5Z" />
  </svg>
);

export const IconSave = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M5 4h11l3 3v13H5V4Z" />
    <path d="M8 4v5h7V4M8 20v-6h8v6" />
  </svg>
);

export const IconDownload = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

export const IconPalette = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4h1.3A4.6 4.6 0 0 0 20 11.2C20 6.7 16.4 3 12 3Z" />
    <circle cx="8" cy="9.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.8" cy="9.8" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
