import { useRef, useState } from 'react';
import { isAcceptedFile } from '../lib/imageLoader';

interface Props {
  onFile: (file: File) => void;
  busy: boolean;
  error?: string | null;
}

/** ACQUIRE. Nothing here uploads: the File never leaves the page. */
export function UploadStep({ onFile, busy, error }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  function handle(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!isAcceptedFile(file)) {
      setLocalError('Please pick a JPEG, PNG or PDF roster.');
      return;
    }
    setLocalError(null);
    onFile(file);
  }

  return (
    <section>
      <div className="dropzone">
        <h2>Add your roster</h2>
        <p className="muted">Photo, scan or PDF. One month, your own row.</p>
        <div className="row" style={{ marginTop: 14 }}>
          <button
            className="primary"
            disabled={busy}
            onClick={() => cameraRef.current?.click()}
          >
            {busy ? 'Loading…' : 'Take a photo'}
          </button>
          <button
            className="ghost grow"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Choose file or PDF
          </button>
        </div>
        <input
          ref={cameraRef}
          type="file"
          accept="image/jpeg,image/png"
          capture="environment"
          onChange={(e) => handle(e.target.files)}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          onChange={(e) => handle(e.target.files)}
        />
      </div>

      {(localError || error) && (
        <div className="banner err" style={{ marginTop: 12 }}>
          {localError ?? error}
        </div>
      )}

      <p className="muted" style={{ marginTop: 14 }}>
        Text PDFs are read directly. Photos and scans are recognised on this device
        with a local OCR engine — the first run downloads the OCR model from the
        page origin, then works offline.
      </p>
    </section>
  );
}
