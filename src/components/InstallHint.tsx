import { useEffect, useState } from 'react';
import {
  applyUpdate,
  promptInstall,
  subscribePwa,
  type PwaStatus,
} from '../lib/pwa';

const DISMISSED_KEY = 'rostertocal.installHintDismissed';

/**
 * One small line, twice at most: "you can install this" and "a new
 * version is ready". Both disappear once acted on, and the install hint
 * never returns once dismissed or once the app is running from the home
 * screen.
 */
export function InstallHint() {
  const [status, setStatus] = useState<PwaStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => subscribePwa(setStatus), []);

  if (!status) return null;

  // An update is worth interrupting for; an install suggestion is not.
  if (status.updateReady) {
    return (
      <div className="banner ok install-hint" role="status">
        <span>A new version is ready.</span>
        <button className="ghost" onClick={applyUpdate}>
          Reload
        </button>
      </div>
    );
  }

  if (status.installed || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Private mode: the hint simply comes back next time.
    }
  };

  if (status.canInstall) {
    return (
      <div className="banner install-hint" role="note">
        <span>Add RosterToCal to your home screen for quicker access.</span>
        <button
          className="ghost"
          onClick={async () => {
            const accepted = await promptInstall();
            if (!accepted) dismiss();
          }}
        >
          Install
        </button>
        <button className="ghost" onClick={dismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  if (status.iosHint) {
    return (
      <div className="banner install-hint" role="note">
        <span>
          To keep this handy: tap <strong>Share</strong>, then{' '}
          <strong>Add to Home Screen</strong>.
        </span>
        <button className="ghost" onClick={dismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  return null;
}
