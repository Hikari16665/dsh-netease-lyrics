/**
 * inject-policy.js — 什么时候该尝试注入 hook DLL（纯函数，可单测）
 *
 * 实测踩出来的两个坑：
 *   1. helper 一旦附加就持有共享内存句柄，映射在网易云退出后**依然存在**
 *      —— 「通道存在」不等于「有写入端」。
 *   2. 网易云重启后 DLL 随之消失，通道变"僵尸"：桌面歌词窗口还在、却再无新歌词。
 *
 * 判断依据因此是：通道是不是我们自己建出来的（没人写过）、
 * 以及**桌面歌词窗口句柄有没有变**（网易云重启后句柄必变，比进程枚举可靠 ——
 * 沙箱下进程快照根本看不到 cloudmusic.exe）。
 * 至于"写入端静默死掉"，不自动注入（避免用户只是暂停播放就误报），改为在状态里标 stale，
 * 由页面提示给出「重试注入」按钮。
 */
export const DEFAULT_COOLDOWN_MS = 60000; // 两次自动注入尝试的最小间隔
export const DEFAULT_STALE_MS = 180000;   // 桌面歌词窗口在、却这么久没有任何写入活动 → 判定通道僵死

/** 是否应该自动注入 */
export function shouldAttemptInject(input) {
  const {
    autoInject = true,
    desktopLyrics = 0,
    createdByUs = false,
    dlHwnd = '',
    prevDlHwnd = '',
    lastInjectAt = 0,
    now = Date.now(),
    cooldownMs = DEFAULT_COOLDOWN_MS,
  } = input ?? {};

  if (!autoInject) return { attempt: false, reason: 'auto-inject off' };
  if (!(desktopLyrics > 0)) return { attempt: false, reason: 'no desktop-lyrics window' };
  if (now - lastInjectAt < cooldownMs) return { attempt: false, reason: 'cooldown' };
  if (createdByUs) return { attempt: true, reason: 'channel created without writer' };
  if (dlHwnd && prevDlHwnd && dlHwnd !== prevDlHwnd) {
    return { attempt: true, reason: 'player restarted (desktop-lyrics window changed)' };
  }
  return { attempt: false, reason: 'writer present' };
}

/**
 * 通道是否已经僵死（写入端静默消失）——用于给用户一个手动重试的入口。
 *
 * 判定用的是**写入端的活动**（新歌词 `line` 或重绘心跳 `tick`），不是「多久没出新歌词」：
 * 同一句词被反复重绘、长间奏都会让「没有新歌词」变久，但写入端一直活着 —— 只按新歌词判定
 * 会误报「通道已断开」。注意不能用 status 里的 `idleSecs`：helper 只在窗口/可见性/句柄
 * 变化时才上报它，宿主拿到的是旧快照，按它会永久压掉该出现的提示。
 *
 * 剩下的歧义（网易云暂停时两边都静默）无法只靠这里区分，所以阈值取得保守（默认 180s）。
 */
export function isStaleChannel(input) {
  const { desktopLyrics = 0, lastWriteAt = 0, now = Date.now(), staleMs = DEFAULT_STALE_MS } = input ?? {};
  if (!(desktopLyrics > 0)) return false;
  if (!lastWriteAt) return false;
  return now - lastWriteAt > staleMs;
}
