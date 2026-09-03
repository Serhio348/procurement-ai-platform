export interface TelegramSendCommand {
  chatId: string;
  text: string;
}

export interface TelegramSendResult {
  messageId: string;
}

export interface TelegramSenderPort {
  send(command: TelegramSendCommand): Promise<TelegramSendResult>;
}

export class TelegramSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TelegramSendError";
  }
}

export class TelegramChatNotAllowedError extends Error {
  readonly chatId: string;

  constructor(chatId: string) {
    super("Telegram chat is not on the allowlist");
    this.name = "TelegramChatNotAllowedError";
    this.chatId = chatId;
  }
}

export class TelegramAllowlistEmptyError extends Error {
  constructor() {
    super("Telegram allowlist is empty");
    this.name = "TelegramAllowlistEmptyError";
  }
}

export class RecordingTelegramSender implements TelegramSenderPort {
  readonly sent: Array<TelegramSendCommand & TelegramSendResult> = [];

  async send(command: TelegramSendCommand): Promise<TelegramSendResult> {
    const messageId = String(this.sent.length + 1);
    this.sent.push({ ...command, messageId });
    return { messageId };
  }
}

export interface LiveTelegramSenderOptions {
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

/**
 * Sends already-formed text through Telegram Bot API. The token lives only in
 * the request URL; errors must not echo it back.
 */
export class LiveTelegramSender implements TelegramSenderPort {
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: string;

  constructor(options: LiveTelegramSenderOptions) {
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
  }

  async send(command: TelegramSendCommand): Promise<TelegramSendResult> {
    const url = `${this.#apiBaseUrl}/bot${this.#token}/sendMessage`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: command.chatId,
        text: command.text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number | string };
    };
    if (!response.ok || payload.ok !== true || payload.result?.message_id === undefined) {
      throw new TelegramSendError(publicTelegramError(payload.description));
    }
    return { messageId: String(payload.result.message_id) };
  }
}

function publicTelegramError(description: string | undefined): string {
  if (description === undefined || description.length === 0) {
    return "Telegram send failed";
  }
  return `Telegram send failed: ${description}`;
}
