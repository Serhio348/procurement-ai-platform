export function withCredentials(init: RequestInit = {}): RequestInit {
  return { ...init, credentials: "include" };
}

/**
 * HTTP failure with the response status and the API machine code attached.
 * UI code can branch on `status`/`code`; the message stays human-readable.
 */
export class ApiError extends Error {
  readonly status?: number | undefined;
  readonly code?: string | undefined;

  constructor(
    message: string,
    options?: { status?: number | undefined; code?: string | undefined },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options?.status;
    this.code = options?.code;
  }
}

/**
 * Reads the API error body for a machine code, then throws ApiError.
 * The fallback message is what the user sees when the body has no detail.
 */
export async function throwApiError(response: Response, fallback: string): Promise<never> {
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) code = body.error;
  } catch {
    // No JSON body — status alone still has to reach the caller.
  }
  throw new ApiError(fallback, { status: response.status, code });
}

/** Human-readable message for banners and toasts. */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}
