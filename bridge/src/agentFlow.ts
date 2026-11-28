import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentFlowEvent,
  AgentFlowNode,
  AgentFlowRunDetail,
  AgentFlowRunSummary,
  AgentFlowSnapshot,
  AgentFlowTeamMember,
  AgentFlowUsage,
  AgentInfo,
  AgentKind,
  TaskInfo,
} from './types.ts';

const DEFAULT_PRIMARY_RUNS_DIR = '/Users/Shared/agent-flow/runs';
const CODEX_INDEX_TTL_MS = 30_000;
const MAX_ROLLOUT_CACHE_ENTRIES = 500;
const MAX_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_SPEC_BYTES = 65_536;
const SPEC_CANDIDATES = ['spec.md', 'SPEC.md', 'brief.md', 'plan.md'] as const;
const ROLLOUT_UUID_RE = /rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSION_ID_RE = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const LOG_FILE_RE = /^log(?:[-_].+|\d*)\.txt$/i;

export interface AgentFlowOptions {
  primaryRunsDir?: string;
  codexRunsDir?: string;
  codexSessionsDir?: string;
  getBridgeAgents?: () => Promise<AgentInfo[]> | AgentInfo[];
  getBridgeTasks?: () => TaskInfo[];
  probeBinary?: (binNames: string[], preferredPaths: string[]) => string | undefined;
}

interface MemberMetadata {
  name: string;
  shortName: string;
  account: string;
  tier: 'orchestrator' | 'executor' | 'bridge';
  role: string;
  defaultModel: string;
  accent: string;
  badge: string;
  binName: string;
}

interface LocalCliDefinition extends MemberMetadata {
  id: string;
  binNames: string[];
  preferredPaths: () => string[];
}

const BRIDGE_MEMBER_META: Record<AgentKind, MemberMetadata> = {
  claude: {
    name: 'Claude Code',
    shortName: 'claude',
    account: 'Anthropic CLI',
    tier: 'bridge',
    role: 'AgentTote Bridge · 核心编码与交互代理',
    defaultModel: 'Claude',
    accent: '#D97757',
    badge: 'BRIDGE',
    binName: 'claude',
  },
  codex: {
    name: 'Codex',
    shortName: 'codex',
    account: 'OpenAI CLI',
    tier: 'bridge',
    role: '核心复杂编码、系统架构与深度评审主力',
    defaultModel: 'GPT Codex',
    accent: '#34D399',
    badge: 'CORE CODE',
    binName: 'codex',
  },
  workbuddy: {
    name: 'WorkBuddy',
    shortName: 'workbuddy',
    account: 'WorkBuddy',
    tier: 'bridge',
    role: 'AgentTote Bridge · 办公与研发助手',
    defaultModel: 'WorkBuddy',
    accent: '#2F6BFF',
    badge: 'BRIDGE',
    binName: 'workbuddy',
  },
  antigravity: {
    name: 'Antigravity',
    shortName: '总控大脑',
    account: 'Orchestrator',
    tier: 'orchestrator',
    role: '总控大脑 · 统筹规划、派单与验收',
    defaultModel: 'Antigravity Orchestrator',
    accent: '#A78BFA',
    badge: 'BRAIN',
    binName: 'agy',
  },
  cursor: {
    name: 'Cursor',
    shortName: 'cursor',
    account: 'Cursor CLI',
    tier: 'bridge',
    role: 'AgentTote Bridge · 编辑器代理',
    defaultModel: 'Cursor',
    accent: '#64748B',
    badge: 'BRIDGE',
    binName: 'cursor',
  },
};

function defaultBinPaths(binNames: string[]): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  for (const name of binNames) {
    paths.push(
      path.join(home, '.local', 'bin', name),
      path.join('/opt/homebrew/bin', name),
      path.join('/usr/local/bin', name),
    );
  }
  return paths;
}

const LOCAL_CLI_DEFINITIONS: readonly LocalCliDefinition[] = [
  {
    id: 'antigravity',
    name: 'Antigravity',
    shortName: '总控大脑',
    account: 'Orchestrator',
    tier: 'orchestrator',
    role: '总控大脑 · 统筹规划、派单与验收',
    defaultModel: 'Antigravity Orchestrator',
    accent: '#A78BFA',
    badge: 'BRAIN',
    binName: 'agy',
    binNames: ['agy', 'antigravity'],
    preferredPaths: () => defaultBinPaths(['agy', 'antigravity']),
  },
  {
    id: 'agy2',
    name: 'agy2 CLI',
    shortName: 'agy2 · Neon',
    account: 'Account B',
    tier: 'executor',
    role: '自媒体执行、高审美界面设计与通用执行手',
    defaultModel: 'Gemini 4 Neon',
    accent: '#22D3EE',
    badge: 'DESIGN · OPS',
    binName: 'agy2',
    binNames: ['agy2'],
    preferredPaths: () => defaultBinPaths(['agy2']),
  },
  {
    id: 'codebuddy',
    name: 'codebuddy CLI',
    shortName: 'codebuddy',
    account: 'CodeBuddy CLI',
    tier: 'executor',
    role: '量大、边界清晰的常规代码开发与调研手',
    defaultModel: 'CodeBuddy Multi-Model',
    accent: '#FBBF24',
    badge: 'BATCH · R&D',
    binName: 'codebuddy',
    binNames: ['codebuddy'],
    preferredPaths: () => defaultBinPaths(['codebuddy']),
  },
  {
    id: 'arkcli',
    name: 'arkcli',
    shortName: 'arkcli',
    account: 'Volcengine Ark',
    tier: 'executor',
    role: '多模态生图、TTS 配音与音视频理解专家',
    defaultModel: 'Volcengine Ark Multimodal',
    accent: '#F472B6',
    badge: 'MULTIMODAL',
    binName: 'arkcli',
    binNames: ['arkcli'],
    preferredPaths: () => defaultBinPaths(['arkcli']),
  },
];

