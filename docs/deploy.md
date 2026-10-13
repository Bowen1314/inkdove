# 部署和配置

最常用的装法（官方镜像 + docker compose）见 [README 的「快速开始」](../README.md#快速开始)。这里是更多细节：自己编译镜像、容器和数据目录、HTTPS 反代、全部环境变量。升级见 [upgrade.md](upgrade.md) 和 [online-update.md](online-update.md)。

## 用源码自己编译镜像

官方镜像在推 `v*` 标签时由 GitHub Actions 自动构建，支持 amd64 和 arm64，一般直接拉它就行（`docker compose pull && docker compose up -d`）。改了代码、想在本地编译时：

```bash
cp .env.example .env
# 至少填：INKDOVE_ADMIN_EMAIL、INKDOVE_ADMIN_PASSWORD（≥12 位）、INKDOVE_SESSION_SECRET、
#        INKDOVE_WAHA_WEBHOOK_SECRET、INKDOVE_WAHA_API_KEY、INKDOVE_UPDATER_TOKEN（后四个用 openssl rand -hex 32 生成；
#        最后一个是在线更新用的，不要的话见 docs/online-update.md）
docker compose up -d --build
```

自己编译出的镜像也叫 `ghcr.io/bowen1314/inkdove:<标签>`。这时在网页上点「立即更新」，更新助手会拉官方镜像把它换掉；自己改过代码的，建议按 [在线更新](online-update.md) 里说的删掉 `updater` 服务。

## 部署说明

- `inkdove` 只监听宿主的 `127.0.0.1:8794`，对外请用 nginx 之类反代到 HTTPS，并在 `.env` 里设 `INKDOVE_PUBLIC_BASE_URL=https://kb.example.com`、`INKDOVE_COOKIE_SECURE=1`。Meta 回调必须是公网 HTTPS 地址。
- `waha` 用 `devlikeapro/waha:gows`，不映射宿主端口，只有 inkdove 能访问。登录态存在 `./waha-sessions`，重建容器不用重新扫码。
- `inkdove` 的主机名固定为 `inkdove`，WAHA 经 `inkdove:<端口>` 连代理中继（见[代理中继](channels-and-security.md#代理中继f13)），选了「用全局代理」的号经 `inkdove:17890` 连全局代理。这些端口都不映射到宿主。
- 数据在 `./data`，备份这个目录即可：SQLite 数据库、上传的文件（`files/`）、客户发来的图片视频语音文件（`media/`，单个最大 64MB，不自动清理，客户发得多时留意磁盘）。
- 两个容器都配了 `host.docker.internal:host-gateway`。要用宿主机上的代理时，代理地址填 `host.docker.internal`。
- `waha` 设了 `WAHA_EVENTS_DOWNLOAD_MEDIA=true` 和 `WAHA_BASE_URL=http://waha:3000`：客户发来的图片、视频、语音、文件由 WAHA 先下载，inkdove 收到消息后马上带 `X-Api-Key` 从 `waha:3000/api/files/...` 取一份存进 `./data/media`（WAHA 自己只留 `WHATSAPP_FILES_LIFETIME` 秒，默认 180 秒）。发给客户的文件超过 15MB 时，WAHA 反过来从 `http://inkdove:<INKDOVE_PORT>/internal/files/<id>?token=…` 拉取（签名地址，10 分钟有效），所以两个容器要在同一个网络里（compose 默认就是）。

## 全局代理（mihomo）

「设置 → 代理」（默认关，用法见[功能说明](features.md#全局代理)，安全上的考虑见[这里](channels-and-security.md#全局代理)）靠 [mihomo](https://github.com/MetaCubeX/mihomo)（Clash Meta 内核）连机场节点：

- 镜像里自带 `/usr/local/bin/mihomo`，版本 **v1.19.32**，**GPL-3.0** 许可，源码 <https://github.com/MetaCubeX/mihomo/tree/v1.19.32>。它是一个独立的程序，墨鸽只在开启全局代理时把它作为子进程拉起、通过配置文件和本机的控制接口和它打交道，不链接它的代码。构建镜像时从官方 release 下载（amd64 用 `mihomo-linux-amd64-compatible-v1.19.32.gz`，arm64 用 `mihomo-linux-arm64-v1.19.32.gz`），核对 Dockerfile 里写死的 sha256 后解压；镜像里的 `/usr/local/share/doc/mihomo/` 下有 `NOTICE`（版本、许可、源码地址）和 `LICENSE`（同一标签下的 GPL-3.0 全文，也核对 sha256）。
- mihomo 让镜像大了约 60MB（解压后的二进制 amd64 约 62MB、arm64 约 57MB，压缩后各 20MB 出头）。开着全局代理时它和墨鸽在同一个容器里，内存一起算在 compose 的 `mem_limit` 里（现在是 512m）。
- 端口：混合端口 `INKDOVE_GLOBAL_PROXY_PORT`（默认 17890），容器里听 `0.0.0.0`（给 compose 内网里的 WAHA 用，外面来的要账号密码），**不要映射到宿主机**；控制接口听 `127.0.0.1` 的随机端口。和代理中继的端口（`INKDOVE_PROXY_RELAY_PORT_BASE` 起，每个扫码号一个）错开。
- 配置和运行文件在 `./data/mihomo/`（目录 700，配置 600）。
- 不用 Docker、自己跑 server 时，从官方 release 下载对应平台的 mihomo，核对 sha256 后用 `INKDOVE_MIHOMO_PATH` 指过去；没有的话设置页提示「这台机器没有 mihomo」，开关打不开。

## 对外访问：HTTPS 反代示例

`inkdove` 只监听本机的 `127.0.0.1:8794`。要让业务员在外面用、或者接 Meta Cloud API，就在同一台机器上用 nginx（或 Caddy 等）反代成 HTTPS。nginx 的例子，域名和证书路径换成你自己的：

```nginx
server {
    listen 443 ssl;
    server_name kb.example.com;
    ssl_certificate     /etc/letsencrypt/live/kb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kb.example.com/privkey.pem;

    # 产品资料单个文件最大 50MB、一次最多传 20 个，nginx 默认只放行 1MB，按自己的用量调大
    client_max_body_size 100m;
    # 要推荐回复、测试对话这类请求要等模型回完，别让 nginx 太早断开
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8794;
        proxy_set_header Host $host;
        # 登录失败限流按客户端 IP 算，靠这个拿到真实 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

然后在 `.env` 里设：

```bash
INKDOVE_PUBLIC_BASE_URL=https://kb.example.com
INKDOVE_COOKIE_SECURE=1
```

再执行 `docker compose up -d` 让它生效。

## 环境变量

只读 `INKDOVE_` 开头的变量。完整列表和注释见 [.env.example](../.env.example)。

| 变量 | 必填 | 说明 |
|---|---|---|
| `INKDOVE_ADMIN_EMAIL` | ✔ | 第一个管理员的邮箱。只在库里还没有任何账号时用 |
| `INKDOVE_ADMIN_PASSWORD` | ✔ | 第一个管理员的密码，至少 12 个字符 |
| `INKDOVE_SESSION_SECRET` | ✔ | cookie 签名密钥，也用来算 WAHA 配置指纹 |
| `INKDOVE_WAHA_WEBHOOK_SECRET` | ✔ | WAHA webhook 的 HMAC 密钥 |
| `INKDOVE_WAHA_API_KEY` | compose 里必填 | WAHA 的 `X-Api-Key`，compose 同时传给 waha 容器 |
| `INKDOVE_UPDATER_TOKEN` | compose 里必填 | 更新助手的口令，compose 同时传给 updater 容器。像其他密钥一样用 `openssl rand -hex 32` 生成；删掉 updater 服务时留空，网页上改为显示更新命令 |
| `INKDOVE_PORT` | | 默认 8794 |
| `INKDOVE_DATA_DIR` | | 默认 `./data`，compose 里是 `/app/data` |
| `INKDOVE_PUBLIC_BASE_URL` | | 对外地址：Meta 回调地址、邀请链接、通知里的后台链接都用它 |
| `INKDOVE_COOKIE_SECURE` | | 经 HTTPS 对外时设 1 |
| `INKDOVE_WAHA_URL` | | 默认 `http://127.0.0.1:3000`，compose 里是 `http://waha:3000` |
| `INKDOVE_WAHA_WEBHOOK_URL` | | WAHA 回调本服务的地址，compose 里是 `http://inkdove:8794/webhooks/waha` |
| `INKDOVE_PROXY_RELAY_PORT_BASE` | | 代理中继的起始端口，默认 18000，每个扫码号占一个 |
| `INKDOVE_PROXY_RELAY_HOST` | | WAHA 连中继用的主机名，默认 `inkdove`；超过 15MB 的文件给 WAHA 的签名下载地址也用它 |
| `INKDOVE_MIHOMO_PATH` | | 全局代理用的 mihomo，默认 `/usr/local/bin/mihomo`（镜像里自带）。本地开发没有时指定自己下载的 |
| `INKDOVE_GLOBAL_PROXY_PORT` | | 全局代理的混合端口，默认 17890（1024–65535）。墨鸽自己从本机连，WAHA 经 `INKDOVE_PROXY_RELAY_HOST:端口` 连；不要映射到宿主 |
| `INKDOVE_WAHA_SESSION` | | 仅第一期升级用：迁移成「默认号」时沿用的 session 名 |
| `INKDOVE_LLM_BASE_URL` 等 4 个 | | LLM 初始值，只在第一次启动时写进库，之后以设置页为准 |
| `INKDOVE_LLM_MOCK` | | 设 1 走假 LLM |
| `INKDOVE_UPDATE_CHECK` | | 默认开：启动 1 分钟后、之后每 6 小时查一次 GitHub 上的最新发布。设 0 关掉，不再访问 GitHub |
| `INKDOVE_UPDATE_REPO` | | 查哪个仓库的发布，默认 `Bowen1314/inkdove`；镜像名按它推出来（`ghcr.io/<小写的 owner/repo>`） |
| `INKDOVE_UPDATER_URL` | | 更新助手的地址，默认 `http://updater:8080`（compose 内网） |
| `INKDOVE_IMAGE_TAG` | | 应用镜像的标签，默认 `latest`；compose 用它拼镜像名，也传给应用判断能不能一键升级 |
| `INKDOVE_AUDIT_RETENTION_DAYS` | | 操作日志保留多少天，默认 365（1–36500 的整数），过期的每天自动清掉 |
| `INKDOVE_META_GRAPH_URL`、`INKDOVE_RESEND_API_URL` | | 仅测试用，生产不要设 |
