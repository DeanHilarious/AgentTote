# AgentAnywhere 云端中转（Relay）设计

## 目标

手机不在 Mac 所在的网络、也没装 Tailscale 时，仍能控制 Mac 上的 agent。

- 中转服务部署在自有公网服务器：`https://agent-anywhere.nuts-claw.tech`，与账号服务同一进程。
- **端到端加密**：服务器只转发密文，看不到代码、对话、任务结果。
- 连接优先级不变：局域网 → Tailscale → 中转。能直连就不走中转。
- 中转是**账号功能**：手机和 Mac 必须登录同一账号（服务器要知道把手机接到哪台 Mac，并做授权）。只扫码配对、未登录的 Mac 不走中转。

## 总体结构

```
iPhone ──wss /v1/relay/phone?device=ID──┐
                                        │  账号 + 中转服务（Node，127.0.0.1:8790）
Mac bridge ──wss /v1/relay/bridge───────┘  ← nginx (TLS, agent-anywhere.nuts-claw.tech)
          （bridge 主动外连，长连接，多路复用多个手机通道）
```

服务器对每个通道只做三件事：认证两端、配对、按通道转发不透明的二进制帧。

## 服务端（`server/`）

### 设备公钥
- `devices` 表新增可空列 `public_key`（启动时若缺列则 `ALTER TABLE` 补上）。
- `PUT /v1/devices/:id` 接受 `publicKey`（base64url 编码的 32 字节 X25519 公钥，严格校验长度与字符集）。
- `GET /v1/devices` 每台设备额外返回 `publicKey`（可能为 null）和 `relayOnline`（该设备当前是否有中转长连接）。

### Bridge 端点 `GET /v1/relay/bridge?device=<id>`（WebSocket）
- 头 `Authorization: Bearer <access token>`；校验 access token（签名、类型、过期），且 `device` 属于该用户。
- 每台设备只保留一条：新连接替换旧连接（旧的以 close code 4000 `replaced` 关闭）。
- 服务器每 25 秒 ping，60 秒无 pong 断开。
- 设备被删除（`DELETE /v1/devices/:id`）时立即关闭其中转连接和所有通道。

### 手机端点 `GET /v1/relay/phone?device=<id>`（WebSocket）
- 头 `Authorization: Bearer <access token>`；设备须属于该用户。
- 该设备没有在线的 bridge 中转连接时，以 close code 4404 `bridge_offline` 关闭。
- 分配通道号（uint32，每个 bridge 连接内递增），通知 bridge 打开通道，之后双向转发。

### 服务器 ↔ bridge 帧格式（WebSocket 二进制消息）
```
byte 0      类型：1 = OPEN, 2 = DATA, 3 = CLOSE
byte 1..4   通道号 uint32 大端
byte 5..    负载（OPEN/CLOSE 为空；DATA 为手机发来的/发往手机的原始二进制消息）
```
- 手机 ↔ 服务器之间就是普通二进制消息，不加头。
- 任一侧关闭：服务器关闭另一侧对应的通道 / 发送 CLOSE。

### 限制与日志
- 单条消息上限 1 MiB；每台设备同时最多 8 个手机通道；手机升级请求按 IP 限速（每分钟 60 次）。
- 某一侧 `bufferedAmount` 超过 4 MiB 视为对端过慢，关闭该通道。
- **绝不记录负载**，只记录连接元数据（设备 id、通道号、打开/关闭、原因）。
- 新增依赖 `ws`；`npm run bundle` 用 esbuild 打成 `dist/server.mjs` 便于部署。

## 端到端加密（v1）

### 密钥
- 每个 bridge 有长期 X25519 身份密钥，保存在 `~/.agentanywhere/identity.key`（0600，JSON：`{"privateKey": base64url(32B)}`）。
- 公钥（32 字节，base64url）：
  - 写进扫码配对链接 `pk=…` —— 手机**固定**（pin）该 Mac 的公钥；
  - 随设备注册上报账号服务 —— 只用账号的手机从 `GET /v1/devices` 获取（信任账号服务，首次使用即信任）。
  - 若同一 deviceId 既有扫码固定的公钥又有账号返回的公钥且二者不同：**拒绝走中转**并提示 "This Mac's security key changed"。