// Ordered so specific IDs (e.g. agy2, workbuddy, codebuddy) match before shorter substrings (agy, buddy).
const AGENT_ALIAS_TABLE: ReadonlyArray<{ id: string; aliases: readonly string[] }> = [
  { id: 'agy2', aliases: ['agy2', 'neon', 'gemini-4-neon', 'gemini'] },
  { id: 'workbuddy', aliases: ['workbuddy'] },
  { id: 'codebuddy', aliases: ['codebuddy', 'buddy'] },
  { id: 'antigravity', aliases: ['antigravity', 'brain', 'orchestrator', 'master', 'agy'] },
  { id: 'codex', aliases: ['codex', 'gpt', 'sol', 'astra'] },
  { id: 'claude', aliases: ['claude', 'anthropic'] },
  { id: 'cursor', aliases: ['cursor'] },
  { id: 'arkcli', aliases: ['arkcli', 'volcengine', 'seedream', 'doubao', 'ark'] },
];

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function defaultProbeBinary(binNames: string[], preferredPaths: string[]): string | undefined {
  const checked = new Set<string>();
  for (const candidate of preferredPaths) {
    if (!candidate || checked.has(candidate)) continue;
    checked.add(candidate);
    if (isExecutableFile(candidate)) return candidate;
  }

  const envPath = process.env.PATH ?? '';
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  for (const binName of binNames) {
    if (!binName) continue;
    for (const dir of dirs) {
      const candidate = path.join(dir, binName);
      if (checked.has(candidate)) continue;
      checked.add(candidate);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function normalizeAgentId(rawAgent?: unknown): string {
  if (rawAgent == null || String(rawAgent).trim() === '') return 'antigravity';
  const lowered = String(rawAgent).toLowerCase().trim();
  for (const entry of AGENT_ALIAS_TABLE) {
    if (entry.id === lowered || entry.aliases.includes(lowered)) return entry.id;
  }
  for (const entry of AGENT_ALIAS_TABLE) {
    if (entry.aliases.some(alias => lowered.includes(alias))) return entry.id;
  }
  return lowered;
}

export function normalizeEventStatus(raw?: unknown): AgentFlowNode['status'] {
  const val = String(raw ?? 'event').toLowerCase().trim();
  if (['dispatched', 'dispatch', 'started', 'running', 'queued', 'in_progress'].includes(val)) {
    return 'dispatched';
  }
  if (['delivered', 'submitted', 'review', 'ready'].includes(val)) {
    return 'delivered';
  }
  if (['accepted', 'approved', 'completed', 'done', 'merged', 'passed'].includes(val)) {
    return 'accepted';
  }
  if (['rejected', 'failed', 'error', 'aborted', 'cancelled'].includes(val)) {
    return 'rejected';
  }
  return 'event';
}

function parseTimestamp(ts: unknown): number | null {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? Math.round(ts) : null;
  let str = String(ts).trim();
  if (!str) return null;
  str = str.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? null : parsed;
}

function toNonNegativeInt(val: unknown): number | null {
  if (val == null || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

export function computeCacheHitRate(inputTokens: number, cacheReadTokens: number): number {
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.max(0, Number(cacheReadTokens) || 0);
  if (cached <= 0) return 0;
  const denom = input >= cached ? input : input + cached;
  if (denom <= 0) return 0;
  return Math.min(100, Math.round((cached / denom) * 1000) / 10);
}

export function emptyUsage(): AgentFlowUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
  };
}

function finalizeUsage(
  raw: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  },
  source?: string,
): AgentFlowUsage {
  const inputTokens = Math.max(0, Math.round(Number(raw.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.round(Number(raw.outputTokens) || 0));
  const thinkingTokens = Math.max(0, Math.round(Number(raw.thinkingTokens) || 0));
  const cacheReadTokens = Math.max(0, Math.round(Number(raw.cacheReadTokens) || 0));
  let totalTokens = Math.max(0, Math.round(Number(raw.totalTokens) || 0));
  if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0 || thinkingTokens > 0 || cacheReadTokens > 0)) {
    const effectiveInput = inputTokens > 0 ? inputTokens : cacheReadTokens;
    totalTokens = effectiveInput + outputTokens + thinkingTokens;
  }
  const result: AgentFlowUsage = {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    totalTokens,
    cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens),
  };
  if (source) result.source = source;
  return result;
}

export function normalizeUsage(raw: unknown, source?: string): AgentFlowUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;

  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(record, k)) {
        const parsed = toNonNegativeInt(record[k]);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  };

  const input = pick('input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens', 'prompt');
  const output = pick('output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens', 'completion');
  const thinking = pick(
    'thinking_tokens',
    'thinkingTokens',
    'thinking',
    'reasoning_output_tokens',
    'reasoningOutputTokens',
    'reasoning_tokens',
    'reasoningTokens',
    'reasoning',
  );
  const cached = pick(
    'cache_read_tokens',
    'cacheReadTokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cached',
    'cache_read',
    'cacheRead',
    'cached_tokens',
    'cachedTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens',
  );
  const total = pick('total_tokens', 'totalTokens', 'total');

  if (input === null && output === null && thinking === null && cached === null && total === null) {
    return undefined;
  }

  const normalized = finalizeUsage(
    {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      cacheReadTokens: cached ?? 0,
      totalTokens: total ?? 0,
    },
    source,
  );

  if (
    normalized.totalTokens === 0 &&
    normalized.inputTokens === 0 &&
    normalized.outputTokens === 0 &&
    normalized.thinkingTokens === 0 &&
    normalized.cacheReadTokens === 0
  ) {
    return undefined;
  }

  return normalized;
}

