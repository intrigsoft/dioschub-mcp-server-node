import { SignJWT, jwtVerify } from 'jose';

const encode = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/**
 * The handle-JWT is NOT a credential container. It carries only a random `jti`
 * (the store key), an audience (this server), and an expiry. The native auth
 * artifacts stay server-side, keyed by `jti`. So even a fully decoded token
 * reveals nothing about the user — it's an opaque handle, credential-blind.
 */
export interface HandleClaims {
  jti: string;
  aud: string;
}

export async function signHandle(
  claims: HandleClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(claims.jti)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encode(secret));
}

/**
 * Verify against every configured secret (newest first) so a rotation window
 * accepts both old and new tokens. Returns the `jti` on success; throws otherwise.
 */
export async function verifyHandle(
  token: string,
  secrets: string[],
  audience: string,
): Promise<{ jti: string }> {
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, encode(secret), { audience });
      if (!payload.jti) throw new Error('handle JWT missing jti');
      return { jti: payload.jti };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('handle JWT verification failed');
}
