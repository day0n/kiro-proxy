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

export class ForbiddenError extends ProxyError {
  constructor(message: string, public readonly suspended: boolean = false) {
    super(message, 403, !suspended);
    this.name = 'ForbiddenError';
  }
}

export class UpstreamError extends ProxyError {
  constructor(message: string, statusCode: number = 502) {
    super(message, statusCode, true);
    this.name = 'UpstreamError';
  }
}

export class FirstTokenTimeoutError extends ProxyError {
  constructor(message: string = 'No data received within first-token timeout') {
    super(message, 504, true);
    this.name = 'FirstTokenTimeoutError';
  }
}
