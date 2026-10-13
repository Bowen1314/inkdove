# syntax=docker/dockerfile:1

# 1) 构建前端（产物和平台无关，只在构建机的架构上跑一次）
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2) 安装 server 的生产依赖（better-sqlite3 优先用预编译包，拿不到时用这里的工具链现编）
FROM node:22-slim AS server-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 3) mihomo（全局代理，见 docs/deploy.md「全局代理」）：MetaCubeX 官方 release 的二进制，GPL-3.0，
#    源码 https://github.com/MetaCubeX/mihomo/tree/v1.19.32。按目标架构下载，核对 sha256 后解压。
#    许可证全文（LICENSE）取同一个标签下的，一起放进镜像的 /usr/local/share/doc/mihomo/。
#    sha256 是从官方 release 和仓库下载这几个文件后自己算的；升级版本时版本号和 sha256 一起改（LICENSE 没变的话 sha256 不变）。
#    amd64 用官方的 compatible 版（对 CPU 指令集要求最低，老服务器也能跑）。
FROM --platform=$BUILDPLATFORM node:22-slim AS mihomo
ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.32
WORKDIR /mihomo
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; sum="ba3ce607747a07f948fc35780e108a4a7c7f552a38b9bd4d115f313ebcb89c20" ;; \
    arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; sum="9dd862e28b46ff7d775f169cceebc28deccaa0a9e804237d421cd2571e0caba0" ;; \
    *) echo "mihomo：不支持的架构 $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  dl() { node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); require("node:fs").writeFileSync(process.argv[2], Buffer.from(await r.arrayBuffer())); })' "$1" "$2"; }; \
  dl "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}" mihomo.gz; \
  dl "https://raw.githubusercontent.com/MetaCubeX/mihomo/${MIHOMO_VERSION}/LICENSE" LICENSE; \
  printf '%s  %s\n' "$sum" mihomo.gz 3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986 LICENSE | sha256sum -c -; \
  gunzip mihomo.gz; \
  chmod 755 mihomo; \
  printf '%s\n' "mihomo ${MIHOMO_VERSION} (${asset})" \
    "License: GPL-3.0 (see LICENSE in this directory)" \
    "Source: https://github.com/MetaCubeX/mihomo/tree/${MIHOMO_VERSION}" > NOTICE

# 4) 运行
# 全局 fetch 靠 server/src/builtin-fetch.js 绕开 npm undici 7.30 的崩溃 bug，Node 22 自带的是 undici 6；
# 换大版本（比如 Node 24 自带 undici 7）前先跑 server/test/builtin-fetch.test.js 和 server/test/media.test.js 确认不崩。
FROM node:22-slim
ENV NODE_ENV=production \
    INKDOVE_PORT=8794 \
    INKDOVE_DATA_DIR=/app/data
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /app/web/dist /app/web/dist
# 全局代理用的 mihomo（默认不启动，设置 → 代理 开启后才由墨鸽作为子进程拉起）
COPY --from=mihomo /mihomo/mihomo /usr/local/bin/mihomo
COPY --from=mihomo /mihomo/NOTICE /mihomo/LICENSE /usr/local/share/doc/mihomo/
RUN mkdir -p /app/data
EXPOSE 8794
CMD ["node", "src/index.js"]
