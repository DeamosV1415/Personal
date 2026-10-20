r"""Draw the 1200x630 link preview (site/og.png) from the portrait data.

    .venv\Scripts\python.exe pipeline\make_og.py

Run it after make_ascii.py, so the preview shows the current portrait.
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "pipeline" / "fonts"
INK, MUTED = (11, 11, 11), (102, 102, 102)
W, H = 1200, 630
PORTRAIT_BOX = (600, 560)  # the portrait fits inside this, on the right


def font(weight: int, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / f"JetBrainsMono-{weight}.ttf"), size)


def main() -> None:
    raw = (ROOT / "site" / "js" / "portrait-data.js").read_text(encoding="utf-8")
    data = json.loads(raw[raw.index("{") : raw.rindex("}") + 1])
    rows = data["medium"]["tone"]

    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    # Portrait: one line per row, sized so the grid fits the box.
    cols, n = len(rows[0]), len(rows)
    size = min(PORTRAIT_BOX[0] / (cols * 0.6), PORTRAIT_BOX[1] / n)
    f = font(800, max(4, round(size)))
    left = W - 40 - cols * 0.6 * size
    top = (H - n * size) / 2
    for i, row in enumerate(rows):
        d.text((left, top + i * size), row, font=f, fill=INK)

    d.text((64, 150), "hello, world. I'm", font=font(400, 26), fill=MUTED)
    d.text((60, 192), "Chinmay", font=font(800, 92), fill=INK)
    d.text((60, 284), "Bhadoria", font=font(800, 92), fill=INK)
    d.text((64, 410), "Co-founder, Zextiria AI", font=font(800, 28), fill=INK)
    d.text((64, 540), "deamosV: ~$ _", font=font(400, 22), fill=MUTED)

    out = ROOT / "site" / "og.png"
    img.save(out, optimize=True)
    print(out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
