import { ProjectFiles, type FileParams } from './files.ts';
import { WebPreviews, type PreviewRequest } from './preview.ts';
import { agentIcons, withAgentIcon, type IconProvider } from './agentIcons.ts';
import { AgentFlowStore, type AgentFlowOptions } from './agentFlow.ts';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { BridgeConfig, HostAddress } from './config.ts';
import { staleLocalAddress } from './network.ts';
import { verifyTicket } from './ticket.ts';
import { PushManager } from './push.ts';
import type { PushAccount } from './push.ts';
import { redactSecrets } from './secrets.ts';
import { displayAttachmentPrompt, TaskAttachments } from './attachments.ts';
import { TaskManager } from './tasks.ts';
import { ModelCatalog, validateModel } from './models.ts';
import { AGENT_KINDS, LEGACY_AGENT_KINDS, type Adapter, type AgentInfo, type AgentKind, type PermissionMode, type PushMessage, type RpcRequest, type RpcResponse, type SessionSummary, type PushStatus } from './types.ts';

export interface ClientTransport {
  kind: 'local' | 'relay';
  remote: string;
  send(text: string): void;
  close(): void;
}

export const BRIDGE_VERSION = '2026.11.28';
const AGENTS: readonly AgentKind[] = AGENT_KINDS;
const MODES: PermissionMode[] = ['readOnly', 'acceptEdits', 'full'];

function tokenFrom(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
}

