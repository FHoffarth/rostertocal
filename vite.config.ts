import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Emit the service worker with a real precache list and a build id.
 *
 * Hand-rolled instead of vite-plugin-pwa/workbox: the worker is ~130
 * lines that need auditing line by line, because the one thing it must
 * never do is cache a roster. A generated worker would be harder to
 * check and would pull in a dependency tree for features we do not want.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'rostertocal-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).sort();
      // The build id is derived from the output itself, so an identical
      // build produces an identical worker and a changed build always
      // invalidates the old cache.
      const buildId = createHash('sha256')
        .update(emitted.join('|'))
        .digest('hex')
        .slice(0, 12);

      // App shell only. Lazy chunks (pdf.js, the OCR wrapper) and the
      // OCR runtime are cached on first use instead, so installing the
      // app does not pull ~25 MB over a phone connection.
      const shell = emitted
        .filter((f) => /^assets\/index-[^/]+\.(js|css)$/.test(f))
        .map((f) => `/${f}`);

      const precache = [
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/icon.svg',
        '/icon-192.png',
        '/icon-512.png',
        '/icon-maskable-512.png',
        '/apple-touch-icon.png',
        ...shell,
      ];

      const template = readFileSync(
        fileURLToPath(new URL('./src/sw-template.js', import.meta.url)),
        'utf-8',
      );
      // replaceAll: the placeholders are also named in the template's
      // own doc comment, and replace() would substitute those instead.
      const source = template
        .replaceAll('__BUILD_ID__', buildId)
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      this.emitFile({
        type: 'asset',
        fileName: 'build-id.txt',
        source: buildId,
      });
    },
  };
}

/**
 * Local HTTPS for on-device validation.
 *
 * A phone will not give the page a secure context over plain http, and
 * without one `navigator.share` does not exist - so an export test on a
 * device would silently only ever exercise the download fallback.
 *
 * The certificate is generated locally by validation/make-cert.sh and is
 * gitignored. If it is not there, everything behaves exactly as before:
 * `npm run dev` and `npm run preview` stay plain http. Nothing about the
 * built application changes either way.
 */
const certDir = fileURLToPath(new URL('./validation/certs/', import.meta.url));
const key = `${certDir}server.key`;
const cert = `${certDir}server.crt`;
const hasLocalCert = existsSync(key) && existsSync(cert);

export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  preview: hasLocalCert
    ? {
        // Reachable from the phone on the LAN, over a certificate that
        // the phone can be made to trust.
        host: true,
        port: 4443,
        strictPort: true,
        https: { key: readFileSync(key), cert: readFileSync(cert) },
      }
    : undefined,
});
