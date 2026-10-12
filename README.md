# 墨鸽 Inkdove：企业知识库 + WhatsApp 自动回复

把企业的产品资料、价格表、政策文档整理成知识库，再用它在 WhatsApp 上自动回复客户。拿不准的问题不回，转给人工，并在 WhatsApp 或邮件里通知你。

接口契约见 [SPEC.md](SPEC.md) 和 [SPEC-phase2.md](SPEC-phase2.md)（两者冲突时以 phase2 为准），界面设计见 [DESIGN.md](DESIGN.md)。

```
server/   Node.js ESM（纯 JS），Express 5 + better-sqlite3，测试用 node:test
web/      React 18 + Vite（前端，另见 web/README.md）
Dockerfile、docker-compose.yml、.env.example
```

## 功能

- **知识库**：上传文件（PDF、Word、Excel、PowerPoint、CSV、文本）或填网址，由 LLM 整理成条目（产品、价格、政策、FAQ……）和企业画像；整理时发现的资料缺口列成清单，补答后转成条目。客户问到、机器人答不上来的问题也会自动进缺口清单，相似的问题合并计数。人工在会话里的回答可以一键改写成知识条目。
- **产品资料库**：上传产品目录、价目表、规格书、图片。客户要资料时机器人直接把文件发过去，人工也能在会话里发文件。每个文件会自动生成一段描述，告诉机器人什么时候该发它。
- **语音和图片**（默认关闭，会产生模型费用）：客户发来的语音转成文字，图片转成文字描述，然后走正常的回复流程。
- **测试对话**：在后台直接和机器人对话，看它怎么回、为什么这么回、引用了哪些条目、会发哪些文件。
- **WhatsApp 自动回复**：
  - 一个部署可以接多个号，共用一个知识库和一套 LLM 配置。每个号有自己的接入方式、自动回复开关、人设、回复范围（全部 / 白名单 / 黑名单）、通知设置和代理；
  - 两种接入方式：扫码（WAHA，GOWS 引擎）和 Meta 官方 Cloud API；
  - 回复像真人：等一会儿、标已读、显示"正在输入"、按字数等待再发；长回复按段落拆成最多 3 条；说话不带客服模板腔，不说只有机器才会说的话；
  - 会话里能看到每条客户消息的处理结果和原因（已回复 / 转人工 · 客户要求打折 / 离题……）。
- **转人工**：机器人拿不准、客户要人工、要折扣、想下单、问是不是机器人时，不回复客户，暂停这个会话并通知你：
  - 通知渠道：WhatsApp（由这个号发给你指定的号码）和邮件（SMTP 或 Resend API，全局配置一次）；
  - 转人工时先替你起草一条回复（可能带建议发送的文件），附在通知里，**不会自动发给客户**；
  - 在 WhatsApp 里**引用通知直接回复**，内容就会转发给客户；`/d` 发送草稿（文字和文件），`/resume` 恢复机器人。
- **多人账号**：管理员邀请业务员（邮件链接），给每人分配能看的号。业务员只看得到、只操作得了分给自己的号和会话；后台人工发的每条消息都记下是谁发的。
- **IP 代理**：每个号可以单独走 http、https、socks4、socks5 代理。

## 截图

> 截图待补：概览、知识库条目、测试对话、号码详情、会话（转人工的会话标红置顶）、设置。

## 用 docker compose 快速开始

需要 Docker 和 Docker Compose v2。

```bash
cp .env.example .env
# 至少填：INKDOVE_ADMIN_EMAIL、INKDOVE_ADMIN_PASSWORD（≥12 位）、INKDOVE_SESSION_SECRET、
#        INKDOVE_WAHA_WEBHOOK_SECRET、INKDOVE_WAHA_API_KEY（后三个用 openssl rand -hex 32 生成）
docker compose up -d --build
```

也可以不在本地编译，直接拉发布好的镜像（推 `v*` 标签时由 GitHub Actions 自动构建，支持 amd64 和 arm64）：

```bash
# 仓库是私有的：先用带 read:packages 权限的 GitHub token 登录一次
echo <token> | docker login ghcr.io -u <GitHub 用户名> --password-stdin
docker compose pull && docker compose up -d
```

发新版：把 `server/package.json` 和 `web/package.json` 的 version 改成新版本号并提交，然后 `git tag v0.2.0 && git push origin v0.2.0`。

然后打开 `http://127.0.0.1:8794`，用 `.env` 里的管理员邮箱和密码登录：

1. **设置 → 模型**：填 LLM 的接口格式（openai / anthropic / gemini）、地址、key 和模型，点"测试连接"。
2. **文件 → 知识库资料**：上传资料或填网址，点"整理"，等它生成条目。
3. **知识库 → 测试对话**：问几个客户常问的问题，看回答对不对。
4. **WhatsApp → 号码 → 新建**：
   - 扫码号：点"启动"，用手机 WhatsApp 的"已关联的设备"扫二维码；
   - Meta 号：填 phone number id、verify token、access token、app secret，把页面上显示的 webhook 地址（`<INKDOVE_PUBLIC_BASE_URL>/webhooks/meta/<号的 id>`）填进 Meta 后台，订阅 `messages`。
