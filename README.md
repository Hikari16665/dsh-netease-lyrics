# dsh-netease-lyrics

在 DSH Web GUI 里，**壁纸层之上、聊天层之下**新增一层网易云歌词，带十种随机特效。

```
┌─ 聊天/侧栏等内容（不透明面板）───────────────┐
│                                             │
│   ← 歌词层：z-index:-1，pointer-events:none  │   ← 本插件
│                                             │
└─────────────────────────────────────────────┘
   壁纸层 / 画布底色：z-index:-2 或 body 背景传播
```

## 它怎么工作

1. **取词**：往 `cloudmusic.exe` 注入一个 x64 hook DLL，挂 `gdiplus!GdipAddPathString`。
   网易云的桌面歌词窗口是把**整句文字转成 GDI+ 路径**再描边渲染的，所以在文字进入渲染管线那一刻就能拿到原文，
   不必碰网易云的网络接口 / 播放状态 / 歌词缓存。过滤条件是「同一线程 + 窗口类名 `DesktopLyrics`」。
2. **回传**：DLL 把 `YYYY-MM-DD HH:MM:SS\n歌词` 写进 `Local\NeteaseLyricsBuffer`（64 KiB）并 `SetEvent`
   `Local\NeteaseLyricsEvent` —— 与 JackalClient 的 `JDLyrics64.dll` **同通道同格式**，
   所以谁在写都能读；JackalClient 已经注入过时，本插件只读附加、不重复注入。
3. **配对**：原文与译文是**两次独立调用、发送端时间戳相同**（真机实测），且原文先、译文后。
   host 侧按「到达时间差 ≤ `pairWindowMs` 且时间戳一致」配对，并用脚本差异（假名/拉丁 vs 汉字）判定置信度。
4. **渲染**：client 侧在 body 上挂一个 `position:fixed; z-index:-1` 的层。
   body 背景会传播到画布绘制，因此负 z-index 元素天然落在画布色之上、正文块之下 —— 正好夹在壁纸与聊天之间
   （同一手法见壁纸插件 `dsh-plugin-wallpaper-engine`）。

## 设置在哪里

**歌词层右下角的齿轮按钮**（自带设置面板，不依赖宿主的设置页）。

原因：DSH 官方的「插件」设置页（`ui-settings-plugins`）在有些 profile 里被第三方设置壳盖住/不渲染，
本机就是这种情况（侧边栏只有通用/模型/账户）。所以本插件把设置做在自己身上，任何主题、任何设置壳下都能用。

面板里可以改：**配对显示方式（四种）**、无译文回落、两句同脚本策略、配对时间窗、效果池、换场节奏、
位置/对齐、玻璃化与强度、字号、不透明度、无歌词淡出、显示歌名、恢复默认。

保存行为分两类：

| 类别 | 字段 | 生效方式 |
|---|---|---|
| 显示类 | `pairMode`、`translationFallback`、`effectPool`、`reshuffle`、`autoGlide`、`glideMs`、`band`、`align`、`fontScale`、`unsungAlpha`、`enterMs`、`opacity`、`showTrackTitle`、`idleFadeSec`、`glassMode`、`glassStrength`、`zIndex`、`respectReducedMotion` | 立即生效，存浏览器 `localStorage` |
| 宿主类 | `pairWindowMs`、`pairSameScript`、`filterPatterns`、`pairDebug`、`enabled`、`source` | 立即写入生效配置，并 `POST /dsh-netease-lyrics/config` 落盘到 `$DSH_HOME/netease-lyrics/settings.json` |

面板底部会说明同步状态；若宿主接口还没起来（例如宿主 JS 是改动前加载的），会提示「显示类设置已本地生效，
宿主类设置需重启 DSH 后保存」——显示类改动不受影响。

顶层配置仍然遵循 DSH 惯例：`cordis.patch.yml` 里给 `netease-lyrics` 行写 `config:` 也能改，
优先级是 **schema 默认值 ← profile 行 config ← 齿轮面板保存值**。

## 配对显示模式（本插件重点）

网易云把译文画在原文下方，hook 面**不标注**哪句是译文，只能推断。因此提供四种显示模式（设置 → 插件 → 网易云歌词层）：

