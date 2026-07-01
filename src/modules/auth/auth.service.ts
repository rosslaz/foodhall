import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt-based password hashing (no external deps). Format: salt:hash (hex).
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface JwtPayload {
  sub: string; // user id
  role: 'ADMIN' | 'VENDOR';
  vendorId?: string;
}
