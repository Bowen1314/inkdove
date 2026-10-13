# 合规指南：员工、客户和各地法规

## 先说清楚

- **这不是法律意见。** 这里整理的是墨鸽实际怎么处理数据，以及几个常见地区的法规里和它有关的条款，帮你知道该问什么、该准备什么。具体怎么做，按你的公司、员工和客户所在地，请当地律师判断。
- **墨鸽是自托管软件。** 它装在你自己的服务器上，数据存在你自己的 `./data` 里。墨鸽这个开源项目收不到你的任何数据（唯一的例外是在线更新会匿名访问 GitHub 查版本，见下面的表）。部署墨鸽的公司是数据的控制者（GDPR 叫 controller，中国法叫个人信息处理者）：开哪些功能、数据发给哪家服务商、留多久，都是你决定，责任也在你。
- **写于 2026 年 10 月，法规核对日期是 2026-10-13。** 法律会变，以链接里的原文为准。拿不准、还在变的地方，文中直接写了「不确定」。
- 对墨鸽功能的描述都对过 2026-10-13 main 分支的代码。功能的完整说明见 [features.md](features.md)，数据去向的技术细节见 [channels-and-security.md](channels-and-security.md)。

## 一、数据存在哪、留多久

都在部署目录下。备份 `./data` 时这些都在里面，要像保管客户资料一样保管备份。

| 数据 | 存在哪 | 留多久 |
|---|---|---|
| 聊天记录：客户和我方的每条文字、谁发的（成员、机器人、机主手机、外联）、时间、处理结果；撤回的消息原文也留着 | `./data` 的 SQLite（`messages`、`conversations`） | **一直留着**。没有删除会话或消息的功能；删掉一个号，它的会话和消息也照样留着 |
| 客户发来的图片、视频、语音、文件 | `./data/media/` | **一直留着**，不自动清理 |
| 消息的中文译文、推荐回复和转人工草稿 | SQLite（`messages.translation`、`conversations.draft`） | 译文跟着消息一直留；草稿到被发出、关掉或换成新的为止 |
| 客户线索：名字、公司、国家、邮箱、意向产品、数量、阶段、摘要，和阶段变化历史 | SQLite（`leads`、`lead_stage_history`） | 到管理员删掉这条线索为止。删掉后客户再发新消息，会重新提取出一条 |
| 外联任务和收件人：上传文件里的**每个**号码（格式不对的、重复的也存）、发没发、什么时候回复、拒绝 | SQLite（`campaigns`、`campaign_recipients`） | 到删掉这个任务为止（只有草稿、已取消、已完成的任务能删） |
| 屏蔽词命中、AI 发言检查发现的问题：原文（最多 1 万字）、发送人、号和会话、命中的词或问题类别和说明、谁点了「知道了」或「误报」 | SQLite（`blockword_hits`） | **一直留着**，没有删除功能 |
| AI 发言检查查过的文字的哈希和结果（不存原文） | SQLite（`conduct_cache`） | 24 小时 |
| 操作日志：谁、什么时候、做了什么、改之前和改之后、成功还是失败、IP；登录成功和失败、退出 | SQLite（`audit_logs`） | 默认 365 天，用 `INKDOVE_AUDIT_RETENTION_DAYS` 改（1–36500），过期的每天自动清 |
| 成员账号：邮箱、名字、角色、能用的号、密码的哈希、最近登录时间、「我的资料」（称呼、职位、电话、邮箱、介绍）、个人话术 | SQLite（`users`） | 到删掉这个成员为止。删掉后，消息上记的发送人名字、操作日志里的名字和邮箱、命中记录里的名字、会话分配记录、外联任务的发起人名字照样留着 |
| 登录会话、邀请和重置链接（只存哈希） | SQLite（`auth_sessions`、`invites`） | 会话 30 天过期，链接 7 天过期 |
| 会话分配记录：每次分给谁、谁分的、为什么 | SQLite（`conversation_assignments`） | 一直留着 |
| 转人工记录、处理记录、模型调用记录（只有用途、模型、token 数、耗时、号和会话，没有内容） | SQLite（`handoffs`、`decisions`、`llm_calls`） | 一直留着 |
| AI 助手的问答 | SQLite（`assistant_chats`、`assistant_messages`） | 到本人删掉为止；每人最多 100 个对话，多的删最早的；成员被删后，下次启动时清掉他的对话 |
| 缺口清单：客户问到、机器人答不上的问题（模型改写成的中文问题，带会话 id） | SQLite（`gaps`、`gap_hits`） | 一直留着（可以标已回答或忽略） |
| 转人工通知和会话的对应关系 | SQLite（`notice_messages`） | 7 天 |
| 知识库资料和条目、产品资料：公司自己的资料。把人工回复「存进知识库」时，改写出的条目可能带着客户的话 | SQLite、`./data/files/` | 到管理员删掉为止 |
| 在线更新前的数据库备份 | `./data/backups/` | 最近 5 份。**在库里删掉的数据，旧备份里还有** |
| 扫码号的登录态和 WAHA 自己的数据 | `./waha-sessions` | 由 WAHA 管。WAHA 文档说里面是登录信息和保持连接需要的数据，没写清本地还存不存联系人和聊天，删除数据时一并考虑。客户发来的文件在 WAHA 那边默认只留 180 秒 |
| 应用日志（容器的输出） | Docker 的日志 | 个别警告里带客户的 chat id（里面是手机号）。留多久看 Docker 的日志设置，`docker-compose.yml` 里没配日志轮转 |
| 全局代理的订阅地址和节点 | SQLite 的 kv 表、`./data/mihomo/` | 到改掉或清除为止 |

另外，扫码号绑的那部手机上的 WhatsApp 自己也有一份完整的聊天，Meta 号的消息 Meta 那边最多留 30 天（见下一节）。这些不归墨鸽管。

**回复范围（号的黑名单、白名单）决定存不存。** 在号详情里把一个号码加进黑名单后，这个号码之后发来的消息、机主在手机上发给他的消息都**不存**，机器人也不回；白名单模式下只存名单里的号码（和这个号外联过的对象）。群聊一律不收。扫码号关联时导入手机里已有的聊天，也按回复范围筛。

## 二、数据会发给谁

