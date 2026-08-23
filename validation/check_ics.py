"""Independent conformance check for a RosterToCal .ics file.

This deliberately shares no code with the app: it re-parses the file and
resolves Europe/Berlin through the stdlib IANA database, so a mistake in
icsGenerator.ts cannot hide behind the same mistake in the checker.

It validates the FILE. It says nothing about how Apple Calendar or
Google Calendar behave - only a real import on a real device can.

Run:  python validation/check_ics.py validation/roster-2026-08.ics
"""

import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")
UTC = ZoneInfo("UTC")

REQUIRED_VEVENT = {"UID", "DTSTAMP", "SUMMARY", "DTSTART", "DTEND"}
DT_RE = re.compile(r"^DT(START|END);TZID=([^:]+):(\d{8})T(\d{6})$")


def unfold(raw: str) -> list[str]:
    """RFC 5545 3.1: a CRLF followed by a space continues the line."""
    if "\r\n" not in raw:
        fail("file does not use CRLF line endings")
    out: list[str] = []
    for line in raw.split("\r\n"):
        if line.startswith(" ") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return [l for l in out if l]


problems: list[str] = []
checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))
    if not ok:
        problems.append(f"{name}: {detail}")


def fail(msg: str) -> None:
    print(f"FATAL: {msg}")
    sys.exit(2)


def parse_local(value: str) -> datetime:
    m = DT_RE.match(value)
    if not m:
        fail(f"unparseable datetime property: {value}")
    _, tzid, date, time = m.groups()
    if tzid != "Europe/Berlin":
        fail(f"unexpected TZID {tzid}")
    return datetime.strptime(date + time, "%Y%m%d%H%M%S").replace(tzinfo=BERLIN)


def main(path: str) -> int:
    raw = open(path, "r", encoding="utf-8", newline="").read()

    # --- structure -----------------------------------------------------
    check("ends with CRLF", raw.endswith("\r\n"))
    check("no bare LF", "\n" not in raw.replace("\r\n", ""))

    over = [l for l in raw.split("\r\n") if len(l.encode("utf-8")) > 75]
    check("all lines <= 75 octets", not over, f"{len(over)} long line(s)")

    lines = unfold(raw)
    check("starts with BEGIN:VCALENDAR", lines[0] == "BEGIN:VCALENDAR", lines[0])
    check("ends with END:VCALENDAR", lines[-1] == "END:VCALENDAR", lines[-1])
    for prop in ("VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"):
        check(f"has {prop}", prop in lines)
    check("has PRODID", any(l.startswith("PRODID:") for l in lines))
    check("has VTIMEZONE", "BEGIN:VTIMEZONE" in lines)
    check(
        "VTIMEZONE declares Europe/Berlin",
        "TZID:Europe/Berlin" in lines,
    )
    check(
        "VTIMEZONE has both DST arms",
        lines.count("BEGIN:DAYLIGHT") == 1 and lines.count("BEGIN:STANDARD") == 1,
    )

    # --- events --------------------------------------------------------
    events: list[dict[str, str]] = []
    cur: dict[str, str] | None = None
    in_tz = False
    for line in lines:
        if line == "BEGIN:VTIMEZONE":
            in_tz = True
        elif line == "END:VTIMEZONE":
            in_tz = False
        elif line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            events.append(cur or {})
            cur = None
        elif cur is not None and not in_tz:
            key = line.split(";", 1)[0].split(":", 1)[0]
            cur[key] = line

    check("contains at least one VEVENT", bool(events), "none found")

    uids = []
    for e in events:
        missing = REQUIRED_VEVENT - set(e)
        check(f"{e.get('UID', '?')[:44]} has required props", not missing, str(missing))
        uids.append(e.get("UID", ""))

    check("all UIDs unique (no duplicate events)", len(set(uids)) == len(uids),
          f"{len(uids) - len(set(uids))} duplicate(s)")

    # --- timing, resolved through the IANA database --------------------
    drift = []
    nonpositive = []
    offsets = set()
    durations: dict[str, float] = {}
    for e in events:
        start = parse_local(e["DTSTART"])
        end = parse_local(e["DTEND"])
        uid = e["UID"]

        # The local date written in the file must survive a UTC round trip.
        back = start.astimezone(UTC).astimezone(BERLIN)
        if back.date() != start.date() or back.hour != start.hour:
            drift.append(uid)

        if end <= start:
            nonpositive.append(uid)

        offsets.add(start.utcoffset())
        # Subtracting two datetimes that share a tzinfo instance is done
        # naively by Python, which would silently turn every duration
        # check into wall-clock arithmetic. Go through UTC explicitly.
        durations[uid] = (
            end.astimezone(UTC) - start.astimezone(UTC)
        ).total_seconds() / 3600

    check("no local date/time drifts through a UTC round trip", not drift, str(drift[:3]))
    check("every DTEND is strictly after its DTSTART", not nonpositive, str(nonpositive[:3]))
    check(
        "August events resolve to CEST (+02:00)",
        offsets == {timedelta(hours=2)},
        str(offsets),
    )

    # --- the hard cases -------------------------------------------------
    def find(day: str) -> str | None:
        return next((u for u in durations if f"-{day}-" in u), None)

    overnight = find("2026-08-23")
    if overnight:
        s = parse_local(next(e for e in events if e["UID"] == overnight)["DTSTART"])
        en = parse_local(next(e for e in events if e["UID"] == overnight)["DTEND"])
        check("overnight 23rd starts 22:00 on the 23rd", (s.hour, s.day) == (22, 23))
        check("overnight 23rd ends 06:00 on the 24th", (en.hour, en.day) == (6, 24))
        check("overnight 23rd lasts 8 h", abs(durations[overnight] - 8) < 1e-9,
              f"{durations[overnight]} h")

    boundary = find("2026-08-31")
    if boundary:
        en = parse_local(next(e for e in events if e["UID"] == boundary)["DTEND"])
        check("month-boundary night ends on 1 September",
              (en.month, en.day, en.hour) == (9, 1, 6), str(en))
        check("month-boundary night lasts 8 h",
              abs(durations[boundary] - 8) < 1e-9, f"{durations[boundary]} h")

    check("no event for an OFF day (29 Aug)", find("2026-08-29") is None)

    # --- report ---------------------------------------------------------
    width = max(len(n) for n, _, _ in checks)
    for name, ok, detail in checks:
        mark = "PASS" if ok else "FAIL"
        print(f"{mark}  {name.ljust(width)}  {detail if not ok else ''}".rstrip())
    print(f"\n{len(events)} events, {sum(1 for _, ok, _ in checks if ok)}/{len(checks)} checks passed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "validation/roster-2026-08.ics"))
