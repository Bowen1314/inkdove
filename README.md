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
  - 会话里能看到每条客户消息的处理结果和原因（已回复 / 转人工 · 客户要求打折 / 离题……）；
  - 扫码号关联成功后，自动把手机里已有的聊天导进「会话」，可以当联系人名单用。导入的消息只用来看，机器人不回复、不通知、不算待处理。**WhatsApp 只给新关联的设备每个聊天最后 1 条消息**，所以每个聊天通常只导进 1 条，更早的记录看不到。
- **转人工**：机器人拿不准、客户要人工、要折扣、想下单、问是不是机器人时，不回复客户，暂停这个会话并通知你：
  - 通知渠道：WhatsApp（由这个号发给你指定的号码）和邮件（SMTP 或 Resend API，全局配置一次）；
  - 转人工时先替你起草一条回复（可能带建议发送的文件），附在通知里，**不会自动发给客户**；
  - 在 WhatsApp 里**引用通知直接回复**，内容就会转发给客户；`/d` 发送草稿（文字和文件），`/resume` 恢复机器人。
  - 会话页输入框旁的「翻译」按钮把你写的话直译成这位客户的语言（按客户最近的文字消息判断），译文替换输入框内容、不自动发送；草稿里建议的文件可以一键按顺序发出。
- **客户线索**：后台每 2 分钟看一遍会话，机器人或人工处理过、客户停下来 10 分钟以上的会话，由 LLM 读最近 50 条消息整理成一条客户线索（名字、公司、国家、邮箱、意向产品、数量、阶段、摘要），客户又说话后自动更新。人工改过的字段不会被重新提取覆盖；可以立即重新提取、按阶段和号筛选搜索、导出成 Excel 能直接打开的 CSV。设置里可以关掉自动提取。
- **多人账号**：管理员邀请业务员（邮件链接），给每人分配能看的号。业务员只看得到、只操作得了分给自己的号和会话；后台人工发的每条消息都记下是谁发的。
- **IP 代理**：每个号可以单独走 http、https、socks4、socks5 代理。
- **号码配置导出 / 导入**（管理员）：「号码」页右上角的更多菜单里，可以把所有号的配置（名称、接入方式、人设、自动回复、回复范围和名单、通知、代理、Meta 凭证）导出成一个 JSON 文件，再导入到别的部署或同一个部署里，用来迁移或备份。**文件里有 Meta token、app secret、代理密码等密钥的明文**，请当密码一样保管，用完删掉。导入时会新建号（新 id），扫码号要重新扫码或用配对码连接；Meta 号的回调地址会变，要到 Meta 开发者后台改成新地址；phoneNumberId 和已有号重复的 Meta 号会跳过。会话、消息和成员分配不在文件里。

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
   - 扫码号：点"启动"，用手机 WhatsApp 的"已关联的设备"扫二维码。不方便扫码时（比如只有这一部手机），把「关联方式」切到"手机号配对码"，填这个号的手机号（带国家码）获取 8 位配对码，在手机上"关联新设备 → 改用手机号码关联"里输入，配对码约 2 分钟内有效；
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

## 客户线索（F6）

- **表**：`leads` 每个会话一条（`conversation_id` 唯一），字段按规格的 Lead；`manual_fields` 是人工改过的字段名。`lead_stage_history(lead_id, stage, ts)`：stage 每变一次写一行，首次提取也写，人工改 stage 也写，没变不写。号名、联系人名字和号码、`lastContactAt` 读的时候从会话和号表取，不存。
- **提取水位**：`conversations.lead_seq` 记上次提取时会话里最新一条消息的 seq，"上次提取之后有新的客户消息"就是有 seq 更大的客户消息。水位放在会话上而不是线索上，见偏离规格第 43 条。
- **后台扫描**（`server/src/leads/store.js`，`createApp` 里启动，进程关闭时停）：每 2 分钟一次，`leads.enabled=false` 或模型没配置时什么也不做。三个条件同时满足才提取：
  1. 水位之后有新的客户消息，**导入的历史消息（`via: "import"`）不算**；
  2. 会话里最新一条消息（任何一方，按时间）已经过去 10 分钟；
  3. 至少一条客户消息的 botDecision 是 replied、handoff、blocked，或者有人工消息：后台发的和 WhatsApp 转发的 operator 消息，以及**实时**收到的手机回复（owner、`via: "phone"`）。导入的手机回复不算。全是离题、skipped 的不提取。
