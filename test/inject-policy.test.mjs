/**
 * inject-policy.test.mjs — 注入策略与僵死通道判定
 * 运行: node test/inject-policy.test.mjs
 */
import assert from 'node:assert/strict';
import { shouldAttemptInject, isStaleChannel, DEFAULT_COOLDOWN_MS, DEFAULT_STALE_MS } from '../inject-policy.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const NOW = 1_700_000_000_000;
const base = { now: NOW, desktopLyrics: 1, lastInjectAt: 0, dlHwnd: '0x2056C', prevDlHwnd: '0x2056C' };

console.log('== shouldAttemptInject ==');
t('autoInject 关闭 → 不注入', () => {
  assert.equal(shouldAttemptInject({ ...base, autoInject: false }).attempt, false);
});
t('没有桌面歌词窗口 → 不注入（没有可 hook 的目标）', () => {
  assert.equal(shouldAttemptInject({ ...base, desktopLyrics: 0, createdByUs: true }).attempt, false);
});
t('通道是我们建的（没人写过）→ 注入', () => {
  const v = shouldAttemptInject({ ...base, createdByUs: true });
  assert.equal(v.attempt, true);
  assert.match(v.reason, /created without writer/);
});
t('窗口句柄变了（网易云重启）→ 注入', () => {
  const v = shouldAttemptInject({ ...base, createdByUs: false, dlHwnd: '0x99AAA', prevDlHwnd: '0x2056C' });
  assert.equal(v.attempt, true);
  assert.match(v.reason, /player restarted/);
});
t('句柄没变、有写入端 → 不注入（避免暂停播放就误报）', () => {
  assert.equal(shouldAttemptInject({ ...base, createdByUs: false }).attempt, false);
});
t('冷却期内不重复注入', () => {
  const v = shouldAttemptInject({ ...base, createdByUs: true, lastInjectAt: NOW - DEFAULT_COOLDOWN_MS + 1000 });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'cooldown');
});
t('冷却期外可再次注入', () => {
  assert.equal(shouldAttemptInject({ ...base, createdByUs: true, lastInjectAt: NOW - DEFAULT_COOLDOWN_MS - 1 }).attempt, true);
});
t('首次拿不到句柄时不误判为重启', () => {
  const v = shouldAttemptInject({ ...base, createdByUs: false, dlHwnd: '0x1', prevDlHwnd: '' });
  assert.equal(v.attempt, false);
});
t('入参为空也不抛错', () => {
  assert.equal(shouldAttemptInject(undefined).attempt, false);
});

console.log('== isStaleChannel（按写入活动判定，不看「多久没出新歌词」）==');
t('窗口不在 → 不算僵死', () => {
  assert.equal(isStaleChannel({ desktopLyrics: 0, lastWriteAt: NOW - 10 * DEFAULT_STALE_MS, now: NOW }), false);
});
t('从没见过写入活动 → 不算僵死（可能只是没播放）', () => {
  assert.equal(isStaleChannel({ desktopLyrics: 1, lastWriteAt: 0, now: NOW }), false);
});
t('刚有写入活动 → 不算僵死', () => {
  assert.equal(isStaleChannel({ desktopLyrics: 1, lastWriteAt: NOW - 5000, now: NOW }), false);
});
t('窗口在但长时间没有任何写入 → 判定僵死', () => {
  assert.equal(isStaleChannel({ desktopLyrics: 1, lastWriteAt: NOW - DEFAULT_STALE_MS - 1, now: NOW }), true);
});
console.log('== 回归：通道活着却被报「已断开」 ==');
t('重绘心跳刷新过活动 → 不算僵死（很久没有新歌词也一样）', () => {
  // line 事件很久没来（同一句被反复重绘），但 tick 一直在刷新活动时间
  assert.equal(isStaleChannel({ desktopLyrics: 1, lastWriteAt: NOW - 3000, now: NOW }), false);
});
t('活动刚好超过阈值 → 判定僵死', () => {
  assert.equal(isStaleChannel({ desktopLyrics: 1, lastWriteAt: NOW - DEFAULT_STALE_MS - 1, now: NOW }), true);
});
t('阈值保守到 180 秒：暂停/长间奏不会立刻报断开', () => {
  assert.ok(DEFAULT_STALE_MS >= 180000, String(DEFAULT_STALE_MS));
  assert.equal(isStaleChannel({ desktopLyrics: 1, lastWriteAt: NOW - 120000, now: NOW }), false);
});
t('idleSecs 不再参与判定（helper 只在状态变化时上报，是旧快照）', () => {
  // 传了 idleSecs 也不影响结果：只看 lastWriteAt
  assert.equal(isStaleChannel({ desktopLyrics: 1, idleSecs: 0, lastWriteAt: NOW - DEFAULT_STALE_MS - 1, now: NOW }), true);
  assert.equal(isStaleChannel({ desktopLyrics: 1, idleSecs: 9999, lastWriteAt: NOW - 1000, now: NOW }), false);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);