| 发给谁 | 发什么 | 什么时候 | 默认 |
|---|---|---|---|
| WhatsApp（扫码号经 WAHA 连 WhatsApp 的服务器） | 收发的所有消息和文件；外联前查这个号码有没有 WhatsApp | 一直 | 用扫码号就有 |
| Meta（Cloud API 号） | 收发的所有消息和文件、外联的模板消息 | 一直 | 用 Meta 号就有。Meta 说自己在 Cloud API 里是数据处理者，消息最多留 30 天（[Meta 的说明](https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security)） |
| **回复模型的服务商**（「设置 → AI 模型」里填的地址，下面分项） | | | |
| ┣ 自动回复 | 客户这一轮的话、最近 12 条聊天、知识条目、企业画像、人设；再调一次做审核 | 号选了「自动回复」、客户来消息时 | 关（新号默认「人工回复」） |
| ┣ 推荐回复、转人工草稿 | 客户的话和最近的聊天、知识条目、公司话术和个人话术、点按钮的人（转人工时是会话负责人）的「我的资料」 | 点「推荐回复」「换一条」时；自动回复转人工时 | 点了才发 |
| ┣ **客户线索提取** | 会话最近 50 条消息（标明是客户、机器人、人工还是手机发的）和客户的 WhatsApp 昵称 | 后台每 2 分钟：有人工或机器人处理过、客户停下 10 分钟以上的会话 | **开**。配好模型就自动跑，「设置」里能关 |
| ┣ 一键翻译（AI 翻译）、消息译成中文、草稿的「中文意思」 | 要翻译的那段话；判断客户语言时带客户最近 10 条文字消息 | 点「翻译」时；推荐回复和草稿出来时自动译「中文意思」 | 默认用回复模型翻译 |
| ┣ 语音、图片识别 | 客户发来的语音和图片 | 自动回复的号收到语音、图片时 | 关 |
| ┣ 检索词改写 | 客户最近的话（最多 1500 字）、15 个条目标题 | 知识库超过 4 万字、按原话检索命中太少时 | 知识库小时不会发生 |
| ┣ 知识库整理、产品资料描述 | 上传的资料和产品文件的内容 | 点「开始整理」时；上传产品资料后自动生成描述 | 上传了才有 |
| ┣ 人工回复存进知识库 | 这条人工回复和它前面最多 3 条客户消息 | 管理员点时 | 点了才发 |
| ┣ AI 助手 | 提问人的名字和角色、问题、最近 6 轮问答、查到的数据：客户名字和号码、聊天记录、线索、知识条目；管理员提问时还可能有成员的名字、邮箱和模型用量 | 有人提问时 | 配好模型后所有登录的人都能用 |
| ┣ 屏蔽词「AI 扩充」 | 种子词和词表里已有的词，不带客户数据 | 管理员点时 | 点了才发 |
| ┗ **AI 发言检查** | 我方发出的文字（后台发的、文件说明、翻译前的原文、自动回复、通知号码转发的、外联开场消息、**机主在手机上发的**）；发出后查的，每条再带前面最多 4 条聊天（**包括客户的话**，每条最多 300 字）。不带发送人的名字 | 开着时：AI 翻译和自动回复审核时顺带查；其余发出后约 30 秒成批查 | 关 |
| 向量服务（可以和回复模型同一家） | 知识条目；客户最近的话（最多 1500 字）；AI 助手查知识库的关键词 | 开着、而且知识库超过 4 万字时 | 关 |
| 翻译 API（DeepL、DeepLX、Azure、谷歌、百度、火山、LibreTranslate、腾讯云） | 要翻译的话；判断语言时客户最近文字消息里最多 300 字。不带号码和客户名字 | 「设置 → 翻译」选了「翻译 API」时 | 关（默认 AI 翻译） |
| 发信服务（你配的 SMTP 服务器或 Resend） | 转人工通知：客户的名字和号码、客户最近的消息（约 500 字）、草稿；邀请和重置密码的邮件（成员的邮箱） | 转人工时（号里开了邮件通知）、邀请成员时 | 配了发信方式才有 |
| 通知号码（WhatsApp） | 和邮件通知一样的内容 | 转人工时 | 号里开了 WhatsApp 通知才有 |
| GitHub | 匿名查最新版本，对方看得到服务器的 IP | 启动 1 分钟后，之后每 6 小时 | **开**，`INKDOVE_UPDATE_CHECK=0` 关掉 |
| 你填的网址 | 抓网页 | 知识库添加网址资料时 | 填了才有 |
| 号的代理 | 这个号连 WhatsApp 的流量（WhatsApp 自己加密） | 号设了代理时 | 关 |
| 全局代理（机场节点） | 墨鸽连外网的所有请求：机场看得到目标域名、时间和流量；HTTPS 的内容看不到，填成 http:// 的接口内容看得到 | 「设置 → 代理」开着时 | 关 |
| api.ipify.org、www.gstatic.com | 测代理用的请求，不带业务数据 | 点「测试代理」、全局代理测速时 | 点了才有 |

服务商收到数据以后存多久、会不会拿去训练模型、数据放在哪个国家，**看这家服务商的 API 条款**，墨鸽管不了。选服务商时要查清楚，见「六、配置建议」。

## 三、对员工

### 哪些功能会记录员工的情况

告知员工前先对一遍这张表，没开的功能不用写。

| 功能 | 记什么、谁看得到 | 默认 |
|---|---|---|
| 会话 | 管理员看得到所有号的所有会话。每条消息记了是谁发的（哪个成员、机器人、机主手机、外联）和发送时间，撤回的消息原文也看得到。业务员只看得到分给自己的会话 | 一直有 |
| 机主手机上发的消息 | 扫码号绑定的那部手机直接发给客户的消息也存下来，标成手机发的 | 一直有（黑名单里的号码除外） |
| 会话分配记录 | 每次分给谁、谁分的、为什么分 | 一直有 |
| 数据看板里的「成员」 | 每个成员处理了多少转人工、响应时间的中位数、在后台发了多少条消息 | 只有管理员看得到 |
| 操作日志 | 谁在什么时候做了什么、改之前和改之后的值、成功还是失败、IP，还有登录成功、登录失败和退出。只能查，不能改，也不能删 | **一直开，关不掉**。默认留 365 天 |
| 屏蔽词 | 检查我方发出的文字。在墨鸽里发的，命中就不发；机主在手机上发的，只提醒。所有管理员会看到弹窗。命中记录里有原文和发送人 | 关 |
| AI 发言检查 | 把我方发出的文字交给回复模型，看有没有辱骂、威胁、歧视、骚扰、粗鲁的说法。只提醒，不拦。严重的弹窗，轻微的只进列表，管理员可以标「误报」 | 关 |
| AI 助手 | 对话在界面上只有本人看得到。操作日志会记下谁提问、重试、删对话，不记问了什么，也不记标题。数据库里存着全文，能登服务器的人看得到 | 配好模型后所有人都能用 |
| 「我的资料」、个人话术 | 起草回复时发给回复模型 | 填了才有 |

开着屏蔽词或 AI 发言检查时，业务员的输入框下面会显示「发出的消息会做合规检查」。这一行**不能代替告知**：它没说查什么、谁看、留多久，用机主手机发消息的人也看不到。

### 上线前要做的事

1. **先定目的，只开需要的功能。** 比如只想防止对客户说脏话，开屏蔽词就够了。AI 发言检查会把每条我方消息连同前面几条聊天（包括客户的话）发给模型，侵入性比屏蔽词大，开之前想清楚。
2. **书面告诉员工。** 用下面的模板，按实际开了的功能改。
3. **按当地程序办。**
   - 中国：把这些写进规章制度，按《劳动合同法》第四条的程序定：经职工代表大会或者全体职工讨论，和工会或者职工代表平等协商，定下来以后公示或者告知员工。
   - 欧盟有员工的：先做数据保护影响评估（DPIA）。德国有职工委员会（Betriebsrat）的，要先和它谈好（见第五节）。
   - 美国纽约、康涅狄格、特拉华有营业场所或员工的：按当地法律给书面通知。纽约和特拉华要员工确认收到，纽约和康涅狄格还要张贴（见第五节）。
