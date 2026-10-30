export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

export interface DiffParts {
  oldPre: string;
  oldMid: string;
  oldSuf: string;
  newPre: string;
  newMid: string;
  newSuf: string;
}

/**
 * 计算新旧文件名的差异区间，只高亮中间变化的那一段。
 *
 * 这是批量重命名工具里最实用的一处反馈：一屏几百行，如果只把新名字涂成一个颜色，
 * 用户根本看不出到底改了哪几个字符。算法就是从两头往中间收缩公共前后缀，
 * O(n)，对虚拟滚动里可见的几十行毫无压力。
 */
export function diffName(a: string, b: string): DiffParts {
  if (a === b) {
    return { oldPre: a, oldMid: "", oldSuf: "", newPre: b, newMid: "", newSuf: "" };
  }

  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre++;

  let suf = 0;
  while (
    suf < max - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  return {
    oldPre: a.slice(0, pre),
    oldMid: a.slice(pre, a.length - suf),
    oldSuf: suf > 0 ? a.slice(a.length - suf) : "",
    newPre: b.slice(0, pre),
    newMid: b.slice(pre, b.length - suf),
    newSuf: suf > 0 ? b.slice(b.length - suf) : "",
  };
}
