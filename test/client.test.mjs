/**
 * client.test.mjs — 用最小 DOM stub 直接跑 client.js，验证层挂载与四种配对显示模式
 * 运行: node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

// ───────────── 最小 DOM ─────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.attrs = {};
    this._text = '';
    this._listeners = {};
    this.style = {
      _p: new Map(),
      setProperty(k, v) { this._p.set(k, String(v)); },
      getPropertyValue(k) { return this._p.get(k) || ''; },
      removeProperty(k) { this._p.delete(k); },
    };
    this.classList = { add: () => {}, remove: () => {}, contains: () => false };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  appendChild(n) { this.children.push(n); return n; }
  append(...n) { for (const x of n) this.children.push(x); }
  remove() { this.removed = true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, cb) { (this._listeners[t] ||= []).push(cb); }
  dispatch(t, ev) { for (const cb of this._listeners[t] || []) cb(ev); }
  querySelectorAll() { return []; }
  contains(n) { return n === this || this.children.includes(n); }
  getBoundingClientRect() {
    const cls = String(this.className);
    const w = cls.includes('dnl-stage') || cls.includes('dnl-glide') ? 1200 : cls.includes('dnl-slot') ? 600 : 100;
    const h = cls.includes('dnl-stage') || cls.includes('dnl-glide') ? 800 : cls.includes('dnl-slot') ? 120 : 40;
    return { width: w, height: h, left: 0, top: 0, right: w, bottom: h };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html || ''; }
  /** 深度查找（选择器只支持 .class 与 [data-x] 简单形式） */
  find(pred) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  findClass(cls) { return this.find((e) => String(e.className).split(/\s+/).includes(cls)); }
}

const bodyEl = new El('body');
const headEl = new El('head');
const rootEl = new El('html');
const tokens = new Map();
const globalDoc = {
  hidden: false,
  documentElement: rootEl,
  head: headEl,
  body: bodyEl,
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = globalDoc;
let reduced = false;
let stubColor = 'rgba(21, 21, 23, 1)';
globalThis.getComputedStyle = () => ({
  color: stubColor,
  getPropertyValue: (k) => tokens.get(k) || '',
});

// ───────────── 时钟与帧 ─────────────
let nowMs = 1_000_000;
globalThis.performance = { now: () => nowMs };
const realDateNow = Date.now;
Date.now = () => nowMs;
const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
function tick(ms = 16) {
  nowMs += ms;
  const q = rafQueue.splice(0, rafQueue.length);
  for (const cb of q) cb(nowMs);
}
globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__DEF__ = def; } },
  matchMedia: () => ({ matches: reduced }),
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ───────────── fetch / SSE stub ─────────────
let payload = null;
let injectCalls = [];
let configPosts = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/state')) return { ok: true, json: async () => payload };
  if (String(url).includes('/config/reset')) { injectCalls.push('config-reset'); return { ok: true, json: async () => ({ ok: true }) }; }
  if (String(url).includes('/config')) { try { configPosts.push(JSON.parse(opts?.body || '{}')); } catch { configPosts.push({}); } return { ok: true, json: async () => ({ ok: true }) }; }
  if (String(url).includes('/inject')) { injectCalls.push('inject'); return { ok: true, json: async () => ({ ok: true }) }; }
  if (String(url).includes('/reveal')) { injectCalls.push('reveal'); return { ok: true, json: async () => ({ ok: true }) }; }
  return { ok: false, json: async () => ({}) };
};
const esInstances = [];
class FakeEventSource {
  constructor() { this._l = {}; esInstances.push(this); }
  addEventListener(t, cb) { (this._l[t] ||= []).push(cb); }
  close() { this.closed = true; }
  emit(p) { for (const cb of this._l.state || []) cb({ data: JSON.stringify(p) }); }
}
globalThis.EventSource = FakeEventSource;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const navStub = { clipboard: { writeText: async () => {} } };
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};

// ───────────── 加载 client.js ─────────────
new Function('window', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'EventSource', 'MutationObserver', 'navigator', 'getComputedStyle', CODE)(
  globalThis.window, globalThis.document, globalThis.performance, globalThis.requestAnimationFrame,
  globalThis.cancelAnimationFrame, globalThis.fetch, globalThis.EventSource, globalThis.MutationObserver,
  navStub, globalThis.getComputedStyle,
);
assert.ok(globalThis.__DEF__, 'client.js 必须调用 window.__ModuleLoader__.load');
assert.equal(globalThis.__DEF__.id, 'dsh-netease-lyrics', 'id 必须等于包名');

const mod = globalThis.__DEF__.factory(() => { throw new Error('本插件不应 require 平台模块'); });
const cleanupFns = [];
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanupFns.push(d); return () => {}; },
};
mod.apply(ctx);

const layer = () => bodyEl.findClass('dnl-layer')[0];
const slot = () => bodyEl.findClass('dnl-slot')[0];
const main = () => bodyEl.findClass('dnl-main')[0];
const trans = () => bodyEl.findClass('dnl-trans')[0];
const hint = () => bodyEl.findClass('dnl-hint')[0];
const chars = () => bodyEl.findClass('dnl-ch');
const glideEl = () => bodyEl.findClass('dnl-glide')[0];
const gdx = () => parseFloat(glideEl().style.getPropertyValue('--dnl-dx') || '0');
const gdy = () => parseFloat(glideEl().style.getPropertyValue('--dnl-dy') || '0');

