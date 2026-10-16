/**
 * pairing.js — 网易云「原文 / 译文」配对与歌词槽状态机（纯逻辑，无 IO，可单测）
 *
 * 逆向结论（真机实测）：桌面歌词窗口把原文与译文分两次交给 GdipAddPathString，
 * 两次的发送端时间戳**完全相同**，且**原文先、译文后**。hook 面本身不标注哪句是译文，
 * 所以配对只能靠「到达时间差 + 时间戳一致 + 脚本差异」推断。
 *
 * 关键行为：当前句必须**立刻**显示；译文随后到达时**原地升级**当前槽为配对，
 * 而不是等配对完成才显示（否则每句都要等下一句到达，延迟一整句）。
 */

const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af]/;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;

function stats(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const total = s.length || 1;
  let cjk = 0, latin = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk++;
    else if (LATIN.test(ch)) latin++;
  }
  return {
    total: s.length,
    cjkRatio: cjk / total,
    latinRatio: latin / total,
    kana: KANA.test(s),
    hangul: HANGUL.test(s),
  };
}

/** 两侧脚本是否明显不同（不同 → 极可能是译文，confidence=high） */
export function scriptDiffers(a, b) {
  const x = stats(a), y = stats(b);
  if (!x.total || !y.total) return false;
  const cjkSide = (s) => s.cjkRatio >= 0.4;
  const alphaSide = (s) => s.latinRatio >= 0.4 || s.kana || s.hangul;
  if (cjkSide(x) && alphaSide(y)) return true;
  if (alphaSide(x) && cjkSide(y)) return true;
  if (x.kana !== y.kana || x.hangul !== y.hangul) return true;
  return false;
}

/** 字数加权切分点（two-lines 模式下若拿不到真实到达时刻时的回退） */
export function charWeightSplit(a, b) {
  const la = String(a || '').length, lb = String(b || '').length;
  if (!la && !lb) return 0.5;
  const r = la / (la + lb);
  return Math.min(0.65, Math.max(0.35, r));
}

