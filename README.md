# DA-Proxy

OpenAI 兼容的 DesignArena 模型代理。将 34 个 Agon 模型暴露为标准 `/v1/chat/completions` 端点，可直接接入 Cherry Studio、ChatBox、Continue、OpenAI SDK 等任意兼容客户端。

## 部署

```bash
npm install
node index.js
```

服务启动在 `http://localhost:3141`。

## 客户端配置

```
Base URL: http://localhost:3141/v1
API Key:  留空（默认免鉴权）
```

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | 聊天补全（`stream: true/false`） |
| GET | `/health` | 运行状态 |

## 配置

编辑 `config.json`：

```json
{
  "port": 3141,
  "host": "0.0.0.0",
  "apiKey": "",
  "defaultSystemPrompt": "You are a helpful AI assistant."
}
```

| 字段 | 说明 |
|------|------|
| `port` | 监听端口 |
| `host` | 绑定地址，`0.0.0.0` 允许局域网访问 |
| `apiKey` | 如填写，客户端需传 `Authorization: Bearer <key>` |
| `defaultSystemPrompt` | 客户端未传 system 消息时的默认提示词 |

## 特性

- 系统提示词注入（客户端 `system` 消息 → 后端实际生效）
- SSE 流式响应
- Token 用量统计
- 自动重试
- 多轮对话上下文合并
