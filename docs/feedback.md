# 用户反馈与 Agent 支持申请

首页 Agent 网格的 **Want another agent?** 与账户页 **Feedback** 分组打开反馈表单。申请可多选最多 10 个候选，或填写 Other（最多 60 个 Unicode 码点）；Bug / Idea / Other 必须填写留言，最多 2,000 个码点。成功页点 Done 关闭；网络失败保留输入，可重试；429 显示等待秒数。候选 ID 在 `ios/AgentAnywhere/Models/Feedback.swift` 与 `server/src/feedback.ts` 各维护一份，调整时同步。

## API 与通知

`POST /v1/feedback` 接受 JSON；匿名不带 Authorization，登录使用 `Authorization: Bearer <accessToken>`。带无效 token 返回 401，不降级匿名。

```json
{
  "kind": "agent_request",
  "agents": ["gemini-cli", "cursor"],
  "otherAgent": "",
  "message": "Review coding tasks from my phone",
  "contactOk": false,
  "diagnostics": { "appVersion": "1.0", "build": "1", "enabledAgents": ["codex"] }
}
```

返回 `{ "ok": true, "id": "..." }`。限流为滚动窗口：每 IP 10 条/小时、30 条/24 小时，每账号 20 条/24 小时；SQLite 事务检查并写入，重启后保留。429 的 `Retry-After` 头和 `error.retryAfter` 均为秒数。无效请求不占提交额度。

启动服务自动创建 `feedback` 表。配置 `AA_EMAIL_SENDER=smtp`、原有 SMTP 配置和 `AA_FEEDBACK_EMAIL=产品负责人邮箱` 后，每条已保存反馈异步通知负责人。通知复用验证码 SMTP transport，纯文本包含留言、联系授权、账号邮箱（有授权时）、诊断、时间与反馈 ID。发送失败只记录 ID，不回滚反馈或影响 API；没有邮件重试队列，完整记录仍可导出。console 渠道不发送反馈通知。

## 只读导出

在 `server/` 下执行（沿用服务使用的 `AA_DATA_DIR`）：

```sh
node src/index.ts feedback
node src/index.ts feedback --since 7d --format table
node src/index.ts feedback --since 30d --format json > /tmp/feedback.json
node src/index.ts feedback --since all --format csv > /tmp/feedback.csv
# 打包后使用同样参数：
node dist/server.mjs feedback --since 7d --format table
# 部署目录中的独立 bundle：node server.mjs feedback ...
```

`--since` 为 `7d|30d|all`，默认 `30d`；`--format` 为 `table|json|csv`，默认 `table`。导出以只读方式打开已有数据库，不初始化表、不生成密钥、不启动 HTTP，不要求 SMTP 或签名配置有效。请先用新版服务完成一次数据库初始化。

table 先显示申请排行，再按时间倒序列出范围内所有反馈，留言显示前 100 个码点。排行只统计 `agent_request`，按每个 Agent 的同账号 **或** 同 IP 关联组计一次：匿名与登录在同 IP 合并，同账号换 IP 合并，间接关联也合并。因此共享出口 IP 可能低估独立需求；Other 名称按原样区分。去重仅针对所选时间范围，明细保留每次提交。JSON 包含 `ranking` 与完整 `feedback`；CSV 为统一表头，通过 `record_type=ranking|feedback` 区分两类行，数组/诊断使用 JSON，文本字段转义引号、逗号、换行及表格公式前缀。

## 隐私

- `feedback` 不存原始 IP，只存服务器 secret 的 SHA-256 HMAC；用于限流和去重。更换 secret 会使新旧 IP 哈希无法关联。
- `user_id` 可空；`contact_email` 仅在明确同意联系且账号绑定邮箱时由服务端提取，忽略客户端邮箱字段。匿名或无邮箱账号不能提供自填联系邮箱。
- iOS 联系开关只在已登录且有邮箱时显示，默认关闭，界面打码。诊断默认开启，可关闭并预览；仅包含 `appVersion`、`build`、`osVersion`、`deviceModel`（machine 标识）、`bridgeVersion`（连接时）、`enabledAgents`（claude/codex/workbuddy）、`locale`，字符串最多 64 个码点。服务端丢弃其他诊断字段，对白名单内错误类型/超长值返回 400。
- 自动诊断不采集路径、会话、手机号、token。留言和 Other 由用户输入；用户应自行避免填写秘密。服务日志只记录反馈 ID、kind、agents，不记录留言或邮箱；邮件失败不输出异常详情。
- 数据库和通知邮件保存完整留言及获准的联系邮箱；JSON/CSV 导出同样包含这些字段。当前没有自动删除或保留期限清理，负责人应按实际需求管理保存与导出文件。

## 本地验证

server：`npm run typecheck && npm test && npm run bundle`；bridge：`npm run typecheck && npm test`。HTTP 测试在禁止监听的沙箱中使用原生请求/响应内存流，SMTP 使用假 transport，不连接真实服务。

iOS 独立单测（仓库根目录）：

```sh
xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors \
  -module-cache-path /tmp/aa-swift-cache -D AA_FEEDBACK_UNIT_TESTS \
  ios/AgentAnywhere/Models/{Protocol,PairedMac,Feedback}.swift \
  ios/AgentAnywhere/Networking/{AccountClient,BonjourDiscovery}.swift \
  ios/AgentAnywhere/Tests/FeedbackTests.swift -o /tmp/aa-feedback-tests
/tmp/aa-feedback-tests
```

单测覆盖请求校验、Unicode 边界、诊断白名单、诊断关闭、邮箱不入请求及匿名/登录请求。
