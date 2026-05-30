# 部署指南 — RTProxyExchange

本文档提供两种部署方案：**直接搭建**（源码/二进制）和 **Docker 容器**（推荐）。
另含 **CI/CD 自动部署** 说明。

当前线上：`https://82.40.42.147:8443`（自签证书，nginx 反代，HTTP `:8081` 自动跳转）。

---

## 一、Docker 部署（推荐）

### 1.1 单容器（最简）

```bash
# 构建镜像（在项目根目录）
docker build -t rtproxyexchange:latest .

# 运行
docker run -d --name rtproxyexchange \
  --restart unless-stopped \
  -p 8787:8787 \
  -e CODEX_CONVERTER_TIMEOUT=15 \
  rtproxyexchange:latest

# 访问 http://<server>:8787
```

### 1.2 跨架构构建（本地 Mac/ARM → x86 服务器）

服务器多为 x86_64。在 ARM Mac 上要显式指定平台：

```bash
docker buildx build --platform linux/amd64 -t rtproxyexchange:latest --load .
```

### 1.3 离线传输镜像（SFTP/SCP，无需服务器联网构建）

适合内存小、无法本地编译的服务器：

```bash
# 本地导出
docker save rtproxyexchange:latest | gzip > rtproxyexchange-amd64.tar.gz

# 传到服务器
scp rtproxyexchange-amd64.tar.gz root@<server>:/root/

# 服务器加载并运行
ssh root@<server>
gunzip -c /root/rtproxyexchange-amd64.tar.gz | docker load
docker run -d --name rtproxyexchange --restart unless-stopped -p 8787:8787 rtproxyexchange:latest
```

### 1.4 带 HTTPS 反代的生产栈（nginx + 自签证书）

部署文件在 `deploy/` 目录：

```
deploy/
├── docker-compose.proxy.yml   # app(内网) + nginx(对外)
└── nginx/codex.conf           # TLS 终止 + SSE 反代
```

服务器上操作：

```bash
mkdir -p /root/codex-deploy/nginx /root/codex-deploy/certs

# 生成自签证书（用 IP 作 CN/SAN；有域名时换成 Let's Encrypt）
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout /root/codex-deploy/certs/server.key \
  -out /root/codex-deploy/certs/server.crt \
  -subj "/CN=<server-ip>" -addext "subjectAltName=IP:<server-ip>"

# 上传 deploy/ 下的两个文件到 /root/codex-deploy/
# 然后启动
cd /root/codex-deploy
docker compose -f docker-compose.proxy.yml up -d
```

端口说明（本项目线上实例）：
- 标准 `443` 被服务器已有服务占用，故 HTTPS 映射到宿主 **8443**
- HTTP 重定向用 **8081**（80 被占）
- app 容器 **不** 对外暴露，仅 nginx 通过内网访问

> 自签证书：浏览器首次会提示"不安全"，点继续即可，流量仍是加密的。
> 有域名后可改用 Let's Encrypt 去掉警告。

---

## 二、直接搭建（不使用 Docker）

### 2.1 依赖

| 组件 | 版本 |
|------|------|
| Rust | 1.75+ |
| Node.js | 20+ |

> 注意：在小内存机器（<1GB）上编译 Rust release 可能 OOM，建议用 Docker 离线镜像方案。

### 2.2 构建

```bash
# 前端
cd frontend && npm ci && npm run build && cd ..

# 后端（release）
cargo build --release -p codex-backend
```

### 2.3 运行

```bash
# 后端会托管 frontend/dist 静态资源
STATIC_DIR=frontend/dist PORT=8787 ./target/release/codex-backend
```

### 2.4 systemd 守护（可选）

`/etc/systemd/system/rtproxyexchange.service`：

```ini
[Unit]
Description=RTProxyExchange
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/rtproxyexchange
Environment=PORT=8787
Environment=STATIC_DIR=/opt/rtproxyexchange/frontend/dist
Environment=CODEX_CONVERTER_TIMEOUT=15
ExecStart=/opt/rtproxyexchange/codex-backend
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now rtproxyexchange
```

---

## 三、CI/CD 自动部署（GitHub Actions）

仓库内含两个工作流：

| 文件 | 触发 | 作用 |
|------|------|------|
| `.github/workflows/ci.yml` | push / PR 到 main | fmt + clippy + test + 前端构建 |
| `.github/workflows/deploy.yml` | 打 `v*` tag 或手动 | 构建 amd64 镜像 → 推 GHCR → SSH 部署到服务器 |

### 3.1 需要配置的 GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 说明 |
|--------|------|
| `DEPLOY_HOST` | 服务器 IP，如 `82.40.42.147` |
| `DEPLOY_USER` | SSH 用户，如 `root` |
| `DEPLOY_PASSWORD` | SSH 密码 |
| `DEPLOY_PORT` | SSH 端口，通常 `22` |
| `GHCR_TOKEN` | 有 `read:packages` 权限的 PAT，供服务器拉镜像 |

> 推送 GHCR 用内置的 `GITHUB_TOKEN`，无需额外配置。
> 服务器侧拉私有镜像需要 `GHCR_TOKEN`。

### 3.2 发布流程

```bash
# 打 tag 触发自动构建+部署
git tag v0.2.0
git push origin v0.2.0
```

或在 GitHub Actions 页面手动触发 `Build & Deploy`（workflow_dispatch）。

工作流会：
1. 构建 `linux/amd64` 镜像并推送到 `ghcr.io/SummerXDsss/rtproxyexchange:latest` 和对应 tag
2. SSH 登录服务器，`docker compose pull` + `up -d`
3. 健康检查 `/api/health`，失败则打印日志并报错

### 3.3 服务器前置要求

服务器 `/root/codex-deploy/` 需已存在 `docker-compose.proxy.yml`、`nginx/codex.conf`、`certs/`（见 §1.4）。compose 通过 `CODEX_IMAGE` 环境变量指向 GHCR 镜像。

---

## 四、环境变量参考

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 8787 | 监听端口 |
| `STATIC_DIR` | frontend/dist | 前端静态目录 |
| `CODEX_CONVERTER_TIMEOUT` | 25 | 请求超时（秒） |
| `CODEX_CONVERTER_CONNECT_TIMEOUT` | 6 | 连接超时（秒），路由不通时快速失败 |
| `CODEX_CONVERTER_FORCE_IPV4` | true | 强制 IPv4，规避 IPv6 黑洞导致的卡顿 |
| `CODEX_CONVERTER_CONCURRENCY` | 4 | 批量并发数 |
| `CODEX_CONVERTER_CLIENT_ID` | 内置 | OAuth client_id（一般无需改） |

---

## 五、回滚

```bash
# 用某个历史 tag 的镜像
cd /root/codex-deploy
export CODEX_IMAGE="ghcr.io/SummerXDsss/rtproxyexchange:v0.1.0"
docker compose -f docker-compose.proxy.yml up -d
```
