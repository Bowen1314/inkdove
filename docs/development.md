# 开发

## 项目结构

接口契约见 [SPEC.md](../SPEC.md) 和 [SPEC-phase2.md](../SPEC-phase2.md)（两者冲突时以 phase2 为准），界面设计见 [DESIGN.md](../DESIGN.md)。

- `SPEC.md`：第一期的规格（知识库整理 + WhatsApp 自动回复），路由、字段名、枚举值的原始契约；
- `SPEC-phase2.md`：第二期的规格（多人账号、多号、外联、看板、产品资料、语音图片、红线体检、客户线索等，编号 F1–F15，docs 里提到的 F2、F11 这类编号就是它），和 SPEC.md 冲突时以它为准；
- `DESIGN.md`：界面设计（布局、样式、组件摆放），覆盖两份 SPEC 里关于视觉的说明；
- 开发中和规格不一致的地方记在 [deviations.md](deviations.md)，用到的外部接口和实测结果记在 [external-apis.md](external-apis.md)；前端自己的结构、约定和偏离规格见 [web/README.md](../web/README.md)。

```
server/   Node.js ESM（纯 JS），Express 5 + better-sqlite3，测试用 node:test
web/      React 18 + Vite（前端，另见 web/README.md）
Dockerfile、docker-compose.yml、.env.example
```

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

## 发新版

把 `server/package.json` 和 `web/package.json` 的 version 改成新版本号并提交，然后 `git tag v0.2.0 && git push origin v0.2.0`。

推了 `vX.Y.Z` 标签后，GitHub Actions（[.github/workflows/release.yml](../.github/workflows/release.yml)）会：

1. 检查标签和两个 `package.json` 的 version 一致，跑后端测试；
2. 构建 amd64 和 arm64 镜像，推到 `ghcr.io/bowen1314/inkdove`，镜像标签是 `X.Y.Z`、`X.Y` 和 `latest`（带 `-rc` 之类后缀的预发布版不打 `latest`）；
3. 建 GitHub Release（带 `-` 后缀的标成预发布）。

在线更新只认 GitHub 上的正式 Release，见 [online-update.md](online-update.md)。
