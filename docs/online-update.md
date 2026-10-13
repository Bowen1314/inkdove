# 在线更新

**怎么工作**：

- 应用启动 1 分钟后查一次 GitHub 上的最新发布（`GET https://api.github.com/repos/<INKDOVE_UPDATE_REPO>/releases/latest`，匿名，每个 IP 每小时 60 次），之后每 6 小时查一次，结果只存在内存里。预发布不提示。`INKDOVE_UPDATE_CHECK=0` 时完全不访问 GitHub。
- 有新版本时，管理员在侧栏底部看到「有新版本 vX.Y.Z」，点开是新版本的说明（发布时间、更新说明、GitHub Release 链接）。**设置 → 版本**里能看当前版本、上次检查时间，手动「检查更新」（60 秒内重复点直接给上次的结果）。业务员看不到这些。
- 装了更新助手时，弹窗里有「立即更新」：确认后应用先把数据库备份到 `./data/backups/`，再调 compose 里的 `updater` 服务（镜像 `nickfedor/watchtower:1.23.0`，`POST /v1/update?image=ghcr.io/bowen1314/inkdove&async=true`，带口令）。它拉同一个标签的新镜像、重建 `inkdove` 容器，期间后台约 1 分钟打不开；`waha` 容器打了不更新的标签，WhatsApp 连接不受影响。页面每 3 秒问一次版本号，变了就自动刷新；5 分钟还没变会提示去服务器上看（`docker compose logs updater`）并给出手动命令。
- **预约更新**：不想白天更新时，在弹窗里点「预约更新」选个时间（1 分钟之后、7 天之内，5 分钟一档，按浏览器的时区显示）。预约后弹窗、侧栏和设置 → 版本里都显示「已预约 … 更新到 vX.Y.Z」，可以改时间、取消，或者直接立即更新。应用每分钟看一次，到点走和「立即更新」一样的流程（先备份再调更新助手）。预约存在数据库里，重启不丢；到点时应用没在运行、过了 1 小时以上才启动的，这次不更新，记为「错过」；结果（成功、失败原因、错过）在设置 → 版本里看。只能预约一次，再预约就覆盖上一次。接口：`POST /api/update/schedule {at}`（带时区的 ISO 时间）、`DELETE /api/update/schedule`，`GET /api/update` 多返回 `schedule` 和 `scheduleResult`，都只有管理员能用。
- 没装更新助手、连不上它、或者镜像钉了版本号时，弹窗里只显示命令，在 `docker-compose.yml` 所在目录执行：

  ```bash
  docker compose pull
  docker compose up -d
  ```

**安全**：更新助手挂了宿主机的 `/var/run/docker.sock`，等于能操作宿主机上所有容器。所以 compose 里它不映射任何端口，只在 compose 内网里给 `inkdove` 调；`INKDOVE_UPDATER_TOKEN` 要用足够长的随机串（`openssl rand -hex 32`）；它只更新打了 `com.centurylinklabs.watchtower.enable=true` 标签的容器（只有 `inkdove`）。不想要它：把 `docker-compose.yml` 里的 `updater` 整段删掉，`.env` 里的 `INKDOVE_UPDATER_TOKEN` 留空，网页上会改为显示上面的命令。

**钉版本号**：更新助手只会重新拉「同一个标签」的新镜像。镜像标签用 `latest`（默认）时一键更新能升到新版；用 `0.2` 这种浮动标签时只能升到 0.2.x；在 `.env` 里设 `INKDOVE_IMAGE_TAG=0.2.0` 这种完整版本号时，一键更新升不上去，网页上只提示新版本，要先把标签改成新版本号再执行上面的命令。

**更新前的备份**：每次一键更新前用 SQLite 在线备份把数据库拷到 `./data/backups/inkdove-v<旧版本>-<UTC 时间>.db`，只留最近 5 份；备份失败就不更新。上传的文件和客户发来的媒体（`./data/files`、`./data/media`）不在备份里（更新不会动它们）。手动用命令更新时不会自动备份，可以先自己拷一份 `./data`。

**回滚**：

1. 在 `.env` 里把 `INKDOVE_IMAGE_TAG` 设成旧版本号（比如 `0.1.0`），执行 `docker compose up -d`；
2. 新版本改过数据库、旧版本读不了时，先 `docker compose stop inkdove`，把 `./data/inkdove.db` 换成 `./data/backups/` 里对应的备份（同时删掉旁边的 `inkdove.db-wal`、`inkdove.db-shm`），再 `docker compose up -d`。备份之后新产生的数据（新消息、改过的设置）会丢。