- **怎么提取**：读最近 50 条消息（按时间，带作者），客户的话和 WhatsApp 昵称包在 `<customer_message>` 里、尖括号转全角，当不可信数据；我方的话标成"客服（机器人/人工/手机）"。用回复模型，输出规格的 JSON。每个字段取字符串（数字转成字符串）、去首尾空白、截断（名字 100、公司 200、国家 100、邮箱 200、意向产品 500、数量 200、摘要 2000 字），没有的留空字符串；stage 不在六个取值里的按 `other`。`manualFields` 里的字段不覆盖。
- **模型次数**：提取调用 `ctx.ai.extractLead`，在 `records.js` 的 `AI_METHOD_PURPOSE` 登记为 `leads`，自动写 `llm_calls`（带号和会话）。计入每会话每日模型上限（60 次）：调用前先记上；已到上限的后台跳过、下次扫描再试，手动重新提取返回 429。
- **mock 规则**（`INKDOVE_LLM_MOCK=1`，只看客户的话）：含"下单""order""PI"→ order_intent；否则含"价格""价钱""price""discount"→ negotiation；否则含"样品""sample"→ sample；其余 inquiry。名字取"我叫 X""my name is X"，公司取"公司是 X""公司：X""company: X""company is X"，邮箱取第一个，数量取"数字 + 个/件/台/套/箱/pcs/pieces/units/sets"，国家和意向产品留空，摘要是"mock 提取：客户说了 N 句，最近一句是「…」"。
- **接口**（都要登录；agent 只能看、改、重新提取、导出分配给自己的号的线索，越权 403 `forbidden`，列表和导出自动过滤，`accountId` 指定别人的号也 403）：
  - `GET /api/leads?q=&stage=&accountId=` → `Lead[]`（直接是数组），按 `lastContactAt` 倒序。`q` 不区分大小写，匹配名字、公司、国家、邮箱、意向产品、WhatsApp 昵称和号码；`q` 是号码时可以带 `+`、空格、`-`、括号。`stage` 不是六个取值之一返回 400；
  - `GET /api/leads/:id`，不存在 404；
  - `PUT /api/leads/:id`：只认 `name company country email interest quantity stage summary`，别的字段忽略；值必须是字符串，stage 必须在枚举里，邮箱非空时要像邮箱，超长 400；一个能认的字段都没有也 400。传了的字段都并进 `manualFields`，返回完整的 Lead；
  - `DELETE /api/leads/:id`：只有 admin（agent 一律 403），同时删掉它的阶段历史，返回 `{ok: true}`；
  - `POST /api/leads/:id/refresh`：同步提取并返回最新的 Lead，不看三个触发条件。模型没配置（不是 mock）400 `llm_not_configured`；超每日上限 429 `llm_daily_limit`；模型出错或输出解析不了 502 `llm_error`；
  - `GET /api/leads/export.csv?q=&stage=&accountId=`：筛选和权限同列表。UTF-8 带 BOM，CRLF 换行，附件名 `inkdove-leads-YYYYMMDD.csv`（服务器本地日期），`cache-control: no-store`。表头：名字、公司、国家、邮箱、WhatsApp 号码、WhatsApp 昵称、所属号、意向产品、数量、阶段、摘要、最近联系、提取时间、更新时间；阶段导出中文（`server/src/codes.js` 的 `LEAD_STAGES`，看板以后也用它），时间是服务器本地时间 `YYYY-MM-DD HH:mm`（容器可用 TZ 环境变量调整）。含逗号、双引号、换行的单元格按 RFC 4180 加引号转义；以 `=` `+` `-` `@`（以及制表符、回车）开头的单元格前面加单引号，防公式注入。

## 偏离规格

1. **Meta Graph API 默认版本是 `v26.0`**。规格示例写的是 v23.0，这里按 Meta 的版本变更日志用了核实时最新的版本，号详情里可以改。
2. **WAHA 配置只在变了时才 PUT**。inkdove 管理的那部分 session 配置（webhook 和代理）算一个指纹（`HMAC-SHA256(INKDOVE_SESSION_SECRET, 配置)`），存在 `accounts.waha_config_hash`。start 时 session 已存在且指纹没变、中继也没重启，就不 PUT，避免 WAHA 读回来的配置把密码打码后每次都判成"变了"。PUT 时只覆盖 webhooks 和 proxy，session 配置里的其他字段原样保留。中继重启时即使指纹没变（中继地址和凭证不变）也会 PUT 一次，让 WAHA 重连到新的上游。
3. **https 上游的中继没有自动化测试**。测试用自签名证书时 TLS 校验会失败；socks4、socks5 两条路径有完整测试（假上游 + 假目标服务）。中继的随机凭证明文存在 SQLite 里。
4. **只用于测试的覆盖项**：
   - 环境变量 `INKDOVE_META_GRAPH_URL`（默认 `https://graph.facebook.com`）和 `INKDOVE_RESEND_API_URL`（默认 `https://api.resend.com/emails`）；
   - 代理测试的目标地址、拟真等待时长、通知重试间隔、中继监听地址、配对码等会话就绪的时长和轮询间隔（`wahaPairWaitMs`、`wahaPollMs`）、进入 WORKING 后等多久再导入已有聊天（`historyImportDelayMs`）、客户线索的扫描间隔（`leadsScanIntervalMs`，0 表示不启动定时扫描，测试里手动调 `ctx.leads.scan()`）只能通过 `createApp` 的选项覆盖。
