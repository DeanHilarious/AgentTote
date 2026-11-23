# AgentAnywhere 账号服务

HTTP JSON 账号服务与 WebSocket 中转服务，负责手机号密码/邮箱验证码登录、账号身份、Mac 设备目录、连接票据和不透明二进制转发。服务器不参与中转负载的加解密。设计背景见 [中转设计](../docs/relay-design.md)。需要 Node ≥ 23.6，可直接运行 TypeScript，也可打成单文件部署。

## 启动与验证

仓库中的依赖已安装，无需新增依赖：

```sh
cd server
npm run typecheck
npm test
npm start
```

单文件打包（已有 esbuild，无需安装依赖）：

```sh
npm run bundle
node dist/server.mjs
```

产物为 Node ESM，包含运行时依赖，使用 `createRequire` banner；`bufferutil`、`utf-8-validate` 为可选原生加速依赖，保留为 external，未安装时 ws 使用纯 JS。运行机器仍须支持 `node:sqlite`，推荐与源码相同的 Node ≥ 23.6；`target: node22` 仅指定打包语法目标。`dist/` 不入 git。

默认监听 `0.0.0.0:8790`：

```sh
curl http://localhost:8790/v1/health
# {"ok":true}

curl -X POST http://localhost:8790/v1/auth/code \
  -H 'Content-Type: application/json' \
  -d '{"channel":"email","target":"review@example.com"}'
```

开发默认把验证码输出到控制台；取到验证码后调用 `/v1/auth/verify`。临时数据目录启动：

```sh
AA_DATA_DIR="$(mktemp -d)" npm start
```

测试优先使用 `listen(0)` 和真实 HTTP 请求。如果沙箱拒绝监听并返回 `EPERM`，自动改用内存流驱动同一 `IncomingMessage` / `ServerResponse` 请求处理，并输出诊断。该路径仍检查 HTTP 状态、响应头、请求体限制及数据库行为，但不能证明操作系统端口可达。

