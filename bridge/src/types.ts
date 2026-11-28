// Wire protocol shared with the iOS app (see ios/AgentAnywhere/Models/Protocol.swift).
// Keep field names in sync on both sides.

export const AGENT_KINDS = ['claude', 'codex', 'workbuddy', 'antigravity', 'cursor'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
/** What phones decode when their `hello` lists no `agents`: older builds reject any other kind. */
export const LEGACY_AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'workbuddy'];

export type AgentStatus = 'ready' | 'unavailable' | 'needsLogin';

export interface AgentInfo {
  kind: AgentKind;
  name: string;
  status: AgentStatus;
  version?: string;
  iconHash?: string;
  /** Agent processes currently alive on the Mac (desktop app sessions, CLIs). */
  runningProcesses: number;
  detail?: string;
}

export interface SessionSummary {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  /** Unix epoch milliseconds. */
  updatedAt: number;
  /** True when the session is being worked on right now (by the Mac or by the bridge). */
  running: boolean;
  preview?: string;
  /** Where the conversation was started: the Mac app, this phone, or a CLI. */
  origin?: 'mac' | 'phone' | 'cli';
  /** Session this one was copied from with `thread/fork`. */
  forkedFromId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

/** Normalised across agents; each adapter maps it to its own permission/sandbox flags. */
export type PermissionMode = 'readOnly' | 'acceptEdits' | 'full';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  note?: string;
  isDefault: boolean;
  efforts?: string[];
  defaultEffort?: string;
}

export type TaskEventBody =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; change: 'created' | 'modified' | 'deleted' }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'status'; text: string }
  | { kind: 'result'; text: string; isError: boolean };

export type TaskEvent = TaskEventBody & { seq: number; ts: number };

export interface TaskInfo {
  id: string;
  agent: AgentKind;
  sessionId?: string;
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
  costUsd?: number;
  watching?: boolean;
}

export interface TaskAttachment {
  path: string;
  isImage: boolean;
}

export interface StartTaskOptions {
  attachments?: TaskAttachment[];
  sessionId?: string;
  cwd?: string;
  prompt: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: string;
  /** Continue a Codex session in a copy (`thread/fork`) instead of resuming it. */
  fork?: boolean;
}

/** What an adapter reports into while a task runs. */
export interface TaskSink {
  emit(event: TaskEventBody): void;
  output?(text: string): void;
  delta(messageId: string, text: string): void;
  setSession(sessionId: string): void;
  /** Execution metadata reported by the agent, including resolved defaults. */
  setModel?(model: string, effort?: string): void;
  finish(outcome: { status: Exclude<TaskStatus, 'running'>; result?: string; error?: string; costUsd?: number }): void;
}

export interface RunningTask {
  cancel(): void;
}

export interface Adapter {
  readonly kind: AgentKind;
  readonly name: string;
  detect(): Promise<AgentInfo>;
  listSessions(limit: number): Promise<SessionSummary[]>;
  getMessages(sessionId: string, limit: number): Promise<ChatMessage[]>;
  listModels?(): Promise<ModelOption[]>;
  startTask(opts: StartTaskOptions, sink: TaskSink): Promise<RunningTask>;
}

// ---- RPC envelope ----

export interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { id: number | string; result: unknown }
  | { id: number | string; error: { message: string } };

export interface TaskDraft { messageId: string; text: string }

export interface PushStatus { available: boolean; reason?: 'signed_out' | 'server_disabled' }

export type PushMessage =
  | { event: 'agents.updated'; data: AgentInfo[] }
  | { event: 'push.status'; data: PushStatus }
  | { event: 'task.delta'; data: { taskId: string; messageId: string; text: string; /** UTF-16 code units. */ offset: number } }
  | { event: 'task.event'; data: { taskId: string; event: TaskEvent } }
  | { event: 'task.updated'; data: TaskInfo };

// ---- Agent-Flow Studio ----

export interface AgentFlowUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  source?: string;
}

export interface AgentFlowTeamMember {
  id: string;
  name: string;
  shortName: string;
  account: string;
  tier: 'orchestrator' | 'executor' | 'bridge';
  role: string;
  defaultModel: string;
  accent: string;
  badge: string;
  binName: string;
  status: AgentStatus;
  runningProcesses: number;
  version?: string;
  detail?: string;
  isBridgeAgent: boolean;
}

export interface AgentFlowNode {
  id: string;
  label: string;
  agent: string;
  model: string;
  effort?: string;
  status: 'dispatched' | 'delivered' | 'accepted' | 'rejected' | 'event';
  round: number;
  startedAt: number;
  updatedAt: number;
  durationMs: number;
  summary: string;
  note?: string;
  artifacts: string[];
  usage: AgentFlowUsage;
  eventCount: number;
}

export interface AgentFlowEvent {
  seq: number;
  ts: number;
  sub: string;
  event: string;
  agent: string;
  model: string;
  effort?: string;
  round: number;
  summary: string;
  note?: string;
  artifacts: string[];
  usage?: AgentFlowUsage;
}

export interface AgentFlowRunSummary {
  id: string;
  slug: string;
  name: string;
  source: 'agent-flow' | 'codex-runs' | 'bridge-live';
  status: 'dispatched' | 'delivered' | 'accepted' | 'rejected' | 'idle';
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  agents: string[];
  nodeCount: number;
  acceptedCount: number;
  rejectedCount: number;
  eventCount: number;
  hasSpec: boolean;
  artifacts: string[];
  usage: AgentFlowUsage;
}

export interface AgentFlowRunDetail extends AgentFlowRunSummary {
  nodes: AgentFlowNode[];
  events: AgentFlowEvent[];
  spec: string | null;
}

export interface AgentFlowSnapshot {
  updatedAt: number;
  summary: {
    totalRuns: number;
    activeRuns: number;
    acceptedRuns: number;
    onlineMembers: number;
    totalMembers: number;
    liveTasksCount: number;
    usage: AgentFlowUsage;
  };
  team: AgentFlowTeamMember[];
  liveTasks: TaskInfo[];
  runs: AgentFlowRunSummary[];
}
