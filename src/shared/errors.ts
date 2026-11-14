/** A failure that may succeed on retry (network, rate limit, timeout). */
export class RetryableError extends Error {
  override name = "RetryableError";
}

/** A failure that will not succeed on retry (bad input, policy violation). */
export class PermanentError extends Error {
  override name = "PermanentError";
}

/** The actor lacks a permission or data scope. Never retried. */
export class AccessDeniedError extends PermanentError {
  override name = "AccessDeniedError";
}

export function errorDetails(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 2000) };
  return { name: "UnknownError", message: String(err).slice(0, 2000) };
}