function push(p) { payload = p; for (const inst of esInstances) inst.emit(p); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};

const basePayload = (over = {}) => ({
  track: { raw: 'Dream of firefly - JEReka', song: 'Dream of firefly', artist: 'JEReka' },
  channel: { state: 'attached', desktopLyrics: 1, visible: 1 },
  inject: { status: 'skipped', message: '' },
  lyric: {
    index: 1,
    original: { text: 'You kissed my dream', ts: '2026-10-17 06:16:28' },
    translation: { text: '你亲吻我的梦境', ts: '2026-10-17 06:16:28' },
    confidence: 'high', startTs: nowMs, endTs: nowMs + 4000, switchAt: nowMs + 2000, split: 0.5,
  },
  config: {
    enabled: true, zIndex: -1, effectPool: ['karaoke'], reshuffle: 'song', band: 'bottom', align: 'center',
    fontScale: 1, opacity: 0.85, showTrackTitle: false, idleFadeSec: 15, respectReducedMotion: true,
    pairMode: 'stacked', pairWindowMs: 1200, pairSameScript: 'separate', translationFallback: 'original',
    glassMode: 'off', glassStrength: 0.35, filterPatterns: [],
  },
  ...over,
});

console.log('== 层挂载 ==');
push(basePayload());
const es = bodyEl.findClass('dnl-layer');
check('层已挂到 body', es.length === 1);
check('style 已注入 head', headEl.children.some((c) => c.tagName === 'STYLE'));
check('层带 aria-hidden', layer().attrs['aria-hidden'] === 'true');
tick(); tick();
check('主行渲染出逐字 span', chars().length === 'You kissed my dream'.length, `chars=${chars().length}`);
check('译文小字已渲染', trans().textContent === '你亲吻我的梦境', trans().textContent);
check('层可见', layer().dataset.hidden === '0');

console.log('== pairMode: original-only ==');
push(basePayload({ config: { ...basePayload().config, pairMode: 'original-only' } }));
tick(); tick();
check('主行是原文', main().textContent === 'You kissed my dream', main().textContent);
check('不渲染译文', trans().textContent === '', trans().textContent);

console.log('== pairMode: translation-only ==');
push(basePayload({ config: { ...basePayload().config, pairMode: 'translation-only' } }));
tick(); tick();
check('主行是译文', main().textContent === '你亲吻我的梦境', main().textContent);

console.log('== pairMode: translation-only 无译文 ==');
const noTrans = basePayload({ config: { ...basePayload().config, pairMode: 'translation-only' } });
noTrans.lyric = { ...noTrans.lyric, index: 2, translation: null, switchAt: null };
push(noTrans); tick(); tick();
check('回落显示原文', main().textContent === 'You kissed my dream', main().textContent);

const hideTrans = basePayload({ config: { ...basePayload().config, pairMode: 'translation-only', translationFallback: 'hide' } });
hideTrans.lyric = { ...hideTrans.lyric, index: 3, translation: null, switchAt: null };
push(hideTrans); tick(); tick();
check('translationFallback=hide → 整句不显示', layer().dataset.hidden === '1');

console.log('== pairMode: two-lines ==');
const tl = basePayload({ config: { ...basePayload().config, pairMode: 'two-lines' } });
tl.lyric = { ...tl.lyric, index: 4, startTs: nowMs, endTs: nowMs + 4000, switchAt: nowMs + 1500 };
push(tl); tick(); tick();
check('切换前显示原文', main().textContent === 'You kissed my dream', main().textContent);
nowMs += 1600; tick(); tick();
check('过了 switchAt 后显示译文', main().textContent === '你亲吻我的梦境', main().textContent);
check('two-lines 不额外渲染译文小字', trans().textContent === '');

console.log('== 随机场景确定性与效果池 ==');
const pool = ['karaoke', 'typewriter', 'blurReveal', 'neonPulse'];
const p1 = basePayload({ config: { ...basePayload().config, effectPool: pool, reshuffle: 'song' } });
p1.lyric = { ...p1.lyric, index: 10 };
push(p1); tick(); tick();
const fx1 = slot().dataset.fx;
const sameSong = basePayload({ config: { ...p1.config } });
sameSong.lyric = { ...sameSong.lyric, index: 11 };
push(sameSong); tick(); tick();
check('同一首歌效果稳定', slot().dataset.fx === fx1, `${fx1} vs ${slot().dataset.fx}`);
check('效果取自效果池', pool.includes(slot().dataset.fx), slot().dataset.fx);
const otherSong = basePayload({ config: { ...p1.config } });
otherSong.track = { raw: 'Another Song - Someone', song: 'Another Song', artist: 'Someone' };
otherSong.lyric = { ...otherSong.lyric, index: 12 };
push(otherSong); tick(); tick();
check('换歌会重挑场景（仍在池内）', pool.includes(slot().dataset.fx), slot().dataset.fx);

