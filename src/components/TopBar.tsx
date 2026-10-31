import { IconFiles, IconMoon, IconSettings, IconSun } from "./Icons";
import { t } from "../i18n";

interface Props {
  count: number;
  sizeText: string;
  dark: boolean;
  onToggleDark: () => void;
  onSettings: () => void;
}

export default function TopBar({
  count,
  sizeText,
  dark,
  onToggleDark,
  onSettings,
}: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark">
          <IconFiles size={17} />
        </span>
        <div className="brand-text">
          <h1>{t("名序")}</h1>
          <span className="ver">{__APP_VERSION__}</span>
        </div>
      </div>

      <div className="topbar-right">
        {count > 0 && (
          <span className="stat-chip" key={`${count}-${sizeText}`}>
            <IconFiles size={13} />
            {t("{n} 个文件", { n: count })}
            <i>{sizeText}</i>
          </span>
        )}
        <button
          className="icon-btn"
          onClick={onToggleDark}
          title={dark ? t("切换到浅色主题") : t("切换到深色主题")}
        >
          {dark ? <IconSun /> : <IconMoon />}
        </button>
        <button
          className="icon-btn"
          onClick={onSettings}
          title={t("外观与偏好设置 (Ctrl+,)")}
        >
          <IconSettings />
        </button>
      </div>
    </header>
  );
}
