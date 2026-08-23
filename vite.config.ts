import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [react()],
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