5. **LLM 参数**：
   - openai 格式不发 `max_tokens`，因为 OpenAI 的新模型只认 `max_completion_tokens`，而很多兼容接口只认 `max_tokens`；
   - anthropic 格式的 `max_tokens` 是：回复 2048、审核 512、蒸馏 8192、客户线索提取 1024；
   - gemini 格式的 `maxOutputTokens` 至少 8192，因为 Gemini 2.5 起思考 token 也算在里面；
   - 三种格式都只靠宽容解析拿 JSON，只有 gemini 加了 `responseMimeType: "application/json"`；
   - anthropic 和 gemini 的 thinking/thought 块都会跳过。
6. **规格没定的错误码**：
   - 400 `invalid_input`（参数校验失败）、`channel_immutable`、`wrong_channel`（Meta 号调扫码或代理接口）、`proxy_disabled`、`account_deleted`（从已删除号的会话发消息）；
   - 404 `not_found`；409 `gap_closed`（缺口已经不是 open）、`not_scan_qr`；429 `llm_daily_limit`（F6 手动重新提取线索时这个会话当天的模型次数已用完）；
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
22. **F12 的处理记录**：每轮处理（合并的几条消息算一轮）在 `decisions` 表写一行，skipped 不写；`onDecision` 钩子保留，同一行再传一份。后台测试对话（`/api/kb/ask`）不写处理记录（和第 25 条的缺口清单一样，免得测试混进统计），但它调的模型照样记进 `llm_calls`（号和会话为空）。模型判的 handoff 按 `handoff_type` 映射成 code（见上文的表）；模型判的 offtopic 按新增的输出字段 `offtopic_type`（`task`、`chitchat`、`injection`、`other`）原样作为 code，没给或不认识的记 `other`；审核判的离题记 `review_offtopic`。
23. **F12 枚举外新增的 code**：blocked 的 `bad_file` 和 handoff 的 `file_limit`（F15 的规格里定了，但 F12 的表里没列），以及 F11 的 `declined`（decision 和 code 都是 `declined`）。所有 code、模型调用用途、首次回复方式的中文标签放在 `server/src/codes.js`，看板和通知共用；通知里原来的原因文案（`NOTIFY_REASONS`）也挪到了这里，文案没变。
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
34. **手机号配对码（规格外新增）**：扫码号除了扫码，还能用手机号获取配对码关联（WhatsApp 的"改用手机号码关联"）。号详情「连接」里的「关联方式」切换，默认扫码，两种方式共用同一轮等待关联和状态轮询。
    - 接口：`POST /api/accounts/:id/waha/request-code` `{phoneNumber}` → `{code}`，权限同 `/waha/start`。服务端先确保 session 已启动（同 start），等它进入 SCAN_QR_CODE（最多 15 秒），再向 WAHA 申请；
    - 号码：去掉空格、横线、括号，开头可以是 `+` 或 `00`，剩下必须是 8–15 位、不以 0 开头的数字（国家码没有 0 开头的，这样能挡住忘了填国家码的本地号码），否则 400 `bad_phone`；
    - 同一个号 20 秒内只能申请一次，否则 429 `too_frequent`，防止连点让 WhatsApp 风控这个号。只有已经发给 WAHA 的申请才计数（不论成败），号码不对、会话没就绪这类没发出去的不算。计时在内存里，重启后清零；
    - 错误码：已连接的号 409 `already_connected`（不会登出）；WAHA 的 422（会话不在 SCAN_QR_CODE）转成 409 `not_scan_qr`；等满 15 秒会话还没进入等待关联，或 WAHA 返回其他错误，502 `waha_error`；
    - **FAILED 的会话先普通重启，还是 FAILED 才登出重来**，申请配对码和「开始扫码连接」都这样。先 stop 再 start（不登出），等结果：回到 WORKING 就算恢复了（网络抖动造成的 FAILED 多半这样，不用重新扫码；申请配对码时这种情况返回 409 `already_connected`）；进入 SCAN_QR_CODE 就照常出码或申请配对码；又落回 FAILED，才 logout 再 start。这是为了对付申请过配对码却没输入时留下的半截登录凭证，这种会话普通重启永远回不到 SCAN_QR_CODE（见下文「已核实的外部接口」）。只有走到登出这一步，这个号才要重新扫码或输码。普通重启用 stop + start 而不是只 start，因为 start 对没停的会话什么都不做，FAILED 算不算"没停"还没实测；WORKING 的号一律不动；
    - 日志里的手机号只留后 4 位。
