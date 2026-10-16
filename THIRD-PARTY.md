# 第三方组件声明

本插件本体以 MIT 许可发布（见 [LICENSE](LICENSE)）。随包分发的下列组件来自第三方，各自的许可与来源如下。

## 编译进二进制的组件

| 组件 | 出现在 | 许可 | 上游 |
|---|---|---|---|
| MinHook | `bin/lyrichook64.dll`（静态链接；用于 hook `gdiplus!GdipAddPathString`） | MIT | https://github.com/TsudaKageyu/minhook |

`bin/inject.exe` 与 `bin/lyricstream.exe` 由本仓库 `bin-src/lyricstream.c` 构建，无第三方代码。

## 随包副本（运行时回落用）

| 组件 | 位置 | 许可 | 上游 |
|---|---|---|---|
| schemastery 3.18.0 | `vendor/schemastery/` | MIT | https://github.com/shigma/schemastery |
| cosmokit | `vendor/schemastery/node_modules/cosmokit/` | MIT | https://github.com/shigma/cosmokit |

这两个包只是"装不上真依赖时"的兜底（详见 [vendor/README.md](vendor/README.md)），
正式依赖声明在 `package.json` 的 `dependencies` 里。

## 运行期依赖（不随包分发）

本插件运行在 DeepSeek Harness 内，宿主提供 `@deepseek-ai/dsh-client-runtime` 等平台模块；
这些模块由宿主分发，不在本包内。
