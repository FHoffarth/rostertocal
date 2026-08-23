"""Generate the two roster fixtures used for manual validation.

Outputs into this directory:
  sample-roster-text.pdf   - a real text-layer PDF (native extraction path)
  sample-roster-photo.jpg  - a SYNTHETIC photo-like scan (OCR path)

The JPEG is deliberately degraded (rotation, lighting gradient, sensor
noise, JPEG artefacts) to exercise the OCR path. It is NOT a photograph
of a real printed roster - that check still needs a real device.

Run:  python samples/make_samples.py
Needs: PyMuPDF, Pillow
"""

import math
import os
import random

import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

MONTH = "2026-08"
DAYS = 31
WEEKDAY_OF_DAY_1 = 5  # 2026-08-01 is a Saturday
WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

# Chosen so the fixture covers the interesting cases:
#   day 23 -> N   (the overnight example from the spec)
#   day 31 -> N   (overnight across the month boundary)
SHIFTS = [
    "F", "F", "S", "S", "N", "N", "OFF", "OFF", "F1", "F1",
    "S", "N", "N", "OFF", "OFF", "F", "F", "S", "S", "N",
    "OFF", "OFF", "N", "F1", "F1", "S", "N", "OFF", "OFF", "F",
    "N",
]
assert len(SHIFTS) == DAYS

OTHER_ROWS = [
    ("Baumann, K.", ["S", "S", "N", "OFF", "OFF", "F", "F", "F1", "S", "N",
                     "N", "OFF", "OFF", "F", "S", "S", "N", "OFF", "OFF", "F",
                     "F1", "F1", "S", "N", "N", "OFF", "OFF", "F", "S", "S", "F"]),
    ("Okonkwo, A.", ["N", "OFF", "OFF", "F", "F1", "S", "S", "N", "OFF", "OFF",
                     "F", "F", "S", "N", "N", "OFF", "OFF", "F1", "S", "S",
                     "N", "N", "OFF", "OFF", "F", "F", "S", "N", "F", "F1", "OFF"]),
]
ME = "Hoffarth, F."


def weekday(day: int) -> str:
    return WEEKDAYS[(WEEKDAY_OF_DAY_1 + day - 1) % 7]


# --------------------------------------------------------------------
# text PDF
# --------------------------------------------------------------------

def make_pdf(path: str) -> None:
    page_w, page_h = 842, 595  # A4 landscape
    doc = fitz.open()
    page = doc.new_page(width=page_w, height=page_h)

    left, top = 110, 90
    col_w = (page_w - left - 30) / DAYS
    row_h = 26

    page.insert_text((40, 50), f"Dienstplan {MONTH}  -  Station 3B", fontsize=13)

    def centered(text, cx, y, size):
        """Centre a token in its column, shrinking it if it would overflow."""
        while size > 4 and fitz.get_text_length(text, fontsize=size) > col_w - 2:
            size -= 0.5
        w = fitz.get_text_length(text, fontsize=size)
        page.insert_text((cx - w / 2, y), text, fontsize=size)

    # header: weekday over day number
    for d in range(1, DAYS + 1):
        cx = left + col_w * (d - 0.5)
        centered(weekday(d), cx, top - 14, 6.5)
        centered(str(d), cx, top, 9)

    rows = [(OTHER_ROWS[0][0], OTHER_ROWS[0][1]), (ME, SHIFTS), (OTHER_ROWS[1][0], OTHER_ROWS[1][1])]
    for i, (name, codes) in enumerate(rows):
        y = top + row_h * (i + 1)
        page.insert_text((40, y), name, fontsize=8.5)
        for d, code in enumerate(codes, start=1):
            centered(code, left + col_w * (d - 0.5), y, 8)

    # grid lines
    for i in range(len(rows) + 2):
        y = top + row_h * i - row_h * 0.55
        page.draw_line(fitz.Point(35, y), fitz.Point(page_w - 25, y), width=0.4)
    for d in range(DAYS + 1):
        x = left + col_w * d
        page.draw_line(
            fitz.Point(x, top - row_h * 0.55),
            fitz.Point(x, top + row_h * (len(rows) + 1) - row_h * 0.55),
            width=0.3,
        )

    doc.save(path)
    doc.close()


# --------------------------------------------------------------------
# synthetic photo
# --------------------------------------------------------------------

def _font(size: int):
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_photo(path: str) -> None:
    W, H = 2400, 900
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    left, top = 300, 250
    col_w = (W - left - 80) / DAYS
    row_h = 90

    d.text((60, 90), f"Dienstplan {MONTH}  -  Station 3B", font=_font(44), fill="black")

    def centered(text, cx, y, size, fill="black"):
        """Centre a token in its column, shrinking it if it would overflow."""
        f = _font(size)
        while size > 12 and d.textlength(text, font=f) > col_w - 8:
            size -= 2
            f = _font(size)
        d.text((cx - d.textlength(text, font=f) / 2, y), text, font=f, fill=fill)

    for day in range(1, DAYS + 1):
        cx = left + col_w * (day - 0.5)
        centered(weekday(day), cx, top - 96, 28, (70, 70, 70))
        centered(str(day), cx, top - 52, 38)

    rows = [(OTHER_ROWS[0][0], OTHER_ROWS[0][1]), (ME, SHIFTS), (OTHER_ROWS[1][0], OTHER_ROWS[1][1])]
    for i, (name, codes) in enumerate(rows):
        y = top + row_h * i
        d.text((60, y + 18), name, font=_font(34), fill="black")
        for day, code in enumerate(codes, start=1):
            centered(code, left + col_w * (day - 0.5), y + 16, 40)

    for i in range(len(rows) + 1):
        y = top + row_h * i - 8
        d.line([(50, y), (W - 50, y)], fill=(120, 120, 120), width=3)
    d.line([(50, top - 130), (W - 50, top - 130)], fill=(120, 120, 120), width=3)
    for day in range(DAYS + 1):
        x = left + col_w * day
        d.line([(x, top - 130), (x, top + row_h * len(rows) - 8)], fill=(150, 150, 150), width=2)

    # --- degrade it like a hand-held phone shot -----------------------
    random.seed(7)
    img = img.rotate(-1.4, resample=Image.BICUBIC, expand=True, fillcolor="white")
    img = img.filter(ImageFilter.GaussianBlur(0.7))

    # uneven lighting: bright top-left falling off to the right
    w, h = img.size
    grad = Image.new("L", (w, h))
    gd = grad.load()
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            v = 255 - int(58 * (x / w) + 30 * math.sin(y / h * math.pi))
            for yy in range(y, min(y + 4, h)):
                for xx in range(x, min(x + 4, w)):
                    gd[xx, yy] = max(0, min(255, v))
    img = Image.composite(img, Image.new("RGB", (w, h), (30, 30, 30)), grad)

    px = img.load()
    for _ in range(w * h // 40):
        x = random.randrange(w)
        y = random.randrange(h)
        n = random.randint(-26, 26)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))

    img.save(path, "JPEG", quality=72)


if __name__ == "__main__":
    pdf = os.path.join(HERE, "sample-roster-text.pdf")
    jpg = os.path.join(HERE, "sample-roster-photo.jpg")
    make_pdf(pdf)
    make_photo(jpg)
    for p in (pdf, jpg):
        print(f"{os.path.basename(p)}  {os.path.getsize(p) / 1024:.0f} KB")
    print(f"expected employee row ({ME}): {' '.join(SHIFTS)}")