console.log('== 提示与失败态 ==');
push(basePayload({ inject: { status: 'needs-manual', message: '', manualScript: 'C:\\x\\install-hook.cmd' }, channel: { state: 'waiting-shm' } }));
tick();
check('needs-manual 显示提示', hint().dataset.show === '1', JSON.stringify(hint().dataset));
check('提示里有三个动作按钮', hint().children.filter((c) => c.tagName === 'BUTTON').length === 3, `buttons=${hint().children.filter((c) => c.tagName === 'BUTTON').length}`);
const btn = hint().children.filter((c) => c.tagName === 'BUTTON')[0];
btn.dispatch('click', { stopPropagation() {} });
await new Promise((r) => setTimeout(r, 10));
check('点击「复制脚本路径」不抛错', true);

push(basePayload({ channel: { state: 'attached', desktopLyrics: 0, visible: 0 } }));
tick();
check('未开桌面歌词时给出提示', hint().dataset.show === '1' && hint().textContent.includes('桌面歌词'), hint().textContent);

console.log('== 提示条的可点击性（回归：提示条点不到）==');
{
  const CSS_SRC = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  const uiEl = bodyEl.findClass('dnl-ui')[0];
  check('提示条挂在高层容器 .dnl-ui 里（不是 z-index:-1 的歌词层）', !!uiEl && uiEl.contains(hint()));
  check('歌词层里不再有提示条', layer().findClass('dnl-hint').length === 0);
  check('提示条默认不吃点击（隐藏时不挡输入区）', /\.dnl-hint\{[^}]*pointer-events:none/.test(CSS_SRC));
  check('提示条显示时才接收点击', /\.dnl-hint\[data-show="1"\]\{[^}]*pointer-events:auto/.test(CSS_SRC));
  check('提示条的按钮可点', /\.dnl-hint button\{[^}]*pointer-events:auto/.test(CSS_SRC));
}
console.log('== 通道僵死提示（措辞不武断，按钮可用）==');
{
  const withChannel = (ch) => basePayload({ channel: { state: 'attached', desktopLyrics: 1, visible: 1, lines: 100, ...ch } });

  // 宿主标 stale → 给提示与按钮，但文案要承认"可能只是暂停"
  push(withChannel({ stale: true, idleSecs: 0 })); tick();
  check('宿主标 stale 时给出提示', hint().dataset.show === '1', hint().textContent);
  check('提示文案不武断（提到可能只是暂停）', hint().textContent.includes('暂停'), hint().textContent);
  check('提示里给了「重新注入」按钮', hint().children.some((c) => c.tagName === 'BUTTON' && c.textContent.includes('重新注入')),
    hint().textContent);

  // 宿主没标 stale → 不提示
  push(withChannel({ stale: false, idleSecs: 300 })); tick();
  check('宿主未标 stale → 不提示', hint().dataset.show !== '1', hint().textContent);
}
console.log('== 空闲淡出与总开关 ==');
push(basePayload({ config: { ...basePayload().config, idleFadeSec: 1 } }));
tick(); tick();
check('有歌词时可见', layer().dataset.hidden === '0');
nowMs += 3000; tick();
check('超过 idleFadeSec 后淡出', layer().dataset.hidden === '1');

push(basePayload({ config: { ...basePayload().config, enabled: false } }));
tick(); tick();
check('enabled=false → 层隐藏', layer().dataset.hidden === '1');
check('enabled=false → 提示说明', hint().textContent.includes('关闭'), hint().textContent);

console.log('== 玻璃化（面板不透明时把外壳调半透明）==');
const glassToken = () => rootEl.style.getPropertyValue('--dsw-alias-bg-layer-1');
const cfgWithGlass = (over) => ({ ...basePayload().config, ...over });

push(basePayload({ config: cfgWithGlass({ glassMode: 'off' }) }));
tick();
check('glassMode=off → 不动主题令牌', glassToken() === '', glassToken());

push(basePayload({ config: cfgWithGlass({ glassMode: 'auto' }) }));
tick();
check('auto + 面板不透明 → 写入半透明令牌', glassToken().includes('color-mix'), glassToken());
check('混色用的是解析后的真实颜色', glassToken().includes('rgba(21, 21, 23, 1)'), glassToken());

push(basePayload({ config: cfgWithGlass({ glassMode: 'off' }) }));
tick();
check('切回 off → 令牌还原', glassToken() === '', glassToken());

stubColor = 'rgb(255, 255, 255)'; // 模拟浅色主题
push(basePayload({ config: cfgWithGlass({ glassMode: 'auto', glassStrength: 0.5 }) }));
tick();
check('浅色主题按真实底色混色（回归：不再回落深色）', glassToken().includes('rgb(255, 255, 255)'), glassToken());

push(basePayload({ config: cfgWithGlass({ glassMode: 'off' }) }));
tick();
stubColor = 'rgba(21, 21, 23, 0.5)'; // 面板本就半透明（例如壁纸插件的玻璃主题）
push(basePayload({ config: cfgWithGlass({ glassMode: 'auto' }) }));
tick();
check('面板已半透明 → 不重复覆盖', glassToken() === '', glassToken());

stubColor = 'rgba(21, 21, 23, 1)';
push(basePayload({ config: cfgWithGlass({ glassMode: 'auto' }) }));
tick();
check('玻璃化已生效（供回收检查）', glassToken().includes('color-mix'), glassToken());

