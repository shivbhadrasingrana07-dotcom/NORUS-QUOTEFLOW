export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  readonly mode: 'resend' | 'dev_outbox';
  send(msg: EmailMessage): Promise<{ delivered: boolean; provider: string }>;
}

export interface CapturedDevEmail extends EmailMessage {
  sentAt: string;
}

export class DevOutboxEmailProvider implements EmailProvider {
  readonly mode = 'dev_outbox' as const;
  readonly sent: CapturedDevEmail[] = [];

  async send(msg: EmailMessage): Promise<{ delivered: boolean; provider: string }> {
    this.sent.unshift({
      ...msg,
      sentAt: new Date().toISOString(),
    });
    if (this.sent.length > 50) {
      this.sent.length = 50;
    }
    if (process.env.NODE_ENV !== 'test') {
      // Never print full verification/reset tokens in logs
      console.info(`[email:dev_outbox] Queued "${msg.subject}" to ${msg.to}`);
    }
    return { delivered: true, provider: 'dev_outbox' };
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly mode = 'resend' as const;
  private apiKey: string;
  private fromAddress: string;

  constructor(apiKey: string, fromAddress: string) {
    this.apiKey = apiKey;
    this.fromAddress = fromAddress;
  }

  async send(msg: EmailMessage): Promise<{ delivered: boolean; provider: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });

    if (!res.ok) {
      throw new Error(`Email delivery failed with status ${res.status}`);
    }
    return { delivered: true, provider: 'resend' };
  }
}

export function createEmailProvider(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'NORUS QUOTEFLOW <noreply@norus.local>';
  if (apiKey && apiKey.trim()) {
    return new ResendEmailProvider(apiKey.trim(), from);
  }
  return new DevOutboxEmailProvider();
}
