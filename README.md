# fast-bridge

让 FastGoTo 与 VS Code 配合工作: 识别你正在编辑的文件和光标位置, 并在你使用 FastGoTo 的相关功能时完成文件跳转、查找、选择和文本输入.

这是 FastGoTo 的配套扩展. 编辑器联动需要本机运行 FastGoTo 及其编辑器连接服务; 单独安装扩展不会提供完整的 FastGoTo 功能.

本扩展免费, FastGoTo 提供免费功能及可选的 VIP 订阅.

## 安装

在 VS Code 扩展面板搜索 `@id:mmsan.scs`, 安装发布者为 **mmsan** 的 **fast-bridge**.

也可以从 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=mmsan.scs) 安装. 已经安装的用户可以在扩展面板检查更新.

如果拿到的是 `.vsix` 文件, 在扩展面板右上角的菜单中选择 **Install from VSIX...**, 然后选择安装包. 按 VS Code 提示重新加载窗口.

## 开始使用

1. 启动 FastGoTo, 确保其编辑器连接服务已运行.
2. 在 VS Code 中打开要编辑的文件或项目.
3. 扩展会通过本机 Windows Host 自动获得短时连接凭据和实际端口, 无需输入 Token.
4. 回到 FastGoTo 使用需要编辑器配合的功能, 例如跳转到文件、查找文字或向当前编辑位置输入内容.

通常无需手动配置. 如果连接没有建立, 打开命令面板, 执行 **Fast Bridge: 显示日志**, 查看连接状态和错误信息.

## 你可以做什么

- 让 FastGoTo 获取当前文件、工作区、光标和选区位置, 减少手动切换和复制路径.
- 从 FastGoTo 打开文件并跳转到指定位置, 查找或选择文本.
- 配合 FastGoTo 在当前编辑器输入、替换选中文本或移动光标.
- 在资源管理器或“已打开的编辑器”列表中选中文件或文件夹, 按 `Ctrl+Shift+C` 复制路径. 支持多选.

扩展也保留了 SCS 文件的语法高亮和格式整理功能. 在 SCS 编辑器中可使用 `Alt+Shift+F`; 命令面板中的对应命令名为 **Beautify SQL**.

## 连接与隐私设置

打开 VS Code 设置, 搜索 `Fast Bridge`.

| 设置 | 默认值 | 什么时候需要修改 |
| --- | --- | --- |
| `fastBridge.host` | `127.0.0.1` | 保留的本机地址设置, 仅接受 loopback |
| `fastBridge.port` | `9072` | 保留设置; 实际端口由本机 Host 提供 |
| `fastBridge.path` | 空 | 服务要求指定连接路径时 |
| `fastBridge.token` | 空 | 兼容保留, 不再用于连接认证 |
| `fastBridge.autoConnect` | 开启 | 关闭后停止自动连接; 需要联动时重新开启 |
| `fastBridge.sendText` | 开启 | 不希望共享选中文本或光标附近的内容时关闭 |
| `fastBridge.contextCharacters` | `200` | 调整光标前后各自最多共享的字符数, 范围为 0–10000 |

连接仅支持本机 Windows Host, 不接受远程服务或旧 Bearer Token. Host 检查实际 VS Code 进程, 扩展在同一个命名管道句柄上核验 Host PID 和安装路径. 一次性凭据仅保存在内存, 最长 30 秒过期; 双向 nonce/HMAC 认证完成后才传输应用消息, 后续消息使用有序 AES-256-GCM 加密帧. Host 授权丢失或更换时, 已有连接失效.

开启文本共享时, 扩展会向经过认证的本机服务发送选中文本和光标附近的内容, 并允许 FastGoTo 按需读取当前行或选中文本. 关闭文本共享后, 文件路径、光标位置和选区范围等结构信息仍会用于联动, 但相关文本读取功能不可用.

经过认证的本机服务也能请求编辑器执行操作, 包括修改文本. 扩展、Host 和 FastJS runtime 需要配套更新; 旧的明文连接不会回退.

## 常见问题

**安装后没有连接?**

先确认已启动配套版本的 FastGoTo 和 FastJS runtime, 以及 `fastBridge.autoConnect` 是否开启. 远程工作区和非 Windows 环境不会绕过本机认证. 然后在命令面板执行 **Fast Bridge: 重新连接**.

**连接成功, 但读取不到选中文字?**

确认文本选在代码编辑器内, 并且 `fastBridge.sendText` 已开启. 搜索框等输入框不等同于代码编辑器, 扩展无法直接读取所有这类控件的选区.

**复制路径快捷键没有生效?**

先在资源管理器或“已打开的编辑器”列表选中目标资源. `Ctrl+Shift+C` 的路径复制只在这些列表获得焦点时生效.

**在哪里查看日志?**

执行 **Fast Bridge: 显示日志**, 打开 `Fast Bridge` 输出面板. 扩展保留最近 3 天的按日日志, 记录连接和错误摘要, 不记录源码、选区内容或 Token.

## 许可证

本扩展采用 MIT 许可证, 完整条款见安装包中的 LICENSE.txt.

源码与问题反馈: [mmsan/fast-vscode](https://github.com/mmsan/fast-vscode).
