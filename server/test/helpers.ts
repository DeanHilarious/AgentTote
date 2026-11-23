import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { TestContext } from 'node:test';
import { createApp } from '../src/app.ts';
import type { AppOptions } from '../src/app.ts';
import { hashPassword } from '../src/passwords.ts';
import { openDatabase } from '../src/db.ts';
import type { Channel, Purpose } from '../src/targets.ts';
import type { CodeSender } from '../src/senders.ts';

export const keys = generateKeyPairSync('ed25519');
export const secret = 'test-secret-at-least-thirty-two-bytes';
export const initialTime = 1_800_000_000_000;

interface Reply {
  status: number;
  body: any;
  headers: Record<string, string>;
}

interface RequestOptions {
  token?: string;
  raw?: string;
  headers?: Record<string, string>;
}

function parseResponse(bytes: Buffer): Reply {
  const separator = bytes.indexOf('\r\n\r\n');
  const lines = bytes.subarray(0, separator).toString().split('\r\n');
  const status = Number(lines.shift()!.split(' ')[1]);
  const headers = Object.fromEntries(lines.map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  let body = bytes.subarray(separator + 4);
  if (headers['transfer-encoding'] === 'chunked') {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < body.length) {
      const end = body.indexOf('\r\n', offset);
      const size = parseInt(body.subarray(offset, end).toString(), 16);
      if (size === 0) break;
      chunks.push(body.subarray(end + 2, end + 2 + size));
      offset = end + 2 + size + 2;
    }
    body = Buffer.concat(chunks);
  }
  return { status, headers, body: JSON.parse(body.toString()) };
}

// Use actual IncomingMessage/ServerResponse streams when the sandbox forbids even listen(0).
function inMemoryRequest(server: Server, method: string, path: string, raw: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const bytes: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { bytes.push(Buffer.from(chunk)); done(); } });
    const input = new Socket();
    const req = new IncomingMessage(input);
    req.method = method;
    req.url = path;
    req.headers = headers;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.on('error', reject);
    res.on('finish', () => {
      try { resolve(parseResponse(Buffer.concat(bytes))); } catch (error) { reject(error); }
      socket.destroy();
      input.destroy();
    });
    server.emit('request', req, res);
    req.push(Buffer.from(raw));
    req.push(null);
  });
}

export async function fixture(t: TestContext, testAccounts = new Map<string, string>(), senderOverride?: CodeSender,
  options: Pick<AppOptions, 'trustProxy' | 'apns' | 'log' | 'legacyPhoneLogin' | 'feedbackNotification'> = {}) {
  let time = initialTime;
  const now = () => time;
  const sent: { target: string; code: string; purpose: Purpose }[] = [];
  const sender: CodeSender = senderOverride ?? { async send(target, code, purpose) { sent.push({ target, code, purpose }); } };
  const db = openDatabase();
  const server = createApp({ db, serverSecret: secret, signingKey: keys.privateKey, now, senders: { email: sender, sms: sender }, testAccounts, ...options });
  let base: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('listen(0) denied with EPERM; testing HTTP request/response streams in memory');
  }
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    else server.close(() => {}); // Emit close and release relay timers even after listen EPERM.
    db.close();
  });

  async function request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<Reply> {
    const raw = options.raw ?? (body === undefined ? '' : JSON.stringify(body));
    const headers = {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    };
    if (!base) return inMemoryRequest(server, method, `/v1${path}`, raw, headers);
    const response = await fetch(`${base}/v1${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
    return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
  }

  async function send(target: string, channel: Channel = 'email', purpose: Purpose = 'register') {
    return request('POST', '/auth/code', { channel, target, purpose });
  }

  async function login(target: string, channel: Channel = 'email') {
    const email = target.trim().toLowerCase();
    if (db.prepare('SELECT user_id FROM identities WHERE target = ?').get(email)) {
      const result = await request('POST', '/auth/password', { email, password: '12345678' });
      if (result.status !== 200) throw new Error(`Login failed: ${JSON.stringify(result.body)}`);
      return result.body;
    }
    const response = await send(target, channel);
    if (response.status !== 200) throw new Error(`Send failed: ${JSON.stringify(response.body)}`);
    const code = testAccounts.get(`${channel}:${email}`) ?? sent.at(-1)!.code;
    const result = await request('POST', '/auth/register', { email, code, password: '12345678', deviceLabel: 'Test Mac' });
    if (result.status !== 200) throw new Error(`Register failed: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  async function legacy(phone = '+8613800138000') {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, created_at, password_hash) VALUES (?, ?, ?)').run(id, now(), await hashPassword('12345678'));
    db.prepare("INSERT INTO identities VALUES (?, 'sms', ?, 0)").run(id, phone);
    return id;
  }

  return { db, now, sent, request, send, login, legacy, advance(ms: number) { time += ms; } };
}
