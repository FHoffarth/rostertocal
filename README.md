# RosterToCal — MVP prototype

Turn a photographed or PDF shift roster into calendar events, on the device,
with no upload, no login and no server.

**Status: prototype. Not production-ready.** It has never run on a real phone
or been imported into a real calendar app. See
[Unverified](#unverified--needs-device-validation).

## Run it

```bash
npm install
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

## The flow

**Acquire → Align → Recognize → Confirm → Export**

1. **Acquire** — JPEG, PNG or PDF. A PDF's text layer is read natively; only a
   scan falls through to OCR.
2. **Align** — you mark two bands: the row of dates, and your own shift row.
   Each band has two ends, so it can follow a photo that sits crooked.
3. **Recognize** — the date band builds the day columns; the shift band is read
   into those columns. Geometry decides which day a reading belongs to — never
   the recogniser.
4. **Confirm** — the whole month as tappable cells. Anything under 80 %
   confidence is marked, anything unreadable is blank. One tap corrects a day.
5. **Export** — a `.ics` file, handed to the system share sheet or saved.

## Design decisions worth knowing

**Two bands, not table parsing.** Full-roster OCR fails in the one place it
matters — pairing a cell to a date. Asking the user for two drags removes that
problem entirely and takes about five seconds.

**Geometry owns the date→cell mapping** (`gridAlignment.ts`). OCR only reports
*what* it read and *where*. A token that lands in no column is discarded, never
snapped to the nearest day.

**Fail closed, then interpolate.** Day columns are fitted by least squares.
A day read in two places is dropped entirely; a single outlier is discarded and
its column interpolated; a majority of outliers rejects the whole alignment.

**Confidence is displayed, never trusted.** Nothing reaches the calendar until
it is confirmed or explicitly accepted in the review step. Unreadable cells stay
unreadable — no code is ever invented.

**Character-level OCR.** Roster cells are separated by printed rules, not
spaces, so Tesseract returns the whole row as one "word". Reading per character
and re-grouping by geometry is what makes per-day mapping possible.

**Date-only arithmetic never touches `Date` parsing** (`icsGenerator.ts`).
`new Date('2026-08-23')` is UTC midnight and shifts the day in western zones.
`parseYmd` / `addDays` / `formatYmd` are pure local-calendar functions.

## Privacy boundary

- The file is read into a canvas and never leaves the page. No upload endpoint
  exists in the code.
- OCR runs in a WebAssembly worker on the device.
- **All Tesseract assets are self-hosted** from `public/tesseract`: worker,
  WASM core and the `eng` model. tesseract.js would otherwise fetch them from a
  public CDN. Verified by removing the local model and clearing IndexedDB —
  recognition then fails rather than reaching for a CDN.
- Shift definitions live in `localStorage` under one versioned key. No sync,
  no profile, no account.
- No analytics, no telemetry, no crash reporting.

## Performance safeguards

- Photos are downscaled to a 2000 px working canvas before anything else.
- Crops are transient and released (`canvas.width = 0`) right after OCR.
- Exactly one Tesseract worker per session, reused; explicitly terminated on
  unmount.
- pdf.js and tesseract.js are dynamically imported — the initial bundle is
  ~225 kB (72 kB gzipped); a photo user never downloads pdf.js.
- The whole shift band is OCR'd in one pass; only weak cells get a second,
  per-cell pass.
- Object URLs are revoked (image decode: immediately; export: after 60 s).

Measured on the sample photo, desktop Chromium, production build:
`dates 1635 ms · row 1101 ms · 3 cells retried 528 ms · total 3267 ms`.
Text-PDF extraction: `8 ms`. **No mobile benchmark exists yet.**

## Recognition accuracy — measured, not claimed

On `samples/sample-roster-photo.jpg` (synthetic, 1.4° tilt, uneven lighting,
JPEG q72), one employee row of 31 days:

| result | count |
| --- | --- |
| correct | 28 |
| unreadable (shown blank, needs a tap) | 1 |
| wrong, flagged uncertain (54 %) | 1 |
| **wrong, high confidence (99 %)** | **1** |

The last row is the risk that matters: a cell can be confidently wrong, and the
review matrix is the only thing standing between it and the calendar. This is
why the product is built around correction rather than autonomy.

The text-PDF sample recognises **31 of 31** days exactly.

## Samples

`samples/make_samples.py` (PyMuPDF + Pillow) regenerates both fixtures.
`sample-roster-photo.jpg` is a *synthetic* photo — rotated, unevenly lit and
JPEG-degraded, but not a photograph of real printed paper.

## Unverified — needs device validation

Nothing below has been tested. Treat each as an open question, not a feature.

- **iPhone Safari** and **Android Chrome**: never run on either.
- **Calendar import**: no `.ics` produced here has been opened by Apple
  Calendar, Google Calendar or any Android calendar app.
- **`TZID=Europe/Berlin`**: a `VTIMEZONE` block with the current EU rule is
  included, which is the best a file can do — but whether a given client honours
  it across a DST boundary is a per-client question, and untested. Only
  Europe/Berlin is supported.
- **Web Share with files**: the code path exists and its fallback is unit
  tested, but no real share sheet has been invoked.
- **Touch dragging**: band handles were driven with synthetic pointer events,
  not fingers. Hit targets are 48 px, but real-thumb ergonomics are unverified.
- **Mobile memory**: repeated load/discard cycles keep the JS heap flat
  (18–33 MB) on desktop. A 12 MP photo on a low-end phone is untested.
- **First-load cost**: the OCR model is ~2 MB gzipped and the WASM core ~2.9 MB.
  On a slow connection the first recognition will be slow; there is no progress
  indicator for that download yet.

## Known limitations

- One employee row, one month, one page per import.
- A band is a parallelogram, so it corrects tilt but not perspective. A photo
  taken at a steep angle will not align.
- The alignment needs at least three readable day numbers.
- `OFF` and other three-character codes are the weakest OCR case — they are wide
  enough to cross column boundaries.
- If the OCR model is missing from a deployment, engine start times out after
  45 s with a readable error rather than hanging forever.
