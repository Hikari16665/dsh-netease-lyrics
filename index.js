/**
 * dsh-netease-lyrics — host half
 *
 * 职责：
 *   1. 把 bin/ 里的三件套暂存到 $DSH_HOME/netease-lyrics/（普通 ACL，没有 Low 完整性标签，
 *      否则用户从工作区双击注入器会继承 Low IL 而注入失败 err=5 —— 这是实测踩过的坑）
 *   2. 常驻 lyricstream.exe，读它的 NDJSON 事件流，喂给 pairing.js 得到「歌词槽」
 *   3. 必要时注入 lyrichook64.dll（通道不存在时）；注入失败就给出可双击的手动脚本
 *   4. 通过 webServer 暴露 /state、/stream(SSE)、/inject、/reveal
 *
 * 只在 host 侧持有状态；client 侧只做渲染（配置随 /state 一起下发）。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createLyricState } from './pairing.js';
import { shouldAttemptInject, isStaleChannel } from './inject-policy.js';

const PLUGIN_VERSION = '0.2.0';
/** 齿轮面板可改、且必须立即影响宿主行为的字段（其余字段只影响渲染，由 client 本地生效） */
export const HOST_SIDE_KEYS = ['pairWindowMs', 'pairSameScript', 'filterPatterns', 'pairDebug', 'enabled', 'source'];

/* Config schema：优先用声明在 package.json 里的 schemastery；装不上时回落到随包的副本，
   这样无论 profile 是 hoisted 还是 isolated 布局、插件是 link 还是 copy，都能起来。 */
let Schema;
try {
  ({ default: Schema } = await import('schemastery'));
} catch {
  ({ default: Schema } = await import('./vendor/schemastery/lib/index.mjs'));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(HERE, 'bin');
const ROUTE_BASE = '/dsh-netease-lyrics';
const HELPER_BINARIES = ['lyricstream.exe', 'inject.exe', 'lyrichook64.dll'];

export const name = 'netease-lyrics';
/** webServer 提供路由；subprocess 用来常驻 helper 与注入器 */
export const inject = ['webServer', 'subprocess'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关：关闭后不启动 helper、不挂载歌词层'),
  zIndex: Schema.number().default(-1).description('歌词层 z-index：-1 = 壁纸之上/聊天之下；正数会浮到界面之上'),

  // ── 显示 ──
  effectPool: Schema.array(Schema.string())
    .default(['karaoke', 'typewriter', 'blurReveal', 'neonPulse', 'tilt3d', 'rain', 'marquee', 'orbit', 'glassCard', 'gradientSweep'])
    .description('参与随机的效果 id 池（留空 = 全集）'),
  autoGlide: Schema.boolean().default(true).description('自动对齐时，轮换落点用缓动方程滑动过去（活泼感）；关掉则直接切位置'),
  glideMs: Schema.number().min(200).max(3000).step(50).default(900).description('缓动滑动时长（毫秒）'),
  reshuffle: Schema.union(['song', 'line', 'auto']).default('auto')
    .description('换场节奏：auto（默认）=每 30 秒沿效果池顺序轮换，保证一首歌里能看到多种效果；song=每首歌固定一套；line=每句换'),
  band: Schema.union(['auto', 'top', 'middle', 'bottom']).default('auto').description('垂直位置（auto=按歌曲随机）'),
  align: Schema.union(['auto', 'left', 'center', 'right']).default('auto').description('水平对齐（auto=按歌曲随机）'),
  fontScale: Schema.number().min(0.6).max(2).step(0.05).default(1).description('字号倍率'),
  opacity: Schema.number().min(0.1).max(1).step(0.05).default(0.85).description('歌词层整体不透明度'),
  unsungAlpha: Schema.number().min(0.15).max(1).step(0.01).default(0.68)
    .description('逐字效果里「还没唱到」部分的亮度；调太低会只剩第一个字看得见'),
  enterMs: Schema.number().min(120).max(1200).step(20).default(280)
    .description('入场动画时长；会自动压缩到句长的 35% 以内，避免快歌整句都在入场'),
  showTrackTitle: Schema.boolean().default(false).description('在歌词下方显示「歌名 - 歌手」'),
  idleFadeSec: Schema.number().min(0).max(120).step(1).default(15).description('无歌词活动多久后淡出（0=不淡出）'),
  respectReducedMotion: Schema.boolean().default(true).description('系统开启「减少动态效果」时退化为静态高亮'),

  // ── 配对与显示（核心） ──
  pairMode: Schema.union(['stacked', 'original-only', 'translation-only', 'two-lines']).default('stacked')
    .description('配对显示：stacked=原文+译文小字 / original-only=只显示原文 / translation-only=只显示翻译 / two-lines=当成两段歌词依次显示'),
  pairWindowMs: Schema.number().min(200).max(5000).step(50).default(1200)
    .description('配对时间窗：同一秒内、且在这个时间差内到达的后一句视为译文'),
  pairSameScript: Schema.union(['separate', 'stack']).default('separate')
    .description('两句脚本相同（都像中文）时：separate=当成两句独立歌词 / stack=仍按原文+译文处理'),
  translationFallback: Schema.union(['original', 'hide']).default('original')
    .description('translation-only 模式下该句没有译文时：回落显示原文 / 整句不显示'),
  pairDebug: Schema.boolean().default(false).description('在 /state 里附带配对判定细节（排查用）'),

  // ── 内容过滤 ──
  filterPatterns: Schema.array(Schema.string())
    .default(['纯音乐', '请欣赏', '作词', '作曲', '编曲'])
    .description('命中任一子串的歌词行直接跳过（先过滤再配对）'),

  // ── 玻璃化（让歌词透出面板） ──
  glassMode: Schema.union(['auto', 'on', 'off']).default('auto')
    .description('面板不透明时自动把外壳半透明以便看见歌词；off=保持面板不透明（歌词只在框架间隙可见）'),
  glassStrength: Schema.number().min(0).max(1).step(0.05).default(0.35).description('玻璃化强度'),

  // ── 数据源 ──
  source: Schema.object({
    autoInject: Schema.boolean().default(true).description('通道不存在时自动注入 hook DLL'),
    shmName: Schema.string().default('').description('共享内存名（留空=Local\\NeteaseLyricsBuffer）'),
    evtName: Schema.string().default('').description('事件名（留空=Local\\NeteaseLyricsEvent）'),
    processName: Schema.string().default('cloudmusic.exe').description('目标进程名'),
  }).description('歌词通道与注入设置'),
});