新增 WebSocket 监听测试默认跳过；在允许监听的环境执行 `AA_TEST_LISTEN=1 npm test`，使用真实 ws 客户端验证认证、转发、替换、删除、通道上限、消息大小与代理 IP 限流。帧、公钥、数据库迁移、丢弃计数、背压和模拟时钟存活测试无需监听，默认执行。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8790` | 监听端口，允许 `0` 分配临时端口 |
| `AA_HOST` | `0.0.0.0` | 监听 IP；同机 nginx 部署用 `127.0.0.1`，也支持 IPv6 IP |
| `AA_TRUST_PROXY` | 关闭 | `1` / `true` 开启；仅在服务确实位于可信代理之后、且该代理向 XFF 末尾追加客户端地址时开启 |
| `AA_DATA_DIR` | `server/data` | 默认相对源码定位，与启动工作目录无关；显式相对路径基于当前工作目录 |
| `AA_SERVER_SECRET` | 开发时生成 | 验证码 HMAC 密钥，至少 32 字节 |
| `AA_SIGNING_KEY` | 开发时生成 | Ed25519 PKCS#8 PEM 私钥内容，须包含真实换行，不是文件路径 |
| `AA_EMAIL_SENDER` | `console` | `console` 或 `smtp` |
| `AA_SMS_SENDER` | `console` | 保留配置；短信验证码 API 暂时停用 |
| `AA_SMTP_URL` | 无 | `smtp` 模式必填，nodemailer SMTP URL |
| `AA_MAIL_FROM` | 无 | `smtp` 模式必填，发件人地址 |
| `AA_TEST_ACCOUNTS` | 空 | 如 `email:review@example.com=123456`；短信测试码不能绕过停用限制 |
| `NODE_ENV` | 无 | `production` 时要求显式配置两项密钥 |

开发生成的 `server-secret` 和 `signing-key.pem` 存入数据目录，文件权限为 `0600`，重启复用；使用时提示“开发密钥，勿用于生产”。SQLite 文件为 `account.sqlite`，启用 WAL 和外键。生产环境在 HTTPS 反向代理后部署，显式提供密钥和真实发送渠道。

单文件生产部署需设置 `NODE_ENV=production`、`AA_HOST=127.0.0.1`、`PORT=8790`、`AA_DATA_DIR=/opt/agentanywhere/data`、`AA_TRUST_PROXY=1`，并通过权限为 `0600` 的环境文件提供 `AA_SERVER_SECRET`、`AA_SIGNING_KEY`；邮箱发送另需 `AA_EMAIL_SENDER=smtp`、`AA_SMTP_URL` 和 `AA_MAIL_FROM`。显式设置数据目录可避免移动单文件后改变数据位置。nginx 须转发 `Upgrade` / `Connection`、保留 `Authorization`，并在 XFF 末尾追加实际客户端 IP；长连接设置 `proxy_read_timeout 3600s`，外部使用 HTTPS/WSS。

测试账号仍须先申请验证码，遵循相同的过期、尝试次数、单次消费和限流规则，只是不调用 sender。

## 接口

所有路径以 `/v1` 为前缀。需要鉴权的接口传 `Authorization: Bearer <accessToken>`。有请求体时使用 `Content-Type: application/json`；只接受 JSON 对象，最大 64 KiB。

| 方法 | 路径 | 鉴权 | 请求 / 响应 |
| --- | --- | --- | --- |
| POST | `/auth/register` | 无 | `{phone,password,deviceLabel?}` → `{accessToken,refreshToken,user,isNewUser:true}` |
| POST | `/auth/password` | 无 | `{phone,password,deviceLabel?}` → `{accessToken,refreshToken,user,isNewUser:false}` |
| POST | `/auth/code` | 无 | `{channel,target,purpose?}` → `{expiresIn:300,resendAfter:60}` |
| POST | `/auth/verify` | 无 | `{channel,target,code,deviceLabel?}` → `{accessToken,refreshToken,user,isNewUser}` |
| POST | `/auth/refresh` | 无 | `{refreshToken}` → `{accessToken,refreshToken}` |
| POST | `/auth/logout` | 无 | `{refreshToken}` → `{ok:true}`，吊销该令牌所属会话族，可重复调用 |
| GET | `/me` | access | `{id,phone?,email?,createdAt,hasPassword}` |
| POST | `/me/password` | access | `{currentPassword?,newPassword}` → 更新后的用户；已设密码时必须提供正确的旧密码 |
| POST | `/me/phone` | access | `{phone,password}` → 更新后的用户；未设密码时同时设密码，已有密码时须匹配 |
| POST | `/me/identities` | access | `{channel,target,code}` → 更新后的用户；验证码必须以 `purpose:"bind"` 申请 |
| GET | `/devices` | access | `{devices:[{id,name,hosts,port,bridgeVersion,lastSeenAt,createdAt,online,publicKey,relayOnline}]}` |
| PUT | `/devices/:id` | access | `{name,hosts,port,bridgeVersion,publicKey?}` → 设备对象；同用户重复调用更新心跳及可变字段 |
| DELETE | `/devices/:id` | access | `{ok:true}` |
| POST | `/devices/:id/ticket` | access | 空请求体或 `{}` → `{ticket,expiresIn:300}` |
| GET | `/keys` | 无 | `{ed25519PublicKey:"-----BEGIN PUBLIC KEY-----..."}` |
| GET | `/health` | 无 | `{ok:true}` |

`channel` 当前仅接受 `email`；`/auth/code`、`/auth/verify`、`/me/identities` 的 `sms` 请求统一返回 400 `sms_disabled`。`purpose` 是 `login`（默认）或 `bind`。邮箱去首尾空白并转小写，不移除内部空白；手机号接受 E.164，11 位中国手机号自动加 `+86`。设备 UUID 统一为小写；`hosts` 是 1–32 个地址/主机名，`port` 为 1–65535 的整数。

数据库与用户/设备 JSON 时间戳为 Unix 毫秒；令牌 `iat` / `exp` 为 Unix 秒。设备最后心跳距离当前时间小于 120 秒时 `online:true`。

`publicKey` 是 32 字节公钥的规范 base64url（43 个字符，无 `=` 填充）；错误字符、非规范尾部位、错误长度或 null 返回 400 `invalid_request`。未登记时返回 null；更新请求省略该字段会保留原值。旧数据库启动时自动补充可空 `public_key` 列。`relayOnline` 仅表示当前进程中该设备的 bridge WebSocket 在线，与设备 HTTP 心跳 `online` 独立。

错误示例：

```json
{"error":{"code":"rate_limited","message":"Too many requests","retryAfter":60}}
```

错误码包括 `invalid_request`、`invalid_target`、`invalid_code`、`sms_disabled`、`weak_password`（400），`unauthorized`、`invalid_credentials`（401），`not_found`（404），`conflict`、`phone_taken`（409），`body_too_large`（413），`rate_limited`（429），`delivery_failed` / `internal_error`（500）。429 同时提供 HTTP `Retry-After` 头和 `error.retryAfter` 秒数。验证码错误、过期、不存在、已消费和尝试耗尽统一为 `invalid_code`。

## 手机号密码认证

手机号仍用现有 E.164 / +86 规范化规则。密码只校验 8–128 个 Unicode 字符的长度，允许纯数字、空白及其他字符；不会 trim 密码。数据库只保存 `scrypt$16384$8$1$<16 字节盐的 base64url>$<64 字节哈希的 base64url>`，每次使用独立随机盐，校验使用 `timingSafeEqual`。启动时为旧 `users` 表安全补充可空 `password_hash` 列，已有用户保持无密码状态。

注册在同一事务内创建用户、未验证的手机号身份（`verified_at:0`）和会话。绑定手机号同样原子写入身份和密码；已绑定相同手机号可重复调用，不能替换已有手机号。手机号暂不验证归属，接入短信后再补验证。注册/绑定时已占用的手机号返回 409 `phone_taken`。登录时手机号不存在、密码错误、账号未设密码均返回相同的 401 `invalid_credentials`；未知手机号和未设密码账号也执行一次 scrypt。邮箱账号可用 `/me/password` 先设置密码，或直接用 `/me/phone` 同时绑定手机号和设置密码。

注册按 IP 滚动一小时限 10 次；密码登录失败按规范化手机号滚动 15 分钟限 10 次、按 IP 滚动一小时限 60 次。登录成功清零该手机号失败计数，保留该 IP 之前的失败计数。SQLite 保存计数，重启仍有效；异步 scrypt 开始前预占额度，成功后释放该次登录额度。超额返回 429 `rate_limited`，带 `error.retryAfter` 与 `Retry-After` 秒数。IP 信任规则与验证码一致。

请求示例（所有密码均为示例值）：

```http
POST /v1/auth/register
Content-Type: application/json

