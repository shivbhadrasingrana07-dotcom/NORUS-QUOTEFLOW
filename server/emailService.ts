import {
  isPlaceholderSecret,
  redactSensitiveText,
  stripSurroundingQuotes,
} from './security.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProviderStatus {
  mode: 'resend' | 'dev_outbox';
  configured: boolean;
  senderValid: boolean;
}

export interface EmailProvider {
  readonly mode: 'resend' | 'dev_outbox';
  send(msg: EmailMessage): Promise<{ delivered: boolean; provider: string; attempts: number }>;
  getStatus(): EmailProviderStatus;
}

export interface CapturedDevEmail extends EmailMessage {
  sentAt: string;
}

export function isValidSenderAddress(from: string): boolean {
  const trimmed = String(from || '').trim();
  if (!trimmed) return false;
  const angleMatch = trimmed.match(/<([^<>]+)>$/);
  const addr = angleMatch ? angleMatch[1].trim() : trimmed;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

export class DevOutboxEmailProvider implements EmailProvider {
  readonly mode = 'dev_outbox' as const;
  readonly sent: CapturedDevEmail[] = [];

  async send(msg: EmailMessage): Promise<{ delivered: boolean; provider: string; attempts: number }> {
    this.sent.unshift({
      ...msg,
      sentAt: new Date().toISOString(),
    });
    if (this.sent.length > 50) {
      this.sent.length = 50;
    }
    if (process.env.NODE_ENV !== 'test') {
      // Never print verification or reset tokens in logs
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'email_dev_outbox_queued',
          subject: msg.subject,
          recipientDomain: msg.to.split('@')[1] || 'unknown',
          ts: new Date().toISOString(),
        })
      );
    }
    return { delivered: true, provider: 'dev_outbox', attempts: 1 };
  }

  getStatus(): EmailProviderStatus {
    return {
      mode: 'dev_outbox',
      configured: false,
      senderValid: true,
    };
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly mode = 'resend' as const;
  private readonly apiKey: string;
  private readonly fromAddress: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    apiKey: string,
    fromAddress: string,
    options: { timeoutMs?: number; maxRetries?: number; retryBaseDelayMs?: number } = {}
  ) {
    if (!isValidSenderAddress(fromAddress)) {
      throw new Error('EMAIL_FROM must contain a valid sender email address when Resend is enabled.');
    }
    this.apiKey = apiKey;
    this.fromAddress = fromAddress.trim();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
  }

  async send(msg: EmailMessage): Promise<{ delivered: boolean; provider: string; attempts: number }> {
    let lastError: Error | null = null;
    const totalAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
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
          signal: controller.signal,
        });

        if (res.ok) {
          return { delivered: true, provider: 'resend', attempts: attempt };
        }

        const retryable = res.status === 429 || res.status >= 500;
        lastError = new Error(`Resend email delivery failed with status ${res.status}`);
        if (!retryable || attempt === totalAttempts) {
          throw lastError;
        }
      } catch (err) {
        const msgText = err instanceof Error ? err.message : String(err);
        const safeMessage = redactSensitiveText(msgText.split(this.apiKey).join('[REDACTED]'));
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error(`Resend email delivery timed out after ${this.timeoutMs}ms`);
        } else {
          lastError = new Error(safeMessage);
        }
        // Do not retry non-retryable 4xx HTTP errors thrown above
        if (
          lastError.message.includes('status 400') ||
          lastError.message.includes('status 401') ||
          lastError.message.includes('status 403') ||
          lastError.message.includes('status 422') ||
          attempt === totalAttempts
        ) {
          throw lastError;
        }
      } finally {
        clearTimeout(timer);
      }

      const backoffMs = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    throw lastError || new Error('Email delivery failed.');
  }

  getStatus(): EmailProviderStatus {
    return {
      mode: 'resend',
      configured: true,
      senderValid: isValidSenderAddress(this.fromAddress),
    };
  }
}

export function createEmailProvider(
  env: Record<string, string | undefined> = process.env
): EmailProvider {
  const isProd = (env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const apiKey = stripSurroundingQuotes(env.RESEND_API_KEY || '');
  if (!apiKey || isPlaceholderSecret(apiKey)) {
    if (isProd) {
      throw new Error(
        'Configuration error: RESEND_API_KEY must be configured in production (DevOutboxEmailProvider fallback is disabled in production). Failing closed.'
      );
    }
    return new DevOutboxEmailProvider();
  }

  const rawFrom = stripSurroundingQuotes(env.EMAIL_FROM || '');
  if (isProd) {
    if (!rawFrom || isPlaceholderSecret(rawFrom) || !isValidSenderAddress(rawFrom)) {
      throw new Error(
        'Configuration error: EMAIL_FROM must contain a valid non-placeholder sender email address in production. Failing closed.'
      );
    }
    return new ResendEmailProvider(apiKey, rawFrom);
  }

  const from = rawFrom || 'NORUS QUOTEFLOW <noreply@norus.local>';
  if (!isValidSenderAddress(from)) {
    if (env.NODE_ENV !== 'test') {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'resend_invalid_sender_fallback_dev_outbox',
          nodeEnv: env.NODE_ENV || 'development',
          ts: new Date().toISOString(),
        })
      );
    }
    return new DevOutboxEmailProvider();
  }

  return new ResendEmailProvider(apiKey, from);
}
