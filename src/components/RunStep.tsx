import {
  FAIL_LABEL,
  type BatchInfo,
  type InterruptedBatch,
  type OpResult,
  type Plan,
  type RenameConfig,
} from "../types";
import { t } from "../i18n";
import { IconAlert, IconCheck, IconUndo } from "./Icons";

interface Props {
  plan: Plan | null;
  config: RenameConfig;
  batches: BatchInfo[];
  interrupted: InterruptedBatch[];
  /** 上次执行失败的条目（带分类与建议） */
  failures: OpResult[];
  canRetry: boolean;
  busy: boolean;
  onChange: (patch: Partial<RenameConfig>) => void;
  onUndo: (batchId: string) => void;
  onRecover: (batchId: string) => void;
  onRetry: () => void;
  onDismissFailures: () => void;
}

function when(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export default function RunStep({
  plan,
  config,
  batches,
  interrupted,
  failures,
  canRetry,
  busy,
  onChange,
  onUndo,
  onRecover,
  onRetry,
  onDismissFailures,
}: Props) {
  const tiles = [
    { k: "ok", label: t("可执行"), v: plan?.executable ?? 0 },
    { k: "conflict", label: t("重名冲突"), v: plan?.conflicts ?? 0 },
    { k: "invalid", label: t("非法名称"), v: plan?.invalid ?? 0 },
    { k: "unchanged", label: t("无变化"), v: plan?.unchanged ?? 0 },
  ];

  // 按原因归类：用户先要知道「到底几类问题」，再去看具体哪个文件
  const groups = (() => {
    const m = new Map<string, { label: string; n: number; hint: string }>();
    for (const f of failures) {
      const kind = f.kind ?? "other";
      const cur = m.get(kind) ?? {
        label: FAIL_LABEL[kind],
        n: 0,
        hint: f.hint ?? "",
      };
      cur.n += 1;
      m.set(kind, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  })();

  return (
    <div className="step-body">
      {failures.length > 0 && (
        <section className="card fail">
          <header className="card-head">
            <IconAlert />
            <h3>{t("上次有 {n} 个没成功", { n: failures.length })}</h3>
            <button className="link-btn" onClick={onDismissFailures}>
              {t("收起")}
            </button>
          </header>
          <ul className="fail-groups">
            {groups.map((g) => (
              <li key={g.label} className="fail-group">
                <b>{g.label}</b>
                <span className="fail-n">{g.n}</span>
                <span className="fail-hint" title={g.hint}>
                  {g.hint}
                </span>
              </li>
            ))}
          </ul>
          <ul className="fail-items">
            {failures.slice(0, 5).map((f, i) => (
              <li key={`${f.from}-${i}`} className="fail-item">
                <span className="fail-name" title={f.to}>
                  {f.from.split(/[\\/]/).pop()}
                </span>
                <span className="fail-why" title={f.error ?? ""}>
                  {f.error}
                </span>
              </li>
            ))}
            {failures.length > 5 && (
              <li className="fail-item more">
                …{t("还有 {n} 个", { n: failures.length - 5 })}
              </li>
            )}
          </ul>
          <div className="fail-foot">
            <button
              className="btn tiny primary"
              onClick={onRetry}
              disabled={busy || !canRetry}
            >
              <IconUndo size={12} />
              {t("重试这 {n} 个", { n: failures.length })}
            </button>
            <span className="io-hint">
              {t(
                "重试会按当前磁盘状态重新校验：被占用的先关掉占用的程序，被改过的直接再试",
              )}
            </span>
          </div>
        </section>
      )}

      {interrupted.length > 0 && (
        <section className="card crash">
          <header className="card-head">
            <IconAlert />
            <h3>{t("上次没跑完")}</h3>
            <span className="card-count">
              {t("有文件停在 .rnm- 临时名上，恢复即可拿回原名")}
            </span>
          </header>
          <ul className="batch-list">
            {interrupted.map((b) => (
              <li key={b.batch} className="batch-item">
                <span className="batch-time">{when(b.startedMs)}</span>
                <span className="batch-steps">
                  {t("{n} 个待还原", { n: b.pending.length })}
                </span>
                <span className="batch-id">#{b.batch.slice(-4)}</span>
                <button
                  className="btn tiny primary"
                  disabled={busy}
                  onClick={() => onRecover(b.batch)}
                >
                  <IconUndo size={12} />
                  {t("恢复原名")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tiles">
        {tiles.map((tl) => (
          <div
            className={`tile ${tl.k === "ok" ? "accent" : tl.k}`}
            key={tl.k}
          >
            <span className="tile-v">{tl.v}</span>
            <span className="tile-l">{tl.label}</span>
          </div>
        ))}
      </section>

      {plan && plan.conflicts > 0 && (
        <div className="note warn">
          <IconAlert />
          <span>
            {t(
              "有 {n} 个文件目标名重复。可以把下面的「重名时」改成自动加序号，否则这些文件会被跳过。",
              { n: plan.conflicts },
            )}
          </span>
        </div>
      )}
      {plan && plan.invalid > 0 && (
        <div className="note danger">
          <IconAlert />
          <span>
            {t(
              "有 {n} 个新名字不合法（含非法字符、保留名或超长），执行时会被跳过。",
              { n: plan.invalid },
            )}
          </span>
        </div>
      )}

      <section className="card">
        <header className="card-head">
          <h3>{t("序号")}</h3>
          <span className="card-count">
            {t("模板里 {index} 的计数方式；{counter} 同样生效")}
          </span>
        </header>
        <div className="opt-grid">
          <label className="fld">
            <span>{t("起始")}</span>
            <input
              type="number"
              className="num"
              style={{ width: 70 }}
              min={0}
              value={config.startIndex}
              onChange={(e) =>
                onChange({
                  startIndex: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </label>
          <label className="fld">
            <span>{t("步长")}</span>
            <input
              type="number"
              className="num"
              style={{ width: 70 }}
              min={1}
              value={config.indexStep}
              onChange={(e) =>
                onChange({
                  indexStep: Math.max(1, Number(e.target.value) || 1),
                })
              }
            />
          </label>
          <label className="fld">
            <span>{t("位数")}</span>
            <input
              type="number"
              className="num"
              style={{ width: 70 }}
              min={0}
              max={12}
              value={config.indexWidth}
              onChange={(e) =>
                onChange({
                  indexWidth: Math.min(
                    12,
                    Math.max(0, Number(e.target.value) || 0),
                  ),
                })
              }
            />
          </label>
        </div>
        <div className="checks">
          <label className="chk">
            <input
              type="checkbox"
              checked={config.indexPerFolder}
              onChange={(e) =>
                onChange({ indexPerFolder: e.target.checked })
              }
            />
            {t("按文件夹重新计数")}
            <span className="io-hint">{t("每个文件夹各自从「起始」开始")}</span>
          </label>
        </div>
        <p className="set-hint dim" style={{ margin: 0 }}>
          {t("模板里写 {index:03} 这类显式格式时，优先用模板里的位数")}
        </p>
      </section>

      <section className="card">
        <header className="card-head">
          <h3>{t("执行选项")}</h3>
          <span className="card-count">{t("排序在预览列表上方调整")}</span>
        </header>
        <div className="opt-grid">
          <label className="fld">
            <span>{t("重名时")}</span>
            <select
              value={config.conflict}
              onChange={(e) =>
                onChange({
                  conflict: e.target.value as RenameConfig["conflict"],
                })
              }
            >
              <option value="skip">{t("跳过该文件")}</option>
              <option value="suffix">{t("自动加 (1)(2)")}</option>
            </select>
          </label>
        </div>
        <div className="checks">
          <label className="chk">
            <input
              type="checkbox"
              checked={config.keepExt}
              onChange={(e) => onChange({ keepExt: e.target.checked })}
            />
            {t("保留原扩展名")}
          </label>
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <IconUndo size={15} />
          <h3>{t("撤销历史")}</h3>
          <span className="card-count">
            {t("每次执行都会记一笔，可逐批回滚")}
          </span>
        </header>
        {batches.length === 0 ? (
          <p className="empty-note sm">{t("还没有执行过改名。")}</p>
        ) : (
          <ul className="batch-list">
            {batches.slice(0, 12).map((b) => (
              <li key={b.batch} className="batch-item">
                <span className="batch-time">{when(b.startedMs)}</span>
                <span className="batch-steps">
                  {t("{n} 个文件", { n: b.steps })}
                  {!b.completed && (
                    <b className="batch-tag" title={t("这一批没写完成标记，可能被打断")}>
                      {" "}
                      · {t("未完成")}
                    </b>
                  )}
                </span>
                <span className="batch-id">#{b.batch.slice(-4)}</span>
                <button
                  className="btn tiny"
                  disabled={busy}
                  onClick={() => onUndo(b.batch)}
                >
                  <IconUndo size={12} />
                  {t("撤销")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="note">
        <IconCheck />
        <span>
          {t(
            "执行采用「两阶段改名」：先全部改成临时名，再改成目标名。这样成环的改名（a→b 同时 b→a）也能安全完成，中途失败可回滚。",
          )}
        </span>
      </div>
    </div>
  );
}
