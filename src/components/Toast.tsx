import { useEffect, useRef } from "react";
import { IconAlert, IconCheck, IconX } from "./Icons";

export type ToastKind = "ok" | "warn" | "err";

export interface ToastData {
  id: number;
  kind: ToastKind;
  text: string;
}

interface Props {
  toast: ToastData | null;
  onClose: () => void;
}

export default function Toast({ toast, onClose }: Props) {
  // 用 ref 存关闭回调，让计时器只依赖 toast 本身。
  // 否则父组件每次重渲染都会换一个新的箭头函数，计时器被反复重置，提示永远不消失。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(
      () => closeRef.current(),
      toast.kind === "ok" ? 3600 : 6500,
    );
    return () => window.clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  return (
    <div className={`toast ${toast.kind}`} key={toast.id} role="status">
      <span className="toast-icon">
        {toast.kind === "ok" ? <IconCheck size={15} /> : <IconAlert size={15} />}
      </span>
      <span className="toast-text">{toast.text}</span>
      <button className="icon-btn sm" onClick={onClose} title="关闭">
        <IconX size={12} />
      </button>
      <i className="toast-timer" />
    </div>
  );
}
