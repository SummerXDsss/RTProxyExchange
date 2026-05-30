# Codex Token 转换器 PRD

> **文档版本**: v1.0  
> **创建日期**: 2026-04-18  
> **项目名称**: Codex Token → CLIProxyAPI 转换工具

---

## 一、项目概述

### 1.1 项目背景

目前存在两个独立项目用于处理 Codex/OpenAI OAuth Token：

- **Sub2API**：Go 后端，负责 Refresh Token 刷新、用户信息提取、账号管理
- **Cockpit-Tools**：Rust 桌面应用，支持导入 Sub2API 格式并转换为 CPA (CLIProxyAPI) 格式

本项目旨在将两者的核心逻辑整合为一个轻量级转换工具，实现 **单个 Codex Refresh Token → 完整 CLIProxyAPI 账号信息文档** 的端到端转换。

### 1.2 项目目标

1. 输入：一个或多个 Codex Refresh Token
2. 处理：自动刷新获取完整 Token 集合，提取用户信息
3. 输出：符合 CLIProxyAPI (CPA) 格式的账号信息 JSON 文档

### 1.3 目标用户

- 需要批量管理 Codex 账号的技术人员
- 从其他平台迁移到 CLIProxyAPI 的用户
- 需要自动化 Token 管理流程的开发者

---

## 二、功能需求

### 2.1 核心功能

#### FR-001: Refresh Token 输入

**描述**：支持多种输入方式导入 Refresh Token

**输入格式**：
| 格式 | 示例 | 说明 |
|------|------|------|
| 纯 Token | `v1.MzEyMzQ1Njc4...` | 单行一个 Token |
| 批量 Token | 多行文本，每行一个 Token | 支持批量处理 |
| Sub2API JSON | Sub2API 导出的 DataPayload | 自动识别并解析 |
| 自定义 JSON | `{"refresh_token": "..."}` | 灵活字段名匹配 |

**Token 字段查找优先级**：
```
1. refresh_token / refreshToken
2. credentials.refresh_token / credentials.refreshToken
3. tokens.refresh_token / tokens.refreshToken
```

#### FR-002: Token 刷新

**描述**：使用 Refresh Token 向 OpenAI OAuth 端点换取完整 Token 集合

**实现逻辑**（参考 Sub2API + Cockpit-Tools 两套实现）：

```
输入: refresh_token
     ↓
POST https://auth.openai.com/oauth/token
  Content-Type: application/x-www-form-urlencoded (推荐，兼容性更好)
  Body:
    - grant_type: refresh_token
    - refresh_token: <RT>
    - client_id: app_EMoamEEZ73f0CkXaXp7hrann
    - scope: openid profile email
     ↓
输出: {
  access_token,
  id_token,
  refresh_token (新的，可能与输入相同),
  expires_in,
  token_type,
  scope
}
```

**兼容性处理**：
| 特性 | 行为 | 原因 |
|------|------|------|
| Content-Type | `application/x-www-form-urlencoded` | Sub2API 方式，兼容性更好 |
| scope 参数 | 发送 `openid profile email` | 确保返回完整 claims |
| User-Agent | `codex-cli/0.91.0` | 模拟官方客户端 |
| 新 RT 为空 | 保留旧 refresh_token | 防止丢失有效凭证 |

#### FR-003: 用户信息提取

**描述**：从 Token 中解析用户身份信息

**数据来源 1：ID Token JWT 解析**

```json
{
  "sub": "user-xxx",
  "email": "user@example.com",
  "email_verified": true,
  "https://api.openai.com/auth": {
    "chatgpt_account_id": "account-xxx",
    "chatgpt_user_id": "user-xxx",
    "chatgpt_plan_type": "plus",
    "user_id": "user-xxx",
    "poid": "org-xxx",
    "organizations": [
      {
        "id": "org-xxx",
        "role": "owner",
        "title": "Personal",
        "is_default": true
      }
    ]
  }
}
```

