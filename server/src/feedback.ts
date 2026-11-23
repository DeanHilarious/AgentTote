import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { HttpError } from './errors.ts';
import type { MailSender } from './senders.ts';

// Keep IDs and names in sync with ios/AgentAnywhere/Models/Feedback.swift.
export const agentCandidates: Record<string, string> = {
  'gemini-cli': 'Gemini CLI', cursor: 'Cursor', 'copilot-cli': 'GitHub Copilot CLI',
  'qwen-code': 'Qwen Code', 'kimi-cli': 'Kimi CLI', trae: 'Trae', 'tongyi-lingma': '通义灵码',
  opencode: 'OpenCode', aider: 'Aider', cline: 'Cline', amp: 'Amp', 'iflow-cli': 'iFlow CLI', 'claude-code': 'Claude Code',
};
export const agentName = (id: string): string => Object.hasOwn(agentCandidates, id) ? agentCandidates[id] : id;
const kinds = ['agent_request', 'bug', 'idea', 'other'] as const;
export type FeedbackKind = typeof kinds[number];
const labels: Record<FeedbackKind, string> = { agent_request: '申请 Agent', bug: '问题', idea: '建议', other: '其他' };
const invalid = (field: string): never => { throw new HttpError(400, 'invalid_request', `Invalid ${field}`); };
const length = (s: string) => [...s].length;
function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (value === undefined) return '';
  if (typeof value !== 'string' || length(value) > max) return invalid(key);
  return value.trim();
}
export function feedbackBody(body: Record<string, unknown>) {
  if (!kinds.includes(body.kind as FeedbackKind)) invalid('kind');
  const kind = body.kind as FeedbackKind;
  if (body.agents !== undefined && (!Array.isArray(body.agents) || body.agents.length > 10 ||
    body.agents.some(a => typeof a !== 'string' || !Object.hasOwn(agentCandidates, a)))) invalid('agents');
  const agents = [...new Set((body.agents ?? []) as string[])];
  const other = text(body, 'otherAgent', 60);
  const message = text(body, 'message', 2000);
  if (kind === 'agent_request' ? !agents.length && !other : !message) invalid(kind === 'agent_request' ? 'agents' : 'message');
  if (body.contactOk !== undefined && typeof body.contactOk !== 'boolean') invalid('contactOk');
  const diagnostics: Record<string, string | string[]> = {};
  if (body.diagnostics !== undefined) {
    if (!body.diagnostics || typeof body.diagnostics !== 'object' || Array.isArray(body.diagnostics)) invalid('diagnostics');
    const input = body.diagnostics as Record<string, unknown>;
    for (const key of ['appVersion', 'build', 'osVersion', 'deviceModel', 'bridgeVersion', 'locale']) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'string' || length(input[key] as string) > 64) invalid(`diagnostics.${key}`);
        diagnostics[key] = input[key] as string;
      }
    }
    if (input.enabledAgents !== undefined) {
      if (!Array.isArray(input.enabledAgents) ||
        input.enabledAgents.some(a => !['claude', 'codex', 'workbuddy', 'antigravity', 'cursor'].includes(a))) invalid('diagnostics.enabledAgents');
      diagnostics.enabledAgents = [...new Set(input.enabledAgents as string[])];
    }
  }
  return { kind, agents: [...new Set([...agents, ...(other ? [other] : [])])], message, contactOk: body.contactOk === true, diagnostics };
}
export interface FeedbackRow {
  id: string; user_id: string | null; kind: FeedbackKind; agents: string; message: string;
  contact_ok: number; contact_email: string | null; diagnostics: string; ip_hash: string; created_at: number;
}
export function feedbackMail(row: FeedbackRow) {
  const agents = (JSON.parse(row.agents) as string[]).map(a => agentName(a)).join(', ');
  return {
    subject: `AgentTote 反馈：${labels[row.kind]}${row.kind === 'agent_request' ? `（${agents.replace(/[\r\n]/g, ' ')}）` : ''}`,
    text: `类型：${labels[row.kind]}\n申请的 Agent：${agents || '无'}\n留言：\n${row.message}\n\n同意联系：${row.contact_ok ? '是' : '否'}\n联系邮箱：${row.contact_email ?? '无'}\n诊断信息：\n${JSON.stringify(JSON.parse(row.diagnostics), null, 2)}\n时间：${new Date(row.created_at).toISOString()}\n反馈 id：${row.id}`,
  };
}
export function createFeedback(db: DatabaseSync, secret: string, now: () => number,
  log: (message: string) => void = () => {}, notification?: { to: string; sender: MailSender }) {
  return (body: Record<string, unknown>, ip: string, user?: { id: string; email?: string }) => {
    const input = feedbackBody(body);
    const time = now();
    const ipHash = createHmac('sha256', secret).update(`feedback-ip:${ip}`).digest('hex');
    const row: FeedbackRow = {
      id: randomUUID(), user_id: user?.id ?? null, kind: input.kind, agents: JSON.stringify(input.agents),
      message: input.message, contact_ok: Number(input.contactOk), contact_email: input.contactOk ? user?.email ?? null : null,
      diagnostics: JSON.stringify(input.diagnostics), ip_hash: ipHash, created_at: time,
    };
    transaction(db, () => {
      let retryAfter = 0;
      for (const [column, value, window, limit] of [
        ['ip_hash', ipHash, 3600_000, 10], ['ip_hash', ipHash, 86400_000, 30],
        ['user_id', user?.id ?? null, 86400_000, 20],
      ] as const) {
        if (!value) continue;
        const quota = db.prepare(`SELECT count(*) AS n, min(created_at) AS oldest FROM feedback WHERE ${column} = ? AND created_at > ?`).get(value, time - window)!;
        if (Number(quota.n) >= limit) retryAfter = Math.max(retryAfter, Math.ceil((Number(quota.oldest) + window - time) / 1000));
      }
      if (retryAfter) throw new HttpError(429, 'rate_limited', 'Feedback limit exceeded', retryAfter);
      db.prepare(`INSERT INTO feedback (id, user_id, kind, agents, message, contact_ok, contact_email, diagnostics, ip_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.user_id, row.kind, row.agents, row.message,
        row.contact_ok, row.contact_email, row.diagnostics, row.ip_hash, row.created_at);
    });
    log(JSON.stringify({ id: row.id, kind: row.kind, agents: input.agents }));
    // Delivery is deliberately outside the transaction and never delays the HTTP response.
    if (notification) void Promise.resolve().then(() => notification.sender.sendMail(notification.to, feedbackMail(row)))
      .catch(() => log(`Feedback notification failed: ${row.id}`));
    return { ok: true, id: row.id };
  };
}