console.log('== 齿轮设置面板 ==');
const gear = () => bodyEl.findClass('dnl-gear')[0];
const panel = () => bodyEl.findClass('dnl-panel')[0];
const segBtn = (label) => panel().find((e) => e.tagName === 'BUTTON' && e.textContent === label)[0];

push(basePayload({ config: cfgWithGlass({ glassMode: 'off', pairMode: 'stacked' }) }));
tick(); tick();
check('齿轮已挂到独立高层容器（不在 z-index:-1 的歌词层里）', !!gear() && bodyEl.findClass('dnl-ui')[0].contains(gear()));
check('歌词层里没有设置 UI（避免被聊天内容盖住）', layer().findClass('dnl-gear').length === 0);
check('面板默认收起', panel().dataset.open === '0');

gear().dispatch('click', { stopPropagation() {} });
tick();
check('点齿轮展开面板', panel().dataset.open === '1');
check('面板里有四个配对模式', ['译文小字', '只要原文', '只要翻译', '当两段歌词'].every((t) => !!segBtn(t)));
check('当前值高亮为「译文小字」', segBtn('译文小字').attrs['aria-pressed'] === 'true');
check('面板里有十个效果 chip', panel().find((e) => String(e.className).includes('dnl-chips'))[0].children.length === 10);

segBtn('当两段歌词').dispatch('click', { stopPropagation() {} });
tick(); tick();
check('点击后立即按 two-lines 渲染（切换前显示原文）', main().textContent === 'You kissed my dream', main().textContent);
check('本地设置已落 localStorage', String(lsMap.get('dsh-netease-lyrics:settings')).includes('two-lines'), String(lsMap.get('dsh-netease-lyrics:settings')));
check('pairMode 只走本地、不发宿主请求', configPosts.length === 0, JSON.stringify(configPosts));
check('配对时间窗以滑块呈现', !!panel().find((e) => e.textContent === '配对时间窗')[0]);

console.log('== 恢复默认 ==');
const resetBtn = panel().find((e) => e.tagName === 'BUTTON' && e.textContent === '恢复默认')[0];
check('有恢复默认按钮', !!resetBtn);
resetBtn.dispatch('click', { stopPropagation() {} });
await new Promise((r) => setTimeout(r, 20));
check('本地设置已清空', !String(lsMap.get('dsh-netease-lyrics:settings') || '').includes('two-lines'), String(lsMap.get('dsh-netease-lyrics:settings')));
check('reset 打到宿主接口', injectCalls.includes('config-reset'), JSON.stringify(injectCalls));

console.log('== 效果轮换与「减少动态效果」（回归：曾经永远只出 karaoke）==');
{
  const pool = ['karaoke', 'typewriter', 'blurReveal', 'neonPulse', 'tilt3d'];
  const withPool = (over = {}) => basePayload({
    config: { ...basePayload().config, effectPool: pool, reshuffle: 'auto', ...over },
  });

  const p1 = withPool(); p1.lyric = { ...p1.lyric, index: 1 };
  push(p1); tick(); tick();
  const fx1 = slot().dataset.fx;
  const idx1 = pool.indexOf(fx1);
  nowMs += 31000;
  const p2 = withPool(); p2.lyric = { ...p2.lyric, index: 2 };
  push(p2); tick(); tick();
  const fx2 = slot().dataset.fx;
  check('auto 模式 30 秒后换效果', fx1 !== fx2, `${fx1} -> ${fx2}`);
  check('效果都取自效果池', pool.includes(fx1) && pool.includes(fx2));
  // 真正要保证的性质：沿时间推进能走遍整个效果池（而不是反复撞同一个）
  const walked = new Set([fx1, fx2]);
  const seenIdx = [];
  for (let i = 0; i < pool.length; i++) {
    nowMs += 31000;
    const p = withPool();
    p.lyric = { ...p.lyric, index: 50 + i };
    push(p); tick(); tick();
    seenIdx.push(pool.indexOf(slot().dataset.fx));
    walked.add(slot().dataset.fx);
  }
  check('自动轮换能走遍效果池', walked.size === pool.length, `走到 ${walked.size}/${pool.length}: ${[...walked].join(',')}`);
  check('轮换顺序是循环递增的（不是随机）', seenIdx.every((v, i) => i === 0 || v === (seenIdx[i - 1] + 1) % pool.length), seenIdx.join('->'));

  const q1 = withPool({ reshuffle: 'song' }); q1.pluginVersion = '0.2.0'; q1.lyric = { ...q1.lyric, index: 10 };
  push(q1); tick(); tick();
  const s1 = slot().dataset.fx;
  nowMs += 61000;
  const q2 = withPool({ reshuffle: 'song' }); q2.pluginVersion = '0.2.0'; q2.lyric = { ...q2.lyric, index: 11 };
  push(q2); tick(); tick();
  check('song 模式同一首歌保持不变', slot().dataset.fx === s1, `${s1} -> ${slot().dataset.fx}`);

  reduced = true; // 模拟系统开启「减少动态效果」
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    const p = withPool({ respectReducedMotion: true });
    p.lyric = { ...p.lyric, index: 100 + i };
    push(p); tick(); tick();
    seen.add(slot().dataset.fx);
    nowMs += 31000;
  }
  check('减少动态下效果仍然多样（不再锁死 karaoke）', seen.size >= 3, [...seen].join(','));
  check('减少动态下打上 data-calm', slot().dataset.calm === '1', String(slot().dataset.calm));

  const rainCalm = withPool({ reshuffle: 'song', effectPool: ['rain'], respectReducedMotion: true });
  rainCalm.lyric = { ...rainCalm.lyric, index: 200 };
  push(rainCalm); tick(); tick();
  check('减少动态时不生成字雨粒子', bodyEl.findClass('dnl-drop').length === 0, String(bodyEl.findClass('dnl-drop').length));

  const rainOn = withPool({ reshuffle: 'song', effectPool: ['rain'], respectReducedMotion: false });
  rainOn.lyric = { ...rainOn.lyric, index: 201 };
  push(rainOn); tick(); tick();
  check('忽略减少动态时不打 calm', slot().dataset.calm === '0', String(slot().dataset.calm));
  reduced = false;
}

