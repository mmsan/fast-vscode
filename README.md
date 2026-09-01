# fast-bridge

快捷指令和 SCS 语言支持。

## Fast Bridge

三个插件都支持通过 `command.getSelectedText` 主动读取当前编辑器选中文本，并通过 `command.getCurrentLineContent` 读取当前代码行；Fast 端快捷调用分别为 `await f.editorBridge.getCurrentSelectedText()` 和 `await f.editorBridge.getCurrentLineContent()`。选区结果和上次主动读取不同时会立即返回；相同时插件每隔 30 毫秒复读一次，发现变化便提前返回，始终相同则在 200 毫秒时返回最新结果。没有选择时前者返回空字符串，关闭 `fastBridge.sendText` 或没有活动编辑器时返回 `null`。VS Code 的查询框等非编辑器输入框会被识别为输入焦点；由于 VS Code 扩展 API 不直接暴露内置查询框的选区文本，`ctrlC()` 会在主动读取返回 `null` 时回退到原生 Ctrl+C，从而继续获取该输入框中的选中内容。

在 VS Code 的 Files Explorer 中选中一个或多个文件/目录并按 `Ctrl+Shift+C` 时，插件会复制全部资源路径。WebSocket 命令 `command.copyResourcePath` 在 `data.paths` 返回全部绝对路径；单选时还保留兼容字段 `data.path`。

插件启动后默认连接 `ws://127.0.0.1:19900`，协议兼容 Fast Idea Bridge。它会上报当前工作区、文件、文本输入光标、选区及多光标状态，并支持服务端发起状态查询、文件导航、文本选择、查找、编辑器聚焦、编辑器全屏、资源管理器文件路径复制、`command.deleteSelection`、`command.home`、`command.end`、`command.inputTop`、`command.shiftDown`、`command.shiftUp` 和 `command.moveUpIfLastLine` 命令。`command.deleteSelection` 只有在当前选区内容与 `payload.expectedText` 完全一致时才删除；内容不一致时成功返回但不修改文档。`home` 清除选择并移动到逻辑行首；`end` 清除选择并移动到逻辑行尾；`inputTop` 会跳过文件顶部连续的整行 `//`、Python `#` 和 `/* ... */` 注释，在第一个非注释行上方插入 `payload.code` 和换行，不主动处理光标或当前选区；`shiftDown`、`shiftUp` 调用 VS Code 原生方向移动并扩展选择，可通过 `payload.count` 指定步数，默认 `1`。`home`、`end` 和 `inputTop` 按逻辑文档位置执行，不受自动换行影响；`moveUpIfLastLine` 仅在主光标位于最后一行时清除选区并上移一行，否则返回 `handled: false`。查找通常限制在当前工作区内；当前已经作为文本编辑器文档打开的临时文件可按其精确路径查找，未打开的工作区外文件仍会被拒绝。

状态快照中的 `payload.activeEditor.context` 表示光标最内层的通用语法上下文，`expressionContext` 提供表达式、对象类型、方法返回值、参数和成员信息；VS Code 通过 Hover 和 Completion Provider 尽力解析这些字段，方法成员同时提供 `returnType` 和兼容的 `type`。`editor.statusChanged` 只在输入能力或当前对象信息变化时发送，不再发送高频的 `editor.caretChanged` 和 `editor.documentChanged`。`command.getInputable`、`command.getContext`、`command.getObjectInfo`、`command.getSelectedText` 和 `command.getCurrentLineContent` 可主动读取当前状态，对应 Fast 端调用为 `await f.editorBridge.getCurrentInputable()`、`await f.editorBridge.getCurrentContext()`、`await f.editorBridge.getCurrentObjectInfo()`、`await f.editorBridge.getCurrentSelectedText()` 和 `await f.editorBridge.getCurrentLineContent()`。VSCode 插件不提供 `command.isEditorFocused`；Fast 端的 `await f.editorBridge.isEditorFocused()` 直接调用主进程的 Windows 原生焦点检测。`command.getContext` 返回 `singleQuote`、`doubleQuote`、`backtick`、`parentheses`、`braces` 或 `none`；没有活动编辑器时返回 `null`。`command.queryPythonPackages` 按需批量查询目标工作区解释器中的指定包。`payload.fullScreen` 表示 VS Code 是否全屏；`payload.editorOpenedAt` 是当前编辑器打开时间的 Unix 毫秒时间戳。`command.isFullScreen` 会重新查询当前窗口的全屏状态，返回 `data.fullScreen` 的 `true`、`false` 或未知的 `null`。自动全屏会在握手后查询，确认未全屏才发送 `command.fullScreen`，并在切换后再次查询确认；宿主尚未就绪时会在编辑器打开后的 30 秒内重试。`command.fullScreen` 会幂等地执行 `workbench.action.toggleFullScreen`。
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