35. **号码配置导出 / 导入（规格外新增，只有 admin，agent 403）**：
    - 导出：`GET /api/accounts/export`，附件 `inkdove-accounts-YYYYMMDD.json`（按导出时间的 UTC 日期），`cache-control: no-store`。内容是 `{format: "inkdove-accounts", version: 1, exportedAt, accounts: [...]}`，每个号是 `{name, channel, autoReply, persona, scope, allowlist, blocklist, waha: {proxy: {enabled, protocol, host, port, username, password}} | null, meta: {phoneNumberId, apiVersion, verifyToken, accessToken, appSecret} | null, notify}`，结构和号详情接口一致，只是**密钥是明文**，不是 `passwordSet` 这类标记。不导出 id、WAHA session 名、状态、时间、会话和消息、成员分配。日志只记谁导出了几个号，不记内容；
    - 导入：`POST /api/accounts/import`，multipart，字段 `file`（和其他上传接口一样），最大 2MB，可以带 UTF-8 BOM。返回 `{created: [{id, name, notices?}], skipped: [{name, reason}]}`，`notices` 是字符串数组，只有这个号导入时被自动调整过才有；
    - 校验：先整份校验再建号，有一个号不合法就整体 400，一个都不建。不是 JSON、`format` 不对、`accounts` 不是数组返回 `bad_format`，`version` 不是 1 返回 `unsupported_version`。每个号的校验和新建、更新共用，错误信息形如「第 2 个号（销售一号）：proxy.port 必须是 1–65535 的整数或 null」，错误码沿用原来的；缺的字段按新建号的默认值；
    - 开了邮件通知的号，在还没配置发信方式的部署里导入时不会让整批失败：这个号的邮件通知自动关掉（收件人 `to` 保留），`created` 里对应那一项带 `notices: ["没配发信方式，已关掉邮件通知"]`，导入后在设置里配好发信方式再把它打开就行（新建、更新号时仍然严格 400 `email_not_configured`）；其余校验错误照旧整体 400；
    - 新建：在一个事务里逐个建，新 id、新 session 名，WAHA session 不自动建也不启动。名称可以重复。Meta 号的 phoneNumberId 和已有的号、或文件里前面的号重复时跳过并写明原因，空的不算重复。
36. **关联后导入已有聊天（规格外新增，只有扫码号）**：关联时手机同步过来的旧聊天，WAHA 存着但不推 webhook（历史消息不触发 `message` 事件），所以刚关联的号「会话」是空的。现在号进入已连接后，服务自己去 WAHA 拉一次：
    - 触发：服务看到号从非 WORKING 变成 WORKING 时（webhook 的 `session.status` 或状态查询），包括服务启动后第一次看到它是 WORKING。服务启动时会顺手查一次所有扫码号的状态（不等结果），所以已经连着的号重启服务就会导入，不用重新关联。看到 WORKING 后等 10 秒再拉，给手机同步历史留时间（同步要多久没在真机上核实）。在后台跑，不耽误 webhook 响应；同一个号同时只跑一次，正在等或正在跑时再次连上不会叠着再跑。Meta 号没有历史接口，不导入；
    - 范围：先拉聊天列表（最多 100 个，WAHA 返回的顺序没核实，聊天更多时不保证是最近的 100 个），每个聊天最多取 20 条（WhatsApp 现在只给 1 条，留余量），不下载媒体。哪些聊天收和 webhook 入站完全一样：群、广播（含 `status@broadcast`）、频道不收，通知号码不收，号的黑白名单照常判断（lid 先换算成手机号）。聊天对象取 chat id（历史消息的 `to` 是 null），`@s.whatsapp.net` 记成 `@c.us`；
    - 只收早于"连上时间"减 60 秒（见第 19 条）的消息，正好是 webhook 会当旧消息忽略的那部分；更新的交给 webhook 照常处理和自动回复，两边不会抢同一条。代价是连上前 60 秒内、又没被 webhook 推过来的消息两边都不收。掉线重连、重启服务时会再导入一次，这时补进来的是断线期间漏掉的消息，同样只存不回；
    - 静默：不自动回复、不调模型、不识别语音图片、不记缺口、不发通知、不标待处理、不暂停、不占每日模型次数、不调处理记录钩子。消息标 `via: "import"`、已处理，时间用 WhatsApp 的原始时间；客户消息记 `skipped`，原因"导入的历史消息，机器人不处理"；本人在手机上发的（fromMe）存成 F12 的 `author: "owner"`，会话里显示"手机回复"。媒体只存"[媒体消息]"之类的标记，和没开识别的入站媒体一样；
    - 会话：没有就新建，已有（比如新消息先到）就并进去。新会话的创建时间取最早一条导入消息的时间，更新时间取最新一条，不用"现在"，免得会话列表排序乱、按天的统计虚高；已有会话的更新时间只会往后推，不会被旧消息拨回去。名字取聊天列表里的名字，号码按 chat id 换算，都只补空的，不覆盖 webhook 写进去的；
    - 去重：按消息 id（同一会话内），id 前缀不同但最后一段相同的也算同一条（和引用匹配一样，见第 14 条）。重复导入不会重复；导入过的消息 webhook 再推也按 id 去重；
    - 已知限制：消息按入库顺序显示，所以导入之前几秒里客户刚好发了新消息时，旧消息会排在新消息后面，会话预览也会暂时显示这条旧消息。同一个联系人在 WAHA 聊天列表里和 webhook 里用的 chat id 不一样时（比如一边 `@lid` 一边 `@c.us`），会分成两个会话；
    - 日志：每次导入一行汇总（导进几个聊天、几条消息，跳过几条，范围外和读取失败的聊天各几个），不记号码和内容；读单个聊天失败只计数。
