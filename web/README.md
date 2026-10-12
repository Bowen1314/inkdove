# KBWA 前端（web/）

React 18 + Vite 6，纯 JS。界面中文，面向企业管理员。

## 运行

```bash
npm install
npm run dev     # http://localhost:5194，/api 和 /webhooks 代理到 http://127.0.0.1:8794
npm run build   # 输出到 web/dist，由 server 静态托管（需 SPA 回退到 index.html）
```

依赖：`react` / `react-dom` 18.3.1、`react-router-dom` 6.30、`lucide-react`（图标）；开发依赖 `vite`、`@vitejs/plugin-react`。没有 UI 框架，样式都在 `src/styles.css`（CSS 变量 + 普通 CSS）。

## 结构

```
src/
  main.jsx, App.jsx        路由、登录守卫（GET /api/auth/me → {user}，放进 AuthContext）、AdminOnly 路由守卫、全局 401 → /login
  Layout.jsx               左侧导航（按角色过滤；≤760px 变成可横向滚动的顶栏）+ 右上角用户菜单（修改密码、退出）
  api/client.js            统一请求：401 跳登录、{error, code} 弹 toast、id 一律 encodeURIComponent
  hooks/usePolling.js      setTimeout 链式轮询，卸载/条件变化即停，标签页隐藏时跳过
  lib/
    auth.jsx               useAuth() → {user, isAdmin, setUser}；canUseAccount(user, accountId)
    accounts.js            useAccounts()：号码列表的模块级缓存（15 秒），patchAccountCache / invalidateAccounts / isConnected
    labels.js format.js entryCache.js   文案映射、格式化、条目缓存
  ui/                      Toast、Modal/useConfirm、StatusDot、SecretField、EntryRefs、AccountPicker（号码多选）、
                           ChangePasswordModal、ComingSoon（占位）；common.jsx 里有 PageHeader/Field/Switch/Segmented/
                           TabBar/CopyButton/EmptyState/ErrorState/Loading/Spinner
  pages/
    Login.jsx  Invite.jsx  Overview.jsx  Members.jsx
    Dashboard.jsx  Outreach.jsx  Leads.jsx          占位（即将上线），下一段补
    Files.jsx  files/      两个标签：SourcesTab（知识库资料，原知识库「资料」整块搬来）、SendableTab（占位）
    kb/        KnowledgePage（admin 4 个标签；agent 只读条目+画像）、EntriesTab、DistillTab、DistillBar（整理按钮，两处共用）、
               GapsTab、RedteamTab（占位）、TestChat
    wa/        WhatsAppPage（号码 / 会话两个标签）、NumbersTab、AccountDetail、account/ConnectSection、account/ReplySection、
               ChatsTab、SaveToKbModal
    settings/  SettingsPage + 各区块：LlmSection、ReplySettingsSection、MediaSection、LeadsSection、EmailSection；shared.jsx
```

### 给后续开发的约定

- **加接口**：在 `src/api/client.js` 的 `api` 对象里加一行，用 `get/post/put/del`，路径里的 id 用 `enc()`。默认出错弹 toast；页面要自己显示错误时传 `{silent: true}`，错误对象有 `status`、`code`、`message`。
- **权限**：用 `useAuth().isAdmin` 判断；没权限的按钮直接不渲染。admin 专属页面在 App.jsx 里包 `<AdminOnly>`，导航项在 Layout.jsx 的 `NAV` 里标 `adminOnly`。
- **号码**：`useAccounts()` 拿列表（agent 只会拿到自己的号），改了号以后 `patchAccountCache(account)`，增删后 `invalidateAccounts()`。
- **设置页新区块**：在 `pages/settings/` 新建 `XxxSection.jsx`，接收 `{settings, onSaved}`，草稿用 `useSliceDraft`，外层 `SettingsCard`，底部 `SaveBar`；SettingsPage.jsx 里留了「主动外联」「模型单价」的插入位置。
- **外联、客户**：路由注册成 `/outreach/*`、`/leads/*`，子页面在各自的页面组件里用嵌套 `<Routes>` 加，不用改 App.jsx。

