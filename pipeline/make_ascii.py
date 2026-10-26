r"""Turn ONE photo into ASCII, for the explainer page in prototype/.

The home page portrait is built by make_portrait.py from the whole shoot; this
script only feeds prototype/ and lends make_portrait.py its helpers.

    .venv\Scripts\python.exe pipeline\make_ascii.py photos\raw\mountains.jpg

--model picks the background remover. u2netp is 4.7 MB and fine at character
resolution; u2net_human_seg (176 MB) cuts hair more cleanly for final shots.

Writes, into prototype/:
    stages/01_original.jpg   the photo as given
    stages/02_cutout.png     background removed, on white
    stages/03_tone.png       cropped to head and shoulders, greyscale, contrast lifted
    portrait.js              window.PORTRAIT = { coarse|medium|fine: { tone, edges } }

The page reads the data as a plain script so it also works opened straight from disk.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from rembg import new_session, remove
from scipy import ndimage

# Lightest to darkest. Short on purpose: long ramps put letters into skin and
# read as noise rather than shading.
RAMP = " .,:;-=+*#%@"

# A monospace cell is about 0.6 as wide as it is tall at line-height 1.
CELL_ASPECT = 0.6

DENSITIES = {"coarse": 80, "medium": 120, "fine": 160}


def cut_out(img: Image.Image, model: str) -> Image.Image:
    session = new_session(model)
    return remove(img, session=session, post_process_mask=True)


def crop_head_and_shoulders(rgba: Image.Image, bottom_ratio: float) -> Image.Image:
    """Top of the hair down to `bottom_ratio` x the subject's width."""
    alpha = np.asarray(rgba.getchannel("A")) > 128
    ys, xs = np.nonzero(alpha)
    top, left, right = ys.min(), xs.min(), xs.max()
    width = right - left
    pad = int(width * 0.04)
    box = (
        max(left - pad, 0),
        max(top - pad, 0),
        min(right + pad, rgba.width),
        min(top + int(width * bottom_ratio), rgba.height),
    )
    return rgba.crop(box)


def tone(rgba: Image.Image, contrast: float) -> tuple[np.ndarray, np.ndarray]:
    """Greyscale in 0..1 (1 = white) with contrast stretched inside the subject only."""
    alpha = rgba.getchannel("A")
    grey = ImageOps.grayscale(rgba.convert("RGB"))
    # Equalise using the subject's own histogram, so the sky that was removed
    # does not decide how dark the face gets. Blend back half way: full
    # equalisation turns skin into blotches.
    eq = ImageOps.equalize(grey, mask=alpha.point(lambda a: 255 if a > 128 else 0))
    mixed = Image.blend(grey, eq, 0.55)
    lum = np.asarray(mixed, dtype=np.float32) / 255.0
    lum = s_curve(lum, contrast)
    a = np.asarray(alpha, dtype=np.float32) / 255.0
    return lum * a + (1.0 - a), a


def s_curve(lum: np.ndarray, k: float) -> np.ndarray:
    """Push mid-greys apart. Characters have about ten useful levels, and a
    mid-grey jacket next to mid-grey skin spends them all on fuzz; this sends
    light cloth towards white and shadow towards solid, so the face separates."""
    if k <= 0:
        return lum
    s = 1.0 / (1.0 + np.exp(-k * (lum - 0.5)))
    lo, hi = 1.0 / (1.0 + np.exp(k * 0.5)), 1.0 / (1.0 + np.exp(-k * 0.5))
    return (s - lo) / (hi - lo)


def to_cells(lum: np.ndarray, alpha: np.ndarray, cols: int) -> tuple[np.ndarray, np.ndarray, int]:
    h, w = lum.shape
    rows = max(1, round(cols * (h / w) * CELL_ASPECT))
    small = np.asarray(
        Image.fromarray((lum * 255).astype(np.uint8)).resize((cols, rows), Image.BOX),
        dtype=np.float32,
    ) / 255.0
    cover = np.asarray(
        Image.fromarray((alpha * 255).astype(np.uint8)).resize((cols, rows), Image.BOX),
        dtype=np.float32,
    ) / 255.0
    return small, cover, rows


def tone_rows(small: np.ndarray, cover: np.ndarray) -> list[str]:
    dark = np.clip(1.0 - small, 0, 1) ** 0.9
    idx = np.round(dark * (len(RAMP) - 1)).astype(int)
    # A white t-shirt is still the person: keep at least the faintest mark
    # inside the silhouette so it never opens a hole in the outline.
    idx = np.where(cover > 0.5, np.maximum(idx, 1), 0)
    return ["".join(RAMP[i] for i in row) for row in idx]


