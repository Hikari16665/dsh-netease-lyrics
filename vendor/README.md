# vendor/ —— 随包副本（仅作回落）

这里的包**不是**本插件的依赖声明来源，而是兜底：

- 正式依赖写在 `package.json` 的 `dependencies` 里，由 profile 的包管理器安装。
- 但本插件常见的安装方式是 `link:` / `file:`（本地目录），这种安装下包管理器**不会**给被链接的包装依赖；
  再加上 DSH 插件是以真实路径 `import()` 的，模块解析会回到本目录而不是 profile 的 `node_modules`。
- 所以 `index.js` 里是"先试真依赖、失败再回落随包副本"，两条路都通。

| 目录 | 版本 | 许可 | 上游 |
|---|---|---|---|
| `schemastery/` | 3.18.0 | MIT | https://github.com/shigma/schemastery |
| `schemastery/node_modules/cosmokit/` | 1.x | MIT | https://github.com/shigma/cosmokit |

升级方式：把上游 `lib/`（以及 cosmokit 的 `lib/`）覆盖过来即可。
随包副本只保留运行时需要的文件 —— 上游的 `src/` 与 `*.map` 已剪掉（省约 40 KB），
插件只 `import` 到 `lib/index.mjs`，剪掉不影响加载（`npm test` 会走这条回落路径，可随时验证）。
