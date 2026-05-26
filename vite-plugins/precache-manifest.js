// Vite plugin: after the build emits dist/, rewrite dist/sw.js to substitute
// two placeholders that the SW source can't compute itself:
//
//   __APP_VERSION__         a build-time identifier (cache-busts the shell cache)
//   __PRECACHE_MANIFEST__   array of dist/-relative paths the SW pre-caches on install
//
// We exclude dist/tiles/* and dist/data/* from the precache list — those are
// the big data files installed by the user-driven flow in src/pwa/install.js.
// We also exclude sw.js (it can't precache itself) and version.json (always
// network-first).

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_EXCLUDE_PREFIXES = ['tiles/', 'data/', 'icons/bikemap.svg'];
const DEFAULT_EXCLUDE_BASENAMES = new Set(['sw.js', 'manifest.webmanifest']);

function hashPrecache(distDir, precache) {
  const h = createHash('sha256');
  for (const rel of [...precache].sort()) {
    h.update(rel);
    h.update('\0');
    if (rel === './') continue; // synthetic root entry; nothing to hash
    const abs = join(distDir, rel.replace(/^\.\//, ''));
    try { h.update(readFileSync(abs)); } catch {}
  }
  return h.digest('hex').slice(0, 16);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const s = statSync(abs);
    if (s.isDirectory()) {
      out.push(...listFiles(abs, base));
    } else {
      out.push(relative(base, abs).split(sep).join('/'));
    }
  }
  return out;
}

export default function precacheManifest({ appVersion } = {}) {
  return {
    name: 'precache-manifest',
    apply: 'build',
    closeBundle() {
      const distDir = 'dist';
      const swPath = join(distDir, 'sw.js');

      let sw;
      try {
        sw = readFileSync(swPath, 'utf8');
      } catch {
        console.warn('[precache-manifest] dist/sw.js not found — did vite copy public/?');
        return;
      }

      const all = listFiles(distDir);
      const precache = ['./']
        .concat(
          all
            .filter((p) => !DEFAULT_EXCLUDE_PREFIXES.some((pre) => p.startsWith(pre)))
            .filter((p) => !DEFAULT_EXCLUDE_BASENAMES.has(p))
            .map((p) => './' + p),
        );

      // Content hash of the precache contents — this becomes APP_VERSION.
      // Content-based (not timestamp) so a no-op rebuild doesn't spam a
      // phantom "Update available" on every existing install.
      const version = appVersion || process.env.APP_VERSION
        || hashPrecache(distDir, precache);

      // Replace the entire `let PRECACHE_MANIFEST = [];` line, not just a
      // placeholder string — keeps the dev-mode default a valid JS literal.
      const out = sw
        .replace(/^let PRECACHE_MANIFEST = \[\];$/m,
                 `let PRECACHE_MANIFEST = ${JSON.stringify(precache)};`)
        .replace(/__APP_VERSION__/g, version);

      writeFileSync(swPath, out);

      // Stamp the same version into dist/data/version.json so the update
      // check in src/pwa/update.js can detect shell-only changes (it diffs
      // appVersion separately from per-file data hashes).
      const versionPath = join(distDir, 'data', 'version.json');
      if (existsSync(versionPath)) {
        try {
          const manifest = JSON.parse(readFileSync(versionPath, 'utf8'));
          manifest.appVersion = version;
          writeFileSync(versionPath, JSON.stringify(manifest, null, 2) + '\n');
        } catch (e) {
          console.warn('[precache-manifest] failed to stamp version.json:', e.message);
        }
      }

      console.log(`[precache-manifest] sw.js: APP_VERSION=${version}, ${precache.length} files precached`);
    },
  };
}
