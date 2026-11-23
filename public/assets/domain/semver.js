/**
 * Pure zero-dependency SemVer & npmjs release helpers shared between
 * Node server (openrig/lib/self-update.mjs), Command Deck (openrig/index.html),
 * and the Website (landing/index.html).
 */

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(raw) {
  const str = String(raw || '').trim();
  const m = SEMVER_RE.exec(str);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const pre = m[4] ? m[4].split('.') : [];
  return {
    major,
    minor,
    patch,
    pre,
    normalized: `${major}.${minor}.${patch}${pre.length ? '-' + pre.join('.') : ''}`
  };
}

export function compareSemver(a, b) {
  const pa = typeof a === 'object' && a !== null && 'major' in a ? a : parseSemver(a);
  const pb = typeof b === 'object' && b !== null && 'major' in b ? b : parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  // Release without prerelease has higher precedence than prerelease (e.g. 3.2.0 > 3.2.0-rc.1)
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    if (i >= pa.pre.length) return -1;
    if (i >= pb.pre.length) return 1;
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      const diff = Number(ia) - Number(ib);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia !== ib) {
      return ia > ib ? 1 : -1;
    }
  }
  return 0;
}

export function isNewerVersion(latest, current) {
  const cmp = compareSemver(latest, current);
  return cmp === 1;
}

export function normalizeNpmReleaseInfo(payload, packageName = 'rig-commander') {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, version: '', releaseUrl: '', error: 'Empty registry payload' };
  }
  const parsed = parseSemver(payload.version);
  if (!parsed) {
    return { ok: false, version: '', releaseUrl: '', error: 'Invalid version in registry payload' };
  }
  const safePkg = String(packageName || 'rig-commander').replace(/[^a-zA-Z0-9@/_-]/g, '');
  return {
    ok: true,
    version: parsed.normalized,
    releaseUrl: `https://www.npmjs.com/package/${safePkg}/v/${parsed.normalized}`
  };
}