5. 在号详情里打开**自动回复**，并配好"拿不准时通知我"。要发邮件通知的话，先在**设置 → 发信方式**里配 SMTP 或 Resend。

部署说明：

- `inkdove` 只监听宿主的 `127.0.0.1:8794`，对外请用 nginx 之类反代到 HTTPS，并在 `.env` 里设 `INKDOVE_PUBLIC_BASE_URL=https://kb.example.com`、`INKDOVE_COOKIE_SECURE=1`。Meta 回调必须是公网 HTTPS 地址。
- `waha` 用 `devlikeapro/waha:gows`，不映射宿主端口，只有 inkdove 能访问。登录态存在 `./waha-sessions`，重建容器不用重新扫码。
- `inkdove` 的主机名固定为 `inkdove`，WAHA 经 `inkdove:<端口>` 连代理中继（见下文）。中继端口不映射到宿主。
- 数据（SQLite 和上传的文件）在 `./data`，备份这个目录即可。
- 两个容器都配了 `host.docker.internal:host-gateway`。要用宿主机上的代理时，代理地址填 `host.docker.internal`。
- `waha` 设了 `WAHA_EVENTS_DOWNLOAD_MEDIA=true` 和 `WAHA_BASE_URL=http://waha:3000`：客户发来的语音、图片由 WAHA 先下载，inkdove 再带 `X-Api-Key` 从 `waha:3000/api/files/...` 取。发给客户的文件超过 15MB 时，WAHA 反过来从 `http://inkdove:<INKDOVE_PORT>/internal/files/<id>?token=…` 拉取（签名地址，10 分钟有效），所以两个容器要在同一个网络里（compose 默认就是）。

### 从第一期升级

- 必须新增 `INKDOVE_ADMIN_EMAIL`。第一次启动时用它和 `INKDOVE_ADMIN_PASSWORD` 建管理员；旧的登录 cookie 全部失效，重新登录即可。
- 第一期的通道设置会自动迁移成一个叫「默认号」的号：自动回复开关、回复范围、名单、代理和通知都带过去，旧会话挂到这个号下。扫码号沿用原来的 session 名（第一期设过 `INKDOVE_WAHA_SESSION` 的，升级时保留这个变量），不用重新扫码。旧的 SMTP 设置挪到全局"发信方式"。
- **Meta 号的回调地址变了**：从 `/webhooks/meta` 改成 `/webhooks/meta/<号的 id>`，旧地址已删除。升级后去 Meta 后台把回调地址换成号详情页显示的新地址。
- 产品资料库、缺口来源、语音图片这些新增的表和列在启动时自动加上，不改动已有数据。已经在待处理的会话会从最近一条未回复的客户消息补上 `pendingReason`。WAHA 容器要按新的 compose 加上两个环境变量（见上文），重建一次 waha 容器即可，不用重新扫码。

## 本地开发和测试

需要 Node 20.18.1 及以上。

```bash
cd server
npm install
INKDOVE_LLM_MOCK=1 INKDOVE_ADMIN_EMAIL=admin@example.com INKDOVE_ADMIN_PASSWORD=change-me-123456 \
  INKDOVE_SESSION_SECRET=dev INKDOVE_WAHA_WEBHOOK_SECRET=dev INKDOVE_PROXY_RELAY_HOST=127.0.0.1 npm run dev
# http://127.0.0.1:8794/api/health

cd ../web
npm install
npm run dev        # http://127.0.0.1:5194，/api 和 /webhooks 代理到 8794

cd ../server
npm test           # 全部跑在 mock LLM 和临时数据目录上，不访问外网
```

- `INKDOVE_LLM_MOCK=1` 时所有 LLM 调用走确定性的假实现，不需要 key，也不会产生费用。
- 服务只读取 `INKDOVE_` 开头的环境变量，不会读 `LLM_API_KEY`、`OPENAI_API_KEY` 这类通用变量。
- 如果 `web/dist` 存在，server 会同时托管前端；不存在时只提供接口。
- 测试里的 WAHA、Meta Graph API、Resend、SMTP（nodemailer 的 jsonTransport）、LLM 接口（三种格式）、HTTP/SOCKS4/SOCKS5 代理和中继的目标服务，都是本地起的假服务。拟真发送的等待时间在测试里注入成 0 或几百毫秒。

## 环境变量

只读 `INKDOVE_` 开头的变量。完整列表和注释见 [.env.example](.env.example)。