{"phone":"13800138000","password":"example-pass","deviceLabel":"My Mac"}
```

```http
POST /v1/auth/password
Content-Type: application/json

{"phone":"13800138000","password":"example-pass"}
```

```http
POST /v1/me/password
Authorization: Bearer <accessToken>
Content-Type: application/json

{"currentPassword":"example-pass","newPassword":"another-pass"}
```

```http
POST /v1/me/phone
Authorization: Bearer <accessToken>
Content-Type: application/json

{"phone":"13800138000","password":"example-pass"}
```

客户端密码仅用于请求，不写入 Keychain、UserDefaults、账号文件、日志或用户缓存。CLI 选 1 输入手机号和密码；在密码提示输入 `r` 进入注册并确认两次密码，终端密码输入不回显，管道输入仍按行读取。选 2 保留邮箱验证码流程。

## WebSocket 中转

两端均通过 HTTP GET 升级，必须携带 `Authorization: Bearer <accessToken>`（不接受 connect 票据或查询参数 token），且 `device` 为当前用户的设备 UUID：

- bridge：`wss://<host>/v1/relay/bridge?device=<UUID>`，每设备一条长连接。
- 手机：`wss://<host>/v1/relay/phone?device=<UUID>`，每台设备最多 8 个手机通道。

升级前拒绝：401 `unauthorized`（缺失、错误类型、验签失败或过期 token），403 `forbidden`（别人的设备），404 `not_found`（未知路径、缺失/无效/重复 device 参数或设备不存在），429 `rate_limited`（手机升级超过 IP 配额，包含 `Retry-After`）。响应后销毁 socket，不升级。手机尝试按滚动一分钟限 60 次，认证失败与 bridge 离线的尝试也计数；bridge 升级不受这个配额限制，`AA_TRUST_PROXY` 的取 IP 规则与验证码 HTTP 接口相同。

服务器与 bridge 的二进制消息格式为 `type:u8 | channel:u32be | payload`，头部共 5 字节：`1=OPEN`、`2=DATA`、`3=CLOSE`，OPEN/CLOSE 无负载。通道从每条 bridge 连接内的 1 递增，关闭后不复用，不回绕 uint32；手机只收发原始二进制消息，不含该头部。例如：

```text
01 00 00 00 01          OPEN 通道 1
02 00 00 00 01 00 ff   DATA 通道 1，负载为 00 ff
03 00 00 00 01          CLOSE 通道 1
```

bridge 发来的短帧、未知类型、未知/零通道、带负载的控制帧或逆向 OPEN 均丢弃；模块 `stats().invalidBridgeFrames` 计数，不记录负载。手机关闭会向 bridge 发送 CLOSE；bridge 发 CLOSE 会关闭对应手机。新 bridge 替换旧连接时同步关闭其全部手机通道，旧连接后续事件不会影响新连接。删除设备立即移除在线状态并关闭两端连接。

