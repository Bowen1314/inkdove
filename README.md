<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" width="128" alt="墨鸽 Inkdove">
</picture>

# 墨鸽 Inkdove

**面向外贸团队的 WhatsApp 与 LINE 工作台：公司号码统一对外，客户分配给业务员；需要时由 AI 通过 RAG（全文检索 + 内置向量库）从知识库检索依据、起草回复，经人工确认后发送。**

[![Release](https://img.shields.io/github/v/release/Bowen1314/inkdove)](https://github.com/Bowen1314/inkdove/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fbowen1314%2Finkdove-2496ED?logo=docker&logoColor=white)](https://github.com/Bowen1314/inkdove/pkgs/container/inkdove)
[![Node >= 20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Release workflow](https://img.shields.io/github/actions/workflow/status/Bowen1314/inkdove/release.yml?label=release%20build)](https://github.com/Bowen1314/inkdove/actions/workflows/release.yml)

中文 | [English](README_EN.md)

[快速开始](#快速开始) · [功能](#功能) · [截图](#截图) · [文档](#文档)

</div>

<p align="center">
  <img src="assets/screenshots/chat-suggest.png" width="900" alt="会话页：点击「推荐回复」后，AI 依据知识库起草回复，业务员修改后发送">
</p>

## ⚠️ 使用前须知

- **扫码接入存在封号风险。** 扫码接入（WAHA）基于 WhatsApp 网页版的非官方协议，号码可能被限制或封禁。重要号码建议使用 Meta 官方 Cloud API，详见[三种接入方式的区别和风险](docs/channels-and-security.md#三种接入方式的区别和风险)。
- **请勿用于骚扰性群发。** 不得向未同意接收的人发送营销消息，并须遵守 WhatsApp 的服务条款和当地法律。
- **AI 起草的内容由发送人负责。** AI 可能给出错误的价格、交期或承诺，发送前请务必核对。

## 适用场景

**适用于：**

- 外贸团队多人共用公司的 WhatsApp 号码对外沟通，不使用个人号码；
- 客户资源需要留在公司：业务员离职时，其客户可一键转交他人，聊天记录完整保留；
- 希望新员工也按照公司统一的产品资料、价格和话术回复客户；
- 管理者需要查看全部聊天并随时接手，及时发现对客户的不当言论，所有设置变更均有记录可查。

**不适用于：**

- 群发营销或获客拉新：外联功能对每个号码只发送一条开场消息，不做跟进，且每个号码每天有发送上限；
- 由 AI 全自动谈单：折扣、报价、下单等事项 AI 不会代为承诺，须由人工决定；
- 个人使用单个号码且不需要知识库：直接使用手机或电脑版 WhatsApp 即可。

## 功能

- **公司号码统一对外，客户分配给业务员。** 业务员无需使用个人 WhatsApp，统一在后台以公司号码与客户沟通。管理员将客户分配给业务员（支持多选批量分配），业务员只能看到分配给自己的客户；人员离职时可一键转交，客户始终归属公司。客户发送的图片、视频、语音和文件可在会话中直接查看。[详细](docs/features.md#多人账号按客户分配)
- **AI 按需起草，人工确认后发送。** 在会话页点击「推荐回复」，AI 结合上下文和知识库起草一条回复：资料中写明的标准交期、起订量、样品政策直接引用；需要人工决定的内容（折扣、具体发货日期、按量报价等）标注为【待你确认：…】；不满意时可点击「换一条」。业务员发言后再次请求推荐，AI 会顺着业务员的话继续（例如兑现「我来介绍一下注册流程」）。公司话术和个人的「我的资料」用于控制语气和署名。[详细](docs/features.md#推荐回复和话术)
- **知识库。** 支持上传 PDF、Word、Excel、PPT 或网址，由 AI 整理为产品、价格、政策、FAQ 条目；资料缺失之处列入缺口清单，补充后即转为条目。后台提供「测试对话」，可直接与机器人对话检验效果，并支持一键「红线体检」。[详细](docs/features.md#知识库)
- **RAG 检索，可选向量检索。** AI 回复前先从知识库中检索与客户问题相关的条目，仅将这些条目提供给模型（RAG）：默认通过全文索引按关键词检索；客户语言与知识库语言不同时，先将客户的问题改写为知识库的语言再检索。在设置中开启「向量检索」后，还会按语义检索，客户换一种语言或说法提问也能命中，两路结果合并排序。向量直接存储在墨鸽自带的 SQLite 中，无需另行部署向量数据库，支持 OpenAI、Gemini、本机 Ollama 等向量模型。另可开启「重排」，由 Jina、Cohere、硅基流动、Voyage 等的重排模型对候选结果按相关度重新排序。知识库较小（4 万字以内）时直接全部提供给模型，不经检索。[详细](docs/features.md#知识库怎么带进回复)
- **首页 AI 助手。** 在概览页以自然语言提问，例如「今天有多少新客户」「还有哪些客户待处理」「P600 的交期和起订量是多少」。AI 调用只读查询工具（function calling）检索会话、聊天记录、客户线索、知识库和产品资料，并以中文汇总作答；回答中提及的会话和资料可点击打开或预览。查询范围遵循权限：管理员可查询全部数据，业务员仅能查询自己的客户。助手只读不写，不会代为发送消息。[详细](docs/features.md#ai-助手首页)
- **一键翻译为客户语言。** 在会话中用中文撰写，一键译为客户使用的语言后发送；默认使用回复模型翻译，也可在设置中改用 DeepL、谷歌、Azure、百度、火山等翻译 API。[详细](docs/features.md#一键翻译)
- **消息撤回。** 扫码号码发出的消息约两天半内可撤回；客户撤回的消息、机主在手机上撤回的消息也会标注出来，原文保留。已撤回的消息不再提供给 AI。[详细](docs/features.md#消息撤回)
- **产品资料库，一键发送文件。** 上传产品目录、价目表、规格书和图片后，可在会话中直接发送给客户；推荐回复也会建议应发送的文件。[详细](docs/features.md#产品资料库)
- **自动回复与转人工（可选）。** 适用于客服类的固定问答：机器人仅依据知识库作答，遇到折扣、下单、询问是否为机器人等问题时不作回复，转交人工处理，并通过 WhatsApp 或邮件发出通知。每条回复发送前须经过四层校验。[详细](docs/features.md#转人工自动回复模式) · [安全设计](docs/channels-and-security.md#安全设计)
- **客户线索。** 自动从聊天中提取客户姓名、公司、国家、意向产品、数量和跟进阶段，支持搜索、编辑和导出 CSV。[详细](docs/features.md#客户线索)
- **主动外联。** 上传已同意接收联系的客户号码，向每人发送一条开场消息；按每日上限、随机间隔和对方当地时间逐步发送，不做跟进。[详细](docs/features.md#主动外联)
- **数据看板。** 管理员可查看消息量、新增客户、转人工原因与响应时间、各成员处理量、客户平均等待时长、模型费用、外联效果，以及推荐回复被直接采用、修改后发送和未采用的情况；支持按号码和业务员筛选。[详细](docs/features.md#数据看板管理员)
- **屏蔽词与 AI 发言检查。** 管理员设置屏蔽词后，我方发给客户的消息含有屏蔽词时将无法发送（机主在手机上发送的消息无法拦截，仅作提醒），所有管理员会立即收到弹窗提醒，并可在弹窗中一键停用该业务员。还可开启「AI 发言检查」，由 AI 检查已发送的内容是否含有辱骂、威胁、歧视或骚扰，仅提醒、不拦截。两项功能默认关闭。[详细](docs/features.md#屏蔽词管理员默认关闭)
- **操作日志。** 管理员可查看每项操作的时间、操作人和内容，包括号码与设置变更、知识库修改、会话分配、成员管理、数据导出、登录及登录失败，并记录变更前后的内容、IP 和设备（如「Chrome · Windows 电脑」）。发给客户的消息不记入日志，密码和密钥仅记录「已修改」。日志只读，不可修改或删除。[详细](docs/features.md#操作日志管理员)
- **多号码、三种接入方式、在线更新。** 一套部署可接入多个号码，支持扫码（WAHA）和 Meta 官方 Cloud API，也可接入 LINE 官方帐号（客户添加好友后在 LINE 中沟通，适用于日本、台湾、泰国等以 LINE 为主的市场）。扫码号码可单独配置代理；也可开启全局代理，使模型、翻译、发信等请求以及扫码号码均经由代理节点（Clash 订阅）出站。发布新版本后，可在网页上一键更新，也可预约在夜间等时段自动更新。[接入和代理](docs/channels-and-security.md) · [在线更新](docs/online-update.md)

各项功能的完整说明见 [docs/features.md](docs/features.md)。

## 截图

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/screenshots/chat-suggest.png" alt="会话和推荐回复"><br>
      <sub>会话：点击「推荐回复」，AI 起草回复，【待你确认】部分高亮显示，修改后发送</sub>
    </td>
    <td width="50%" valign="top">
      <img src="assets/screenshots/assign.png" alt="按客户分配"><br>
      <sub>按客户分配：多选会话，批量分配给业务员</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/screenshots/knowledge.png" alt="知识库条目"><br>
      <sub>知识库：上传的资料整理为产品、价格、政策、FAQ 条目</sub>
    </td>
    <td width="50%" valign="top">
      <img src="assets/screenshots/dashboard.png" alt="看板"><br>
      <sub>看板：消息量、转人工原因、响应时间、模型费用</sub>
    </td>
  </tr>
</table>

## 快速开始

推荐使用官方镜像和 docker compose 部署。自行构建镜像、配置反向代理等细节见 [docs/deploy.md](docs/deploy.md)。

### 前置条件

- 一台安装了 Docker 和 Docker Compose v2 的 Linux 服务器或 Mac，支持 amd64 和 arm64。三个容器的内存上限合计约 1.4GB。
- 一个大模型 API key，支持 OpenAI、Anthropic、Gemini 三种接口格式，以及兼容 OpenAI 接口的服务。
- 至少一个可接入的号码或帐号：
  - 扫码接入：一部安装了 WhatsApp 的手机；
  - Meta 官方 Cloud API：Meta 开发者账号和公网 HTTPS 地址；
  - LINE 官方帐号：已开通 Messaging API 的官方帐号和公网 HTTPS 地址（[配置步骤](docs/deploy.md#line-官方帐号要的公网-https)）。

### 步骤

1. 克隆代码并复制配置文件：

   ```bash
   git clone https://github.com/Bowen1314/inkdove.git
   cd inkdove
   cp .env.example .env
   ```

2. 编辑 `.env`，至少填写以下 6 项：

   | 变量 | 说明 |
   |---|---|
   | `INKDOVE_ADMIN_EMAIL` | 第一个管理员的邮箱，用于登录后台 |
   | `INKDOVE_ADMIN_PASSWORD` | 管理员密码，至少 12 位 |
   | `INKDOVE_SESSION_SECRET` | 随机字符串 |
   | `INKDOVE_WAHA_WEBHOOK_SECRET` | 随机字符串 |
   | `INKDOVE_WAHA_API_KEY` | 随机字符串 |
   | `INKDOVE_UPDATER_TOKEN` | 随机字符串，供网页上的「立即更新」使用。不需要在线更新时见[在线更新](docs/online-update.md) |

   随机字符串可用以下命令生成，每项需单独生成：

   ```bash
   openssl rand -hex 32
   ```

   大模型的 key 无需写入此文件，登录后在网页上填写。其他变量见[环境变量](docs/deploy.md#环境变量)。

3. 拉取镜像并启动：

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. 打开 `http://127.0.0.1:8794`，使用 `.env` 中的管理员邮箱和密码登录。后台仅监听本机；部署在远程服务器上时，可先通过 `ssh -L 8794:127.0.0.1:8794 <服务器地址>` 建立端口转发后再访问，或按下文「对外访问」配置 HTTPS。

### 登录后的初始设置

1. **设置 → AI 模型**：填写 LLM 的接口格式（openai / anthropic / gemini）、地址、key 和模型，点击「测试连接」。
2. **文件 → 知识库资料**：上传资料或填写网址，点击「开始整理」，等待生成条目。
3. **知识库 → 测试对话**：提出几个客户常见的问题，检查回答是否准确。
4. **号码 → 添加号码**：
   - 扫码号码：点击「开始扫码连接」，在手机 WhatsApp 的「已关联的设备」中扫描二维码。不便扫码时（例如只有这一部手机），可将「关联方式」切换为「手机号配对码」，填写该号码（含国家码）获取 8 位配对码，再在手机上通过「关联新设备 → 改用手机号码关联」输入。配对码约 2 分钟内有效；
   - Meta 号码：填写 phone number id、verify token、access token 和 app secret，将页面上显示的 webhook 地址（`<INKDOVE_PUBLIC_BASE_URL>/webhooks/meta/<号的 id>`）填入 Meta 后台，并订阅 `messages`；
   - LINE 官方帐号：填写 Channel ID、Channel secret 和长期 Channel access token，将「连接」中显示的 Webhook URL（`<INKDOVE_PUBLIC_BASE_URL>/webhooks/line/<号的 id>`）填入 LINE Developers Console，并开启「Use webhook」。详见 [LINE 官方帐号](docs/channels-and-security.md#line-官方帐号)。
5. 在号码详情中选择**回复方式**：新建的号码默认为「人工回复」，客户消息仅保存，不调用 AI；业务员需要时在会话页点击「推荐回复」，由 AI 依据知识库起草，修改后发送。如需机器人直接回复客户，请选择「自动回复」，并配置「拿不准时通知我」。如需邮件通知，请先在**设置 → 发信方式**中配置 SMTP 或 Resend。公司话术在**设置 → 推荐回复**中编写。

团队中有业务员时：在**成员 → 邀请成员**中添加成员并分配可用的号码，再在**会话**页将客户分配给该业务员。

### 对外访问（HTTPS）

后台仅监听本机的 `127.0.0.1:8794`。如需让业务员从外部访问，或接入 Meta Cloud API、LINE 官方帐号，请使用 nginx 等反向代理配置 HTTPS，在 `.env` 中设置 `INKDOVE_PUBLIC_BASE_URL=https://kb.example.com` 和 `INKDOVE_COOKIE_SECURE=1`，然后重新执行 `docker compose up -d`。Meta 和 LINE 的回调地址必须是公网 HTTPS 地址。nginx 配置示例见 [docs/deploy.md](docs/deploy.md#对外访问https-反代示例)。

### 升级

- **网页更新**：有新版本时，管理员会在侧栏底部看到提示，点开后可选择「立即更新」，或通过「预约更新」指定时间（如夜间）自动更新。更新期间后台约 1 分钟无法访问，完成后页面自动刷新。更新前会自动备份数据库。
- **命令行更新**：在 `docker-compose.yml` 所在目录执行：

  ```bash
  docker compose pull
  docker compose up -d
  ```

跨版本升级的注意事项（例如自 v0.3.1 起推荐回复改为手动触发）见 [docs/upgrade.md](docs/upgrade.md)；固定版本号和回滚见 [docs/online-update.md](docs/online-update.md)。

### 常用命令

在 `docker-compose.yml` 所在目录执行：

```bash
docker compose ps                  # 查看容器运行状态
docker compose logs -f inkdove     # 查看应用日志（WhatsApp 连接日志将 inkdove 换成 waha）
docker compose restart inkdove     # 重启应用
docker compose down                # 停止全部容器（数据保留）
```

备份：数据库和上传的文件位于 `./data`，扫码号码的登录状态位于 `./waha-sessions`，密钥位于 `.env`。请先停止应用再打包；在 Linux 上，这些文件由容器内的 root 用户创建，打包时需要 `sudo`：

```bash
docker compose stop inkdove
sudo tar czf inkdove-backup-$(date +%Y%m%d).tar.gz data waha-sessions .env
docker compose start inkdove
```

备份文件包含密钥（LLM key、Meta token 等），请像密码一样妥善保管。

## 文档

- [部署和配置](docs/deploy.md)：自行构建镜像、容器与数据目录、HTTPS 反向代理示例、全部环境变量
- [升级说明](docs/upgrade.md)：跨版本时数据和行为的变化（按功能列出），以及回滚注意事项
- [在线更新](docs/online-update.md)：网页一键更新的工作原理、安全机制、固定版本号、备份与回滚
- [三种接入方式、安全设计和代理](docs/channels-and-security.md)：扫码、Meta 官方 API 与 LINE 官方帐号的区别和风险，机器人回复的四层校验，代理中继，全局代理
- [合规指南](docs/compliance.md)：数据的存储位置和接收方，如何告知员工和客户，中国、欧盟、美国的相关法规，以及 WhatsApp、LINE 的规则要点
- [功能说明](docs/features.md)：各项功能的完整说明，以及实现细节和接口约定
- [开发](docs/development.md)：项目结构、本地开发与测试、版本发布
- [偏离规格](docs/deviations.md)：开发过程中与 SPEC 不一致之处
- [已核实的外部接口](docs/external-apis.md)：WAHA、Meta、LINE、Resend、SMTP、LLM 接口的依据与实测结果

## 许可证

Copyright © 2026 Inkdove contributors

自 v0.2.0 起采用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）：

- 个人和企业均可免费使用、修改和自行部署，包括用于商业经营；
- 分发修改后的版本，或将修改后的版本部署为网络服务供他人使用时，须以 AGPL-3.0 公开完整的修改后源代码；
- 后台「设置 → 版本」中提供源代码链接，二次开发后请将其改为自己的仓库地址。

v0.1.0 及更早的版本仍采用 MIT 协议。

如需闭源商用、不希望受 AGPL 约束，可另行洽谈商业授权，请在 GitHub [提交 Issue](https://github.com/Bowen1314/inkdove/issues) 联系。

<p align="center">如果本项目对您有帮助，欢迎 Star 支持。</p>
