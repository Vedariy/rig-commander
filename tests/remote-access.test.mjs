import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RemoteAccessGuard,
  normalizePublicOrigin,
  buildLiveManifest,
  parseCookies,
  SESSION_COOKIE_NAME
} from '../openrig/lib/remote-access.mjs';

function makeTempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigcmd-remote-test-'));
  return { dir, file: path.join(dir, 'remote-sessions.json') };
}

test('normalizePublicOrigin validates HTTPS/HTTP, normalizes bare hostnames, and rejects dangerous inputs', () => {
  const httpsRes = normalizePublicOrigin('https://mac-studio.tail1234.ts.net/extra?x=1');
  assert.equal(httpsRes.ok, true);
  assert.equal(httpsRes.origin, 'https://mac-studio.tail1234.ts.net');
  assert.equal(httpsRes.isHttps, true);
  assert.equal(httpsRes.isLoopback, false);

  const bareHost = normalizePublicOrigin('mac-studio.tail1234.ts.net');
  assert.equal(bareHost.ok, true);
  assert.equal(bareHost.origin, 'https://mac-studio.tail1234.ts.net');
  assert.equal(bareHost.isHttps, true);

  const lanHttp = normalizePublicOrigin('http://192.168.1.42:7440/');
  assert.equal(lanHttp.ok, true);
  assert.equal(lanHttp.origin, 'http://192.168.1.42:7440');
  assert.equal(lanHttp.isHttps, false);
  assert.equal(lanHttp.isLoopback, false);

  const loopback = normalizePublicOrigin('http://127.0.0.1:7440');
  assert.equal(loopback.ok, true);
  assert.equal(loopback.isLoopback, true);

  for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://host.example.com', 'https://user:pass@mac.ts.net', 'https://bad host.ts.net']) {
    const out = normalizePublicOrigin(bad);
    assert.equal(out.ok, false, `Expected rejection for: ${bad}`);
  }
});

test('buildLiveManifest targets live Command Deck root ("/") rather than /demo', () => {
  const manifest = buildLiveManifest();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);
  assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 2);
  for (const sc of manifest.shortcuts) {
    assert.equal(sc.url.includes('/demo'), false, `Live manifest shortcut must not point to /demo: ${sc.url}`);
  }
});

