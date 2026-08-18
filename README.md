# hum

`hum` 是一个儿童知识歌曲的内容生产后台。它用 Next.js 提供受保护的管理界面，并以 PostgreSQL 保存账号、配置、任务、评测与生产谱系。

## 本地启动

前提：Docker Desktop、Node.js 22+ 与 pnpm 10+。

```bash
cp .env.example .env
# 把 .env 中的 POSTGRES_PASSWORD 替换为高熵密码
docker compose up --build
```

打开 <http://localhost:3000/setup>，按首次初始化流程创建管理员。应用会在首次访问时自动应用版本化数据库迁移；`hum-data` 与 `hum-postgres-data` Docker volumes 保存本地状态，删除容器不会删除它们。

## 配置边界

- 第三方服务凭据只在已登录的管理界面写入，且数据库中以加密形式保存；不要把凭据写入 `.env`、镜像或 Git。
- `HUM_DATA_DIR` 保存应用私有文件与加密密钥，必须与 PostgreSQL volume 一并备份。
- PostgreSQL 密码由本机 `.env` 提供；`.env` 不得提交。

## 开发

```bash
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm dev
```

`pnpm dev` 默认连接本机 compose PostgreSQL，地址为 `127.0.0.1:55432`。如使用自定义数据库，显式设置 `DATABASE_URL`。

## 容器发布

推送到 `dev` 分支会由 GitHub Actions 构建并推送：

- `ghcr.io/talexdreamsoul/hum:dev`
- `ghcr.io/talexdreamsoul/hum:sha-<commit>`

部署预构建镜像时，在 `.env` 中设置 `HUM_IMAGE=ghcr.io/talexdreamsoul/hum:dev`，再执行 `docker compose up -d`。Compose 仍会启动独立的 PostgreSQL 服务与持久化 volumes；数据库不应被烘焙进应用镜像。
