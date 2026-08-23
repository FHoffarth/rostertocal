# validation/

Evidence and run sheets for RosterToCal device validation.

| file | what it is | status |
| --- | --- | --- |
| `DEVICE-VALIDATION.md` | run sheet for iPhone / Android / Apple / Google | **not yet executed** |
| `check_ics.py` | independent RFC-5545 + timezone conformance check | executed, 46/46 pass |
| `roster-2026-08.ics` | reference export, byte-identical to the app's output | generated |

`roster-2026-08.ics` is the real thing: it was produced by the app in a browser
(FNV-1a `f64871f5`, 5291 bytes) and reproduced here byte-for-byte. Mail it to a
phone to test Apple / Google Calendar import without needing the app on the
device first.

`check_ics.py` shares no code with the app and resolves Europe/Berlin through
the stdlib IANA database, so a bug in `icsGenerator.ts` cannot hide behind the
same bug in the checker. It validates the **file**; it says nothing about how
any calendar client behaves.

```bash
python validation/check_ics.py validation/roster-2026-08.ics
```
