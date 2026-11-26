import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SESSION_COOKIE_NAME = 'rigcmd_session';
const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_PAIR_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_PAIR_FAILED_ATTEMPTS = 5;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '::ffff:127.0.0.1']);

function defaultRemoteStateFile() {
  const home = process.env.HOME || os.homedir();
  return home ? path.join(home, '.config', 'rig-commander', 'remote-sessions.json') : null;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validates and canonicalizes a user-provided public origin URL for remote Live PWA access.
 * Rejects non-http(s) schemes and embedded credentials.
 */
export function normalizePublicOrigin(rawUrl) {
  let trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { ok: false, origin: '', protocol: '', hostname: '', isHttps: false, isLoopback: false, error: 'Empty URL' };
  }
  if (/[\s\r\n]/.test(trimmed)) {
    return { ok: false, origin: '', protocol: '', hostname: '', isHttps: false, isLoopback: false, error: 'URL must not contain whitespace' };
  }
  // Allow bare domain paste like "my-mac.tail1234.ts.net" -> prepend https://
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    } else {
      return { ok: false, origin: '', protocol: '', hostname: '', isHttps: false, isLoopback: false, error: 'Include https:// (e.g. https://your-mac.ts.net)' };
    }
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, origin: '', protocol: '', hostname: '', isHttps: false, isLoopback: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, origin: '', protocol: parsed.protocol, hostname: parsed.hostname, isHttps: false, isLoopback: false, error: 'Only https:// or http:// URLs are supported' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, origin: '', protocol: parsed.protocol, hostname: parsed.hostname, isHttps: false, isLoopback: false, error: 'Credentials in URL are not allowed' };
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  return {
    ok: true,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname,
    isHttps: parsed.protocol === 'https:',
    isLoopback
  };
}

/**
 * Dynamic Web App Manifest served by live openrig/server.mjs so installing the PWA
 * installs the real Live RigCommander Command Deck ("start_url": "/?source=pwa"),
 * never the static marketing website or /demo sandbox.
 */
export function buildLiveManifest() {
  return {
    id: '/',
    name: 'RigCommander — Live Command Deck',
    short_name: 'RigCommander',
    description: 'Live Mission Control & Neural Command Deck for your local Claude Code, Codex CLI, tmux & OpenRig autonomous AI fleets.',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#030712',
    theme_color: '#030712',
    categories: ['developer', 'productivity', 'utilities'],
    icons: [
      { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: [
      {
        name: 'Live Command Deck',
        short_name: 'Live Deck',
        url: '/?source=pwa',
        icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192' }]
      },
      {
        name: 'Task Gantt Timeline',
        short_name: 'Gantt',
        url: '/?track=gantt',
        icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192' }]
      },
      {
        name: 'Fleet Advisor',
        short_name: 'Advisor',
        url: '/?track=advisor',
        icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192' }]
      }
    ]
  };
}

export function parseCookies(cookieHeader) {
  const out = Object.create(null);
  const raw = String(cookieHeader || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
      out[key] = val;
    }
  }
  return out;
}

function extractHostWithoutPort(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end !== -1 ? h.slice(0, end + 1) : h;
  }
  const colonIdx = h.indexOf(':');
  return colonIdx !== -1 ? h.slice(0, colonIdx) : h;
}

function generatePairingPin() {
  const bytes = crypto.randomBytes(8);
  let chars = '';
  for (let i = 0; i < 8; i++) {
    chars += PIN_ALPHABET[bytes[i] % PIN_ALPHABET.length];
  }
  return {
    normalized: chars,
    formatted: `${chars.slice(0, 4)}-${chars.slice(4)}`
  };
}

/**
 * Best-effort non-blocking detection of an active `tailscale serve` HTTPS URL
 * pointing to this local RigCommander port. Silently returns '' if tailscale is absent.
 */
