import { timingSafeEqual } from 'node:crypto';

/**
 * So sánh token theo thời gian hằng. Độ dài khác nhau thì trả false ngay —
 * chấp nhận được vì token của chúng ta có độ dài cố định theo cấu hình.
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
