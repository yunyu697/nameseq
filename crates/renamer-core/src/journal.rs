//! 撤销日志（write-ahead journal）。
//!
//! 存储格式是 JSON Lines，一行一步：
//! ```json
//! {"batch":"20261028-183000-123","from":"/a/x.txt","to":"/a/.rnm-...","ts":1761666600000}
//! ```
//!
//! 关键约定：**先写日志，再动文件**。任何一步在磁盘上生效之前，日志里已经有了它的意图，
//! 所以即使中途崩溃，也能靠日志把已经发生的改名逆推回去（找不到源文件的步骤直接跳过）。

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub batch: String,
    pub from: String,
    pub to: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInfo {
    pub batch: String,
    pub steps: usize,
    pub started_ms: i64,
    pub finished_ms: i64,
    /// 是否写了「完成」标记。false 说明这一批要么正在跑，要么进程半路挂了
    pub completed: bool,
}

/// 一个没跑完、且有文件还卡在临时名上的批次。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedBatch {
    pub batch: String,
    pub started_ms: i64,
    pub steps: usize,
    /// 现在还在 `.rnm-*` 临时名上的路径
    pub pending: Vec<String>,
}

/// 批次完成标记。和 Step 写进同一个文件，靠 `done` 字段区分：
/// 解析 Step 会因为缺少 from/to 失败，正好落到这个结构上。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DoneMark {
    batch: String,
    ts: i64,
    done: bool,
}

pub struct Journal {
    path: PathBuf,
    file: Mutex<File>,
}