**提取字段映射**：
| JWT 字段 | 提取目标 | 说明 |
|----------|----------|------|
| `email` | email | 用户邮箱 |
| `chatgpt_account_id` | account_id | ChatGPT 账号 ID |
| `chatgpt_user_id` | user_id | 用户 ID |
| `chatgpt_plan_type` | plan_type | 订阅计划类型 |
| `poid` | organization_id | 默认组织 ID |

**数据来源 2：Access Token JWT 解析**

当 id_token 信息不完整时，从 access_token JWT 补充：
- `exp` → token 过期时间
- `poid` → organization_id

#### FR-004: 账号去重

**描述**：避免重复导入同一账号

**去重策略**：
```python
account_id = SHA256(email + account_id + organization_id)
```

**处理逻辑**：
- 新账号：创建新的 CodexAccount
- 已存在：更新 Token，保留旧 refresh_token（如果新的为空）

#### FR-005: CLIProxyAPI 格式输出

**描述**：生成符合 CPA 格式的账号信息文档

**输出结构**：

```json
{
  "id": "sha256_hash",
  "email": "user@example.com",
  "auth_mode": "oauth",
  "openai_api_key": null,
  "api_base_url": null,
  "api_provider_mode": "openai_builtin",
  "user_id": "user-xxx",
  "plan_type": "plus",
  "subscription_active_until": "2026-05-02T20:32:12+00:00",
  "account_id": "account-xxx",
  "organization_id": "org-xxx",
  "tokens": {
    "id_token": "eyJhbGciOi...",
    "access_token": "eyJhbGciOi...",
    "refresh_token": "v1.MzEyM..."
  },
  "token_generation": 1,
  "token_source_mode": "managed",
  "requires_reauth": false,
  "quota": null,
  "tags": [],
  "created_at": 1745000000,
  "last_used": 1745000000
}
```

**字段映射表**：

| 来源字段 | 目标字段 | 转换说明 |
|----------|----------|----------|
| refresh_token 输入 | tokens.refresh_token | 直接复制 |
| 刷新返回 access_token | tokens.access_token | 直接复制 |
| 刷新返回 id_token | tokens.id_token | 直接复制 |
| JWT email | email | 直接复制 |
| JWT chatgpt_account_id | account_id | 字段名映射 |
| JWT chatgpt_user_id | user_id | 字段名映射 |
| JWT poid | organization_id | 直接复制 |
| JWT chatgpt_plan_type | plan_type | 直接复制 |
| JWT exp | subscription_active_until | 时间戳转换 |
| 固定值 | auth_mode | "oauth" |
| 固定值 | api_provider_mode | "openai_builtin" |
| 固定值 | token_source_mode | "managed" |

### 2.2 批量处理功能

#### FR-006: 批量 Token 处理

**描述**：支持一次处理多个 Refresh Token

**输入格式**：
```
v1.MzEyMzQ1Njc4OTAtb2F1dGg...
v1.OTg3NjU0MzIxMC1vYXV0aC...
v1.LTEyMzQ1Njc4OTAtb2F1dGg...
```

**输出格式**：
```json
{
  "accounts": [
    { /* CPA 账号 1 */ },
    { /* CPA 账号 2 */ },
    { /* CPA 账号 3 */ }
  ],
  "exported_at": "2026-04-18T12:00:00Z",
  "total": 3,
  "success": 2,
  "failed": 1,
  "errors": [
    {
      "index": 2,
      "token_preview": "LTEyMzQ1...",
      "error": "Token expired or invalid"
    }
  ]
}
```

#### FR-007: Sub2API 格式导入

**描述**：支持导入 Sub2API 导出的 DataPayload JSON

