import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Config } from './config.ts';
import type { Channel, Purpose } from './targets.ts';

export interface CodeSender {
  send(target: string, code: string, purpose: Purpose): Promise<void>;
}

export class ConsoleSender implements CodeSender {
  private log: (message: string) => void;

  constructor(log = console.log) {
    this.log = log;
  }

  async send(target: string, code: string, purpose: Purpose): Promise<void> {
    this.log(`[console] ${purpose} ${target}: ${code}（5 分钟内有效）`);
  }
}

export interface MailSender {
  sendMail(target: string, mail: { subject: string; text: string; html?: string }): Promise<void>;
}

export class SmtpSender implements CodeSender, MailSender {
  private transport: Pick<Transporter, 'sendMail'>;
  private from: string;

  constructor(url: string, from: string, transport?: Pick<Transporter, 'sendMail'>) {
    this.transport = transport ?? nodemailer.createTransport(url);
    this.from = from;
  }

  async sendMail(target: string, mail: { subject: string; text: string; html?: string }): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: target, ...mail });
  }

  async send(target: string, code: string, purpose: Purpose): Promise<void> {
    const action = { register: '注册', reset: '重置密码', bind: '绑定邮箱' }[purpose];
    const subject = `AgentTote ${action}验证码`;
    // Only a six-digit generated code enters the HTML template.
    if (!/^\d{6}$/.test(code)) throw new Error('Invalid verification code');
    await this.sendMail(target, {
      subject,
      text: `您的${action}验证码为 ${code}，5 分钟内有效。如非本人操作请忽略。`,
      html: `<div style="font-family:Arial,sans-serif;padding:24px;color:#222"><h2 style="color:#4B3AF0">${subject}</h2><p>您的验证码：</p><p style="font-family:monospace;font-size:36px;letter-spacing:6px;color:#4B3AF0">${code}</p><p>5 分钟内有效。如非本人操作请忽略。</p><p style="font-size:12px;color:#666">This code expires in 5 minutes. If you did not request it, please ignore this email.</p></div>`,
    });
  }
}

export class AliyunSmsSender implements CodeSender {
  async send(_target: string, _code: string, _purpose: Purpose): Promise<void> {
    throw new Error('阿里云短信未配置');
  }
}

export class TencentSmsSender implements CodeSender {
  async send(_target: string, _code: string, _purpose: Purpose): Promise<void> {
    throw new Error('腾讯云短信未配置');
  }
}

export function createSenders(config: Config, log = console.log): Record<Channel, CodeSender> {
  return {
    email: config.emailSender === 'smtp' ? new SmtpSender(config.smtpUrl!, config.mailFrom!) : new ConsoleSender(log),
    sms: config.smsSender === 'aliyun' ? new AliyunSmsSender() :
      config.smsSender === 'tencent' ? new TencentSmsSender() : new ConsoleSender(log),
  };
}
