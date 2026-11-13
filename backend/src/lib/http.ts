import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export const ok = (res: Response, data: unknown = {}, message = 'Success', status = 200) =>
  res.status(status).json({ success: true, data, message });

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function pageArgs(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export const pageResult = <T>(items: T[], total: number, q: { page: number; pageSize: number }) => ({
  items,
  total,
  page: q.page,
  pageSize: q.pageSize,
});

export const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v);

export const idParam = (req: Request, name = 'id') => z.string().uuid().parse(req.params[name]);
