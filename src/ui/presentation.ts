const states: Record<string, string> = {
  starting: "启动中", busy: "执行中", idle: "待命", stopping: "停止中", stopped: "已停止", error: "需要处理",
  running: "进行中", paused: "已暂停", finished: "已结束", completed: "已完成", failed: "失败",
  cancelled: "已取消", interrupted: "已中断", ready: "已就绪", preparing: "准备中", unprepared: "未准备",
  open: "待安排", closed: "已关闭",
};
export const stateLabel = (state: unknown) => states[String(state)] ?? String(state ?? "未知");
export const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
export function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
}
