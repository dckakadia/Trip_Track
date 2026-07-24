import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from '../repositories/settingsRepository.ts';

export const SESSION_COOKIE = 'triptrack_session';
export const MIN_PASSWORD_LENGTH = 6;

const SECRET_SETTING_KEY = 'auth_secret';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) {
    return false;
  }
  const [scheme, salt, expectedHex] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !expectedHex) {
    return false;
  }
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// The signing secret lives in the settings table (generated on first use), so
// session tokens stay valid across restarts without any state in memory.
async function getSessionSecret(): Promise<string> {
  let secret = await getSetting(SECRET_SETTING_KEY);
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    await setSetting(SECRET_SETTING_KEY, secret);
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export async function createSessionToken(userId: string): Promise<string> {
  const payload = `${userId}.${Date.now() + SESSION_TTL_SECONDS * 1000}`;
  return `${payload}.${sign(payload, await getSessionSecret())}`;
}

export async function verifySessionToken(token: string | undefined): Promise<string | null> {
  if (!token) {
    return null;
  }
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) {
    return null;
  }
  const payload = token.slice(0, lastDot);
  const signature = Buffer.from(token.slice(lastDot + 1), 'hex');
  const expected = Buffer.from(sign(payload, await getSessionSecret()), 'hex');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }
  const [userId, expiresAt] = payload.split('.');
  if (!userId || Number(expiresAt) < Date.now()) {
    return null;
  }
  return userId;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

// Set TRIPTRACK_COOKIE_SECURE=1 when Nginx (or another proxy) terminates TLS in front of
// the app server, so the session cookie is never sent over plain HTTP. Left off by default
// so local HTTP development still works.
function secureAttribute(): string {
  return process.env.TRIPTRACK_COOKIE_SECURE === '1' ? '; Secure' : '';
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secureAttribute()}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute()}`;
}
