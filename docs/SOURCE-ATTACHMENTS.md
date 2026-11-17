# 禅道附件下载通道

> 目标：inbox 里的禅道任务，其附件（如 `前端UI.rar` 38MB）能在 Antumi 里下载。
> 涉及 **插件 SDK 契约 + core + 桌面端** 三层，是协议级改动。

## 1. 为什么不能照搬图片通道

图片通道是「快照时全量下载」：`fetch()` 返回 `images: [{name, bytes}]`，core 存进
attachments，快照只留 id。这对截图合适（2MB、一两张），对附件不合适：

| | 图片（现状） | 附件（本次） |
| --- | --- | --- |
| 典型大小 | 2 MB | **38 MB**，可能更大 |
| 数量 | 每任务 1–3 张 | 可能几十个 |
| 用户是否总要 | 是（正文的一部分） | **否**（可能永远不看） |
| 结论 | 快照时下载合理 | **按需下载**，点击才取 |

所以附件走「**列表随快照、字节按需**」：快照里只放附件的元数据，用户点下载时才向插件要字节。

## 2. 设计

### 2.1 插件 SDK：新增 `attachment()` 回调

```ts
attachment?(settings, credential, key, id, signal): Promise<{ name: string; bytes: Uint8Array }>
```

- `key` 是事项编号（`task-13176`），因为同一文件 id 在不同事项下权限不同；
- `id` 是源系统内的附件标识（禅道里就是它的 fileID）；
- 与 `image()` 同形，但**语义不同**：图片是快照的一部分，附件是独立产物。

### 2.2 快照里声明的附件列表

`SourceIssueDetail` 增加：

```ts
attachments?: readonly { id: string; name: string; size: number | null }[]
```

渲染成 markdown 的 `## 附件` 一节会带上下载入口（由桌面端识别，不是裸链接）。

### 2.3 RPC：`sources.attachment`

```ts
'sources.attachment': {
  params: IssueRef.extend({ attachmentId: z.string().min(1).max(200) }),
  result: z.object({ name: z.string(), bytes: z.string() /* base64 */, size: z.number() })
}
```

**为什么返回 base64 而不是走文件系统**：客户端可能在另一台机器（远程 core 模式下必然如此），
写服务器磁盘再让客户端读是错的。

**为什么不分块**：`read()` 已有 offset/length 能力，但 RPC 层做流式需要新的传输约定；
当前最大附件 38MB，base64 后 ~51MB，一次性传输在本地环回/SSH 隧道上可接受。
分块是**下一步**，不是现在——记在 §5。

### 2.4 core

`sources.attachment` → `SourceService.attachment()`：
校验来源已配置 → 调 `provider.attachment()` → 返回字节。

**不落 `AttachmentStore`（原设计错了，已改）**：那个 store 是**图片**仓库——它 `inspectImage()`
校验格式、读宽高、剥元数据、只接受 PNG/JPEG/GIF/WebP。`.rar` 进去会直接被拒
（实测：`only PNG, JPEG, GIF and WebP images are accepted`）。

把它强行扩成「通用文件仓库」是个更大的改动：宽高字段对 rar 无意义，`IMAGE_MIME` 是一张封闭表，
而 sweep/GC 的语义也按图片设计。**所以附件只转发、不存档**：一次下载一次转发，`id` 原样回传
（来源自己的句柄），重试可识别。

代价：同一附件下载两次要取两次。考虑到 38MB / 30 秒的实测代价，这不如「正确」重要——
以后真要做「agent 分析附件」，应当建一个**文件**仓库，而不是把图片仓库改成通用仓库。

### 2.5 桌面端

`## 附件` 一节里的每一项渲染成按钮；点击 → `sources.attachment` → 用浏览器的
`showSaveFilePicker` 或 Electron 的保存对话框落盘。

## 3. 二阶 / 三阶影响

| 影响 | 处理 |
| --- | --- |
| **51MB 走 JSON-RPC** | 实测：38.1MB 文件下载 29.8s，base64 46ms，载荷 50.9MB。瓶颈在网络，不在编码。一次传输可接受；**没有进度**是体验缺口（§5） |
| **插件被调用时的凭据** | 复用 `list`/`fetch` 的 credential，不新增凭据路径 |
| **恶意附件名** | 下载时只把 name 当**建议名**，落盘前经 Electron 的保存对话框，用户可改；不做路径拼接 |
| **附件可执行** | 不自动打开，只保存；打开由用户决定（与 `openFile` 的既有策略一致） |
| **失败重试** | 单个附件失败只报该附件，不影响快照 |
| **未实现该回调的插件** | 附件列表照常显示，下载按钮报「该来源不支持下载」——**不是静默消失** |
| **上游分歧** | SDK 是插件契约，改它意味着上游升级时冲突面大；因此**新增可选回调**，不改既有签名 |

**三阶**：若将来要做「agent 直接读附件」，应当复用 attachment store 的 id，而不是再传一次字节。

## 4. 验证

1. 单元：SDK 类型、core 的 `attachment()` 拒绝未知来源、桌面端的按钮渲染。
2. 真实站点：下载 `前端UI.rar`，断言大小 40002875 字节。
3. 端到端：inbox → 点附件 → 落盘 → 文件大小与校验和一致。

## 5. 已知缺口

- **不分块**：>50MB 的附件会一次性进内存。分块需要新的传输约定，按需再做。
- **进度条**：一次性传输没有进度。分块之后才有意义。