export async function detectTailscaleServeUrl(port = 7440) {
  try {
    const { stdout } = await execFileAsync('tailscale', ['serve', 'status', '--json'], { timeout: 1500 });
    const parsed = JSON.parse(stdout || '{}');
    const web = parsed && parsed.Web;
    if (!web || typeof web !== 'object') return '';
    const targetRe = new RegExp(`(?:127\\.0\\.0\\.1|localhost):${Number(port)}\\b`);
    for (const [hostPort, cfg] of Object.entries(web)) {
      const handlers = cfg && cfg.Handlers;
      if (!handlers || typeof handlers !== 'object') continue;
      const matchesPort = Object.values(handlers).some(h => h && targetRe.test(String(h.Proxy || '')));
      if (!matchesPort) continue;
      const cleanHost = hostPort.replace(/:443$/, '');
      if (cleanHost) return `https://${cleanHost}`;
    }
  } catch {
    // tailscale not installed or not serving
  }
  return '';
}

export class RemoteAccessGuard {
  constructor(options = {}) {
    this.port = Number(options.port || 7440);
    this.stateFile = options.stateFile !== undefined ? options.stateFile : defaultRemoteStateFile();
    this.readOnly = Boolean(options.readOnly);
    this.pairTtlMs = Number(options.pairTtlMs || DEFAULT_PAIR_TTL_MS);
    this.sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS);
    this.publicOrigin = '';
    this.sessions = [];
    this.activePairing = null;

    this._loadState();

    if (options.publicUrl) {
      const parsed = normalizePublicOrigin(options.publicUrl);
      if (parsed.ok && !parsed.isLoopback) {
        this.publicOrigin = parsed.origin;
        if (!this.readOnly) {
          this._persistState();
        }
      }
    }

