import { useEffect, useState } from "react";
import {
  ACCENTS,
  DENSITIES,
  MODES,
  NEUTRALS,
  RADII,
  STATUSES,
  STRENGTHS,
  DEFAULT_SETTINGS,
  accentSwatch,
  neutralSwatch,
  neutralSwatchText,
  resolveDark,
  statusSwatches,
  type AccentStrength,
  type HueSat,
  type Settings,
} from "../theme";
import {
  fetchReleases,
  useUpdater,
  type ReleaseInfo,
} from "../updateManager";
import { SUPPORTED_LANGS, t } from "../i18n";
import {
  IconMonitor,
  IconMoon,
  IconPalette,
  IconSun,
  IconX,
} from "./Icons";

interface Props {
  open: boolean;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  /** 更新检查器放在 App 里（抽屉关着也能自动检查），传进来共用状态 */
  updater: ReturnType<typeof useUpdater>;
}

const MODE_ICON = {
  light: <IconSun size={16} />,
  dark: <IconMoon size={16} />,
  system: <IconMonitor size={16} />,
};

/** 色相 + 饱和度双滑块。拖动即生效，实时预览色块跟随。 */
function HueSatSlider({
  value,
  onChange,
}: {
  value: HueSat;
  onChange: (v: HueSat) => void;
}) {
  return (
    <div className="hs-slider">
      <i
        className="hs-dot"
        style={{ background: `hsl(${value.h} ${value.s}% 46%)` }}
      />
      <label>
        <span>{t("色相")}</span>
        <input
          type="range"
          min={0}
          max={360}
          value={value.h}
          onChange={(e) => onChange({ ...value, h: Number(e.target.value) })}
        />
        <b>{value.h}°</b>
      </label>
      <label>
        <span>{t("饱和")}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={value.s}
          onChange={(e) => onChange({ ...value, s: Number(e.target.value) })}
        />
        <b>{value.s}%</b>
      </label>
    </div>
  );
}

const CHECK_FREQS: { id: Settings["updateCheck"]; label: string }[] = [
  { id: "startup", label: "每次启动" },
  { id: "daily", label: "每天" },
  { id: "weekly", label: "每周" },
  { id: "manual", label: "仅手动" },
];

/** 把 markdown 压成可读文本（去图片/链接壳/井号），保留换行 */
function plainNotes(md: string): string {
  return md
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^[*-]\s+/gm, "· ")
    .trim();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 版本与更新。检查频率可选；发现更新后给三个入口：
    立即更新（下载+安装+重启）、仅下载（装不装自己定）、打开下载页面。 */