/** "YYYY-MM-DD HH:MM:SS" → 秒（同一天内的相对值足够比较；解析失败返回 NaN） */
function tsSeconds(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(ts || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

export function createLyricState(config = {}) {
  const cfg = {
    pairWindowMs: config.pairWindowMs ?? 1200,
    pairSameScript: config.pairSameScript ?? 'separate',
    filterPatterns: config.filterPatterns ?? ['纯音乐', '请欣赏', '作词', '作曲', '编曲'],
    maxSlots: config.maxSlots ?? 20,
    defaultIntervalMs: config.defaultIntervalMs ?? 3000,
    pairDebug: config.pairDebug === true,
  };

  let intervalMs = cfg.defaultIntervalMs;
  let nextIndex = 1;
  let current = null;
  const slots = [];
  const debug = [];

  let track = { raw: '', song: '', artist: '' };
  let channel = { state: 'waiting-shm', desktopLyrics: 0, visible: 0, idleSecs: 0, lines: 0 };
  let lastActivityAt = 0;
  let lastText = '';
  let tickCount = 0;

  function filtered(text) {
    if (cfg.filterPatterns.some((p) => p && String(text).includes(p))) return 'pattern';
    // 切歌时网易云会在桌面歌词窗口先画一张「歌名 - 歌手」卡片，会被 hook 当成歌词抓到
    if (looksLikeTrackTitle(text)) return 'track-title';
    return null;
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-–—·.。,，!！?？'"“”''()（）\[\]【】]/g, '');

  /** 该文本是否就是/包含当前曲目标题（歌名卡片），而非歌词 */
  function looksLikeTrackTitle(text) {
    const t = norm(text);
    if (!t) return false;
    const raw = norm(track.raw), song = norm(track.song), artist = norm(track.artist);
    if (raw && t === raw) return true;
    if (song && t === song) return true;
    if (song && artist && t.includes(song) && t.includes(artist)) return true;
    return false;
  }

  function recordDebug(entry) {
    if (!cfg.pairDebug) return;
    debug.push({ at: Date.now(), ...entry });
    if (debug.length > 20) debug.shift();
  }

  /** 收尾当前槽：确定 endTs/duration，并更新句间隔 EMA */
  function closeCurrent(at) {
    if (!current) return;
    current.endTs = at;
    current.durationMs = Math.max(0, at - current.startTs);
    if (current.durationMs >= 500 && current.durationMs <= 60000) {
      intervalMs = Math.round(intervalMs * 0.65 + current.durationMs * 0.35);
    }
    current.open = false;
  }

  function openSlot(line, at) {
    const slot = {
      index: nextIndex++,
      original: line,
      translation: null,
      confidence: null,
      startTs: at,
      endTs: at + intervalMs,
      pairedAt: null,
      switchAt: null,
      split: null,
      open: true,
    };
    slots.push(slot);
    while (slots.length > cfg.maxSlots) slots.shift();
    current = slot;
    return slot;
  }

  /** 一句新歌词（已去重后） */
  function pushLine(text, ts, seq, at) {
    lastActivityAt = at;
    const why = filtered(text);
    if (why) {
      recordDebug({ kind: 'filtered', why, text });
      return;
    }
    const line = { text, ts, seq, at };
    if (current && current.open && current.translation === null) {
      const dtArrival = at - current.startTs;
      const sameTs = ts === current.original.ts;
      const dts = Math.abs(tsSeconds(ts) - tsSeconds(current.original.ts));
      const withinTime = sameTs || (Number.isFinite(dts) && dts <= 1);
      if (dtArrival <= cfg.pairWindowMs && withinTime) {
        const differs = scriptDiffers(current.original.text, text);
        const confidence = differs ? 'high' : 'low';
        recordDebug({ kind: 'pair-candidate', dtArrival, sameTs, differs, confidence });
        if (confidence === 'low' && cfg.pairSameScript === 'separate') {
          // 同脚本 → 判定为两句独立歌词：把前一句收尾，新句另起一槽
          closeCurrent(at);
          openSlot(line, at);
          recordDebug({ kind: 'split-same-script', text });
          return;
        }
        current.translation = line;
        current.confidence = confidence;
        current.pairedAt = at;
        const span = Math.max(1, current.endTs - current.startTs);
        const ratio = (at - current.startTs) / span;
        // two-lines 模式的原文/译文切换点：原文至少占一槽的 25%（否则原句一闪而过）；
        // 只有译文确实迟到（≥25%）时才用真实到达时刻，否则用字数加权。
        current.switchAt = ratio >= 0.25 ? at
          : current.startTs + Math.round(charWeightSplit(current.original.text, text) * span);
        current.split = charWeightSplit(current.original.text, text);
        recordDebug({ kind: 'paired', confidence, ratio: +ratio.toFixed(3), switchAt: current.switchAt });
        return;
      }
    }
    closeCurrent(at);
    openSlot(line, at);
  }

  function pushEvent(ev) {
    const at = ev._at ?? Date.now();
    switch (ev.type) {
      case 'hello':
        return;
      case 'status':
        channel = {
          state: ev.state ?? channel.state,
          desktopLyrics: ev.desktopLyrics ?? 0,
          visible: ev.visible ?? 0,
          idleSecs: ev.idleSecs ?? channel.idleSecs,
          lines: ev.lines ?? channel.lines,
        };
        return;
      case 'alive':
        channel = { ...channel, state: ev.attached ? 'attached' : 'waiting-shm', lines: ev.lines ?? channel.lines };
        lastActivityAt = Math.max(lastActivityAt, at);
        return;
      case 'track': {
        track = { raw: ev.raw ?? '', song: ev.song ?? '', artist: ev.artist ?? '' };
        // 回溯过滤：切歌时网易云会先画一张「歌名 - 歌手」卡片，它往往**比 track 事件先到**
        // （helper 的窗口标题是轮询的）——那时还不知道歌名，先到的卡片会被当成歌词。
        // 所以拿到 track 后回头检查当前槽，是歌名卡片就撤掉。
        if (current && current.translation === null && looksLikeTrackTitle(current.original.text)) {
          const idx = slots.indexOf(current);
          if (idx >= 0) slots.splice(idx, 1);
          recordDebug({ kind: 'dropped-track-card', text: current.original.text, track: track.raw });
          current = null;
        }
        return;
      }
      case 'line': {
        const text = String(ev.text ?? '');
        if (!text) return;
        if (text === lastText) return; // 兜底去重（helper 已去重）
        lastText = text;
        pushLine(text, ev.ts ?? '', ev.seq ?? 0, at);
        return;
      }
      case 'tick':
        tickCount++;
        lastActivityAt = at;
        return;
      default:
        return;
    }
  }

  /** 供 /state 与 SSE 使用的快照 */
  function snapshot(extra = {}) {
    const cur = current
      ? {
          index: current.index,
          original: { text: current.original.text, ts: current.original.ts, seq: current.original.seq },
          translation: current.translation
            ? { text: current.translation.text, ts: current.translation.ts, seq: current.translation.seq }
            : null,
          confidence: current.confidence,
          startTs: current.startTs,
          endTs: current.endTs,
          pairedAt: current.pairedAt,
          switchAt: current.switchAt,
          split: current.split,
        }
      : null;
    return {
      track,
      lyric: cur,
      channel,
      stats: { slots: slots.length, ticks: tickCount, intervalMs },
      lastActivityTs: lastActivityAt,
      recent: slots.slice(-6).map((s) => ({
        index: s.index,
        original: s.original.text,
        translation: s.translation ? s.translation.text : null,
        confidence: s.confidence,
        durationMs: s.durationMs ?? null,
      })),
      pairDebug: cfg.pairDebug ? debug.slice(-10) : undefined,
      ...extra,
    };
  }

  return {
    pushEvent,
    snapshot,
    config: cfg,
    /** 运行期改配置（齿轮面板保存后立即生效，不需要重载插件） */
    setConfig(patch) {
      if (!patch || typeof patch !== 'object') return;
      if (patch.pairWindowMs !== undefined) cfg.pairWindowMs = Number(patch.pairWindowMs);
      if (patch.pairSameScript !== undefined) cfg.pairSameScript = patch.pairSameScript;
      if (patch.filterPatterns !== undefined) cfg.filterPatterns = patch.filterPatterns;
      if (patch.pairDebug !== undefined) cfg.pairDebug = patch.pairDebug === true;
    },
    get intervalMs() { return intervalMs; },
  };
}