function sameToken(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface UpgradeContext {
  pairingToken: string;
  deviceId: string;
  userId?: string;
  publicKeyPem?: string;
  now?: () => number;
}

export function authorizeUpgrade(token: string, ctx: UpgradeContext): 'pairing' | 'account' | undefined {
  if (sameToken(token, ctx.pairingToken)) return 'pairing';
  if (ctx.userId && ctx.publicKeyPem && verifyTicket(token, ctx.publicKeyPem, {
    deviceId: ctx.deviceId, userId: ctx.userId, now: ctx.now,
  })) return 'account';
  return undefined;
}

function str(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = params[key];
  if (typeof v === 'string' && v.trim()) return v;
  if (required) throw new Error(`Missing "${key}"`);
  return undefined;
}

function agentParam(params: Record<string, unknown>): AgentKind {
  const a = str(params, 'agent') as AgentKind;
  if (!AGENTS.includes(a)) throw new Error(`Unknown agent "${a}"`);
  return a;
}

function clientAgentsParam(params: Record<string, unknown>): Set<AgentKind> {
  const listed = params.agents;
  if (!Array.isArray(listed)) return new Set(LEGACY_AGENT_KINDS);
  return new Set(AGENTS.filter(kind => listed.includes(kind)));
}

function limitParam(params: Record<string, unknown>, fallback: number, max: number): number {
  const n = Number(params.limit ?? fallback);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
}

async function detectEnabledAgents(cfg: { disabledAgents?: AgentKind[] }, adapters: Adapter[], icons: IconProvider = agentIcons): Promise<AgentInfo[]> {
  const disabled = cfg.disabledAgents;
  const infos = await Promise.all(adapters.filter(a => !cfg.disabledAgents?.includes(a.kind)).map(async a => withAgentIcon(await a.detect(), icons)));
  // A switch during detection invalidates the snapshot, including agents just turned back on.
  if (disabled !== cfg.disabledAgents) return detectEnabledAgents(cfg, adapters, icons);
  return infos;
}

export async function bridgeHello(cfg: Pick<BridgeConfig, 'name' | 'deviceId' | 'publicKey'> & Partial<Pick<BridgeConfig, 'disabledAgents'>>, adapters: Adapter[], push: PushStatus = { available: false, reason: 'signed_out' }, icons: IconProvider = agentIcons) {
  return {
    push,
    supportsAttachments: true,
    name: cfg.name,
    deviceId: cfg.deviceId,
    version: BRIDGE_VERSION,
    publicKey: cfg.publicKey,
    agents: await detectEnabledAgents(cfg, adapters, icons),
  };
}

export function startServer(cfg: BridgeConfig, adapters: Adapter[], log: (msg: string) => void,
  accountContext: () => Pick<UpgradeContext, 'userId' | 'publicKeyPem'> = () => ({}),
  onClients: (count: number) => void = () => {}, account?: PushAccount, icons: IconProvider = agentIcons,
  agentFlowOptions?: Omit<AgentFlowOptions, 'getBridgeAgents' | 'getBridgeTasks'>) {
  const rawLog = log;
  log = message => rawLog(redactSecrets(message));
  const installations = new WeakMap<ClientTransport, string>();
  const clients = new Set<ClientTransport>();
  const pairingClients = new Set<WebSocket>();
  const broadcastListeners = new Set<(msg: PushMessage) => void>();
  const remoteAddresses = new WeakMap<WebSocket, string>();
  // Agent kinds each phone declared in `hello`; phones never see agents they cannot decode.
  const clientAgents = new WeakMap<ClientTransport, Set<AgentKind>>();
  const localClient: ClientTransport = { kind: 'local', remote: 'mac-hub', send: () => {}, close: () => {} };
  clientAgents.set(localClient, new Set(AGENTS));
  const legacyAgents = new Set(LEGACY_AGENT_KINDS);
  const supports = (client: ClientTransport, kind: AgentKind) => (clientAgents.get(client) ?? legacyAgents).has(kind);
  const broadcast = (msg: PushMessage) => {
    for (const listener of broadcastListeners) {
      try { listener(msg); } catch {}
    }
    const data = JSON.stringify(msg);
    const taskAgent = msg.event === 'task.updated' ? msg.data.agent
      : msg.event === 'task.event' || msg.event === 'task.delta' ? tasks.agentOf(msg.data.taskId) : undefined;
    for (const c of clients) {
      if (taskAgent && !supports(c, taskAgent)) continue;
      if (msg.event === 'agents.updated' && msg.data.some(a => !supports(c, a.kind))) {
        c.send(JSON.stringify({ ...msg, data: msg.data.filter(a => supports(c, a.kind)) }));
      } else {
        c.send(data);
      }
    }
  };
  const push = new PushManager(cfg, account, data => broadcast({ event: 'push.status', data }), log);
  const previews = new WebPreviews(() => { const address = http.address(); return typeof address === 'object' && address ? address.port : cfg.port; });
  const tasks = new TaskManager(adapters, broadcast, (task, id) => push.send(task, id), (id, text) => previews.observe(id, text));
  const files = new ProjectFiles(() => tasks.allAdapters(), () => cfg.disabledAgents);
  const models = new ModelCatalog();
  const attachments = new TaskAttachments();
  const flow = new AgentFlowStore({
    ...agentFlowOptions,
    getBridgeAgents: () => detectEnabledAgents(cfg, tasks.allAdapters(), icons),
    getBridgeTasks: () => tasks.list(),
  });
  const installation = (client: ClientTransport) => {
    const id = installations.get(client);
    return push.has(id) ? id : undefined;
  };

  const enabledAgent = (p: Record<string, unknown>, client: ClientTransport) => {
    const kind = agentParam(p);
    if (cfg.disabledAgents.includes(kind)) throw new Error(`${tasks.adapter(kind).name} is turned off on this Mac.`);
    if (!supports(client, kind)) throw new Error(`Update AgentTote on your iPhone to use ${tasks.adapter(kind).name}.`);
    return kind;
  };
  const listSessions = async (agent: AgentKind, limit: number): Promise<SessionSummary[]> => {
    const sessions = await tasks.adapter(agent).listSessions(limit);
    const running = tasks.runningSessionIds(agent);
    for (const s of sessions) if (running.has(s.id)) s.running = true;
    return sessions;
  };

  const handlers: Record<string, (p: Record<string, unknown>, client: ClientTransport) => Promise<unknown> | unknown> = {
    hello: async (p, client) => {
      clientAgents.set(client, clientAgentsParam(p));
      const hello = await bridgeHello(cfg, tasks.allAdapters(), push.status, icons);
      return { ...hello, agents: hello.agents.filter(a => supports(client, a.kind)) };
    },
    'agents.list': async (_p, client) => (await detectEnabledAgents(cfg, tasks.allAdapters(), icons)).filter(a => supports(client, a.kind)),
    'agents.models': async (p, client) => {
      const agent = enabledAgent(p, client);
      const options = await models.list(tasks.adapter(agent));
      enabledAgent(p, client);
      return { agent, models: options };
    },
    'agents.icon': async (p, client) => {
      const agent = enabledAgent(p, client);
      const icon = await icons.get(agent);
      if (!icon) throw new Error('No icon');
      return { agent, iconHash: icon.iconHash, png: icon.png.toString('base64') };
    },
    'sessions.list': (p, client) => listSessions(enabledAgent(p, client), limitParam(p, 30, 200)),
    'sessions.messages': async (p, client) => {
      const adapter = tasks.adapter(enabledAgent(p, client));
      const messages = await adapter.getMessages(str(p, 'sessionId')!, limitParam(p, 60, 500));
      return messages.map(m => m.role === 'user' ? { ...m, text: displayAttachmentPrompt(m.text) } : m);
    },
    'projects.recent': async (p, client) => {
      // Working directories seen across all agents, for picking where a new session should run.
      const byPath = new Map<string, { path: string; agents: AgentKind[]; updatedAt: number }>();
      for (const s of await files.sessions()) {
        if (cfg.disabledAgents.includes(s.agent) || !supports(client, s.agent)) continue;
        if (!s.cwd) continue;
        const e = byPath.get(s.cwd) ?? { path: s.cwd, agents: [], updatedAt: 0 };
        if (!e.agents.includes(s.agent)) e.agents.push(s.agent);
        e.updatedAt = Math.max(e.updatedAt, s.updatedAt);
        byPath.set(s.cwd, e);
      }
      return [...byPath.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limitParam(p, 30, 100));
    },
    'files.list': (p, client) => { enabledAgent(p, client); return files.list(p as unknown as FileParams); },
    'files.read': (p, client) => { if (p.agent !== undefined) enabledAgent(p, client); return files.read(p as unknown as FileParams); },
    'preview.targets': () => previews.targets(),
    'preview.request': async (p, client) => {
      const result = await previews.request(p as unknown as PreviewRequest, client);
      log(`preview ${Number(p.port)} ${result.status}`);
      return result;
    },
    'preview.upload': (p, client) => previews.upload(p as unknown as { bodyId?: string; data: string; offset: number }, client),
    'preview.chunk': (p, client) => previews.chunk(str(p, 'streamId')!, client),
    'push.register': (p, client) => {
      installations.set(client, push.register(p));
      return { push: push.status };
    },
    'tasks.watch': (p, client) => {
      const id = installation(client);
      if (!id) throw new Error('Register for notifications first');
      if (typeof p.watch !== 'boolean') throw new Error('Invalid watch');
      return tasks.watch(str(p, 'taskId')!, id, p.watch);
    },
    'attachments.begin': (p, client) => attachments.begin(client, p.name, p.size),
    'attachments.chunk': (p, client) => attachments.chunk(client, p.id, p.offset, p.data),
    'attachments.discard': (p, client) => attachments.discard(client, str(p, 'id')!),
    'tasks.start': async (p, client) => {
      const kind = enabledAgent(p, client);
      if (p.watch !== undefined && typeof p.watch !== 'boolean') throw new Error('Invalid watch');
      const mode = (str(p, 'permissionMode', false) ?? 'acceptEdits') as PermissionMode;
      if (!MODES.includes(mode)) throw new Error(`Unknown permission mode "${mode}"`);
      const sessionId = str(p, 'sessionId', false);
      const cwd = str(p, 'cwd', false);
      if (p.fork !== undefined && typeof p.fork !== 'boolean') throw new Error('Invalid fork');
      const fork = p.fork === true;
      if (fork && !sessionId) throw new Error('fork requires a sessionId');
      if (!sessionId && !cwd) throw new Error('Pass a sessionId to continue a session, or a cwd to start a new one');
      for (const key of ['model', 'effort']) {
        if (p[key] !== undefined && (typeof p[key] !== 'string' || !(p[key] as string).trim())) throw new Error(`Invalid ${key}`);
      }
      const model = p.model as string | undefined;
      const effort = p.effort as string | undefined;
      if (model !== undefined || effort !== undefined) {
        // Catalog availability must not prevent task execution. Validation errors
        // stay outside this catch so invalid selections cannot bypass validation.
        const options = await models.list(tasks.adapter(kind)).catch(() => undefined);
        if (options !== undefined) validateModel(options, model, effort);
        enabledAgent(p, client);
      }
      const prompt = str(p, 'prompt')!;
      const task = await attachments.start(client, p.attachmentIds, () => tasks.list(), files => {
        enabledAgent(p, client);
        return tasks.start(kind, { sessionId, cwd, prompt, permissionMode: mode, model, effort, fork,
          ...(files.length ? { attachments: files } : {}) }, p.watch === true ? installation(client) : undefined);
      });
      files.invalidate();
      return tasks.get(task.id, 0, installation(client)).task;
    },
    'tasks.cancel': p => tasks.cancel(str(p, 'taskId')!),
    'tasks.list': (_p, client) => tasks.list(installation(client)).filter(t => supports(client, t.agent)),
    'tasks.get': (p, client) => {
      const taskId = str(p, 'taskId')!;
      const agent = tasks.agentOf(taskId);
      if (agent && !supports(client, agent)) throw new Error(`Unknown task ${taskId}`);
      return tasks.snapshot(taskId, Number(p.sinceSeq ?? 0) || 0, installation(client));
    },
    'agentFlow.snapshot': (p) => flow.snapshot(limitParam(p, 40, 100)),
    'agentFlow.run': (p) => flow.getRun(str(p, 'id')!),
  };

  const attachClient = (client: ClientTransport) => {
    clients.add(client);
    onClients(clients.size);
    return {
      disconnect: () => { attachments.disconnect(client); previews.disconnect(client); if (clients.delete(client)) onClients(clients.size); },
      receive: async (text: string) => {
        if (!clients.has(client)) return;
        let req: RpcRequest;
        try {
          req = JSON.parse(text);
        } catch {
          return;
        }
        if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') return;
        let res: RpcResponse;
        try {
          const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
          if (!handler) throw new Error(`Unknown method ${req.method}`);
          res = { id: req.id, result: (await handler(req.params ?? {}, client)) ?? null };
        } catch (err) {
          res = { id: req.id, error: { message: (err as Error).message } };
          if (req.method.startsWith('files.') || req.method.startsWith('preview.')
            || req.method.startsWith('attachments.') || (req.method === 'tasks.start' && req.params?.attachmentIds)) {
            log(req.method);
          }
          else log(client.kind === 'relay' ? '中转 RPC failed' : `${req.method} failed: ${(err as Error).message}`);
        }
        if (client.kind === 'local' && req.method === 'tasks.start' && 'result' in res) log(`Task started on ${(req.params as any)?.agent}`);
        if (clients.has(client)) client.send(JSON.stringify(res));
      },
    };
  };

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: cfg.name, version: BRIDGE_VERSION }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const authorization = authorizeUpgrade(tokenFrom(req), { ...accountContext(), pairingToken: cfg.token, deviceId: cfg.deviceId });
    if (!authorization) {
      log(`Rejected connection from ${req.socket.remoteAddress}: bad token`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const who = req.socket.remoteAddress ?? 'unknown';
    wss.handleUpgrade(req, socket, head, ws => {
      remoteAddresses.set(ws, who);
      log(`${authorization === 'pairing' ? '配对 token 连接' : '账号票据连接'} from ${who}`);
      if (authorization === 'pairing') pairingClients.add(ws);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket & { alive?: boolean }, req: IncomingMessage) => {
    const who = remoteAddresses.get(ws) ?? req.socket.remoteAddress ?? 'unknown';
    const connection = attachClient({ kind: 'local', remote: who,
      send: text => { if (ws.readyState === WebSocket.OPEN) ws.send(text); }, close: () => ws.terminate() });
    ws.alive = true;
    log(`Phone connected from ${who}`);
    ws.on('pong', () => (ws.alive = true));
    ws.on('close', () => {
      connection.disconnect();
      pairingClients.delete(ws);
      log(`Phone disconnected (${who})`);
    });
    ws.on('message', raw => { void connection.receive(String(raw)); });
  });

  // Drop phones that vanished without closing (e.g. walked out of Wi-Fi range).
  const heartbeat = setInterval(() => {
    void attachments.prune(() => tasks.list()).catch(() => log('Attachment cleanup failed'));
    for (const c of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (!c.alive) {
        c.terminate();
        continue;
      }
      c.alive = false;
      c.ping();
    }
  }, 30_000);
  http.on('close', () => {
    clearInterval(heartbeat);
    push.close();
    previews.close();
    void attachments.close().catch(() => log('Attachment cleanup failed'));
  });

  const controlled = Object.assign(http, {
    agentFlow: flow,
    onBroadcast: (listener: (msg: PushMessage) => void) => {
      broadcastListeners.add(listener);
      return () => broadcastListeners.delete(listener);
    },
    callLocal: async (method: string, params: Record<string, unknown> = {}) => {
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!handler) throw new Error(`Unknown method ${method}`);
      return await handler(params, localClient);
    },
    agentsUpdated: (data: AgentInfo[]) => broadcast({ event: 'agents.updated',
      data: data.map(({ kind, name, status, version, runningProcesses, detail, iconHash }) =>
        ({ kind, name, status, version, runningProcesses, detail, iconHash })) }),
    clientCount: () => clients.size,
    attachClient,
    broadcast,
    disconnectPairing: () => { for (const ws of pairingClients) ws.terminate(); },
    disconnectStale: (hosts: HostAddress[]) => {
      for (const ws of wss.clients) {
        const socket = (ws as WebSocket & { _socket?: { localAddress?: string } })._socket;
        if (staleLocalAddress(socket?.localAddress, hosts)) ws.terminate();
      }
    },
    shutdown: () => new Promise<void>((resolve, reject) => {
      clearInterval(heartbeat);
      previews.close();
      for (const task of tasks.list()) if (task.status === 'running') tasks.cancel(task.id);
      for (const client of clients) client.close();
      wss.close();
      http.close(error => { void attachments.close().then(() => error ? reject(error) : resolve(), reject); });
      http.closeAllConnections();
    }),
  });
  return new Promise<typeof controlled>((resolve, reject) => {
    const failed = (error: Error) => {
      clearInterval(heartbeat);
      push.close();
      previews.close();
      wss.close();
      reject(error);
    };
    http.once('error', failed);
    try {
      http.listen(cfg.port, '0.0.0.0', () => {
        void attachments.removeOrphans().catch(() => log('Could not clean up attachments left by a previous bridge'));
        resolve(controlled);
      });
    } catch (error) {
      failed(error as Error);
    }
  });
}
