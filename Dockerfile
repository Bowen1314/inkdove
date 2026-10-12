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

# 3) 运行
FROM node:22-slim
ENV NODE_ENV=production \
    INKDOVE_PORT=8794 \
    INKDOVE_DATA_DIR=/app/data
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /app/data
EXPOSE 8794
CMD ["node", "src/index.js"]