console.log('== 歌名卡片守卫（client 侧，随刷新生效）==');
{
  const card = basePayload({ config: basePayload().config });
  card.lyric = { ...card.lyric, index: 400, original: { text: 'Lone Wolf (Instrumental) - Synthion', ts: 'x' }, translation: null };
  card.track = { raw: 'Lone Wolf (Instrumental) - Synthion', song: 'Lone Wolf (Instrumental)', artist: 'Synthion' };
  push(card); tick(); tick();
  check('歌名卡片不显示（层隐藏）', layer().dataset.hidden === '1', layer().dataset.hidden);

  const real = basePayload({ config: basePayload().config });
  real.lyric = { ...real.lyric, index: 401, original: { text: 'You kissed my dream', ts: 'x' } };
  push(real); tick(); tick();
  check('正常歌词照常显示', layer().dataset.hidden === '0' && main().textContent === 'You kissed my dream');

  const similar = basePayload({ config: basePayload().config });
  similar.lyric = { ...similar.lyric, index: 402, original: { text: 'Lone Wolf', ts: 'x' }, translation: null };
  similar.track = { raw: 'Lone Wolf (Instrumental) - Synthion', song: 'Lone Wolf (Instrumental)', artist: 'Synthion' };
  push(similar); tick(); tick();
  check('只是歌名一部分的歌词不被误杀', layer().dataset.hidden === '0', layer().dataset.hidden);
}

console.log('== 旧宿主兼容垫片 ==');
{
  // basePayload 不带 pluginVersion（= 旧宿主），其 config.reshuffle 是旧的 'song'
  const oldHost = basePayload({ config: { ...basePayload().config, reshuffle: 'song', effectPool: ['karaoke', 'typewriter'] } });
  push(oldHost); tick(); tick();
  const a = slot().dataset.fx;
  nowMs += 31000;
  const oldHost2 = basePayload({ config: { ...oldHost.config } });
  oldHost2.lyric = { ...oldHost2.lyric, index: 300 };
  push(oldHost2); tick(); tick();
  check('旧宿主不报 pluginVersion 时默认升级为轮换', slot().dataset.fx !== a, `${a} -> ${slot().dataset.fx}`);

  // 用户显式设过 reshuffle → 不干预
  const explicit = basePayload({ config: { ...oldHost.config, reshuffle: 'song' }, pluginVersion: '0.2.0' });
  push(explicit); tick(); tick();
  const b = slot().dataset.fx;
  nowMs += 31000;
  const explicit2 = basePayload({ config: { ...oldHost.config, reshuffle: 'song' }, pluginVersion: '0.2.0' });
  explicit2.lyric = { ...explicit2.lyric, index: 301 };
  push(explicit2); tick(); tick();
  check('新宿主/显式 song 时保持每首歌固定', slot().dataset.fx === b, `${b} -> ${slot().dataset.fx}`);
}

