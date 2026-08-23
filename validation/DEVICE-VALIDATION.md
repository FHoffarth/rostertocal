# RosterToCal — real-device validation protocol

Build under test: commit `6396cbc`.

This file is the run sheet for the parts of validation that **cannot** be done
without physical hardware. Nothing in it has been executed yet. Fill it in on
the devices; every row left blank is a row that stays unknown.

---

## 0. Before you start: the secure-context blocker

**Verified here, not assumed.** Loading the production build over a plain-http
LAN address gives:

```
origin            http://192.168.178.46:4174
isSecureContext   false
navigator.share   undefined
navigator.canShare undefined
crypto.subtle     undefined
```

Consequences for validation:

- Export **strategy A (Web Share with a File)** can never run. The app falls
  back to the blob-URL download, so a device test over http tests only the
  fallback. Any conclusion about "share to calendar" would be invalid.
- On iOS Safari the download fallback for a blob URL is historically the weaker
  path, so this is also the least favourable configuration to judge the app by.

**Serve the build over HTTPS before running section A–D**, or accept that
section B/D only covers the download path and record that explicitly.

Options, in order of least exposure:

1. **Local HTTPS with a trusted cert** — self-signed cert on the laptop, trust
   profile installed on the phone. Nothing leaves the LAN. Fiddliest on iOS.
2. **Static HTTPS host** — publish `dist/` to any static host. The roster still
   never leaves the device (all processing is client-side), but the *app assets*
   then come from a third party. Ask before doing this.
3. **Tunnel** (ngrok/cloudflared) — same trade as 2, plus the traffic transits
   the tunnel provider.

Current LAN URL (http, insecure): `http://192.168.178.46:4174/`
Also reachable on: `http://192.168.178.39:4174/`

---

## A. iPhone Safari

| step | what to do | record |
| --- | --- | --- |
| A1 | Open the build. Note iOS + Safari version | |
| A2 | Photograph a real paper roster with the in-app camera button | worked? |
| A3 | Thumb-drag the blue band onto the date row | |
| A4 | Thumb-drag the green band onto your own row | |
| A5 | Use the left/right circles to follow the tilt | reachable? |
| A6 | Tap "Read this roster", wait | seconds elapsed |
| A7 | Count cells by state (orange = to check, red = unclear) | RECOGNIZED / UNRESOLVED |
| A8 | **Compare EVERY orange cell against the paper, one by one** | FALSE_ACCEPTED_CELLS |
| A9 | Try to export before resolving | must be blocked |
| A10 | Resolve every red cell, accept the orange ones | manual edits count |
| A11 | Export | share sheet or download? |

**A8 is the KPI.** A single orange cell whose code differs from the paper is a
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

Same as A. Additionally record: rendering/layout issues, OCR crash, tab reload,
whether the phone got hot or the tab was evicted.

## D. Google Calendar import

Same table as B.

## E. Thumb / mobile UX (observe, do not fix)

- band handles too small?
- drag jitter?
- page scrolls while dragging a band?
- accidental band movement when scrolling?
- confirm/edit controls reachable one-handed?
- are red "unclear" cells understandable without explanation?
- is the disabled export button's reason obvious?
- horizontal overflow anywhere?
- anything broken by the notch / safe area?

**Already known from 375 px emulation (not from a device):**
- the left/right tilt handles sit partly off-screen at 375 px — see defect D-1
- a 2000 px roster renders into ~351 px with no zoom — see defect D-2

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
Roster type:
Photo resolution:
Days:
RECOGNIZED:
UNRESOLVED:
FALSE_ACCEPTED_CELLS:
Manual edits:
Band usability:
Export gate:
ICS generated:
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
