const decoder = new TextDecoder();
const encoder = new TextEncoder();
const cache = new Map();
function bytes(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
// Verify Access assertions even when the Worker is reached through an alternate hostname.
export async function authenticate(request, env, fetchImpl = fetch) {
  const issuer = env.ACCESS_ISSUER?.replace(/\/$/, '');
  if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !env.ACCESS_AUD)
    throw Object.assign(new Error('Cloudflare Access is not configured.'), { status: 503 });
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const unauthorized = () => Object.assign(new Error('Sign in with Cloudflare Access.'), { status: 401 });
  if (!token || token.length > 16000) throw unauthorized();
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized();
    const header = JSON.parse(decoder.decode(bytes(parts[0])));
    const claims = JSON.parse(decoder.decode(bytes(parts[1])));
    const now = Date.now() / 1000;
    if (header.alg !== 'RS256' || claims.iss !== issuer ||
        !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD) ||
        typeof claims.exp !== 'number' || claims.exp <= now ||
        typeof claims.iat !== 'number' || claims.iat > now + 60 ||
        (claims.nbf !== undefined && claims.nbf > now + 60)) throw unauthorized();
    let keys = cache.get(issuer);
    if (!keys || keys.expires < Date.now()) {
      const response = await fetchImpl(issuer + '/cdn-cgi/access/certs');
      if (!response.ok) throw unauthorized();
      keys = { value: (await response.json()).keys, expires: Date.now() + 300000 };
      cache.set(issuer, keys);
    }
    const jwk = keys.value.find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) throw unauthorized();
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]),
      encoder.encode(parts[0] + '.' + parts[1]))) throw unauthorized();
    return claims;
  } catch { throw unauthorized(); }
}

async function encryptionKey(secret) {
  if (!secret || secret.length < 32) throw new Error('Set KEY_ENCRYPTION_SECRET in Cloudflare first.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value));
  return JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
}
export async function unseal(value, secret) {
  const { iv, cipher } = JSON.parse(value);
  return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) },
    await encryptionKey(secret), new Uint8Array(cipher)));
}
