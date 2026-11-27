import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { TEST_USER_KEY_PATTERN } from './test-users.js';

const encode = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/**
 * The handle-JWT is NOT a credential container. It carries only a random `jti`
 * (the store key), an audience (this server), and an expiry. The native auth
 * artifacts stay server-side, keyed by `jti`. So even a fully decoded token
 * reveals nothing about the user — it's an opaque handle, credential-blind.
 *
 * A **test** handle (minted by the test-bind route) also carries `test: true`,
 * `tu` (the test user's key) and `ro: true` when that user is read only.
 */
export interface HandleClaims {
  jti: string;
  aud: string;
  /** Present, and true, only on a test handle. */
  test?: true;
  /** The test user's key. Set exactly when `test` is. */
  tu?: string;
  /** Present, and true, only on a read-only test handle. */
  ro?: true;
}

/** What a verified handle carries. */
export interface VerifiedHandle extends HandleClaims {
  iat?: number;
  exp?: number;
}

export async function signHandle(
  claims: HandleClaims,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const extra: JWTPayload = {};
  if (claims.test === true) {
    if (typeof claims.tu !== 'string' || !TEST_USER_KEY_PATTERN.test(claims.tu)) {
      throw new Error('a test handle needs a valid test user key');
    }
    extra.test = true;
    extra.tu = claims.tu;
    if (claims.ro === true) extra.ro = true;
  } else if (claims.tu !== undefined || claims.ro !== undefined) {
    throw new Error('tu and ro belong on a test handle only');
  }
  return new SignJWT(extra)
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(claims.jti)
    .setAudience(claims.aud)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttlSeconds)
    .sign(encode(secret));
}

/**
 * Verify against every configured secret (newest first) so a rotation window
 * accepts both old and new tokens. Returns the claims on success; throws
 * otherwise, including for test claims that are not exactly as minted.
 */
export async function verifyHandle(
  token: string,
  secrets: string[],
  audience: string,
): Promise<VerifiedHandle> {
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, encode(secret), { audience });
      if (!payload.jti) throw new Error('handle JWT missing jti');
      return { jti: payload.jti, aud: audience, iat: payload.iat, exp: payload.exp, ...testClaims(payload) };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('handle JWT verification failed');
}

/** Fail closed: any test claim that is not exactly as signHandle writes it rejects the handle. */
function testClaims(payload: JWTPayload): Pick<HandleClaims, 'test' | 'tu' | 'ro'> {
  const { test, tu, ro } = payload;
  if (test === undefined && tu === undefined && ro === undefined) return {};
  if (test !== true || typeof tu !== 'string' || !TEST_USER_KEY_PATTERN.test(tu)) {
    throw new Error('handle JWT has malformed test claims');
  }
  if (ro !== undefined && ro !== true) throw new Error('handle JWT has malformed test claims');
  return ro === true ? { test: true, tu, ro: true } : { test: true, tu };
}
