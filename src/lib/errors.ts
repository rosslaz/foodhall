import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const badRequest = (msg: string) => new AppError(400, 'BAD_REQUEST', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const unauthorized = (msg = 'Unauthorized') =>
  new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);

export function errorHandler(
  err: FastifyError | AppError | ZodError,
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  if (err instanceof ZodError) {
    return reply
      .status(400)
      .send({ error: 'VALIDATION', issues: err.flatten().fieldErrors });
  }
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ error: err.code, message: err.message });
  }
  // Fastify validation errors carry a statusCode.
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) {
    _req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  }
  return reply.status(status).send({ error: 'ERROR', message: err.message });
}