impl Journal {
    /// 打开（或创建）日志文件。
    pub fn open(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 记录一步「即将发生」的改名。必须在真正的 fs::rename 之前调用。
    pub fn record(&self, batch: &str, from: &Path, to: &Path) -> std::io::Result<()> {
        let step = Step {
            batch: batch.to_string(),
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            ts: now_ms(),
        };
        let mut line = serde_json::to_string(&step)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');

        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        f.write_all(line.as_bytes())?;
        // 只 flush 到操作系统，不做 fsync：改名本身是元数据操作，
        // 日志丢最后几行最多损失一次撤销能力，不值得为每个文件付一次 fsync 的代价。
        f.flush()
    }

    /// 读出某一批次的所有步骤，按写入顺序。
    pub fn steps_for(&self, batch: &str) -> std::io::Result<Vec<Step>> {
        let mut out = Vec::new();
        for line in self.read_lines()? {
            if let Ok(step) = serde_json::from_str::<Step>(&line) {
                if step.batch == batch {
                    out.push(step);
                }
            }
        }
        Ok(out)
    }

    /// 列出所有批次，最近的在前。
    pub fn batches(&self) -> std::io::Result<Vec<BatchInfo>> {
        let mut map: std::collections::BTreeMap<String, BatchInfo> =
            std::collections::BTreeMap::new();
        for line in self.read_lines()? {
            if let Ok(step) = serde_json::from_str::<Step>(&line) {
                let e = map.entry(step.batch.clone()).or_insert(BatchInfo {
                    batch: step.batch.clone(),
                    steps: 0,
                    started_ms: step.ts,
                    finished_ms: step.ts,
                    completed: false,
                });
                e.steps += 1;
                e.finished_ms = e.finished_ms.max(step.ts);
                continue;
            }
            if let Ok(done) = serde_json::from_str::<DoneMark>(&line) {
                if done.done {
                    if let Some(e) = map.get_mut(&done.batch) {
                        e.completed = true;
                        e.finished_ms = e.finished_ms.max(done.ts);
                    }
                }
            }
        }
        let mut v: Vec<BatchInfo> = map.into_values().collect();
        v.reverse();
        Ok(v)
    }

    /// 写「这一批跑完了」。崩溃恢复靠它区分「跑完的批次」和「跑到一半挂掉的批次」。
    pub fn mark_done(&self, batch: &str) -> std::io::Result<()> {
        let mark = DoneMark {
            batch: batch.to_string(),
            ts: now_ms(),
            done: true,
        };
        let mut line = serde_json::to_string(&mark)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        f.write_all(line.as_bytes())?;
        f.flush()
    }

    /// 找出「跑到一半挂了」的批次：没写完成标记，而且还有文件停在 `.rnm-*` 上。
    ///
    /// 判据只看磁盘事实——临时名文件存在，就说明这一批没有正常走完。
    /// 正常结束的批次在阶段二结束时会把所有临时名落成最终名，不会留下任何 `.rnm-*`。
    pub fn interrupted(&self) -> std::io::Result<Vec<InterruptedBatch>> {
        let mut order: Vec<String> = Vec::new();
        let mut steps: std::collections::HashMap<String, Vec<Step>> =
            std::collections::HashMap::new();
        let mut done: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut started: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

        for line in self.read_lines()? {
            if let Ok(step) = serde_json::from_str::<Step>(&line) {
                if !steps.contains_key(&step.batch) {
                    order.push(step.batch.clone());
                    started.insert(step.batch.clone(), step.ts);
                }
                steps.entry(step.batch.clone()).or_default().push(step);
                continue;
            }
            if let Ok(m) = serde_json::from_str::<DoneMark>(&line) {
                if m.done {
                    done.insert(m.batch);
                }
            }
        }

        let mut out = Vec::new();
        for batch in order {
            if done.contains(&batch) {
                continue;
            }
            let list = steps.get(&batch).cloned().unwrap_or_default();
            let pending: Vec<String> = list
                .iter()
                .map(|s| s.to.clone())
                .filter(|to| is_temp_path(to) && Path::new(to).exists())
                .collect();
            if pending.is_empty() {
                continue;
            }
            out.push(InterruptedBatch {
                batch: batch.clone(),
                started_ms: started.get(&batch).copied().unwrap_or(0),
                steps: list.len(),
                pending,
            });
        }
        out.reverse(); // 最近的批次在前
        Ok(out)
    }

    fn read_lines(&self) -> std::io::Result<Vec<String>> {
        let file = File::open(&self.path)?;
        let reader = BufReader::new(file);
        Ok(reader
            .lines()
            .map_while(Result::ok)
            .filter(|l| !l.trim().is_empty())
            .collect())
    }
}

/// 临时名判定：两阶段改名期间的文件名形如 `.rnm-<batch>-<i>`。
fn is_temp_path(p: &str) -> bool {
    Path::new(p)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with(".rnm-"))
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_journal(tag: &str) -> (Journal, PathBuf) {
        let dir = std::env::temp_dir().join(format!("renamer-journal-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("journal.jsonl");
        (Journal::open(&path).unwrap(), path)
    }

    #[test]
    fn records_and_reads_back() {
        let (j, _p) = tmp_journal("basic");
        j.record("b1", Path::new("/a/x"), Path::new("/a/y")).unwrap();
        j.record("b1", Path::new("/a/y"), Path::new("/a/z")).unwrap();
        j.record("b2", Path::new("/b/1"), Path::new("/b/2")).unwrap();

        let s1 = j.steps_for("b1").unwrap();
        assert_eq!(s1.len(), 2);
        assert_eq!(s1[0].from, "/a/x");
        assert_eq!(s1[1].to, "/a/z");

        let s2 = j.steps_for("b2").unwrap();
        assert_eq!(s2.len(), 1);

        let bs = j.batches().unwrap();
        assert_eq!(bs.len(), 2);
        assert_eq!(bs[0].batch, "b2", "最近的批次在前");
        assert_eq!(bs[1].steps, 2);
    }

    #[test]
    fn reopens_and_appends() {
        let (j, path) = tmp_journal("reopen");
        j.record("b1", Path::new("/a"), Path::new("/b")).unwrap();
        drop(j);
        let j2 = Journal::open(&path).unwrap();
        j2.record("b1", Path::new("/b"), Path::new("/c")).unwrap();
        assert_eq!(j2.steps_for("b1").unwrap().len(), 2);
    }

    #[test]
    fn done_mark_marks_batch_completed() {
        let (j, _p) = tmp_journal("done");
        j.record("b1", Path::new("/a"), Path::new("/b")).unwrap();
        j.record("b2", Path::new("/c"), Path::new("/d")).unwrap();
        j.mark_done("b1").unwrap();

        let bs = j.batches().unwrap();
        assert_eq!(bs.len(), 2);
        assert!(bs.iter().find(|b| b.batch == "b1").unwrap().completed);
        assert!(!bs.iter().find(|b| b.batch == "b2").unwrap().completed);
    }

    #[test]
    fn interrupted_finds_batch_with_live_temp_file() {
        let dir = std::env::temp_dir().join(format!("renamer-journal-int-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let temp = dir.join(".rnm-b1-0");
        std::fs::write(&temp, b"x").unwrap();

        let j = Journal::open(dir.join("journal.jsonl")).unwrap();
        // 模拟「阶段一写进日志、改名成功，然后进程挂了」
        j.record("b1", &dir.join("a.txt"), &temp).unwrap();

        let list = j.interrupted().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].batch, "b1");
        assert_eq!(list[0].pending.len(), 1);

        // 打了完成标记就不该再被当成未完成
        j.mark_done("b1").unwrap();
        assert!(j.interrupted().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
