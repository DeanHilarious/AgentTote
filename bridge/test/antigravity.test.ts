import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AntigravityAdapter, antigravityAssistantText, antigravityUserText, parseWorkspaceUris } from '../src/adapters/antigravity.ts';
import type { TaskEventBody, TaskSink } from '../src/types.ts';

const require = createRequire(import.meta.url);

function createSummariesDb(dbPath: string, rows: Array<{
  id: string;
  title?: string;
  preview?: string;
  workspaceUris?: string;
  status?: string;
  parentId?: string;
  lastModified?: string;
}>) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      status TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      last_modified_time DATETIME NOT NULL
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, workspace_uris, status, parent_conversation_id, last_modified_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.id,
      r.title ?? '',
      r.preview ?? '',
      r.workspaceUris ?? '[]',
      r.status ?? 'CASCADE_RUN_STATUS_IDLE',
      r.parentId ?? '',
      r.lastModified ?? '2026-10-23T05:00:00Z',
    );
  }
  db.close();
}

test('antigravity transcript and workspace URI helpers', () => {
  assert.equal(
    antigravityUserText({
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: '<USER_REQUEST>\nFix the login bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>now</ADDITIONAL_METADATA>',
    }),
    'Fix the login bug',
  );
  assert.equal(
    antigravityUserText({
      type: 'USER_INPUT',
      source: 'SYSTEM',
      content: '<USER_REQUEST>ignored</USER_REQUEST>',
    }),
    undefined,
  );
  assert.equal(
    antigravityUserText({
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: '<USER_REQUEST>\n/plan Review the diff\n</USER_REQUEST>',
    }),
    'Review the diff',
  );
  assert.equal(
    antigravityAssistantText({
      type: 'PLANNER_RESPONSE',
      content: '  Here is the fix.  ',
    }),
    'Here is the fix.',
  );
  assert.equal(parseWorkspaceUris('["file:///Users/test/Project%20A"]'), '/Users/test/Project A');
});

test('AntigravityAdapter lists sessions, messages, models, and syncs desktop sessions on resume', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-antigravity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const appHome = join(dir, 'app');
  const cliHome = join(dir, 'cli');
  await mkdir(appHome, { recursive: true });
  await mkdir(cliHome, { recursive: true });

  const sessionDesktop = '11111111-2222-3333-4444-555555555555';
  const sessionCli = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sessionGhost = '99999999-9999-9999-9999-999999999999';
  const sessionSubagent = '77777777-7777-7777-7777-777777777777';

  createSummariesDb(join(appHome, 'conversation_summaries.db'), [
    {
      id: sessionDesktop,
      title: 'Desktop Feature Work',
      preview: 'Desktop Feature Work',
      workspaceUris: '["file:///Users/test/desktop-repo"]',
      lastModified: '2026-10-23T04:00:00Z',
    },
    {
      id: sessionGhost,
      title: 'Deleted Session',
      workspaceUris: '["file:///tmp/ghost"]',
      lastModified: '2026-10-23T03:00:00Z',
    },
    {
      id: sessionSubagent,
      title: 'Subagent Task',
      parentId: sessionDesktop,
      workspaceUris: '["file:///Users/test/desktop-repo"]',
      lastModified: '2026-10-23T04:30:00Z',
    },
  ]);

  createSummariesDb(join(cliHome, 'conversation_summaries.db'), [
    {
      id: sessionCli,
      title: 'CLI Bugfix',
      preview: 'CLI Bugfix',
      workspaceUris: '["file:///Users/test/cli-repo"]',
      lastModified: '2026-10-23T05:00:00Z',
    },
  ]);

  // Create desktop session files in appHome only.
  await mkdir(join(appHome, 'conversations'), { recursive: true });
  await writeFile(join(appHome, 'conversations', `${sessionDesktop}.db`), 'desktop-db-v1');
  const desktopLogs = join(appHome, 'brain', sessionDesktop, '.system_generated', 'logs');
  await mkdir(desktopLogs, { recursive: true });
  await writeFile(
    join(desktopLogs, 'transcript_full.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-10-23T04:00:00Z',
        content: '<USER_REQUEST>\nBuild the desktop feature\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-23T04:00:05Z',
        content: 'Part 1 of response.',
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-23T04:00:10Z',
        content: 'Part 2 of response.',
      }),
    ].join('\n') + '\n',
  );

  // Create CLI session transcript in cliHome.
  const cliLogs = join(cliHome, 'brain', sessionCli, '.system_generated', 'logs');
  await mkdir(cliLogs, { recursive: true });
  await writeFile(
    join(cliLogs, 'transcript_full.jsonl'),
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-23T05:00:00Z',
      content: '<USER_REQUEST>\nFix CLI bug\n</USER_REQUEST>',
    }) + '\n',
  );

  // Configure settings.json in cliHome.
  await writeFile(
    join(cliHome, 'settings.json'),
    JSON.stringify({ model: 'Claude Sonnet 5.5 (Medium)' }),
  );

  // Create fake agy binary.
  const argsFile = join(dir, 'agy-args.json');
  const fakeAgy = join(dir, 'fake-agy');
  await writeFile(
    fakeAgy,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('1.4.5');
  process.exit(0);
}
if (args[0] === 'models') {
  console.log('Fetching available models...');
  console.log('gemini-4-argon-medium\\tGemini 4 Argon (Medium)');
  console.log('claude-sonnet-5-5-medium\\tClaude Sonnet 5.5 (Medium)');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, cwd: process.cwd() }));