console.log('== 自动对齐下的缓动滑动 ==');
{
  const autoCfg = (over = {}) => basePayload({
    config: { ...basePayload().config, band: 'auto', align: 'auto', autoGlide: true, glideMs: 800, reshuffle: 'line', effectPool: ['karaoke', 'typewriter', 'blurReveal'], ...over },
  });
  // line 模式每句换落点，最方便观测
  // 每句之间推进 600ms：模拟正常节奏（超过默认 500ms 短句防抖）
  const pushLine = (i) => { nowMs += 600; const p = autoCfg(); p.lyric = { ...p.lyric, index: i }; push(p); tick(); };

  pushLine(1); tick();
  const startX = gdx(), startY = gdy();

  // 推进若干句，直到落点确实变了
  let changed = null;
  for (let i = 2; i <= 8 && !changed; i++) {
    pushLine(i);
    const before = { x: gdx(), y: gdy() };
    tick(100);   // 滑动进行中
    if (Math.abs(gdx() - before.x) > 0.5 || Math.abs(gdy() - before.y) > 0.5) changed = { before, mid: { x: gdx(), y: gdy() } };
  }
  check('轮换落点时会滑动（位移逐帧变化）', !!changed, changed ? JSON.stringify(changed) : 'no movement');

  if (changed) {
    const from = changed.before;
    // 滑动过程中应出现"既不是起点也不是终点"的中间值
    tick(120);
    const mid2 = { x: gdx(), y: gdy() };
    check('滑动过程中有中间帧（不是瞬间跳变）', Math.abs(mid2.x - from.x) > 0.5 || Math.abs(mid2.y - from.y) > 0.5, JSON.stringify({ from, mid2 }));
    // 时长走完后应停在目标点（此后不再动）
    for (let i = 0; i < 12; i++) tick(100);
    const settled = { x: gdx(), y: gdy() };
    tick(200);
    check('滑动结束后停在目标点', Math.abs(gdx() - settled.x) < 0.01 && Math.abs(gdy() - settled.y) < 0.01, `${JSON.stringify(settled)} -> ${gdx()},${gdy()}`);
    check('位移层承担滑动、不碰特效自己的 transform', slot().style.getPropertyValue('--dnl-dx') === '', slot().style.getPropertyValue('--dnl-dx'));
  }

  // 关闭滑动：位移应归零
  const off = autoCfg({ autoGlide: false }); off.lyric = { ...off.lyric, index: 50 };
  push(off); tick(); tick();
  check('autoGlide=false → 不滑动（位移为 0）', Math.abs(gdx()) < 0.01 && Math.abs(gdy()) < 0.01, `${gdx()},${gdy()}`);

  // 固定对齐：即使开了滑动也不该动
  const fixed = autoCfg({ band: 'bottom', align: 'center', autoGlide: true }); fixed.lyric = { ...fixed.lyric, index: 60 };
  push(fixed); tick(); tick();
  check('固定对齐时不滑动', Math.abs(gdx()) < 0.01 && Math.abs(gdy()) < 0.01, `${gdx()},${gdy()}`);

  // 减少动态：直接落位，不做动画
  reduced = true;
  const calm = autoCfg({ respectReducedMotion: true }); calm.lyric = { ...calm.lyric, index: 70 };
  push(calm); tick();
  const jump = { x: gdx(), y: gdy() };
  tick(100); tick(100);
  check('减少动态下直接落位（无动画）', Math.abs(gdx() - jump.x) < 0.01 && Math.abs(gdy() - jump.y) < 0.01, `${JSON.stringify(jump)} -> ${gdx()},${gdy()}`);
  reduced = false;

  // 缓动方程本身：抽到"回弹/弹性"这类 overshoot 曲线时，过程中应冲过目标点再回落
  let overshootSeen = false, easeNames = new Set(), overshootTried = 0;
  for (let i = 90; i < 140 && !overshootSeen; i++) {
    nowMs += 700;
    const p = autoCfg({ reshuffle: 'line', band: 'auto', align: 'auto' });
    p.lyric = { ...p.lyric, index: i };
    push(p); tick();
    const name = glideEl().dataset.ease;
    if (!name) continue;
    easeNames.add(name);
    if (name !== 'outBack' && name !== 'outElastic' && name !== 'outBounce') continue;
    overshootTried++;
    const from = { x: gdx(), y: gdy() };
    // 走完整个滑动，记录是否越过终点（终点 = 结束后稳定值）
    for (let k = 0; k < 14; k++) tick(80);
    const end = { x: gdx(), y: gdy() };
    const spanX = end.x - from.x, spanY = end.y - from.y;
    if (Math.abs(spanX) < 2 && Math.abs(spanY) < 2) continue;   // 这次落点没变，跳过
    const p2 = autoCfg({ reshuffle: 'line', band: 'auto', align: 'auto' });
    p2.lyric = { ...p2.lyric, index: i };
    // 重新跑一遍，逐帧采样看有没有越过终点
    nowMs += 700;
    push(p2); tick();
    for (let k = 0; k < 14; k++) {
      tick(40);
      const overshootX = spanX > 0 ? gdx() > end.x + 0.5 : gdx() < end.x - 0.5;
      const overshootY = spanY > 0 ? gdy() > end.y + 0.5 : gdy() < end.y - 0.5;
      if (overshootX || overshootY) { overshootSeen = true; break; }
    }
  }
  check('缓动方程池被实际使用（多种曲线）', easeNames.size >= 2, [...easeNames].join(','));
  check('带 overshoot 的缓动会冲过目标点再回落', overshootSeen, `尝试 ${overshootTried} 次, 曲线: ${[...easeNames].join(',')}`);

  // 复位到固定，避免影响后续用例
  const back = autoCfg({ band: 'bottom', align: 'center', autoGlide: false }); back.lyric = { ...back.lyric, index: 80 };
  push(back); tick(); tick();
}