4. **不要靠「员工同意」。** 在中国，人力资源管理所必需的处理不需要员工同意，但要告知。在欧盟，监管机构认为劳动关系里员工的同意一般不算数。所以让员工签的是「已阅读并知悉」，不是「同意」。
5. **管理员少设几个。** 管理员看得到所有聊天、操作日志和命中记录。
6. **定好保留多久。** 墨鸽不会自己删聊天和命中记录（见第一节），公司自己定期限，写进告知。
7. **AI 的结论只当线索。** AI 发言检查会误判。要处理员工，管理员先看原文和上下文，再听员工解释。
8. **只接工作号。** 员工的私人号不要接进来。扫码号绑定的手机上，只要对方不在黑名单里，私人消息也会被存下来，所以要告诉拿这部手机的人。

### 员工告知模板（中文）

方括号【】里的按实际情况填，没开的功能整条删掉。

> **关于公司 WhatsApp 工作台（墨鸽）处理员工个人信息的告知**
>
> 【公司名称】（以下称「公司」）从【日期】起使用 WhatsApp 工作台「墨鸽」，统一管理公司的 WhatsApp 号和客户沟通。系统装在【公司自己的服务器 / 租用的服务器】上，服务器在【国家或地区】。涉及你个人信息的处理如下。
>
> 1. **处理哪些信息**
>    - 账号信息：邮箱、姓名、角色、能用的号、最近登录时间；你自己填的「我的资料」（称呼、职位、电话、邮箱、介绍）和个人话术。
>    - 工作消息：你在工作台里发给客户的每条消息，还有【公司配发的手机号码】上直接发出的消息，都会记下发送人和时间。撤回的消息原文也会保留。
>    - 操作记录：你在工作台里的操作（例如改设置、分配会话、导出数据），登录成功、登录失败和退出，以及当时的 IP 地址。
>    - 工作统计：你处理的会话数、响应时间、发出的消息数。
>    - 【开了才写】合规检查记录：屏蔽词命中和 AI 发言检查发现的问题，包括原文、问题类别和说明。
> 2. **为什么处理**：和客户沟通、管理销售工作；【防止对客户使用辱骂、威胁、歧视、骚扰等不当说法】；保障系统安全、排查问题。
> 3. **怎么检查**【开了才写】
>    - 屏蔽词：消息发出前检查。在工作台里发的，命中就不发；在手机上发的，只提醒管理员。
>    - AI 发言检查：由【模型服务商名称】的 AI 模型查看你发出的文字和前面最多 4 条聊天。只提醒，不拦截。AI 会判错，检查结果只作为线索。管理员会核实原文和上下文，处理前听你的说明。
> 4. **谁能看到**：管理员【姓名或岗位】能看到所有会话、工作统计、操作记录和检查记录。业务员只看得到分给自己的会话。
> 5. **交给谁处理**：【AI 模型服务商名称，所在国家或地区】（起草回复、翻译、整理客户线索【、AI 发言检查】）；【翻译服务商】；【邮件服务商】。【涉及向境外提供的，写明境外接收方的名称、联系方式、处理目的、处理方式、信息种类，以及你向它行使权利的方式和程序。】
> 6. **保存多久**：工作消息【期限】；检查记录【期限】；操作记录【365 天】；离职后【期限】内删除。
> 7. **请注意**：工作号只用于工作。在【公司配发的手机】上发的私人消息，系统也会记录。
> 8. **你的权利**：你可以查阅、复制你的个人信息，要求更正，对处理方式提出意见。联系人：【姓名、电话或邮箱】。
>
> 本告知已按【规章制度名称 / 民主程序】制定，自【日期】起执行。
>
> 本人已阅读并知悉以上内容。（这是确认收到，不是同意。）
>
> 签名：________　日期：________

### 员工告知模板（英文）

> **Notice: How the company WhatsApp workspace (Inkdove) processes employee personal data**
>
> From 【date】, 【Company name】 ("the Company") uses the WhatsApp workspace "Inkdove" to manage the Company's WhatsApp numbers and customer conversations. The system runs on 【a server owned by / rented by】 the Company in 【country or region】. This notice explains how it processes your personal data.
>
> 1. **What we process**
>    - Account data: email, name, role, the numbers you can use, last sign-in time; the profile you fill in yourself (display name, job title, phone, email, bio) and your personal writing style.
>    - Work messages: every message you send to customers from the workspace, and messages sent directly from 【the company phone number】, are recorded with the sender and time. The original text of deleted ("unsent") messages is kept.
>    - Activity records: what you do in the workspace (for example changing settings, assigning conversations, exporting data), sign-ins, failed sign-ins and sign-outs, and the IP address used.
>    - Work statistics: conversations handled, response times, number of messages sent.
>    - 【Only if enabled】 Conduct checks: blocked-word hits and issues found by the AI message check, including the original text, the issue category and an explanation.
> 2. **Why**: to communicate with customers and manage sales work; 【to prevent abusive, threatening, discriminatory, harassing or rude language towards customers】; to keep the system secure and investigate problems.
> 3. **How messages are checked** 【only if enabled】
>    - Blocked words: checked before sending. Messages sent from the workspace are not sent if they match. Messages sent from the phone are only flagged to administrators.
>    - AI message check: an AI model from 【provider name】 reads the text you send and up to 4 earlier messages in the chat. It only raises alerts and does not block anything. The AI can be wrong. An alert is only a lead: an administrator will check the original text and context, and will hear your explanation before taking any action.
> 4. **Who can see it**: administrators (【names or roles】) can see all conversations, work statistics, activity records and check results. Other staff only see conversations assigned to them.
> 5. **Service providers**: 【AI model provider, country】 (drafting replies, translation, summarising customer leads【, AI message check】); 【translation provider】; 【email provider】. 【If data goes abroad: name and contact details of each overseas recipient, purpose, method, data categories, and how you can exercise your rights against it.】
> 6. **How long we keep it**: work messages 【period】; check results 【period】; activity records 【365 days】; after you leave, deleted within 【period】.
> 7. **Please note**: use work numbers for work only. Private messages sent from 【the company phone】 are recorded too.
> 8. **Your rights**: you can ask to see and get a copy of your personal data, ask for corrections, and object to how it is processed. Contact: 【name, phone or email】.
>
> I confirm that I have read this notice. (This confirms receipt. It is not consent.)
>
> Signature: ________　Date: ________

### 开屏蔽词、AI 发言检查前对一遍

- [ ] 员工已经收到书面告知并签收。告知里写了开哪一项、查什么、谁看、留多久。
- [ ] 当地程序走完了：中国按规章制度程序；欧盟做完 DPIA，德国和职工委员会谈好；美国纽约、康涅狄格、特拉华按当地要求通知。
- [ ] 欧盟有员工、又要开 AI 发言检查的：AI 法案的高风险义务 2027-12-02 起适用，投入使用前要告知员工和员工代表（见第五节）。
- [ ] AI 发言检查用的模型服务商，看过它的 API 条款：数据存多久、拿不拿去训练、服务器在哪个国家。服务器在中国、模型在境外的，出境路径定好了（见第五节）。
- [ ] 定好谁处理提醒、怎么核实、员工怎么申辩。判错的点「误报」。
- [ ] 拿机主手机的人知道：手机上发的消息也会被查。
- [ ] 操作日志一直开着，关不掉。用 `INKDOVE_AUDIT_RETENTION_DAYS` 设保留天数（默认 365，范围 1–36500），和告知里写的一致。日志里有 IP。

