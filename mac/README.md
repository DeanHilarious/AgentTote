# AgentAnywhere for Mac

A SwiftUI menu bar app for macOS 14 or later. It starts and owns one bridge process, using the bridge's `--ipc` stdin/stdout NDJSON protocol. No third-party Swift packages are required.

## Development

From the repository root, install the bridge's dependencies once (`cd bridge && npm install`), then:

```sh
cd mac
swift build
swift test
cd ..
AA_BRIDGE_NODE=/opt/homebrew/bin/node \
AA_BRIDGE_SCRIPT="$PWD/bridge/src/index.ts" \
AGENTANYWHERE_HOME="$(mktemp -d /tmp/agentanywhere-mac.XXXXXX)" \
mac/.build/debug/AgentAnywhere
```

You can also open `mac/Package.swift` in Xcode and set these environment variables in the executable's run scheme. A `.ts` entry point automatically receives `--no-warnings`. Development TypeScript requires Node 23.6 or newer. To use the existing bundle, run `npm run bundle` in `bridge/`, then set `AA_BRIDGE_SCRIPT` to its absolute `dist/bridge.mjs` path.

The app has no Dock icon. Use its menu bar icon to open Pairing, Account, Settings or Logs, restart the bridge or quit. Closing a window leaves the bridge running. Quit sends `shutdown`, escalates to SIGTERM after three seconds, and uses SIGKILL after another two seconds if needed. A forced app exit closes stdin; the bridge handles EOF itself.

If a restricted environment blocks the default SwiftPM caches or manifest sandbox, use writable local caches:

```sh
cd mac
mkdir -p .build/swiftpm/{config,security,cache} .build/module-cache
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift build --disable-sandbox --cache-path .build/swiftpm/cache \
  --config-path .build/swiftpm/config --security-path .build/swiftpm/security
```

Use the same environment and options with `swift test`. Tests include real `/bin/sh` subprocess fixtures; they require permission to execute subprocesses, but do not require Node or network access.

## Runtime and configuration

| Variable | Purpose |
| --- | --- |
| `AA_BRIDGE_NODE` | Absolute path to a development Node executable. |
| `AA_BRIDGE_SCRIPT` | Absolute path to the bridge's `.ts` entry point or `.mjs` bundle. |
| `AGENTANYWHERE_HOME` | Optional configuration directory instead of `~/.agentanywhere/`. |
| `AA_SERVER_URL` | Optional account-server override. The bridge reapplies this override on every start; unset it to keep changes made in Account across restarts. |

The app prefers `Bundle.main` resources `node` and `bridge/bridge.mjs`, falling back to the development variables. The child inherits the app's environment. WorkBuddy connects through the app’s Connect WorkBuddy window: open CodeBuddy API Keys, copy a key, then Verify and Save. Clipboard autofill runs when the app becomes active; the key is held only in the secure field until verification. The bridge saves verified keys privately in `~/.agentanywhere/workbuddy.json` (0600). Disconnect WorkBuddy in Settings removes the key.


The app and Terminal bridge share configuration, pairing tokens and account sign-in. Do not run both against the same port. The app deliberately stops automatic retries on `port_in_use`; stop the Terminal bridge, or choose **Remove old login item**, then **Retry**. Removing the old item invokes the existing bridge CLI's `--uninstall-login-item`; it does not disable the app's own **Launch at login** setting.

**Launch at login** uses `SMAppService.mainApp`. It is disabled when running the Swift Package executable outside an `.app` bundle. Registration may require approval in System Settings. Install the packaged app in `/Applications` before enabling this setting. `SMAppService.mainApp` registers the enclosing app, without a development executable path.

## Protocol details

`bridge/src/ipc.ts`, `config.ts`, `types.ts` and `account.ts` define the wire schema. Compared with the design document's abbreviated table:

- Phone login uses `channel: "sms"`; hosts are `{ address, kind: "lan" | "tailscale" }` objects.
- `config.set` returns `restartRequired` but emits no config event. After saving, the app calls `status` to refresh the name and pairing QR. The returned port is the running port, so a saved new port appears only after restart.
- `pairing.rotate` returns `{ pairingUrl }`; the app also refreshes `status` afterward.
- A revoked account can retain its user during a device ownership conflict. Both 401 and 409 use the `revoked` state; use Sign out to start a new sign-in.

Pairing URLs are displayed only in Pairing. Logs retain at most 1000 lines, label stderr separately, redact known current and retired pairing tokens, and never print malformed IPC payloads.

## Source layout

- `Sources/AgentAnywhereMac/App.swift`: menu bar and four window scenes, application lifecycle.
- `BridgeProcess.swift`: runtime lookup, pipes, requests, automatic restart, graceful shutdown.
- `IPC.swift`: wire types, incremental line splitting, request tracking and backoff.
- `BridgeModel.swift`: observable state, event handling, logs and config/pairing actions.
- `SystemActions.swift`: login item registration, Terminal sign-in, legacy item removal.
- `Views/`: menu panel, pairing, account, settings and logs.
- `Tests/AgentAnywhereMacTests/`: wire/state tests and real subprocess lifecycle tests.