| `pairMode` | 效果 |
|---|---|
| `stacked`（默认） | 原文为主，译文小字（0.44em、0.72 不透明度）在下 |
| `original-only` | 只显示原文，译文直接丢弃（不产生动画空档） |
| `translation-only` | 只显示译文；该句没有译文时按 `translationFallback` 回落原文或整句不显示 |
| `two-lines` | **当成两段歌词**：原文与译文各占一段依次显示，切换点用真实到达时刻或字数加权 |

相关设置：

- `pairWindowMs`（默认 1200）：多近算"同时出现"。默认配对窗下译文几乎都在几十毫秒内到达。
- `pairSameScript`（默认 `separate`）：两句***脚本相同***（比如中文歌的两行词）时——`separate` 当成两句独立歌词；
  `stack` 仍按原文+译文处理（此时 `stacked` 模式下第二行不会缩到 0.44em，而是 0.8em）。
- `translationFallback`：`translation-only` 模式下的回落策略。
- `pairDebug`：在 `/state` 里附带配对判定细节（`/dsh-netease-lyrics/state`）。

## 随机特效

每首歌按 `hash(歌名|歌手)` 定种，随机一套「场景」= 效果 + 调色板 + 垂直位置 + 对齐 + 速度；同歌内稳定不闪。

`reshuffle` 控制换场节奏：

| 值 | 行为 |
|---|---|
| `auto`（默认） | **每 30 秒沿效果池顺序轮换**（从本歌的种子位置起步）—— 保证一首歌里能把这池子走一遍，不会反复撞同一个 |
| `song` | 每首歌固定一套（稳，但一首歌里只看得到一种效果） |
| `line` | 每句换效果（配色不变） |

**系统「减少动态效果」的处理**：以前的做法是把效果**锁死成 karaoke**（于是看起来"只有卡拉OK能被 roll 出来"）；
现在改为保留场景与各效果的静态形态差异，只关掉运动（`data-calm` 由 CSS 处理：字雨不出粒子、圆环不转但仍是环形排布等）。
面板里可切换「跟随系统「减少动态」/忽略」。

### 轮换时的缓动滑动（「自动对齐」下）

**位置模式为「自动」时**（`band` 或 `align` 为 `auto`），每次轮换会同时换一个落点（上/中/下 × 左/中/右），
再用**显式缓动方程**把歌词滑过去 —— 这是"活泼感"的来源：

| 曲线 | 手感 |
|---|---|
| `outBack` | 冲过头再回弹 |
| `outElastic` | 弹性回弹（弹簧） |
| `outBounce` | 落地弹两下 |
| `outQuint` | 快出慢收，干净利落 |
| `inOutCubic` | 平滑加减速 |

曲线由轮换种子决定，每次轮换换一种；位移写在专门的 `.dnl-glide` 层上（px 位移，逐帧由 rAF 写 CSS 变量），
**不碰各特效自己写在 `.dnl-slot` 上的 transform**，所以不会打架。相关设置：`autoGlide`（开关，默认开）、
`glideMs`（时长，默认 900ms，200~3000）；窗口尺寸变化时重新量一次落点并直接落位（不播动画）；
「减少动态效果」下同样直接落位。

效果池（`effectPool` 可裁剪）：`karaoke` 逐字卡拉OK、`typewriter` 打字机、`blurReveal` 模糊揭示、
`neonPulse` 霓虹呼吸、`tilt3d` 3D 透视、`rain` 字雨、`marquee` 弹幕横穿、`orbit` 极坐标环绕、
`glassCard` 毛玻璃卡片、`gradientSweep` 渐变扫光。

其它开关：`band` / `align` / `fontScale` / `opacity` / `showTrackTitle` / `idleFadeSec`（无歌词活动多久后淡出）/
`respectReducedMotion`（系统"减少动态"时退化为静态高亮）/ `filterPatterns`（跳过"纯音乐，请欣赏"等）。

**玻璃化** `glassMode`：默认 `auto` —— 面板不透明时把外壳面板临时调半透明（`glassStrength` 可调），
否则歌词会被不透明面板挡住；设为 `off` 则保持面板原样（歌词只在框架间隙可见）。停用/卸载时会逐条还原主题令牌。