## 四、对客户

### 告诉客户：隐私说明片段

墨鸽没有自动给客户发隐私说明的功能。把下面的文字放进公司网站的隐私政策，在 WhatsApp 商业资料的简介里放链接；外联的开场消息里也可以写一句。客户多在海外，英文版更常用。

**英文**

> **How we handle your information on WhatsApp**
>
> 【Company name】 (【address】, 【contact email】) uses a business messaging system to manage our WhatsApp conversations with customers.
>
> - **What we keep**: your WhatsApp number and profile name, the messages and files you send us, our replies, and details you give us (such as your name, company, country, email, and the products and quantities you are interested in).
> - **Why**: to answer your enquiries, prepare quotes and orders, and follow up on our business with you. 【If GDPR applies, state the legal basis, for example: steps you ask us to take before a contract; our legitimate interest in managing business relationships.】
> - **Automated replies and AI**: 【Some replies on this number are generated automatically by an AI system.】 We use AI services from 【provider, country】 to 【draft replies, translate messages and summarise enquiries】.
> - **Who receives it**: WhatsApp/Meta, which carries the messages; 【AI provider】; 【translation provider】; 【email provider】. Some of them are in other countries, including 【countries】. 【Transfer safeguards, if required.】
> - **How long**: 【retention period】.
> - **Your choices**: you can ask for a copy of your information, ask us to correct or delete it, or tell us to stop contacting you at any time. Reply 【"STOP"】 on WhatsApp or write to 【email】. We will respond within 【number】 days.

**中文**

> **我们如何处理您在 WhatsApp 上的信息**
>
> 【公司名称】（【地址】，【联系邮箱】）用一套企业消息系统管理和客户的 WhatsApp 沟通。
>
> - **保存什么**：您的 WhatsApp 号码和昵称、您发来的消息和文件、我们的回复，以及您告诉我们的信息（例如姓名、公司、国家、邮箱、感兴趣的产品和数量）。
> - **为什么**：回答您的询问、报价和处理订单、跟进和您的业务。
> - **自动回复和 AI**：【本号的部分回复由 AI 自动生成。】我们使用【服务商、所在国家】的 AI 服务【起草回复、翻译消息、整理询盘】。
> - **交给谁**：传递消息的 WhatsApp/Meta；【AI 服务商】；【翻译服务商】；【邮件服务商】。其中有的在【国家】。
> - **保存多久**：【期限】。
> - **您的选择**：您可以要求获取您的信息副本、更正或删除，也可以随时让我们不再联系您：在 WhatsApp 上回复【「STOP」】，或写信到【邮箱】。我们会在【天数】天内处理。

写进去之前，先确认你真能做到上面答应的事。墨鸽**不会自动识别「STOP」**：自动回复的号上，模型判出客户明确拒绝时会停掉这个会话的机器人；人工回复的号上什么都不会发生，要有人看到后手动处理（见下面「外联」）。

### AI 自动回复：要告诉客户是 AI

墨鸽现在是这样做的：

- 自动回复按设计**不说自己是 AI，也不说自己是真人**。回复里出现这类说法会被拦下、转人工。
- 客户问「你是不是机器人」「你是什么模型」时，机器人不回答，转人工。
- 「设置 → 回复」里的「回复像真人」默认开着：先标已读、显示正在输入、按字数等几秒再发。
- 墨鸽没有替你告诉客户「这是 AI」的功能。

而欧盟 AI 法案、美国犹他州和加州的法律、WhatsApp 的商业消息政策，都朝「让客户知道」的方向要求（见第五节）。所以用了自动回复的号，自己补上告知：

1. 在 WhatsApp 商业资料的简介里写明「本号部分回复由 AI 自动生成」，网站隐私政策里也写上。
2. 客户问是不是机器人，墨鸽会转给业务员。**接手的人要如实说前面的回复是 AI 写的。** 把这条写进业务员的操作规范。
3. 欧盟、美国客户多的号，考虑关掉「回复像真人」。人设（persona）不要起真人的名字。设置页输入框里「客服小王」只是语气示例，不是建议。
4. 外联开场消息是你自己写的，墨鸽不会改它：发出前只查屏蔽词，开了 AI 发言检查的，发出后也查，但只提醒。可以在开场消息里写明。

### 外联：先有同意，随时能退出

墨鸽现在是这样做的：

- 上传的号码文件里**每个号码都存下来**（格式不对的、重复的也存），直到删掉这个外联任务。
- 扫码号发之前，会去 WhatsApp 查这个号码有没有 WhatsApp。
- 每个号码只发一条。聊过的、发过的、在黑名单里的、是通知号码的，自动跳过。只要这个号码在任何一个号上有会话，以后的外联任务都会跳过它。
- 只有**自动回复的号**会判断「客户明确拒绝」。判出来以后，这个会话的机器人暂停，不再自动发消息，也不通知业务员。人工回复的号不判。
- 黑名单是按号设的，没有全公司统一的「勿扰名单」。业务员手动发消息不受外联规则限制。
- 墨鸽**不记录每个号码的同意是从哪来的**。功能说明里说上传「已经同意被联系的客户」，这要靠你自己保证。

你要做的：

1. **只上传有同意记录的号码。** 谁、什么时候、怎么同意的、同意接收什么，这些记录存在墨鸽以外的地方，出了问题拿得出来。
2. **开场消息里写清楚**公司名、为什么联系，以及怎么退出（例如「回复 STOP 不再接收」）。
3. **有人说不要再联系：** 在号详情里把他的号码加进黑名单，最好每个号都加。加进黑名单后，他之后发来的消息墨鸽不存、机器人不回，在墨鸽里看不到。如果他以后又想联系你，要有人从名单里把他删掉。
4. 告诉业务员：客户说过不要再联系的，手动也不要再发。

### 客户要查、改、删自己的数据

| 客户要求 | 墨鸽里能做的 | 做不到的 |
|---|---|---|
| 看我们存了什么 | 在会话页看聊天记录，在线索页看线索。管理员能把**所有**线索导出成 CSV | 没有按客户导出聊天记录的功能。要给副本，只能截图或者从数据库里查 |
| 更正 | 线索可以改 | 聊天记录不能改（本来也不该改） |
| 删除 | 线索可以删，但客户再发消息会重新提取一条。外联任务能删（只能删草稿、已取消、已完成的） | **会话、消息、图片和文件、屏蔽词和 AI 检查的命中记录，界面上都删不掉。** 删掉一个号，它的会话和消息也照样留着 |
| 别再联系我 | 把号码加进黑名单，之后不存、不回 | 已经存下来的不会因此删掉 |

真要删一个客户的数据，只能由能登服务器的人手动处理，墨鸽没有现成的工具：