**识别逻辑**：
```python
def looks_like_sub2api_export(value):
    accounts = value.get("accounts", [])
    return (
        value.get("exported_at") is not None
        or value.get("proxies") is not None
        or any(
            a.get("credentials") is not None 
            and a.get("platform") is not None
            for a in accounts
        )
    )

def is_codex_oauth_account(account):
    return (
        account.get("platform") == "openai" 
        and account.get("type") == "oauth"
    )
```

### 2.3 错误处理

#### FR-008: 错误处理与重试

**错误类型与处理策略**：

| 错误类型 | 处理方式 | 重试策略 |
|----------|----------|----------|
| 网络超时 | 返回错误信息 | 建议重试 |
| Token 无效/过期 | 跳过并记录 | 不重试 |
| Rate Limit | 等待后重试 | 指数退避，最多 3 次 |
| 服务端错误 | 返回错误信息 | 建议稍后重试 |
| JSON 解析失败 | 跳过并记录 | 不重试 |

---

## 三、非功能需求

### 3.1 性能要求

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 单 Token 处理时间 | < 5 秒 | 包含网络请求和数据处理 |
| 批量处理吞吐量 | > 10 Token/分钟 | 并发控制避免触发限流 |
| 内存占用 | < 100MB | 处理 1000 个 Token 时 |

### 3.2 安全要求

| 需求 | 说明 |
|------|------|
| Token 不落盘 | 处理过程中 Token 仅在内存中，不写入临时文件 |
| 输出文件权限 | 生成的 JSON 文件权限为 600 (仅所有者可读写) |
| 无日志记录 | 不在日志中记录完整 Token，仅记录前 10 字符用于调试 |

### 3.3 兼容性要求

| 环境 | 支持版本 |
|------|----------|
| Python | 3.9+ |
| Node.js | 18+ |
| Go | 1.21+ |
| Rust | 1.70+ |

---

## 四、技术架构

### 4.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Codex Token 转换器                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐   │
│  │   输入模块    │────▶│   处理模块    │────▶│     输出模块      │   │
│  │              │     │              │     │                  │   │
│  │ • 纯 Token   │     │ • Token 刷新 │     │ • CPA JSON       │   │
│  │ • 批量 Token │     │ • JWT 解析   │     │ • 账号索引        │   │
│  │ • Sub2API    │     │ • 信息提取   │     │ • 错误报告        │   │
│  │ • 自定义JSON │     │ • 去重处理   │     │                  │   │
│  └──────────────┘     └──────┬───────┘     └──────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│                     ┌─────────────────┐                            │
│                     │  OpenAI OAuth   │                            │
│                     │  auth.openai.com│                            │
│                     └─────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 数据流图

```
Refresh Token
     │
     ▼
┌─────────────────┐
│  HTTP POST      │
│  /oauth/token   │──────▶ auth.openai.com
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ TokenResponse   │
│ - access_token  │
│ - id_token      │
│ - refresh_token │
│ - expires_in    │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│JWT解析 │ │JWT解析 │
│id_token│ │access_ │
│        │ │token   │
└───┬────┘ └───┬────┘
    │          │
    ▼          ▼
┌─────────────────┐
│   信息合并      │
│ email, user_id  │
│ plan_type, ...  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  去重检查       │
│  SHA256 计算    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CodexAccount    │
│ (CPA 格式)      │
└─────────────────┘
```

### 4.3 核心模块设计

#### 模块 1：Token 刷新器 (TokenRefresher)

```python
class TokenRefresher:
    OAUTH_ENDPOINT = "https://auth.openai.com/oauth/token"
    CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
    USER_AGENT = "codex-cli/0.91.0"
    
    def refresh(self, refresh_token: str) -> TokenResponse:
        """
        使用 Refresh Token 换取完整 Token 集合
        
        Args:
            refresh_token: Codex Refresh Token
            
        Returns:
            TokenResponse 包含 access_token, id_token, refresh_token, expires_in
            
        Raises:
            TokenRefreshError: 刷新失败
            NetworkError: 网络错误
        """
        pass
```