| 变量 | 必填 | 说明 |
|---|---|---|
| `INKDOVE_ADMIN_EMAIL` | ✔ | 第一个管理员的邮箱。只在库里还没有任何账号时用 |
| `INKDOVE_ADMIN_PASSWORD` | ✔ | 第一个管理员的密码，至少 12 个字符 |
| `INKDOVE_SESSION_SECRET` | ✔ | cookie 签名密钥，也用来算 WAHA 配置指纹 |
| `INKDOVE_WAHA_WEBHOOK_SECRET` | ✔ | WAHA webhook 的 HMAC 密钥 |
| `INKDOVE_WAHA_API_KEY` | compose 里必填 | WAHA 的 `X-Api-Key`，compose 同时传给 waha 容器 |
| `INKDOVE_PORT` | | 默认 8794 |
| `INKDOVE_DATA_DIR` | | 默认 `./data`，compose 里是 `/app/data` |
| `INKDOVE_PUBLIC_BASE_URL` | | 对外地址：Meta 回调地址、邀请链接、通知里的后台链接都用它 |
| `INKDOVE_COOKIE_SECURE` | | 经 HTTPS 对外时设 1 |
| `INKDOVE_WAHA_URL` | | 默认 `http://127.0.0.1:3000`，compose 里是 `http://waha:3000` |
| `INKDOVE_WAHA_WEBHOOK_URL` | | WAHA 回调本服务的地址，compose 里是 `http://inkdove:8794/webhooks/waha` |
| `INKDOVE_PROXY_RELAY_PORT_BASE` | | 代理中继的起始端口，默认 18000，每个扫码号占一个 |
| `INKDOVE_PROXY_RELAY_HOST` | | WAHA 连中继用的主机名，默认 `inkdove`；超过 15MB 的文件给 WAHA 的签名下载地址也用它 |
| `INKDOVE_WAHA_SESSION` | | 仅第一期升级用：迁移成「默认号」时沿用的 session 名 |
| `INKDOVE_LLM_BASE_URL` 等 4 个 | | LLM 初始值，只在第一次启动时写进库，之后以设置页为准 |
| `INKDOVE_LLM_MOCK` | | 设 1 走假 LLM |
| `INKDOVE_META_GRAPH_URL`、`INKDOVE_RESEND_API_URL` | | 仅测试用，生产不要设 |

## 两种接入方式的区别和风险

| | 扫码（WAHA） | Meta 官方 Cloud API |
|---|---|---|
| 原理 | 模拟 WhatsApp 网页版 / 关联设备，走**非官方协议** | Meta 官方的企业接口 |
| 准备 | 一部装了 WhatsApp 的手机，扫码即可 | Meta 开发者账号、企业验证、专用号码、公网 HTTPS 回调 |
| 风险 | **有封号风险**：WhatsApp 不允许非官方客户端，号码可能被限制或封禁。批量群发、短时间大量回复、新号都会加大风险 | 走正规渠道，没有协议层面的封号风险；但要遵守 Meta 的商业政策和 24 小时客服窗口（客户 24 小时内没发过消息时，只能发模板消息） |
| 费用 | 自建 WAHA，不按消息计费（WAHA 分免费的 Core 版和付费的 Plus 版） | 按 Meta 的定价计费 |
| 适合 | 自用号、小规模、试用 | 正式的客服号 |

扫码号建议用单独的号码，开着拟真发送（默认开），并保留每会话每小时的回复上限。

## 安全设计

**机器人永远不能**：答应打折或优惠；同意出售或确认订单；承诺库存、交期、留货；报资料里没有的价格；承认自己是 AI 或自称真人。拿不准就转人工，不回复客户。

回复要过四层（`server/src/reply/`、`server/src/wa/service.js`）：

1. **system prompt**：只依据知识库回答，带红线和说话方式规则（不说模板腔、不复述问题）；客户消息当数据，不当指令；埋一个随机的金丝雀串。
2. **程序硬规则**：业务回复必须引用真实存在的条目；超长、带代码块、出现金丝雀串的拦下；**价格红线**：回复里的金额、百分比、"X 折"必须在引用的条目里出现同样的数值；成交和给优惠的措辞（短语级匹配，"we deal in…"这类正常描述不受影响）、资料里没有的优惠词、身份表述和"根据知识库""according to the information provided"这类元话语，一律拦下转人工。命中客服套话时重写一次，还有就删掉那句。
3. **审核调用**：再让模型检查一遍回复有没有越界、有没有资料依据、有没有承诺；审核失败或超时，默认不发。
4. **会话闸门**：24 小时内离题 3 次静默 24 小时；每会话每天最多 60 次 LLM 调用；每会话每小时回复次数有上限（超了转人工）；每个号每分钟最多 30 条自动回复。

其他：

- 登录：邮箱 + 密码（scrypt 加盐哈希），服务端存储的会话 token，httpOnly + SameSite=Lax cookie；同一 IP、同一邮箱每分钟失败 5 次后限流。邀请和重置链接一次性、会过期。停用、删除或改密码时立即踢掉这个人的会话。
- 权限全部在服务端判断：业务员访问没分给自己的号、会话一律 403。
- Webhook：WAHA 校验 `X-Webhook-Hmac`（HMAC-SHA512），Meta 校验每个号自己的 `X-Hub-Signature-256`。
- 密钥（LLM key、Meta token 和 app secret、SMTP 密码、Resend key、代理密码）存在 SQLite 里，接口不回传明文、不写日志。所以要保护好 `./data` 和它的备份。
- 网址抓取有 SSRF 防护（每一跳重定向都重新解析、拒绝内网地址）。

## 代理中继（F13）

WAHA 的 GOWS 引擎只会走 HTTP 代理：它把代理地址固定拼成 `http://host:port`（WAHA 源码 `src/core/engines/gows/session.gows.core.ts` 的 `getProxyUrl`）。为了让四种协议都能用，inkdove 做协议转换：