1. 停掉服务，先备份。
2. 在 SQLite 里删这个客户的会话和相关的行：`conversations`、`messages`（译文也在里面）、`leads`、`lead_stage_history`、`campaign_recipients`、`blockword_hits`、`conversation_assignments`、`handoffs`、`decisions`、`gaps` 和 `gap_hits`、`notice_messages`。表结构见 `server/src/db.js`。
3. 删掉 `./data/media/` 里这个客户发来的文件。
4. 想想还有哪些地方有副本：`./data/backups/` 里的旧备份；`./waha-sessions`；扫码号绑定的手机上的 WhatsApp；Docker 日志；知识库里从这段聊天改写来的条目；AI 助手的对话；已经发给模型、翻译、邮件服务商的内容（按它们的条款处理）。

欧盟客户按 GDPR 提要求的，一般要在一个月内答复（GDPR 第十二条第三款）。

## 五、各地法规要点

哪些法律管得到你，看三件事：公司和员工在哪，客户在哪，服务器和服务商在哪。下面按地区列。拿不准的直接写了「不确定」；没核实原文的写了「未核实」。

### 中国

**谁适用。** 在中国境内处理个人信息，不管是哪国人的，都适用《个人信息保护法》（第三条第一款）。公司和服务器在国内，客户在海外，也一样适用。

**员工**

- **法律依据：** 第十三条第一款第二项，「按照依法制定的劳动规章制度和依法签订的集体合同实施人力资源管理所必需」。监控聊天、屏蔽词、AI 发言检查要写进规章制度，规章制度按《劳动合同法》第四条的程序定。
- **不需要同意，但要告知。** 第十三条第二款：有第一款第二至七项情形的，不需要取得个人同意。告知还是要做，内容按第十七条（处理者名称和联系方式、目的、方式、信息种类、保存期限、怎么行使权利）。国家网信办 2026-07-24 的答问也是这个意思。
- **自动化决策（第二十四条）：** AI 发言检查只提醒，由管理员决定，一般不算「仅通过自动化决策的方式作出决定」。前提是真的有人核实。这一点有一定不确定性。
- **影响评估（第五十五条）：** 下面这些情况要事前做个人信息保护影响评估，报告和处理记录至少留 3 年（第五十六条）：处理敏感个人信息；自动化决策；委托处理、向其他处理者提供；向境外提供。用了外部 AI 模型服务，至少碰到「委托处理或向其他处理者提供」这一条；模型在境外，还碰到「向境外提供」。

**客户**

- **法律依据：** 客户以个人身份买货的，可以用「为订立、履行个人作为一方当事人的合同所必需」（第十三条第一款第二项）。代表公司来谈的联系人，本人不是合同一方，这一项用不用得上有争议。稳妥的做法是告知清楚并取得同意。
- **交给 AI 模型、翻译服务：** 是委托处理（第二十一条），还是向其他处理者提供（第二十三条，要单独同意），看服务商的条款。服务商只按你的要求处理、不拿去自己用的，更接近委托；条款允许它拿数据训练或者另作他用的，更接近提供。**不确定。**
- **敏感个人信息：** 客户在聊天里发的银行账户（金融账户）、护照这类身份证件，一般属于敏感个人信息（第二十八条），要求更严。墨鸽会照样存下来，文字部分还会随聊天记录发给模型（比如线索提取）。

**向境外提供**

- **什么算出境：** 服务器在境内，把聊天内容发给境外的模型、翻译、邮件服务，就是向境外提供。用国内的服务商（例如百度、火山引擎、腾讯云）不算出境，但仍然是委托处理或向其他处理者提供（见上）。
- **基本要求：** 第三十八条，要满足安全评估、个人信息保护认证、标准合同等条件之一。第三十九条，要告知境外接收方的名称、联系方式、处理目的、处理方式、信息种类和行使权利的方式，并取得单独同意。依第十三条第二款在非同意情形下处理的，一般理解也不需要这里的单独同意，但没有明文，稳妥起见能取得就取得。
- **《促进和规范数据跨境流动规定》**（2024-03-22 施行）规定了几种可以免于安全评估、标准合同、认证的情况：
  - 第四条：在境外收集和产生的个人信息，传到境内处理后再向境外提供，处理中没有引入境内个人信息或重要数据。海外客户的聊天看起来像，但墨鸽里同时有业务员的信息（名字、发的话、AI 发言检查的结果），「境外收集」怎么认定也有争议。**不建议只靠这一条。**
  - 第五条第一项：为订立、履行个人作为一方当事人的合同，确需向境外提供。对方是代表公司的联系人时，用不用得上有争议。
  - 第五条第二项：按依法制定的劳动规章制度和集体合同实施跨境人力资源管理，确需向境外提供员工个人信息。AI 发言检查把员工的话发到境外模型，算不算这一项，没有明确说法。
  - 第五条第四项：关键信息基础设施运营者以外的处理者，当年 1 月 1 日起累计向境外提供不满 10 万人的个人信息（不含敏感个人信息）。**多数外贸公司实际能用的是这一条。**
  - 敏感个人信息不在第五条第四项里。累计不满 1 万人的敏感个人信息，或者 10 万到 100 万人的个人信息，要订标准合同或者通过认证（第八条）。100 万人以上，或者 1 万人以上的敏感个人信息，要申报安全评估（第七条）。
  - 免了上面三种手续，告知、单独同意、影响评估这些义务照样要做（第十条）。
- 《个人信息出境认证办法》2026-01-01 起施行，走认证路线的看这个。

**生成式 AI 的规定**

- 《生成式人工智能服务管理暂行办法》管的是向境内公众提供生成式 AI 服务（第二条）。企业自己用、没有向境内公众提供服务的，不适用。自动回复给海外客户的，一般不适用；也给国内客户用自动回复的，要另外判断。
- 《人工智能生成合成内容标识办法》（2025-09-01 施行）主要管提供服务的和传播平台。企业只是自己用，一般没有标识义务，但把握不大。

**网络线路**

「设置 → 代理」的全局代理连的是机场节点。工信部 2017 年的通知（工信部信管函〔2017〕32 号）要求，未经电信主管部门批准，不得自行建立或租用专线（含 VPN）等其他信道开展跨境经营活动。工信部的答问说，外贸企业办公自用需要跨境联网的，可以向依法设有国际通信出入口局的电信业务经营者租用。用什么线路连 WhatsApp 和境外服务，请按这些规定自己判断。本指南不提供绕开规定的办法。

**其他**

- 《网络数据安全管理条例》（2025-01-01 施行）对个人信息处理规则、向境外提供等有更细的要求。
- 《个人信息保护合规审计管理办法》（2025-05-01 施行）要求定期做合规审计。处理超过 1000 万人个人信息的，至少每两年一次。

### 欧盟：GDPR

**管不管得到你**

- 在欧盟有分公司、办事处或员工的，这部分直接适用（第三条第一款）。
- 公司只在中国的，如果向欧盟境内的人提供商品或服务，也适用（第三条第二款第一项）。看的是你有没有面向欧盟市场，例如用欧盟语言或欧元报价、参加欧盟的展会、主动向欧盟号码外联。只是被动接欧盟客户的询价，适用的可能性小一些。B2B 怎么算，EDPB 的指南没有明确说法。对方虽然代表公司，也是自然人，同样受保护。
- 适用第三条第二款的，要书面指定一名欧盟代表（第二十七条）。只是「偶尔」处理的可以免，但持续的销售聊天一般不算偶尔。