#### 模块 2：JWT 解析器 (JWTDecoder)

```python
class JWTDecoder:
    def decode_payload(self, jwt_token: str) -> dict:
        """
        解码 JWT payload（不验证签名）
        
        Args:
            jwt_token: JWT 格式的 token
            
        Returns:
            payload 字典
        """
        pass
    
    def extract_user_info(self, id_token: str, access_token: str) -> UserInfo:
        """
        从 Token 中提取用户信息
        
        Returns:
            UserInfo 包含 email, user_id, account_id, organization_id, plan_type
        """
        pass
```

#### 模块 3：账号构建器 (AccountBuilder)

```python
class AccountBuilder:
    def build_codex_account(
        self, 
        tokens: TokenResponse, 
        user_info: UserInfo
    ) -> CodexAccount:
        """
        构建 CPA 格式的账号对象
        
        Args:
            tokens: Token 响应
            user_info: 用户信息
            
        Returns:
            CodexAccount 对象
        """
        pass
    
    def generate_account_id(self, email: str, account_id: str, org_id: str) -> str:
        """
        生成唯一账号 ID (SHA256)
        """
        pass
```

#### 模块 4：格式转换器 (FormatConverter)

```python
class FormatConverter:
    def sub2api_to_codex_import_candidate(self, sub2api_account: dict) -> CodexImportCandidate:
        """
        将 Sub2API 格式转换为内部导入候选对象
        """
        pass
    
    def codex_account_to_json(self, account: CodexAccount) -> dict:
        """
        将 CodexAccount 转换为 JSON 输出格式
        """
        pass
```

---

## 五、API 设计

### 5.1 命令行接口

#### 基本用法

```bash
# 单个 Token 转换
codex-converter convert --token "v1.MzEyMzQ1Njc4..."

# 批量 Token 转换（从文件）
codex-converter convert --file tokens.txt --output accounts.json

# 从 Sub2API 导入
codex-converter import --sub2api sub2api_export.json --output accounts.json

# 指定输出目录（批量时每个账号单独文件）
codex-converter convert --file tokens.txt --output-dir ./accounts/
```

#### 参数说明

| 参数 | 简写 | 说明 | 必填 |
|------|------|------|------|
| --token | -t | 单个 Refresh Token | 否 |
| --file | -f | Token 文件路径（每行一个） | 否 |
| --sub2api | -s | Sub2API 导出 JSON 文件 | 否 |
| --output | -o | 输出文件路径 | 否 |
| --output-dir | -d | 输出目录（批量模式） | 否 |
| --proxy | -p | HTTP 代理地址 | 否 |
| --timeout | -T | 请求超时时间（秒） | 否 |
| --verbose | -v | 详细输出 | 否 |
| --dry-run | | 仅解析不刷新 | 否 |

#### 输出格式

```bash
# 标准输出
{
  "accounts": [...],
  "exported_at": "2026-04-18T12:00:00Z",
  "total": 10,
  "success": 9,
  "failed": 1,
  "errors": [...]
}

# 退出码
0 - 全部成功
1 - 部分失败
2 - 全部失败
3 - 参数错误
```

### 5.2 Python API

```python
from codex_converter import CodexConverter

converter = CodexConverter()

# 单个 Token 转换
account = converter.convert_token("v1.MzEyMzQ1Njc4...")

# 批量转换
results = converter.convert_batch(["token1", "token2", "token3"])

# 从 Sub2API 导入
accounts = converter.import_sub2api("sub2api_export.json")

# 导出为 JSON
converter.export_json(accounts, "output.json")
```

---

## 六、配置项

### 6.1 配置文件

**文件位置**：`~/.codex-converter/config.json`

