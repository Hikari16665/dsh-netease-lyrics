/**
 * host.test.mjs — 用 stub ctx 跑真实的 host 插件（子进程是真的 helper）
 * 验证：暂存、helper 常驻解析、/state、/stream、/inject 路由
 * 运行: node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { apply, Config } from '../index.js';

const routes = new Map();
const disposers = [];
let spawned = 0;

const ctx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  webServer: {
    register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); },
  },
  subprocess: {
    spawn: ({ argv, cwd, stdio, graceMs }) => {
      spawned++;
      const child = spawn(argv[0], argv.slice(1), {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      const done = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
        child.on('error', (e) => resolve({ exitCode: -1, signal: null, error: String(e) }));
      });
      return { stdout: child.stdout, stderr: child.stderr, done, terminate: () => { try { child.kill(); } catch {} } };
    },
  },
};

/** 假的 res：收集状态码与 body */
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: null,
    chunks,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    write(s) { chunks.push(String(s)); return true; },
    end(s) { if (s !== undefined) chunks.push(String(s)); this.ended = true; },
  };
}
const fakeReq = (method = 'GET', body = null) => ({
  method,
  _h: {},
  on(ev, cb) {
    (this._h[ev] ||= []).push(cb);
    if (body !== null) {
      if (ev === 'data') cb(Buffer.from(body));
      if (ev === 'end') setImmediate(() => cb());
    }
  },
  destroy() {},
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skipped = 0;
const skip = (name, why) => { skipped++; console.log(`  --  跳过 ${name}：${why}`); };
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};

console.log('== 启动 host 插件（真实 helper）==');
const cfg = Config({});
apply(ctx, cfg);

const stageDir = join((process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh'), 'netease-lyrics');
await sleep(1200);

check('路由已注册', routes.size === 6, `实际 ${routes.size}`);
check('helper 已启动', spawned >= 1, `spawned=${spawned}`);
check('三件套已暂存', ['lyricstream.exe', 'inject.exe', 'lyrichook64.dll'].every((f) => existsSync(join(stageDir, f))), stageDir);
check('手动注入脚本已生成', existsSync(join(stageDir, 'install-hook.cmd')));

await sleep(3000); // 等 helper 输出 status/track

console.log('== /state ==');
const resState = fakeRes();
await routes.get('/dsh-netease-lyrics/state').handler(fakeReq('GET'), resState);
const state = JSON.parse(resState.chunks.join(''));
check('HTTP 200', resState.statusCode === 200);
check('content-type 是 JSON', String(resState.headers['Content-Type']).includes('application/json'));
check('channel.state = attached', state.channel?.state === 'attached', JSON.stringify(state.channel));
check('config.pairMode 默认 stacked', state.config?.pairMode === 'stacked', String(state.config?.pairMode));
check('config 里带四种 pairMode 之外的渲染参数', typeof state.config?.glassMode === 'string' && typeof state.config?.zIndex === 'number');
check('captured 到了真实曲目名', !!(state.track && state.track.raw), JSON.stringify(state.track));
console.log(`       track=${state.track?.raw} | lyric=${state.lyric ? state.lyric.original.text : '(还没歌词)'} | inject=${state.inject?.status}`);

console.log('== 等待真实歌词（最多 30 秒）==');
let lyricSeen = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const rs = fakeRes();
  await routes.get('/dsh-netease-lyrics/state').handler(fakeReq('GET'), rs);
  const s = JSON.parse(rs.chunks.join(''));
  if (s.lyric) { lyricSeen = s; break; }
}
const noLyric = '30 秒内没有新歌词（当前曲目可能是纯音乐/已暂停），非代码问题';
if (lyricSeen) { pass++; console.log('  ok  拿到歌词槽'); } else skip('拿到歌词槽', noLyric);
if (!lyricSeen) { skip('槽里有 startTs/endTs', noLyric); skip('recent 至少一条', noLyric); }
if (lyricSeen) {
  console.log(`       lyric: "${lyricSeen.lyric.original.text}"` + (lyricSeen.lyric.translation ? ` / "${lyricSeen.lyric.translation.text}" (${lyricSeen.lyric.confidence})` : ''));
  check('槽里有 startTs/endTs', Number.isFinite(lyricSeen.lyric.startTs) && lyricSeen.lyric.endTs > lyricSeen.lyric.startTs);
  check('recent 至少一条', Array.isArray(lyricSeen.recent) && lyricSeen.recent.length >= 1);
}

console.log('== /stream (SSE) ==');
const resStream = fakeRes();
const sreq = { method: 'GET', on(ev, cb) { this['_' + ev] = cb; } };
routes.get('/dsh-netease-lyrics/stream').handler(sreq, resStream);
await sleep(400);
const firstFrame = resStream.chunks.join('');
check('SSE 头正确', String(resStream.headers['Content-Type']).includes('text/event-stream'));
check('首帧是 state 事件', firstFrame.includes('event: state'), firstFrame.slice(0, 80));
check('首帧 data 是可解析 JSON', (() => {
  const m = /data: (\{.*\})\n/.exec(firstFrame);
  if (!m) return false;
  try { JSON.parse(m[1]); return true; } catch { return false; }
})());

console.log('== 405 保护 ==');
const resBad = fakeRes();
await routes.get('/dsh-netease-lyrics/state').handler(fakeReq('POST'), resBad);
check('非 GET 返回 405', resBad.statusCode === 405);

console.log('== 齿轮面板的配置接口 ==');
{
  const r1 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('GET'), r1);
  const g1 = JSON.parse(r1.chunks.join(''));
  check('GET /config 返回生效配置', r1.statusCode === 200 && g1.config?.pairMode === 'stacked', JSON.stringify(g1.config?.pairMode));
  check('GET /config 声明宿主侧字段', Array.isArray(g1.hostSideKeys) && g1.hostSideKeys.includes('pairWindowMs'));

  // 改显示类字段（client 本地也生效，但接口同样接受）
  const r2 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('POST', JSON.stringify({ patch: { pairMode: 'two-lines', opacity: 0.6 } })), r2);
  await sleep(50);
  const g2 = JSON.parse(r2.chunks.join(''));
  check('POST /config 接受合法补丁', r2.statusCode === 200 && g2.config.pairMode === 'two-lines', JSON.stringify(g2));
  check('补丁写入了 settings.json', existsSync(join(stageDir, 'settings.json')));

  const r3 = fakeRes();
  await routes.get('/dsh-netease-lyrics/state').handler(fakeReq('GET'), r3);
  const s3 = JSON.parse(r3.chunks.join(''));
  check('/state 立即反映新配置', s3.config?.pairMode === 'two-lines' && s3.config?.opacity === 0.6, JSON.stringify(s3.config?.pairMode));

  // 宿主侧字段：配对窗口真的被状态机接受
  const r4 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('POST', JSON.stringify({ patch: { pairWindowMs: 2000, pairSameScript: 'stack' } })), r4);
  await sleep(50);
  check('宿主侧字段可写', JSON.parse(r4.chunks.join('')).config?.pairWindowMs === 2000);

  // 非法值必须被拒绝
  const r5 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('POST', JSON.stringify({ patch: { pairMode: 'nope' } })), r5);
  await sleep(50);
  check('非法枚举被拒绝(400)', r5.statusCode === 400, `${r5.statusCode} ${r5.chunks.join('')}`);
  const r6 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('POST', JSON.stringify({ patch: { pairWindowMs: 999999 } })), r6);
  await sleep(50);
  check('越界数值被拒绝(400)', r6.statusCode === 400);
  const r7 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('POST', 'not json'), r7);
  await sleep(50);
  check('坏 JSON 被拒绝(400)', r7.statusCode === 400);
  const r8 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('POST', JSON.stringify({ patch: { pairMode: 'nope' } })), r8);
  await sleep(50);
  const r9 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config').handler(fakeReq('GET'), r9);
  check('被拒绝的补丁没有污染生效配置', JSON.parse(r9.chunks.join('')).config.pairMode === 'two-lines');

  // 复位
  const r10 = fakeRes();
  await routes.get('/dsh-netease-lyrics/config/reset').handler(fakeReq('POST'), r10);
  await sleep(50);
  check('reset 回到默认', JSON.parse(r10.chunks.join('')).config?.pairMode === 'stacked');
}

console.log('== 回收 ==');
const resReveal = fakeRes();
await routes.get('/dsh-netease-lyrics/reveal').handler(fakeReq('POST'), resReveal);
check('/reveal 返回目录', (() => { try { return JSON.parse(resReveal.chunks.join('')).dir === stageDir; } catch { return false; } })());

for (const d of disposers) { try { d(); } catch {} }
await sleep(800);
check('dispose 后路由清空', routes.size === 0, `实际 ${routes.size}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项` + (skipped ? `（跳过 ${skipped} 项：依赖网易云正在播放歌词）` : ""));
process.exit(fail ? 1 : 0);
