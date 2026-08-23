# RosterToCal — real-device validation protocol

Build under test: commit `6396cbc` plus the device-enabler sprint.

This is the run sheet for the parts that **cannot** be done without physical
hardware. Nothing below the setup section has been executed. Every row you leave
blank stays unknown.

---

## 0. Setup — local HTTPS (do this first)

A phone will not give the page a secure context over plain http, and without one
`navigator.share` does not exist, so an export test would silently only ever
exercise the download fallback. Everything here stays on your machine and your
LAN: no tunnel, no hosted service, no third party.

### 0.1 On the laptop

```bash
npm run cert
```

This generates a local CA and a server certificate covering `localhost` and every
LAN IPv4 address on this machine, into `validation/certs/` (gitignored — the keys
are private). It prints the CA's SHA-256 fingerprint; write it down.

```bash
npm run build
npm run validate:https
```

Vite serves at `https://<your-lan-ip>:4443/`. If `validation/certs/` is absent,
`npm run dev` and `npm run preview` behave exactly as before, over plain http —
the HTTP path stays available and the built application is unchanged either way.

Verified locally: the chain validates (`openssl verify` → OK, TLS handshake
`Verify return code: 0`) and the certificate covers `DNS:localhost`,
`127.0.0.1` and both LAN addresses.

### 0.2 Trust the CA on the iPhone

1. Get `validation/certs/ca.crt` onto the phone (AirDrop, or email it to
   yourself). **Only this file** — never `ca.key` or `server.key`.
2. Tap it. iOS says *Profile Downloaded*.
3. **Settings → General → VPN & Device Management → RosterToCal Local
   Validation CA → Install** (enter passcode, Install again).
4. **Settings → General → About → Certificate Trust Settings** → switch
   **on** for that CA. iOS will not trust it until this second step is done.
5. Check the fingerprint matches the one printed by `npm run cert`.

### 0.3 Trust the CA on Android

1. Copy `ca.crt` to the phone.
2. **Settings → Security & privacy → More security settings → Encryption &
   credentials → Install a certificate → CA certificate → Install anyway**,
   pick the file. (Menu wording varies by vendor; search Settings for "CA
   certificate".)
3. Android shows a "network may be monitored" warning for user CAs — that is
   expected for any private CA.

### 0.4 Confirm the secure context on the device

Open `https://<lan-ip>:4443/` on the phone. There must be **no** certificate
warning. Then, in the device browser's console (Safari Web Inspector from a Mac,
or `chrome://inspect` from the laptop for Android), run:

```js
({ secure: isSecureContext, share: typeof navigator.share, canShare: typeof navigator.canShare })
```

Record the result. Required: `secure: true`. Both iOS Safari and Android Chrome
implement Web Share, so `share` should be `"function"` — if it is `undefined`,
the origin is not actually secure and sections B/D would be invalid.

> Desktop note: verified here that a secure context restores `crypto.subtle`,
> but this Chromium has no `navigator.share` at all — desktop Chromium does not
> implement Web Share. Its presence is a device-only check.

### 0.5 Getting a roster onto the phone

Photograph a real paper roster with the in-app camera button. Also mail yourself
`validation/roster-2026-08.ics` — you can run sections B and D from that file
alone, without the app, if you want calendar evidence early.

---

## A. iPhone Safari

| step | what to do | record |
| --- | --- | --- |
| A1 | Open the build. Note iOS + Safari version | |
| A2 | Photograph a real paper roster with the in-app camera button | worked? |
| A3 | Zoom in (+) until a day column is comfortably wide; pan with one finger | usable? |
| A4 | Thumb-drag the blue band onto the date row | |
| A5 | Thumb-drag the green band onto your own row | |
| A6 | Use the left/right circles to follow the tilt | reachable? |
| A7 | Tap Fit, check both bands still sit on their rows | survived zoom? |
| A8 | Tap "Read this roster", wait | seconds elapsed |
| A9 | Count cells by state (orange = to check, red = unclear) | RECOGNIZED / UNRESOLVED |
| A10 | **Compare EVERY orange cell against the paper, one by one** | FALSE_ACCEPTED_CELLS |
| A11 | Try to export before resolving | must be blocked |
| A12 | Resolve every red cell, accept the orange ones | manual edits count |
| A13 | Export | share sheet or download? |