37. **F12 手机上发的消息（只有扫码号，Meta 没有这一项，收到 fromMe 的一律忽略）**：
    - 事件：webhook 订阅从 `message` 改成 `message.any`（别人发的和自己发的都推，payload 一样），仍兼容 `message`。已有的号：服务启动时发现 inkdove 管理的那部分配置指纹（第 2 条）变了，就在后台 PUT 一次新配置。按 WAHA 文档，运行中的 session 会被自动 stop 再 start（不登出），所以升级后第一次启动，每个已连接的号会短暂断开重连，重连后按第 36 条再导入一次（按 id 去重，不会重复）。从没推过配置的号（还没建 session）不动；WAHA 连不上只记日志，下次「开始扫码连接」时再推；
    - 聊天对象：GOWS 自己发的消息 `from` 是聊天对象、私聊的 `to` 是 null，WEBJS 是 `from` 自己、`to` 聊天对象（见「已核实的外部接口」）。代码先取原始消息的 `_data.Info.Chat`，没有时 `from` 是群、广播、频道就用 `from`，否则 `to` 优先；
    - 回声剔除，命中一条就丢掉：① WAHA 标了 `source: "api"`（经 WAHA 的 API 发出）；② message id 对得上本服务最近 10 分钟经 API 发出的消息（完整 id 或最后一段，和第 14 条一样）；③ 同一个 chat、去掉首尾空白后文字相同、30 秒内。③ 是给回声比 API 响应先到的情况用的：发请求之前就记下文字，id 等 API 返回再补。WAHA 标了 `source: "app"`（手机等其他设备发的）时不用 ③。经 API 发的包括机器人回复、后台人工、F3 转发和回执、通知、文件（文件按说明文字比，没说明时是空）。这份记录在内存里，重启后清空，重启前发的消息的回声由数据库里的 id 去重兜住（通知不进会话，发给通知号码的本来就不存）；
    - 已知误判：引擎不给 `source` 时，机主 30 秒内在同一个会话里手动发了和机器人一字不差的文字，或者机器人发了不带说明的文件后 30 秒内机主发了不带说明的媒体，会被当成回声丢掉；
    - 存：只存回复范围内的私聊（黑白名单照常判断，通知号码不存），`author: "owner"`、`via: "phone"`、方向 out、已发送、已处理，时间用 WhatsApp 的时间，媒体只存标签。会话没有就新建，名字留空（fromMe 消息里的 pushName 是机主自己），号码只补空的。和导入（第 36 条）用同一套 id 去重：同一会话内完整 id 或最后一段相同就算同一条，导入过的 webhook 再推不重复，反过来也一样；
    - 不影响机器人：不暂停、不取消防抖和拟真发送、不标待处理、不通知、不调模型、不写处理记录，只用来填转人工记录的 `phone` 首次回复。不过机器人之后生成回复时，它会以"[客服]"出现在历史里，和导入的手机回复一样。
38. **F12 转人工记录（`handoffs`）**：
    - needsHuman 从 false 变 true 时新建一行，code 用这次转人工的 code（非文字消息 `media_unsupported`，限流 `rate_limit`，其他取回复引擎或识别的结果）。还在待处理时再次转人工不新建；
    - 首次回复：开着的那一行（还没有首次回复、也没恢复）由第一条人工消息填。后台发的（文字或文件，只算发送成功的）记 `admin_ui` 和发送人；通知号码引用转发的记 `whatsapp_relay`，发送人为空；手机上发的记 `phone`，时间取服务收到的时间，因为 WhatsApp 的时间只到秒，还可能和服务器时钟有偏差，会早于开始时间。导入的手机回复不算；
    - 恢复机器人（后台按钮、`/resume`）时，开着的行都填 `resumedAt`；
    - F11 判 declined 不算转人工，不建行。