## 层的位置与可读性

- 默认 `zIndex: -1`。想让它浮到界面之上，把 `zIndex` 改成正数即可（此时会挡内容，慎用）。
- 层是 `pointer-events:none` + `aria-hidden`，**不拦任何点击**；只有右下角状态提示可点。
- 文字用主题令牌 + 柔和阴影/底衬光晕，深浅主题都保证可读性；调色板只作用于歌词本身（装饰允许自有配色）。

## 安装与停用

```powershell
# 从本目录安装（link: 方式，改了源码不用重装）
dsh plugin --profile web add <本目录绝对路径>

# 或从 npm 安装（发布后）
dsh plugin --profile web add dsh-netease-lyrics
```

停用/卸载：设置 → 插件 → 网易云歌词层（关闭），或 `dsh plugin --profile web remove dsh-netease-lyrics`。
**新装的 client 模块需要刷新一次页面**（F5）；host 半边会随 HMR 立即生效。

## 一次性注入（重要）

hook DLL 必须注入到 `cloudmusic.exe`（Medium IL）。如果 DSH 本身跑在更低的完整性级别
（例如被别的沙箱包了一层），自动注入会失败并返回 `err=5`；此时页面右下角提示会给出三个按钮：
**复制脚本路径 / 打开文件夹 / 重试注入**，双击暂存目录里的 `install-hook.cmd` 即可手动注入一次。

> 注意：**不要从工作区双击注入器**。工作区文件带 Low 完整性标签，从那里启动的进程会被强制 Low IL，
> 注入必然失败。本插件会自动把 `inject.exe` / `lyrichook64.dll` / `lyricstream.exe` 复制到
> `$DSH_HOME/netease-lyrics/`（普通 ACL），请用那份。

注入后 DLL 常驻到网易云退出；网易云重启后需要再注入一次。宿主会自动判断并重试：
通道若是它自己建的（没人写过）会立即注入；**桌面歌词窗口句柄变化**（= 网易云重启过）也会触发重试，
两次自动尝试之间有 60 秒冷却，避免"用户只是暂停播放"就误报。若写入端静默消失而宿主没能接手，
状态里会标 `channel.stale = true`，页面右下角给出「重试注入」按钮由你点一下。

## 数据源与接口（host 半边）

| 路由 | 说明 |
|---|---|
| `GET /dsh-netease-lyrics/state` | 完整状态快照（曲目 / 当前歌词槽 / 通道 / 注入状态 / 生效配置） |
| `GET /dsh-netease-lyrics/stream` | SSE，内容变化即推 `event: state`，15s 心跳，最多 8 个订阅者 |
| `GET /dsh-netease-lyrics/config` | 当前生效配置 + 哪些字段属于宿主侧 |
| `POST /dsh-netease-lyrics/config` | 齿轮面板保存（schema 校验，非法枚举/越界返回 400，落盘 settings.json） |
| `POST /dsh-netease-lyrics/config/reset` | 恢复默认 |
| `POST /dsh-netease-lyrics/inject` | 重试注入 |
| `POST /dsh-netease-lyrics/reveal` | 打开暂存目录 |

`lyricstream.exe` 的事件流（NDJSON，host 逐行消费）：
`hello` / `status`（state、created、desktopLyrics、visible、idleSecs）/ `track`（raw、song、artist）/
`line`（seq、ts、text）/ `tick`（同文本重绘心跳）/ `alive`（30s 存活心跳）。

helper 崩溃或卡死会被宿主自动重启（退避 1s→30s；90s 无事件触发看门狗）。

## 排查