**A10 is the KPI.** A single orange cell whose code differs from the paper is a
FAIL and a stop condition. Red cells are not failures — they are the system
refusing to guess.

## B. Apple Calendar import

Import the exported `.ics`. For each row: PASS / FAIL.

| case | expected | result |
| --- | --- | --- |
| ordinary day shift | appears on the right date, right times | |
| OFF / free day | **no event at all** | |
| overnight shift | starts 22:00, ends 06:00 **next** day | |
| month-boundary overnight | 31 Aug 22:00 → 1 Sep 06:00 | |
| event title | e.g. "N Nachtdienst" | |
| start time | matches roster, local | |
| end time | matches roster, local | |
| calendar date | no one-day drift | |
| timezone | no UTC shift (not 20:00 instead of 22:00) | |
| duplicates | importing twice creates no second copy | |

## C. Android Chrome

Every step of A, on a real Android phone in Chrome. Additionally record:
rendering or layout issues, any OCR crash, tab reload/eviction, whether the
phone got noticeably hot, and whether `navigator.share` was present (0.4).

## D. Google Calendar import

Same table as B.

## E. Thumb / mobile UX (observe, do not fix)

- band handles too small?
- drag jitter?
- does the page scroll while you drag a band?
- accidental band movement while panning?
- confirm/edit controls reachable one-handed?
- are red "unclear" cells understandable without explanation?
- is the disabled export button's reason obvious?
- horizontal overflow anywhere?
- anything broken by the notch / safe area?

**Zoom specifically** (new this sprint):
- is "Fit / − / % / +" discoverable?
- at 200–400 %, can you place a band on the right row confidently?
- does one-finger drag on the picture pan without moving a band?
- does dragging a band ever pan the picture instead?

**Already measured in 320/375/390 emulation — not on a device:**
all 8 handles sit fully inside the stage at 100 % at all three widths, each
48×48 px, no page-level horizontal overflow; at 400 % all 8 remain reachable by
panning. Band source coordinates are identical at 100/150/200/300/400 % and
after returning to Fit.

## F. Privacy / network

With DevTools (Android: chrome://inspect; iOS: Safari Web Inspector from a Mac)
attached, run one full recognition and record **every** request.

Required: no request to any host other than the app origin; nothing containing
image or roster data; no analytics; no telemetry; no remote error logging.

Any request carrying roster-derived content ⇒ **NO-GO**.

## G. Repeated scans

Load → recognise → discard → load again, ≥3 times. Record: crash, tab reload,
stale previous roster, obvious slowdown, phone heat. Do **not** quote heap
numbers unless measured with real tooling.

---

## Result table — one row per device

```
Device:
OS:
Browser:
Roster:
RECOGNIZED:
UNRESOLVED:
FALSE_ACCEPTED_CELLS:
Band usability:
Zoom usability:
Export:
Calendar import:
Overnight:
Month boundary:
Privacy:
Stability:
Notes:
```

## Classification

- **PASS** — recognition matches the paper
- **UNRESOLVED** — the system refused to assume. *Not* a recognition failure.
- **FAIL** — a wrong value was marked RECOGNIZED, or wrong data was exported

Uncertain and blocked = safe. Wrong and accepted = unsafe.

## Stop conditions (immediate NO-GO)

- a wrong cell is RECOGNIZED and can be bulk-confirmed without obvious review
- an UNRESOLVED cell reaches the `.ics`
- a wrong event appears after import
- any roster payload leaves the device
- Apple or Google Calendar shifts dates/times
- band alignment is unusable with a thumb