### 握手（每个手机通道一次）
记号：`X25519(a, B)` 为共享密钥；`||` 拼接；`deviceId` 取 UUID 的 16 字节原始值；`s` 为 bridge 静态密钥。

1. 手机生成临时密钥 `e1`，发送：`0x01 || e1_pub(32)`。
2. bridge 生成临时密钥 `e2`，计算
   - `dh1 = X25519(s_priv, e1_pub)`，`dh2 = X25519(e2_priv, e1_pub)`（任一为全 0 则中止）
   - `transcript = "AA-RELAY-1" || deviceId || s_pub || e1_pub || e2_pub`
   - `okm = HKDF-SHA256(ikm = dh1 || dh2, salt = SHA256(transcript), info = "aa relay v1 keys", L = 64)`
   - `k_p2b = okm[0..32]`，`k_b2p = okm[32..64]`
   - 发送：`0x01 || e2_pub(32) || ChaCha20-Poly1305(k_b2p, nonce = N(0), aad = transcript, plaintext = "AA-RELAY-OK")`
3. 手机算出同样的密钥（`dh1 = X25519(e1_priv, s_pub)`，`dh2 = X25519(e1_priv, e2_pub)`），验证上面的密文 —— 证明对方持有 `s_priv`（服务器无法冒充）。

### 传输
- `N(c) = 4 字节 0 || uint64 大端 c`。每个方向独立计数：手机→bridge 从 0 开始，bridge→手机从 1 开始（0 已用于确认消息）。
- 每条消息：`ChaCha20-Poly1305(k, N(counter), aad = 空, plaintext = UTF-8 JSON)`，发送 `ciphertext || tag(16)`。
- 接收方计数必须严格等于期望值，否则关闭通道（防重放/乱序）。
- 明文就是现有直连 WebSocket 上的 JSON 消息（请求、响应、推送），bridge 内部复用同一套 RPC 处理。

### 应用层认证
- 加密通道建立后，手机发送的第一条明文必须是 `{"auth": "<连接票据>"}`（与直连时相同的票据，从 `POST /v1/devices/:id/ticket` 获取）。
- bridge 用现有离线校验逻辑验证票据（设备 id、用户、服务器公钥、过期），成功回 `{"auth":"ok"}`，失败回错误并关闭通道。

### 测试向量
bridge 实现生成固定私钥的握手与前三条传输消息的测试向量，写入 `docs/relay-test-vectors.json`；iOS 实现必须逐字节一致。

## Bridge（`bridge/`）
- 身份密钥加载/生成；配对链接加 `pk`；设备注册上报 `publicKey`。
- `RelayClient`：已登录账号时保持到 `/v1/relay/bridge` 的长连接（access token 由 `AccountClient` 提供并按需刷新），退避重连 1/2/5/10/30 秒；登出、设备被删时停止。
- 每个通道一个加密会话；认证后接入与本地 WebSocket 客户端相同的 RPC 与推送广播（把 `server.ts` 里的客户端抽象成"传输"，本地 WebSocket 与中转通道都实现它）。
- IPC 事件 `relay`：`{ state: "off" | "connecting" | "online" | "error", channels }`；Mac App 菜单显示中转状态。

## iOS
- `RelayCrypto`（CryptoKit：`Curve25519.KeyAgreement`、`HKDF<SHA256>`、`ChaChaPoly`），通过测试向量。
- `BridgeClient` 抽象传输：直连 WebSocket / 中转 WebSocket + 加密。
- 连接顺序：直连地址（每个地址 3 秒超时）→ 若该 Mac 属于账号、有公钥且 `relayOnline` → 中转。
- 扫码链接里的 `pk` 存进 `PairedMac.publicKey`（固定公钥）。
- 首页连接状态显示 `Connected · via relay` 或直连地址；只扫码配对的 Mac 直连失败时提示 "Sign in to reach this Mac away from home"。
- 默认账号服务器改为 `https://agent-anywhere.nuts-claw.tech`（bridge 默认 `serverUrl` 同步修改）。
