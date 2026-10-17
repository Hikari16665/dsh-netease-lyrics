/**
 * dsh-netease-lyrics — browser half
 *
 * 在 DSH Web GUI 里新增一个夹在「背景层（壁纸 / 画布底色）」与「聊天层」之间的层：
 *   body 背景会传播到画布绘制，所以 position:fixed 的负 z-index 子元素天然落在
 *   画布色之上、正文块之下 —— z-index:-1 正好夹在壁纸层(-2)与内容之间。
 *   （同一手法见壁纸插件 dsh-plugin-wallpaper-engine 的 .we-layer{z-index:-2}）
 *
 * 不使用 react-dom：它不在平台模块表里（同场景插件实测 require 会抛错并导致整插件加载失败）。
 * 本文件是纯 DOM + CSS 变量实现，逐字/进度类动画全部由 CSS 承担，JS 只写变量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-netease-lyrics',
  factory(require) {
    const ROUTE = '/dsh-netease-lyrics';

    // ─────────────────────────── 调色板 ───────────────────────────
    const PALETTES = [
      { id: 'aurora', c1: '#7ef0d0', c2: '#5b8cff', c3: '#c77dff' },
      { id: 'sunset', c1: '#ffb37b', c2: '#ff6b9d', c3: '#ffd76b' },
      { id: 'ice', c1: '#9fe8ff', c2: '#5b6bff', c3: '#e8f6ff' },
      { id: 'ember', c1: '#ff8f5e', c2: '#ff4d6d', c3: '#ffd166' },
      { id: 'moss', c1: '#a8e063', c2: '#56ab2f', c3: '#e6ffcc' },
      { id: 'theme', c1: 'var(--dsw-alias-brand-primary, #5b8cff)', c2: 'var(--dsw-alias-label-primary, #e8e8ea)', c3: 'var(--dsw-alias-brand-primary, #5b8cff)' },
    ];
    const EFFECTS = ['karaoke', 'typewriter', 'blurReveal', 'neonPulse', 'tilt3d', 'rain', 'marquee', 'orbit', 'glassCard', 'gradientSweep'];

    function hash(str) {
      let h = 2166136261 >>> 0;
      const s = String(str || '');
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return h >>> 0;
    }
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    // ─────────────────────────── 样式 ───────────────────────────
    const CSS = `
.dnl-layer{position:fixed;inset:0;z-index:var(--dnl-z,-1);pointer-events:none;overflow:hidden;
  font-family:var(--dsw-font-family,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);
  contain:layout style paint;}
.dnl-stage{opacity:var(--dnl-layer-op,.85);transition:opacity .9s cubic-bezier(.4,0,.2,1)}
.dnl-layer[data-hidden="1"] .dnl-stage{opacity:0}
.dnl-stage{position:absolute;inset:0;padding:0 max(3vw,26px);box-sizing:border-box}
.dnl-stage[data-align="left"]{text-align:left}
.dnl-stage[data-align="center"]{text-align:center}
.dnl-stage[data-align="right"]{text-align:right}
/* 位移层：始终居中对齐，靠 --dnl-dx/--dnl-dy（px）把内容滑到目标锚点。
   单独一层是为了不和各特效自己写在 .dnl-slot 上的 transform 打架。 */
.dnl-glide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;
  padding:0 max(3vw,26px);will-change:transform;
  transform:translate3d(var(--dnl-dx,0px),var(--dnl-dy,0px),0)}

.dnl-slot{position:relative;max-width:min(80vw,1100px);will-change:transform,opacity,filter;
  --dnl-p:0;--dnl-pf:0.06;--dnl-pr:0.03;--dnl-in:0;--dnl-fg:var(--dsw-alias-label-primary,#f2f3f5);--dnl-dim:color-mix(in srgb,var(--dnl-fg) 68%,transparent);
  --dnl-shadow:0 2px 26px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.45);
  --dnl-halo:rgba(255,255,255,.22);--dnl-halo-strong:rgba(0,0,0,.5);
  --dnl-size:clamp(22px,3.5vw,54px);}
body:not([data-ds-dark-theme]) .dnl-slot{--dnl-shadow:0 2px 24px rgba(255,255,255,.8),0 1px 3px rgba(0,0,0,.22);
  --dnl-halo:rgba(255,255,255,.85);--dnl-halo-strong:rgba(0,0,0,.28)}
/* 文字底衬：让歌词压在复杂壁纸上也能读 */
.dnl-slot::before{content:"";position:absolute;inset:-18% -12%;border-radius:50%;z-index:-1;
  background:radial-gradient(60% 70% at 50% 50%,color-mix(in srgb,var(--dnl-c1) 16%,transparent),transparent 72%);
  opacity:calc(.35 + .35*var(--dnl-in));filter:blur(6px);transition:opacity .5s ease}
.dnl-main{position:relative;font-size:var(--dnl-size);font-weight:700;line-height:1.3;letter-spacing:.015em;
  color:var(--dnl-fg);text-shadow:var(--dnl-shadow);
  transform:translateY(calc((1 - var(--dnl-in)) * 16px));opacity:var(--dnl-in)}
