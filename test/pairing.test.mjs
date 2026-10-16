/**
 * pairing.test.mjs — 用**真机抓到的原始事件**回放验证配对状态机
 * 运行: node test/pairing.test.mjs
 */
import assert from 'node:assert/strict';
import { createLyricState, scriptDiffers, charWeightSplit } from '../pairing.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

/** 用 "YYYY-MM-DD HH:MM:SS" + 偏移毫秒 造事件（复刻真机时间关系） */
const base = Date.UTC(2026, 9, 17, 6, 16, 0);
const at = (hhmmss, ms = 0) => {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return base + (h * 3600 + m * 60 + s) * 1000 + ms;
};
const line = (seq, hhmmss, text, ms = 0) => ({ type: 'line', seq, ts: `2026-10-17 ${hhmmss}`, text, _at: at(hhmmss, ms) });
const tick = (seq, hhmmss, ms = 0) => ({ type: 'tick', seq, ts: `2026-10-17 ${hhmmss}`, _at: at(hhmmss, ms) });

console.log('== 脚本判定 ==');
t('英文 vs 中文 → 不同脚本', () => assert.equal(scriptDiffers("I'm happy to see", '但我很高兴能看见'), true));
t('日文(含假名) vs 中文 → 不同脚本', () => assert.equal(scriptDiffers('二人だけの秘密が増えていく', '我们两个人之间，秘密越来越多……'), true));
t('中文 vs 中文 → 同脚本', () => assert.equal(scriptDiffers('对不起我要离开', '我真的很想留下'), false));
t('英文 vs 英文 → 同脚本', () => assert.equal(scriptDiffers('You kissed my dream', 'I saw the light'), false));
t('字数加权切分在 [0.35,0.65]', () => {
  const r = charWeightSplit('短', '一句很长很长的中文译文啊啊啊啊');
  assert.ok(r >= 0.35 && r <= 0.65, `got ${r}`);
});

console.log('== 真机回放：Dream of firefly - JEReka ==');
t('三段槽：孤句 + 两对配对，且配对不产生额外槽', () => {
  const st = createLyricState({ pairWindowMs: 1200 });
  st.pushEvent({ type: 'hello' });
  st.pushEvent({ type: 'status', state: 'attached', desktopLyrics: 1, visible: 1, _at: at('06:16:17') });
  st.pushEvent({ type: 'track', raw: 'Dream of firefly - JEReka', song: 'Dream of firefly', artist: 'JEReka' });

  st.pushEvent(line(1, '06:16:18', '对不起我要离开，要离开'));
  st.pushEvent(line(2, '06:16:22', "I'm happy to see", 0));
  st.pushEvent(tick(2, '06:16:22', 120));
  st.pushEvent(line(3, '06:16:22', '但我很高兴能看见', 300));
  st.pushEvent(line(4, '06:16:28', 'You kissed my dream', 0));
  st.pushEvent(tick(4, '06:16:28', 150));
  st.pushEvent(line(5, '06:16:28', '你亲吻我的梦境', 320));

  const s = st.snapshot();
  assert.equal(s.track.song, 'Dream of firefly');
  assert.equal(s.lyric.original.text, 'You kissed my dream');
  assert.equal(s.lyric.translation.text, '你亲吻我的梦境');
  assert.equal(s.lyric.confidence, 'high');
  assert.equal(s.stats.slots, 3, `期望 3 个槽，实际 ${s.stats.slots}`);
  // 槽间隔 EMA 应落在 4~6 秒之间（真机是 4s 与 6s）
  assert.ok(s.stats.intervalMs > 3000 && s.stats.intervalMs < 7000, `intervalMs=${s.stats.intervalMs}`);
  // 译文到达仅占槽长 7%（<25%）→ 切换点用字数加权（原文至少占 25%）
  const span = s.lyric.endTs - s.lyric.startTs;
  assert.equal(s.lyric.switchAt, s.lyric.startTs + Math.round(s.lyric.split * span));
  assert.ok(s.lyric.switchAt > s.lyric.startTs + span * 0.24, '原文至少占 25%');
});