## Build an installable app

From the repository root, after `npm --prefix bridge install`:

```sh
mac/scripts/build-app.sh
```

This produces `mac/dist/AgentAnywhere.app` and `mac/dist/AgentAnywhere-<version>.dmg` with an Applications shortcut. The version comes from `bridge/package.json`. Swift builds for arm64 and x86_64, falling back to the host architecture with a message if the universal build fails. Official **Node 22.23.0 LTS** archives for both macOS architectures are cached in `mac/.build/node-cache/`; every build checks each archive against the release directory's HTTPS `SHASUMS256.txt` before extraction. Universal apps include a `lipo`-combined Node; fallback apps include the matching Node. Network/download/checksum failures stop the build. Build prerequisites: Xcode command line tools, npm and a development Node capable of running the bridge build script (23.6+ for source tests).

The default signature is ad-hoc. For Developer ID distribution:

```sh
SIGN_IDENTITY="Developer ID Application: Your Name (YOURTEAMID)" mac/scripts/build-app.sh
```

The Node helper gets `com.apple.security.cs.allow-jit` for Apple Silicon V8's MAP_JIT code generation and `com.apple.security.cs.allow-unsigned-executable-memory` for Intel V8's executable page permission changes. An arm64-only fallback build removes the Intel exception. Library validation remains enabled because the bridge has no native addons. The Swift app has no exception entitlements. Developer ID signatures use hardened runtime and a secure timestamp; ad-hoc builds use hardened runtime without a timestamp. The build verifies signatures, exercises Node JIT and runs the bundled bridge's help command after signing.

For notarization, first save your own credentials in **your macOS Keychain** interactively:

```sh
xcrun notarytool store-credentials AgentAnywhere-notary
```

Enter your Apple ID, app-specific password and Team ID `YOURTEAMID` when prompted. Do not put passwords, certificates or keychain exports in this repository. Then build:

```sh
SIGN_IDENTITY="Developer ID Application: Your Name (YOURTEAMID)" \
NOTARY_PROFILE=AgentAnywhere-notary mac/scripts/build-app.sh
```

The script waits for app notarization, staples the app, creates and signs the DMG, then notarizes and staples the DMG. Any rejection stops the build. Without `NOTARY_PROFILE`, Gatekeeper may reject a Developer ID build as unnotarized. Ad-hoc builds are for local testing. Check with `codesign --verify --deep --strict mac/dist/AgentAnywhere.app` and `spctl -a -vv mac/dist/AgentAnywhere.app`.

SwiftPM's font bundle lives in `Contents/Resources`; font loading resolves that installed location before the development `Bundle.module` fallback. The bridge runtime also resolves entirely inside `Contents/Resources`. The generated `.app` uses `SMAppService.mainApp` for Launch at login; no LaunchAgent or development path is needed. Test registration from `/Applications`, approving it in System Settings if requested.

## Keep Mac awake

Settings → Bridge → **Keep Mac awake** offers Off, On power adapter (default), and Always; click Save to persist the choice in `bridge.json` immediately. The bridge owns `/usr/bin/caffeinate -s -w <pid>` on power or `-i -w <pid>` always. Unexpected helper exits log a warning and retry after 30 seconds, then back off up to five minutes. The menu badge appears only while the helper runs and, for On power adapter, AC power is present. Closing the lid still sleeps the Mac unless an external display is connected; sleeping Macs cannot accept phone connections. CLI: `--keep-awake off|onPower|always` (remembered). IPC `status`/`ready` include `keepAwake` and `keepAwakeActive`; `keepAwake` events report helper lifecycle changes.

Packaging orchestration tests (simulated downloads/signing/notarization, real SHA256 and archive checks): `python3 mac/Tests/PackagingTests.py`. These cover layout, native fallback, cache reuse/corruption, signing order and notarization acceptance; they do not replace a real Developer ID/Gatekeeper launch check.

## 发布更新

以下命令从仓库根目录运行。首次在**发版机**生成 OTA 密钥（不要在 CI 日志、聊天或仓库中展示私钥）：

```sh
mac/scripts/ota-keygen.sh
```

私钥默认写入 `~/.agentanywhere/ota/ed25519-private.pem`，权限必须为 `600`；可通过 `OTA_PRIVATE_KEY` 指定仓库外的路径。公钥写入 `mac/ota-public-key.txt`，格式为原始 32 字节的 base64，可加入版本管理。脚本拒绝覆盖已有公钥或私钥。**请离线安全备份私钥；丢失后，已安装客户端无法接受新密钥签名的更新，用户需要手动安装含新公钥的版本。** 不能只更换网站上的清单来轮换公钥。