const convIdx = args.indexOf('--conversation');
const cid = convIdx >= 0 ? args[convIdx + 1] : 'new-conv-id';
// Verify that desktop session DB was synced into cliHome before agy started:
const syncedDb = path.join(${JSON.stringify(cliHome)}, 'conversations', cid + '.db');
if (convIdx >= 0 && !fs.existsSync(syncedDb)) {
  console.error('trajectory not found: ' + cid);
  process.exit(1);
}
if (convIdx >= 0) {
  fs.writeFileSync(syncedDb, 'cli-updated-db-v2');
}
console.log(JSON.stringify({ event: 'init', conversation_id: cid, init: { cwd: process.cwd() } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'hello.txt' } } } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'hello.txt' }, output: 'Serving on http://127.0.0.1:4321' } } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello ' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'world!' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'Hello world!' } }));
`,
  );
  await chmod(fakeAgy, 0o755);

  // Antigravity leaves lock files behind; only a held one means Desktop has the conversation open.
  const desktopLock = join(appHome, 'presence', `${sessionDesktop}.lock`);
  await mkdir(join(appHome, 'presence'), { recursive: true });
  await writeFile(desktopLock, '');
  const held = new Set<string>();
  const hourAgo = new Date(Date.now() - 3600_000);
  await utimes(join(appHome, 'conversations', `${sessionDesktop}.db`), hourAgo, hourAgo);
  await utimes(join(desktopLogs, 'transcript_full.jsonl'), hourAgo, hourAgo);

  const adapter = new AntigravityAdapter({
    cli: fakeAgy,
    app: '/nonexistent/Antigravity.app',
    appHome,
    cliHome,
    processCount: async () => 2,
    heldLocks: async paths => new Set(paths.filter(p => held.has(p))),
  });

  const info = await adapter.detect();
  assert.equal(info.kind, 'antigravity');
  assert.equal(info.status, 'ready');
  assert.equal(info.version, '1.4.5');
  assert.equal(info.runningProcesses, 2);

  const models = await adapter.listModels();
  assert.deepEqual(models, [
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)', isDefault: false },
    { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)', isDefault: true },
  ]);

  const sessions = await adapter.listSessions(20);
  assert.deepEqual(
    sessions.map(s => ({ id: s.id, title: s.title, cwd: s.cwd, preview: s.preview })),
    [
      { id: sessionCli, title: 'CLI Bugfix', cwd: '/Users/test/cli-repo', preview: 'Fix CLI bug' },
      { id: sessionDesktop, title: 'Desktop Feature Work', cwd: '/Users/test/desktop-repo', preview: 'Build the desktop feature' },
    ],
  );
  assert.equal(sessions.find(s => s.id === sessionDesktop)?.running, false, 'A leftover lock file is not a running task');

  const messages = await adapter.getMessages(sessionDesktop, 20);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, 'Build the desktop feature');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, 'Part 1 of response.\n\nPart 2 of response.');

  // Resume the desktop session via startTask and verify CLI sync + stream-json events.
  const events: TaskEventBody[] = [];
  const deltas: string[] = [];
  const outputs: string[] = [];
  let finishedSessionId: string | undefined;
  const workDir = join(dir, 'work');
  await mkdir(workDir, { recursive: true });

  const resume = () => new Promise<void>((resolvePromise, rejectPromise) => {
    const sink: TaskSink = {
      emit: e => events.push(e),
      delta: (_id, text) => deltas.push(text),
      output: text => outputs.push(text),
      setSession: id => { finishedSessionId = id; },
      finish: outcome => {
        if (outcome.status === 'completed') resolvePromise();
        else rejectPromise(new Error(outcome.error ?? outcome.status));
      },
    };
    adapter
      .startTask(
        {
          sessionId: sessionDesktop,
          cwd: workDir,
          prompt: '--model is part of prompt',
          permissionMode: 'acceptEdits',
          model: 'claude-sonnet-5-5-medium',
          effort: 'high',
        },
        sink,
      )
      .catch(rejectPromise);
  });
  await resume();

  assert.equal(finishedSessionId, sessionDesktop);
  assert.deepEqual(deltas, ['Hello ', 'world!']);
  assert.deepEqual(outputs, ['Serving on http://127.0.0.1:4321']);
  assert.ok(events.some(e => e.kind === 'tool' && e.name === 'write_file' && e.detail === 'hello.txt'));
  assert.ok(events.some(e => e.kind === 'file' && e.change === 'created' && e.path.endsWith('/hello.txt')));
  assert.ok(events.some(e => e.kind === 'text' && e.text === 'Hello world!'));
  assert.ok(events.some(e => e.kind === 'result' && !e.isError && e.text === 'Hello world!'));

  const recorded = JSON.parse(await readFile(argsFile, 'utf8'));
  assert.deepEqual(recorded.args, [
    '--output-format',
    'stream-json',
    '--mode=accept-edits',
    '--conversation',
    sessionDesktop,
    '--model',
    'claude-sonnet-5-5-medium',
    '--effort',
    'high',
    '-p=--model is part of prompt',
  ]);

  // Wait briefly for close handler to sync updated DB back to appHome.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await readFile(join(appHome, 'conversations', `${sessionDesktop}.db`), 'utf8'), 'cli-updated-db-v2');

  // While Desktop holds the conversation open, the phone's turn must not overwrite its copy.
  held.add(desktopLock);
  await new Promise(r => setTimeout(r, 20));
  await writeFile(join(appHome, 'conversations', `${sessionDesktop}.db`), 'desktop-db-v3');
  await resume();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await readFile(join(cliHome, 'conversations', `${sessionDesktop}.db`), 'utf8'), 'cli-updated-db-v2');
  assert.equal(await readFile(join(appHome, 'conversations', `${sessionDesktop}.db`), 'utf8'), 'desktop-db-v3');
});