**客户**

- **法律依据：** 客户以个人身份买货的，可以用「履行合同或者应对方要求在签合同前采取步骤」（第六条第一款 b 项）。代表公司来谈的联系人，一般用合法利益（f 项），要事先做并记录权衡，并告诉对方你的合法利益是什么（EDPB 第 1/2024 号指南，目前只有征求意见版）。
- **外联：** 用 WhatsApp 给个人发营销消息，很可能被当成《电子隐私指令》（2002/58/EC）第十三条说的「电子邮件」，要事先同意，不能用合法利益（EDPB 第 1/2024 号指南第 114 段）。没有判例直接说到 WhatsApp，但这个定义和 EDPB 的说法都盖得住它。发给公司的，各国规定不同。德国《反不正当竞争法》（UWG）第七条第二款第二项对公司也要求事先明确同意。
- **告知：** 第十三条、第十四条。用第四节的模板。
- **反对营销：** 对方随时可以反对，不用说理由，反对后就不能再用于营销（第二十一条第二款、第三款）。最晚在第一次联系时，就要明确告诉对方有这个权利（第二十一条第四款）。
- **查、改、删：** 一般一个月内答复（第十二条第三款）。墨鸽能做什么，见第四节。
- **保存期限：** 不能无限期地留（第五条第一款 e 项）。墨鸽默认一直留，要自己定期限、自己清。

**在欧盟的员工**

- **不要靠同意。** 劳动关系里员工的同意一般不算自由作出（EDPB 第 05/2020 号同意指南第 21 段；第 29 条工作组第 2/2017 号意见 WP249，EDPB 仍在引用）。一般靠合法利益，监控要必要、相称、尽量少侵入。比如能用屏蔽词解决的，就不开 AI 发言检查。
- **各国的具体规定（第八十八条）：** 德国《联邦数据保护法》（BDSG）第 26 条第 1 款第 1 句，在欧盟法院 C-34/21 案判决后，很可能不能单独作为依据（巴登-符腾堡州数据保护机构的看法，法院没有最终定论）。德国还没有单独的员工数据保护法。
- **德国职工委员会：** 《企业组织法》（BetrVG）第 87 条第 1 款第 6 项，引入和使用用来监控员工行为或绩效的技术设施，职工委员会有共同决定权。联邦劳动法院的判例认为，只要设施客观上适合监控就算，不看雇主的本意。管理员看聊天、操作日志、AI 发言检查，都很可能算。有职工委员会的，先谈成企业协议再开。
- **影响评估（第三十五条）：** 第 29 条工作组的 DPIA 指南（WP248 rev.01，EDPB 已认可）列了九条标准，一般满足两条就要做。系统性地查员工的通信，至少满足「系统性监控」「弱势的数据主体（员工）」「高度私密的数据（通信）」三条。**很可能要做。**
- **自动化决策（第二十二条）：** AI 发言检查只提醒，由人决定，一般不算「完全基于自动化处理的决定」。前提是人真的看了原文再决定，不是照单全收。

**服务商和数据出欧盟**

- 模型、翻译、邮件服务商替你处理数据，是处理者，要有符合第二十八条第三款的合同（数据处理协议）。看清楚数据存多久、拿不拿去训练、用了哪些分包商。条款允许服务商拿数据另作他用的，那一部分它可能就不算你的处理者了。
- 扫码号是把墨鸽当成一台关联设备连上 WhatsApp。Meta 说自己在 Cloud API 里是处理者，扫码号没有这种安排。
- 欧盟客户直接发消息给在中国的你，一般不算第五章说的「传输」，但 GDPR 照样管（EDPB 第 05/2021 号指南）。你再把聊天发给另一个国家的模型服务商，就是传输了。
- 传输用什么工具：
  - 到中国：欧盟没有对中国作出充分性决定，要用标准合同条款（SCC）等，再做传输影响评估。
  - 欧盟委员会的 SCC 问答说，2021 版 SCC 不适用于接收方本身就受 GDPR 管的情况，新的一套还在准备，本指南核对时没有找到已经通过的版本。如果你和服务商都因为第三条第二款受 GDPR 管，目前没有现成的标准工具。**这是没解决的空白，问律师。**
  - 到美国：欧美数据隐私框架（DPF）还有效，但不稳。欧盟法院的 Latombe 上诉案（C-703/25 P）还在审。美国最高法院 2026-06-29 判了 Trump v. Slaughter 案以后，EDPB 在 2026-07-31 写信请欧盟委员会评估这件事对 DPF 的影响。随时可能变。服务器不在欧盟时 DPF 用不用得上，本指南没有核实。

### 欧盟：AI 法案

- AI 法案是 Regulation (EU) 2024/1689。2026 年的数字综合条例 Regulation (EU) 2026/1744 改了它的时间表，2026-07-24 在公报上发布，2026-07-27 生效。

**AI 发言检查（只在欧盟有员工时才要细看）**

- 附件三第 4 点 (b) 项把「监控和评估工作关系中的人的表现和行为」的 AI 列为高风险。用 AI 发言检查查在欧盟工作的员工，很可能落在这一项里。第六条第三款有例外，但对人做画像（profiling）的一律算高风险。
- 附件三的高风险义务，现在 **2027-12-02** 起适用（原来是 2026-08-02）。到时部署者要做到（第二十六条）：按说明使用；指定有能力的人做人工监督；系统自动生成的日志至少留 6 个月；**投入使用前，告知员工代表和受影响的员工**。
- 员工都在中国的，一般管不到。AI 法案管的是在欧盟投放或使用的 AI，以及输出在欧盟使用的 AI（第二条第一款）。有不确定性。
- 墨鸽是开源的，但开源豁免（第二条第十二款）不包括高风险系统。公司自己部署、自己用，可能被看成「提供者」兼「部署者」。没有定论。
- AI 发言检查只看文字，不用生物特征数据，不属于第五条禁止的「工作场所情绪识别」（情绪识别系统的定义以生物特征数据为基础，见第三条第三十九项）。

**自动回复**

- 第五十条第一款：直接和人交流的 AI 系统，设计上要让人知道自己在和 AI 打交道，一看就明白的除外。**2026-08-02 起适用**，这次没有推迟。
- 这条义务在提供者身上。公司用自己的号跑墨鸽的自动回复，算不算提供者，不确定。
- 墨鸽的自动回复按设计不说自己是 AI，和这条的方向相反。对欧盟客户用自动回复的，按第四节的办法告知。

**AI 素养（第四条）** 已经适用。数字综合条例改过这一条，本指南没有核实改后的原文。

### 美国

先看管不管得到你。纽约、康涅狄格、特拉华的员工监控通知法，看你在当地有没有营业场所（康涅狄格看监控是不是发生在雇主的场所）。加州 CCPA 只管在加州做生意、达到规模门槛的企业。公司和员工都不在美国的，这些一般管不到。管得到美国客户的，是下面的机器人告知法和电话营销类的法律。

**员工监控通知（有美国员工时）**