function sumUsages(list: readonly (AgentFlowUsage | undefined)[], source?: string): AgentFlowUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  const sources = new Set<string>();

  for (const u of list) {
    if (!u) continue;
    inputTokens += Math.max(0, Number(u.inputTokens) || 0);
    outputTokens += Math.max(0, Number(u.outputTokens) || 0);
    thinkingTokens += Math.max(0, Number(u.thinkingTokens) || 0);
    cacheReadTokens += Math.max(0, Number(u.cacheReadTokens) || 0);
    totalTokens += Math.max(0, Number(u.totalTokens) || 0);
    if (u.source) sources.add(u.source);
  }

  const resolvedSource = source ?? (sources.size === 1 ? [...sources][0] : sources.size > 1 ? 'mixed' : undefined);
  return finalizeUsage(
    { inputTokens, outputTokens, thinkingTokens, cacheReadTokens, totalTokens },
    totalTokens > 0 ? resolvedSource : undefined,
  );
}

function readFileHeadUtf8(filePath: string, maxBytes = 4096): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

function extractSessionIdFromLog(logPath: string): string | null {
  const head = readFileHeadUtf8(logPath, 4096);
  if (!head) return null;
  const match = head.match(SESSION_ID_RE);
  return match ? match[1]!.toLowerCase() : null;
}

function readSpecContent(runDirReal: string): string | null {
  for (const filename of SPEC_CANDIDATES) {
    const candidate = path.join(runDirReal, filename);
    try {
      const real = fs.realpathSync(candidate);
      if (!real.startsWith(runDirReal + path.sep)) continue;
      const stat = fs.statSync(real);
      if (!stat.isFile()) continue;
      if (stat.size <= MAX_SPEC_BYTES) {
        return fs.readFileSync(real, 'utf8');
      }
      let fd: number | null = null;
      try {
        fd = fs.openSync(real, 'r');
        const buf = Buffer.allocUnsafe(MAX_SPEC_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, MAX_SPEC_BYTES, 0);
        // Strip a partial multi-byte UTF-8 replacement char at the cut boundary.
        const text = buf.toString('utf8', 0, bytesRead).replace(/\uFFFD+$/, '');
        return `${text}\n\n[truncated]`;
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore close error
          }
        }
      }
    } catch {
      // skip missing or unreadable spec candidate
    }
  }
  return null;
}

function hasAnySpec(runDir: string): { hasSpec: boolean; mtimeMs: number } {
  for (const filename of SPEC_CANDIDATES) {
    const candidate = path.join(runDir, filename);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return { hasSpec: true, mtimeMs: stat.mtimeMs };
    } catch {
      // ignore
    }
  }
  return { hasSpec: false, mtimeMs: 0 };
}

function mapTaskStatusToNodeStatus(status: TaskInfo['status']): AgentFlowNode['status'] {
  if (status === 'running') return 'dispatched';
  if (status === 'completed') return 'accepted';
  return 'rejected';
}

function summarizePrompt(prompt: string, fallback: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
}

interface ParsedRunInternal {
  summary: AgentFlowRunSummary;
  nodes: AgentFlowNode[];
  events: AgentFlowEvent[];
  dirPath?: string;
}

interface MutableNode {
  id: string;
  label: string;
  agent: string;
  model: string;
  effort?: string;
  status: AgentFlowNode['status'];
  round: number;
  dispatchedAt: number | null;
  deliveredAt: number | null;
  acceptedAt: number | null;
  rejectedAt: number | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
  summary: string;
  note?: string;
  artifacts: string[];
  eventCount: number;
  usageByRound: Map<string, AgentFlowUsage>;
}

interface ParsedEventInternal {
  seq: number;
  tsMs: number | null;
  sub: string;
  label?: string;
  event: string;
  status: AgentFlowNode['status'];
  agent: string | null;
  model: string | null;
  effort?: string;
  round: number | null;
  summary: string;
  note?: string;
  artifacts: string[];
  usage?: AgentFlowUsage;
}

export class AgentFlowStore {
  private readonly primaryRunsDir: string;
  private readonly codexRunsDir: string;
  private readonly codexSessionsDir: string;
  private readonly getBridgeAgents?: () => Promise<AgentInfo[]> | AgentInfo[];
  private readonly getBridgeTasks?: () => TaskInfo[];
  private readonly probeBinary: (binNames: string[], preferredPaths: string[]) => string | undefined;

  private codexSessionIndexCache: { ts: number; byUuid: Map<string, string> } = { ts: 0, byUuid: new Map() };
  private readonly rolloutUsageCache = new Map<string, { mtimeMs: number; size: number; usage: AgentFlowUsage | undefined }>();

  constructor(options: AgentFlowOptions = {}) {
    this.primaryRunsDir = options.primaryRunsDir ?? process.env.AGENT_FLOW_RUNS_DIR ?? DEFAULT_PRIMARY_RUNS_DIR;
    this.codexRunsDir = options.codexRunsDir ?? process.env.CODEX_RUNS_DIR ?? path.join(os.homedir(), '.codex-runs');
    this.codexSessionsDir = options.codexSessionsDir ?? process.env.CODEX_SESSIONS_DIR ?? path.join(os.homedir(), '.codex', 'sessions');
    this.getBridgeAgents = options.getBridgeAgents;
    this.getBridgeTasks = options.getBridgeTasks;
    this.probeBinary = options.probeBinary ?? defaultProbeBinary;
  }

