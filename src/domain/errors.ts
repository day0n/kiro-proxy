export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

export class AuthenticationError extends ProxyError {
  constructor(message: string) {
    super(message, 401, true);
    this.name = 'AuthenticationError';
  }
}

export class QuotaExhaustedError extends ProxyError {
  constructor(message: string) {
    super(message, 402, false);
    this.name = 'QuotaExhaustedError';
  }
}

export class RateLimitError extends ProxyError {
  constructor(message: string) {
    super(message, 429, true);
    this.name = 'RateLimitError';
  }
}

export class UpstreamError extends ProxyError {
  constructor(message: string, statusCode: number = 502) {
    super(message, statusCode, true);
    this.name = 'UpstreamError';
  }
}