- **纽约** Civil Rights Law §52-c（编号相同的第二个条文）：在纽约有营业场所的雇主，监控员工的电话、邮件或上网，要在入职时给书面或电子通知，员工书面或电子确认，并在显眼处张贴。州检察长执法，罚款最高 500 / 1,000 / 3,000 美元（第一次、第二次、第三次及以后）。
- **康涅狄格** §31-48d，2026 年被 Public Act 26-73 替换，**2026-10-01 起施行**：事先书面告知监控的类型，以及监控发生的具体地点，并张贴。2026-10-01 及以后入职的，上岗前还要给一份浅白的书面说明，写明哪些行为是禁止的、可能在不事先通知的情况下被监控。劳工专员可以罚款，最高 500 / 1,000 / 3,000 美元。
- **特拉华** 第 19 编 §705：二选一。员工每天用公司邮箱或网络时给一次电子提示；或者给一次书面或电子通知，并由员工确认。每次违规罚 100 美元。
- **加州 CCPA**：员工数据和 B2B 联系人数据的豁免，2023-01-01 已经失效。只管在加州做生意、而且达到门槛的企业，例如年营收超过 26,625,000 美元（2025 年调整后的数）。管得到的，收集时要告知。加州隐私保护局 2026-01-01 起施行的新规，要求对系统性观察员工、推断其工作表现或行为的自动化处理做风险评估。新规的细节本指南没有逐条核实。

**机器人告知（美国客户）**

- **加州** Business and Professions Code §17940–17943：在网上用机器人和加州的人交流，故意在「是不是机器人」上误导对方来促成交易，是违法的。清楚告知是机器人，就不担责。WhatsApp 一对一聊天算不算这里说的「网上」，没有判例。条文是从 FindLaw 读的，加州官方网站没打开。
- **犹他** Utah Code §13-75-103（2025-05-07 起）：在消费交易里用生成式 AI 和人交流，对方清楚地问是不是 AI 时，要告诉他是 AI、不是真人。一开始就清楚告知、交流中一直告知的，有安全港（§13-75-104）。墨鸽遇到这种问题会转人工，**接手的人如实回答才算合规**。
- **缅因**：2025 年通过的法律（LD 1727）要求，在交易里用 AI 聊天机器人、可能让人以为在和真人说话时，要告诉对方不是真人。只读了官方摘要，没核实条文。

**外联和电话营销法**

- 联邦 TCPA（47 U.S.C. §227）限制用自动拨号设备给手机打电话，FCC 认为短信也算。最高法院在 Facebook v. Duguid（2021）案中认为，自动拨号设备要能随机或按顺序生成号码，按上传的名单发不算。
- 没有找到把 TCPA 用到 WhatsApp 上的判决。佛罗里达、俄克拉何马等州有自己的电话营销法，覆盖「短信」，WhatsApp 算不算没有定论。
- 实际风险更大的是被 WhatsApp 封号（见下一节）。给美国号码外联前，问律师。

### WhatsApp 和 Meta 的规则

**扫码号不是官方接口**

- WhatsApp Business App 条款（2026-09-23 生效）第 5 条规定，未经 WhatsApp 事先书面同意，不得开发或使用和 Business App 服务交互的应用（(g) 项），也不得抓取、提取数据（(f) 项）。违反的，WhatsApp 可以限制、限速、停用或终止账号。
- WhatsApp 的普通服务条款（欧洲经济区以外的版本）也禁止群发、自动发消息、自动拨号，以及未经授权的非个人使用。
- 墨鸽的扫码号经 WAHA 连 WhatsApp，就是这种第三方应用。所以**用扫码号本身就有被封号的风险**，和发什么内容无关。号一旦被封，号上的客户联系就断了。重要的号用 Meta Cloud API。

**Meta Cloud API 是官方路线**

- Meta 说自己在 Cloud API 里是处理者，消息最多留 30 天。
- 客户发来消息后的 24 小时内可以自由回复，超过 24 小时只能发审核通过的模板。墨鸽的 Meta 号外联发的就是模板。

**WhatsApp 商业消息政策**（2026-09-23 更新，Business App 和 Business Platform 都适用）

- 只能联系给过你手机号或用户名、并且同意接收你消息的人。
- 对方在 WhatsApp 上或者别的地方提出屏蔽、停止、退出的，都要照办。
- 政策里 Business Platform 的部分说，24 小时窗口内可以用自动化回复，同时要有及时、清楚、直接的转人工路径。
- 政策里还有禁止的内容和受管制行业的限制，开号前看一遍。

**Meta 号用哪家 AI 服务商**

- Meta 的 WhatsApp Business Platform 条款（2026-09-23 修改）第 4.7 条说，AI 服务商当你的方案提供者时，不能让平台数据被用来训练或改进 AI 模型，只给你专用的微调除外。模型 API 服务商算不算「方案提供者」，条款没有明说。稳妥起见，给 Meta 号配模型时，选不拿数据训练的服务商和设置。
- 同一条禁止以通用 AI 助手为主要功能的服务使用这个平台。只为自己业务服务的客服机器人不在此列。

### 其他地区（未详细分析）

下面只列名字，没有逐条核实，客户集中在这些地方的，请找当地律师。

- 英国：UK GDPR 和 PECR（电子营销规则），大体和欧盟相近。
- 巴西：《通用数据保护法》（LGPD，第 13.709/2018 号法律）。
- 印度：《数字个人数据保护法》（DPDP Act 2023），配套规则分阶段施行。
- 沙特：《个人数据保护法》（PDPL），由沙特数据和人工智能局（SDAIA）主管。
- 阿联酋：联邦个人数据保护法（2021 年第 45 号联邦法令）。
- 俄罗斯：第 152-FZ 号《个人数据法》，对俄罗斯公民的个人数据有境内存储要求。
- 土耳其：《个人数据保护法》（KVKK，第 6698 号法律）。

## 六、配置建议

**上线前**

1. 重要的号用 Meta Cloud API。扫码号有封号风险（见第五节）。
2. 扫码之前，先在号详情里设好回复范围。黑名单里的号码不存，白名单模式只存名单里的号码；导入手机里已有的聊天也按这个筛。员工的私人号不要接进来。
3. 管理员少设几个。
4. 对外用 HTTPS，见 [deploy.md](deploy.md)。

**AI 和服务商**

5. 「设置 → AI 模型」：选服务商前看它的 API 条款：数据存多久、拿不拿去训练、服务器在哪个国家、能不能签数据处理协议。服务器在中国、模型在境外的，先按第五节定好出境路径。Meta 号还要满足 Meta 条款第 4.7 条。
6. 「设置 → 客户线索」：「自动提取客户线索」**默认开**，配好模型就会把会话最近 50 条消息发给模型。用不上就关掉。
7. 「设置 → 翻译」：默认用回复模型翻译。选「翻译 API」时，只发要翻译的那段话（判断语言时最多带 300 字客户的话）。选一家条款查清楚的。
8. 「设置 → 语音和图片」「设置 → 向量检索」：默认关。开了语音和图片，自动回复的号收到的语音、图片会发给模型；开了向量检索，知识条目和客户最近的话会发给向量服务。
9. 用自动回复的号：在 WhatsApp 商业资料里写明部分回复由 AI 生成；考虑关掉「设置 → 回复」里的「回复像真人」；人设不要起真人的名字；告诉业务员，客户问是不是机器人时要如实说。

