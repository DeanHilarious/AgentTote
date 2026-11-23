import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { AccountError } from './account.ts';
import type { AccountClient } from './account.ts';

class InputEndedError extends Error {}

export async function login(client: AccountClient, options: {
  question?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
  input?: Readable;
  output?: Writable;
} = {}): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = !!(input as Readable & { isTTY?: boolean }).isTTY;
  let hidden = false;
  const quietOutput = new Writable({ write(chunk, _encoding, done) {
    if (hidden) done();
    else output.write(chunk, done);
  } });
  const readline = options.question ? undefined : createInterface({ input, output: quietOutput, terminal });
  // Subscribe before the first await so piped lines survive prompts and network requests.
  const lines = readline?.[Symbol.asyncIterator]();
  const question = options.question ?? (async (prompt: string) => {
    readline!.setPrompt(prompt);
    readline!.prompt();
    const line = await lines!.next();
    if (line.done) throw new InputEndedError('输入已结束，登录未完成');
    return line.value;
  });
  const secretQuestion = async (prompt: string) => {
    if (options.question || !terminal) return question(prompt);
    hidden = true;
    output.write(prompt);
    readline!.setPrompt('');
    try {
      const line = await lines!.next();
      if (line.done) throw new InputEndedError('输入已结束，登录未完成');
      return line.value;
    } finally { hidden = false; output.write('\n'); }
  };
  const log = options.log ?? console.log;
  const finish = async (user: NonNullable<AccountClient['user']>) => {
    const registered = await client.registerDevice();
    if (!client.user) return false;
    if (registered) log(`已登录：${user.email ?? user.phone ?? user.id}，本机已加入账号`);
    else log(`已登录：${user.email ?? user.phone ?? user.id}，本机注册未完成；启动 bridge 后会重试，设备归属冲突请按提示处理`);
    return true;
  };
  try {
    const entry = (await question('邮箱（输入 r 注册，f 重置密码）：')).trim();
    if (entry !== 'r' && entry !== 'f') {
      return await finish(await client.login(entry, await secretQuestion('密码：')));
    }
    const email = (await question('邮箱：')).trim();
    await client.sendCode(email, entry === 'r' ? 'register' : 'reset');
    log('如果邮箱符合条件，验证码已发送');
    if (entry === 'f') log('重置密码会退出其他设备，包括 Mac');
    const code = (await secretQuestion('6 位验证码：')).trim();
    if (!/^\d{6}$/.test(code)) { log('请输入 6 位验证码'); return false; }
    const password = await secretQuestion('新密码：');
    const confirmation = await secretQuestion('确认密码：');
    if (password !== confirmation) { log('两次密码不一致，请运行 npm run login 重试'); return false; }
    return await finish(entry === 'r' ? await client.register(email, code, password) : await client.resetPassword(email, code, password));
  } catch (error) {
    if (error instanceof InputEndedError) log(error.message);
    else if (error instanceof AccountError && error.status === 429) log(`请求过于频繁，请在 ${error.retryAfter ?? 60} 秒后再试`);
    else if (error instanceof AccountError) log(`登录失败：${error.code}`);
    else log('登录未完成，请检查账号服务连接和本地账号文件权限');
    return false;
  } finally {
    readline?.close();
  }
}
