# fast-bridge

快捷指令和 SCS 语言支持。

## Fast Bridge

三个插件都支持通过 `command.getSelectedText` 主动读取当前编辑器选中文本；Fast 端快捷调用为 `await f.editorBridge.getCurrentSelectedText()`。没有选择时返回空字符串，关闭 `fastBridge.sendText` 或没有活动编辑器时返回 `null`。

在 VS Code 的 Files Explorer 中选中一个或多个文件/目录并按 `Ctrl+Shift+C` 时，插件会复制全部资源路径。WebSocket 命令 `command.copyResourcePath` 在 `data.paths` 返回全部绝对路径；单选时还保留兼容字段 `data.path`。

插件启动后默认连接 `ws://127.0.0.1:19900`，协议兼容 Fast Idea Bridge。它会上报当前工作区、文件、文本输入光标、选区及多光标状态，并支持服务端发起状态查询、文件导航、文本选择、查找、编辑器聚焦、编辑器全屏和资源管理器文件路径复制命令。

状态快照中的 `payload.activeEditor.context` 表示光标最内层的通用语法上下文，`expressionContext` 提供表达式、对象类型、方法返回值、参数和成员信息；VS Code 通过 Hover 和 Completion Provider 尽力解析这些字段，方法成员同时提供 `returnType` 和兼容的 `type`。`editor.statusChanged` 只在输入能力或当前对象信息变化时发送，不再发送高频的 `editor.caretChanged` 和 `editor.documentChanged`。`command.getInputable`、`command.getContext`、`command.getObjectInfo` 和 `command.getSelectedText` 可主动读取当前状态，对应 Fast 端调用为 `await f.editorBridge.getCurrentInputable()`、`await f.editorBridge.getCurrentContext()`、`await f.editorBridge.getCurrentObjectInfo()` 和 `await f.editorBridge.getCurrentSelectedText()`。`command.getContext` 返回 `singleQuote`、`doubleQuote`、`backtick`、`parentheses`、`braces` 或 `none`；没有活动编辑器时返回 `null`。`command.queryPythonPackages` 按需批量查询目标工作区解释器中的指定包。`payload.fullScreen` 表示 VS Code 是否全屏；`payload.editorOpenedAt` 是当前编辑器打开时间的 Unix 毫秒时间戳。`command.isFullScreen` 会重新查询当前窗口的全屏状态，返回 `data.fullScreen` 的 `true`、`false` 或未知的 `null`。自动全屏会在握手后查询，确认未全屏才发送 `command.fullScreen`，并在切换后再次查询确认；宿主尚未就绪时会在编辑器打开后的 30 秒内重试。`command.fullScreen` 会幂等地执行 `workbench.action.toggleFullScreen`。
`payload.focus` 现在通过 VS Code context key 区分代码编辑器、文本输入框和其他组件；焦点轮询仅在 WebSocket 已连接时运行，并在插件销毁或断线时停止。

在 VS Code 的 Files Explorer（文件资源管理器）中选中一个文件或目录并按 `Ctrl+Shift+C` 时，会复制该资源的路径；多选或焦点不在 Files Explorer 时，不匹配这条快捷键，继续执行 Fast 原有的 Ctrl+Shift+C 逻辑。

可在 VS Code 设置中搜索 `Fast Bridge` 修改地址、端口、路径和 Token。关闭 `fastBridge.sendText` 后，不再发送选中文本及输入光标附近的文本，但仍发送文件、行列和选区范围等结构信息。

命令面板提供：

- `Fast Bridge: 重新连接`
- `Fast Bridge: 显示日志`
- `Fast Bridge: Copy Selected Explorer Resource Path`

握手和状态消息只发送实例、连接、项目、进程、能力及自动全屏所需字段；不发送安装 ID、IDE/插件版本或不支持的原生窗口信息。

## 日志

插件使用 VS Code 的 `Fast Bridge` `LogOutputChannel`，可通过命令面板的“Fast Bridge: 显示日志”查看；同时在 VS Code 为扩展提供的标准日志目录下按天保存 `fast-vscode-bridge-YYYY-MM-DD.log`。每次写日志时自动删除 3 天以前的日志，仅记录连接、重连和错误摘要，不记录源码、选区或 Token。

## 本地发布

双击 `publish-local-plugin.cmd`，或在 PowerShell 中运行：

```powershell
.\publish-local-plugin.cmd
```

脚本会自动递增补丁版本、安装依赖、生成 `scs-<版本>.vsix`，然后覆盖安装到当前 VS Code。安装完成后，在命令面板执行 `Developer: Reload Window` 加载新版本。

只打包、不安装：

```powershell
.\publish-local-plugin.cmd -NoVersionBump -SkipInstall
```


# LICENSE
This software is released under the terms of the MIT license.
