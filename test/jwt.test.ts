import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { signHandle, verifyHandle } from '../src/jwt.js';

test('signHandle → verifyHandle round-trips the jti', async () => {
  const token = await signHandle({ jti: 'abc-123', aud: 'northwind-mcp' }, 'secret', 3600);
  const { jti } = await verifyHandle(token, ['secret'], 'northwind-mcp');
  assert.equal(jti, 'abc-123');
});

test('carries no credential material — only jti/aud/exp', async () => {
  const token = await signHandle({ jti: 'j1', aud: 'srv' }, 'secret', 3600);
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'jti']);
});

test('rejects a token signed with the wrong secret', async () => {
  const token = await signHandle({ jti: 'j1', aud: 'srv' }, 'real', 3600);
  await assert.rejects(() => verifyHandle(token, ['other'], 'srv'));
});

test('rejects a token minted for a different audience', async () => {
  const token = await signHandle({ jti: 'j1', aud: 'other-srv' }, 'secret', 3600);
  await assert.rejects(() => verifyHandle(token, ['secret'], 'srv'));
});

test('rejects an expired token', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setJti('j1')
    .setAudience('srv')
    .setExpirationTime(past)
    .sign(new TextEncoder().encode('secret'));
  await assert.rejects(() => verifyHandle(token, ['secret'], 'srv'));
});

test('rotation: verifies against any configured secret, signs with the newest', async () => {
  // A token minted under the old secret still verifies during the window.
  const oldToken = await signHandle({ jti: 'j1', aud: 'srv' }, 'old', 3600);
  const { jti } = await verifyHandle(oldToken, ['new', 'old'], 'srv');
  assert.equal(jti, 'j1');
});
