import type { View } from '@pubsub/contract';
import type { Request } from 'express';
import { safeEqual } from '../common/safe-equal';
import type { AppConfig } from '../config';

export type AuthResult =
  | { ok: true }
  | { ok: false; status: number; code: 'UNAUTHENTICATED' | 'FORBIDDEN'; message: string };

/**
 * Token máy-với-máy, mỗi consumer một token. Token B2C gọi endpoint B2B bị
 * từ chối tường minh (FORBIDDEN), không chỉ là "không tìm thấy".
 */
export function authenticate(view: View, req: Request, config: AppConfig): AuthResult {
  const header = req.header('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const token = bearer || req.header('x-consumer-token') || '';

  if (!token) {
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'thiếu token consumer' };
  }
  if (safeEqual(token, config.tokens[view])) return { ok: true };

  const other: View = view === 'b2b' ? 'b2c' : 'b2b';
  if (safeEqual(token, config.tokens[other])) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: `token ${other} không được gọi endpoint ${view}`,
    };
  }

  return { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'token không hợp lệ' };
}
