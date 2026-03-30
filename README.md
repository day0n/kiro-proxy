# Kiro Proxy

将 Kiro (AWS CodeWhisperer) API 转换为 Claude / OpenAI 兼容格式的轻量代理服务。

## 快速开始

```bash
# 安装依赖
npm install

# 配置凭证（复制模板后编辑）
cp .env.example .env

# 编译 + 启动
npm run build
npm start
```

## 配置凭证

编辑 `.env`，三种方式任选其一：

**方式 1：指定凭证文件**（推荐）
```env
KIRO_CREDS_PATH=~/.aws/sso/cache/kiro-auth-token.json
```

**方式 2：Social Auth（Google/GitHub 登录获得的 token）**
```env
KIRO_REFRESH_TOKEN=aorAxxxxxxxx
KIRO_AUTH_METHOD=social
KIRO_REGION=us-east-1
```

**方式 3：IDC / Builder ID**
```env
KIRO_REFRESH_TOKEN=aorAxxxxxxxx
KIRO_CLIENT_ID=your_client_id
KIRO_CLIENT_SECRET=your_client_secret
KIRO_AUTH_METHOD=IdC
KIRO_REGION=us-east-1
```

**方式 4：通过 OAuth 登录**（不需要提前配置 token）
```bash
# 启动服务后，调用 OAuth 端点
curl -X POST http://localhost:3456/oauth/start \
  -H "Content-Type: application/json" \
  -d '{"method": "google"}'
# 返回 authUrl，在浏览器中打开完成登录
```

## API 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/messages` | Claude Messages API（流式 + 非流式） |
| `POST /v1/chat/completions` | OpenAI Chat Completions API（流式 + 非流式） |
| `GET /v1/models` | 模型列表 |
| `POST /oauth/start` | 启动 OAuth 登录 |
| `GET /health` | 健康检查 |

## 在 Claude Code 中使用

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
claude
```

## 支持的模型

- `claude-opus-4-6`
- `claude-opus-4-5`
- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-haiku-4-5`

## 项目结构

```
src/
├── main.ts                  # 入口
├── server.ts                # HTTP 路由
├── config.ts                # 配置加载
├── domain/
│   ├── types.ts             # 类型定义
│   └── errors.ts            # 错误层级
├── auth/
│   ├── credential-store.ts  # 凭证管理 + Token 刷新
│   └── oauth-flow.ts        # OAuth 浏览器登录
├── gateway/
│   ├── kiro-api.ts          # 上游 API 通信
│   ├── request-mapper.ts    # 消息格式转换
│   └── stream-decoder.ts    # 二进制流解析
├── handlers/
│   ├── claude.ts            # Claude 格式处理
│   ├── openai.ts            # OpenAI 格式处理
│   └── models.ts            # 模型列表
└── lib/
    ├── logger.ts            # 日志
    └── text.ts              # 文本工具
```
