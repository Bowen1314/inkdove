<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" width="128" alt="墨鸽 Inkdove">
</picture>

# 墨鸽 Inkdove

**A WhatsApp workspace for export sales teams: customers talk to one company number, each customer is assigned to a salesperson, and when you need it, one click gets AI to draft a reply grounded in your knowledge base through RAG (full-text search plus a built-in vector store). A person always sends it.**

[![Release](https://img.shields.io/github/v/release/Bowen1314/inkdove)](https://github.com/Bowen1314/inkdove/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fbowen1314%2Finkdove-2496ED?logo=docker&logoColor=white)](https://github.com/Bowen1314/inkdove/pkgs/container/inkdove)
[![Node >= 20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Release workflow](https://img.shields.io/github/actions/workflow/status/Bowen1314/inkdove/release.yml?label=release%20build)](https://github.com/Bowen1314/inkdove/actions/workflows/release.yml)

[中文](README.md) | English

[Quick start](#quick-start) · [Features](#features) · [Screenshots](#screenshots) · [Docs](#documentation)

</div>

<p align="center">
  <img src="assets/screenshots/chat-suggest.png" width="900" alt="Chat view: click Suggest reply, AI drafts a reply from the knowledge base, the salesperson edits and sends it">
</p>

> The admin UI and the detailed docs under `docs/` are in Chinese for now. UI labels below are given in English with the Chinese label in brackets.

## ⚠️ Before you start

- **QR-code login can get your number banned.** The QR option (WAHA) uses WhatsApp Web's unofficial protocol, and the number may be restricted or banned. For numbers that matter, use Meta's official Cloud API. See [the two connection methods and their risks](docs/channels-and-security.md#两种接入方式的区别和风险) (Chinese).
- **Don't use it for spam.** Don't send marketing messages to people who haven't agreed to hear from you. Follow WhatsApp's terms and your local laws.
- **Whoever sends an AI draft is responsible for it.** AI can get prices, lead times and promises wrong. Check before you send.

## Who it's for

**A good fit if:**

- Several people on an export sales team share the company's WhatsApp number instead of using their own;
- Customers should stay with the company: when a salesperson leaves, their customers are handed to someone else in one click, with the full chat history;
- You want new hires to answer with the company's own product info, prices and wording;
- The boss wants to see every chat and be able to step in at any time, hear about it right away when someone says something they shouldn't to a customer, and see who changed what.

**Not a good fit if:**

- You want bulk marketing or lead generation: outreach sends one opening message per number, never follows up, and each number has a daily cap;
- You want AI to close deals on its own: AI never agrees to discounts, quotes or orders for you. A person makes those calls;
- It's one person with one number and no need for a knowledge base: the WhatsApp app on your phone or desktop is enough.

## Features

- **One company number, customers assigned to salespeople.** Salespeople don't use their own WhatsApp; they chat from the web console through the company's numbers. An admin assigns customers to salespeople (bulk-select works), and each salesperson only sees their own. When someone leaves, their customers are transferred in one click and stay with the company. Photos, videos, voice notes and files that customers send show up right in the chat. [Details](docs/features.md#多人账号按客户分配) (Chinese)
- **AI drafts on demand, a person sends.** In a chat, click Suggest reply (推荐回复). AI reads the conversation and drafts a reply from the knowledge base, stating standard terms the knowledge base spells out (standard lead times, MOQ, samples) and marking anything that needs a human decision (discounts, the ship date for this order, volume pricing...) as 【待你确认：…】 ("please confirm"). Not happy with it? Click Try another (换一条). If the salesperson has already said something (say, "let me explain how to register"), the next suggestion picks up from there. A company style guide plus each person's own profile and style notes control the tone and sign-off. [Details](docs/features.md#推荐回复和话术) (Chinese)
- **Knowledge base.** Upload PDF, Word, Excel, PowerPoint or a URL, and AI turns it into product, pricing, policy and FAQ entries. Missing information goes on a gap list; answer it and it becomes an entry. You can chat with the bot in a test panel, and run a one-click red-line check. [Details](docs/features.md#知识库) (Chinese)
- **RAG retrieval, with optional vector search.** Before the AI replies, it looks up the knowledge-base entries relevant to what the customer just said and passes only those to the model (RAG). A full-text index finds them by keyword; when the customer writes in a different language from the knowledge base, their words are rewritten into the knowledge base's language and searched again. Turn on vector search in Settings and it also searches by meaning, so questions in another language or worded differently still find the right entries; the two result lists are merged into one ranking. Vectors live in Inkdove's built-in SQLite database, so there's no separate vector database to run, and OpenAI, Gemini, local Ollama and other embedding models work. You can also turn on reranking, which sends the candidates to a rerank model (Jina, Cohere, SiliconFlow, Voyage and others) to sort them by relevance once more. A small knowledge base (under 40,000 characters) is passed in whole, with no retrieval needed. [Details](docs/features.md#知识库怎么带进回复) (Chinese)
- **AI assistant on the home page.** Ask in plain language: "How many new customers today?", "Which customers are still waiting?", "What's the lead time and MOQ for our P600?" The AI calls read-only query tools (function calling) to look through chats, messages, leads, the knowledge base and product files, then sums up in Chinese; chats and files it mentions open or preview with a click. It respects permissions: admins can query everything, salespeople only their own customers. It only reads; it never changes data or sends messages. [Details](docs/features.md#ai-助手首页) (Chinese)
- **One-click translation into the customer's language.** Write in Chinese in the chat box and translate it into the language the customer uses before sending. It uses your reply model by default, or you can switch to a translation API (DeepL, Google, Azure, Baidu, Volcengine and others) in Settings. [Details](docs/features.md#一键翻译) (Chinese)
- **Unsending messages.** Messages you sent can be unsent for everyone within about two and a half days (QR-code numbers). Messages the customer unsends, or the owner unsends from the phone, are marked as such and the original text is kept. Unsent messages are no longer shown to the AI. [Details](docs/features.md#消息撤回) (Chinese)
- **Product file library.** Upload catalogs, price lists, spec sheets and images, and send them to customers right from the chat. Suggested replies also recommend which file to send. [Details](docs/features.md#产品资料库) (Chinese)
- **Auto-reply with human handoff (optional).** For fixed customer-service Q&A: the bot answers only from the knowledge base. When a customer asks for a discount, wants to order or asks whether it's a bot, it doesn't answer; it hands the chat to a person and notifies you on WhatsApp or by email. Every reply goes through four layers of checks. [Details](docs/features.md#转人工自动回复模式) · [Safety design](docs/channels-and-security.md#安全设计) (Chinese)
- **Customer leads.** Names, companies, countries, products of interest, quantities and deal stages are pulled out of chats automatically. Search, edit, export to CSV. [Details](docs/features.md#客户线索) (Chinese)
- **Outreach.** Upload numbers of customers who have agreed to be contacted, and each gets one opening message, sent slowly within a daily cap, at random intervals and during their local daytime. No follow-ups. [Details](docs/features.md#主动外联) (Chinese)
- **Dashboard.** Admins see message volume, new customers, handoff reasons and response times, how much each team member handled, model spend, outreach results, and how many suggested replies were sent as is, edited or not used. [Details](docs/features.md#数据看板管理员) (Chinese)
- **Blocked words and AI conduct check.** Once an admin sets a blocked-word list, any message to a customer containing one of those words isn't sent (messages typed on the owner's phone can't be stopped, only flagged), and every admin gets a pop-up right away, with a button to disable that salesperson's account. You can also turn on the AI conduct check, which has the AI look at what was sent for abuse, threats, discrimination or harassment; it only alerts and never blocks. Both are off by default. [Details](docs/features.md#屏蔽词管理员默认关闭) (Chinese)
- **Activity log.** Admins can see who did what and when: changes to numbers, settings and the knowledge base, chat assignments, team members, exports, sign-ins and failed sign-ins, with before and after values, the IP address and the device (for example "Chrome · Windows 电脑"). Messages to customers aren't logged, and passwords and keys are only recorded as "changed". The log can be read but not edited or deleted. [Details](docs/features.md#操作日志管理员) (Chinese)
- **Multiple numbers, two connection methods, in-app updates.** One deployment serves several numbers, connected by QR code (WAHA) or Meta's official Cloud API, each with its own optional proxy; an optional global proxy can also send model, translation and email requests, and QR-code numbers, through an airport node from a Clash subscription. New versions install with one click in the web console, or on a schedule (say, overnight). [Connections and proxies](docs/channels-and-security.md) · [In-app updates](docs/online-update.md) (Chinese)

Full feature details: [docs/features.md](docs/features.md) (Chinese).

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/screenshots/chat-suggest.png" alt="Chat with a suggested reply"><br>
      <sub>Chat: click Suggest reply, AI drafts one, the "please confirm" parts are highlighted, edit and send</sub>
    </td>
    <td width="50%" valign="top">
      <img src="assets/screenshots/assign.png" alt="Assigning customers"><br>
      <sub>Assigning customers: select several chats and hand them to a salesperson at once</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/screenshots/knowledge.png" alt="Knowledge base entries"><br>
      <sub>Knowledge base: uploaded documents become product, pricing, policy and FAQ entries</sub>
    </td>
    <td width="50%" valign="top">
      <img src="assets/screenshots/dashboard.png" alt="Dashboard"><br>
      <sub>Dashboard: message volume, handoff reasons, response times, model spend</sub>
    </td>
  </tr>
</table>

## Quick start

The recommended setup is the official image with docker compose. Building the image yourself, reverse proxies and other details are in [docs/deploy.md](docs/deploy.md) (Chinese).

### Prerequisites

- A Linux server or Mac with Docker and Docker Compose v2, amd64 or arm64. The three containers' memory limits add up to about 1.4 GB.
- An API key for a large language model: OpenAI, Anthropic and Gemini API formats are supported, as are OpenAI-compatible APIs.
- A WhatsApp number: for QR login, a phone with WhatsApp installed; for Meta's Cloud API, a Meta developer account and a public HTTPS address.

### Steps

1. Get the code and copy the config file:

   ```bash
   git clone https://github.com/Bowen1314/inkdove.git
   cd inkdove
   cp .env.example .env
   ```

2. Edit `.env` and fill in at least these six:

   | Variable | What to put |
   |---|---|
   | `INKDOVE_ADMIN_EMAIL` | Email of the first admin, used to log in |
   | `INKDOVE_ADMIN_PASSWORD` | Admin password, at least 12 characters |
   | `INKDOVE_SESSION_SECRET` | A random string |
   | `INKDOVE_WAHA_WEBHOOK_SECRET` | A random string |
   | `INKDOVE_WAHA_API_KEY` | A random string |
   | `INKDOVE_UPDATER_TOKEN` | A random string, used by Update now (立即更新) in the web console. If you don't want in-app updates, see [in-app updates](docs/online-update.md) (Chinese) |

   Generate each random string separately with:

   ```bash
   openssl rand -hex 32
   ```

   The LLM key doesn't go here; you enter it in the web console after logging in. Other variables: [environment variables](docs/deploy.md#环境变量) (Chinese).

3. Pull the images and start:

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. Open `http://127.0.0.1:8794` and log in with the admin email and password from `.env`. The console only listens on localhost; on a remote server, tunnel in first with `ssh -L 8794:127.0.0.1:8794 <your-server>`, or set up HTTPS as described under [Exposing it over HTTPS](#exposing-it-over-https).

### First five things after logging in

1. **Settings → AI model** (设置 → AI 模型): pick the API format (openai / anthropic / gemini), enter the base URL, key and model, and click Test connection (测试连接).
2. **Files → Knowledge sources** (文件 → 知识库资料): upload documents or add URLs, click Start organizing (开始整理), and wait for the entries.
3. **Knowledge base → Test chat** (知识库 → 测试对话): ask a few typical customer questions and check the answers.
4. **Numbers → Add number** (号码 → 添加号码):
   - QR number: click Start QR connection (开始扫码连接) and scan the code from Linked devices in WhatsApp on the phone. If scanning is awkward (say, it's your only phone), switch the link method (关联方式) to phone-number pairing code (手机号配对码), enter the number with its country code to get an 8-character code, and type it on the phone under Link a device → Link with phone number instead. The code is valid for about 2 minutes;
   - Meta number: enter the phone number id, verify token, access token and app secret, put the webhook URL shown on the page (`<INKDOVE_PUBLIC_BASE_URL>/webhooks/meta/<number id>`) into the Meta dashboard, and subscribe to `messages`.
5. Choose the **reply mode** in the number's details: new numbers default to Manual reply (人工回复). Incoming messages are just stored and no AI is called; when a salesperson wants help, they click Suggest reply (推荐回复) in the chat, AI drafts a reply from the knowledge base, and they edit and send it. To let the bot answer customers directly, choose Auto-reply (自动回复) and set up Notify me when unsure (拿不准时通知我). For email notifications, first configure SMTP or Resend under **Settings → Email delivery** (设置 → 发信方式). The company style guide lives under **Settings → Suggested replies** (设置 → 推荐回复).

If you have salespeople: **Members → Invite member** (成员 → 邀请成员), give them the numbers they may use, then assign customers to them on the **Chats** (会话) page.

### Exposing it over HTTPS

The console only listens on `127.0.0.1:8794`. To let salespeople use it from elsewhere, or to use Meta's Cloud API, put it behind a reverse proxy such as nginx with HTTPS, set `INKDOVE_PUBLIC_BASE_URL=https://kb.example.com` and `INKDOVE_COOKIE_SECURE=1` in `.env`, and run `docker compose up -d` again. Meta's webhook must be a public HTTPS URL. An nginx example is in [docs/deploy.md](docs/deploy.md#对外访问https-反代示例) (Chinese).

### Upgrading

- **In the web console:** when a new version is out, admins see a notice at the bottom of the sidebar. Open it and click Update now (立即更新), or Schedule update (预约更新) to pick a time. The console is unavailable for about a minute and reloads by itself when it's back. The database is backed up first.
- **From the command line**, in the directory with `docker-compose.yml`:

  ```bash
  docker compose pull
  docker compose up -d
  ```

Changes to watch for between versions (for example, suggested replies became manual-only in v0.3.1) are in [docs/upgrade.md](docs/upgrade.md); pinning a version and rolling back are in [docs/online-update.md](docs/online-update.md) (Chinese).

### Everyday commands

Run these in the directory with `docker-compose.yml`:

```bash
docker compose ps                  # are the containers running?
docker compose logs -f inkdove     # app logs (use waha instead of inkdove for WhatsApp connection logs)
docker compose restart inkdove     # restart the app
docker compose down                # stop everything (your data stays)
```

Backups: the database and uploaded files are in `./data`, QR numbers' login state is in `./waha-sessions`, and secrets are in `.env`. Stop the app before archiving. On Linux the files were created by root inside the container, so you need `sudo`:

```bash
docker compose stop inkdove
sudo tar czf inkdove-backup-$(date +%Y%m%d).tar.gz data waha-sessions .env
docker compose start inkdove
```

The backup contains secrets (LLM key, Meta token and so on). Keep it as safe as a password.

## Documentation

All in Chinese:

- [Deployment and configuration](docs/deploy.md): building the image yourself, containers and data directories, an HTTPS reverse-proxy example, every environment variable
- [Upgrade notes](docs/upgrade.md): data and behavior changes between versions, by feature, and what to watch for when rolling back
- [In-app updates](docs/online-update.md): how one-click updates work, security, pinning a version, backups and rollback
- [Connection methods, safety design and proxies](docs/channels-and-security.md): QR vs. Meta's official API and their risks, the four layers of reply checks, the proxy relay, the global proxy
- [Compliance guide](docs/compliance.md) (in Chinese): where data is stored and who receives it, notices for employees and customers, and the main rules in China, the EU, the US and WhatsApp's terms
- [Features](docs/features.md): full description of every feature, plus implementation details and API contracts
- [Development](docs/development.md): project layout, local development and tests, cutting a release
- [Deviations from the spec](docs/deviations.md): where the implementation differs from the SPEC
- [Verified external APIs](docs/external-apis.md): sources and test results for the WAHA, Meta, Resend, SMTP and LLM APIs

## License

Copyright © 2026 Inkdove contributors

Since v0.2.0, Inkdove is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only):

- Individuals and companies may use, modify and self-host it for free, including for commercial operations;
- If you distribute a modified version, or run a modified version as a service that others use over a network, you must publish the complete modified source code under AGPL-3.0;
- The web console has a source-code link under Settings → Version (设置 → 版本). If you build on Inkdove, point it to your own repository.

v0.1.0 and earlier remain under the MIT license.

If you want to use it in a closed-source commercial product without the AGPL obligations, a commercial license can be arranged. Please [open an issue](https://github.com/Bowen1314/inkdove/issues) on GitHub.

<p align="center">If you find it useful, please give it a star.</p>
