# Windows 端 + 服务器运行时的测试说明

## 你手上是什么

`C:\Users\q1234\Downloads\Antumi-0.21.7-windows-x64.exe`
（SHA256 `f891d4f17c589d08d459cb900d04bbe0bc5f86e390b050141e50d9eee7a10192`）

这是官方 0.21.7 加了「远程 core」模式的构建。分支/提交：`feat/remote-core` @ `cd998a68`。

**未签名的自构建包**，Windows SmartScreen 会拦一次：点「更多信息 → 仍要运行」。

## 让它在远程模式运行（关键一步）

App 靠 `%USERPROFILE%\.antumi\remote.json` 判断是否进入远程模式。**没有这个文件，它就是原版**
（行为与官方完全一致，本地跑）。

在 Windows 上创建 `C:\Users\q1234\.antumi\remote.json`：

```json
{
  "sshHost": "dev-us",
  "corePort": 19450,
  "remoteHome": "/home/claude/.antumi-remote",
  "startCommand": "bash /home/claude/Projects/antumi/ops/remote-core.sh start"
}
```

- `sshHost` 用你 SSH config 里的 `dev-us`（已知指向 `100.119.182.24`），你的 key 完成认证。
- 端口 **19450** 两端一致，已确认空闲。
- 想回到本地模式：删掉这个文件，重启 App。

PowerShell 一行：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.antumi" | Out-Null
notepad "$env:USERPROFILE\.antumi\remote.json"
```

## 服务器侧已经就绪

- core 正在 `127.0.0.1:19450` 运行，home 是 `/home/claude/.antumi-remote`（与交互式实例隔离）。
  管理：`bash ~/Projects/antumi/ops/remote-core.sh {start|stop|status}`
- **不需要开任何端口**：core 仍只监听回环，Windows 经 SSH 本地转发接入。
- 已验证：Windows `ssh -L 19450` 通、App 握手用的 `cat core.json` 从 Windows 侧可读。

## 打开后应该看到什么

- 窗口标题栏是正常的 Windows 窗口（不是 VNC 画面）。
- 左下角状态从「等待 core」变成已连接。
- **Tasks / Chats 是服务器上的**（与之前 VNC 那套是同一个 home 吗？不是——这是
  `.antumi-remote`，一个新的空库）。
- 选项目时，路径是**服务器上的路径**（例如 `/home/claude/Playground`），不是 `C:\...`。

## 已知缺口（有意为之，不是坏了）

1. **内置浏览器在远程模式下关闭**。点 Browser 面板不会有标签页；agent 的浏览器工具会等待。
   原因见 `docs/REMOTE-CORE.md` §4.3：浏览器宿主是桌面端进程，而 core 在服务器上，两者
   需要一条新通道才能互通。**我选择让它明确不可用，而不是半坏**。
2. **聊天里的图片预览不可用**（文本/HTML/SVG 正常）。
3. 远程 core 不随 App 退出：你关窗口、装更新，服务器上的 agent 继续跑。

## 如果出问题，这样收集证据

App 的日志在 `%APPDATA%\Antumi\logs\`（若目录不同，`dir /s /b %APPDATA% | findstr /i antoni`）。
最有用的三个：

- `main.log` —— 里面会有 `[antumi] remote core unavailable: …` 这类明确原因
  （端口被占 / ssh 失败 / 读不到 core.json）。
- Windows 侧手工复现握手（应输出一行 JSON）：
  ```
  ssh dev-us "cat /home/claude/.antumi-remote/core.json"
  ```
- 手工复现转发（应显示 True）：
  ```
  ssh -N -L 127.0.0.1:19450:127.0.0.1:19450 dev-us
  powershell -c "Test-NetConnection 127.0.0.1 -Port 19450 -InformationLevel Quiet"
  ```

把 `main.log` 里 `[antumi]` 开头的行贴给我即可。

## 测试重点（按重要性）

1. **能不能连上并看到任务列表** —— 这是整条链路通没通的判据。
2. **发一条消息给 agent，它是否在服务器上执行** —— 让它跑 `uname -n`，应为 `dev-us-01`。
3. **退出 App 再打开** —— 隧道应重建，不应报端口冲突。
4. **删掉 remote.json 重启** —— 应回到原版本地模式（证明这个改动对原版是零影响）。