/** 状态指纹：只有真正变化才推 SSE */
function signature(s) {
  const l = s.lyric;
  return [
    s.channel.state, s.channel.desktopLyrics, s.channel.visible,
    s.track.raw,
    l ? `${l.index}:${l.original.text}:${l.translation ? l.translation.text : ''}:${l.startTs}` : '-',
    s.inject.status,
  ].join('|');
}

export function apply(ctx, config) {
  const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh');
  const stageDir = join(dshHome, 'netease-lyrics');
  const settingsPath = join(stageDir, 'settings.json');

  /** 读齿轮面板保存的设置（$DSH_HOME/netease-lyrics/settings.json） */
  function readSavedSettings() {
    try {
      if (!existsSync(settingsPath)) return {};
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      ctx.logger?.warn?.(`netease-lyrics: settings.json 解析失败，忽略：${err}`);
      return {};
    }
  }

  // 生效配置 = schema 默认值 ← profile 行 config ← 齿轮面板保存值
  let savedSettings = readSavedSettings();
  let cfg = Config({ ...(config ?? {}), ...savedSettings });

  const state = createLyricState({
    pairWindowMs: cfg.pairWindowMs,
    pairSameScript: cfg.pairSameScript,
    filterPatterns: cfg.filterPatterns,
    pairDebug: cfg.pairDebug,
  });

  const clients = new Set();
  const disposers = [];
  let helper = null;
  let helperStderr = '';
  let restartDelay = 1000;
  let restartTimer = null;
  let watchdog = null;
  let stopping = false;
  let lastEventAt = Date.now();
  let lastPush = 0;
  let injectState = { status: 'idle', message: '', stagedDir: stageDir, manualScript: join(stageDir, 'install-hook.cmd') };
  let lastInjectAt = 0;
  let lastLineAt = 0;
  let prevDlHwnd = '';
  let lastSig = '';
  let configRevision = 0;

  ctx.logger?.info?.(`netease-lyrics: staging dir = ${stageDir}`);

  // ───────────────────────── 1. 暂存二进制与手动脚本 ─────────────────────────
  function stageBinaries() {
    mkdirSync(stageDir, { recursive: true });
    for (const f of HELPER_BINARIES) {
      const from = join(BIN_DIR, f);
      const to = join(stageDir, f);
      if (!existsSync(from)) continue;
      let copy = true;
      try {
        if (existsSync(to) && statSync(to).size === statSync(from).size) copy = false;
      } catch { /* 大小读不到就重拷 */ }
      if (copy) copyFileSync(from, to);
    }
    const target = String(cfg.source?.processName ?? 'cloudmusic.exe').trim() || 'cloudmusic.exe';
    const cmd = [
      '@echo off',
      'rem one-click hook install for DSH netease-lyrics plugin',
      'chcp 65001 >nul',
      `cd /d "%~dp0"`,
      `echo Installing lyric hook into ${target} ...`,
      `inject.exe ${target} "%~dp0lyrichook64.dll"`,
      'echo.',
      'echo Done. Return to the DSH page; lyrics should appear within a few seconds.',
      'pause',
      '',
    ].join('\r\n');
    try { writeFileSync(join(stageDir, 'install-hook.cmd'), cmd, 'latin1'); } catch { /* 忽略 */ }
  }

  // ───────────────────────── 2. helper 生命周期 ─────────────────────────
  function helperArgv() {
    const argv = [join(stageDir, 'lyricstream.exe')];
    const shmName = String(cfg.source?.shmName ?? '').trim();
    const evtName = String(cfg.source?.evtName ?? '').trim();
    if (shmName) argv.push('--shm', shmName);
    if (evtName) argv.push('--evt', evtName);
    return argv;
  }

  function scheduleRestart(reason) {
    if (stopping || restartTimer) return;
    ctx.logger?.warn?.(`netease-lyrics: helper restart in ${restartDelay}ms (${reason})`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startHelper();
    }, restartDelay);
    restartDelay = Math.min(30000, restartDelay * 2);
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text || text[0] !== '{') return;
    let ev;
    try { ev = JSON.parse(text); } catch { return; }
    ev._at = Date.now();
    lastEventAt = ev._at;
    if (ev.type === 'line') lastLineAt = ev._at;
    state.pushEvent(ev);
    if (ev.type === 'status') {
      const verdict = shouldAttemptInject({
        autoInject: cfg.source?.autoInject !== false,
        desktopLyrics: ev.desktopLyrics ?? 0,
        createdByUs: ev.created === true,
        dlHwnd: ev.dlHwnd ?? '',
        prevDlHwnd,
        lastInjectAt,
        now: ev._at,
      });
      if (ev.dlHwnd) prevDlHwnd = ev.dlHwnd;
      if (verdict.attempt) {
        lastInjectAt = ev._at;
        ctx.logger?.info?.(`netease-lyrics: injecting (${verdict.reason})`);
        void tryInject(`auto: ${verdict.reason}`);
      } else if (!injectState.status || injectState.status === 'idle') {
        injectState = { ...injectState, status: 'skipped', message: `已存在歌词通道，直接只读消费（${verdict.reason}）` };
      }
    }
    pushState(ev.type === 'line');
  }

  function startHelper() {
    if (stopping) return;
    try {
      const h = ctx.subprocess.spawn({
        argv: helperArgv(),
        cwd: stageDir,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 5000,
      });
      helper = h;
      restartDelay = 1000;
      lastEventAt = Date.now();

      let buf = '';
      h.stdout?.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const one = buf.slice(0, i);
          buf = buf.slice(i + 1);
          handleLine(one);
        }
        if (buf.length > 1 << 20) buf = ''; // 防御：单行超长
      });
      h.stderr?.on('data', (chunk) => {
        helperStderr = (helperStderr + chunk.toString('utf8')).slice(-2000);
      });
      h.done.then((outcome) => {
        if (helper === h) helper = null;
        scheduleRestart(`exit=${outcome?.exitCode ?? '?'} ${helperStderr.slice(-200)}`);
      }).catch((err) => {
        if (helper === h) helper = null;
        scheduleRestart(`spawn failed: ${err}`);
      });
    } catch (err) {
      scheduleRestart(`spawn threw: ${err}`);
    }
  }

  // ───────────────────────── 3. 注入 ─────────────────────────
  async function runExe(argv, timeoutMs) {
    const h = ctx.subprocess.spawn({
      argv,
      cwd: stageDir,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: timeoutMs,
    });
    let out = '', err = '';
    h.stdout?.on('data', (c) => { out = (out + c.toString('utf8')).slice(-4000); });
    h.stderr?.on('data', (c) => { err = (err + c.toString('utf8')).slice(-4000); });
    const outcome = await h.done.catch((e) => ({ exitCode: -1, error: String(e) }));
    return { code: outcome?.exitCode ?? -1, out, err };
  }

  async function tryInject(kind) {
    const processName = String(cfg.source?.processName ?? 'cloudmusic.exe').trim() || 'cloudmusic.exe';
    const r = await runExe([join(stageDir, 'inject.exe'), processName, join(stageDir, 'lyrichook64.dll')], 20000);
    const tail = (r.out + r.err).trim().split('\n').slice(-2).join(' ').trim();
    if (r.code === 0) {
      injectState = { ...injectState, status: 'injected', message: `已注入 ${processName}（${kind}）` };
    } else if (r.code === 5 || /OpenProcess 失败 err=5/.test(r.out)) {
      injectState = {
        ...injectState, status: 'needs-manual',
        message: '注入被拒绝（err=5）：DSH 进程的完整性级别低于网易云。请双击 install-hook.cmd 手动注入一次。',
      };
    } else {
      injectState = { ...injectState, status: 'failed', message: `注入失败 code=${r.code} ${tail}` };
    }
    pushState(true);
    return injectState;
  }

  // ───────────────────────── 4. 状态与推送 ─────────────────────────
  function snapshot() {
    const base = state.snapshot();
    const now = Date.now();
    return {
      ...base,
      channel: {
        ...base.channel,
        stale: isStaleChannel({ desktopLyrics: base.channel.desktopLyrics, lastLineAt, now }),
      },
      connected: base.channel.state === 'attached',
      pluginVersion: PLUGIN_VERSION,
      inject: injectState,
      configRevision,
      config: publicConfig(),
    };
  }

  function pushState(force) {
    const now = Date.now();
    const sig = signature({ ...state.snapshot(), inject: injectState });
    if (!force && sig === lastSig) return;
    if (!force && now - lastPush < 100) return; // 合并高频变化
    lastSig = sig;
    lastPush = now;
    let payload;
    try { payload = JSON.stringify(snapshot()); } catch { return; }
    const frame = `event: state\ndata: ${payload}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  // ───────────────────────── 5. 路由 ─────────────────────────
  function register(route) {
    const d = ctx.webServer.register(route);
    if (typeof d === 'function') disposers.push(d);
    else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose());
  }

  function json(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  /** 下发给 client 的生效配置 */
  function publicConfig() {
    return {
      enabled: cfg.enabled !== false,
      zIndex: cfg.zIndex, effectPool: cfg.effectPool, reshuffle: cfg.reshuffle,
      autoGlide: cfg.autoGlide, glideMs: cfg.glideMs,
      band: cfg.band, align: cfg.align, fontScale: cfg.fontScale, opacity: cfg.opacity,
      unsungAlpha: cfg.unsungAlpha, enterMs: cfg.enterMs,
      showTrackTitle: cfg.showTrackTitle, idleFadeSec: cfg.idleFadeSec,
      respectReducedMotion: cfg.respectReducedMotion,
      pairMode: cfg.pairMode, pairWindowMs: cfg.pairWindowMs, pairSameScript: cfg.pairSameScript,
      translationFallback: cfg.translationFallback, pairDebug: cfg.pairDebug,
      filterPatterns: cfg.filterPatterns,
      glassMode: cfg.glassMode, glassStrength: cfg.glassStrength,
    };
  }

  /** 合并补丁 → schema 校验 → 落盘 → 立即生效 */
  function applyConfigPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'patch must be an object' };
    }
    let next;
    try {
      next = Config({ ...cfg, ...patch }); // schemastery 负责枚举/范围校验与类型归一
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    cfg = next;
    // 只把用户真改过的键落盘，保持 settings.json 可读
    savedSettings = { ...savedSettings, ...patch };
    try {
      mkdirSync(stageDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(savedSettings, null, 2), 'utf8');
    } catch (err) {
      ctx.logger?.warn?.(`netease-lyrics: 写 settings.json 失败：${err}`);
    }
    state.setConfig(cfg);
    injectState = { ...injectState, stagedDir: stageDir, manualScript: join(stageDir, 'install-hook.cmd') };
    configRevision++;
    try { stageBinaries(); } catch { /* 忽略 */ }
    pushState(true);
    return { ok: true, config: publicConfig(), saved: savedSettings };
  }

  function registerRoutes() {
    register({
      kind: 'exact', path: `${ROUTE_BASE}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        json(res, 200, snapshot());
      },
    });

    register({
      kind: 'exact', path: `${ROUTE_BASE}/stream`,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        try { res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`); } catch { /* 忽略 */ }
        clients.add(res);
        if (clients.size > 8) { // 上限 8 个订阅者，断最旧
          const oldest = clients.values().next().value;
          clients.delete(oldest);
          try { oldest.end(); } catch { /* 忽略 */ }
        }
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 15000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        req.on('error', () => { clearInterval(ping); clients.delete(res); });
      },
    });

    register({
      kind: 'exact', path: `${ROUTE_BASE}/inject`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        try {
          if (injectState.status === 'injected') { /* 允许重复注入（无害） */ }
          await tryInject('manual');
          json(res, 200, { ok: injectState.status === 'injected', inject: injectState });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
      },
    });

    register({
      kind: 'exact', path: `${ROUTE_BASE}/config`,
      handler: (req, res) => {
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, config: publicConfig(), saved: savedSettings, hostSideKeys: HOST_SIDE_KEYS });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
          let patch;
          try { patch = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
          const result = applyConfigPatch(patch?.patch ?? patch);
          json(res, result.ok ? 200 : 400, result);
        });
      },
    });

    register({
      kind: 'exact', path: `${ROUTE_BASE}/config/reset`,
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        savedSettings = {};
        try { writeFileSync(settingsPath, '{}\n', 'utf8'); } catch { /* 忽略 */ }
        cfg = Config({ ...(config ?? {}) });
        state.setConfig(cfg);
        configRevision++;
        pushState(true);
        json(res, 200, { ok: true, config: publicConfig() });
      },
    });

    register({
      kind: 'exact', path: `${ROUTE_BASE}/reveal`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        try {
          await runExe(['explorer.exe', stageDir], 5000);
          json(res, 200, { ok: true, dir: stageDir });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
      },
    });
  }

  // ───────────────────────── 6. 启动 ─────────────────────────
  try {
    stageBinaries();
  } catch (err) {
    ctx.logger?.warn?.(`netease-lyrics: staging failed: ${err}`);
  }
  registerRoutes();
  if (cfg.enabled !== false) startHelper();

  watchdog = setInterval(() => {
    if (stopping || cfg.enabled === false) return;
    const silent = Date.now() - lastEventAt;
    if (silent > 90000) {
      ctx.logger?.warn?.(`netease-lyrics: helper silent ${Math.round(silent / 1000)}s, restarting`);
      lastEventAt = Date.now();
      try { helper?.terminate(); } catch { /* 忽略 */ }
      helper = null;
      scheduleRestart('watchdog');
    }
  }, 20000);

  ctx.effect(() => () => {
    stopping = true;
    clients.clear();
    if (restartTimer) clearTimeout(restartTimer);
    if (watchdog) clearInterval(watchdog);
    for (const d of disposers.splice(0)) { try { d(); } catch { /* 忽略 */ } }
    try { helper?.terminate(); } catch { /* 忽略 */ }
    helper = null;
  });
}