| 现象 | 原因与处理 |
|---|---|
| 层上什么也没有 | 网易云没开桌面歌词（提示会写）；或面板不透明且 `glassMode=off` |
| 提示"需要手动注入一次" | 见上节，双击 `$DSH_HOME/netease-lyrics/install-hook.cmd` |
| 提示"通道似乎已断开" | 网易云重启过、写入端换了进程：点提示里的「重试注入」 |
| 改了 host 代码没生效 | DSH 不热更新已加载插件的 host JS：需要重启 DSH（client 侧改动刷新页面即可） |
| 只出歌词不出译文 | 该曲无译文，或 `pairMode` 设成了 `original-only` |
| 中文歌被拆成两句 | 正常：同脚本默认 `separate`；想强配成原文+译文就设 `pairSameScript=stack` |
| 歌词比人声慢半拍 | 逐字进度由相邻两句时间戳插值，不是网易云真实逐字时间轴 |
| 切歌时出现歌名 | 已过滤：host 侧在 `track` 到达后**回溯**撤掉歌名卡片，client 侧再加一道同口径守卫（因为卡片常比 `track` 事件先到） |
| 一首歌里只看到一种效果 | 把「换场节奏」设为 **30 秒轮换**（已是默认）；若系统开了「减少动态效果」，旧版会锁 karaoke，现已改为只收敛动效 |

## 目录

```
index.js          host：Config、路由、子进程、注入生命周期、SSE
pairing.js        配对状态机（纯函数，可单测）
inject-policy.js  注入时机与「僵尸通道」判定（纯函数，可单测）
client.js         browser：层挂载 + 四种模式渲染 + 十种效果（纯 DOM，不用 react-dom）
bin/              lyrichook64.dll / inject.exe / lyricstream.exe（自写；DLL 内含 MinHook）
bin-src/          C 源码（lyricstream.c，可用 build.cmd 重新构建）
docs/effects.png  十个效果的实拍总览
vendor/           schemastery + cosmokit 的随包副本（正式依赖是 package.json 里的 schemastery，
                  装不上时自动回落，保证 link 安装方式下也能启动）
test/             四套测试，最多 154 项断言（其中 3 项依赖网易云正在播放歌词，
                  没播放时自动跳过并在汇总里报出来）+ 两个离线渲染台
LICENSE           MIT
THIRD-PARTY.md    随包分发的第三方组件（MinHook / schemastery / cosmokit）
```

![十个效果总览](docs/effects.png)

**离线渲染台**（自查视觉效果，不需要 DSH、不需要登录）：用浏览器直接打开
`test/harness.html?fx=karaoke&el=1500&span=4000`（单个效果，可调进度/行文/主题）
或 `test/grid.html`（十个效果一次渲染成网格）。真机截图排查出来的几个渲染问题都是靠它定位的。

```powershell
npm test                            # 跑全部四套（最多 154 项断言）
node test/pairing.test.mjs        # 18 项：配对状态机（真机回放、歌名卡片回溯过滤）
node test/inject-policy.test.mjs  # 14 项：注入时机、冷却、僵尸通道判定
node test/client.test.mjs         # 92 项：四种 pairMode、效果轮换、缓动滑动、逐字可读性、快歌适配、减少动态、玻璃化、齿轮面板、回收
node test/host.test.mjs           # 30 项：真实 helper、路由、SSE、配置接口与校验、回收（无播放时 3 项跳过）
```

## 发布

- 包名 `dsh-netease-lyrics`，版本 `1.0.0`，无 `private`，`publishConfig.access = public`。
- 发布前自查：`npm pack --dry-run` 看随包清单（白名单见 `package.json` 的 `files`），`npm test` 跑四套断言。
- **client 模块的 id 必须等于包名**（`client.js` 里的 `window.__ModuleLoader__.load({ id })`、
  `cordis.patch.yml` 里的行 `name`、`package.json` 的 `name`）—— 改包名时这三处要一起改，
  `test/client.test.mjs` 里有一条断言专门盯着这件事。
- 本机验证过的工作流：`dsh plugin --profile web add <本目录绝对路径>` 走 `link:` 安装，
  改名后需 `remove` 旧名再 `add`，profile 的 `dependencies` 与 `dsh.profile.bundles` 会一起更新。

## 许可

插件本体 MIT，详见 [LICENSE](LICENSE)。随包分发的第三方组件（MinHook、schemastery、cosmokit，均为 MIT）
的来源与位置见 [THIRD-PARTY.md](THIRD-PARTY.md)，升级 vendored 副本的方法见 [vendor/README.md](vendor/README.md)。
