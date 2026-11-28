# AgentTote (AgentAnywhere)

AgentTote is free on Mac and iPhone. Pair a Mac without a subscription or activation code. You can run the bridge locally and self-host the account and relay service. Third-party agents may charge for their own services.

The project source is available under the [MIT License](LICENSE). Bundled fonts retain their OFL licenses, and third-party names and logos belong to their respective owners.

用 iPhone 配对 Mac，查看本机编码智能体的会话、发送任务并接收结果。Mac 和 iPhone 端都可免费使用。支持 Claude Code、Codex、WorkBuddy、Antigravity 和 Cursor。

```
iPhone app (SwiftUI)  ──ws:// + token──▶  bridge (Node, on the Mac)
                                            ├─ Claude Code  →  claude -p --resume … --output-format stream-json
                                            ├─ Codex        →  codex app-server (JSON-RPC over stdio)
                                            └─ WorkBuddy    →  bundled CodeBuddy CLI, stream-json
```

MVP features:

1. **Connect** — scan the bridge's QR code; the app shows which agents are installed and how many are live.
2. **Work list** — each agent's sessions/threads (title, project folder, last activity, running dot).
3. **Send a task** — continue any session, or start a new one in a recent project folder, with a permission mode
   (Read only / Edit files / Full access).
4. **Get the result** — tool calls and replies stream back live; stop a task from the phone. Tasks keep running if
   the phone disconnects and catch up on reconnect.

## 1. Run the bridge on the Mac

For app integration, use `--ipc` for stdin/stdout NDJSON control; `cd bridge && npm run bundle` produces the standalone `dist/bridge.mjs`.

Requires Node ≥ 23.6 (runs the TypeScript directly).

```bash
cd bridge
npm install
npm start
```

It prints a QR code, the Mac's addresses, the token and an `agentanywhere://` link. Config lives in
`~/.agentanywhere/bridge.json`.

For account-based connections, run `npm run login` and follow the prompts.
Start the account service in `server/` first; `AA_SERVER_URL` overrides the remembered `serverUrl`
(set it to your own server, such as `http://localhost:8790`). Login registers this Mac under a stable `deviceId`; while running,
the bridge updates its addresses and heartbeat every 60 seconds. Refresh tokens rotate automatically
and are stored atomically in `~/.agentanywhere/account.json` with mode `0600`; access tokens stay in memory.
`AGENTANYWHERE_HOME` overrides the config directory.
Run login before starting the bridge, or restart an already running bridge after login/logout
so it reads the updated account file.

WebSocket connections accept the pairing token or an account service connection ticket via
`Authorization: Bearer …` or `?token=…`. Tickets require the signed-in user and this device, expire
within five minutes, and tolerate 60 seconds of clock skew. The public key is cached in
`server-key.pem` for offline verification and refreshed online. Account outages leave pairing available;
revoked sessions stop account heartbeats and require login again. A device belonging to another account
stops heartbeats with a diagnostic. Changing account servers requires login again to avoid sending an
old server's refresh token to the new one.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run pair` | Print the pairing QR again |
| `npm run login` / `npm run logout` | Sign in to / out of the account service (pairing remains available) |
| `npm start -- --rotate-token` | New token (un-pairs every phone) |
| `npm run install-login-item` | Start the bridge at login via launchd (logs: `~/.agentanywhere/bridge.log`) |
| `npm run workbuddy-key` | Paste, verify and save a CodeBuddy API key (hidden input); add `-- --clear` to disconnect |
| `npm test` / `npm run typecheck` | Bridge tests |

## 2. Run the iOS app

Open `ios/AgentAnywhere.xcodeproj` in Xcode 26, pick your team under *Signing & Capabilities*
(use your own bundle identifiers and matching app group for device signing), and run on your iPhone (iOS 17+).
Then tap **Scan QR code**, or point the system Camera at the QR code.

### iPhone 会话里的图表与附件

回复支持标题、列表、引用、代码块、表格和 Markdown 图片。项目内的图片由配对的 Mac 提供。使用 Mermaid 代码块可以直接在手机上查看常见流程图、饼图、柱状图和折线图，其他语法可以展开查看源码。

更新 iPhone 客户端和 Mac Bridge 后，点会话输入框旁的回形针，从「照片」或「文件」选择附件。每条消息最多 4 个，每个最大 10 MiB。可以只发附件，也可以附上问题。上传完成后，Bridge 才会用当前权限启动任务。Codex 可以直接接收图片，文档通过 Mac 上的临时文件提供给智能体。

