#!/usr/bin/env node
// DEV-ONLY mock OpenID Connect provider so the frontend login works locally without a real IdP (Progress.md D-3).
//   RECON_DEV_API_TOKEN=rk_... node tools/dev/dev-idp.mjs
// It signs in anyone who opens /authorize (no password) and returns the given recon API key as the access token,
// which the frontend BFF forwards to the API as `Authorization: Bearer`. Never expose this beyond localhost.
// Env: RECON_DEV_API_TOKEN (required)  DEV_IDP_PORT (default 9443)  APP_BASE_URL (default http://localhost:3000)
//      DEV_IDP_CLIENT_ID (default recon-web)
// TLS: the frontend requires an https issuer. A self-signed certificate is generated with `openssl` into .dev/idp/.
//      Start the frontend with NODE_EXTRA_CA_CERTS=.dev/idp/cert.pem, and accept the browser warning once for
//      https://localhost:<port>.
import { execFileSync } from 'node:child_process';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';

const token = process.env.RECON_DEV_API_TOKEN;
if (!token || !/^rk_[0-9a-f]{16}_[0-9a-f]{64}$/.test(token)) {
  console.error('RECON_DEV_API_TOKEN must be an API key issued by `recon-admin issue-api-key`');
  process.exit(2);
}
const PORT = Number(process.env.DEV_IDP_PORT ?? 9443);
const ISSUER = `https://localhost:${PORT}`;
const APP = new URL(process.env.APP_BASE_URL ?? 'http://localhost:3000');
const CLIENT_ID = process.env.DEV_IDP_CLIENT_ID ?? 'recon-web';
const REDIRECT_URI = new URL('/api/auth/callback', APP).href;

const dir = resolve('.dev/idp');
const keyPath = resolve(dir, 'key.pem');
const certPath = resolve(dir, 'cert.pem');
if (!existsSync(certPath) || !existsSync(keyPath)) {
  mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '365'], { stdio: 'ignore' });
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'dev', alg: 'RS256', use: 'sig' };
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function signJwt(claims) {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'dev' })}.${b64(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

const codes = new Map(); // code -> { challenge, nonce }
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(res, 200, {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    const q = url.searchParams;
    if (q.get('client_id') !== CLIENT_ID || q.get('redirect_uri') !== REDIRECT_URI || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') {
      return json(res, 400, { error: 'invalid_request', expected_redirect_uri: REDIRECT_URI });
    }
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce') });
    const back = new URL(REDIRECT_URI);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    res.writeHead(302, { location: back.href });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    const p = new URLSearchParams(raw);
    const entry = codes.get(p.get('code'));
    codes.delete(p.get('code'));
    if (!entry || createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt({ iss: ISSUER, aud: CLIENT_ID, sub: 'dev-user', nonce: entry.nonce, iat: now, exp: now + 3600 });
    return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
  }
  json(res, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1', () => console.log(`dev IdP on ${ISSUER} (redirect URI ${REDIRECT_URI})`));
