import {
  FAIL_LABEL,
  type BatchInfo,
  type InterruptedBatch,
  type OpResult,
  type Plan,
  type RenameConfig,
} from "../types";
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
    { k: "ok", label: "可执行", v: plan?.executable ?? 0 },
    { k: "conflict", label: "重名冲突", v: plan?.conflicts ?? 0 },
    { k: "invalid", label: "非法名称", v: plan?.invalid ?? 0 },
    { k: "unchanged", label: "无变化", v: plan?.unchanged ?? 0 },
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
            <h3>上次有 {failures.length} 个没成功</h3>
            <button className="link-btn" onClick={onDismissFailures}>
              收起
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
                …还有 {failures.length - 5} 个
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
              重试这 {failures.length} 个
            </button>
            <span className="io-hint">
              重试会按当前磁盘状态重新校验：被占用的先关掉占用的程序，被改过的直接再试
            </span>
          </div>
        </section>
      )}

      {interrupted.length > 0 && (
        <section className="card crash">
          <header className="card-head">
            <IconAlert />
            <h3>上次没跑完</h3>
            <span className="card-count">
              有文件停在 .rnm- 临时名上，恢复即可拿回原名
            </span>
          </header>
          <ul className="batch-list">
            {interrupted.map((b) => (
              <li key={b.batch} className="batch-item">
                <span className="batch-time">{when(b.startedMs)}</span>
                <span className="batch-steps">{b.pending.length} 个待还原</span>
                <span className="batch-id">#{b.batch.slice(-4)}</span>
                <button
                  className="btn tiny primary"
                  disabled={busy}
                  onClick={() => onRecover(b.batch)}
                >
                  <IconUndo size={12} />
                  恢复原名
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tiles">
        {tiles.map((t) => (
          <div className={`tile ${t.k === "ok" ? "accent" : t.k}`} key={t.k}>
            <span className="tile-v">{t.v}</span>
            <span className="tile-l">{t.label}</span>
          </div>
        ))}
      </section>

      {plan && plan.conflicts > 0 && (
        <div className="note warn">
          <IconAlert />
          <span>
            有 {plan.conflicts} 个文件目标名重复。可以把下面的「重名时」改成
            <b> 自动加序号</b>，否则这些文件会被跳过。
          </span>
        </div>
      )}
      {plan && plan.invalid > 0 && (
        <div className="note danger">
          <IconAlert />
          <span>
            有 {plan.invalid} 个新名字不合法（含非法字符、保留名或超长），执行时会被跳过。
          </span>
        </div>
      )}

      <section className="card">
        <header className="card-head">
          <h3>编号与排序</h3>
          <span className="card-count">决定序号按什么顺序分配</span>
        </header>
        <div className="opt-grid">
          <label className="fld">
            <span>排序依据</span>
            <select
              value={config.sortBy}
              onChange={(e) =>
                onChange({ sortBy: e.target.value as RenameConfig["sortBy"] })
              }
            >
              <option value="original">添加顺序</option>
              <option value="name">文件名</option>
              <option value="pinyin">文件名（按拼音）</option>
              <option value="ext">扩展名</option>
              <option value="modified">修改时间</option>
              <option value="size">文件大小</option>
            </select>
          </label>
          <label className="fld">
            <span>重名时</span>
            <select
              value={config.conflict}
              onChange={(e) =>
                onChange({
                  conflict: e.target.value as RenameConfig["conflict"],
                })
              }
            >
              <option value="skip">跳过该文件</option>
              <option value="suffix">自动加 (1)(2)</option>
            </select>
          </label>
        </div>
        <div className="checks">
          <label className="chk">
            <input
              type="checkbox"
              checked={config.naturalSort}
              onChange={(e) => onChange({ naturalSort: e.target.checked })}
            />
            自然排序（IMG_2 排在 IMG_10 前）
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={config.descending}
              onChange={(e) => onChange({ descending: e.target.checked })}
            />
            倒序
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={config.keepExt}
              onChange={(e) => onChange({ keepExt: e.target.checked })}
            />
            保留原扩展名
          </label>
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <IconUndo size={15} />
          <h3>撤销历史</h3>
          <span className="card-count">每次执行都会记一笔，可逐批回滚</span>
        </header>
        {batches.length === 0 ? (
          <p className="empty-note sm">还没有执行过改名。</p>
        ) : (
          <ul className="batch-list">
            {batches.slice(0, 12).map((b) => (
              <li key={b.batch} className="batch-item">
                <span className="batch-time">{when(b.startedMs)}</span>
                <span className="batch-steps">
                  {b.steps} 个文件
                  {!b.completed && (
                    <b className="batch-tag" title="这一批没写完成标记，可能被打断">
                      {" "}
                      · 未完成
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
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="note">
        <IconCheck />
        <span>
          执行采用「两阶段改名」：先全部改成临时名，再改成目标名。这样成环的改名
          （a→b 同时 b→a）也能安全完成，中途失败可回滚。
        </span>
      </div>
    </div>
  );
}