test('RemoteAccessGuard distinguishes local loopback from reverse-proxied or remote requests', () => {
  const guard = new RemoteAccessGuard({ port: 7440, stateFile: null });

  assert.equal(guard.isRemoteRequest({ headers: { host: '127.0.0.1:7440' }, socket: { remoteAddress: '127.0.0.1' } }), false);
  assert.equal(guard.isRemoteRequest({ headers: { host: 'localhost:7440' }, socket: { remoteAddress: '::1' } }), false);
  assert.equal(guard.isRemoteRequest({ headers: { host: '127.0.0.1:7440' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }), false);

  // Reverse proxies (Tailscale Serve / Cloudflare Tunnel / Caddy / ngrok)
  assert.equal(guard.isRemoteRequest({ headers: { host: 'mac.tail1234.ts.net' }, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(guard.isRemoteRequest({ headers: { host: '127.0.0.1:7440', 'x-forwarded-for': '100.64.0.5' }, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(guard.isRemoteRequest({ headers: { host: '127.0.0.1:7440', 'cf-connecting-ip': '203.0.113.10' }, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(guard.isRemoteRequest({ headers: { host: '127.0.0.1:7440', 'tailscale-user-login': 'dev@example.com' }, socket: { remoteAddress: '127.0.0.1' } }), true);

  // Direct LAN remote address
  assert.equal(guard.isRemoteRequest({ headers: { host: '127.0.0.1:7440' }, socket: { remoteAddress: '192.168.1.99' } }), true);
});

test('RemoteAccessGuard QR token & 8-char PIN pairing, single-use replay protection, origin pinning, and persistence', () => {
  const { dir, file } = makeTempStateFile();
  try {
    const guard = new RemoteAccessGuard({ port: 7440, stateFile: file });

    // Loopback URL rejected as remote public URL
    const badCfg = guard.setPublicUrl('http://127.0.0.1:7440');
    assert.equal(badCfg.ok, false);

    // Valid HTTPS Tailscale URL accepted & mints initial QR + PIN
    const okCfg = guard.setPublicUrl('https://my-mac.tail9999.ts.net/');
    assert.equal(okCfg.ok, true);
    assert.equal(okCfg.status.enabled, true);
    assert.equal(okCfg.status.publicOrigin, 'https://my-mac.tail9999.ts.net');
    assert.equal(okCfg.status.isHttps, true);
    assert.match(okCfg.status.pairingUrl, /^https:\/\/my-mac\.tail9999\.ts\.net\/pair\?code=[a-f0-9]{48}$/);
    assert.match(okCfg.status.pairingPin, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Origin pinning allows localhost + configured public origin, denies foreign origins
    assert.equal(guard.isAllowedOrigin('http://127.0.0.1:7440'), true);
    assert.equal(guard.isAllowedOrigin('http://localhost:7440'), true);
    assert.equal(guard.isAllowedOrigin('https://my-mac.tail9999.ts.net'), true);
    assert.equal(guard.isAllowedOrigin('https://evil.example.com'), false);

    // Pair Phone #1 using QR token
    const qrToken = new URL(okCfg.status.pairingUrl).searchParams.get('code');
    const paired1 = guard.consumePairingCode(qrToken, { secure: true, userAgent: 'iPhone Safari' });
    assert.equal(paired1.ok, true);
    assert.ok(paired1.cookieHeader.includes(`${SESSION_COOKIE_NAME}=${paired1.sessionToken}`));
    assert.ok(paired1.cookieHeader.includes('HttpOnly'));
    assert.ok(paired1.cookieHeader.includes('SameSite=Lax'));
    assert.ok(paired1.cookieHeader.includes('Secure'));

    // Single-use: replaying the same QR token MUST fail
    const replay = guard.consumePairingCode(qrToken, { secure: true });
    assert.equal(replay.ok, false);

    // Phone #1 cookie authenticates requests; invalid/missing cookies rejected
    const authedReq = { headers: { cookie: `${SESSION_COOKIE_NAME}=${paired1.sessionToken}` } };
    assert.equal(guard.isAuthenticatedRequest(authedReq), true);
    assert.equal(guard.isAuthenticatedRequest({ headers: { cookie: `${SESSION_COOKIE_NAME}=${'a'.repeat(64)}` } }), false);
    assert.equal(guard.isAuthenticatedRequest({ headers: {} }), false);

    // Pair Phone #2 (iOS Home Screen isolated container) using lowercase/dashless 8-char PIN
    const minted2 = guard.mintPairingCode();
    const rawPinInput = minted2.pin.replace('-', '').toLowerCase();
    const paired2 = guard.consumePairingCode(rawPinInput, { secure: true, userAgent: 'iPhone Standalone PWA' });
    assert.equal(paired2.ok, true);
    assert.equal(paired2.pairedDeviceCount, 2);

    // Disk persistence stores ONLY sha256 hashes (NEVER plaintext session tokens) with 0600 permissions
    const diskText = fs.readFileSync(file, 'utf8');
    assert.equal(diskText.includes(paired1.sessionToken), false, 'Plaintext session token must NEVER be written to disk');
    assert.equal(diskText.includes(paired2.sessionToken), false, 'Plaintext session token must NEVER be written to disk');
    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o077, 0, 'State file must not be group/world readable');

    // Restart server (new RemoteAccessGuard reading same stateFile) -> phones stay paired!
    const restarted = new RemoteAccessGuard({ port: 7440, stateFile: file });
    assert.equal(restarted.getStatus().publicOrigin, 'https://my-mac.tail9999.ts.net');
    assert.equal(restarted.getStatus().pairedDeviceCount, 2);
    assert.equal(restarted.isAuthenticatedRequest(authedReq), true);

    // Revoke all devices -> immediately kicks paired phones
    restarted.revokeAllSessions();
    assert.equal(restarted.getStatus().pairedDeviceCount, 0);
    assert.equal(restarted.isAuthenticatedRequest(authedReq), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RemoteAccessGuard brute-force wipe after 5 bad codes, expiry check, and HTML error escaping', () => {
  const guard = new RemoteAccessGuard({ port: 7440, stateFile: null, pairTtlMs: 60_000 });
  guard.setPublicUrl('https://deck.example.ts.net');
  const minted = guard.mintPairingCode();

  for (let i = 0; i < 5; i++) {
    const attempt = guard.consumePairingCode('WRONG-CODE');
    assert.equal(attempt.ok, false);
  }
  // Even the real code must be wiped after 5 failed attempts
  const afterWipe = guard.consumePairingCode(minted.code);
  assert.equal(afterWipe.ok, false);

  // Expiry check
  const shortGuard = new RemoteAccessGuard({ port: 7440, stateFile: null, pairTtlMs: -10 });
  shortGuard.setPublicUrl('https://deck.example.ts.net');
  const expiredCode = shortGuard.activePairing && shortGuard.activePairing.token;
  assert.equal(shortGuard.consumePairingCode(expiredCode || '').ok, false);

  // Cookie parser ignores prototype keys
  const parsed = parseCookies('__proto__=evil; rigcmd_session=abc123');
  assert.equal(parsed.rigcmd_session, 'abc123');
  assert.equal(({}).evil, undefined);

  // HTML escaping on Pair Required page
  const html = guard.renderPairRequiredHtml({ error: '<script>alert(1)</script>' });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('action="/pair"'));
  assert.ok(html.includes('/manifest.webmanifest'));
});
