import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { feedbackReport, exportOptions, renderFeedback } from './feedback-export.ts';
import { SmtpSender } from './senders.ts';
import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createSenders } from './senders.ts';

try {
  if (process.argv[2] === 'feedback') {
    const { since, format } = exportOptions(process.argv.slice(3));
    const dataDir = resolve(process.env.AA_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url)));
    const db = new DatabaseSync(resolve(dataDir, 'account.sqlite'), { readOnly: true });
    try { console.log(renderFeedback(feedbackReport(db, since), format)); }
    finally { db.close(); }
  } else {
    const config = loadConfig();
    const senders = createSenders(config);
    const server = createApp({
      databasePath: resolve(config.dataDir, 'account.sqlite'),
      serverSecret: config.serverSecret,
      signingKey: config.signingKey,
      testAccounts: config.testAccounts,
      senders,
      feedbackNotification: config.feedbackEmail && senders.email instanceof SmtpSender ?
        { to: config.feedbackEmail, sender: senders.email } : undefined,
      log: console.log,
      apns: config.apns,
    });
    server.once('error', () => {
      console.error('账号服务监听失败，请检查端口与监听权限');
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      const address = server.address();
      console.log(`AgentTote account service: http://localhost:${typeof address === 'object' && address ? address.port : config.port}`);
      console.log(`发送渠道: email=${config.emailSender}, sms=${config.smsSender}`);
    });
    const shutdown = () => server.close();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} catch {
  // Do not echo configuration parser errors: they may include SMTP credentials or key material.
  console.error(process.argv[2] === 'feedback' ?
    '反馈导出失败。用法：feedback [--since 7d|30d|all] [--format table|json|csv]；请检查 AA_DATA_DIR 与数据库是否已初始化。' :
    '账号服务启动失败，请检查环境变量、Ed25519 私钥与数据目录权限');
  process.exitCode = 1;
}
