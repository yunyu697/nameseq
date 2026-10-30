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
        <span>色相</span>
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
        <span>饱和</span>
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

/** 版本与更新。
    更新检查要走 Tauri 的 updater 插件，浏览器里预览界面时它不存在，
    所以全部用动态 import —— 拿不到就只显示版本号，不白屏。 */
function UpdateSection({ open }: { open: boolean }) {
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [tone, setTone] = useState<"dim" | "ok" | "err">("dim");

  useEffect(() => {
    if (!open) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [open]);

  const check = async () => {
    setBusy(true);
    setTone("dim");
    setNote("正在检查…");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setTone("ok");
        setNote("已经是最新版本");
        return;
      }
      setNote(`发现 ${update.version}，开始下载…`);
      let got = 0;
      let total = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0) setNote(`下载中 ${Math.round((got / total) * 100)}%`);
        } else if (e.event === "Finished") {
          setNote("下载完成，正在安装…");
        }
      });
      setTone("ok");
      setNote("已安装，正在重启");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setTone("err");
      setNote(`检查失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-sec">
      <h4>关于与更新</h4>
      <div className="ver-row">
        <div>
          <b>名序 NameSeq</b>
          <span>版本 {version || "—"}</span>
        </div>
        <button className="btn" onClick={check} disabled={busy}>
          {busy ? "检查中…" : "检查更新"}
        </button>
      </div>
      {note && <p className={`set-hint ${tone}`}>{note}</p>}
      {!note && (
        <p className="set-hint">
          更新包带签名校验，只会安装用本项目密钥签过名的版本
        </p>
      )}
    </section>
  );
}

export default function SettingsDrawer({
  open,
  settings,
  onChange,
  onClose,
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
            <h2>外观设置</h2>
            <p>偏好会保存在本机，下次打开继续生效</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
            <IconX size={15} />
          </button>
        </header>

        <div className="drawer-body">
          <section className="set-sec">
            <h4>主题模式</h4>
            <div className="seg">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`seg-item ${settings.mode === m.id ? "on" : ""}`}
                  onClick={() => onChange({ mode: m.id })}
                >
                  {MODE_ICON[m.id]}
                  {m.name}
                </button>
              ))}
            </div>
            <p className="set-hint">
              {settings.mode === "system"
                ? "跟随系统时，会随系统深浅色自动切换"
                : "已固定为手动选择的模式"}
            </p>
          </section>

          <section className="set-sec">
            <h4>强调色</h4>
            <div className="swatches swatches-dense">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  className={`swatch ${settings.accent === a.id ? "on" : ""}`}
                  title={a.name}
                  onClick={() => setAccentPreset(a.id, a.h, a.s)}
                >
                  <i style={{ background: accentSwatch(a, dark) }} />
                  <span>{a.name}</span>
                </button>
              ))}
              <button
                className={`swatch ${settings.accent === "custom" ? "on" : ""}`}
                title="自定义"
                onClick={() => onChange({ accent: "custom" })}
              >
                <i
                  className="swatch-custom"
                  style={{
                    background: `linear-gradient(135deg, hsl(${settings.accentH} ${settings.accentS}% 44%), hsl(${(settings.accentH + 60) % 360} ${settings.accentS}% 56%))`,
                  }}
                />
                <span>自定义</span>
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
            <h4>强调色浓淡</h4>
            <div className="seg">
              {STRENGTHS.map((t) => (
                <button
                  key={t.id}
                  className={`seg-item ${settings.strength === t.id ? "on" : ""}`}
                  onClick={() => onChange({ strength: t.id as AccentStrength })}
                  title={t.hint}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <p className="set-hint">
              影响按钮、选中态、焦点环等所有强调色的鲜艳程度
            </p>
          </section>

          <section className="set-sec">
            <h4>界面色系</h4>
            <div className="swatches swatches-dense">
              {NEUTRALS.map((n) => (
                <button
                  key={n.id}
                  className={`swatch ${settings.neutral === n.id ? "on" : ""}`}
                  title={n.name}
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
                  <span>{n.name}</span>
                </button>
              ))}
              <button
                className={`swatch ${settings.neutral === "custom" ? "on" : ""}`}
                title="自定义"
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
                <span>自定义</span>
              </button>
            </div>
            <HueSatSlider
              value={{ h: settings.neutralH, s: settings.neutralS }}
              onChange={(v) =>
                onChange({ neutral: "custom", neutralH: v.h, neutralS: v.s })
              }
            />
            <p className="set-hint">
              决定背景、面板、边框和文字的整体色调
            </p>
          </section>

          <section className="set-sec">
            <h4>状态色</h4>
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
                  {st.name}
                </button>
              ))}
            </div>
            <p className="set-hint">成功 / 警告 / 危险 三色一起换，语义不会混</p>
          </section>

          <section className="set-sec">
            <h4>界面密度</h4>
            <div className="seg">
              {DENSITIES.map((d) => (
                <button
                  key={d.id}
                  className={`seg-item ${settings.density === d.id ? "on" : ""}`}
                  onClick={() => onChange({ density: d.id })}
                  title={d.hint}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </section>

          <section className="set-sec">
            <h4>圆角</h4>
            <div className="seg">
              {RADII.map((r) => (
                <button
                  key={r.id}
                  className={`seg-item ${settings.radius === r.id ? "on" : ""}`}
                  onClick={() => onChange({ radius: r.id })}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </section>

          <section className="set-sec">
            <h4>动效</h4>
            <label className="switch-row">
              <div>
                <b>界面动画</b>
                <span>
                  步骤切换、规则增删、预览变化都会带动画。若觉得晃眼可关掉。
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

          <UpdateSection open={open} />
        </div>

        <footer className="drawer-foot">
          <button
            className="btn ghost"
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
          >
            恢复默认
          </button>
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </aside>
    </>
  );
}