.dnl-ch{display:inline-block;white-space:pre;transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.dnl-trans{margin-top:.46em;font-size:calc(var(--dnl-size) * .44);font-weight:500;letter-spacing:.04em;
  color:var(--dnl-fg);opacity:calc(.72 * var(--dnl-in));text-shadow:var(--dnl-shadow);
  filter:blur(calc((1 - var(--dnl-in)) * 7px));transform:translateY(calc((1 - var(--dnl-in)) * 9px))}
.dnl-track{margin-top:.75em;font-size:calc(var(--dnl-size) * .28);font-weight:500;letter-spacing:.14em;
  text-transform:uppercase;color:color-mix(in srgb,var(--dnl-fg) 62%,transparent);opacity:calc(.9*var(--dnl-in))}
.dnl-drops{position:absolute;inset:0;overflow:visible;pointer-events:none}
.dnl-drop{position:absolute;top:-6%;font-size:calc(var(--dnl-size) * .42);color:var(--dnl-fg);opacity:0;
  text-shadow:var(--dnl-shadow);animation:dnl-fall var(--dur,2.6s) cubic-bezier(.35,.1,.7,.9) var(--delay,0s) forwards}
@keyframes dnl-fall{0%{opacity:0;transform:translateY(0) rotate(0)}12%{opacity:.55}
  100%{opacity:0;transform:translateY(calc(var(--fall,240px))) rotate(var(--rot,25deg))}}

/* ── 1 逐字卡拉OK：渐变填充 + 字头光晕 ── */
.dnl-slot[data-fx="karaoke"] .dnl-main{background-image:linear-gradient(90deg,
    var(--dnl-c1) 0,var(--dnl-c2) calc(var(--dnl-pf) * 100%),
    var(--dnl-dim) calc(var(--dnl-pf) * 100%),var(--dnl-dim) 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;
  /* 不能留深色 text-shadow：字形没有填充色时它只会变成一团黑影（未唱部分会看不见）*/
  text-shadow:none;
  filter:drop-shadow(0 2px 18px var(--dnl-halo)) drop-shadow(0 1px 2px var(--dnl-halo-strong))}
/* ⚠️ 这里**不能**给逐字 span 加 transform：Chrome 在 background-clip:text 的元素里，
   子元素一旦有 transform，贴在字形上的背景遮罩就只覆盖第一个字 —— 表现就是"只有第一个字亮"。
   入场位移交给 .dnl-main（同一个元素上的 transform 没问题），逐字只做颜色/渐变。 */

/* ── 2 打字机：逐字浮现 + 光标 ── */
.dnl-slot[data-fx="typewriter"] .dnl-main::after{content:"";display:inline-block;width:.08em;height:1.05em;
  margin-left:.12em;vertical-align:-.16em;background:var(--dnl-c1);border-radius:2px;
  opacity:calc(.35 + .65 * var(--dnl-in));animation:dnl-blink 1.05s steps(1,end) infinite}
@keyframes dnl-blink{0%,49%{visibility:visible}50%,100%{visibility:hidden}}
.dnl-slot[data-fx="typewriter"] .dnl-ch{opacity:clamp(0,calc((var(--dnl-pr) * var(--n,20) - var(--i)) * 3.2),1);
  transform:translateY(calc((1 - clamp(0,calc((var(--dnl-pr) * var(--n,20) - var(--i)) * 3.2),1)) * 8px))}

/* ── 3 模糊揭示：字距收拢 + 横向遮罩 ── */
.dnl-slot[data-fx="blurReveal"] .dnl-main{filter:blur(calc((1 - var(--dnl-in)) * 10px));
  letter-spacing:calc(.015em + (1 - var(--dnl-in)) * .18em);
  -webkit-mask-image:linear-gradient(90deg,#000 calc(var(--dnl-in) * 130% - 30%),transparent calc(var(--dnl-in) * 130%));
  mask-image:linear-gradient(90deg,#000 calc(var(--dnl-in) * 130% - 30%),transparent calc(var(--dnl-in) * 130%))}

/* ── 4 霓虹呼吸：双色描边 + 光晕脉动 ── */
.dnl-slot[data-fx="neonPulse"] .dnl-main{color:#fff;-webkit-text-stroke:.6px color-mix(in srgb,var(--dnl-c2) 70%,#000);
  animation:dnl-neon 3.6s ease-in-out infinite;
  --g1:color-mix(in srgb,var(--dnl-c1) 85%,transparent);--g2:color-mix(in srgb,var(--dnl-c3) 80%,transparent)}
@keyframes dnl-neon{0%,100%{text-shadow:0 0 6px var(--g1),0 0 22px var(--g1),0 0 44px var(--g2),var(--dnl-shadow)}
  50%{text-shadow:0 0 10px var(--g2),0 0 34px var(--g1),0 0 68px var(--g2),var(--dnl-shadow)}}

/* ── 5 3D 透视：入场翻转 + 常驻微摆 ── */
.dnl-slot[data-fx="tilt3d"] .dnl-main{transform:perspective(900px)
  rotateX(calc((1 - var(--dnl-in)) * 22deg)) rotateZ(calc((1 - var(--dnl-in)) * -1.6deg))
  translateY(calc((1 - var(--dnl-in)) * 26px)) scale(calc(.94 + .06 * var(--dnl-in)));
  text-shadow:0 14px 34px rgba(0,0,0,.5),var(--dnl-shadow)}
.dnl-slot[data-fx="tilt3d"]{animation:dnl-float 7.5s ease-in-out infinite}
@keyframes dnl-float{0%,100%{transform:rotateX(0deg) translateY(0)}50%{transform:rotateX(1.6deg) translateY(-7px)}}

/* ── 6 字雨：上一句字符下落（JS 生成 .dnl-drop） ── */
.dnl-slot[data-fx="rain"] .dnl-main{text-shadow:0 4px 30px rgba(0,0,0,.6),var(--dnl-shadow)}

/* ── 7 弹幕横穿：缓慢漂移 + 两端渐隐 ── */
.dnl-slot[data-fx="marquee"]{max-width:96vw}
.dnl-slot[data-fx="marquee"] .dnl-main{transform:translateX(calc((.5 - var(--dnl-p)) * 10vw));
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);
  filter:blur(calc(.4px + .9px * abs(var(--dnl-p) - .5)))}

/* ── 8 极坐标环绕：字符排成圆环缓慢旋转 ── */
.dnl-slot[data-fx="orbit"] .dnl-main{width:calc(var(--dnl-size) * 6);height:calc(var(--dnl-size) * 6);
  position:relative;margin:0 auto;animation:dnl-spin 26s linear infinite}
.dnl-slot[data-fx="orbit"] .dnl-ch{position:absolute;left:50%;top:50%;
  transform:translate(-50%,-50%) rotate(calc(var(--i) * var(--step,26deg))) translateY(calc(var(--dnl-size) * -1.62))
    rotate(calc(var(--i) * var(--step,26deg) * -1));
  opacity:clamp(0,calc((var(--dnl-pr) * var(--n,12) - var(--i)) * 2.4),1)}
@keyframes dnl-spin{from{rotate:0deg}to{rotate:360deg}}

/* ── 9 毛玻璃卡片：上滑入场 + 内高光 ── */
.dnl-slot[data-fx="glassCard"]{padding:calc(var(--dnl-size) * .52) calc(var(--dnl-size) * .95);border-radius:calc(var(--dnl-size) * .62);
  background:linear-gradient(140deg,color-mix(in srgb,var(--dnl-c1) 20%,transparent),color-mix(in srgb,var(--dnl-c2) 13%,transparent));
  backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);
  border:1px solid color-mix(in srgb,var(--dnl-c1) 34%,transparent);
  box-shadow:0 18px 60px rgba(0,0,0,.36),inset 0 1px 0 color-mix(in srgb,#fff 22%,transparent);
  transform:translateY(calc((1 - var(--dnl-in)) * 34px)) scale(calc(.95 + .05 * var(--dnl-in)))}
.dnl-slot[data-fx="glassCard"]::before{opacity:calc(.2 * var(--dnl-in))}
.dnl-slot[data-fx="glassCard"] .dnl-trans{opacity:calc(.86 * var(--dnl-in))}

/* ── 10 渐变扫光：底色呼吸 + 高光掠过 ── */
.dnl-slot[data-fx="gradientSweep"] .dnl-main{text-shadow:none;
  background-image:linear-gradient(100deg,var(--dnl-c1),var(--dnl-c2) 34%,#fff 50%,var(--dnl-c3) 66%,var(--dnl-c1));
  background-size:260% 100%;background-position:calc(var(--dnl-pf) * 160%) 0;
  -webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;
  filter:drop-shadow(0 4px 22px color-mix(in srgb,var(--dnl-c2) 30%,transparent))}

/* ── 状态提示（唯一可点击元素） ── */
.dnl-hint{position:absolute;right:max(2vw,18px);bottom:max(2vh,14px);display:flex;gap:10px;align-items:center;
  /* 默认不吃点击：它挂在高层的 .dnl-ui 里，隐藏时若仍 pointer-events:auto 会挡住右下角的输入区 */
  pointer-events:none;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a8adb8);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#151517) 78%,transparent);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;padding:7px 11px;
  backdrop-filter:blur(10px);opacity:0;transform:translateY(6px);transition:opacity .35s ease,transform .35s ease}
.dnl-hint[data-show="1"]{opacity:.94;transform:none;pointer-events:auto}
.dnl-hint button{pointer-events:auto;font:inherit;color:var(--dsw-alias-label-primary,#f2f3f5);cursor:pointer;
  background:color-mix(in srgb,var(--dnl-c1, #5b8cff) 24%,transparent);
  border:1px solid color-mix(in srgb,var(--dnl-c1, #5b8cff) 40%,transparent);
  border-radius:7px;padding:3px 8px;transition:background .2s ease}
.dnl-hint button:hover{background:color-mix(in srgb,var(--dnl-c1, #5b8cff) 40%,transparent)}
.dnl-hint .dnl-dot{width:7px;height:7px;border-radius:50%;background:var(--dnl-c1,#5b8cff);box-shadow:0 0 10px var(--dnl-c1,#5b8cff);
  animation:dnl-pulse 1.6s ease-in-out infinite}
@keyframes dnl-pulse{0%,100%{opacity:.35}50%{opacity:1}}
/* ── 设置 UI：单独放在高层容器里（歌词层在 z-index:-1，里面的东西会被聊天内容盖住） ── */
.dnl-ui{position:fixed;inset:0;z-index:2147482000;pointer-events:none}
/* ── 齿轮入口与设置面板（自带设置界面，不依赖宿主设置页） ── */
.dnl-gear{position:absolute;right:max(2vw,18px);bottom:calc(max(2vh,14px) + 40px);pointer-events:auto;cursor:pointer;
  width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-secondary,#a8adb8);opacity:.35;transition:opacity .25s ease,transform .25s ease,background .2s ease;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#151517) 72%,transparent);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));backdrop-filter:blur(10px)}
.dnl-gear:hover{opacity:1;transform:rotate(35deg)}
.dnl-gear[data-open="1"]{opacity:1;background:color-mix(in srgb,var(--dnl-c1,#5b8cff) 30%,transparent)}
.dnl-gear svg{width:16px;height:16px;display:block}

.dnl-panel{position:absolute;right:max(2vw,18px);bottom:calc(max(2vh,14px) + 78px);width:min(340px,86vw);
  max-height:min(66vh,560px);overflow:auto;pointer-events:auto;box-sizing:border-box;
  padding:14px 14px 12px;border-radius:14px;font-size:12.5px;line-height:1.5;
  color:var(--dsw-alias-label-primary,#f2f3f5);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1b1b1e) 92%,transparent);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));
  box-shadow:0 24px 70px rgba(0,0,0,.5);
  backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);
  opacity:0;transform:translateY(10px) scale(.98);transition:opacity .22s ease,transform .22s ease;pointer-events:none}
.dnl-panel[data-open="1"]{opacity:1;transform:none;pointer-events:auto}
.dnl-panel h4{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#a8adb8)}
.dnl-panel .dnl-sec{padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.dnl-panel .dnl-sec:first-of-type{border-top:0;padding-top:2px}
.dnl-panel .dnl-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:7px}
.dnl-panel .dnl-row:first-child{margin-top:0}
.dnl-panel .dnl-label{color:var(--dsw-alias-label-secondary,#a8adb8);flex:0 0 auto}
.dnl-panel .dnl-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#a8adb8);opacity:.85}
.dnl-seg{display:inline-flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.dnl-seg button{font:inherit;cursor:pointer;padding:3px 8px;border-radius:8px;white-space:nowrap;
  color:var(--dsw-alias-label-primary,#f2f3f5);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 8%,transparent);
  border:1px solid transparent;transition:background .16s ease,border-color .16s ease}
.dnl-seg button:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 16%,transparent)}
.dnl-seg button[aria-pressed="true"]{background:color-mix(in srgb,var(--dnl-c1,#5b8cff) 34%,transparent);
  border-color:color-mix(in srgb,var(--dnl-c1,#5b8cff) 55%,transparent)}
.dnl-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.dnl-chips button{font:inherit;font-size:11px;cursor:pointer;padding:3px 7px;border-radius:999px;
  color:var(--dsw-alias-label-secondary,#a8adb8);background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 7%,transparent);
  border:1px solid transparent}
.dnl-chips button[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#f2f3f5);
  background:color-mix(in srgb,var(--dnl-c1,#5b8cff) 28%,transparent);
  border-color:color-mix(in srgb,var(--dnl-c1,#5b8cff) 45%,transparent)}
.dnl-panel input[type=range]{-webkit-appearance:none;appearance:none;width:150px;height:4px;border-radius:3px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 22%,transparent);outline:none}
.dnl-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;
  background:var(--dnl-c1,#5b8cff);cursor:pointer;box-shadow:0 0 8px color-mix(in srgb,var(--dnl-c1,#5b8cff) 60%,transparent)}
.dnl-panel .dnl-val{min-width:52px;text-align:right;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#f2f3f5)}
.dnl-panel .dnl-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;
  padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.dnl-panel .dnl-foot button{font:inherit;cursor:pointer;padding:4px 9px;border-radius:8px;color:var(--dsw-alias-label-primary,#f2f3f5);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 10%,transparent);border:1px solid transparent}
.dnl-panel .dnl-foot button:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 18%,transparent)}
.dnl-sync{font-size:11px;color:var(--dsw-alias-label-secondary,#a8adb8);opacity:.85}
/* 「减少动态效果」：保留场景与静态视觉差异，只关掉运动与逐字动画的位移部分 */
.dnl-slot[data-calm="1"] *,.dnl-slot[data-calm="1"]{animation:none !important;transition:none !important}
.dnl-slot[data-calm="1"] .dnl-main{transform:none !important;filter:none !important;opacity:1 !important;
  -webkit-mask-image:none !important;mask-image:none !important}
.dnl-slot[data-calm="1"] .dnl-ch{opacity:1 !important;transform:none !important}
.dnl-slot[data-calm="1"] .dnl-trans{opacity:.72 !important;filter:none !important;transform:none !important}
.dnl-slot[data-calm="1"] .dnl-drops{display:none}
.dnl-slot[data-calm="1"][data-fx="orbit"] .dnl-main{width:auto;height:auto}
.dnl-slot[data-calm="1"][data-fx="orbit"] .dnl-ch{position:static;margin:0 .12em;display:inline-block}
.dnl-slot[data-calm="1"][data-fx="marquee"]{max-width:min(80vw,1100px)}
`;

    // ─────────────────────────── 应用 ───────────────────────────
    function apply(ctx) {
      if (typeof document === 'undefined' || !document.body) return;

      const styleEl = document.createElement('style');
      styleEl.id = 'dnl-style';
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);

      const layer = document.createElement('div');
      layer.className = 'dnl-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.dataset.hidden = '1';
      const stage = document.createElement('div');
      stage.className = 'dnl-stage';
      stage.dataset.band = 'bottom';
      stage.dataset.align = 'center';
      const slot = document.createElement('div');
      slot.className = 'dnl-slot';
      slot.dataset.fx = 'karaoke';
      const drops = document.createElement('div');
      drops.className = 'dnl-drops';
      const main = document.createElement('div');
      main.className = 'dnl-main';
      const trans = document.createElement('div');
      trans.className = 'dnl-trans';
      const trackEl = document.createElement('div');
      trackEl.className = 'dnl-track';
      slot.append(drops, main, trans, trackEl);
      const glideEl = document.createElement('div');
      glideEl.className = 'dnl-glide';
      glideEl.appendChild(slot);
      stage.appendChild(glideEl);
      const hint = document.createElement('div');
      hint.className = 'dnl-hint';
      // 提示条不能挂在歌词层里：那一层是 z-index:-1，看得见但点击永远落在上层应用上（点不到）。
      // 它和齿轮/面板一起放进下面的 .dnl-ui 高层容器。
      layer.append(stage);
      document.body.appendChild(layer);

      // ── 自带设置：齿轮 + 面板（显示类立即生效并存 localStorage；宿主侧参数同步到 /config） ──
      const LS_KEY = 'dsh-netease-lyrics:settings';
      let localOverrides = (() => {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
      })();
      function saveLocal() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(localOverrides)); } catch { /* 隐私模式等 */ }
      }
      /** 宿主 config ← 本地覆盖 */
      /**
       * 生效配置 = 宿主 config ← 本地覆盖，外加一条兼容垫片：
       * 0.2.0 之前的宿主默认 reshuffle='song'（一首歌一个效果，容易被误认为"只出 karaoke"），
       * 而宿主 JS 不热更新。旧宿主不报 pluginVersion —— 只在这种情形、且用户没自己设过 reshuffle 时，
       * 把 client 侧默认提升为 'auto'。面板与渲染都读同一个 effCfg，显示与实际始终一致。
       */
      function effCfg(hostCfg, payload) {
        const merged = { ...(hostCfg || {}), ...localOverrides };
        const hostIsNew = typeof payload?.pluginVersion === 'string';
        if (!hostIsNew && localOverrides.reshuffle === undefined && merged.reshuffle === 'song') {
          merged.reshuffle = 'auto';
          merged.__shimmedReshuffle = true;
        }
        return merged;
      }

      const HOST_KEYS = ['pairWindowMs', 'pairSameScript', 'filterPatterns', 'pairDebug', 'enabled', 'source'];
      let hostSyncOk = null;   // null=未知, true/false=上次同步结果

      async function pushHostPatch(patch) {
        try {
          const r = await fetch(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          hostSyncOk = r.ok;
          if (!r.ok && r.status === 404) hostSyncOk = false;
        } catch { hostSyncOk = false; }
        paintSyncNote();
      }
      function setOption(key, value) {
        localOverrides[key] = value;
        saveLocal();
        // force=true：立即用新设置重建当前句（否则同一句内改效果池/位置看不到任何变化）
        if (lastPayload) { applyGlass(effCfg(lastPayload.config, lastPayload)); renderNow(lastPayload, true); }
        if (HOST_KEYS.includes(key)) void pushHostPatch({ [key]: value });
        refreshPanel();
      }
      async function resetAll() {
        localOverrides = {};
        saveLocal();
        try { await fetch(`${ROUTE}/config/reset`, { method: 'POST' }); hostSyncOk = true; } catch { hostSyncOk = false; }
        if (lastPayload) { applyGlass(lastPayload.config || {}); renderNow(lastPayload, true); }
        refreshPanel();
      }

      // 齿轮
      const gear = document.createElement('div');
      gear.className = 'dnl-gear';
      gear.setAttribute('role', 'button');
      gear.setAttribute('tabindex', '0');
      gear.title = '网易云歌词层 · 设置';
      gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.07A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.07A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.07a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.07a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.07a1.7 1.7 0 0 0-1.53 1z"/></svg>';
      const panel = document.createElement('div');
      panel.className = 'dnl-panel';
      panel.dataset.open = '0';
      const ui = document.createElement('div');
      ui.className = 'dnl-ui';
      ui.append(hint, gear, panel);
      document.body.appendChild(ui);
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = panel.dataset.open === '1';
        panel.dataset.open = open ? '0' : '1';
        gear.dataset.open = open ? '0' : '1';
        if (!open) refreshPanel();
      });
      gear.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') gear.click(); });
      const onDocClick = (e) => {
        if (panel.dataset.open !== '1') return;
        if (panel.contains(e.target) || gear.contains(e.target)) return;
        panel.dataset.open = '0';
        gear.dataset.open = '0';
      };
      document.addEventListener('click', onDocClick, true);

      const EFFECT_LABELS = {
        karaoke: '逐字卡拉OK', typewriter: '打字机', blurReveal: '模糊揭示', neonPulse: '霓虹呼吸',
        tilt3d: '3D 透视', rain: '字雨', marquee: '弹幕横穿', orbit: '极坐标环绕',
        glassCard: '毛玻璃卡片', gradientSweep: '渐变扫光',
      };
      const PAIR_HINT = '网易云把译文画在原文下方，hook 面分不出哪句是译文 —— 只能按「同时间戳 + 先后顺序 + 脚本差异」推断。';

      function seg(label, key, options, hostSide) {
        const row = document.createElement('div');
        row.className = 'dnl-row';
        const lab = document.createElement('span');
        lab.className = 'dnl-label';
        lab.textContent = label;
        const box = document.createElement('span');
        box.className = 'dnl-seg';
        const cur = effCfg(lastPayload?.config, lastPayload)[key];
        for (const [value, text] of options) {
          const b = document.createElement('button');
          b.textContent = text;
          b.setAttribute('aria-pressed', String(cur === value));
          b.addEventListener('click', (e) => { e.stopPropagation(); setOption(key, value); });
          box.appendChild(b);
        }
        row.append(lab, box);
        return row;
      }

      function range(label, key, min, max, step, fmt, hostSide) {
        const row = document.createElement('div');
        row.className = 'dnl-row';
        const lab = document.createElement('span');
        lab.className = 'dnl-label';
        lab.textContent = label;
        const val = document.createElement('span');
        val.className = 'dnl-val';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min); input.max = String(max); input.step = String(step);
        const cur = effCfg(lastPayload?.config, lastPayload)[key] ?? min;
        input.value = String(cur);
        val.textContent = fmt ? fmt(cur) : String(cur);
        input.addEventListener('input', (e) => { e.stopPropagation(); val.textContent = fmt ? fmt(Number(input.value)) : input.value; });
        input.addEventListener('change', (e) => { e.stopPropagation(); setOption(key, Number(input.value)); });
        row.append(lab, input, val);
        return row;
      }

      function chips(label, key, pool) {
        const wrap = document.createElement('div');
        wrap.className = 'dnl-sec';
        const h = document.createElement('h4');
        h.textContent = label;
        const box = document.createElement('div');
        box.className = 'dnl-chips';
        const cur = new Set(effCfg(lastPayload?.config, lastPayload)[key] || []);
        for (const id of pool) {
          const b = document.createElement('button');
          b.textContent = EFFECT_LABELS[id] || id;
          b.setAttribute('aria-pressed', String(cur.has(id)));
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = new Set(effCfg(lastPayload?.config, lastPayload)[key] || []);
            if (next.has(id)) next.delete(id); else next.add(id);
            if (next.size === 0) next.add(id); // 至少留一个
            setOption(key, pool.filter((x) => next.has(x)));
          });
          box.appendChild(b);
        }
        wrap.append(h, box);
        return wrap;
      }

      function section(title, rows) {
        const wrap = document.createElement('div');
        wrap.className = 'dnl-sec';
        if (title) { const h = document.createElement('h4'); h.textContent = title; wrap.appendChild(h); }
        for (const r of rows) wrap.appendChild(r);
        return wrap;
      }

      let syncNote = null;
      function paintSyncNote() {
        if (!syncNote) return;
        if (hostSyncOk === false) {
          syncNote.textContent = '宿主接口未就绪：显示类设置已本地生效，配对窗口/过滤词需重启 DSH 后保存';
        } else if (hostSyncOk === true) {
          syncNote.textContent = '已同步到宿主（settings.json）';
        } else {
          syncNote.textContent = '';
        }
      }

      function refreshPanel() {
        if (panel.dataset.open !== '1' || !lastPayload) return;
        const hostCfg = lastPayload.config || {};
        const c = effCfg(hostCfg, lastPayload);
        panel.textContent = '';
        panel.append(
          section('配对显示', [
            seg('显示方式', 'pairMode', [
              ['stacked', '译文小字'], ['original-only', '只要原文'],
              ['translation-only', '只要翻译'], ['two-lines', '当两段歌词'],
            ]),
            ...(c.pairMode === 'translation-only'
              ? [seg('无译文时', 'translationFallback', [['original', '回落原文'], ['hide', '整句不显示']])]
              : []),
            seg('两句同脚本', 'pairSameScript', [['separate', '拆成两句'], ['stack', '当成译文']]),
            range('配对时间窗', 'pairWindowMs', 200, 5000, 50, (v) => `${v} ms`),
          ]),
          (() => {
            const n = document.createElement('div');
            n.className = 'dnl-note';
            n.textContent = PAIR_HINT;
            return n;
          })(),
          chips('效果池（每首歌随机取一套）', 'effectPool', EFFECTS),
          section('外观', [
            seg('换场节奏', 'reshuffle', [['auto', '30 秒轮换'], ['song', '每首歌'], ['line', '每句']]),
            seg('缓动滑动', 'autoGlide', [[true, '开'], [false, '关']]),
            range('滑动时长', 'glideMs', 200, 3000, 50, (v) => v + ' ms'),
            seg('垂直位置', 'band', [['auto', '自动'], ['top', '上'], ['middle', '中'], ['bottom', '下']]),
            seg('水平对齐', 'align', [['auto', '自动'], ['left', '左'], ['center', '中'], ['right', '右']]),
            seg('玻璃化', 'glassMode', [['auto', '自动'], ['on', '开'], ['off', '关']]),
            range('玻璃强度', 'glassStrength', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
            range('字号', 'fontScale', 0.6, 2, 0.05, (v) => `${v.toFixed(2)}×`),
            range('不透明度', 'opacity', 0.1, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
            range('未唱部分亮度', 'unsungAlpha', 0.15, 1, 0.01, (v) => `${Math.round(v * 100)}%`),
            range('入场时长', 'enterMs', 120, 1200, 20, (v) => `${v} ms`),
            range('短句防抖', 'moveDebounceMs', 0, 2000, 50, (v) => (v ? `${v} ms` : '关')),
            range('无歌词淡出', 'idleFadeSec', 0, 60, 1, (v) => (v ? `${v} 秒` : '不淡出')),
            seg('显示歌名', 'showTrackTitle', [[true, '开'], [false, '关']]),
            seg('跟随系统「减少动态」', 'respectReducedMotion', [[true, '跟随'], [false, '忽略']]),
          ]),
        );
        const nowNote = document.createElement('div');
        nowNote.className = 'dnl-note';
        nowNote.textContent = `当前效果：${EFFECT_LABELS[slot.dataset.fx] || slot.dataset.fx}`
          + (c.reshuffle === 'auto' ? '（每 30 秒沿效果池轮换）' : c.reshuffle === 'line' ? '（每句换）' : '（本首歌固定）')
          + (slot.dataset.calm === '1' ? ' · 系统已开启「减少动态效果」，动效已收敛' : '')
          + (c.__shimmedReshuffle ? ' · 宿主为旧版本，已临时按轮换运行（重启 DSH 后以配置为准）' : '')
          + (c.autoGlide !== false && (c.band === 'auto' || c.align === 'auto')
            ? ` · 轮换时缓动滑动（自动对齐${glideEl.dataset.ease ? ' · ' + glideEl.dataset.ease : ''}）` : '');
        panel.appendChild(nowNote);
        const foot = document.createElement('div');
        foot.className = 'dnl-foot';
        const rst = document.createElement('button');
        rst.textContent = '恢复默认';
        rst.addEventListener('click', (e) => { e.stopPropagation(); void resetAll(); });
        syncNote = document.createElement('span');
        syncNote.className = 'dnl-sync';
        paintSyncNote();
        foot.append(rst, syncNote);
        panel.appendChild(foot);
      }

      // 玻璃化：面板不透明时把外壳调半透明，否则歌词层被面板挡住看不见
      const glassSaved = new Map();
      let glassApplied = false;
      const GLASS_TOKENS = ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-base'];

      /** 把主题令牌解析成真实颜色（令牌多定义在 body 作用域，不能读 root 的内联值） */
      function tokenColor(tk) {
        const probe = document.createElement('div');
        probe.style.cssText = `position:absolute;left:-9999px;top:-9999px;visibility:hidden;color:var(${tk})`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color || '';
      }
      function alphaOf(cssColor) {
        const m = /rgba?\(([^)]+)\)/.exec(String(cssColor));
        if (!m) return 1;
        const parts = m[1].split(',').map((s) => parseFloat(s));
        return parts.length >= 4 ? parts[3] : 1;
      }
      function applyGlass(cfg) {
        const mode = cfg?.glassMode ?? 'auto';
        const strength = clamp01(cfg?.glassStrength ?? 0.35);
        const effective = tokenColor('--dsw-alias-bg-layer-1');
        const alpha = alphaOf(effective);
        const need = mode === 'on' || (mode === 'auto' && alpha >= 0.98);
        if (!need) { if (glassApplied) restoreGlass(); return; }
        if (glassApplied) return;
        const root = document.documentElement;
        const pct = Math.round((1 - strength) * 100);
        for (const tk of GLASS_TOKENS) {
          glassSaved.set(tk, root.style.getPropertyValue(tk)); // 只用于还原用户自己的内联覆盖
          const solid = tokenColor(tk) || effective || 'rgb(21,21,23)';
          root.style.setProperty(tk, `color-mix(in srgb, ${solid} ${pct}%, transparent)`);
        }
        glassApplied = true;
      }
      function restoreGlass() {
        const root = document.documentElement;
        for (const [k] of glassSaved) root.style.removeProperty(k);
        glassSaved.clear();
        glassApplied = false;
      }

      // ── 场景（按歌曲定种，同一首歌稳定） ──
      let scene = null;
      let sceneKey = '';
      // ── 轮换时的缓动滑动（"自动对齐"下才有） ─────────────────────────────
      /** 显式缓动方程池：带方程的缓动 = 用数学曲线驱动位移，而不是 CSS 默认过渡 */
      const EASINGS = {
        outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
        outElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
        outQuint: (t) => 1 - Math.pow(1 - t, 5),
        inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
        outBounce: (t) => {
          const n = 7.5625, d = 2.75;
          if (t < 1 / d) return n * t * t;
          if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
          if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
          return n * (t -= 2.625 / d) * t + 0.984375;
        },
      };
      const EASING_NAMES = Object.keys(EASINGS);
      /** 锚点比例：自动模式下按桶重新抽，抽到哪个就往哪滑 */
      const BAND_RATIO = { top: 0.10, middle: 0.5, bottom: 0.86 };
      const ALIGN_RATIO = { left: 0.02, center: 0.5, right: 0.98 };

      let dx = 0, dy = 0;                  // 当前位移（px）
      let glide = null;                    // { fromX, fromY, toX, toY, t0, dur, ease, name }
      let lastAnchorKey = '';              // 已应用的目标锚点，用于判断要不要滑
      let glideCount = 0;                   // 本层启动过多少次滑动（排查用）

      /** 量出目标锚点相对"居中"位置的像素偏移 */
      function measureTarget(band, align) {
        const stageRect = stage.getBoundingClientRect();
        const slotRect = slot.getBoundingClientRect();
        const padX = parseFloat(getComputedStyle(glideEl).paddingLeft) || 0;
        const padY = parseFloat(getComputedStyle(glideEl).paddingTop) || 0;
        const availW = Math.max(0, stageRect.width - padX * 2 - slotRect.width);
        const availH = Math.max(0, stageRect.height - padY * 2 - slotRect.height);
        const bx = BAND_RATIO[band] ?? 0.5;
        const ax = ALIGN_RATIO[align] ?? 0.5;
        // 居中时偏移为 0；否则把内容推到对应比例处
        return {
          x: (ax - 0.5) * availW,
          y: (bx - 0.5) * availH,
        };
      }

      /** 抽一个新的落点；尽量避开当前这个，否则"换落点"等于没换 */
      function repickAnchor(sc, seed) {
        const bands = ['top', 'middle', 'bottom'];
        const aligns = ['left', 'center', 'right'];
        const nb = bands[seed % 3];
        const na = aligns[(seed >>> 5) % 3];
        sc.band = nb === sc.band ? bands[(seed + 1) % 3] : nb;
        sc.align = na === sc.align ? aligns[((seed >>> 5) + 1) % 3] : na;
        sc.motionSeed = seed;
        return sc;
      }

      /** 开始一次缓动滑动（同锚点不重复触发） */
      function maybeGlide(band, align, cfg, seed) {
        const auto = cfg.band === 'auto' || cfg.align === 'auto';
        if (cfg.autoGlide === false || !auto) { glide = null; dx = dy = 0; setVars(glideEl, { '--dnl-dx': '0px', '--dnl-dy': '0px' }); lastAnchorKey = `${band}|${align}`; return; }
        const key = `${band}|${align}`;
        if (key === lastAnchorKey) return;
        const to = measureTarget(band, align);
        const name = EASING_NAMES[(seed >>> 3) % EASING_NAMES.length];
        glide = { fromX: dx, fromY: dy, toX: to.x, toY: to.y, t0: performance.now(), dur: Math.max(200, Number(cfg.glideMs) || 900), ease: EASINGS[name], name };
        glideEl.dataset.ease = name;
        // 启动计数：便于排查"到底滑了几次"（短句防抖生效时这个数不会涨）
        glideEl.dataset.glides = String(++glideCount);
        lastAnchorKey = key;
        if (slot.dataset.calm === '1' || reducedMotion() && cfg.respectReducedMotion !== false) {
          // 收敛动效：直接落位
          dx = to.x; dy = to.y; glide = null;
          setVars(glideEl, { '--dnl-dx': `${dx}px`, '--dnl-dy': `${dy}px` });
        }
      }
      /** 效果池（过滤掉不认识/已被用户裁掉的 id，至少留一个） */
      function scenePool(cfg) {
        const pool = (cfg.effectPool && cfg.effectPool.length ? cfg.effectPool : EFFECTS).filter((e) => EFFECTS.includes(e));
        return pool.length ? pool : ['karaoke'];
      }
      function pickScene(track, cfg) {
        const pool = scenePool(cfg);
        const seed = hash(`${track.song || track.raw || ''}|${track.artist || ''}`);
        const base = seed % pool.length;
        const palette = PALETTES[(seed >>> 3) % PALETTES.length];
        const band = cfg.band !== 'auto' ? cfg.band : ['top', 'middle', 'bottom'][(seed >>> 5) % 3];
        const align = cfg.align !== 'auto' ? cfg.align : ['left', 'center', 'right'][(seed >>> 7) % 3];
        const speed = 0.85 + ((seed >>> 11) % 40) / 100;
        return { effect: pool[base], base, palette, band, align, speed, seed };
      }
      /** 归一化：去掉空白与中英标点，用于"这句是不是歌名卡片"的比较（与 host 侧同口径） */
      const normCard = (s) => String(s || '').toLowerCase().replace(/[\s\-–—·.。,，!！?？'"“”''()（）\[\]【】]/g, '');
      /**
       * 切歌时网易云桌面歌词窗口会先画一张「歌名 - 歌手」卡片，它往往比 host 的 track 事件先到，
       * 于是会被当成歌词。host 侧有回溯过滤，这里再加一道同口径守卫 —— 宿主 JS 不热更新，
       * client 侧守卫能让修复随刷新生效。
       */
      function isTrackCard(text, track) {
        const t = normCard(text);
        if (!t) return false;
        const raw = normCard(track?.raw), song = normCard(track?.song), artist = normCard(track?.artist);
        if (raw && t === raw) return true;
        if (song && t === song) return true;
        if (song && artist && t.includes(song) && t.includes(artist)) return true;
        return false;
      }
      /** 长句回退：只对"排布型"效果生效，避免超长文本撑破圆环/横穿 */
      function longLineFallback(text, effect) {
        const len = [...String(text)].length;
        if (effect === 'orbit' && len > 12) return 'blurReveal';
        if (effect === 'marquee' && len > 34) return 'blurReveal';
        return effect;
      }
      const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

      // ── 渲染 ──
      let shown = { key: '', kind: '', text: '' };
      let prevText = '';
      let entranceAt = 0;
      let lyricRef = null;
      let shownTranslation = false;
      let lastUnitAt = 0;        // 上一次"换字"的到达时刻（ms）
      let lastUnitStartTs = NaN;  // 上一次"换字"那句的 startTs

      /** 短间隔防抖：相邻两句来得太快时，不换位置也不换样式，只原地换字 */
      function moveDebounce(cfg) {
        const v = Number(cfg?.moveDebounceMs);
        return Number.isFinite(v) ? Math.max(0, v) : 500;
      }

      function setVars(el, vars) { for (const k in vars) el.style.setProperty(k, vars[k]); }

      function buildLine(text, effect, n) {
        main.textContent = '';
        const step = n > 0 ? `${(360 / n).toFixed(2)}deg` : '26deg';
        slot.style.setProperty('--n', String(n));
        slot.style.setProperty('--step', step);
        for (let i = 0; i < text.length; i++) {
          const sp = document.createElement('span');
          sp.className = 'dnl-ch';
          sp.textContent = text[i];
          sp.style.setProperty('--i', String(i));
          main.appendChild(sp);
        }
        slot.dataset.fx = effect;
      }

      function spawnDrops(text) {
        drops.textContent = '';
        if (!text) return;
        const chars = [...text].filter((c) => c.trim());
        const take = Math.min(10, chars.length);
        for (let i = 0; i < take; i++) {
          const d = document.createElement('span');
          d.className = 'dnl-drop';
          d.textContent = chars[(i * 3) % chars.length];
          const left = 6 + Math.random() * 88;
          d.style.left = `${left}%`;
          d.style.setProperty('--delay', `${(Math.random() * 0.5).toFixed(2)}s`);
          d.style.setProperty('--dur', `${(2.1 + Math.random() * 1.8).toFixed(2)}s`);
          d.style.setProperty('--fall', `${160 + Math.random() * 260}px`);
          d.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 90)}deg`);
          drops.appendChild(d);
        }
      }

      function renderNow(payload, force) {
        const cfg = effCfg(payload.config, payload);
        lyricRef = payload.lyric || null;
        const track = payload.track || {};

        // 场景
        const key = `${track.raw || ''}`;
        const songChanged = force || key !== sceneKey;

        // 短间隔防抖：两句之间如果太近（默认 500ms 以内），这一句不换位置、不换样式，
        // 只在原地把文字换掉 —— 否则连词/快歌会一直在滑来滑去、样式也一直在重播。
        const startTs = Number(lyricRef?.startTs);
        const nowReal = Date.now();
        const gapByTs = Number.isFinite(startTs) && Number.isFinite(lastUnitStartTs)
          ? startTs - lastUnitStartTs : Infinity;
        const gapByArrival = lastUnitAt ? nowReal - lastUnitAt : Infinity;
        const gap = Math.min(gapByTs, gapByArrival);
        // 换歌/改设置时不防抖：那是自然的"重新落位"时机
        const rapid = !songChanged && gap >= 0 && gap < moveDebounce(cfg);

        if (songChanged) {
          sceneKey = key;
          scene = pickScene(track, cfg);
        }
        if (!rapid) {
          if (cfg.reshuffle === 'line' && shown.kind) {
            const pool = scenePool(cfg);
            const li = payload.lyric?.index ?? 0;
            scene.effect = pool[hash(`${track.raw}|${li}`) % pool.length];
            if (cfg.band === 'auto' || cfg.align === 'auto') repickAnchor(scene, hash(`${track.raw}|pos|${li}`));
          } else if (cfg.reshuffle === 'auto' && scene) {
            // 顺序轮换（不是随机）：从本歌的种子位置开始，每 30 秒前进一个，
            // 保证一首歌里能把效果池走一遍，而不会像随机那样反复撞同一个效果。
            const pool = scenePool(cfg);
            const step = Math.floor(Date.now() / 30000);
            scene.effect = pool[(scene.base + step) % pool.length];
            // 自动对齐下，轮换时顺便换个落点 —— 配合缓动方程滑过去，得到"活泼"的观感
            if (cfg.band === 'auto' || cfg.align === 'auto') repickAnchor(scene, hash(`${track.raw}|pos|${step}`));
          }
        }

        const pal = scene.palette;
        setVars(slot, { '--dnl-c1': pal.c1, '--dnl-c2': pal.c2, '--dnl-c3': pal.c3 });
        setVars(layer, { '--dnl-z': String(cfg.zIndex ?? -1), '--dnl-layer-op': String(cfg.opacity ?? 0.85) });
        // 未唱部分亮度可调：默认 68%（太低就只剩第一个字看得见）
        setVars(slot, { '--dnl-dim': `color-mix(in srgb, var(--dnl-fg) ${Math.round(clamp01(cfg.unsungAlpha ?? 0.68) * 100)}%, transparent)` });
        stage.dataset.band = scene.band;
        stage.dataset.align = scene.align;

        // 显示单位（pairMode 决定）
        const mode = cfg.pairMode || 'stacked';
        let text = '', sub = null, kind = '';
        if (lyricRef) {
          const orig = lyricRef.original?.text || '';
          const tr = lyricRef.translation?.text || null;
          if (mode === 'original-only') { text = orig; kind = 'o'; }
          else if (mode === 'translation-only') {
            if (tr) { text = tr; kind = 't'; }
            else if ((cfg.translationFallback || 'original') === 'original') { text = orig; kind = 'o'; }
            else { text = ''; kind = 'none'; }
          } else if (mode === 'two-lines') { text = orig; kind = 'o'; }
          else { text = orig; sub = tr; kind = 'stacked'; }
        }

        // 歌名卡片守卫：宁可这一句不显示，也不要把歌名当歌词贴在聊天背后
        if (text && isTrackCard(text, track)) { text = ''; sub = null; kind = 'none'; }

        const unitKey = `${lyricRef ? lyricRef.index : '-'}:${kind}:${text}`;
        if (force || unitKey !== shown.key) {
          shown = { key: unitKey, kind, text };
          shownTranslation = false;
          // 短间隔里不重播入场：文字直接换掉（rapid 时把入场时间推到很久以前 → --dnl-in 直接为 1）
          entranceAt = rapid ? performance.now() - 1e6 : performance.now();
          idleSince = Date.now();
          lastUnitAt = nowReal;
          lastUnitStartTs = Number.isFinite(startTs) ? startTs : NaN;
          if (text) {
            // 减少动态效果：不锁死成某一种效果（那会让"永远只有 karaoke"），
            // 而是保留场景、只把运动关掉（data-calm 由 CSS 处理）。
            slot.dataset.calm = reducedMotion() && cfg.respectReducedMotion !== false ? '1' : '0';
            const eff = longLineFallback(text, scene.effect);
            buildLine(text, eff, [...text].length);
            if (eff === 'rain' && prevText && slot.dataset.calm !== '1' && !rapid) spawnDrops(prevText);
            prevText = text;
          }
        }

        // 自动对齐下的缓动滑动：落点变了就用当前这套缓动方程滑过去（短间隔不滑）
        if (text && !rapid) maybeGlide(scene.band, scene.align, cfg, scene.motionSeed ?? scene.seed);

        // 译文小字（stacked）
        if (sub && mode === 'stacked') {
          trans.textContent = sub;
          trans.style.display = '';
        } else if (mode === 'two-lines' && lyricRef?.translation) {
          trans.textContent = '';
          trans.style.display = 'none';
        } else {
          trans.textContent = '';
          trans.style.display = 'none';
        }
        // 歌名
        if (cfg.showTrackTitle && track.raw) {
          trackEl.textContent = track.raw;
          trackEl.style.display = '';
        } else trackEl.style.display = 'none';

        // 可见性（enabled=false 时整层隐藏，只留设置提示）
        const hasText = !!text && cfg.enabled !== false;
        layer.dataset.hidden = hasText ? '0' : '1';
        paintHint(payload);
      }

      // ── rAF：进度 / 入场 / 两段切换 / 空闲淡出 ──
      let rafId = 0;
      let idleSince = Date.now();
      function frame() {
        rafId = requestAnimationFrame(frame);
        if (document.hidden) return;
        const now = performance.now();
        // 缓动滑动：用显式方程算插值，逐帧写位移
        if (glide) {
          const t = Math.min(1, (now - glide.t0) / glide.dur);
          const k = glide.ease(t);
          dx = glide.fromX + (glide.toX - glide.fromX) * k;
          dy = glide.fromY + (glide.toY - glide.fromY) * k;
          glideEl.style.setProperty('--dnl-dx', `${dx.toFixed(2)}px`);
          glideEl.style.setProperty('--dnl-dy', `${dy.toFixed(2)}px`);
          if (t >= 1) { dx = glide.toX; dy = glide.toY; glide = null; }
        }
        // 入场时长自适应：配置值（默认 280ms），且不超过句长的 35% ——
        // 快歌里 600ms 的入场会吃掉句子的大半时间，字幕一直是"糊的"。
        const spanNow = Math.max(1, (lyricRef?.endTs ?? 0) - (lyricRef?.startTs ?? 0));
        const enterMs = Math.max(120, Math.min(Number(lastConfig?.enterMs) || 280, spanNow * 0.35));
        const enter = clamp01((now - entranceAt) / enterMs);
        slot.style.setProperty('--dnl-in', enter.toFixed(3));

        const l = lyricRef;
        if (l) {
          const span = Math.max(1, l.endTs - l.startTs);
          const elapsed = Math.max(0, Date.now() - l.startTs);
          const p = clamp01(elapsed / span);
          slot.style.setProperty('--dnl-p', p.toFixed(4));
          // 填充进度：比"时间进度"更宽容 —— 提前唱满（0.85×），长间奏最长按 12 秒算，
          // 并且起步就有 6%，免得句首只有第一个字亮、其余全暗看不清。
          const spanFill = Math.min(span, 12000) * 0.85;
          const pf = clamp01(0.06 + 0.94 * clamp01(elapsed / spanFill));
          slot.style.setProperty('--dnl-pf', pf.toFixed(4));
          // 揭示进度：逐字类效果（打字机、环绕）必须在句子结束前就把字出完，
          // 否则快歌（句子只有 1.5 秒）里整句几乎一直在"打字中"，读不出来。
          const revealDur = Math.max(220, Math.min(span * 0.4, 1200));
          const pr = clamp01(0.03 + 0.97 * clamp01(elapsed / revealDur));
          slot.style.setProperty('--dnl-pr', pr.toFixed(4));

          // two-lines：到切换点把主行换成译文（自带入场动画）
          const mode = lastConfig?.pairMode || 'stacked';
          if (mode === 'two-lines' && l.translation && !shownTranslation) {
            const sw = l.switchAt || l.startTs + span * 0.5;
            if (Date.now() >= sw) {
              shownTranslation = true;
              const t = l.translation.text;
              shown = { key: `${l.index}:t:${t}`, kind: 't', text: t };
              entranceAt = performance.now();
              const eff = longLineFallback(t, scene?.effect || 'karaoke');
              buildLine(t, eff, [...t].length);
              trans.style.display = 'none';
            }
          }
          if (Date.now() - (l.startTs || 0) < 1e9) { /* 时间戳有效则继续走 */ }
        }

        // 空闲淡出
        const idleFade = Number(lastConfig?.idleFadeSec ?? 15);
        if (idleFade > 0 && Date.now() - idleSince > idleFade * 1000) layer.dataset.hidden = '1';
      }
      rafId = requestAnimationFrame(frame);

      // ── 状态提示 ──
      let lastConfig = null;
      function paintHint(payload) {
        const cfg = effCfg(payload.config, payload);
        lastConfig = cfg;
        const inj = payload.inject || {};
        const ch = payload.channel || {};
        let text = '', actions = [];
        if (cfg.enabled === false) { text = '歌词层已关闭（插件设置里开启）'; }
        else if (inj.status === 'needs-manual') {
          text = '需要手动注入一次 hook（DSH 权限低于网易云）';
          actions = [['复制脚本路径', 'copy'], ['打开文件夹', 'reveal'], ['重试注入', 'inject']];
        } else if (ch.state !== 'attached') { text = '等待歌词通道…'; }
        else if (!ch.desktopLyrics) { text = '请在网易云音乐里打开「桌面歌词」'; }
        else if (ch.stale === true) {
          // 写死"已断开"会骗人：暂停播放/长间奏时写入端本来就安静，所以把话说明白，按钮照给
          text = '很久没有新歌词了（可能只是暂停）；若网易云重启过，点「重新注入」';
          actions = [['重新注入', 'inject'], ['打开文件夹', 'reveal']];
        }
        else if (inj.status === 'failed') { text = `注入失败：${inj.message || ''}`; actions = [['重试注入', 'inject'], ['打开文件夹', 'reveal']]; }
        hint.textContent = '';
        if (!text) { hint.dataset.show = '0'; return; }
        const dot = document.createElement('span');
        dot.className = 'dnl-dot';
        hint.append(dot, document.createTextNode(text));
        for (const [label, act] of actions) {
          const b = document.createElement('button');
          b.textContent = label;
          b.addEventListener('click', (e) => { e.stopPropagation(); void doAction(act, inj); });
          hint.appendChild(b);
        }
        hint.dataset.show = '1';
      }
      async function doAction(act, inj) {
        try {
          if (act === 'copy') { await navigator.clipboard?.writeText?.(inj.manualScript || ''); }
          else if (act === 'reveal') { await fetch(`${ROUTE}/reveal`, { method: 'POST' }); }
          else if (act === 'inject') { await fetch(`${ROUTE}/inject`, { method: 'POST' }); }
        } catch { /* 忽略：下次状态刷新会纠正提示 */ }
      }

      // ── 数据源：SSE 优先，失败退化为轮询 ──
      let es = null, pollTimer = null, esFails = 0, lastPayload = null;
      function onPayload(payload) {
        lastPayload = payload;
        applyGlass(effCfg(payload.config, payload));
        renderNow(payload, false);
      }
      function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(async () => {
          try {
            const r = await fetch(`${ROUTE}/state`, { cache: 'no-store' });
            if (r.ok) onPayload(await r.json());
          } catch { /* 忽略 */ }
        }, 500);
      }
      function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
      function connect() {
        try {
          es = new EventSource(`${ROUTE}/stream`);
          es.addEventListener('state', (e) => { esFails = 0; stopPolling(); try { onPayload(JSON.parse(e.data)); } catch { /* 忽略 */ } });
          es.onerror = () => {
            esFails++;
            if (esFails >= 3) { try { es.close(); } catch { /* 忽略 */ } es = null; startPolling(); }
          };
        } catch { startPolling(); }
      }
      connect();
      // 首次状态（SSE 建连前先拿一份，避免空白等待）
      fetch(`${ROUTE}/state`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((p) => { if (p) onPayload(p); }).catch(() => {});

      // 主题切换时重新评估玻璃化
      // 窗口尺寸变了，像素位移就失效了：重新量一次并直接落位（不播动画）
      const onResize = () => {
        if (!scene) return;
        glide = null;
        const to = measureTarget(scene.band, scene.align);
        dx = to.x; dy = to.y;
        setVars(glideEl, { '--dnl-dx': `${dx}px`, '--dnl-dy': `${dy}px` });
      };
      window.addEventListener('resize', onResize);

      const themeObserver = new MutationObserver(() => { if (lastPayload) applyGlass(lastPayload.config || {}); });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] });

      // ── 回收 ──
      ctx.effect(() => () => {
        cancelAnimationFrame(rafId);
        try { es?.close(); } catch { /* 忽略 */ }
        stopPolling();
        themeObserver.disconnect();
        document.removeEventListener('click', onDocClick, true);
        window.removeEventListener('resize', onResize);
        restoreGlass();
        styleEl.remove();
        ui.remove();
        layer.remove();
      });

      ctx.logger?.info?.('netease-lyrics: lyrics layer mounted (z-index -1, between wallpaper and chat)');
    }

    return { inject: [], apply };
  },
});