- 上游是 **http**：直接交给 WAHA，`config.proxy = {server: "host:port", username, password}`（账号密码先 URL 编码）。
- 上游是 **https / socks4 / socks5**：inkdove 为这个号起一个**本地 HTTP CONNECT 中继**，WAHA 的代理指向 `inkdove:<端口>`，账号密码是这个号专属的随机凭证（存在库里，不出现在接口里）。中继收到 CONNECT 后：
  - https：先用 TLS 连上代理本身，再发 CONNECT；
  - socks4 / socks5：用 [`socks`](https://www.npmjs.com/package/socks) 包建立连接。
- 中继只放行 CONNECT（其他方法 405），必须带正确的 `Proxy-Authorization`（否则 407），上游连不上返回 502。
- 端口从 `INKDOVE_PROXY_RELAY_PORT_BASE`（默认 18000）开始，每个扫码号建号时分一个。容器里绑 `0.0.0.0`，但 compose 不映射这些端口，只有同一内网的 WAHA 能连到。
- 号的代理一改，中继就重启，同时 `PUT /api/sessions/{name}` 更新 WAHA session（运行中的 session 会被 WAHA 自动重启，不用重新扫码）。inkdove 重启时按库里的配置重新拉起所有中继。删除号时关掉它的中继。
- "测试代理"仍然从 inkdove 直连上游代理去测，不经过中继。

## 知识库闭环、语音图片、发文件（F2、F4、F15）

### F2 知识库闭环

- **转人工的草稿**：引擎判 handoff 或 blocked 时，再用回复模型起草一条回复，存为会话的 `draft: {text, fileIds, createdAt}`，**不自动发送**。先起草再通知，通知里附草稿正文和"草稿附带的文件：…"。草稿 prompt 依据知识库和可发送文件，用客户的语言，带和回复一样的说话方式规则，需要人拍板的地方写【待你确认：…】。草稿不过 4.3、4.4 的把关；通过 `/d` 发出时算人工发送，文字和文件都发。人工发消息或文件、恢复机器人、生成新草稿时清空草稿。
- **人工回复存进知识库**：`POST /api/wa/conversations/:id/messages/:messageId/kb-draft`（只有 admin）把一条人工回复连同它前面最多 3 条连续的客户消息，改写成 `{type, title, content, tags, sourceRefs}`，不落库。前端确认后用 `POST /api/kb/entries`、`origin: "conversation"` 保存。
- **答不了的问题进缺口清单**：模型输出新增 `handoff_type` 和 `question_zh`。`handoff_type` 为 `insufficient_info` 时，把 `question_zh` 写进缺口清单（`origin: "conversation"`，带 `conversationId`）。和现有 open 缺口按汉字二元组算 Jaccard 相似度，≥0.6 的只把 `count` 加 1。`GET /api/kb/gaps` 按 count 倒序。

### 待处理原因

会话列表和单个会话的返回新增 `pendingReason: string | null`。needsHuman 为真时，值是让会话进入待处理的那条客户消息的 decisionReason；needsHuman 为假时是 null。置 needsHuman 时把原因一起写进 `conversations.pending_reason`，清 needsHuman（恢复机器人）时清空，读的时候不扫消息表。

### F4 语音和图片识别

- 设置是 `media: {voice, image, mediaModel, transcribeModel}`，默认全关。各接口格式的做法：
  - openai：图片走 chat completions 的 `image_url`（data URL）；语音走 `POST {baseUrl}/audio/transcriptions`，要填 transcribeModel；
  - anthropic：只支持图片，用 base64 image block；
  - gemini：图片和语音都用 `inlineData`。
- 功能打开、号开着自动回复、会话没暂停时，处理流程是：
  1. 先存一条占位消息；
  2. 下载媒体：WAHA 带 `X-Api-Key` 从 WAHA 取，Meta 先 `GET /{media-id}` 拿地址，再带 token 下载；
  3. 检查大小、格式和时长；
  4. 转成 `[语音] <转写>` 或 `[图片] <描述>`，有 caption 就接在描述后面另起一行。

  转出的文字当作客户发来的文字，走防抖合并和四层把关。识别期间客户又发来的文字，会等识别完一起处理。
- 限制：图片 ≤5MB，只收 jpeg、png、webp；语音 ≤10MB，且 ≤3 分钟。处理规则：
  - 超出限制的转人工，code 是 `media_unsupported`；
  - 识别出错的转人工，code 是 `media_failed`；
  - 两种都标 needsHuman 并通知，不暂停会话。
- 每次识别算 1 次 LLM 调用，计入每会话每天 60 次的上限。
- Message 新增 `media: {type: "voice"|"image", mime} | null`。

### F15 产品资料库和发文件

- **接口**：
  - `GET /api/files?q=&status=`；
  - `POST /api/files`：multipart，字段 `files`，另带 `addToKb`，默认 true；
  - `GET /api/files/:id`、`PUT /api/files/:id`、`DELETE /api/files/:id`；
  - `GET /api/files/:id/download`；
  - `POST /api/files/:id/describe`；
  - `POST /api/wa/conversations/:id/send-file {fileId, caption?}`。

  上传、修改、删除和重新生成描述只有 admin 能用，agent 只能浏览和下载。
- **存储和描述**：
  - 文件存在 `DATA_DIR/files/<id>`。上传时先落 `files/tmp`，校验通过后再改名；
  - 勾了 addToKb 的文件同时建一个知识库资料；
  - 描述在后台排队生成，一次一个，服务重启后接着生成还没做完的。
- **机器人发文件**：
  - 回复 prompt 的【可发送文件】列出 active 文件，最多 50 个。超过 50 个时按和客户消息的 BM25 相关度取，相关度为 0 的按发送次数补满；
  - 模型输出 `send_file_ids`，最多 3 个；
  - 程序硬规则有三条：
    - `bad_file`：文件不存在、已停用或超过 3 个，判 blocked；
    - `no_citation`：业务回复既没引用条目也没发文件，转人工；
    - `file_limit`：同一会话每天自动发超过 5 个，改判 handoff；
  - 审核调用的输入里带上要发的文件的名称和描述。
- **发送顺序**：先按 F1/F14 的节奏发文字，停 1–2 秒，再逐个发文件，不带 caption。
  - WAHA：jpeg、png 走 sendImage，其他走 sendFile。15MB 以内传 base64，超过时传签名地址 `http://<INKDOVE_PROXY_RELAY_HOST>:<INKDOVE_PORT>/internal/files/<id>?token=<过期时间>.<HMAC>`。签名地址 10 分钟有效，HMAC-SHA256 的密钥是 `INKDOVE_SESSION_SECRET`，只放行这一个文件，token 不写日志。
  - Meta：先 `POST /{phone-number-id}/media` 上传，再发 document 消息（带 filename）或 image 消息。media id 按（文件、号）缓存 25 天；用缓存的 id 发送失败时，重新上传一次再发。
- **记录**：
  - 每个发出的文件另存一条消息：`attachment: {fileId, filename, mime, size}`，text 为空（人工发时是 caption）；
  - 发送成功后 `sendCount` 加 1，更新 `lastSentAt`；
  - 处理记录里带 `sentFileIds`。
- **模型的 `handoff_type` 和处理记录 code（F12）的对应**：六个取值原样作为 code，其他值或空值记 `other`。

  | handoff_type | code |
  |---|---|
  | `insufficient_info` | `insufficient_info` |
  | `price` | `price` |
  | `purchase` | `purchase` |
  | `identity` | `identity` |
  | `human_request` | `human_request` |
  | `other`、空、其他值 | `other` |

  F4 用的 `media_unsupported`、`media_failed` 本来就在 F12 的枚举里。F15 新增了两个 code：blocked 的 `bad_file` 和 handoff 的 `file_limit`。

## 偏离规格

1. **Meta Graph API 默认版本是 `v26.0`**。规格示例写的是 v23.0，这里按 Meta 的版本变更日志用了核实时最新的版本，号详情里可以改。
2. **WAHA 配置只在变了时才 PUT**。inkdove 管理的那部分 session 配置（webhook 和代理）算一个指纹（`HMAC-SHA256(INKDOVE_SESSION_SECRET, 配置)`），存在 `accounts.waha_config_hash`。start 时 session 已存在且指纹没变、中继也没重启，就不 PUT，避免 WAHA 读回来的配置把密码打码后每次都判成"变了"。PUT 时只覆盖 webhooks 和 proxy，session 配置里的其他字段原样保留。中继重启时即使指纹没变（中继地址和凭证不变）也会 PUT 一次，让 WAHA 重连到新的上游。
3. **https 上游的中继没有自动化测试**。测试用自签名证书时 TLS 校验会失败；socks4、socks5 两条路径有完整测试（假上游 + 假目标服务）。中继的随机凭证明文存在 SQLite 里。
4. **只用于测试的覆盖项**：
   - 环境变量 `INKDOVE_META_GRAPH_URL`（默认 `https://graph.facebook.com`）和 `INKDOVE_RESEND_API_URL`（默认 `https://api.resend.com/emails`）；
   - 代理测试的目标地址、拟真等待时长、通知重试间隔、中继监听地址只能通过 `createApp` 的选项覆盖。
5. **LLM 参数**：
   - openai 格式不发 `max_tokens`，因为 OpenAI 的新模型只认 `max_completion_tokens`，而很多兼容接口只认 `max_tokens`；
   - anthropic 格式的 `max_tokens` 是：回复 2048、审核 512、蒸馏 8192；
   - gemini 格式的 `maxOutputTokens` 至少 8192，因为 Gemini 2.5 起思考 token 也算在里面；
   - 三种格式都只靠宽容解析拿 JSON，只有 gemini 加了 `responseMimeType: "application/json"`；
   - anthropic 和 gemini 的 thinking/thought 块都会跳过。
6. **规格没定的错误码**：
   - 400 `invalid_input`（参数校验失败）、`channel_immutable`、`wrong_channel`（Meta 号调扫码或代理接口）、`proxy_disabled`、`account_deleted`（从已删除号的会话发消息）；
   - 404 `not_found`；409 `gap_closed`（缺口已经不是 open）、`not_scan_qr`；
   - 502 `waha_error`（WAHA 返回错误）、`relay_failed`（中继起不来，比如端口被占用）；
   - 401 `bad_signature`（webhook 签名不对）；403 `meta_not_configured`（这个号没配 app secret 时收到 Meta webhook）；403 `forbidden`（Meta 校验 token 不对，或没有权限）。
   - agent 访问别人的号时，先判权限再判存在：不存在的号也返回 403，探不出别人的号是否存在。
7. **价格数字核对的口径**（4.4），都在规范化之后比较：全角转半角、去掉千分位逗号和空格。
   - 金额：数值要等于引用条目里出现过的某个数字。条目里的价格表常常不带单位，所以不要求单位一致。
   - 百分比和"X 折"：条目里要有同样数值的百分比或"X 折"。
   - 中文数字写的金额（比如"五十九元"）和"百分之几"：按原样比对。
   - 词表放在 `server/src/reply/redlines.js`。F13 之后成交词表是短语级的，单独的 `deal`、`we can offer you`、`成交` 不再拦；"给你留 / 帮您留 X 件"用正则拦，排除"留意""留言""留心""留神"。
8. **离题静默解除后**，24 小时窗口内的离题记录还在，所以解除后再离题一次会马上再次静默。
9. **"每天 60 次 LLM 调用"按服务器本地日期计**，过了零点重新计数。生成、套话重写、审核都算。今天剩下的次数不到 3 次时不做套话重写，直接删掉套话句。
10. **每会话每小时回复上限，超了改为转人工**（`code: rate_limit`，标 needsHuman、暂停并通知），第一期是记 skipped。这样和 F12 的 code 枚举一致，也不会让客户一直没人理。拆成几条发的回复按一次计。
11. **只在拟真发送开着时才拆条**。关掉 `reply.humanize` 时长回复整条发出，不标已读、不显示正在输入。
12. **拟真发送被取消时**：第一条发出时才把客户消息记为 replied、调一次处理记录。一条都没发出就被新消息打断的，客户消息保持未处理，和新消息合在一起从防抖重新走；已经发出一条的，剩下的不发，新消息单独走流程。后台人工发送也会取消正在等待的机器人回复，未处理的客户消息记 skipped（"人工已接管"）。
13. **F3 `/resume` 的回执**是"✅ 已恢复机器人：<客户名或号码>"（规格只写了转发和 `/d` 的回执）。没开 WhatsApp 通知的号，通知号码发来的消息按黑名单处理（不存档、不回复）。用法提示的 10 分钟节流状态在内存里，重启后重新计时。
14. **引用 id 的匹配**：WAHA 文档里 sendText 返回的 id 是 `true_<chatId>_<id>`，而入站 `replyTo.id` 按 WAHA 源码是不带前缀的 `<id>`，所以按完整 id 或最后一段都能匹配。GOWS 入站消息是否填 `replyTo` 文档和源码都没找到证据，没有时退回原始消息里的 `extendedTextMessage.contextInfo.stanzaID`。**这两点要用真机验证**。Meta 用 `messages[].context.id`，普通引用回复的这个字段在官方文档里没有明文，也要真机验证。
15. **删除号**时先 logout 再 `DELETE /api/sessions/{name}`（文档说 DELETE 本身也会登出，这里按规格先登出），WAHA 出错只写日志、号照常删除。会话和消息保留，号的通知记录（引用用的）一起删掉。
16. **`/api/health` 不登录也能调**，但 `accounts` 只在登录后返回有权限看的号，未登录时是空数组，避免把号的名字暴露给外网。状态有 5 秒缓存。
17. **第一期迁移**见上文"从第一期升级"。Meta 的旧回调地址 `/webhooks/meta` 已删除，访问返回 404。
18. **通知失败最多尝试 2 次**（重试 1 次），失败只写日志。
19. **会话"连上时间"的判定**：服务在 webhook 或状态查询里看到 session 从非 WORKING 变成 WORKING 时，才记为连上时间。早于"进程启动时间和连上时间中较晚的那个"减 60 秒的消息会被忽略。
20. **网址抓取的 SSRF 防护**：每一跳重定向都会重新解析并校验 IP。DNS 解析和实际连接之间仍有极短的 rebinding 窗口；要彻底消除需要自定义 DNS lookup，这里没做。
21. **非文字消息**：F4 的识别关着、号没开自动回复、会话已暂停或模型没配置时，仍按第一期处理：不下载，只存"[图片]""[语音]"之类的标记，记 skipped，标 needsHuman 并通知。其他情况见 F4。
22. **F12 的处理记录还没落库**（C 段做）：回复引擎给出 F12 枚举的 `code`，服务里留了 `onDecision` 钩子，每轮处理调一次；`/api/kb/ask` 也返回 `code`。模型判的 handoff 按 `handoff_type` 映射成 code（见上文的表）；模型判的 offtopic 仍记 `other`，审核判的离题记 `review_offtopic`。
23. **F12 枚举外新增的 code**：blocked 的 `bad_file` 和 handoff 的 `file_limit`（F15 的规格里定了，但 F12 的表里没列）。看板的 code 枚举和中文标签要把这两个加上。
24. **草稿只在回复引擎判 handoff 或 blocked 时生成**。以下几种情况不生成，照常通知：
    - 每小时回复超限（`rate_limit`）：本来就是在限流；
    - 语音图片识别失败或超限：模型看不到内容；
    - 当天剩余次数不够 1 次。

    生成草稿期间人工已经回了，或者机器人已经恢复，这份草稿就丢掉。A 段存下的旧格式 `{text, createdAt}` 草稿，读出来时补上 `fileIds: []`。
25. **缺口清单**：
    - 只有真实会话会写入缺口清单，后台测试对话（`/api/kb/ask`）不写，免得测试问题混进清单；
    - `question_zh` 为空时，用客户原话（截前 200 字）；
    - 重新整理知识库时只清掉 `origin=distill` 的 open 缺口，从会话来的保留；
    - 每次被问到都在 `gap_hits` 表里记一行（缺口、会话、时间），留给看板用。
26. **kb-draft 只给 admin 用**，agent 调用返回 403，因为保存条目本身只有 admin 能做。提问取这条人工回复之前最多 3 条连续的客户消息。错误码：
    - 404：消息或会话不存在；
    - 400：`not_operator_message`、`empty_message`、`llm_not_configured`；
    - 502：`llm_error`。
27. **语音图片识别失败或超限时不暂停会话**：消息记 handoff，带 `media_failed` 或 `media_unsupported`，标 needsHuman 并通知，但不暂停。这和原来的非文字消息一致，客户接着发文字时，机器人照常回复。
28. **语音时长只在拿得到时检查**：
    - WAHA payload 里有时长就用它：GOWS 是 `_data.Message.audioMessage.seconds`，WEBJS 是 `_data.duration`；
    - 没有时，从 Ogg 文件最后一页的 granule 算；
    - mp3、m4a 等其他格式只查大小，不查时长；
    - Meta 的 webhook 不给时长，下载后按 Ogg 算。
29. **模型的选择和计数**：
    - 识别语音和图片、给图片文件写描述，都用 `mediaModel`，为空时用回复模型；给文档写描述用蒸馏模型；
    - 识别计入会话的每日次数；文件描述不属于任何会话，不计入；
    - 当天次数用完时，语音和图片按 `media_failed` 转人工。
30. **产品资料库的上传**：
    - 描述状态：图片不建知识库资料（没有可整理的文字）；文档抽不出文字时，`descriptionStatus` 直接记 failed；模型没配置时上传的文件记 manual；
    - 数量和格式：一次最多传 20 个，有一个格式不支持就整批拒绝（400 `unsupported_file_type`）；单个超过 50MB 返回 413 `file_too_large`；没有扩展名时按 mime 判断格式；
    - 依赖：知识库资料（sources）也顺带支持了 .xls 和 .pptx。解析 pptx 用的 jszip 原本是间接依赖，现在写进了运行依赖，没有新增依赖。
31. **发文件的细节**：
    - 格式限制：
      - WAHA：webp 走 sendFile，因为 WhatsApp 的图片消息只收 jpeg 和 png；
      - Meta：不收 webp 图片（webp 只能当贴纸），也不收超过 5MB 的图片，这两种直接发送失败并写明原因；
      - csv 按 `text/plain` 上传给 Meta，因为 Meta 的文档类型里没有 `text/csv`。
    - 节奏：关掉拟真发送时，文字和文件之间仍然停 1–2 秒。发文件的过程中来了新消息或人工接管，剩下的文件不再发。
    - 判定：smalltalk 带文件时按业务回复处理，要过同样的文件校验和审核。超过每天 5 个时**整轮**改判 handoff，文字也不发，不只发前几个。
    - 计数：`sendCount` 和 `lastSentAt` 统计所有成功发出的，包括机器人、后台人工和 `/d`。
    - 错误码：人工发送停用的文件返回 400 `file_disabled`；签名地址不对返回 403 `bad_token`；重新生成描述时，图片没开识别返回 400 `image_disabled`，模型没配置返回 400 `llm_not_configured`。
32. **产品资料库不分号**：agent 能浏览和下载全部文件，只能把文件发到自己有权限的会话。
33. **WAHA 内联 base64 的上限 15MB** 是常量，测试通过 `createApp` 的选项 `wahaInlineMaxBytes` 改小。签名地址的主机名用 `INKDOVE_PROXY_RELAY_HOST`，默认 `inkdove`。

## 已核实的外部接口

- **WAHA**：
  - session 的创建、更新、启动、停止、登出和删除，见 [sessions](https://waha.devlike.pro/docs/how-to/sessions/)；
  - webhook 的 events 和 HMAC（`X-Webhook-Hmac`，sha512，对原始 body 计算），见 [events](https://waha.devlike.pro/docs/how-to/events/)；
  - sendText、标已读 `POST /api/sendSeen {session, chatId, messageIds}`（GOWS 支持 messageIds），见 [send-messages](https://waha.devlike.pro/docs/how-to/send-messages/)；
  - 正在输入 `POST /api/{session}/presence {chatId, presence: "typing" | "paused"}`，WAHA 不会自动发，见 [presence](https://waha.devlike.pro/docs/how-to/presence/)；
  - 入站消息的 `replyTo`（`id` 不带前缀），见 [message.dto.ts](https://raw.githubusercontent.com/devlikeapro/waha/core/src/structures/message.dto.ts)；
  - `X-Api-Key`，见 [security](https://waha.devlike.pro/docs/how-to/security/)；
  - GOWS 镜像，见 [engines](https://waha.devlike.pro/docs/how-to/engines/)；
  - 会话存储，见 [storages](https://waha.devlike.pro/docs/how-to/storages/)；
  - lid 转手机号，见 [contacts](https://waha.devlike.pro/docs/how-to/contacts/)；
  - 代理，见 [proxy](https://waha.devlike.pro/docs/how-to/proxy/)；
  - 发文件和图片：`POST /api/sendFile`、`POST /api/sendImage`，体是 `{session, chatId, file: {mimetype, filename, data} | {mimetype, filename, url}, caption?}`。data 是不带 `data:` 前缀的 base64，返回体顶层有 `id`。见 [send-messages](https://waha.devlike.pro/docs/how-to/send-messages/) 和 [files.dto.ts](https://github.com/devlikeapro/waha/blob/core/src/structures/files.dto.ts)；
  - GOWS 支持 sendImage 和 sendFile，见 [engines](https://waha.devlike.pro/docs/how-to/engines/) 和 [session.gows.core.ts](https://raw.githubusercontent.com/devlikeapro/waha/core/src/core/engines/gows/session.gows.core.ts)。按 [changelog](https://waha.devlike.pro/docs/overview/changelog/) 和 [waha-plus](https://waha.devlike.pro/docs/how-to/waha-plus/)，从 2026.6.1 起原来 Plus 的功能并入了 Core；
  - 收媒体：入站消息带 `hasMedia` 和 `media: {url, mimetype, filename, error}`。url 指向 WAHA 的 `/api/files/...`，主机名按 `WAHA_BASE_URL` 拼，下载要带 `X-Api-Key`。`WAHA_EVENTS_DOWNLOAD_MEDIA` 默认是 true，文件默认保留 180 秒（`WHATSAPP_FILES_LIFETIME`）。见 [receive-messages](https://waha.devlike.pro/docs/how-to/receive-messages/) 和 [config](https://waha.devlike.pro/docs/how-to/config/)。
- **Meta**：
  - webhook 校验和签名，见 [getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)；
  - 消息结构和 `context`，见 [payload examples](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples)、[text messages webhook](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/text)；
  - 发文本消息，见 [text messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages)；
  - 标已读 `{messaging_product, status: "read", message_id}`，见 [mark as read](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read)；
  - 正在输入：在标已读的请求里加 `typing_indicator: {type: "text"}`，回复后或 25 秒后消失，没有停止接口，见 [typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)；
  - 版本，见 [versions](https://developers.facebook.com/docs/graph-api/changelog/versions)；
  - 上传媒体：`POST /{ver}/{phone-number-id}/media`，multipart 带 `messaging_product=whatsapp`、`type`、`file`，返回 `{id}`，上传的媒体 30 天有效。下载媒体：`GET /{ver}/{media-id}` 返回 `{url, mime_type, file_size}`，再带同一个 Bearer token GET 这个 url，url 5 分钟有效。大小限制：jpeg 和 png 图片 5MB；txt、xls、xlsx、doc、docx、ppt、pptx、pdf 这些文档 100MB；webp 只能当贴纸。见 [media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)；
  - 发文档 `{type: "document", document: {id, filename}}`、发图片 `{type: "image", image: {id}}`，见 [document messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/document-messages)、[image messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/image-messages)；
  - 入站图片和语音的 webhook 结构，见 [image](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/image)、[audio](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/audio)。
- **Resend**：
  - `POST https://api.resend.com/emails`，`Authorization: Bearer <key>`，体 `{from, to[], subject, text, html?}`，返回 `{id}`，见 [send email](https://resend.com/docs/api-reference/emails/send-email)；
  - 错误（422 参数错误、403 域名未验证）和限流（429，带 `retry-after`，这里重试 1 次），见 [errors](https://resend.com/docs/api-reference/errors)、[rate limit](https://resend.com/docs/api-reference/rate-limit)。
- **SMTP**：nodemailer，`secure=true` 走 SMTPS（通常 465），否则强制 STARTTLS（通常 587），见 [nodemailer SMTP](https://nodemailer.com/smtp/)。
- **LLM**：
  - Anthropic，见 [Messages](https://platform.claude.com/docs/en/api/messages)、[versioning](https://platform.claude.com/docs/en/api/versioning)、[errors](https://platform.claude.com/docs/en/api/errors)；
  - Gemini，见 [generateContent](https://ai.google.dev/api/generate-content)、[thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[API versions](https://ai.google.dev/gemini-api/docs/api-versions)；
  - OpenAI，见 [chat completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)；
  - 识图和语音：
    - OpenAI：图片用 `image_url` 传 data URL，见 [images-vision](https://developers.openai.com/api/docs/guides/images-vision)。语音用 `POST /audio/transcriptions`，multipart 带 `file` 和 `model`，返回 `{text}`，上限 25MB，见 [speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text) 和 [transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。ogg 的支持两份官方文档说法不一致：指南页没列 ogg，[Python reference](https://developers.openai.com/api/reference/python/resources/audio/subresources/transcriptions/methods/create) 列了。WhatsApp 的 ogg/opus 语音要用真样本试一次；
    - Anthropic：图片用 `{type: "image", source: {type: "base64", media_type, data}}`，每张不超过 10MB，不支持音频，见 [vision](https://platform.claude.com/docs/en/build-with-claude/vision)；
    - Gemini：图片和音频都放进 parts 的 `inlineData: {mimeType, data}`，整个请求 20MB 以内，见 [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)、[audio](https://ai.google.dev/gemini-api/docs/audio)。

## 许可证

[MIT](LICENSE) © 2026 Inkdove contributors