**员工**

10. 「设置 → 屏蔽词」：屏蔽词和 AI 发言检查都默认关。先按第三节告知员工，再开。
11. 设 `INKDOVE_AUDIT_RETENTION_DAYS`，和告知里写的保留天数一致。

**外联**

12. 只上传有同意记录的号码。开场消息里写公司名和退出方法。有人退出，就把他加进黑名单，最好每个号都加。

**保存和删除**

13. 定好各类数据留多久。聊天、客户发来的文件、命中记录，墨鸽不会自动删，界面上也删不掉。到期要清的，由能登服务器的人停服后处理数据库和 `./data/media`，旧备份也要一起处理。
14. `./data` 和 `./waha-sessions` 的备份要加密，限制谁能拿到。在线更新会在 `./data/backups/` 留最近 5 份数据库备份，库里删掉的数据，这些备份里还有。
15. 应用日志里个别警告带着客户的 chat id（里面是手机号），而 `docker-compose.yml` 没配日志轮转。可以在 compose 的每个服务下加 `logging`（`driver: json-file`，`options` 里设 `max-size` 和 `max-file`），或者在 Docker 的全局配置里设。
16. 不需要在线更新的，设 `INKDOVE_UPDATE_CHECK=0`，墨鸽就不再访问 GitHub。
17. 「设置 → 代理」的全局代理默认关。开之前看第五节中国部分关于网络线路的说明。模型、翻译接口填 `https://` 的地址，机场节点就看不到内容。

## 七、参考链接

核对日期都是 2026-10-13。标「转载」的是官方网站打不开时读的副本，以官方原文为准。

**中国**

- 《个人信息保护法》：<https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm>
- 国家网信办 2026-07-24 答问：<https://www.cac.gov.cn/2026-07/24/c_1786638883119336.htm>
- 《促进和规范数据跨境流动规定》：<https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm>
- 《个人信息出境认证办法》：<https://www.cac.gov.cn/2025-10/17/c_1762449728720008.htm>
- 《网络数据安全管理条例》：<https://www.gov.cn/zhengce/content/202409/content_6977766.htm>
- 《个人信息保护合规审计管理办法》：<https://www.cac.gov.cn/2025-02/14/c_1741233507681519.htm>
- 《生成式人工智能服务管理暂行办法》：<https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm>
- 《人工智能生成合成内容标识办法》：<https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm>
- 《劳动合同法》（国家税务总局法规库转载）：<https://fgk.chinatax.gov.cn/zcfgk/c100009/c5193025/content.html>
- 工信部关于清理规范互联网网络接入服务市场的通知：<https://www.cac.gov.cn/2017-01/23/c_1120366809.htm>
- 工信部信息通信管理局负责人答记者问：<https://www.cac.gov.cn/2017-01/26/c_1120381529.htm>

**欧盟**

- GDPR：<https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32016R0679>
- AI 法案 Regulation (EU) 2024/1689：<https://eur-lex.europa.eu/eli/reg/2024/1689/oj>
- 数字综合条例 Regulation (EU) 2026/1744：<https://eur-lex.europa.eu/eli/reg/2026/1744/oj?locale=en>
- 电子隐私指令（合并文本）：<https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219>
- EDPB 第 1/2024 号合法利益指南（征求意见版）：<https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202401_legitimateinterest_en.pdf>
- EDPB 第 05/2020 号同意指南：<https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en>
- WP249（工作中的数据处理）：<https://ec.europa.eu/newsroom/article29/items/610169>
- WP248 rev.01（DPIA）：<https://ec.europa.eu/newsroom/article29/items/611236>
- EDPB 第 05/2021 号指南（第三条和第五章的关系）：<https://edpb.europa.eu/system/files/2023-02/edpb_guidelines_05-2021_interplay_between_the_application_of_art3-chapter_v_of_the_gdpr_v2_en_0.pdf>
- EDPB 指南列表（含第 3/2018 号地域范围指南）：<https://www.edpb.europa.eu/our-work-tools/general-guidance/guidelines-recommendations-best-practices_en>
- 欧盟委员会 SCC 问答：<https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/new-standard-contractual-clauses-questions-and-answers-overview_en>
- EDPB 2026-07-31 就 Trump v. Slaughter 致欧盟委员会的信：<https://www.edpb.europa.eu/system/files/2026-08/edpb_letter_20260731_us_supremecourt_judgment_trump_v_slaughter_en.pdf>
- Latombe 上诉案 C-703/25 P 公告：<https://eur-lex.europa.eu/eli/C/2025/6610/oj/eng>
- 德国 BDSG 第 26 条：<https://www.gesetze-im-internet.de/bdsg_2018/__26.html>
- 德国 BetrVG 第 87 条：<https://www.gesetze-im-internet.de/betrvg/__87.html>
- 德国 UWG 第 7 条：<https://www.gesetze-im-internet.de/uwg_2004/__7.html>
- 巴登-符腾堡州数据保护机构关于员工数据法律依据的问答：<https://www.baden-wuerttemberg.datenschutz.de/faq-rechtsgrundlagen-bei-beschaeftigtendaten/>

**美国**

- 纽约 Civil Rights Law §52-c：<https://www.nysenate.gov/legislation/laws/CVR/52-C*2>
- 康涅狄格 Public Act 26-73：<https://prdext3.cga.ct.gov/2026/ACT/PA/PDF/2026PA-00073-R00SB-00472-PA.PDF>；律所解读：<https://www.workplaceprivacyreport.com/2026/09/articles/monitoring-2/deadline-imminent-for-connecticuts-expanded-electronic-monitoring-law/>
- 特拉华第 19 编 §705：<https://delcode.delaware.gov/title19/c007/sc01/index.html>
- 加州 B&P §17941（FindLaw 转载）：<https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17941/>
- CCPA 门槛调整：<https://www.cppa.ca.gov/regulations/cpi_adjustment.html>；2026 年新规：<https://cppa.ca.gov/regulations/ccpa_updates.html>
- 犹他 SB 226（2025）：<https://le.utah.gov/Session/2025/bills/enrolled/SB0226.pdf>
- 缅因 LD 1727 官方摘要：<https://lldc.mainelegislature.org/Open/Sums/132/sum132-LD-1727.pdf>
- 47 U.S.C. §227（康奈尔转载）：<https://www.law.cornell.edu/uscode/text/47/227>
- Facebook v. Duguid（康奈尔转载）：<https://www.law.cornell.edu/supremecourt/text/19-511>

**WhatsApp 和 Meta**

- WhatsApp 服务条款：<https://www.whatsapp.com/legal/terms-of-service>（欧洲经济区：<https://www.whatsapp.com/legal/terms-of-service-eea>）
- WhatsApp Business App 条款：<https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-App>
- WhatsApp 商业消息政策：<https://whatsappbusiness.com/policy/>
- Meta 的 WhatsApp Business Platform 条款：<https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform>
- Cloud API 的数据隐私说明：<https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security>
- Cloud API 获取同意的说明：<https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in>