console.log('== 未唱部分的可见性与填充进度（回归：只剩第一个字亮、其余是黑影）==');
{
  const CSS_TEXT = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  check('karaoke/gradientSweep 不再用深色 text-shadow', (() => {
    const kara = /data-fx="karaoke"\]\s*\.dnl-main\{([^}]*)\}/.exec(CSS_TEXT);
    const grad = /data-fx="gradientSweep"\]\s*\.dnl-main\{([^}]*)\}/.exec(CSS_TEXT);
    return !!kara && !!grad && kara[1].includes('text-shadow:none') && grad[1].includes('text-shadow:none');
  })());
  check('未唱部分的不透明度提到 60% 以上', /--dnl-dim:color-mix\(in srgb,var\(--dnl-fg\)\s*(\d+)%/.test(CSS_TEXT) && Number(/--dnl-dim:color-mix\(in srgb,var\(--dnl-fg\)\s*(\d+)%/.exec(CSS_TEXT)[1]) >= 60);

  const slotPf = () => parseFloat(slot().style.getPropertyValue('--dnl-pf') || '0');
  const slotP = () => parseFloat(slot().style.getPropertyValue('--dnl-p') || '0');
  const longLine = (spanMs) => {
    const p = basePayload({ config: { ...basePayload().config, effectPool: ['karaoke'], reshuffle: 'song' } });
    p.lyric = { ...p.lyric, index: 500, startTs: nowMs, endTs: nowMs + spanMs };
    return p;
  };

  push(longLine(4000)); tick();
  check('句首就有起步填充（第一个字是亮的）', slotPf() >= 0.05, String(slotPf()));
  nowMs += 2000; tick();
  check('半程已基本唱满（提前 0.85×）', slotPf() > 0.55, String(slotPf()));
  nowMs += 2000; tick();
  check('句尾唱满', slotPf() > 0.99, String(slotPf()));

  // 长间奏（20 秒）不该让整句一直不亮
  push(longLine(20000)); tick();
  nowMs += 11000; tick();
  check('长间奏句也会在 ~10 秒内唱满（不是等 20 秒）', slotPf() > 0.99, String(slotPf()));
  check('时间进度 --dnl-p 仍然是真实的（给 marquee/orbit 用）', slotP() < 0.99, String(slotP()));

  // 未唱部分亮度可调
  const dimCfg = basePayload({ config: { ...basePayload().config, effectPool: ['karaoke'], unsungAlpha: 0.9 } });
  dimCfg.lyric = { ...dimCfg.lyric, index: 600 };
  push(dimCfg); tick();
  check('未唱部分亮度跟随设置（90%）', slot().style.getPropertyValue('--dnl-dim').includes('90%'), slot().style.getPropertyValue('--dnl-dim'));
  const dimCfg2 = basePayload({ config: { ...basePayload().config, effectPool: ['karaoke'], unsungAlpha: 0.3 } });
  dimCfg2.lyric = { ...dimCfg2.lyric, index: 601 };
  push(dimCfg2); tick();
  check('调低也生效（30%）', slot().style.getPropertyValue('--dnl-dim').includes('30%'), slot().style.getPropertyValue('--dnl-dim'));
}

console.log('== clipped-text 效果的可读性（回归：真机只有第一个字亮）==');
{
  const C = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  // Chrome 的坑：background-clip:text 的元素里，子元素一旦有 transform，
  // 贴在字形上的背景遮罩只覆盖第一个字 —— 表现就是"只有第一个字亮，其余没有背景可显示"。
  // 所以 karaoke / gradientSweep 这两类"用背景给文字上色"的效果，绝不能给逐字 span 写 transform。
  check('karaoke 不给逐字 span 加 transform', !/data-fx="karaoke"\]\s*\.dnl-ch\{[^}]*transform/.test(C));
  check('gradientSweep 不给逐字 span 加 transform', !/data-fx="gradientSweep"\]\s*\.dnl-ch\{[^}]*transform/.test(C));
  check('karaoke 仍保留"用渐变给文字上色"的实现', /data-fx="karaoke"\]\s*\.dnl-main\{[^}]*background-clip:text/.test(C));
  check('未唱亮度用 CSS 变量下发（不再写死在样式表里）', /--dnl-dim/.test(C) && /unsungAlpha/.test(C));
}

console.log('== 快歌适配：入场与揭示必须在句子结束前完成（回归：整句都糊着/在打字）==');
{
  const CSS_TEXT2 = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  check('逐字揭示类效果用自适应进度 --dnl-pr', /data-fx="typewriter"\]\s*\.dnl-ch\{[^}]*--dnl-pr/.test(CSS_TEXT2) && /data-fx="orbit"\]\s*\.dnl-ch\{[^}]*--dnl-pr/.test(CSS_TEXT2));

  let seq = 700;
  const fastLine = (spanMs, over = {}) => {
    const p = basePayload({ config: { ...basePayload().config, effectPool: ['blurReveal'], reshuffle: 'song', ...over } });
    // 每句用不同 index：同一 index+文本 不会重播入场（那是有意行为）
    p.lyric = { ...p.lyric, index: ++seq, startTs: nowMs, endTs: nowMs + spanMs };
    return p;
  };
  const inVal = () => parseFloat(slot().style.getPropertyValue('--dnl-in') || '0');
  const prVal = () => parseFloat(slot().style.getPropertyValue('--dnl-pr') || '0');

  // 1.6 秒的短句（真机实测就是 1.4~1.7s）
  push(fastLine(1600)); tick();
  nowMs += 300; tick();
  check('短句入场在 300ms 内完成（不再糊着）', inVal() >= 0.99, String(inVal()));
  nowMs += 300; tick();
  check('短句揭示在 600ms 内基本出完', prVal() >= 0.9, String(prVal()));

  // 入场时长配置生效（长句时才不会被 35% 上限压到）
  push(fastLine(12000, { enterMs: 1200 })); tick();
  nowMs += 400; tick();
  check('长句时入场时长按配置走（400ms 时仍在入场）', inVal() > 0.2 && inVal() < 0.9, String(inVal()));
  nowMs += 1000; tick();
  check('抵达配置时长后完成', inVal() >= 0.99, String(inVal()));

  // 入场不会被配置值拖到超过句长 35%
  push(fastLine(1600, { enterMs: 1200 })); tick();
  nowMs += 560; tick();
  check('短句时配置值被 35% 上限压缩（560ms 已完成）', inVal() >= 0.99, String(inVal()));
}

