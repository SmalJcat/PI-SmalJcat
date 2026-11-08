//! 启动耗时追踪：把启动各阶段的耗时记下来，供诊断面板与日志使用。
//!
//! 目的很朴素：**先量再优化**。没有数字之前，"某处不阻塞启动"只是猜测。
//! 记录的是各阶段完成的累计毫秒数（相对 run() 开始），因此相邻两项之差就是该阶段耗时。

use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// 进程内最早的零点：在 main() 的第一条语句登记。
/// 这样 trace 的计时就不再从 Tauri run() 开始，而是覆盖 Builder/插件初始化。
/// 注意：**不含** exe 加载与 DLL 解析（那发生在 main 之前，需要平台 API 才能拿到）。
static BOOT: OnceLock<Instant> = OnceLock::new();

/// 登记进程内零点（幂等，重复调用只生效第一次）。
pub fn mark_process_start() {
    let _ = BOOT.set(Instant::now());
}

#[derive(Default)]
pub struct StartupTrace {
    started: Mutex<Option<Instant>>,
    marks: Mutex<Vec<(String, u128)>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

impl StartupTrace {
    /// 在 run() 最开始调用。如果 main() 已经登记过进程零点就用它，否则以此刻为零点。
    pub fn begin(&self) {
        let origin = BOOT.get().copied().unwrap_or_else(Instant::now);
        *self.started.lock().unwrap() = Some(origin);
    }

    /// 记录一个阶段的完成时刻（累计毫秒）。重复标记同名阶段时以最后一次为准。
    pub fn mark(&self, name: &str) {
        let Some(start) = *self.started.lock().unwrap() else {
            return;
        };
        let elapsed = start.elapsed().as_millis();
        let mut marks = self.marks.lock().unwrap();
        if let Some(existing) = marks.iter_mut().find(|(label, _)| label == name) {
            existing.1 = elapsed;
            return;
        }
        marks.push((name.to_owned(), elapsed));
    }

    /// 生成阶段表 + 相邻差值（毫秒）。
    pub fn report(&self) -> Value {
        let marks = self.marks.lock().unwrap().clone();
        let mut stages = Vec::new();
        let mut previous = 0_u128;
        for (name, at) in &marks {
            stages.push(json!({
                "name": name,
                "atMs": at,
                "costMs": at.saturating_sub(previous),
            }));
            previous = *at;
        }
        json!({
            "stages": stages,
            "totalMs": marks.last().map(|(_, at)| *at).unwrap_or_default(),
            "reportedAtMs": now_ms(),
        })
    }

    /// 一行日志摘要，便于在启动日志里直接看到各阶段。
    pub fn summary_line(&self) -> String {
        let marks = self.marks.lock().unwrap().clone();
        let mut parts = Vec::new();
        let mut previous = 0_u128;
        for (name, at) in &marks {
            parts.push(format!("{name} {}ms", at.saturating_sub(previous)));
            previous = *at;
        }
        format!(
            "启动耗时：总计 {}ms（{}）",
            marks.last().map(|(_, at)| *at).unwrap_or_default(),
            parts.join(" · ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_recorded_with_cumulative_and_stage_costs() {
        let trace = StartupTrace::default();
        trace.begin();
        trace.mark("配置");
        trace.mark("任务记录");
        trace.mark("界面");
        let report = trace.report();
        let stages = report["stages"].as_array().unwrap();
        assert_eq!(stages.len(), 3);
        assert_eq!(stages[0]["name"], "配置");
        // 累计时间单调不减，阶段耗时相加等于总计
        let mut previous = 0_u64;
        for stage in stages {
            let at = stage["atMs"].as_u64().unwrap();
            assert!(at >= previous, "累计时间应当单调不减");
            previous = at;
        }
        let total = report["totalMs"].as_u64().unwrap();
        let sum: u64 = stages
            .iter()
            .map(|stage| stage["costMs"].as_u64().unwrap())
            .sum();
        assert_eq!(total, previous);
        assert_eq!(sum, total, "阶段耗时之和应等于总计");
        assert!(trace.summary_line().starts_with("启动耗时：总计"));
    }

    #[test]
    fn remark_overwrites_and_unstarted_trace_is_inert() {
        let trace = StartupTrace::default();
        // 没有 begin：mark 不产生记录
        trace.mark("配置");
        assert!(trace.report()["stages"].as_array().unwrap().is_empty());

        trace.begin();
        trace.mark("界面");
        trace.mark("界面");
        let stages = trace.report()["stages"].as_array().unwrap().clone();
        assert_eq!(stages.len(), 1, "同名阶段应当覆盖而不是重复记录");
    }
}
