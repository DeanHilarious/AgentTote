import { run } from './util.ts';

export interface ProcessSnapshot {
  claudeProcesses: number;
  /** Claude session ids that a live process was started with (--resume / --session-id). */
  claudeSessionIds: Set<string>;
  codexProcesses: number;
  workbuddyProcesses: number;
  antigravityProcesses: number;
  cursorProcesses: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_SESSION_ARG = new RegExp(`--(?:resume|session-id)[= ](${UUID})`);

let cache: { at: number; snap: ProcessSnapshot } | undefined;

export async function snapshotProcesses(): Promise<ProcessSnapshot> {
  if (cache && Date.now() - cache.at < 3000) return cache.snap;
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,command=']);
  const snap: ProcessSnapshot = {
    claudeProcesses: 0,
    claudeSessionIds: new Set(),
    codexProcesses: 0,
    workbuddyProcesses: 0,
    antigravityProcesses: 0,
    cursorProcesses: 0,
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const cmd = line.slice(line.indexOf(' ') + 1);
    // Executable paths may contain spaces ("Application Support"), so cut at the first flag instead.
    const exe = cmd.split(' -')[0];
    if (/(^|\/)claude$/.test(exe)) {
      snap.claudeProcesses++;
      const m = cmd.match(CLAUDE_SESSION_ARG);
      if (m) snap.claudeSessionIds.add(m[1]);
    } else if (/(^|\/)codex( (app-server|exec|resume|e))?( |$)/.test(exe) && !exe.startsWith('node ')) {
      snap.codexProcesses++;
    } else if (cmd.includes('WorkBuddy.app/Contents/MacOS/WorkBuddy') || cmd.includes('/cli/bin/codebuddy')) {
      snap.workbuddyProcesses++;
    } else if (
      (cmd.includes('Antigravity.app/Contents/MacOS/Antigravity') && !cmd.includes('Antigravity Helper')) ||
      /(^|\/)agy$/.test(exe)
    ) {
      snap.antigravityProcesses++;
    } else if (cmd.includes('Cursor.app/Contents/MacOS/Cursor') || /(^|\/)cursor-agent( |$)/.test(cmd)) {
      snap.cursorProcesses++;
    }
  }
  cache = { at: Date.now(), snap };
  return snap;
}