| WebSocket close code | reason / 条件 |
| --- | --- |
| `4000` | `replaced`，旧 bridge 被替换（其手机通道以 1012 关闭） |
| `4404` | `bridge_offline`，手机升级后发现 bridge 离线 |
| `4429` | `too_many_channels`，第 9 个手机通道或通道号耗尽 |
| `1003` | `binary_required`，文本消息 |
| `1009` | 单条接收消息超过 1 MiB（bridge 消息上限包含 5 字节头） |
| `1013` | `backpressure`，任一侧 bufferedAmount 超过 4 MiB；关闭对应通道，保留其他通道 |
| `1012` | `bridge_disconnected`，bridge 断线后关闭手机通道 |
| `1001` | `device_deleted` / `server_shutdown` |

每个端点每 25 秒 ping，连接建立或最近一次 pong 后满 60 秒仍无 pong 则断开。日志仅包含设备 id、通道号、打开/关闭事件和服务端定义的原因；不输出令牌、负载或客户端关闭原因。中转在线表、通道和限流表均在单进程内存中，重启会断开连接，不支持多实例之间配对。

## 令牌与客户端验票

紧凑格式为 `base64url(header).base64url(payload).base64url(signature)`，无填充；头部严格为 `{alg:"EdDSA",typ:"JWT"}`。签名输入是前两段和中间的点，算法为 Ed25519。access payload 为 `{sub,typ:"access",iat,exp}`，有效期 900 秒；connect 增加 `dev` 且 `typ:"connect"`，有效期 300 秒。

导出校验函数用于后续 bridge 对照实现：

```ts
import { verifyToken } from './src/tokens.ts';

const claims = verifyToken(ticket, ed25519PublicKey, {
  typ: 'connect',
  deviceId: localDeviceId,
  userId: loggedInUserId,
  now: () => Date.now(),
});
```

校验失败抛出 `HttpError`（401）。校验包括编码、算法、原生密码学验签、类型、时间和可选的用户/设备约束。bridge 必须同时传 `deviceId` 和 `userId`；不能只验签。校验器不允许未来 `iat` 或过长有效期，双方时钟需要同步。公钥从可信 HTTPS 账号服务获取。

刷新令牌是 32 字节随机数的 base64url 编码，数据库仅存 SHA-256。每次刷新生成 30 天有效的新令牌；旧令牌重用将吊销整个 family，包括其后代；其他会话族不受影响。退出登录也吊销整个族。已有 access 和离线连接票据持续有效到各自过期，不会因退出登录或删除设备立刻失效。

## 测试注入与实现约定

`createApp(options)` 返回未监听的 Node HTTP `Server`。可注入 `db: DatabaseSync`、`now: () => number`（毫秒）、`senders: {email,sms}`、`testAccounts: Map<string,string>`，以及 `serverSecret` / `signingKey`。未传数据库时使用 `databasePath`，默认内存数据库；内部打开的数据库随 server 关闭，外部注入的数据库由调用方关闭。发送器接口见 `src/senders.ts`，仅 `smtp` 使用已有的 nodemailer。

设计稿未具体规定的行为在此明确：

- “每天最多 10 次”采用滚动 24 小时；目标 60 秒、每日额度跨 login/bind 共享，IP 每小时 30 次。默认只使用连接的 `remoteAddress`，完全忽略 `X-Forwarded-For`。开启 `AA_TRUST_PROXY` 后，仅取该头最后一个地址并去掉首尾空格；头缺失、为空或末尾地址为空时退回 `remoteAddress`。只应在可信代理之后开启，并确保客户端无法绕过代理直连服务。`createApp` 可通过 `trustProxy` 显式覆盖；未传时读取环境变量。
- 发送前预占数据库额度，发送失败保留计数并废弃该验证码；同一目标、同一用途新发码会使前一个验证码失效。
- 每个账号每种渠道最多一个身份，与 `/me` 单值 `phone` / `email` 及“绑定另一种登录方式”一致；绑定相同身份可重复验证，替换已有同渠道身份返回 409。
- 与设计稿列举的细分错误码不同，验证码失败统一 `invalid_code`，避免对外暴露验证状态。错误尝试会先持久化；成功验证码在执行账号变更前单独提交消费，即使后续绑定冲突也不能再次使用。
- 短信供应商保留明确报“未配置”的类和选择项；真实供应商凭据配置与 API 接入未包含在本次实现。