t('孤句（上一句原文没抓到）不会把下一句当成译文', () => {
  const st = createLyricState({ pairWindowMs: 1200 });
  st.pushEvent(line(1, '06:16:18', '对不起我要离开，要离开'));
  st.pushEvent(line(2, '06:17:05', '下一句正常的歌词'));   // 间隔 47s
  const s = st.snapshot();
  assert.equal(s.stats.slots, 2);
  assert.equal(s.lyric.translation, null);
});

console.log('== 同脚本（中文歌两行）==');
t("pairSameScript='separate'（默认）→ 拆成两句独立歌词", () => {
  const st = createLyricState({ pairSameScript: 'separate' });
  st.pushEvent(line(1, '06:20:00', '对不起我要离开'));
  st.pushEvent(line(2, '06:20:00', '我真的很想留下', 200));
  const s = st.snapshot();
  assert.equal(s.stats.slots, 2);
  assert.equal(s.lyric.translation, null);
  assert.equal(s.recent[0].translation, null);
});

t("pairSameScript='stack' → 仍按原文+译文处理，但置信度为 low", () => {
  const st = createLyricState({ pairSameScript: 'stack' });
  st.pushEvent(line(1, '06:20:00', '对不起我要离开'));
  st.pushEvent(line(2, '06:20:00', '我真的很想留下', 200));
  const s = st.snapshot();
  assert.equal(s.stats.slots, 1);
  assert.equal(s.lyric.translation.text, '我真的很想留下');
  assert.equal(s.lyric.confidence, 'low');
});

console.log('== 日文 + 中文（05:58 那首）==');
t('假名原句与中文译文配成一对', () => {
  const st = createLyricState();
  st.pushEvent({ type: 'line', seq: 1, ts: '2026-10-17 05:58:14', text: '二人だけの秘密が増えていく', _at: at('05:58:14', 0) });
  st.pushEvent({ type: 'line', seq: 2, ts: '2026-10-17 05:58:14', text: '我们两个人之间，秘密越来越多……', _at: at('05:58:14', 40) });
  const s = st.snapshot();
  assert.equal(s.stats.slots, 1);
  assert.equal(s.lyric.confidence, 'high');
  assert.equal(s.lyric.translation.text, '我们两个人之间，秘密越来越多……');
});

console.log('== 过滤与心跳 ==');
t('歌名卡片比 track 事件先到时，track 到达后回溯撤掉它（真机：纯音乐曲目）', () => {
  const st = createLyricState();
  st.pushEvent(line(1, '06:50:00', 'Lone Wolf (Instrumental) - Synthion'));   // 卡片先到，此时还不知道歌名
  assert.equal(st.snapshot().stats.slots, 1, '先到的卡片暂时会成为一个槽');
  assert.equal(st.snapshot().lyric.original.text, 'Lone Wolf (Instrumental) - Synthion');
  st.pushEvent({ type: 'track', raw: 'Lone Wolf (Instrumental) - Synthion', song: 'Lone Wolf (Instrumental)', artist: 'Synthion' });
  assert.equal(st.snapshot().stats.slots, 0, 'track 到达后应把卡片撤掉');
  assert.equal(st.snapshot().lyric, null, '撤掉后没有当前槽（层会隐藏，而不是一直显示歌名）');
  st.pushEvent(line(2, '06:50:06', '真正的歌词来了'));
  assert.equal(st.snapshot().lyric.original.text, '真正的歌词来了');
});

t('回溯过滤不会误撤已有译文的配对槽', () => {
  const st = createLyricState();
  st.pushEvent(line(1, '06:51:00', "I'm happy to see", 0));
  st.pushEvent(line(2, '06:51:00', '但我很高兴能看见', 200));
  st.pushEvent({ type: 'track', raw: 'Dream of firefly - JEReka', song: 'Dream of firefly', artist: 'JEReka' });
  assert.equal(st.snapshot().stats.slots, 1, '已配对的槽不该被撤');
  assert.equal(st.snapshot().lyric.original.text, "I'm happy to see");
});
t('过滤列表命中「纯音乐，请欣赏」', () => {
  const st = createLyricState();
  st.pushEvent(line(1, '06:30:00', '纯音乐，请欣赏'));
  assert.equal(st.snapshot().stats.slots, 0);
});