function UpdateSection({
  open,
  settings,
  onChange,
  updater,
}: {
  open: boolean;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  updater: ReturnType<typeof useUpdater>;
}) {
  const [version, setVersion] = useState("");
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
  const { phase } = updater;

  useEffect(() => {
    if (!open) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [open]);

  // 更新日志：GitHub releases，缓存 1 小时，失败就显示「暂时拿不到」
  useEffect(() => {
    if (!open || releases) return;
    void fetchReleases().then((r) => setReleases(r ?? []));
  }, [open, releases]);

  const busy =
    phase.status === "checking" ||
    phase.status === "downloading" ||
    phase.status === "installing";

  const statusLine = () => {
    switch (phase.status) {
      case "checking":
        return <p className="set-hint dim">{t("正在检查…")}</p>;
      case "uptodate":
        return <p className="set-hint ok">{t("已经是最新版本")}</p>;
      case "error":
        return (
          <p className="set-hint err">{t("检查失败：{err}", { err: phase.error })}</p>
        );
      case "downloading":
        return (
          <div className="upd-progress">
            <div className="bar">
              <i style={{ width: `${phase.progress}%` }} />
            </div>
            <span>{t("下载中 {n}%", { n: phase.progress })}</span>
          </div>
        );
      case "installing":
        return <p className="set-hint ok">{t("下载完成，正在安装，马上重启…")}</p>;
      default:
        return (
          <p className="set-hint">
            {t("更新包带签名校验，只会安装用本项目密钥签过名的版本")}
          </p>
        );
    }
  };

  return (
    <section className="set-sec">
      <h4>{t("关于与更新")}</h4>
      <div className="ver-row">
        <div>
          <b>{t("名序 NameSeq")}</b>
          <span>{t("版本 {v}", { v: version || "—" })}</span>
        </div>
        <button
          className="btn"
          onClick={() => void updater.check(false)}
          disabled={busy}
        >
          {busy ? t("检查中…") : t("检查更新")}
        </button>
      </div>

      <label className="fld upd-freq">
        <span>{t("自动检查频率")}</span>
        <select
          value={settings.updateCheck}
          onChange={(e) =>
            onChange({
              updateCheck: e.target.value as Settings["updateCheck"],
            })
          }
        >
          {CHECK_FREQS.map((f) => (
            <option key={f.id} value={f.id}>
              {t(f.label)}
            </option>
          ))}
        </select>
      </label>
      {settings.updateCheck === "manual" && (
        <p className="set-hint dim">
          {t("已关闭自动检查，想更新时点上面的按钮")}
        </p>
      )}

      {phase.status === "available" && (
        <div className="upd-card">
          <div className="upd-head">
            <b>{t("发现新版本 v{v}", { v: phase.version })}</b>
          </div>
          {phase.notes ? (
            <pre className="upd-notes">{plainNotes(phase.notes)}</pre>
          ) : (
            <p className="set-hint dim">{t("更新说明见下方更新日志")}</p>
          )}
          <div className="upd-actions">
            <button
              className="btn tiny primary"
              onClick={() => void updater.installNow()}
            >
              {t("更新")}
            </button>
            <button
              className="btn tiny"
              onClick={() => void updater.downloadOnly()}
            >
              {t("仅下载")}
            </button>
            <button
              className="btn tiny ghost"
              onClick={() => void updater.openReleasePage()}
            >
              {t("打开下载页面")}
            </button>
          </div>
        </div>
      )}
      {phase.status === "downloaded" && (
        <div className="upd-card">
          <b>{t("安装包已下载")}</b>
          <p className="set-hint dim">{t("想现在装就点下面，重启后生效")}</p>
          <div className="upd-actions">
            <button
              className="btn tiny primary"
              onClick={() => void updater.installDownloaded()}
            >
              {t("安装并重启")}
            </button>
            <button
              className="btn tiny ghost"
              onClick={() => void updater.openReleasePage()}
            >
              {t("打开下载页面")}
            </button>
          </div>
        </div>
      )}

      {statusLine()}

      <div className="rel-notes">
        <h5>{t("更新日志")}</h5>
        {releases === null ? (
          <p className="set-hint dim">{t("正在加载…")}</p>
        ) : releases.length === 0 ? (
          <p className="set-hint dim">
            {t("暂时拿不到更新日志（离线或网络受限）")}
          </p>
        ) : (
          releases.map((r) => {
            const isCur = version && r.tag === `v${version}`;
            const isNew =
              phase.status === "available" && r.tag === `v${phase.version}`;
            return (
              <details key={r.tag} className="rel-item" open={isNew}>
                <summary>
                  <b>{r.name || r.tag}</b>
                  {isCur && <i className="rel-tag cur">{t("当前版本")}</i>}
                  {isNew && <i className="rel-tag new">{t("新版本")}</i>}
                  <span className="rel-date">{fmtDate(r.date)}</span>
                </summary>
                {r.body ? (
                  <pre className="rel-body">{plainNotes(r.body)}</pre>
                ) : (
                  <p className="set-hint dim">{t("这一版没有写说明")}</p>
                )}
              </details>
            );
          })
        )}
      </div>
    </section>
  );
}

export default function SettingsDrawer({
  open,
  settings,
  onChange,
  onClose,
  updater,
}: Props) {
  const dark = resolveDark(settings.mode);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const setAccentPreset = (id: string, h: number, s: number) =>
    onChange({ accent: id, accentH: h, accentS: s });
  const setNeutralPreset = (id: string, h: number, s: number) =>
    onChange({ neutral: id, neutralH: h, neutralS: s });
  const setStatusPreset = (id: string) => {
    const st = STATUSES.find((x) => x.id === id);
    if (!st) return;
    onChange({
      status: id,
      okH: st.ok.h,
      okS: st.ok.s,
      warnH: st.warn.h,
      warnS: st.warn.s,
      dangerH: st.danger.h,
      dangerS: st.danger.s,
    });
  };

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? "show" : ""}`}
        onClick={onClose}
      />
      <aside className={`drawer ${open ? "show" : ""}`} aria-hidden={!open}>
        <header className="drawer-head">
          <span className="drawer-icon">
            <IconPalette />
          </span>
          <div>
            <h2>{t("外观设置")}</h2>
            <p>{t("偏好会保存在本机，下次打开继续生效")}</p>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            title={t("关闭 (Esc)")}
          >
            <IconX size={15} />
          </button>
        </header>

        <div className="drawer-body">
          <section className="set-sec">
            <h4>{t("语言")}</h4>
            <div className="seg seg-wrap">
              {SUPPORTED_LANGS.map((l) => (
                <button
                  key={l.id}
                  className={`seg-item ${settings.language === l.id ? "on" : ""}`}
                  onClick={() => onChange({ language: l.id })}
                  // 语言名按惯例用母语写（endonym），不跟随界面语言翻译
                  data-endonym
                >
                  {l.label}
                </button>
              ))}
            </div>
            <p className="set-hint">{t("切换语言后立即生效，无需重启")}</p>
          </section>

          <section className="set-sec">
            <h4>{t("主题模式")}</h4>
            <div className="seg">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`seg-item ${settings.mode === m.id ? "on" : ""}`}
                  onClick={() => onChange({ mode: m.id })}
                >
                  {MODE_ICON[m.id]}
                  {t(m.name)}
                </button>
              ))}
            </div>
            <p className="set-hint">
              {settings.mode === "system"
                ? t("跟随系统时，会随系统深浅色自动切换")
                : t("已固定为手动选择的模式")}
            </p>
          </section>

          <section className="set-sec">
            <h4>{t("强调色")}</h4>
            <div className="swatches swatches-dense">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  className={`swatch ${settings.accent === a.id ? "on" : ""}`}
                  title={t(a.name)}
                  onClick={() => setAccentPreset(a.id, a.h, a.s)}
                >
                  <i style={{ background: accentSwatch(a, dark) }} />
                  <span>{t(a.name)}</span>
                </button>
              ))}
              <button
                className={`swatch ${settings.accent === "custom" ? "on" : ""}`}
                title={t("自定义")}
                onClick={() => onChange({ accent: "custom" })}
              >
                <i
                  className="swatch-custom"
                  style={{
                    background: `linear-gradient(135deg, hsl(${settings.accentH} ${settings.accentS}% 44%), hsl(${(settings.accentH + 60) % 360} ${settings.accentS}% 56%))`,
                  }}
                />
                <span>{t("自定义")}</span>
              </button>
            </div>
            <HueSatSlider
              value={{ h: settings.accentH, s: settings.accentS }}
              onChange={(v) =>
                onChange({ accent: "custom", accentH: v.h, accentS: v.s })
              }
            />
          </section>

          <section className="set-sec">
            <h4>{t("强调色浓淡")}</h4>
            <div className="seg">
              {STRENGTHS.map((s) => (
                <button
                  key={s.id}
                  className={`seg-item ${settings.strength === s.id ? "on" : ""}`}
                  onClick={() => onChange({ strength: s.id as AccentStrength })}
                  title={t(s.hint)}
                >
                  {t(s.name)}
                </button>
              ))}
            </div>
            <p className="set-hint">
              {t("影响按钮、选中态、焦点环等所有强调色的鲜艳程度")}
            </p>
          </section>

          <section className="set-sec">
            <h4>{t("界面色系")}</h4>
            <div className="swatches swatches-dense">
              {NEUTRALS.map((n) => (
                <button
                  key={n.id}
                  className={`swatch ${settings.neutral === n.id ? "on" : ""}`}
                  title={t(n.name)}
                  onClick={() => setNeutralPreset(n.id, n.h, n.s)}
                >
                  <i
                    className="swatch-neutral"
                    style={{
                      background: neutralSwatch(n, dark),
                      color: neutralSwatchText(n, dark),
                    }}
                  >
                    A
                  </i>
                  <span>{t(n.name)}</span>
                </button>
              ))}
              <button
                className={`swatch ${settings.neutral === "custom" ? "on" : ""}`}
                title={t("自定义")}
                onClick={() => onChange({ neutral: "custom" })}
              >
                <i
                  className="swatch-neutral"
                  style={{
                    background: neutralSwatch(
                      { id: "", name: "", h: settings.neutralH, s: settings.neutralS },
                      dark,
                    ),
                    color: neutralSwatchText(
                      { id: "", name: "", h: settings.neutralH, s: settings.neutralS },
                      dark,
                    ),
                  }}
                >
                  A
                </i>
                <span>{t("自定义")}</span>
              </button>
            </div>
            <HueSatSlider
              value={{ h: settings.neutralH, s: settings.neutralS }}
              onChange={(v) =>
                onChange({ neutral: "custom", neutralH: v.h, neutralS: v.s })
              }
            />
            <p className="set-hint">
              {t("决定背景、面板、边框和文字的整体色调")}
            </p>
          </section>

          <section className="set-sec">
            <h4>{t("状态色")}</h4>
            <div className="status-list">
              {STATUSES.map((st) => (
                <button
                  key={st.id}
                  className={`status-item ${settings.status === st.id ? "on" : ""}`}
                  onClick={() => setStatusPreset(st.id)}
                >
                  <span className="status-dots">
                    {statusSwatches(st, dark).map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                  {t(st.name)}
                </button>
              ))}
            </div>
            <p className="set-hint">
              {t("成功 / 警告 / 危险 三色一起换，语义不会混")}
            </p>
          </section>

          <section className="set-sec">
            <h4>{t("界面密度")}</h4>
            <div className="seg">
              {DENSITIES.map((d) => (
                <button
                  key={d.id}
                  className={`seg-item ${settings.density === d.id ? "on" : ""}`}
                  onClick={() => onChange({ density: d.id })}
                  title={t(d.hint)}
                >
                  {t(d.name)}
                </button>
              ))}
            </div>
          </section>

          <section className="set-sec">
            <h4>{t("圆角")}</h4>
            <div className="seg">
              {RADII.map((r) => (
                <button
                  key={r.id}
                  className={`seg-item ${settings.radius === r.id ? "on" : ""}`}
                  onClick={() => onChange({ radius: r.id })}
                >
                  {t(r.name)}
                </button>
              ))}
            </div>
          </section>

          <section className="set-sec">
            <h4>{t("动效")}</h4>
            <label className="switch-row">
              <div>
                <b>{t("界面动画")}</b>
                <span>
                  {t("步骤切换、规则增删、预览变化都会带动画。若觉得晃眼可关掉。")}
                </span>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={settings.motion}
                onChange={(e) => onChange({ motion: e.target.checked })}
              />
            </label>
          </section>

          <UpdateSection
            open={open}
            settings={settings}
            onChange={onChange}
            updater={updater}
          />
        </div>

        <footer className="drawer-foot">
          <button
            className="btn ghost"
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
          >
            {t("恢复默认")}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t("完成")}
          </button>
        </footer>
      </aside>
    </>
  );
}