    if (this.publicOrigin && !this.readOnly) {
      this.mintPairingCode();
    }
  }

  _loadState() {
    if (!this.stateFile) return;
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.publicOrigin === 'string' && data.publicOrigin) {
        const parsed = normalizePublicOrigin(data.publicOrigin);
        if (parsed.ok && !parsed.isLoopback) {
          this.publicOrigin = parsed.origin;
        }
      }
      if (data && Array.isArray(data.sessions)) {
        const now = Date.now();
        this.sessions = data.sessions.filter(s =>
          s &&
          typeof s.hash === 'string' &&
          /^[a-f0-9]{64}$/.test(s.hash) &&
          Number(s.expiresAt) > now
        );
      }
    } catch {
      // No saved state yet or unreadable
    }
  }

  _persistState() {
    if (!this.stateFile || this.readOnly) return;
    try {
      const dir = path.dirname(this.stateFile);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payload = JSON.stringify({
        version: 1,
        publicOrigin: this.publicOrigin || '',
        sessions: this._activeSessions()
      }, null, 2);
      const tmp = `${this.stateFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // Ignore persistence errors on read-only filesystems
    }
  }

  _activeSessions() {
    const now = Date.now();
    this.sessions = this.sessions.filter(s => Number(s.expiresAt) > now);
    return this.sessions;
  }

  _pruneExpiredPairing() {
    if (this.activePairing && Date.now() > this.activePairing.expiresAt) {
      this.activePairing = null;
    }
  }

  /**
   * Returns true if the HTTP request arrived via a reverse proxy / tunnel (Tailscale Serve,
   * Cloudflare Tunnel, ngrok, Caddy) or from a non-loopback network interface.
   * Only direct local browser connections to 127.0.0.1 / localhost return false.
   */
  isRemoteRequest(req) {
    if (!req) return true;
    const headers = req.headers || {};
    const proxyHeaders = [
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'forwarded',
      'cf-connecting-ip',
      'tailscale-user-login',
      'x-real-ip'
    ];
    for (const h of proxyHeaders) {
      if (headers[h] && String(headers[h]).trim() !== '') return true;
    }
    const hostName = extractHostWithoutPort(headers.host);
    if (hostName && !LOOPBACK_HOSTS.has(hostName)) {
      return true;
    }
    const remoteAddr = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress).toLowerCase() : '';
    if (remoteAddr && !LOOPBACK_HOSTS.has(remoteAddr)) {
      return true;
    }
    return false;
  }

  isHttpsRequest(req) {
    const headers = (req && req.headers) || {};
    const xfProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfProto === 'https') return true;
    if (req && req.socket && req.socket.encrypted) return true;
    if (this.isRemoteRequest(req) && this.publicOrigin.startsWith('https://')) return true;
    return false;
  }

  isAllowedOrigin(origin) {
    const clean = String(origin || '').trim();
    if (!clean) return false;
    if (clean === `http://127.0.0.1:${this.port}` || clean === `http://localhost:${this.port}`) {
      return true;
    }
    if (this.publicOrigin && clean === this.publicOrigin) {
      return true;
    }
    return false;
  }

  setPublicUrl(rawUrl) {
    if (this.readOnly) {
      return { ok: false, code: 'READ_ONLY_MODE', error: 'Remote pairing settings are disabled in --read-only mode' };
    }
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) {
      this.publicOrigin = '';
      this.activePairing = null;
      this._persistState();
      return { ok: true, status: this.getStatus() };
    }
    const parsed = normalizePublicOrigin(trimmed);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error || 'Invalid public URL' };
    }
    if (parsed.isLoopback) {
      return {
        ok: false,
        error: 'Loopback URL (localhost / 127.0.0.1) cannot be opened from a phone. Use your Tailscale Serve or Cloudflare Tunnel https:// URL.'
      };
    }
    this.publicOrigin = parsed.origin;
    this.mintPairingCode();
    this._persistState();
    return { ok: true, status: this.getStatus() };
  }

  mintPairingCode() {
    if (this.readOnly) {
      return null;
    }
    const token = crypto.randomBytes(24).toString('hex'); // 192-bit QR token
    const pin = generatePairingPin(); // 40-bit single-use PIN for iOS standalone Home Screen PWA
    const now = Date.now();
    const expiresAt = now + this.pairTtlMs;
    this.activePairing = {
      token,
      pinNormalized: pin.normalized,
      pinFormatted: pin.formatted,
      createdAt: now,
      expiresAt,
      failedAttempts: 0
    };
    return {
      code: token,
      pin: pin.formatted,
      expiresAt: new Date(expiresAt).toISOString(),
      pairingUrl: this.publicOrigin ? `${this.publicOrigin}/pair?code=${token}` : ''
    };
  }

  consumePairingCode(rawInput, opts = {}) {
    if (this.readOnly) {
      return { ok: false, code: 'READ_ONLY_MODE', error: 'Device pairing is disabled in --read-only mode' };
    }
    this._pruneExpiredPairing();
    if (!this.activePairing) {
      return { ok: false, error: 'No active pairing code. Generate a fresh QR in Phone QR on your Mac.' };
    }
    const raw = String(rawInput || '').trim();
    const normalizedPin = raw.replace(/[\s-]+/g, '').toUpperCase();
    const tokenMatch = timingSafeStrEqual(raw, this.activePairing.token);
    const pinMatch = timingSafeStrEqual(normalizedPin, this.activePairing.pinNormalized);

    if (!tokenMatch && !pinMatch) {
      this.activePairing.failedAttempts += 1;
      if (this.activePairing.failedAttempts >= MAX_PAIR_FAILED_ATTEMPTS) {
        this.activePairing = null;
      }
      return { ok: false, error: 'Invalid or expired pairing code.' };
    }

    // Strict single-use: invalidate immediately on successful pairing
    this.activePairing = null;

    const sessionToken = crypto.randomBytes(32).toString('hex'); // 256-bit secret cookie
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    this._activeSessions();
    this.sessions.push({
      id: crypto.randomBytes(6).toString('hex'),
      hash: sha256Hex(sessionToken),
      createdAt: now,
      expiresAt,
      ua: String(opts.userAgent || '').slice(0, 120)
    });
    this._persistState();

    const maxAgeSec = Math.max(60, Math.floor(this.sessionTtlMs / 1000));
    const secureFlag = opts.secure ? '; Secure' : '';
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secureFlag}`;
    return {
      ok: true,
      sessionToken,
      cookieHeader,
      pairedDeviceCount: this.sessions.length
    };
  }

  isAuthenticatedRequest(req) {
    if (!req) return false;
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const candidateHash = sha256Hex(token);
    const active = this._activeSessions();
    for (const s of active) {
      if (timingSafeStrEqual(candidateHash, s.hash)) return true;
    }
    return false;
  }

  revokeAllSessions() {
    if (this.readOnly) {
      return this.getStatus();
    }
    this.sessions = [];
    this.activePairing = null;
    this._persistState();
    return this.getStatus();
  }

  getStatus() {
    this._pruneExpiredPairing();
    const activeSessions = this._activeSessions();
    return {
      enabled: Boolean(this.publicOrigin),
      publicOrigin: this.publicOrigin || '',
      isHttps: Boolean(this.publicOrigin && this.publicOrigin.startsWith('https://')),
      pairingUrl: (this.publicOrigin && this.activePairing)
        ? `${this.publicOrigin}/pair?code=${this.activePairing.token}`
        : '',
      pairingPin: this.activePairing ? this.activePairing.pinFormatted : '',
      pairingExpiresAt: this.activePairing ? new Date(this.activePairing.expiresAt).toISOString() : null,
      pairedDeviceCount: activeSessions.length
    };
  }

  renderPairRequiredHtml(opts = {}) {
    const errMsg = opts.error ? String(opts.error) : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#030712" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="RigCommander" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/svg+xml" href="/assets/icons/favicon.svg" />
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon.png" />
  <title>RigCommander // Device Pairing Required</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: radial-gradient(circle at 20% 0%, rgba(0, 240, 255, 0.12), transparent 50%), #030712;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
    }
    .card {
      width: 100%;
      max-width: 400px;
      background: rgba(10, 18, 36, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.32);
      border-radius: 16px;
      padding: 24px 22px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65), 0 0 28px rgba(0, 240, 255, 0.12);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      color: #67e8f9;
      background: rgba(0, 240, 255, 0.1);
      border: 1px solid rgba(0, 240, 255, 0.35);
      border-radius: 999px;
      padding: 4px 10px;
    }
    h1 { font-size: 19px; font-weight: 800; letter-spacing: -0.2px; }
    p { font-size: 13px; color: #94a3b8; line-height: 1.5; }
    .err {
      font-size: 12px;
      color: #fda4af;
      background: rgba(244, 63, 94, 0.12);
      border: 1px solid rgba(244, 63, 94, 0.35);
      border-radius: 10px;
      padding: 10px 12px;
    }
    form { display: flex; flex-direction: column; gap: 10px; }
    label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #cbd5e1; }
    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(56, 189, 248, 0.4);
      background: rgba(2, 6, 23, 0.9);
      color: #f8fafc;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 2px;
      text-align: center;
      text-transform: uppercase;
      outline: none;
    }
    input:focus { border-color: #00f0ff; box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.18); }
    button {
      width: 100%;
      padding: 12px 16px;
      border: none;
      border-radius: 10px;
      background: linear-gradient(135deg, #00f0ff, #00ff9d);
      color: #030712;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.4px;
      cursor: pointer;
    }
    .note {
      font-size: 11.5px;
      color: #64748b;
      border-top: 1px solid rgba(148, 163, 184, 0.16);
      padding-top: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">💠 RIGCOMMANDER // LIVE BRIDGE</span>
    <h1>Pair This Device</h1>
    <p>This live telemetry bridge is locked. Open <strong>Phone QR</strong> in RigCommander on your Mac and scan the QR code — or enter the 8-character PIN shown below the QR.</p>
    ${errMsg ? `<div class="err">⚠️ ${escapeHtml(errMsg)}</div>` : ''}
    <form method="POST" action="/pair">
      <label for="pairCodeInput">ONE-TIME PAIRING PIN (E.G. K7M9-P2X4)</label>
      <input id="pairCodeInput" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required />
      <button type="submit">🔗 Connect Live RigCommander</button>
    </form>
    <div class="note">
      🍏 <strong>iPhone PWA tip:</strong> After adding RigCommander to your Home Screen, iOS creates an isolated app container. Enter the PIN once inside the installed app icon to stay paired for 30 days.
    </div>
  </div>
</body>
</html>`;
  }
}

export { SESSION_COOKIE_NAME };