  async getTeam(): Promise<AgentFlowTeamMember[]> {
    const bridgeAgents = this.getBridgeAgents ? await this.getBridgeAgents() : [];
    const seen = new Set<string>();
    const members: AgentFlowTeamMember[] = [];

    for (const agent of bridgeAgents) {
      if (seen.has(agent.kind)) continue;
      seen.add(agent.kind);
      const meta = BRIDGE_MEMBER_META[agent.kind];
      const member: AgentFlowTeamMember = {
        id: agent.kind,
        name: agent.name || meta.name,
        shortName: meta.shortName,
        account: meta.account,
        tier: agent.kind === 'antigravity' ? 'orchestrator' : 'bridge',
        role: meta.role,
        defaultModel: meta.defaultModel,
        accent: meta.accent,
        badge: meta.badge,
        binName: meta.binName,
        status: agent.status,
        runningProcesses: agent.runningProcesses,
        isBridgeAgent: true,
      };
      if (agent.version !== undefined) member.version = agent.version;
      if (agent.detail !== undefined) member.detail = agent.detail;
      members.push(member);
    }

    for (const cli of LOCAL_CLI_DEFINITIONS) {
      if (seen.has(cli.id)) continue;
      seen.add(cli.id);
      const resolved = this.probeBinary(cli.binNames, cli.preferredPaths());
      const member: AgentFlowTeamMember = {
        id: cli.id,
        name: cli.name,
        shortName: cli.shortName,
        account: cli.account,
        tier: cli.tier,
        role: cli.role,
        defaultModel: cli.defaultModel,
        accent: cli.accent,
        badge: cli.badge,
        binName: cli.binName,
        status: resolved ? 'ready' : 'unavailable',
        runningProcesses: 0,
        isBridgeAgent: false,
      };
      if (resolved) member.detail = resolved;
      members.push(member);
    }

    const tierRank = (tier: AgentFlowTeamMember['tier']) => (tier === 'orchestrator' ? 0 : tier === 'bridge' ? 1 : 2);
    members.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
    return members;
  }

  async snapshot(limit = 40): Promise<AgentFlowSnapshot> {
    const cappedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 40;
    const now = Date.now();
    const [team, liveTasks] = await Promise.all([
      this.getTeam(),
      Promise.resolve(this.getBridgeTasks ? [...this.getBridgeTasks()] : []),
    ]);

    const discovered = this.collectDiskRuns(now);
    const liveRun = this.synthesizeLiveRun(liveTasks, now);
    if (liveRun) discovered.push(liveRun);

    discovered.sort((a, b) => {
      const aLiveActive = a.summary.id === 'bridge-live' && a.summary.status === 'dispatched' ? 0 : 1;
      const bLiveActive = b.summary.id === 'bridge-live' && b.summary.status === 'dispatched' ? 0 : 1;
      if (aLiveActive !== bLiveActive) return aLiveActive - bLiveActive;

      const aActive = a.summary.status === 'dispatched' || a.summary.status === 'delivered' ? 0 : 1;
      const bActive = b.summary.status === 'dispatched' || b.summary.status === 'delivered' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;

      if (a.summary.updatedAt !== b.summary.updatedAt) return b.summary.updatedAt - a.summary.updatedAt;
      return a.summary.id.localeCompare(b.summary.id);
    });

    const summaries = discovered.map(r => r.summary);
    const activeRuns = summaries.filter(r => r.status === 'dispatched' || r.status === 'delivered').length;
    const acceptedRuns = summaries.filter(r => r.status === 'accepted').length;
    const aggregateUsage = sumUsages(summaries.map(r => r.usage));

    return {
      updatedAt: now,
      summary: {
        totalRuns: summaries.length,
        activeRuns,
        acceptedRuns,
        onlineMembers: team.filter(m => m.status === 'ready').length,
        totalMembers: team.length,
        liveTasksCount: liveTasks.length,
        usage: aggregateUsage,
      },
      team,
      liveTasks,
      runs: summaries.slice(0, cappedLimit),
    };
  }

