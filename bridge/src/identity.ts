import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDirectory } from './config.ts';
import { publicKey } from './relayCrypto.ts';

export interface Identity { privateKey: Buffer; publicKey: string }
export async function loadIdentity(directory = configDirectory()): Promise<Identity> {
  const path = join(directory, 'identity.key');
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Publish a complete file exclusively: concurrent startups must never replace a pinned key.
    const temporary = join(directory, `.identity.${randomBytes(16).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ privateKey: randomBytes(32).toString('base64url') }) + '\n', { flag: 'wx', mode: 0o600 });
      try { await link(temporary, path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally { await rm(temporary, { force: true }); }
    content = await readFile(path, 'utf8');
  }
  let raw: Buffer;
  try {
    const value = JSON.parse(content).privateKey;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
    raw = Buffer.from(value, 'base64url');
    if (raw.length !== 32 || raw.toString('base64url') !== value) throw new Error();
  } catch { throw new Error('identity.key is damaged; restore the original identity key'); }
  await chmod(path, 0o600);
  return { privateKey: raw, publicKey: publicKey(raw).toString('base64url') };
}
