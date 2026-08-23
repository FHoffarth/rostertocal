/**
 * Service-worker registration and the install/update signals the UI
 * needs. Nothing here touches roster data.
 */

export type PwaStatus = {
  /** A newer build is installed and waiting for the user to accept it. */
  updateReady: boolean;
  /** The browser offered a native install prompt (Android/desktop Chrome). */
  canInstall: boolean;
  /** Already launched from the home screen. */
  installed: boolean;
  /** iOS Safari has no install prompt; it needs the Share-sheet hint. */
  iosHint: boolean;
};

type Listener = (s: PwaStatus) => void;

let waiting: ServiceWorker | null = null;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<Listener>();

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: fullscreen)').matches === true ||
    iosStandalone === true
  );
}

/** iOS Safari: no beforeinstallprompt exists, so the user must be told. */
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const otherBrowser = /CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);
  return iOS && webkit && !otherBrowser;
}

function status(): PwaStatus {
  const installed = isStandalone();
  return {
    updateReady: waiting !== null,
    canInstall: deferredPrompt !== null && !installed,
    installed,
    iosHint: isIosSafari() && !installed,
  };
}

function emit() {
  const s = status();
  listeners.forEach((l) => l(s));
}

export function subscribePwa(listener: Listener): () => void {
  listeners.add(listener);
  listener(status());
  return () => listeners.delete(listener);
}

/** Ask the browser to show its own install prompt. Chrome-family only. */
export async function promptInstall(): Promise<boolean> {
  const p = deferredPrompt;
  if (!p) return false;
  deferredPrompt = null;
  await p.prompt();
  const { outcome } = await p.userChoice;
  emit();
  return outcome === 'accepted';
}

/**
 * Take the waiting build. The page reloads once the new worker takes
 * control, so the user never ends up running half of one version and
 * half of another.
 */
export function applyUpdate(): void {
  if (!waiting) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waiting.postMessage('skip-waiting');
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Only the built app ships a worker; the dev server has none.
  if (!import.meta.env.PROD) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the event so the hint can trigger it at a moment that makes
    // sense, instead of the browser's own timing.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    emit();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        const track = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            // "installed" while a controller exists means this is an
            // update rather than a first install.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              waiting = worker;
              emit();
            }
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) {
          waiting = reg.waiting;
          emit();
        }
        reg.addEventListener('updatefound', () => track(reg.installing));
      })
      .catch(() => {
        // A failed registration must never stop the app working; it just
        // means no offline shell this session.
      });
  });
}