## Mac menu bar app

The native macOS 14+ menu bar app in [`mac/`](mac/README.md) manages the bridge, pairing QR, account sign-in, settings and logs. Build with `cd mac && swift build`; see its README for development runtime environment variables and testing. Stop a Terminal or legacy login-item bridge before starting the app on the same port.

## Connecting from anywhere

On the same Wi-Fi the phone uses the Mac's LAN address. Away from home, install
[Tailscale](https://tailscale.com) on both devices: the bridge includes its Tailscale address (100.x.y.z) in the QR
code and the app tries it automatically. Keep the Mac awake (Battery → Options → *Prevent automatic sleeping when the
display is off*, or `caffeinate -s`), otherwise it's unreachable while asleep.

## Agent notes

- **Claude Code** — the bridge uses the newest Claude Code it finds (`CLAUDE_BIN`, `claude` on PATH, or the copy
  bundled with the Claude desktop app). It must be able to run on its own: `claude -p "hi"` in Terminal should work.
  If your `~/.claude/settings.json` points `ANTHROPIC_BASE_URL` at a local proxy, that proxy has to be running.
- **Codex** — uses your existing `codex` login. Threads started from the phone appear in Codex's history.
- **WorkBuddy** — drives the agent CLI shipped inside `WorkBuddy.app` with WorkBuddy's own config
  (`~/.workbuddy`). In the Mac app, choose **Connect…**, open [CodeBuddy API Keys](https://www.codebuddy.cn/profile/keys),
  copy a key, then **Verify and Save**. The app fills a newly copied key when it becomes active again; you can also use Paste.
  AgentAnywhere verifies the key in an isolated directory with read-only permissions before saving it to
  `~/.agentanywhere/workbuddy.json` (0600). It tries the domestic `internal` environment first; an authentication
  failure triggers one retry without that environment variable, and the successful setting is remembered
  (`null` means unset). Keys stay out of logs, status and IPC events. Verification can take up to three minutes.
  **Disconnect WorkBuddy** in Settings deletes the saved key. Without a connected key, iPhone sessions remain
  viewable and their task composer is disabled. For Terminal setup, run `npm run workbuddy-key` in `bridge/`
  (hidden input, also accepts piped input), or `npm run workbuddy-key -- --clear` to disconnect.
  WorkBuddy 5.6.2 removed the CLI interactive sign-in interface. Its private app login cannot be reused by
  AgentAnywhere. The bundled CLI is undocumented by Tencent, so updates may need adapter changes
  (`bridge/src/adapters/workbuddy.ts`).
- Sessions open in a desktop app keep working there; a task sent from the phone runs alongside it, and the desktop
  window may only show the new turn after you reopen the session.

## Security

The token is a 192-bit random secret, stored in the iOS Keychain. Anyone holding it can run agents on your Mac
(with Full access, any command), so:

- Traffic is plain `ws://`. On Tailscale it's encrypted by WireGuard; on untrusted Wi-Fi, prefer Tailscale.
- Rotate the token with `--rotate-token` if a phone is lost.

## Layout

```
bridge/src/
  index.ts            CLI entry, pairing QR
  server.ts           WebSocket JSON-RPC server + auth
  tasks.ts            task lifecycle, event log for reconnects
  adapters/claude.ts  ~/.claude/projects transcripts + claude -p
  adapters/codex.ts   codex app-server client
  adapters/workbuddy.ts ~/.workbuddy transcripts + bundled CLI
  adapters/streamJson.ts shared stream-json runner
ios/AgentAnywhere/
  Networking/BridgeClient.swift   WebSocket RPC client
  Models/AppModel.swift           connection, reconnect, task state
  Views/…                         pairing, agents, sessions, chat + live task view
```

### Bridge protocol

Requests `{id, method, params}` → `{id, result}` or `{id, error: {message}}`. Methods: `hello`, `agents.list`,
`sessions.list {agent}`, `sessions.messages {agent, sessionId}`, `projects.recent`,
`tasks.start {agent, sessionId? | cwd, prompt, permissionMode}`, `tasks.cancel {taskId}`, `tasks.list`,
`tasks.get {taskId, sinceSeq}`. Pushes: `{event: "task.event", data: {taskId, event}}` and
`{event: "task.updated", data: task}`. Types: `bridge/src/types.ts` ↔ `ios/AgentAnywhere/Models/Protocol.swift`.
