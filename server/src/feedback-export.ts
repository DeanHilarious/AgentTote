import type { DatabaseSync } from 'node:sqlite';
import { agentName } from './feedback.ts';
import type { FeedbackRow } from './feedback.ts';

export function exportOptions(args: string[]) {
  let since = '30d', format = 'table';
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === '--since' && ['7d', '30d', 'all'].includes(value)) since = value;
    else if (args[i] === '--format' && ['table', 'json', 'csv'].includes(value)) format = value;
    else throw new Error('Usage: feedback [--since 7d|30d|all] [--format table|json|csv]');
  }
  return { since, format };
}
export function feedbackReport(db: DatabaseSync, since: string, now = Date.now()) {
  const cutoff = since === 'all' ? -1 : now - (since === '7d' ? 7 : 30) * 86400_000;
  const rows = db.prepare('SELECT * FROM feedback WHERE created_at >= ? ORDER BY created_at DESC, id DESC').all(cutoff) as unknown as FeedbackRow[];
  const identities = new Map<string, Map<string, string>>();
  // Connected identity groups: a repeated account OR a repeated IP merges requests,
  // including anonymous requests later submitted from the same IP while signed in.
  for (const row of rows.filter(r => r.kind === 'agent_request')) {
    for (const agent of new Set(JSON.parse(row.agents) as string[])) {
      let parents = identities.get(agent);
      if (!parents) { parents = new Map(); identities.set(agent, parents); }
      const root = (key: string): string => {
        if (!parents!.has(key)) parents!.set(key, key);
        let result = key;
        while (parents!.get(result) !== result) result = parents!.get(result)!;
        while (key !== result) { const next = parents!.get(key)!; parents!.set(key, result); key = next; }
        return result;
      };
      const ip = root(`ip:${row.ip_hash}`);
      if (row.user_id) parents.set(root(`user:${row.user_id}`), ip);
    }
  }
  const ranking = [...identities].map(([agent, parents]) => {
    const roots = new Set<string>();
    for (let key of parents.keys()) {
      while (parents.get(key) !== key) key = parents.get(key)!;
      roots.add(key);
    }
    return { agent, name: agentName(agent), count: roots.size };
  }).sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent));
  return { ranking, feedback: rows.map(row => ({
    ...row, agents: JSON.parse(row.agents) as string[], diagnostics: JSON.parse(row.diagnostics) as Record<string, unknown>,
    contact_ok: Boolean(row.contact_ok), created_at: new Date(row.created_at).toISOString(),
  })) };
}
const terminalText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
// Avoid spreadsheet formulas when CSV is opened in Excel/Numbers.
const csvCell = (value: unknown) => {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
};
export function renderFeedback(report: ReturnType<typeof feedbackReport>, format: string): string {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'csv') {
    // A single rectangular CSV holds both ranking and full feedback records.
    const header = ['record_type', 'agent', 'name', 'count', 'id', 'user_id', 'kind', 'agents', 'message', 'contact_ok', 'contact_email', 'diagnostics', 'ip_hash', 'created_at'];
    const lines: unknown[][] = [header, ...report.ranking.map(r => ['ranking', r.agent, r.name, r.count])];
    for (const row of report.feedback) lines.push(['feedback', '', '', '', row.id, row.user_id, row.kind,
      JSON.stringify(row.agents), row.message, row.contact_ok, row.contact_email, JSON.stringify(row.diagnostics), row.ip_hash, row.created_at]);
    return lines.map(line => header.map((_, i) => csvCell(line[i])).join(',')).join('\r\n');
  }
  return ['各 Agent 被申请次数（同账号或同 IP 去重）',
    ...report.ranking.map(r => `${r.count}\t${terminalText(r.name)} [${terminalText(r.agent)}]`),
    '', '最近反馈（时间倒序）', '时间\tID\t类型\tAgent\t留言',
    ...report.feedback.map(r => `${r.created_at}\t${r.id}\t${r.kind}\t${terminalText(r.agents.join(', '))}\t${terminalText([...r.message].slice(0, 100).join(''))}${[...r.message].length > 100 ? '…' : ''}`),
  ].join('\n');
}
