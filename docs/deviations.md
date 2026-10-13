# 偏离规格

开发中和 SPEC（[SPEC.md](../SPEC.md)、[SPEC-phase2.md](../SPEC-phase2.md)）不一致的地方都记在这里，新条目接着编号往下加。

1. **Meta Graph API 默认版本是 `v26.0`**。规格示例写的是 v23.0，这里按 Meta 的版本变更日志用了核实时最新的版本，号详情里可以改。
2. **WAHA 配置只在变了时才 PUT**。inkdove 管理的那部分 session 配置（webhook 和代理）算一个指纹（`HMAC-SHA256(INKDOVE_SESSION_SECRET, 配置)`），存在 `accounts.waha_config_hash`。start 时 session 已存在且指纹没变、中继也没重启，就不 PUT，避免 WAHA 读回来的配置把密码打码后每次都判成"变了"。PUT 时只覆盖 webhooks 和 proxy，session 配置里的其他字段原样保留。中继重启时即使指纹没变（中继地址和凭证不变）也会 PUT 一次，让 WAHA 重连到新的上游。
3. **https 上游的中继没有自动化测试**。测试用自签名证书时 TLS 校验会失败；socks4、socks5 两条路径有完整测试（假上游 + 假目标服务）。中继的随机凭证明文存在 SQLite 里。
4. **只用于测试的覆盖项**：
   - 环境变量 `INKDOVE_META_GRAPH_URL`（默认 `https://graph.facebook.com`）和 `INKDOVE_RESEND_API_URL`（默认 `https://api.resend.com/emails`）；
   - 代理测试的目标地址、拟真等待时长、通知重试间隔、中继监听地址、配对码等会话就绪的时长和轮询间隔（`wahaPairWaitMs`、`wahaPollMs`）、进入 WORKING 后等多久再导入已有聊天（`historyImportDelayMs`）、客户线索的扫描间隔（`leadsScanIntervalMs`，0 表示不启动定时扫描，测试里手动调 `ctx.leads.scan()`）、看板的时钟（`dashboardNow`）只能通过 `createApp` 的选项覆盖。
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
17. **第一期迁移**见[升级说明"从第一期升级"](upgrade.md#从第一期升级)。Meta 的旧回调地址 `/webhooks/meta` 已删除，访问返回 404。
18. **通知失败最多尝试 2 次**（重试 1 次），失败只写日志。
19. **会话"连上时间"的判定**：服务在 webhook 或状态查询里看到 session 从非 WORKING 变成 WORKING 时，才记为连上时间。早于"进程启动时间和连上时间中较晚的那个"减 60 秒的消息会被忽略。
20. **网址抓取的 SSRF 防护**：每一跳重定向都会重新解析并校验 IP。DNS 解析和实际连接之间仍有极短的 rebinding 窗口；要彻底消除需要自定义 DNS lookup，这里没做。
21. **非文字消息**：F4 的识别关着、号没开自动回复、会话已暂停或模型没配置时，仍按第一期处理：不下载，只存"[图片]""[语音]"之类的标记，记 skipped，标 needsHuman 并通知（推荐回复模式除外，见第 48 条）。其他情况见 [F4](features.md#f4-语音和图片识别)。
22. **F12 的处理记录**：每轮处理（合并的几条消息算一轮）在 `decisions` 表写一行，skipped 不写；`onDecision` 钩子保留，同一行再传一份。后台测试对话（`/api/kb/ask`）不写处理记录（和第 25 条的缺口清单一样，免得测试混进统计），但它调的模型照样记进 `llm_calls`（号和会话为空）。模型判的 handoff 按 `handoff_type` 映射成 code（见 [F15 里的表](features.md#f15-产品资料库和发文件)）；模型判的 offtopic 按新增的输出字段 `offtopic_type`（`task`、`chitchat`、`injection`、`other`）原样作为 code，没给或不认识的记 `other`；审核判的离题记 `review_offtopic`。
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
    - **FAILED 的会话先普通重启，还是 FAILED 才登出重来**，申请配对码和「开始扫码连接」都这样。先 stop 再 start（不登出），等结果：回到 WORKING 就算恢复了（网络抖动造成的 FAILED 多半这样，不用重新扫码；申请配对码时这种情况返回 409 `already_connected`）；进入 SCAN_QR_CODE 就照常出码或申请配对码；又落回 FAILED，才 logout 再 start。这是为了对付申请过配对码却没输入时留下的半截登录凭证，这种会话普通重启永远回不到 SCAN_QR_CODE（见[「已核实的外部接口」](external-apis.md)）。只有走到登出这一步，这个号才要重新扫码或输码。普通重启用 stop + start 而不是只 start，因为 start 对没停的会话什么都不做，FAILED 算不算"没停"还没实测；WORKING 的号一律不动；
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
    - 聊天对象：GOWS 自己发的消息 `from` 是聊天对象、私聊的 `to` 是 null，WEBJS 是 `from` 自己、`to` 聊天对象（见[「已核实的外部接口」](external-apis.md)）。代码先取原始消息的 `_data.Info.Chat`，没有时 `from` 是群、广播、频道就用 `from`，否则 `to` 优先；
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
      - `leads`：F6 客户线索提取（`ctx.ai.extractLead`），计入会话每日模型次数；`redteam`：F5 红线体检里的调用（生成、套话重写、审核），体检用 `llmScope({purpose: 'redteam'})` 覆盖按方法名推出的用途；
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
    - F11 外联：服务里的 `customerDeclined()` 先调外联模块给 Recipient 记 declinedAt（见[「主动外联（F11）」](features.md#主动外联f11)），再调 `createApp` 的选项 `onDeclined`（收到 `{accountId, conversationId, ts}`，测试用）；
    - mock 规则：含"不需要""not interested""no thanks"的判 declined；含"太贵""too expensive"的按价格转人工，原因是"客户嫌贵"。
41. **模型单价 `pricing`**（全局设置，只有 admin）：`[{model, inputPerMillion, outputPerMillion}]`，单位是美元每百万 token，PUT 时整体替换。
    - 校验：必须是数组，最多 200 行，每行是对象；model 去掉首尾空白后 1–200 字，不能重复（区分大小写）；两个单价是 0–100000 的数字。多余字段丢掉；
    - 不合法返回 400 `invalid_input`，错误信息以 `pricing` 开头；数据库里存坏了的读出来当空表。
42. **F12 看板接口里规格没定、按自己理解做的**（详见[「管理员数据看板（F12）」](features.md#管理员数据看板f12)）：
    - **参数**：range 不传按 7d；tz 不传按 UTC，传了但不认识的返回 400 `invalid_tz`，不悄悄退回 UTC；
    - **导入的历史消息**不计入客户消息、新客户和热力图。**新客户**按会话里最早的一条客户消息判断，导入的也拿来比较，所以导入过历史聊天的老客户不算新客户（否则关联号之后，每个老客户发来的第一条消息都会被算成新客户）；
    - **`handoffReasons` 多一个 `decision` 字段**，按 (decision, code) 分组；
    - **`kpi.handoffs`** 数的是转人工记录（`handoffs` 表），不是 handoff 处理记录数；
    - **declined 的处理记录**不进 turns、趋势、回复率，也不进 handoffReasons；
    - **`unusedEntries`** 的"被引用"按任何一条处理记录的 usedEntryIds 算（不只 replied），30 天从现在往前算，不随 range 和号变；
    - **`kb.topFiles`** 只数机器人发的文件（decisions.sentFileIds 在本时间段内出现的次数）。后台人工发的文件不在 decisions 里，所以和文件页的"发送次数"（sendCount：含人工发的，不分时间段）对不上；
    - **`kb.topGaps`** 只列还 open 的缺口，次数按本时间段内的 `gap_hits` 算；
    - **leads 的 stages、funnel、countries 不按时间段**，是当前线索的快照；products 按时间段。countries 数的是线索的人数，"未知"的 `code` 为 null；
    - **members** 列出所有成员，包括停用的、没有记录的；phone、relay 两行的 `manualMessages` 为 null；
    - **cost** 部分模型没配单价时，总费用只算配了的，含没配单价模型的用途 costUsd 为 null；
    - **`abuse.mutedConversations`** 是实时数（现在还在静默中的），因为库里只记了静默到什么时候，没有每次静默的记录；
    - **outreach** 的回复率、拒绝率按本时间段内发出的人算，回复、拒绝可能发生在时间段之后；
    - **`accounts[].state`** 缓存 30 秒，看板刷新时不每次都去问 WAHA；
    - **只用于测试的覆盖项**：`createApp` 的选项 `dashboardNow`（时钟）。
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
44. **F5 红线体检里规格没定、按自己理解做的**（详见[「红线体检（F5）」](features.md#红线体检f5)）：
    - **题量**：规格表合计 30 道，加 F15 的"所有文件"题共 31 道红线题，再加至多 5 道正常题和至多 1 道目录题；
    - **类别 key**：规格只定了表里的六个。多轮题用 `multi_turn`、正常题用 `legit`（和前端约定一致），F15 的"所有文件"题用 `file_dump`，目录题用 `catalog`（`isLegit: true`，前端按正常题显示）。注入题只要求不回复，`expected` 记 `not_replied`；
    - **多轮题的第一轮是固定的**：`history` 里写死客户问价和一句不报价的机器人回复，不先跑一遍引擎。这样结果确定、每题只调一次生成，只判第二轮；
    - **目录题要真的带文件才算答上**：回复了但没带文件也算误伤；
    - **`summary.total` 是已判完的题数**（进行中、取消时都是），计划的总题数看 `progress.total`；
    - **取消**立刻把状态改成 cancelled、`current` 清空，还在路上的一两题回来后丢掉（库里不会再变），返回 `{ok: true}`；不在跑 409 `job_not_running`；
    - **出错**：模型调用失败由引擎按转人工处理，所以模型挂了时红线题照样"通过"、正常题全算误伤，看误伤数和原因能发现；只有引擎本身抛错（程序错误）时整次判 failed，另一路也不再出新题；
    - **正常题的抽取用 `Math.random`**，不可指定种子；测试里放正好 5 条 faq/product 让结果确定；
    - **mock 规则**补了一组红线说法（见[「红线体检（F5）」](features.md#红线体检f5)），只影响 mock，真实引擎的判定逻辑没改。
45. **F11 主动外联里规格没定、按自己理解做的**（详见[「主动外联（F11）」](features.md#主动外联f11)）：
    - **号码写法**：`00` 一律当成 `+`，不管默认国家的国际冠码是什么；不带 `+` 的先按默认国家解析，不行再当成省掉 `+` 的国际号码；`+` 前面允许有一个左括号。点号、字母、分机号都算 invalid。`defaultCountry` 不传时用 CN，必须是 libphonenumber-js 支持的国家码，否则 400 `invalid_country`；
    - **主时区**：多时区国家用一张手写的表定（首都或人口最多的地区），表外的国家取库里列出的第一个时区，解析不出国家的用 UTC。号码不区分具体州省，比如美国号码一律按纽约时间；
    - **发送窗口**：`[windowStart, windowEnd)`，`windowStart` 晚于 `windowEnd` 表示跨午夜，两个相同表示全天；
    - **格式不对的和重复的也存成收件人**（skipped，`invalid` 的 number 是原文），所以 `stats.total` 等于文件里的号码行数，收件人列表按 skipped 能查到它们；
    - **每个号码只记一个跳过原因**，按 invalid → duplicate → notify_number → already_contacted → blocklisted 的顺序。notify_number 不管这个号的 WhatsApp 通知开没开都算。blocklisted 在分配之后判，pooled 里被跳过的号码仍占着那个号的名额，不重新分；
    - **发送前再查一遍** blocklisted、notify_number、already_contacted（规格只说预检时查）。两个任务里有同一个号码时，先发的那个发出去，另一个发送时按 already_contacted 跳过，保证每个号码只发一条；
    - **每日上限**只数发送成功的（查到没有 WhatsApp 的、失败的不占名额），按服务器本地日期（容器可用 TZ 环境变量调整），过了零点重新计。`perAccount.sentToday` 是这个任务今天在这个号上发的数，上限本身是这个号所有任务合计；
    - **间隔**：查号查到没有 WhatsApp 也等一个间隔（查号也是一次 WhatsApp 请求）；发送前再查时本地就跳过的不等；
    - **连续失败计数**按"任务 + 号"记在内存里，重启或继续时清零。查号接口出错也算失败。自动暂停后已经失败的号码不重发；
    - **Meta 号**：只发模板名和语言，不支持模板变量（components），模板里有变量的发送会失败。Meta 没有查号接口，号码不在 WhatsApp 上时会发送失败，计入连续失败。只有 Meta 号的任务开场消息可以不填；有扫码号时必填（400 `message_required`），最长 4096 字。任务名必填，最长 100 字；
    - **取消**后没发的号码保持 pending，不再发；
    - **删除任务**连同它的收件人一起删，看板上的外联统计也会少掉这部分；已经发出的消息和会话保留，所以这些号码之后仍按 already_contacted 跳过；
    - **号被删了**：它在 running 任务里没发的号码记 failed（"发送用的号已删除"），任务能正常结束；
    - **状态不对的操作**（比如开始一个已经在发的任务）返回 409 `invalid_status`；
    - **白名单放行**只放行这个号发送成功过的外联对象，没发出去的（failed、skipped）不放行；
    - **repliedAt** 只记第一条回复，任何类型的消息都算（语音、图片也算），黑名单和范围外的不算；
    - **外联新建的会话**联系人名字是空的，对方回复时用 WhatsApp 昵称补上；
    - **Campaign 多一个 `outreach` 字段**（生效中的外联设置），因为 agent 读不到全局设置；
    - **只用于测试的覆盖项**：`createApp` 的选项 `outreachNow`（时钟）、`outreachIntervalMs`（两条之间等多久）、`outreachTickMs`（定时检查的间隔，0 表示只在启动时检查一次，测试里手动调 `ctx.outreach.tick()`）；
    - **WAHA 查号接口是按文档写的，没在真机上验证**，GOWS 引擎实际返回什么要真机核实（见[「已核实的外部接口」](external-apis.md)）。
46. **按客户分配里约定没定、按自己理解做的**：
    - **存储**：`conversations` 加 `assignee_id`、`assigned_at`；新表 `conversation_assignments(id, conversation_id, from_user_id, to_user_id, by_user_id, reason, at)`，负责人每变一次写一行，和改会话在同一个事务里。代码在 `server/src/wa/assign.js`，权限判断只有 `server/src/auth.js` 的 `canAccessConversation` 一处（会话详情、消息、发送、发文件、翻译、机器人开关、kb-draft、分配记录和线索都走它），会话列表和线索列表按同一套条件在 SQL 里过滤；
    - **分配记录不存名字快照**：名字取成员现在的名字（没填名字的用邮箱），成员被删了显示「已删除成员」。Conversation 的 `assignee.name` 是原样的名字（可能为空），前端可以退回 `email`；
    - **`assignedAt`** 是最近一次改负责人的时间，取消分配时清空；分给同一个人不算改，不动它，也不写记录；
    - **还没接受邀请的成员**也能被分配、算"启用中"，只有停用的和不存在的返回 `assignee_invalid`；
    - **只有 admin 的接口先判角色**：agent 调改负责人、批量分配、转交一律 403，不论会话存不存在。会话级接口仍然先判存在再判权限（会话不存在 404），和以前一样；
    - **批量分配**：`conversationIds` 里重复的只算一次；空数组返回 `{updated: 0, skipped: []}`；每个会话按 not_found → unchanged → assignee_no_account_access 的顺序判。`userId` 没传、类型不对返回 400 `invalid_input`（单个分配也一样），目标无效时一个都不改；
    - **失去号的权限统一按一条规则收回**：agent 的 `accountIds` 去掉了某个号、admin 降级成 agent、号被删除，都是"agent 现在没有这个号的权限"，他在这些号上负责的会话变成未分配（`access_removed`，by 记操作的管理员）。把号加回来不会自动分回去；admin 负责的会话不受删号影响；
    - **升级迁移**的"启用中"指没停用（含还没接受邀请的），admin 不算；by 为 null（系统）。新装的库第一次启动就记上标记，之后不会再迁移；
    - **外联发起人归属**：发送时重新读发起人，已停用、已删除、改成了 admin、没有这个号权限的都不分（约定只写了 admin 不分；停用的也不分，和"不能分给停用成员"一致）；会话已经有负责人的不动；by 为 null（系统）。回复从 `@lid` 来、落在另一个会话时，那个会话按客户主动来消息处理，保持未分配，没有继承外联会话的负责人；
    - **列表筛选**：admin 传不存在的成员 id 返回空数组；agent 传自己的 id 等同 `me`。号级的规则没变：`accountId` 指定没权限的号仍然 403，号码页、号的状态和外联任务仍然按号判断；
    - **`assignedCount`** 除了 `GET /api/users`，新建成员和 `PUT /api/users/:id` 返回的成员也带；`/api/auth/me` 不带；
    - **日志**只记数量和邮箱，不记会话 id（里面有客户号码）。
47. **在线更新里约定没定、按自己理解做的**（详见[「在线更新」](online-update.md)，代码在 `server/src/update.js`，更新助手的接口参数集中在里面的 `UPDATER_API`）：
    - **多了 `INKDOVE_IMAGE_TAG`**：应用自己看不到 compose 用的镜像标签，没法判断钉没钉版本，所以 compose 改成 `ghcr.io/bowen1314/inkdove:${INKDOVE_IMAGE_TAG:-latest}`，同一个变量也传给应用。镜像名（不带标签，传给更新助手的 `image=`）按 `INKDOVE_UPDATE_REPO` 推：`ghcr.io/<小写的 owner/repo>`，所以改了 `INKDOVE_UPDATE_REPO` 时 compose 里 `inkdove` 的 `image:` 也要改成对应的镜像名，否则更新助手找不到要更新的容器。直接改 compose 里 `image:` 的标签（不用 `INKDOVE_IMAGE_TAG`）应用是看不出来的，一键更新会白等 5 分钟后提示手动命令。`latest` 不算钉；`x.y` 和最新版同一个小版本时不算钉；完整版本号、别的 `x.y`、自定义标签都算钉；
    - **`GET /api/update` 多一个 `checkEnabled`**（设置页据此显示"已关闭检查"）。`updater.reachable` 只在设了口令时带，只建 TCP 连接探一下（1.5 秒超时），不发 HTTP 请求，免得误触发更新；
    - **`POST /api/update/check` 60 秒内重复调用**返回上次的结果（200），不返回 429；同时点多次只请求一次 GitHub。关闭了检查时 400 `update_check_disabled`；
    - **`POST /api/update/apply` 的其他错误**：镜像钉了版本 400 `image_pinned`（一键更新升不上去，不如直接拦下）；已经在更新 409 `update_in_progress`；备份失败 500 `backup_failed`。更新助手 15 秒不回应、口令不对（401/403）、返回别的状态码、连不上都是 502 `updater_failed`。成功返回 `{ok, from, to, backup}`，之后 10 分钟内再点也是 409（容器马上要重建；万一没重建，过了 10 分钟可以再点）；
    - **GitHub 出错时**保留上次查到的结果，`error` 记原因；release 链接不是 https 的换成仓库的发布页；正文超过 2 万字截断。检查结果只在内存里，重启后要等首查；
    - **备份**文件名 `inkdove-v<当前版本>-<UTC 时间，到秒>.db`，同一秒里重名加序号；按修改时间留最近 5 份，只删 `inkdove-v*.db`，目录里别的文件不碰。只备份数据库，不备份上传的文件；
    - **compose 里 `INKDOVE_UPDATER_TOKEN` 用 `:?` 必填**（和 `INKDOVE_WAHA_API_KEY` 一样）：口令为空时 watchtower 起不来、会一直重启，不如让 compose 直接报错。updater 限内存 128m（和其他服务一样设了上限，这个值没实测）；
    - **前端**：提示放在侧栏底部（和「演示模式」同一处）；设置页新增「版本」分组（`/settings/version`），原来设置页底部那行灰字版本号去掉了；版本号旁边有「源代码 · AGPL-3.0」链接，地址集中在 `web/src/lib/update.js` 的 `SOURCE_REPO_URL`。点了更新后版本号**变了**就刷新（不要求正好等于弹窗里的新版本，免得拉到更新的版本时一直等）；关掉弹窗照样在后台等；别的管理员已经点了更新（409）时一起等；
    - **测试**：`test/helpers.js` 默认关掉检查（`INKDOVE_UPDATE_CHECK=0`）、不起定时器、GitHub 指向连不上的端口；`test/update.test.js` 打开检查并指向本地假 GitHub 和假更新助手。
48. **推荐回复和权限收紧里约定没定、按自己理解做的**（详见[「推荐回复」](features.md#推荐回复手动起草)）：
    - **推荐回复模式不看会话暂停**：人工发一条消息会话就会暂停（`botPaused`），推荐回复要是也看暂停，第一次人工回复之后就不再起草了。所以推荐回复模式下暂停、反复离题的静默、每小时回复上限、每号每分钟上限都不管（它们是管机器人发消息的），只看模型有没有配、当天模型次数够不够（够 1 次就起草，自动回复要够 2 次）；
    - **不写处理记录**：`suggested` 不进 `decisions` 表（和 skipped 一样），消息上也不记 code。所以看板的 turns、自动回复率、趋势、转人工原因都不受推荐回复影响，起草的花费从 `llm_calls`（purpose `suggest`）看；
    - **推荐回复模式下的非文字消息和识别失败**：只记 skipped 和原因（没开识别的是「非文字消息…，不生成推荐回复」；识别失败、超出范围的是「语音识别失败：…」之类，不带"已通知人工"），不标待处理、不通知、不写转人工记录。关闭模式照旧标待处理并通知；
    - **防抖到了但我方最后一条消息之后客户没再说话**（比如人工刚好在防抖期间回了，消息一般已被记成"人工已接管"）：剩下没处理的记 skipped「我方已经回复」，不起草；
    - **生成期间我方回了**：按"开始起草之后会话里有没有新的出站消息"判断，后台、手机、机器人、外联都算，发送失败的也算。自动起草时这几条消息记 skipped「生成推荐回复期间我方已经回复，推荐作废」（人工从后台回的，消息已被记成"人工已接管"，不改）。手动「换一条」时结果照样返回给点按钮的人，但不存进会话；
    - **清推荐只在发送成功时**（机器人、手机、外联）；后台人工发送沿用以前的规则，发之前就清掉所有草稿；
    - **手动「换一条」**的【上一条推荐】取会话当前的草稿，不管是推荐还是转人工草稿；号已删除时 400 `account_deleted`（和从已删除号的会话发消息一样）；
    - **话术只用于推荐回复**，转人工草稿的提示词不变（没填话术时两者的 system prompt 完全一样）。v0.3.1 起转人工草稿会带会话负责人的「我的资料」（见第 50 条），话术仍只用于推荐回复；
    - **`stylePrompt` 只在 `/api/auth/me` 和 `PUT /api/auth/me/style-prompt` 的返回里**，登录、接受邀请返回的 user 和成员列表都不带（v0.3.1 起 `PUT /api/auth/me/profile` 的返回也带，同 `/api/auth/me`）；
    - **agent 读号**：`meta.verifyToken` 给 null，`notify.email.to` 给空数组，`notify.whatsapp.number` 给空字符串（字段保留、开关照常返回），列表和详情一样；
    - **agent 调只有 admin 的号接口一律先判角色**：`PUT /api/accounts/:id`（哪怕请求体是空的）、扫码连接 / 取二维码 / 配对码 / 登出、测试通知都直接 403，不论号存不存在、参数对不对，也不碰 WAHA；
    - **导出文件只带 `replyMode`**（不再带 `autoReply`）；库里也只存 `replyMode`。导入时 `replyMode` 不是三个取值之一的整批 400；
    - **客户线索的提取条件没改**：要有 replied、handoff、blocked 的客户消息或人工消息，所以推荐回复模式的会话要等人工回过之后才会提取线索；
    - **数据库**：`users` 加 `style_prompt`（默认空字符串），号的 `config` JSON 里 `autoReply` 换成 `replyMode`（读时兼容旧的），不用迁移脚本。
49. **推荐回复改为只手动触发**（用户定，自动起草太费 token）：去掉 `suggest` 模式和自动起草，回复方式只剩 `off`（人工回复，默认）/ `auto`；存量 `suggest` 读作 `off`。兼容规则见[升级说明「升级到 v0.3.1」](upgrade.md#升级到-v031推荐回复改为手动)，现在的行为见[「推荐回复（手动起草）」](features.md#推荐回复手动起草)。
50. **「我的资料」和跟进推荐（规格外新增，v0.3.1）**：
    - 每个成员可以填对客户的称呼、职位、电话、邮箱、补充介绍（`PUT /api/auth/me/profile`），放进推荐回复（点按钮的人）和转人工草稿（会话负责人，没分配或已停用不带）的提示词【业务员信息】，自动回复不用——机器人以公司身份回，不冒充业务员；
    - 推荐回复分「客户有新消息」和「跟进」两种（见 [features.md 的「推荐回复（手动起草）」](features.md#推荐回复手动起草)）：跟进时把我方最后几条话单独列给模型、要求兑现，并拼进检索词；自动回复和转人工草稿的检索不变；
    - 会话里一条客户消息都没有时（外联发出去客户没回）照旧 400 `no_customer_message`，不起草；
    - 推荐回复判断我方有没有回过只认发送成功的消息（第 48 条「起草期间我方回了，发送失败的也算」不变，那是判断推荐作废）；跟进时「换一条」只拿推荐回复当【上一条推荐】（第 48 条说的「不管是推荐还是转人工草稿」只适用于非跟进）；跟进起草期间客户来了新消息，推荐不存。
