# fast-bridge

快捷指令和 SCS 语言支持。

## Fast Bridge

插件启动后默认连接 `ws://127.0.0.1:19900`，协议兼容 Fast Idea Bridge。它会上报当前工作区、文件、文本输入光标、选区及多光标状态，并支持服务端发起状态查询、文件导航、文本选择、查找、编辑器聚焦、编辑器全屏和资源管理器文件路径复制命令。

状态快照中的 `payload.fullScreen` 表示 VS Code 是否全屏；`payload.editorOpenedAt` 是当前编辑器打开时间的 Unix 毫秒时间戳。握手 payload 也包含这些全屏判断字段，总服务只在 `bridge.hello` 时执行一次自动全屏判断。`command.fullScreen` 会幂等地执行 `workbench.action.toggleFullScreen`，已全屏或状态未知时不会切换。

在 VS Code 的 Files Explorer（文件资源管理器）中选中一个文件或目录并按 `Ctrl+Shift+C` 时，会复制该资源的路径；多选或焦点不在 Files Explorer 时，不匹配这条快捷键，继续执行 Fast 原有的 Ctrl+Shift+C 逻辑。

可在 VS Code 设置中搜索 `Fast Bridge` 修改地址、端口、路径和 Token。关闭 `fastBridge.sendText` 后，不再发送选中文本及输入光标附近的文本，但仍发送文件、行列和选区范围等结构信息。

命令面板提供：

- `Fast Bridge: 重新连接`
- `Fast Bridge: 显示日志`
- `Fast Bridge: Copy Selected Explorer Resource Path`

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