  async getRun(id: string): Promise<AgentFlowRunDetail> {
    if (typeof id !== 'string' || !id || id.trim() !== id || id.includes('\0')) {
      throw new Error(`Invalid Agent-Flow run id: ${String(id)}`);
    }

    if (id === 'bridge-live') {
      const liveTasks = this.getBridgeTasks ? [...this.getBridgeTasks()] : [];
      const liveRun = this.synthesizeLiveRun(liveTasks, Date.now());
      if (!liveRun) throw new Error(`Unknown Agent-Flow run: ${id}`);
      return {
        ...liveRun.summary,
        nodes: liveRun.nodes,
        events: liveRun.events,
        spec: null,
      };
    }

    const isCodex = id.startsWith('codex:');
    const slug = isCodex ? id.slice('codex:'.length) : id;
    const rootDir = isCodex ? this.codexRunsDir : this.primaryRunsDir;
    const source: 'agent-flow' | 'codex-runs' = isCodex ? 'codex-runs' : 'agent-flow';

    if (
      !slug ||
      slug === '.' ||
      slug === '..' ||
      slug.includes('..') ||
      slug.includes('/') ||
      slug.includes('\\') ||
      slug.includes('\0') ||
      slug.startsWith('.') ||
      slug.trim() !== slug
    ) {
      throw new Error(`Invalid Agent-Flow run id: ${id}`);
    }

    let rootReal: string;
    try {
      const rootStat = fs.statSync(rootDir);
      if (!rootStat.isDirectory()) throw new Error(`Unknown Agent-Flow run: ${id}`);
      rootReal = fs.realpathSync(rootDir);
    } catch {
      throw new Error(`Unknown Agent-Flow run: ${id}`);
    }

    const candidatePath = path.resolve(rootReal, slug);
    if (!candidatePath.startsWith(rootReal + path.sep)) {
      throw new Error(`Invalid Agent-Flow run id: ${id}`);
    }

    let candidateReal: string;
    try {
      candidateReal = fs.realpathSync(candidatePath);
    } catch {
      throw new Error(`Unknown Agent-Flow run: ${id}`);
    }

    if (!candidateReal.startsWith(rootReal + path.sep)) {
      throw new Error(`Invalid Agent-Flow run id: ${id}`);
    }

    try {
      if (!fs.statSync(candidateReal).isDirectory()) {
        throw new Error(`Unknown Agent-Flow run: ${id}`);
      }
    } catch {
      throw new Error(`Unknown Agent-Flow run: ${id}`);
    }

    const parsed = this.parseRunDirectory(candidateReal, slug, source, Date.now());
    if (!parsed) throw new Error(`Unknown Agent-Flow run: ${id}`);

    const spec = readSpecContent(candidateReal);
    return {
      ...parsed.summary,
      nodes: parsed.nodes,
      events: parsed.events,
      spec,
    };
  }

  private collectDiskRuns(nowMs: number): ParsedRunInternal[] {
    const roots: Array<{ dir: string; source: 'agent-flow' | 'codex-runs' }> = [
      { dir: this.primaryRunsDir, source: 'agent-flow' },
      { dir: this.codexRunsDir, source: 'codex-runs' },
    ];
    const seenRoots = new Set<string>();
    const seenIds = new Set<string>();
    const results: ParsedRunInternal[] = [];

    for (const root of roots) {
      let rootReal: string;
      try {
        if (!fs.existsSync(root.dir)) continue;
        if (!fs.statSync(root.dir).isDirectory()) continue;
        rootReal = fs.realpathSync(root.dir);
      } catch {
        continue;
      }
      if (seenRoots.has(rootReal)) continue;
      seenRoots.add(rootReal);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(rootReal, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const runPath = path.join(rootReal, entry.name);
        let runReal: string;
        try {
          runReal = fs.realpathSync(runPath);
          if (!runReal.startsWith(rootReal + path.sep)) continue;
          if (!fs.statSync(runReal).isDirectory()) continue;
        } catch {
          continue;
        }
        const parsed = this.parseRunDirectory(runReal, entry.name, root.source, nowMs);
        if (!parsed) continue;
        if (seenIds.has(parsed.summary.id)) continue;
        seenIds.add(parsed.summary.id);
        results.push(parsed);
      }
    }

    return results;
  }

  private synthesizeLiveRun(liveTasks: readonly TaskInfo[], nowMs: number): ParsedRunInternal | null {
    if (liveTasks.length === 0) return null;

    const nodes: AgentFlowNode[] = [];
    const rawEvents: Array<Omit<AgentFlowEvent, 'seq'>> = [];

    for (const task of liveTasks) {
      const nodeStatus = mapTaskStatusToNodeStatus(task.status);
      const agent = normalizeAgentId(task.agent);
      const model = task.model ?? '';
      const startedAt = task.startedAt;
      const updatedAt = task.endedAt ?? Math.max(startedAt, nowMs);
      const durationMs = Math.max(0, updatedAt - startedAt);
      const summary = task.error ?? task.result ?? task.prompt;
      const label = summarizePrompt(task.prompt, task.id);

      let eventCount = 1;
      rawEvents.push({
        ts: startedAt,
        sub: task.id,
        event: 'dispatched',
        agent,
        model,
        ...(task.effort ? { effort: task.effort } : {}),
        round: 1,
        summary: task.prompt,
        ...(task.cwd ? { note: task.cwd } : {}),
        artifacts: [],
      });

      if (task.status !== 'running') {
        eventCount = 2;
        rawEvents.push({
          ts: task.endedAt ?? updatedAt,
          sub: task.id,
          event: task.status === 'completed' ? 'accepted' : task.status,
          agent,
          model,
          ...(task.effort ? { effort: task.effort } : {}),
          round: 1,
          summary: task.result ?? task.error ?? task.status,
          ...(task.error ? { note: task.error } : {}),
          artifacts: [],
        });
      }

      nodes.push({
        id: task.id,
        label,
        agent,
        model,
        ...(task.effort ? { effort: task.effort } : {}),
        status: nodeStatus,
        round: 1,
        startedAt,
        updatedAt,
        durationMs,
        summary,
        ...(task.error ? { note: task.error } : task.cwd ? { note: task.cwd } : {}),
        artifacts: [],
        usage: emptyUsage(),
        eventCount,
      });
    }

    rawEvents.sort((a, b) => a.ts - b.ts);
    const events: AgentFlowEvent[] = rawEvents.map((ev, index) => ({ seq: index + 1, ...ev }));

    const hasRunning = nodes.some(n => n.status === 'dispatched');
    const hasRejected = nodes.some(n => n.status === 'rejected');
    const allAccepted = nodes.every(n => n.status === 'accepted');
    const runStatus: AgentFlowRunSummary['status'] = hasRunning
      ? 'dispatched'
      : hasRejected
        ? 'rejected'
        : allAccepted
          ? 'accepted'
          : 'idle';

    const createdAt = Math.min(...nodes.map(n => n.startedAt));
    const updatedAt = Math.max(...nodes.map(n => n.updatedAt));
    const durationMs = Math.max(0, updatedAt - createdAt);

    return {
      summary: {
        id: 'bridge-live',
        slug: 'bridge-live',
        name: 'AgentTote Live Tasks',
        source: 'bridge-live',
        status: runStatus,
        createdAt,
        updatedAt,
        durationMs,
        agents: [...new Set(nodes.map(n => n.agent).filter(Boolean))],
        nodeCount: nodes.length,
        acceptedCount: nodes.filter(n => n.status === 'accepted').length,
        rejectedCount: nodes.filter(n => n.status === 'rejected').length,
        eventCount: events.length,
        hasSpec: false,
        artifacts: [],
        usage: emptyUsage(),
      },
      nodes,
      events,
    };
  }