```json
{
  "oauth": {
    "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
    "endpoint": "https://auth.openai.com/oauth/token",
    "scope": "openid profile email",
    "user_agent": "codex-cli/0.91.0",
    "timeout": 25
  },
  "output": {
    "default_format": "cpa",
    "include_metadata": true,
    "pretty_print": true
  },
  "network": {
    "proxy": null,
    "verify_ssl": true,
    "max_retries": 3,
    "retry_delay": 1
  },
  "security": {
    "log_tokens": false,
    "file_permissions": "600"
  }
}
```

### 6.2 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CODEX_CONVERTER_PROXY` | HTTP 代理 | 无 |
| `CODEX_CONVERTER_TIMEOUT` | 请求超时 | 25 |
| `CODEX_CONVERTER_CLIENT_ID` | OAuth Client ID | app_EMoamEEZ73f0CkXaXp7hrann |
| `CODEX_CONVERTER_OUTPUT_DIR` | 默认输出目录 | 当前目录 |

---

## 七、测试计划

### 7.1 单元测试

| 测试项 | 测试内容 | 预期结果 |
|--------|----------|----------|
| JWT 解析 | 解码标准 JWT payload | 正确提取所有字段 |
| Token 刷新 | 模拟 OAuth 响应 | 正确处理各种响应格式 |
| 格式转换 | Sub2API → CPA 转换 | 字段正确映射 |
| 去重逻辑 | 重复 Token 导入 | 正确识别并更新 |
| 错误处理 | 各类异常情况 | 优雅处理并给出提示 |

### 7.2 集成测试

| 测试场景 | 测试步骤 | 验证点 |
|----------|----------|--------|
| 端到端转换 | 输入有效 RT → 输出 CPA JSON | 输出格式正确，字段完整 |
| 批量处理 | 输入 10 个 RT → 输出 10 个账号 | 并发正确，无遗漏 |
| Sub2API 导入 | 导入 Sub2API JSON → 输出 CPA | 转换正确，信息完整 |
| 网络异常 | 模拟超时/断网 | 正确重试，错误报告 |

### 7.3 性能测试

| 测试项 | 测试条件 | 性能指标 |
|--------|----------|----------|
| 单次转换 | 1 个 Token | < 5 秒 |
| 批量转换 | 100 个 Token | < 10 分钟 |
| 内存占用 | 1000 个 Token | < 100MB |

---

## 八、里程碑计划

| 阶段 | 时间 | 交付物 |
|------|------|--------|
| M1: 核心功能 | 第 1-2 周 | Token 刷新 + JWT 解析 + 基本转换 |
| M2: 批量处理 | 第 3 周 | 批量输入输出 + 错误处理 |
| M3: 格式兼容 | 第 4 周 | Sub2API 导入 + 多种输入格式 |
| M4: 优化完善 | 第 5 周 | 性能优化 + 文档 + 测试 |

---

## 九、风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|----------|
| OpenAI OAuth 接口变更 | Token 刷新失败 | 监控接口变化，快速适配 |
| Rate Limit 触发 | 批量处理受限 | 实现退避重试，支持并发控制 |
| Token 格式变化 | JWT 解析失败 | 降级处理，仅输出原始 Token |
| 依赖库安全漏洞 | 安全风险 | 定期更新依赖，安全审计 |

---

## 十、附录

### 10.1 参考资料

- Sub2API 项目：https://github.com/Wei-Shaw/sub2api
- Cockpit-Tools 项目：https://github.com/qlsxteam/cockpit-tools
- OpenAI OAuth 文档：https://platform.openai.com/docs/guides/authorization

### 10.2 术语表

| 术语 | 说明 |
|------|------|
| RT | Refresh Token，用于换取 Access Token 的长期凭证 |
| AT | Access Token，用于 API 调用的短期凭证（约 1 小时） |
| JWT | JSON Web Token，用于传递用户身份信息 |
| CPA | CLIProxyAPI，Codex CLI 使用的代理 API 格式 |
| Sub2API | 第三方 OpenAI 账号管理后端 |
| CodexAccount | CPA 格式的账号数据结构 |
