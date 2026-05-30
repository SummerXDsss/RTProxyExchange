# RTProxyExchange

Refresh Token ⇄ Proxy 账号格式转换工具。粘贴 Codex / OpenAI 的 **Refresh Token** 即可登录刷新，并在 **CPA (CLIProxyAPI)** 与 **Sub2API** 格式间自由互转。无需 ClientID，开箱即用。

- **后端**：Rust（[Axum](https://github.com/tokio-rs/axum)）—— Token 刷新、JWT 解析、格式转换、并发批量、SSE 进度推送
- **CLI**：Rust（[clap](https://github.com/clap-rs/clap)）—— 命令行批量转换，安全文件输出
- **前端**：React + TypeScript + [Material UI](https://mui.com/) —— 单 Token 登录 / 批量、格式转换、账号拆分、实时进度、历史记录、明暗主题

主要功能：
- 🔑 单个 / 批量 Refresh Token 登录刷新
- 🔄 CPA ↔ Sub2API 格式互转
- ✂️ 批量账号拆分，按 `codex_{email}.json` 命名
- 📦 单独 / 打包(zip) 导出，一键复制
- ⚡ 实时进度（SSE），纯本地处理，Token 不落盘

实现参考 PRD.md 中的功能需求（FR-001 ~ FR-008）。

> **登录只需 Refresh Token，无需 ClientID。** `client_id`（`app_EMoamEEZ73f0CkXaXp7hrann`）
> 不是用户凭证，而是官方 codex-cli 内置的固定公开常量。OpenAI 的刷新接口要求携带它，
> 因此它被内置在后端 `crates/core/src/config.rs`，不在 UI / CLI / 配置接口中暴露。

---

## 项目结构

```
RefreshToken2CPA/
├── Cargo.toml                # Rust workspace
├── config.example.json       # 配置文件示例（见 §配置）
├── crates/
│   ├── core/                 # 核心逻辑（与传输层无关）
│   │   └── src/
│   │       ├── config.rs       # 刷新配置 + 内置 client_id 常量
│   │       ├── file_config.rs  # ~/.codex-converter/config.json 加载
│   │       ├── models.rs       # TokenResponse / CodexAccount / BatchResult / ProgressEvent
│   │       ├── jwt.rs          # JWT payload 解码 + 用户信息提取
│   │       ├── input.rs        # 输入解析（纯文本/批量/Sub2API/自定义 JSON）
│   │       ├── refresher.rs    # OAuth 刷新 + 指数退避重试
│   │       ├── builder.rs      # CPA 账号构建 + SHA256 去重 ID
│   │       ├── converter.rs    # 并发编排 + 流式进度 + 去重合并
│   │       └── tests.rs        # 单元测试
│   ├── backend/              # HTTP 服务
│   │   └── src/
│   │       ├── main.rs         # 启动、CORS、静态资源、配置分层
│   │       └── api.rs          # /api/health, /api/config, /api/convert, /api/convert/stream
│   └── cli/                  # 命令行工具
│       └── src/
│           ├── main.rs         # 参数解析、退出码、子命令
│           └── output.rs       # 安全输出（0600 权限、按账号分文件）
└── frontend/                 # React + MUI 前端
    └── src/
        ├── App.tsx
        ├── api.ts              # 后端调用（含 SSE 流式解析）
        ├── types.ts           # 与后端对齐的类型
        ├── hooks/             # useColorMode / useHistory
        └── components/        # InputPanel / ProgressPanel / ResultPanel / AccountCard / HistoryDrawer
```

---

## 运行方式

### 1. 启动后端

```bash
cargo run -p codex-backend
# 默认监听 http://localhost:8787
```

### 2. 启动前端（开发模式）

```bash
cd frontend
npm install
npm run dev
# http://localhost:5173 ，/api 自动代理到后端 :8787
```

### 3. 生产部署（单进程）

```bash
cd frontend && npm run build           # 产物输出到 frontend/dist
cargo run -p codex-backend --release   # 后端托管 frontend/dist
# 访问 http://localhost:8787
```

### 4. 命令行工具

```bash
# 单个 Token
cargo run -p codex-cli -- convert --token "v1.MzEy..."

# 批量（从文件，每行一个），并发 8，写入文件
cargo run -p codex-cli -- convert --file tokens.txt --concurrency 8 --output accounts.json

# 从 Sub2API 导入，每个账号单独成文件（0600 权限）
cargo run -p codex-cli -- import --sub2api export.json --output-dir ./accounts/

# 仅解析不刷新
cargo run -p codex-cli -- convert --file tokens.txt --dry-run
```

退出码：`0` 全部成功 / `1` 部分失败 / `2` 全部失败 / `3` 参数错误。

---

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查与版本 |
| GET | `/api/config` | 生效配置（不含 client_id） |
| POST | `/api/convert` | 一次性转换（支持 `dry_run`） |
| POST | `/api/convert/stream` | SSE 流式转换，逐条推送进度 |

### `POST /api/convert`

```json
{
  "input": "v1.MzEy...\nv1.OTg3...",
  "timeout_secs": 25,
  "concurrency": 4,
  "dry_run": false
}
```

`input` 支持：单个 Token、批量 Token（每行一个）、Sub2API 导出 JSON、自定义 JSON。
- `dry_run: true` → `{ total, token_previews }`
- `dry_run: false` → `BatchResult`

### `POST /api/convert/stream`

请求体同上。响应为 SSE，事件序列：

```
event: started   data: {"type":"started","total":3}
event: item      data: {"type":"item","index":0,"ok":true,"email":"...","completed":1,"total":3}
event: done      data: {"type":"done","result":{ ...BatchResult... }}
```

---

## 配置

配置分三层，后者覆盖前者：

1. 内置默认值（`RefreshConfig::default`）
2. 配置文件 `~/.codex-converter/config.json`（见 `config.example.json`）
3. 环境变量 / 请求参数

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 后端端口 | 8787 |
| `STATIC_DIR` | 前端静态资源目录 | frontend/dist |
| `CODEX_CONVERTER_TIMEOUT` | 请求超时（秒） | 25 |
| `CODEX_CONVERTER_CONCURRENCY` | 并发数 | 4 |

---

## 测试与质量

```bash
cargo test           # 15 个核心单元测试
cargo clippy --workspace --all-targets   # 零告警
```

---

## 安全说明

- Token 仅在内存中处理，不落盘
- 日志与错误信息中仅保留 Token 前 10 个字符的预览
- CLI 输出文件在 Unix 上以 `0600` 权限创建
- 前端历史记录仅存于浏览器 localStorage，不上传
- 生成的 `accounts.json` 已加入 `.gitignore`