客户端启动约 10 秒后检查，之后每 6 小时检查，也可从菜单或设置中选择 **Check for Updates…**。验证 Ed25519 签名后才使用清单，拒绝非 HTTPS、不同 host/port、带凭据的 URL 和所有重定向。下载显示进度并支持取消；下载大小和 SHA-256、App 深度签名、Team ID、bundle ID、版本/build、最低系统版本全部通过后，才停止 bridge 并启动独立安装脚本。系统通知权限被拒绝不影响菜单提示。

ad-hoc/无 Team ID、App Translocation、只读卷、`/Volumes/` 下的 App（保守地包括外置盘）、不可写安装目录均只显示 **Download from website**。推荐安装在可写的 `/Applications` 或 `~/Applications`，不弹出提权安装提示。

更新先在安装目录所在磁盘暂存并复核签名，再等待旧进程退出、重命名旧 App、新 App 替换、`open` 启动；替换或启动命令失败则恢复旧 App。旧进程 120 秒内未退出则放弃替换。安装日志在 `~/Library/Caches/<bundle-id>/Updates/install.log`。成功后旧 App 留在安装目录下 `.AgentAnywhere-update-<UUID>/previous.app`，确认新版可用后可手动删除该备份目录。`open` 成功不代表新进程健康；本轮没有实现崩溃后自动回滚，也没有单独的 `rollback-mac.sh`。如需撤回有问题的版本，应将修复/旧代码重新构建为更高版本或构建号再签名发布，或手动恢复备份；客户端拒绝降级。

离线验收（测试使用临时密钥及模拟下载、公证、安装工具，不使用真实发布私钥）：

```sh
swift build --package-path mac --disable-sandbox
swift test --package-path mac --disable-sandbox
python3 mac/Tests/PackagingTests.py
node --test deploy/ota-manifest.test.mjs
bash -n mac/scripts/build-app.sh
bash -n mac/scripts/ota-keygen.sh
bash -n mac/Sources/AgentAnywhereMac/Resources/install-update.sh
npm --prefix bridge test
```

若执行环境禁止写入 SwiftPM 用户缓存，使用本文 Development 一节的仓库内缓存设置；从仓库根目录也可逐条运行：

```sh
mkdir -p mac/.build/module-cache mac/.build/swiftpm/config mac/.build/swiftpm/security mac/.build/swiftpm/cache
env CLANG_MODULE_CACHE_PATH="$PWD/mac/.build/module-cache" SWIFTPM_MODULECACHE_OVERRIDE="$PWD/mac/.build/module-cache" swift build --package-path mac --disable-sandbox --cache-path mac/.build/swiftpm/cache --config-path mac/.build/swiftpm/config --security-path mac/.build/swiftpm/security
env CLANG_MODULE_CACHE_PATH="$PWD/mac/.build/module-cache" SWIFTPM_MODULECACHE_OVERRIDE="$PWD/mac/.build/module-cache" swift test --package-path mac --disable-sandbox --cache-path mac/.build/swiftpm/cache --config-path mac/.build/swiftpm/config --security-path mac/.build/swiftpm/security
```

首次真实发布前，仍需用两个 Developer ID 签名且公证的构建，在测试 Mac 验证通知点击、下载取消、同日升级、bridge 退出、原路径替换与重启，并验证只读位置的下载回退。离线通过不代表已完成 Gatekeeper、服务器/nginx 或生产 OTA 验收。

## Cursor

Install the official Cursor Agent CLI and sign in with `cursor-agent login` on the Mac.
AgentAnywhere detects `CURSOR_BIN`, `~/.local/bin/cursor-agent`, or `cursor-agent` on PATH.
The iPhone app can start Cursor chats, select a model, continue a saved chat, view replies, and stop a task.
Only chats started through AgentAnywhere appear in its Cursor list; existing editor/CLI history is not imported.
The Cursor CLI manages its own conversation, while AgentAnywhere stores the working directory and displayed messages
in its private configuration directory. No Cursor credentials or private chat databases are copied.

Read only uses Cursor plan mode. Edit files uses normal print mode with sandboxing and the user's existing
Cursor permission rules; an unrestricted global approval mode must be changed manually or Full access explicitly selected.
Full access passes `--force`, still subject to Cursor deny rules and team policy. AgentAnywhere does not edit Cursor settings.
Official references: [headless execution](https://cursor.com/docs/cli/headless),
[stream format](https://cursor.com/docs/cli/reference/output-format),
[permissions](https://cursor.com/docs/cli/reference/permissions).

Cursor requires an iPhone build that declares the `cursor` capability. Older iPhone builds continue using their supported
agents without seeing Cursor; updating the Mac alone does not add the Cursor entry to an already shipped iPhone app.