  private getCodexSessionIndex(forceRefresh = false): Map<string, string> {
    const now = Date.now();
    if (!forceRefresh && this.codexSessionIndexCache.ts > 0 && now - this.codexSessionIndexCache.ts < CODEX_INDEX_TTL_MS) {
      return this.codexSessionIndexCache.byUuid;
    }

    const byUuid = new Map<string, string>();
    let rootReal: string;
    try {
      if (!fs.existsSync(this.codexSessionsDir) || !fs.statSync(this.codexSessionsDir).isDirectory()) {
        this.codexSessionIndexCache = { ts: now, byUuid };
        return byUuid;
      }
      rootReal = fs.realpathSync(this.codexSessionsDir);
    } catch {
      this.codexSessionIndexCache = { ts: now, byUuid };
      return byUuid;
    }

    const walk = (dir: string, depth: number) => {
      if (depth > 5) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const match = entry.name.match(ROLLOUT_UUID_RE);
          if (match) {
            byUuid.set(match[1]!.toLowerCase(), fullPath);
          }
        }
      }
    };

    walk(rootReal, 0);
    this.codexSessionIndexCache = { ts: now, byUuid };
    return byUuid;
  }

  private readRolloutTokenUsage(filePath: string): AgentFlowUsage | undefined {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return undefined;

      const cached = this.rolloutUsageCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.usage;
      }

      let content = '';
      if (stat.size <= MAX_ROLLOUT_TAIL_BYTES) {
        content = fs.readFileSync(filePath, 'utf8');
      } else {
        let fd: number | null = null;
        try {
          fd = fs.openSync(filePath, 'r');
          const buf = Buffer.allocUnsafe(MAX_ROLLOUT_TAIL_BYTES);
          const bytesRead = fs.readSync(fd, buf, 0, MAX_ROLLOUT_TAIL_BYTES, stat.size - MAX_ROLLOUT_TAIL_BYTES);
          content = buf.toString('utf8', 0, bytesRead);
        } finally {
          if (fd !== null) {
            try {
              fs.closeSync(fd);
            } catch {
              // ignore
            }
          }
        }
      }

      let usage: AgentFlowUsage | undefined;
      const lines = content.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line || !line.includes('"token_count"')) continue;
        try {
          const parsed = JSON.parse(line) as { payload?: { type?: string; info?: { total_token_usage?: unknown } } };
          const payload = parsed?.payload;
          if (payload?.type === 'token_count' && payload.info?.total_token_usage) {
            const normalized = normalizeUsage(payload.info.total_token_usage, 'codex-session');
            if (normalized) {
              usage = normalized;
              break;
            }
          }
        } catch {
          // skip malformed or partial tail line
        }
      }

      if (this.rolloutUsageCache.size >= MAX_ROLLOUT_CACHE_ENTRIES) {
        const firstKey = this.rolloutUsageCache.keys().next().value;
        if (firstKey !== undefined) this.rolloutUsageCache.delete(firstKey);
      }
      this.rolloutUsageCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
      return usage;
    } catch {
      return undefined;
    }
  }

  private backfillCodexRunUsage(runDir: string, nodes: AgentFlowNode[]): void {
    if (nodes.length === 0) return;
    const nodesNeedingUsage = nodes.filter(n => !n.usage || n.usage.totalTokens === 0);
    if (nodesNeedingUsage.length === 0) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(runDir, { withFileTypes: true });
    } catch {
      return;
    }

    const logFiles = entries
      .filter(e => e.isFile() && LOG_FILE_RE.test(e.name))
      .map(e => e.name)
      .sort();
    if (logFiles.length === 0) return;

    const sessionIndex = this.getCodexSessionIndex();
    if (sessionIndex.size === 0) return;

    const nodeSessionUsages = new Map<string, Map<string, AgentFlowUsage>>();

    const findTargetNode = (filename: string): AgentFlowNode | null => {
      const dashMatch = filename.match(/^log[-_](.+)\.txt$/i);
      if (dashMatch) {
        const stem = dashMatch[1]!;
        const stemLower = stem.toLowerCase();

        const exact = nodesNeedingUsage.find(n => n.id === stem || n.id.toLowerCase() === stemLower);
        if (exact) return exact;

        let bestPrefix: AgentFlowNode | null = null;
        for (const n of nodesNeedingUsage) {
          const nid = n.id.toLowerCase();
          if (stemLower.startsWith(`${nid}-`) || stemLower.startsWith(`${nid}_`)) {
            if (!bestPrefix || n.id.length > bestPrefix.id.length) {
              bestPrefix = n;
            }
          }
        }
        if (bestPrefix) return bestPrefix;
      }

      if (nodesNeedingUsage.length === 1) return nodesNeedingUsage[0]!;
      const codexCandidates = nodesNeedingUsage.filter(n => n.agent === 'codex');
      if (codexCandidates.length === 1) return codexCandidates[0]!;
      return null;
    };

    for (const filename of logFiles) {
      const targetNode = findTargetNode(filename);
      if (!targetNode) continue;

      const sessionId = extractSessionIdFromLog(path.join(runDir, filename));
      if (!sessionId) continue;

      const rolloutPath = sessionIndex.get(sessionId);
      if (!rolloutPath) continue;

      const usage = this.readRolloutTokenUsage(rolloutPath);
      if (!usage) continue;

      let perSession = nodeSessionUsages.get(targetNode.id);
      if (!perSession) {
        perSession = new Map();
        nodeSessionUsages.set(targetNode.id, perSession);
      }
      if (!perSession.has(sessionId)) {
        perSession.set(sessionId, usage);
      }
    }

    for (const node of nodesNeedingUsage) {
      const perSession = nodeSessionUsages.get(node.id);
      if (perSession && perSession.size > 0) {
        node.usage = sumUsages([...perSession.values()], 'codex-session');
      }
    }
  }

  private parseRunDirectory(
    runDir: string,
    slug: string,
    source: 'agent-flow' | 'codex-runs',
    nowMs: number,
  ): ParsedRunInternal | null {
    let dirMtimeMs = 0;
    try {
      dirMtimeMs = fs.statSync(runDir).mtimeMs;
    } catch {
      return null;
    }

    const eventsPath = path.join(runDir, 'events.jsonl');
    let hasEvents = false;
    let rawEventsText = '';
    try {
      if (fs.existsSync(eventsPath)) {
        const stat = fs.statSync(eventsPath);
        if (stat.isFile()) {
          rawEventsText = fs.readFileSync(eventsPath, 'utf8');
          hasEvents = true;
          dirMtimeMs = Math.max(dirMtimeMs, stat.mtimeMs);
        }
      }
    } catch {
      // ignore unreadable events.jsonl
    }

    const specCheck = hasAnySpec(runDir);
    const hasSpec = specCheck.hasSpec;
    if (specCheck.mtimeMs > dirMtimeMs) dirMtimeMs = specCheck.mtimeMs;

    if (!hasEvents && !(source === 'agent-flow' && hasSpec)) {
      return null;
    }

    const fallbackTs = Math.round(dirMtimeMs);
    const parsedEvents: ParsedEventInternal[] = [];

    if (rawEventsText) {
      const lines = rawEventsText.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

          const tsMs = parseTimestamp(raw.t ?? raw.timestamp ?? raw.time ?? raw.ts);
          const rawEventName = String(raw.event ?? raw.type ?? raw.status ?? 'event');
          const status = normalizeEventStatus(rawEventName);
          const sub = String(raw.sub ?? raw.subtask ?? raw.node ?? raw.step ?? 'main');
          const rawArtifacts = Array.isArray(raw.artifacts)
            ? raw.artifacts
            : raw.artifact != null && raw.artifact !== ''
              ? [raw.artifact]
              : [];
          const usage = normalizeUsage(raw.usage ?? raw.tokens ?? raw.token_usage, 'events');
          const parsedRound = raw.round != null && raw.round !== '' ? toNonNegativeInt(raw.round) : null;
          const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note : undefined;
          const effort = typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort : undefined;
          const label = typeof raw.label === 'string' && raw.label.trim()
            ? raw.label.trim()
            : typeof raw.title === 'string' && raw.title.trim()
              ? raw.title.trim()
              : undefined;

          parsedEvents.push({
            seq: i + 1,
            tsMs,
            sub,
            label,
            event: rawEventName,
            status,
            agent: raw.agent != null && String(raw.agent).trim() ? normalizeAgentId(raw.agent) : null,
            model: raw.model != null && String(raw.model).trim() ? String(raw.model) : null,
            effort,
            round: parsedRound,
            summary: String(raw.summary ?? raw.message ?? raw.reason ?? raw.note ?? ''),
            note,
            artifacts: rawArtifacts.map(String),
            usage,
          });
        } catch {
          // silently skip malformed JSONL line
        }
      }
    }

    parsedEvents.sort((a, b) => {
      if (a.tsMs != null && b.tsMs != null && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
      return a.seq - b.seq;
    });

    const nodesMap = new Map<string, MutableNode>();
    const artifactSet = new Set<string>();

    for (const ev of parsedEvents) {
      let node = nodesMap.get(ev.sub);
      if (!node) {
        node = {
          id: ev.sub,
          label: ev.label ?? ev.sub,
          agent: ev.agent ?? 'antigravity',
          model: ev.model ?? '',
          effort: ev.effort,
          status: ev.status,
          round: ev.round ?? 1,
          dispatchedAt: null,
          deliveredAt: null,
          acceptedAt: null,
          rejectedAt: null,
          firstEventAt: ev.tsMs,
          lastEventAt: ev.tsMs,
          summary: ev.summary,
          note: ev.note,
          artifacts: [],
          eventCount: 0,
          usageByRound: new Map(),
        };
        nodesMap.set(ev.sub, node);
      }

      if (ev.label) node.label = ev.label;
      if (ev.agent) node.agent = ev.agent;
      if (ev.model) node.model = ev.model;
      if (ev.effort) node.effort = ev.effort;
      if (ev.round != null) node.round = ev.round;
      if (ev.summary) node.summary = ev.summary;
      if (ev.note) node.note = ev.note;

      if (ev.usage) {
        const roundKey = String(ev.round ?? node.round ?? 1);
        const prev = node.usageByRound.get(roundKey);
        if (!prev || ev.usage.totalTokens >= prev.totalTokens) {
          node.usageByRound.set(roundKey, ev.usage);
        } else {
          const populatedCount = (u: AgentFlowUsage) =>
            [u.inputTokens, u.outputTokens, u.thinkingTokens, u.cacheReadTokens].filter(v => v > 0).length;
          if (populatedCount(ev.usage) >= populatedCount(prev)) {
            node.usageByRound.set(roundKey, ev.usage);
          }
        }
      }

      node.status = ev.status;
      node.eventCount += 1;

      if (ev.tsMs != null) {
        if (node.firstEventAt == null || ev.tsMs < node.firstEventAt) node.firstEventAt = ev.tsMs;
        if (node.lastEventAt == null || ev.tsMs > node.lastEventAt) node.lastEventAt = ev.tsMs;
        if (ev.status === 'dispatched' && node.dispatchedAt == null) node.dispatchedAt = ev.tsMs;
        if (ev.status === 'delivered') node.deliveredAt = ev.tsMs;
        if (ev.status === 'accepted') node.acceptedAt = ev.tsMs;
        if (ev.status === 'rejected') node.rejectedAt = ev.tsMs;
      }

      for (const art of ev.artifacts) {
        artifactSet.add(art);
        if (!node.artifacts.includes(art)) node.artifacts.push(art);
      }
    }

    const nodes: AgentFlowNode[] = [...nodesMap.values()].map(m => {
      const startedAt = m.dispatchedAt ?? m.firstEventAt ?? fallbackTs;
      const updatedAt = m.lastEventAt ?? fallbackTs;
      const endMs = m.acceptedAt ?? m.rejectedAt ?? m.deliveredAt ?? null;
      let durationMs = 0;
      if (endMs != null && endMs >= startedAt) {
        durationMs = endMs - startedAt;
      } else if (m.status === 'dispatched') {
        durationMs = Math.max(0, nowMs - startedAt);
      } else if (updatedAt >= startedAt) {
        durationMs = updatedAt - startedAt;
      }

      const usage = m.usageByRound.size > 0 ? sumUsages([...m.usageByRound.values()], 'events') : emptyUsage();

      return {
        id: m.id,
        label: m.label,
        agent: m.agent,
        model: m.model,
        ...(m.effort ? { effort: m.effort } : {}),
        status: m.status,
        round: m.round,
        startedAt,
        updatedAt,
        durationMs,
        summary: m.summary,
        ...(m.note ? { note: m.note } : {}),
        artifacts: m.artifacts,
        usage,
        eventCount: m.eventCount,
      };
    });

    this.backfillCodexRunUsage(runDir, nodes);

    const runUsage = sumUsages(nodes.map(n => n.usage));

    const events: AgentFlowEvent[] = parsedEvents.map(ev => {
      const node = nodesMap.get(ev.sub);
      return {
        seq: ev.seq,
        ts: ev.tsMs ?? fallbackTs,
        sub: ev.sub,
        event: ev.event,
        agent: ev.agent ?? node?.agent ?? 'antigravity',
        model: ev.model ?? node?.model ?? '',
        ...(ev.effort ?? node?.effort ? { effort: ev.effort ?? node?.effort } : {}),
        round: ev.round ?? node?.round ?? 1,
        summary: ev.summary,
        ...(ev.note ? { note: ev.note } : {}),
        artifacts: ev.artifacts,
        ...(ev.usage ? { usage: ev.usage } : {}),
      };
    });

    let runStatus: AgentFlowRunSummary['status'] = 'idle';
    if (nodes.length > 0) {
      const statuses = nodes.map(n => n.status);
      if (statuses.some(s => s === 'rejected')) {
        runStatus = 'rejected';
      } else if (statuses.every(s => s === 'accepted')) {
        runStatus = 'accepted';
      } else if (statuses.some(s => s === 'dispatched')) {
        runStatus = 'dispatched';
      } else if (statuses.some(s => s === 'delivered')) {
        runStatus = 'delivered';
      } else {
        runStatus = 'idle';
      }
    }

    const firstTs = parsedEvents.reduce<number | null>(
      (min, ev) => (ev.tsMs != null && (min == null || ev.tsMs < min) ? ev.tsMs : min),
      null,
    );
    const lastTs = parsedEvents.reduce<number | null>(
      (max, ev) => (ev.tsMs != null && (max == null || ev.tsMs > max) ? ev.tsMs : max),
      null,
    );
    const createdAt = firstTs ?? fallbackTs;
    const updatedAt = lastTs ?? fallbackTs;

    let durationMs = 0;
    if (updatedAt > createdAt) {
      durationMs = updatedAt - createdAt;
    } else if (runStatus === 'dispatched') {
      durationMs = Math.max(0, nowMs - createdAt);
    }

    const runId = source === 'agent-flow' ? slug : `codex:${slug}`;

    return {
      summary: {
        id: runId,
        slug,
        name: slug,
        source,
        status: runStatus,
        createdAt,
        updatedAt,
        durationMs,
        agents: [...new Set(nodes.map(n => n.agent).filter(Boolean))],
        nodeCount: nodes.length,
        acceptedCount: nodes.filter(n => n.status === 'accepted').length,
        rejectedCount: nodes.filter(n => n.status === 'rejected').length,
        eventCount: events.length,
        hasSpec,
        artifacts: [...artifactSet],
        usage: runUsage,
      },
      nodes,
      events,
      dirPath: runDir,
    };
  }
}