console.log('== 短间隔防抖（连词/快歌时只原位换字）==');
{
  const rapidCfg = (over = {}) => basePayload({
    config: {
      ...basePayload().config,
      band: 'auto', align: 'auto', autoGlide: true, glideMs: 800,
      moveDebounceMs: 500, reshuffle: 'line',
      effectPool: ['karaoke', 'typewriter', 'blurReveal', 'neonPulse'],
      ...over,
    },
  });
  const lineAt = (idx, startTs, over = {}) => {
    const p = rapidCfg(over);
    p.lyric = { ...p.lyric, index: idx, startTs, endTs: startTs + 1600, original: { text: `第${idx}句`, ts: '' } };
    return p;
  };
  const glides = () => Number(glideEl().dataset.glides || 0);
  const settle = (n = 15) => { for (let i = 0; i < n; i++) tick(100); };

  const T = 2_000_000;
  nowMs = T;
  push(lineAt(1, T)); tick();
  settle();                                   // 让第一句的滑动走完
  const settledX = gdx(), settledY = gdy();
  const g0 = glides();
  const fx0 = slot().dataset.fx;
  check('正常节奏会启动滑动', g0 > 0, String(g0));

  // 把时钟拨回"第一句之后 300ms"，构造短间隔（视觉状态仍是已落位）
  nowMs = T + 300;
  push(lineAt(2, T + 300)); tick();
  check('短间隔时不启动新的滑动', glides() === g0, `${g0} -> ${glides()}`);
  check('短间隔时文字已更新', main().textContent === '第2句', main().textContent);
  check('短间隔时保持同样样式（效果不变）', slot().dataset.fx === fx0, fx0 + ' -> ' + slot().dataset.fx);
  check('短间隔时不重播入场（--dnl-in 直接为 1）', parseFloat(slot().style.getPropertyValue('--dnl-in')) >= 0.99,
    slot().style.getPropertyValue('--dnl-in'));
  check('短间隔时不移动（仍在原落点）', Math.abs(gdx() - settledX) < 0.01 && Math.abs(gdy() - settledY) < 0.01,
    `${gdx()},${gdy()} vs ${settledX},${settledY}`);

  // 连续 300ms 连击（连词/快歌）
  for (let k = 3; k <= 6; k++) { nowMs += 300; push(lineAt(k, nowMs)); tick(); }
  check('连续连词全程不启动滑动', glides() === g0, `${g0} -> ${glides()}`);
  check('连词期间文字每次都更新', main().textContent === '第6句', main().textContent);
  check('连词期间位置不动', Math.abs(gdx() - settledX) < 0.01 && Math.abs(gdy() - settledY) < 0.01, `${gdx()},${gdy()}`);

  // 停下来（> 500ms）之后恢复移动
  nowMs += 1200;
  push(lineAt(9, nowMs)); tick();
  check('间隔恢复后重新启动滑动', glides() === g0 + 1, `${g0} -> ${glides()}`);
  settle();

  // 防抖设为 0：短间隔也照滑
  const g1 = glides();
  nowMs += 300;
  push(lineAt(10, nowMs, { moveDebounceMs: 0 })); tick();
  check('防抖设为 0 时不再拦截', glides() === g1 + 1, `${g1} -> ${glides()}`);
  settle();

  // 换歌：自然的重新落位时机，即使间隔很短
  const g2 = glides();
  nowMs += 200;
  const p6 = lineAt(11, nowMs);
  p6.track = { raw: '另一首歌 - 别人', song: '另一首歌', artist: '别人' };
  push(p6); tick();
  check('换歌时不防抖（立刻重新落位）', glides() === g2 + 1, `${g2} -> ${glides()}`);
  settle();

  // 复位到固定对齐，避免影响后续用例
  nowMs += 1000;
  const back = basePayload({ config: { ...basePayload().config, band: 'bottom', align: 'center', autoGlide: false, moveDebounceMs: 500 } });
  back.lyric = { ...back.lyric, index: 900, startTs: nowMs, endTs: nowMs + 4000 };
  push(back); tick(); tick();
}
console.log('== 回收 ==');
for (const d of cleanupFns) d();
check('层已从 body 移除', layer().removed === true || bodyEl.findClass('dnl-layer').length === 0);
check('设置 UI 容器也已移除', bodyEl.findClass('dnl-ui')[0].removed === true || bodyEl.findClass('dnl-ui').length === 0);
check('style 已移除', headEl.children.every((c) => c.tagName !== 'STYLE' || c.removed === true));
check('回收时玻璃化令牌被还原', rootEl.style.getPropertyValue('--dsw-alias-bg-layer-1') === '', rootEl.style.getPropertyValue('--dsw-alias-bg-layer-1'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
