// Canton's unsafe shared-secret auth (unsafe-jwt-hmac-256), used by the DecMan
// LocalNet only: an HS256 token whose `sub` is the ledger user. Never for a real
// network; DevNet uses the OAuth token in lib/ledger.mjs.
import { createHmac } from 'node:crypto';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function hmacJwt(secret, sub, aud = 'https://canton.network.global') {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud, iat, exp: iat + 3600 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
