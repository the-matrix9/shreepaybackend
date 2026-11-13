export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m = 'Invalid request', d?: unknown) => new AppError(400, 'INVALID_REQUEST', m, d);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, m);
export const forbidden = (m = 'Forbidden', code = 'FORBIDDEN') => new AppError(403, code, m);
export const notFound = (m = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, m);
export const conflict = (m: string, code = 'CONFLICT') => new AppError(409, code, m);
export const upstreamUnavailable = () =>
  new AppError(502, 'UPSTREAM_UNAVAILABLE', 'Payment service temporarily unavailable');
