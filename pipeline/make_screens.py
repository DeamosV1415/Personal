r"""Prepare product screenshots for the work section.

    .venv\Scripts\python.exe pipeline\make_screens.py

Reads photos/screens/screen_<name>.png and writes, into site/img/:

    work-<name>-tone.webp    greyscale, contrast set, page background lifted
                             to white. The page dithers this in the browser at
                             the screen's real pixel size.
    work-<name>.png          the same, dithered here to 1-bit. Shown before
                             the script runs, and if it never does.
    work-<name>-color.webp   the real screenshot, revealed on hover.

Why dither in the browser too: a dithered image only stays crisp when its
pixels land on whole device pixels. At 125% or 150% Windows scaling a
pre-dithered PNG lands between them and turns into moire.
"""

from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "photos" / "screens"
OUT = ROOT / "site" / "img"
SIZE = (520, 325)  # CSS size of the card image, 16:10 like the captures

# Dark sites dither into a slab of black that outweighs everything around it
# on a white page; inverting them keeps every card the same weight.
INVERT = {"agentinflow", "gitnomad"}
# Page backgrounds are near-white greys, and dithering a flat grey fills it
# with dots. Everything at or above the cutoff becomes pure white, so only
# real content (type, images, UI) carries a pattern.
WHITE_AT = 205
# GitNomad's phone mockup is only a shade darker than its page; at the
# default cutoff both go white and the phone vanishes into a few specks.
WHITE_AT_FOR = {"gitnomad": 236}


def tone(src: Image.Image, name: str, size: tuple[int, int]) -> Image.Image:
    img = ImageOps.grayscale(src)
    if name in INVERT:
        img = ImageOps.invert(img)
    img = img.resize(size, Image.LANCZOS)
    img = ImageOps.autocontrast(img, cutoff=1)
    img = ImageEnhance.Contrast(img).enhance(1.15)
    cut = WHITE_AT_FOR.get(name, WHITE_AT)
    return img.point(lambda v: 255 if v >= cut else round(v * 255 / cut))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    double = (SIZE[0] * 2, SIZE[1] * 2)
    for path in sorted(SRC.glob("screen_*.png")):
        name = path.stem.removeprefix("screen_")
        src = Image.open(path).convert("RGB")
        src.resize(double, Image.LANCZOS).save(OUT / f"work-{name}-color.webp", quality=82, method=6)
        tone(src, name, double).save(OUT / f"work-{name}-tone.webp", quality=88, method=6)
        tone(src, name, SIZE).convert("1", dither=Image.Dither.FLOYDSTEINBERG).save(
            OUT / f"work-{name}.png", optimize=True
        )
        print(name, "ok")


if __name__ == "__main__":
    main()
