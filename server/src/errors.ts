export class HttpError extends Error {
  status: number;
  code: string;
  retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Invalid or expired credentials');
}

export function stringField(body: Record<string, unknown>, key: string, max = 256): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, 'invalid_request', `Invalid ${key}`);
  }
  return value.trim();
}