39. **F12 模型调用（`llm_calls`）**：
    - 每次逻辑调用一行（`ctx.ai` 的每个方法一次），接口内部的重试（429、5xx）不另算。purpose 有：
      - 规格里的：`reply`（生成回复）、`review`（审核）、`draft`（起草）、`kb_draft`（存知识库）、`distill`（整理资料和题目）、`media`（语音图片识别）、`test`（测试连接）；
      - `leads`：F6 客户线索提取（`ctx.ai.extractLead`），计入会话每日模型次数；`redteam` 先留着，调用方用 `llmScope({purpose})` 覆盖；
      - 规格外新增：`file_describe`（F15 产品资料描述）和 `translate`（会话输入框的一键翻译，另做，不计入会话每日模型次数）。新加调模型的方法要在 `server/src/records.js` 的 `AI_METHOD_PURPOSE` 里登记，否则不记；
    - model 记设置里的模型名，不是接口返回的带日期版本，按它和 `pricing` 对单价；
    - token：
      - openai 取 `usage.prompt_tokens` 和 `completion_tokens`；
      - anthropic 的输入是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，输出是 `output_tokens`。缓存读写的单价和普通输入不一样，这里都按普通输入算，所以成本是估算；
      - gemini 的输入是 `promptTokenCount`，输出是 `candidatesTokenCount + thoughtsTokenCount`；
      - 没有用量字段记 null，只缺一部分时缺的按 0 加。OpenAI 语音转写接口不返回 token，记 null；
    - ok：方法正常返回记 1，抛错记 0。模型回了但 JSON 解析不了、按原有逻辑不抛错的，记 1。真实模式下在发请求之前就出错的（比如 anthropic 格式不支持语音）没调模型，不写；
    - mock 模式也写，format 和 model 记 `mock`，token 为 null；
    - 号和会话：处理会话时的调用（回复、审核、起草、识别、存知识库）带上；整理资料、文件描述、测试连接和后台测试对话为空。
40. **F11 回复引擎判拒绝（declined）**：
    - 回复引擎新增 category `declined`，表示客户明确说不需要、没兴趣、别再联系。"再考虑一下"这类犹豫、"太贵了"这类嫌贵不算；嫌贵按价格规则转人工，prompt 里写明了；
    - 判 declined 时：不回复、不通知、不起草、不记缺口；会话暂停机器人（botPaused=true），needsHuman 保持 false；客户消息 botDecision=declined，前端显示"客户拒绝·已停止"；处理记录 decision 和 code 都是 declined。这一轮之后还没处理的消息记 skipped。管理员恢复机器人后照常回复；
    - F11 外联：服务里留了 `customerDeclined()`，`createApp` 的选项 `onDeclined` 会收到 `{accountId, conversationId, ts}`。外联做了以后，在这里给 Recipient 记 declinedAt；
    - mock 规则：含"不需要""not interested""no thanks"的判 declined；含"太贵""too expensive"的按价格转人工，原因是"客户嫌贵"。
41. **模型单价 `pricing`**（全局设置，只有 admin）：`[{model, inputPerMillion, outputPerMillion}]`，单位是美元每百万 token，PUT 时整体替换。
    - 校验：必须是数组，最多 200 行，每行是对象；model 去掉首尾空白后 1–200 字，不能重复（区分大小写）；两个单价是 0–100000 的数字。多余字段丢掉；
    - 不合法返回 400 `invalid_input`，错误信息以 `pricing` 开头；数据库里存坏了的读出来当空表。
42. **这次没做的 F12 部分**：看板接口 `/api/dashboard`。`lead_stage_history` 已随 F6 建好（见「客户线索（F6）」）。
43. **F6 客户线索里规格没定、按自己理解做的**：
    - **删除后不会被旧消息再提取出来**：提取水位存在 `conversations.lead_seq` 上，删线索时把水位推到会话当前最新的消息。之后客户又发了新消息、满足三个条件时，会再提取出一条新线索（新 id）；
    - **`lastContactAt`** 是会话里最新一条消息（任何一方，含导入的）的时间，读的时候算，不存；列表按它倒序；
    - **`leads.enabled=false` 只停后台扫描**，手动「重新提取」照样能用（也计入每日模型次数）；
    - **超每日上限的错误码**：规格没定，手动重新提取返回 429 `llm_daily_limit`；后台扫描跳过、下次再试；
    - **后台提取失败**（模型报错、输出解析不了）的会话 30 分钟内不再试（记在内存里，重启清空），免得反复调模型把这个会话当天的回复次数用光；一次扫描最多提取 20 个会话，其余的下次接着来；同一个会话同时只提取一次，后台正在提取时点「重新提取」等那次的结果；
    - **PUT 里"改过的字段"按请求体里出现的字段算**（前端只发改动的字段），值和原来一样也记进 `manualFields`；不认识的字段忽略，而不是 400；
    - **agent 删除**：F8 权限表里 agent 没有删除线索，所以 agent 删自己号的线索也是 403；
    - **CSV 里的号码**写成 `+` 加数字，按防公式注入的规则前面会多一个单引号（`'+8613900000000`），这样 Excel 不会把号码显示成科学计数法；
    - **country** 让模型写中文国名、聊天里明确提到才填；看板的国家分布（F12）按规格从号码解析，不用这个字段。

