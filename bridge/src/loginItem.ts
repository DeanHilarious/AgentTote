import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { augmentedEnv, HOME, run } from './util.ts';

const LABEL = 'com.agentanywhere.bridge';
const PLIST = join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = join(HOME, '.agentanywhere', 'bridge.log');

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Registers a per-user launchd agent so the bridge is up whenever you're logged in. */
export async function installLoginItem() {
  const modulePath = fileURLToPath(import.meta.url);
  const entry = modulePath.endsWith('.mjs') ? modulePath : resolve(dirname(modulePath), 'index.ts');
  const args = [process.execPath, '--no-warnings', entry];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(augmentedEnv().PATH ?? '')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });
  await writeFile(PLIST, plist);
  const uid = process.getuid?.() ?? 501;
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  const res = await run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  if (res.code !== 0) {
    console.error(`launchctl bootstrap failed: ${res.stderr.trim()}`);
    process.exit(1);
  }
  console.log(`Installed ${PLIST}\nThe bridge now starts at login. Logs: ${LOG}\nShow the pairing QR any time with: npm run pair`);
}

export async function uninstallLoginItem() {
  const uid = process.getuid?.() ?? 501;
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  await rm(PLIST, { force: true });
  console.log('Removed the AgentTote bridge login item.');
}