## 前端路由

| 路径 | 页面 |
|---|---|
| `/login` | 登录（邮箱 + 密码） |
| `/invite/:token` | 接受邀请 / 重置密码（不需要登录） |
| `/` | 概览 |
| `/dashboard` | 看板（admin，占位） |
| `/kb/entries` `/kb/gaps` `/kb/distill` `/kb/redteam` | 知识库标签（agent 只有条目）；`/kb/distill?job=<id>` 查看指定任务，`/kb/entries?edit=<id>` 打开指定条目 |
| `/files/sources` `/files/sendable` | 文件：知识库资料（admin）、产品资料（占位） |
| `/whatsapp/numbers` `/whatsapp/numbers/:accountId` | 号码列表、号详情 |
| `/whatsapp/chats?account=<accountId>&chat=<conversationId>` | 会话；两个参数都可选 |
| `/whatsapp?chat=<encodeURIComponent(conversationId)>` | 通知里的链接，自动跳到「会话」并选中 |
| `/outreach/*` `/leads/*` | 外联、客户（占位） |
| `/members` `/settings` | 成员、设置（admin） |

旧地址 `/kb/sources` 跳到 `/files/sources`；`/whatsapp/connect`、`/whatsapp/reply` 跳到 `/whatsapp/numbers`。

轮询：整理任务 queued/running 时每 1.5 秒；会话页每 4 秒拉会话列表和当前消息；号码列表每 6 秒；号详情在扫码、启动中时每 3 秒刷新状态和二维码（`/api/accounts/:id/waha/qr?t=<时间戳>`）。离开页面即停。

## 偏离规格

没有改动接口、字段名或枚举值。以下是规格没写清楚、按"最简单能跑通"处理的地方：

1. **"蒸馏"在界面上叫"整理知识库"**（按产品要求，接口名不变）；"缺口"叫"待补充问题"。
2. **会话用查询参数 `?chat=` 选中，不放在路径里**。会话 id 形如 `<accountId>:123@c.us`，放在路径段里像带扩展名的文件，容易被静态托管或 SPA 回退当成文件处理而 404。参数名和通知链接一致。
3. **Meta 的 accessToken / appSecret、SMTP 密码只显示"已设置"，没有后四位**：接口只给了 `*Set` 布尔值。LLM apiKey 有 `apiKeyLast4`，显示"已设置 · 后四位 xxxx"。
4. **"反复离题，静默到 HH:mm"**：截止时间不在今天时显示"明天 HH:mm"或"M月D日 HH:mm"，否则跨天看不出是哪天。
5. **"测试连接""发送测试通知"会先保存未保存的修改**：这两个接口不带参数，只测已保存的配置。
6. **整理任务的选取**：假设 `GET /api/distill/jobs` 按时间倒序；进入"整理进度"时优先显示 queued/running 的任务，否则显示列表第一个。
7. **增量整理不传 sourceIds**，即处理所有未整理且可用的资料；界面没有做手动勾选。
8. **`PUT /api/kb/profile` 的返回**规格没写：返回的是 Profile 就直接用，否则在本地合并。
9. **查看引用条目**：没有单条查询接口，用 `GET /api/kb/entries` 全量列表按 id 查找，缓存 30 秒。
10. **测试对话兼容旧返回**：没有 `decision` 字段时，按 `handoff` / `confident` 推断。
11. **"测试代理"也会先保存未保存的修改**，和其他测试按钮一致；"使用代理"开关没打开时测试按钮置灰（否则必然得到 400 `proxy_disabled`）。代理开关跟着"保存代理设置"一起提交，不像自动回复开关那样点了就生效，因为改代理会重启 WhatsApp 连接。
12. **代理端口**：输入框留空时提交 `port: null`；开启代理时地址和端口必填，地址不能带 `socks5://` 之类的前缀。
13. **改代理的提示**：已连接时只要有未保存的代理修改，就提示"修改代理会重启 WhatsApp 连接"（按协调方给的文案）。SPEC 4.5 另有"修改代理需要重新扫码"的说法，取决于后端能否保住登录态，前端没有单独区分；保存后 30 秒内持续刷新状态，需要重新扫码时会自动出现二维码。
14. **代理折叠头部显示开关状态**：收起时也能看到"已开启 / 未开启"和协议、地址。
15. **LLM 接口格式**：后端返回的 `llm.format` 不在三种之内时，下拉框按 `openai` 显示。

