import crypto from 'crypto';

interface AuthConfig {
  username: string;
  password: string;
}

interface HttpResult {
  status: number;
  body: string;
}

/**
 * HTTP GET with automatic auth negotiation.
 *
 * Hikvision/Dahua authentication flow:
 *   1. Send request WITHOUT credentials
 *   2. Server responds 401 + WWW-Authenticate: Digest realm=..., nonce=..., qop=...
 *   3. Compute MD5 digest response from challenge
 *   4. Retry with Authorization: Digest ... header
 *
 * IMPORTANT: Do NOT send Basic auth first — Hikvision returns 403 (blocked)
 * instead of 401 (challenge) when it receives unexpected Basic credentials.
 */
export async function httpGet(url: string, auth: AuthConfig, timeoutMs = 10000): Promise<HttpResult> {
  const parsedUrl = new URL(url);
  // URI for digest = path + search (some NVRs require query params in digest)
  const digestUri = parsedUrl.pathname + parsedUrl.search;

  console.log(`  HTTP GET ${url}`);

  // ── Step 1: unauthenticated probe to get challenge ──
  let challengeHeaders: string[] = [];
  try {
    const res1 = await fetch(url, {
      headers: { 'Accept': '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Drain body to free connection
    const body1 = await res1.text();

    if (res1.ok) {
      console.log(`  → ${res1.status} OK (no auth required), ${body1.length} bytes`);
      return { status: res1.status, body: body1 };
    }

    if (res1.status !== 401) {
      console.log(`  → ${res1.status} — not a 401, cannot authenticate`);
      console.log(`  → Response: ${body1.substring(0, 200)}`);
      return { status: res1.status, body: body1 };
    }

    // Collect all WWW-Authenticate headers
    // Some servers send multiple: one for Digest, one for Basic
    challengeHeaders = res1.headers.getSetCookie ?
      [] : []; // getSetCookie not relevant here

    const authHeader = res1.headers.get('www-authenticate');
    if (authHeader) {
      challengeHeaders.push(authHeader);
    }

    console.log(`  → 401, WWW-Authenticate: ${authHeader?.substring(0, 120) || '(none)'}`);
  } catch (e: any) {
    console.warn(`  → Connection error: ${e.message}`);
    return { status: 0, body: '' };
  }

  // ── Step 2: find Digest challenge (preferred over Basic) ──
  const digestChallenge = challengeHeaders.find(h => h.toLowerCase().startsWith('digest'));
  const basicChallenge = challengeHeaders.find(h => h.toLowerCase().startsWith('basic'));

  if (digestChallenge) {
    console.log(`  → Authenticating with Digest`);
    try {
      const authHeader = buildDigestHeader(auth, 'GET', digestUri, digestChallenge);
      console.log(`  → Digest header: ${authHeader.substring(0, 80)}...`);

      const res2 = await fetch(url, {
        headers: {
          'Authorization': authHeader,
          'Accept': '*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res2.text();
      console.log(`  → ${res2.status} (Digest), ${body.length} bytes`);
      return { status: res2.status, body };
    } catch (e: any) {
      console.warn(`  → Digest request failed: ${e.message}`);
      return { status: 0, body: '' };
    }
  }

  if (basicChallenge) {
    console.log(`  → Authenticating with Basic`);
    try {
      const cred = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      const res3 = await fetch(url, {
        headers: {
          'Authorization': `Basic ${cred}`,
          'Accept': '*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res3.text();
      console.log(`  → ${res3.status} (Basic), ${body.length} bytes`);
      return { status: res3.status, body };
    } catch (e: any) {
      console.warn(`  → Basic request failed: ${e.message}`);
      return { status: 0, body: '' };
    }
  }

  console.warn(`  → No Digest or Basic challenge in 401 response`);
  return { status: 401, body: '' };
}

/**
 * Build Digest Authorization header per RFC 2617.
 *
 * Handles:
 *   - qop="auth" and qop="auth,auth-int" (picks "auth")
 *   - algorithm=MD5 (default) and algorithm=MD5-sess
 *   - opaque passthrough
 *   - URI with query params (required by some NVRs)
 */
function buildDigestHeader(auth: AuthConfig, method: string, uri: string, challenge: string): string {
  const p = parseChallenge(challenge);

  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const opaque = p.opaque || '';
  const algorithm = (p.algorithm || 'MD5').toUpperCase();

  // qop can be "auth", "auth-int", or "auth,auth-int" — pick "auth"
  let qop = '';
  if (p.qop) {
    const qopOptions = p.qop.split(',').map(s => s.trim());
    qop = qopOptions.includes('auth') ? 'auth' : qopOptions[0];
  }

  const cnonce = crypto.randomBytes(16).toString('hex');
  const nc = '00000001';

  // HA1
  let ha1 = md5(`${auth.username}:${realm}:${auth.password}`);
  if (algorithm === 'MD5-SESS') {
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  }

  // HA2
  const ha2 = md5(`${method}:${uri}`);

  // Response
  let response: string;
  if (qop === 'auth' || qop === 'auth-int') {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  // Build header
  let header = `Digest username="${auth.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=${algorithm}`;

  if (qop) {
    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  }
  if (opaque) {
    header += `, opaque="${opaque}"`;
  }

  return header;
}

/**
 * Parse WWW-Authenticate challenge header.
 * Handles: key="quoted value", key=unquoted, key="value with spaces"
 */
function parseChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  // Strip "Digest " or "Basic " prefix
  const body = header.replace(/^(Digest|Basic)\s+/i, '');

  // State machine parser for key=value pairs (handles commas inside quotes)
  let i = 0;
  while (i < body.length) {
    // Skip whitespace and commas
    while (i < body.length && (body[i] === ' ' || body[i] === ',' || body[i] === '\t')) i++;
    if (i >= body.length) break;

    // Read key
    const keyStart = i;
    while (i < body.length && body[i] !== '=') i++;
    const key = body.substring(keyStart, i).trim();
    i++; // skip '='

    // Read value
    let value: string;
    if (body[i] === '"') {
      // Quoted value
      i++; // skip opening quote
      const valStart = i;
      while (i < body.length && body[i] !== '"') i++;
      value = body.substring(valStart, i);
      i++; // skip closing quote
    } else {
      // Unquoted value (until comma or end)
      const valStart = i;
      while (i < body.length && body[i] !== ',' && body[i] !== ' ') i++;
      value = body.substring(valStart, i);
    }

    if (key) params[key.toLowerCase()] = value;
  }

  return params;
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * HTTP GET returning binary Buffer. Uses same Digest/Basic auth as httpGet.
 * Designed for snapshot fetches — minimal logging, fast.
 */
export async function httpGetBuffer(url: string, auth: AuthConfig, timeoutMs = 8000): Promise<Buffer | null> {
  const parsedUrl = new URL(url);
  const digestUri = parsedUrl.pathname + parsedUrl.search;

  try {
    // Step 1: probe for auth challenge
    const res1 = await fetch(url, {
      headers: { 'Accept': 'image/jpeg' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res1.ok) {
      return Buffer.from(await res1.arrayBuffer());
    }

    if (res1.status !== 401) return null;
    await res1.text(); // drain

    const authHeader = res1.headers.get('www-authenticate');
    if (!authHeader) return null;

    // Step 2: authenticate
    let authHeaderValue: string;
    if (authHeader.toLowerCase().startsWith('digest')) {
      authHeaderValue = buildDigestHeader(auth, 'GET', digestUri, authHeader);
    } else {
      authHeaderValue = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    }

    const res2 = await fetch(url, {
      headers: { 'Authorization': authHeaderValue, 'Accept': 'image/jpeg' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res2.ok) return null;
    return Buffer.from(await res2.arrayBuffer());
  } catch {
    return null;
  }
}