t('切歌时的「歌名 - 歌手」卡片不会被当成歌词', () => {
  const st = createLyricState();
  st.pushEvent({ type: 'track', raw: 'Dream of firefly - JEReka', song: 'Dream of firefly', artist: 'JEReka' });
  st.pushEvent(line(1, '06:31:00', 'Dream of firefly - JEReka'));
  assert.equal(st.snapshot().stats.slots, 0, '歌名卡片应被过滤');
  st.pushEvent(line(2, '06:31:02', '你说你向往旅行'));
  assert.equal(st.snapshot().stats.slots, 1);
  assert.equal(st.snapshot().lyric.original.text, '你说你向往旅行');
});

t('歌名卡片不会和紧随其后的第一句歌词配成一对', () => {
  const st = createLyricState();
  st.pushEvent({ type: 'track', raw: 'Dream of firefly - JEReka', song: 'Dream of firefly', artist: 'JEReka' });
  st.pushEvent(line(1, '06:31:00', 'Dream of firefly - JEReka', 0));
  st.pushEvent(line(2, '06:31:00', 'Dream of firefly', 200));       // 同一张卡片的另一行
  st.pushEvent(line(3, '06:31:04', 'You lived in my heart this time', 0));
  st.pushEvent(line(4, '06:31:04', '但你这次选择住在了我的心里', 260));
  const s = st.snapshot();
  assert.equal(s.stats.slots, 1, `期望只有 1 个槽，实际 ${s.stats.slots}`);
  assert.equal(s.lyric.original.text, 'You lived in my heart this time');
  assert.equal(s.lyric.translation.text, '但你这次选择住在了我的心里');
});

t('tick 只更新活跃度、不产生槽', () => {
  const st = createLyricState();
  st.pushEvent(line(1, '06:30:00', '一句歌词'));
  const before = st.snapshot().stats.slots;
  st.pushEvent(tick(1, '06:30:02', 0));
  const s = st.snapshot();
  assert.equal(s.stats.slots, before);
  assert.equal(s.stats.ticks, 1);
  assert.equal(s.lastActivityTs, at('06:30:02'));
});

console.log('== 切分回退 ==');
t('译文立刻到达 → 字数加权切换点（原文至少占 25%）', () => {
  const st = createLyricState();
  st.pushEvent(line(1, '06:40:00', 'You kissed my dream', 0));
  st.pushEvent(line(2, '06:40:00', '你亲吻我的梦境', 20));
  const s = st.snapshot();
  const span = s.lyric.endTs - s.lyric.startTs;
  assert.ok(s.lyric.switchAt > s.lyric.startTs, 'switchAt 必须晚于 startTs');
  assert.ok(s.lyric.switchAt <= s.lyric.startTs + span, 'switchAt 必须落在槽内');
  assert.equal(s.lyric.switchAt, s.lyric.startTs + Math.round(s.lyric.split * span));
});

t('译文确实迟到（≥25% 槽长）→ 用真实到达时刻当切换点', () => {
  // 配对窗口放大到 3s，让"迟到译文"成为可能；先喂一对建立较长的槽间隔
  // （两对都用 英文原文 + 中文译文，否则同脚本规则会把它们拆成两句）
  const st = createLyricState({ pairWindowMs: 3000 });
  st.pushEvent(line(1, '06:41:00', 'First line original', 0));
  st.pushEvent(line(2, '06:41:00', '第一句的译文', 30));
  st.pushEvent(line(3, '06:41:05', 'Second line original', 0));      // 5s 后 → 槽间隔约 5s
  st.pushEvent(line(4, '06:41:05', '第二句的译文来得很晚', 1600));    // 迟到 1.6s，占 ~43%
  const s = st.snapshot();
  assert.equal(s.stats.slots, 2, `期望 2 个槽，实际 ${s.stats.slots}`);
  assert.equal(s.lyric.translation.text, '第二句的译文来得很晚');
  assert.equal(s.lyric.switchAt, s.lyric.pairedAt, '迟到时应使用真实到达时刻');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
