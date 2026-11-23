import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { deleteWorkBuddyKey, normalizeWorkBuddyKey, saveWorkBuddyKey, verifyWorkBuddyKey, WORKBUDDY_KEYS_URL } from './workbuddyKey.ts';

export async function configureWorkBuddyKey(clear = false, options: {
  input?: Readable; output?: Writable;
  verify?: typeof verifyWorkBuddyKey; save?: typeof saveWorkBuddyKey; remove?: typeof deleteWorkBuddyKey;
} = {}): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let readline: ReturnType<typeof createInterface> | undefined;
  try {
    if (clear) {
      await (options.remove ?? deleteWorkBuddyKey)();
      output.write('WorkBuddy disconnected.\n');
      return true;
    }
    // Suppress readline's echo from creation, including keys piped immediately at startup.
    const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });
    readline = createInterface({ input, output: quiet, terminal: !!(input as Readable & { isTTY?: boolean }).isTTY });
    const lines = readline[Symbol.asyncIterator]();
    output.write(`Open ${WORKBUDDY_KEYS_URL}\nPaste your API key (hidden): `);
    const line = await lines.next();
    output.write('\n');
    const apiKey = normalizeWorkBuddyKey(line.done ? undefined : line.value);
    if (!apiKey) { output.write('Enter an API key of 16–512 characters without whitespace.\n'); return false; }
    output.write('Verifying… This may take a few minutes.\n');
    const result = await (options.verify ?? verifyWorkBuddyKey)(apiKey, 'internal');
    if (!result.ok) {
      output.write(result.code === 'invalid_key' ? 'That key did not work. Check the CodeBuddy account and key.\n' : 'Could not verify the key. Please try again.\n');
      return false;
    }
    await (options.save ?? saveWorkBuddyKey)({ apiKey, environment: result.environment });
    output.write('WorkBuddy connected.\n');
    return true;
  } catch { output.write('Could not connect WorkBuddy. Check the CLI and local file permissions.\n'); return false; }
  finally { readline?.close(); }
}