## 已核实的外部接口

- **WAHA**：
  - session 的创建、更新、启动、停止、登出和删除，见 [sessions](https://waha.devlike.pro/docs/how-to/sessions/)；
  - webhook 的 events 和 HMAC（`X-Webhook-Hmac`，sha512，对原始 body 计算），见 [events](https://waha.devlike.pro/docs/how-to/events/)；
  - `message.any`：别人发的和自己发的都推，payload 和 `message` 一样；`source` 字段经 WAHA API 发出的是 `api`，否则是 `app`。见 [events](https://waha.devlike.pro/docs/how-to/events/)；
  - GOWS 的消息结构，按 core 分支源码 [session.gows.core.ts](https://raw.githubusercontent.com/devlikeapro/waha/core/src/core/engines/gows/session.gows.core.ts) 的 `toWAMessage`（这是最新源码，没对到 2026.9.2 这个版本）：
    - `from` 是原始消息的 `Info.Chat`（自己发的也是），`to` 私聊是 null、群里是发送人；`_data` 是原始消息；
    - id 是 `<IsFromMe>_<chat>_<ID>`，群里再接 `_<participant>`，所以按最后一段匹配 id 的做法成立；
    - `source`：发送设备和 WAHA 自己的设备是同一个时是 `api`，否则 `app`（枚举见 [responses.dto.ts](https://raw.githubusercontent.com/devlikeapro/waha/core/src/structures/responses.dto.ts)）；
    - `message` 只推别人发的，`message.any` 推全部；
    - 注意：下面「读已有聊天」实测 fromMe 的 `from` 是机主自己的号，和这份源码不一致。代码先取 `_data.Info.Chat`，两种都兼容；
  - sendText、标已读 `POST /api/sendSeen {session, chatId, messageIds}`（GOWS 支持 messageIds），见 [send-messages](https://waha.devlike.pro/docs/how-to/send-messages/)；
  - 正在输入 `POST /api/{session}/presence {chatId, presence: "typing" | "paused"}`，WAHA 不会自动发，见 [presence](https://waha.devlike.pro/docs/how-to/presence/)；
  - 入站消息的 `replyTo`（`id` 不带前缀），见 [message.dto.ts](https://raw.githubusercontent.com/devlikeapro/waha/core/src/structures/message.dto.ts)；
  - `X-Api-Key`，见 [security](https://waha.devlike.pro/docs/how-to/security/)；
  - GOWS 镜像，见 [engines](https://waha.devlike.pro/docs/how-to/engines/)；
  - 会话存储，见 [storages](https://waha.devlike.pro/docs/how-to/storages/)；
  - lid 转手机号，见 [contacts](https://waha.devlike.pro/docs/how-to/contacts/)；
  - 代理，见 [proxy](https://waha.devlike.pro/docs/how-to/proxy/)；
  - 手机号配对码：`POST /api/{session}/auth/request-code`，体 `{phoneNumber: "<纯数字国际号码>"}`（`method` 可省），返回 `{code: "LDYW-LWV8"}`。GOWS 支持，见镜像 `devlikeapro/waha:gows` 2026.9.2 里 `dist/core/engines/gows/session.gows.core.js` 的 `requestCode`：只能在会话状态为 `SCAN_QR_CODE` 时调用，`STARTING` 时最多等 2 秒，否则返回 422 `Can request code only in SCAN_QR_CODE status. The current status is X`。配对码只在这一轮等待扫码期间有效：没人扫码或输码时，WAHA 两分多钟后把会话停掉（FAILED），码随之作废。申请过配对码却没输入，会话里会留下半截登录凭证，之后再 start 或 restart，会话直接去"登录"然后 FAILED（`Connection Failure`），不再回到 `SCAN_QR_CODE`，要先 `POST /api/sessions/{name}/logout` 清掉凭证再 start 才能重新出码。这一条是在 NOWEB 引擎上实测的，GOWS 按同样的情况防；
  - 对已经在跑的会话再 `POST /api/sessions/{name}/start`（10-12 实测，GOWS 2026.9.2，会话在 `SCAN_QR_CODE`）：不报 422，正常返回会话 JSON，状态不变。所以"开始扫码连接"对等待关联中的号重复点不会出错，也不会让二维码重来；
  - `POST /api/sessions/{name}/logout`（10-12 实测，GOWS 2026.9.2）：返回 201，会话自己重启，1 秒内进入 `SCAN_QR_CODE` 并一直停在那里等关联，不用再 start。这里登出后照样补一次 start：会话已经到 SCAN_QR_CODE 时按上一条是无害的；还在 STARTING 时 start 的结果没实测，代码容忍 422；
  - 发文件和图片：`POST /api/sendFile`、`POST /api/sendImage`，体是 `{session, chatId, file: {mimetype, filename, data} | {mimetype, filename, url}, caption?}`。data 是不带 `data:` 前缀的 base64，返回体顶层有 `id`。见 [send-messages](https://waha.devlike.pro/docs/how-to/send-messages/) 和 [files.dto.ts](https://github.com/devlikeapro/waha/blob/core/src/structures/files.dto.ts)；
  - GOWS 支持 sendImage 和 sendFile，见 [engines](https://waha.devlike.pro/docs/how-to/engines/) 和 [session.gows.core.ts](https://raw.githubusercontent.com/devlikeapro/waha/core/src/core/engines/gows/session.gows.core.ts)。按 [changelog](https://waha.devlike.pro/docs/overview/changelog/) 和 [waha-plus](https://waha.devlike.pro/docs/how-to/waha-plus/)，从 2026.6.1 起原来 Plus 的功能并入了 Core；
  - 读已有聊天（2026-10-12 实测，GOWS 2026.9.2，Core）：
    - `GET /api/{session}/chats?limit=N` 返回 `[{id, name, conversationTimestamp}]`；
    - `GET /api/{session}/chats/overview?limit=N` 返回 `[{id, name, picture, lastMessage, _chat: {id, name, conversationTimestamp}}]`，顶层 `name` 实测是 null，名字在 `_chat.name`。导入用的是上一个接口；
    - `GET /api/{session}/chats/{chatId}/messages?limit=N&downloadMedia=false` 返回消息数组，字段 `id, timestamp(秒), from, fromMe, source, body, to, participant, hasMedia, media, ack, ackName, replyTo, location, vCards, _data`。`to` 实测是 null（fromMe 的也是），`media` 是 null，所以聊天对象只能从 chat id 取；
    - chat id 实测是 `<号码>@c.us`（私聊）和 `<id>@g.us`（群），NOWEB 引擎还见过 `@s.whatsapp.net` 和 `@lid`；
    - 新关联的设备，WhatsApp 每个聊天只同步最后 1 条消息（实测 26 个聊天，每个 1 条，最早的是 2022 年的，不少是本人发的）。这些历史消息不会触发 webhook 的 `message` 事件；
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
  - token 用量（F12）：
    - OpenAI 是 `usage.prompt_tokens`、`usage.completion_tokens`，见 [chat completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)；
    - Anthropic 是 `usage.input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`output_tokens`，其中 `input_tokens` 不含缓存部分，见 [Messages](https://platform.claude.com/docs/en/api/messages) 和 [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)；
    - Gemini 是 `usageMetadata.promptTokenCount`、`candidatesTokenCount`、`thoughtsTokenCount`，见 [generateContent](https://ai.google.dev/api/generate-content)；
  - 识图和语音：
    - OpenAI：图片用 `image_url` 传 data URL，见 [images-vision](https://developers.openai.com/api/docs/guides/images-vision)。语音用 `POST /audio/transcriptions`，multipart 带 `file` 和 `model`，返回 `{text}`，上限 25MB，见 [speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text) 和 [transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。ogg 的支持两份官方文档说法不一致：指南页没列 ogg，[Python reference](https://developers.openai.com/api/reference/python/resources/audio/subresources/transcriptions/methods/create) 列了。WhatsApp 的 ogg/opus 语音要用真样本试一次；
    - Anthropic：图片用 `{type: "image", source: {type: "base64", media_type, data}}`，每张不超过 10MB，不支持音频，见 [vision](https://platform.claude.com/docs/en/build-with-claude/vision)；
    - Gemini：图片和音频都放进 parts 的 `inlineData: {mimeType, data}`，整个请求 20MB 以内，见 [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)、[audio](https://ai.google.dev/gemini-api/docs/audio)。

## 许可证

[MIT](LICENSE) © 2026 Inkdove contributors