def edge_rows(lum: np.ndarray, alpha: np.ndarray, base: list[str], cols: int, rows: int) -> list[str]:
    """Overlay | / - \\ where the photo has a strong edge, oriented along it.

    Difference of Gaussians finds edges at a scale a character can show;
    Sobel gives their direction. Each cell takes the most common direction
    among its edge pixels, and only if enough of the cell is edge.
    """
    src = lum * alpha + (1 - alpha)  # outline counts as an edge too
    h, w = src.shape
    # Blur at the scale of a character, so cloth texture finer than one cell
    # never registers as an edge.
    sigma = 0.45 * w / cols
    blurred = ndimage.gaussian_filter(src, sigma)
    dog = np.abs(blurred - ndimage.gaussian_filter(src, sigma * 1.6))
    # Threshold against the subject only; the empty white background would
    # otherwise drag the percentile down and let everything through.
    inside = alpha > 0.05
    edge = dog > np.percentile(dog[inside], 93)
    gx = ndimage.sobel(blurred, axis=1)
    gy = ndimage.sobel(blurred, axis=0)
    # Gradient angle mod 180; the edge runs perpendicular to it.
    ang = (np.degrees(np.arctan2(gy, gx)) + 180.0) % 180.0
    bucket = np.select(
        [(ang < 22.5) | (ang >= 157.5), ang < 67.5, ang < 112.5],
        [0, 1, 2],
        default=3,
    )
    glyph = {0: "|", 1: "\\", 2: "_", 3: "/"}

    out = [list(r) for r in base]
    for r in range(rows):
        y0, y1 = int(r * h / rows), int((r + 1) * h / rows)
        for c in range(cols):
            x0, x1 = int(c * w / cols), int((c + 1) * w / cols)
            cell = edge[y0:y1, x0:x1]
            if cell.mean() < 0.3:
                continue
            counts = np.bincount(bucket[y0:y1, x0:x1][cell], minlength=4)
            out[r][c] = glyph[int(counts.argmax())]
    return ["".join(r) for r in out]


def preview(rows: list[str], path: Path) -> None:
    """Rasterise rows with Consolas so the result can be checked without a browser."""
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 12)
    cw, ch = 7, 12
    img = Image.new("L", (cw * len(rows[0]) + 20, ch * len(rows) + 20), 255)
    d = ImageDraw.Draw(img)
    for i, row in enumerate(rows):
        d.text((10, 10 + i * ch), row, fill=0, font=font)
    img.save(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("photo", type=Path)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "prototype")
    ap.add_argument("--bottom", type=float, default=1.0, help="crop height as a multiple of subject width")
    ap.add_argument("--model", default="u2netp")
    ap.add_argument("--contrast", type=float, default=7.0, help="S-curve strength; 0 turns it off")
    args = ap.parse_args()

    stages = args.out / "stages"
    stages.mkdir(parents=True, exist_ok=True)

    original = ImageOps.exif_transpose(Image.open(args.photo)).convert("RGB")
    thumb = original.copy()
    thumb.thumbnail((900, 900))
    thumb.save(stages / "01_original.jpg", quality=86)

    rgba = cut_out(original, args.model)
    on_white = Image.new("RGB", rgba.size, "white")
    on_white.paste(rgba, mask=rgba.getchannel("A"))
    on_white.thumbnail((900, 900))
    on_white.save(stages / "02_cutout.png")

    crop = crop_head_and_shoulders(rgba, args.bottom)
    lum, alpha = tone(crop, args.contrast)
    Image.fromarray((lum * 255).astype(np.uint8)).save(stages / "03_tone.png")

    data = {}
    for name, cols in DENSITIES.items():
        small, cover, rows = to_cells(lum, alpha, cols)
        t = tone_rows(small, cover)
        e = edge_rows(lum, alpha, t, cols, rows)
        data[name] = {"cols": cols, "rows": rows, "tone": t, "edges": e}
        preview(t, stages / f"check_{name}_tone.png")
        preview(e, stages / f"check_{name}_edges.png")

    (args.out / "portrait.js").write_text("window.PORTRAIT = " + json.dumps(data) + ";\n", encoding="utf-8")
    print({k: (v["cols"], v["rows"]) for k, v in data.items()})


if __name__ == "__main__":
    main()
