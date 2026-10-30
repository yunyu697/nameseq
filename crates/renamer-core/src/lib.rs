//! 批量重命名核心引擎。
//!
//! 这个 crate 不依赖 Tauri / 任何 GUI，可以被 CLI、服务端或测试单独复用。
//!
//! 数据流：
//! ```text
//! scan()  -> Vec<FileEntry>
//!              |
//!              v
//!         build_plan()  -> Plan { Vec<RenameOp> }     // 规则链求值 + 冲突消解
//!              |
//!              v
//!         execute()     -> BatchResult                // 两阶段改名 + 落日志
//!              |
//!              v
//!           undo()       -> BatchResult                // 按日志逆序回滚
//! ```

pub mod chain;
pub mod cn;
pub mod executor;
pub mod journal;
pub mod media;
pub mod model;
pub mod planner;
pub mod rule;
pub mod scanner;
pub mod template;
pub mod validate;

pub use chain::{ChainFile, CHAIN_EXT, CHAIN_VERSION};
pub use executor::{execute, recover, undo, BatchResult, ExecOptions, OpResult};
pub use journal::{BatchInfo, InterruptedBatch, Journal, Step};
pub use model::{FileEntry, MediaMeta, OpStatus, RenameOp};
pub use planner::{build_plan, Plan, PlanError, RenameConfig, SortBy};
pub use rule::{
    Action, CaseMode, ChineseNumberMode, ConflictPolicy, CounterBase, DateSource, Filter, Rule,
    Target,
};
pub use scanner::{scan, ScanOptions};
pub use template::{parse as parse_template, RenderCtx, Template, TemplateError};