### 第二期第 1 段新增

16. **号码筛选放在 URL 参数 `?account=`**，刷新和分享链接后保留；切换筛选时清掉当前选中的会话。
17. **全局 401 只在 `code` 为 `unauthorized` 或没有 code 时跳登录**，避免改密码时"当前密码错误"的 401 把人踢出去。登录、邀请、改密码三个接口自己处理错误。
18. **扫码启动 / 登出的返回**规格写的是"语义同 SPEC.md 3.6"：返回完整 Account 就整个替换，只返回状态（`{state, …}` 或 `{status}`）就合并进当前号（`mergeAccount`）。
19. **kb-draft 的返回**规格没写外层：`{type,title,content,tags}`、`{entry:{…}}`、`{draft:{…}}` 三种都接（`unwrapDraft`）。type 不在四种之内时按 faq。
20. **存进知识库时前端带上 `sourceRefs`**：`[{sourceId:null, sourceName:"会话：<客户名或号码>", quote:<人工回复前 200 字>}]`，status 为 active。后端如果自己补引用，可以忽略这个字段。
21. **"存进知识库"的触发**：桌面悬停或键盘聚焦人工消息时出现；触屏长按 0.45 秒出现。只给 admin，发送失败的消息不显示。
22. **缺口的"客户问过 N 次"**：来自会话的缺口次数 ≥1 就显示，其他来源只在 ≥2 次时显示；≥2 次用琥珀色。来自会话且有 `conversationId` 时才有"打开会话"。
23. **agent 读不了 `/api/settings`**，所以号详情里 agent 看不到"全局没配发信方式"的预先提示；agent 打开邮件通知时靠后端的 400 `email_not_configured` 再提示并置灰。admin 会预先读设置，没配时开关直接置灰（已开着的仍可关）。
24. **成员页不显示自己那一行的停用和删除**，编辑弹窗里也不能改自己的角色，免得把自己锁在外面。最后一个 admin 的保护以后端 `last_admin` 为准，错误直接弹出。
25. **整理按钮放两处**：「文件 → 知识库资料」列表上方，和「知识库 → 整理进度」没有进行中任务时，同一个组件 `DistillBar`。知识库默认标签改为「条目」（「资料」搬走了）。
26. **语音和图片识别按"已保存的"接口格式判断**能开哪些：Anthropic 语音开关置灰（已开着的仍可关），转写模型只在 OpenAI 兼容时可填，开启语音时前端先校验必填；后端 400 `transcribe_model_required`、`voice_unsupported_for_format` 显示在对应字段下。
27. **设置页每个区块单独保存**，各自 PUT 自己那一块；"发送测试邮件"和"测试连接"一样会先保存未保存的修改。SMTP 加密方式切换时，端口还是另一种的默认值（465 / 587）就跟着换。
28. **客户线索开关点了就保存**，不用再点保存按钮（和号码卡片上的自动回复开关一致）。
29. **概览**：只有 admin 看到"开始使用"三步、资料统计和条目分类（agent 不调 `/api/kb/stats`，只看"我负责的号"）；第 3 步"添加一个 WhatsApp 号"在至少有一个号已连接时算完成。号码状态优先用 `GET /api/accounts`（带自动回复状态），拿不到时退回 `health.accounts`。
30. **owner 消息**（手机上直接回复的）用灰色气泡靠右，标"手机回复"；`via:"campaign"` 的机器人消息标"外联"、不显示处理详情；人工消息 `via:"whatsapp"` 标"人工 · 经 WhatsApp 转发"，否则标"人工 · <sentByName>"。
31. **代理协议四种都可选**（F13 中继），新开代理默认 SOCKS5。

