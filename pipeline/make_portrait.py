r"""Build the home page portrait from the photo shoot.

    $env:NUMBA_CACHE_DIR = "$PWD\.numba_cache"
    .venv\Scripts\python.exe pipeline\make_portrait.py

Reads photos/raw/:
    center, top, bottom, left, right, top-left, top-right, bottom-left,
    bottom-right, eyes-closed (.jpg)   one sitting, one fixed camera
    wave, nod, startled (.mp4)         optional reactions, same sitting

Writes:
    site/js/portrait-data.js    window.PORTRAIT: every photo as a character
                                frame, at three grid densities
    site/js/portrait-clips-<density>.js
                                window.PORTRAIT_CLIPS: the reactions, frame
                                by frame; the page loads one, after it is idle
    photos/cut/                 cached cutouts (delete to recompute)
    photos/check/               previews of every frame, for checking by eye

Every frame is cut from the SAME box and toned with the SAME curve. The page
swaps frames as the cursor moves, so a box or a curve per photo would make the
portrait jump or flicker on every swap.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_ascii import CELL_ASPECT, RAMP, cut_out, preview, s_curve  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "photos" / "raw"
CUT = ROOT / "photos" / "cut"
CHECK = ROOT / "photos" / "check"

POSES = [
    "center", "top", "bottom", "left", "right",
    "top-left", "top-right", "bottom-left", "bottom-right", "eyes-closed",
]
CLIPS = ["wave", "nod", "startled"]
# Seconds of action kept from each clip, from the moment movement starts.
# The page plays it forward then backward, so it ends where it began: a
# clip that ended mid-lean snapped back to the face and read as a hang.
CLIP_FORWARD = {"wave": 1.6, "nod": 1.0, "startled": 0.7}
# Movement starts where a frame has changed this share of the clip's biggest
# change. A fixed share fires too early: a seated body drifts slowly first.
MOTION = 0.3
DENSITIES = {"coarse": 64, "medium": 96, "fine": 128}
MODEL = "u2netp"
WORK_HEIGHT = 1600   # photos are 6528 tall; a character cell never needs more
CLIP_FPS = 12

# The crop, in units of the head's width, measured on the center photo.
CROP_WIDTH = 2.7     # head plus a little shoulder on each side
CROP_ABOVE = 0.35    # room above the hair for the "top" pose
CROP_HEIGHT = 2.55   # hair to upper chest

CONTRAST = 6.0
EQUALISE = 0.6       # how far toward full histogram equalisation
DETAIL = 1.3         # local contrast; see cells()


def load(path: Path) -> Image.Image:
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    im.thumbnail((WORK_HEIGHT, WORK_HEIGHT))
    return im


def cutout(name: str, im: Image.Image) -> Image.Image:
    """Background removal is the slow step, so each result is cached."""
    CUT.mkdir(parents=True, exist_ok=True)
    cached = CUT / f"{name}.png"
    if cached.exists():
        return Image.open(cached)
    rgba = cut_out(im, MODEL)
    rgba.save(cached)
    return rgba


def head(alpha: np.ndarray) -> tuple[int, float, float]:
    """(top of hair, head centre x, head width) from a person mask.

    Walks down from the hair. The head is the widest part until the outline
    narrows into the neck; once it has narrowed, the next widening is the
    shoulders, and the walk stops. (Shoulders slope out gradually, so a
    "sudden jump in width" test never fires; the neck is the reliable mark.)
    """
    rows = np.nonzero(alpha.any(axis=1))[0]
    top = int(rows[0])
    widest, cx, narrowed = 0, 0.0, False
    for y in range(top, alpha.shape[0]):
        xs = np.nonzero(alpha[y])[0]
        if xs.size == 0:
            continue
        w = xs[-1] - xs[0]
        if not narrowed and w > widest:
            widest, cx = w, (xs[0] + xs[-1]) / 2
        if widest and w < 0.85 * widest:
            narrowed = True
        if narrowed and w > 1.2 * widest:
            break
    return top, cx, float(widest)


def crop_box(alpha: np.ndarray) -> tuple[int, int, int, int]:
    top, cx, hw = head(alpha)
    w, h = hw * CROP_WIDTH, hw * CROP_HEIGHT
    y0 = top - hw * CROP_ABOVE
    return int(cx - w / 2), int(y0), int(cx + w / 2), int(y0 + h)


def tone_curve(grey: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """A 256-entry lookup table, built once from the center photo.

    Half-way histogram equalisation over the person only (the wall does not
    get a vote), then the S-curve that pushes shirt to light and hair to dark.
    """
    hist = np.bincount(grey[mask].ravel(), minlength=256).astype(np.float64)
    cdf = np.cumsum(hist) / hist.sum()
    eq = cdf * 255.0
    lut = (1 - EQUALISE) * np.arange(256) + EQUALISE * eq
    return s_curve(lut / 255.0, CONTRAST)


def to_lum(rgba: Image.Image, box, lut) -> tuple[np.ndarray, np.ndarray]:
    """Crop to the shared box, tone with the shared curve: 0..1, 1 = white."""
    c = rgba.crop(box)  # areas outside the photo come back transparent
    grey = np.asarray(ImageOps.grayscale(c.convert("RGB")))
    a = np.asarray(c.getchannel("A"), dtype=np.float32) / 255.0
    lum = lut[grey]
    return lum * a + (1 - a), a


def cells(lum: np.ndarray, a: np.ndarray, cols: int) -> list[str]:
    h, w = lum.shape
    # Local contrast at the size of a character. An eye is about five cells
    # wide and sits in skin of nearly the same density; sharpening at this
    # scale makes eyes, brows and mouth dense marks against lighter skin.
    # Much stronger and the beard turns to noise.
    blur = ndimage.gaussian_filter(lum, 1.5 * w / cols)
    lum = np.clip(lum + DETAIL * (lum - blur), 0, 1) * a + (1 - a)
    rows = max(1, round(cols * (h / w) * CELL_ASPECT))
    small = np.asarray(Image.fromarray((lum * 255).astype(np.uint8)).resize((cols, rows), Image.BOX), dtype=np.float32) / 255
    cover = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((cols, rows), Image.BOX), dtype=np.float32) / 255
    dark = np.clip(1 - small, 0, 1) ** 0.9
    idx = np.round(dark * (len(RAMP) - 1)).astype(int)
    # Inside the person, never blank: a white shirt must not open a hole.
    idx = np.where(cover > 0.5, np.maximum(idx, 1), 0)
    return ["".join(RAMP[i] for i in row) for row in idx]


def ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    # This PC has no ffmpeg on PATH; Remotion ships one in the Rooms repo.
    bundled = ROOT.parent / "Zextiria_Multiplayer" / "video" / "node_modules" / "@remotion" / "compositor-win32-x64-msvc" / "ffmpeg.exe"
    if bundled.exists():
        return str(bundled)
    sys.exit("ffmpeg not found: install it or put it on PATH")


def clip_frames(name: str) -> list[Image.Image]:
    """Cut out every frame of a clip at CLIP_FPS, cached like the photos."""
    out = CUT / name
    if not out.exists():
        out.mkdir(parents=True)
        # `-r` rather than the fps filter: Remotion's stripped ffmpeg build
        # has no fps filter.
        try:
            subprocess.run(
                [ffmpeg(), "-v", "error", "-i", str(RAW / f"{name}.mp4"),
                 "-vf", f"scale=-2:{WORK_HEIGHT}", "-r", str(CLIP_FPS), str(out / "raw_%03d.png")],
                check=True,
            )
        except subprocess.CalledProcessError:
            shutil.rmtree(out)  # an empty cache would be read as "no frames" forever
            raise
    frames = []
    for i, src in enumerate(sorted(out.glob("raw_*.png"))):
        frames.append(cutout(f"{name}/cut_{i:03d}", Image.open(src).convert("RGB")))
    return frames


def clip_box(first: np.ndarray, photo_alpha: np.ndarray, box) -> tuple[float, float, float, float]:
    """The photo's crop box, carried into a clip's coordinates.

    The phone's video mode frames tighter than its photo mode, so the head is
    bigger in the clips. Matching the head in the clip's first frame (where
    the pose is neutral) to the head in the center photo gives the scale and
    offset that make a clip start exactly where the photo left off.
    """
    p_top, p_cx, p_w = head(photo_alpha)
    c_top, c_cx, c_w = head(first)
    s = c_w / p_w
    x0, y0, x1, y1 = box
    return (c_cx + (x0 - p_cx) * s, c_top + (y0 - p_top) * s,
            c_cx + (x1 - p_cx) * s, c_top + (y1 - p_top) * s)


def main() -> None:
    CHECK.mkdir(parents=True, exist_ok=True)
    photos = {n: cutout(n, load(RAW / f"{n}.jpg")) for n in POSES}

    center = photos["center"]
    alpha = np.asarray(center.getchannel("A")) > 128
    box = crop_box(alpha)
    size = (box[2] - box[0], box[3] - box[1])
    grey = np.asarray(ImageOps.grayscale(center.convert("RGB")))
    lut = tone_curve(grey, alpha)
    print("crop box", box, "head", head(alpha))

    toned = {n: to_lum(im, box, lut) for n, im in photos.items()}
    Image.fromarray((toned["center"][0] * 255).astype(np.uint8)).save(CHECK / "tone_center.png")

    data = {}
    for dname, cols in DENSITIES.items():
        frames = {n: cells(*toned[n], cols) for n in POSES}
        data[dname] = {"cols": cols, "rows": len(frames["center"]), "frames": frames}
        for n in ("center", "top-left", "eyes-closed"):
            preview(frames[n], CHECK / f"{dname}_{n}.png")
    print({k: (v["cols"], v["rows"]) for k, v in data.items()})

    js = ROOT / "site" / "js"
    out = js / "portrait-data.js"
    out.write_text("window.PORTRAIT = " + json.dumps({"version": 2, "fps": CLIP_FPS, "densities": data}) + ";\n", encoding="utf-8")
    print(out.name, out.stat().st_size, "bytes")

    # ---- clips ----
    clips = {d: {} for d in DENSITIES}
    for name in CLIPS:
        if not (RAW / f"{name}.mp4").exists():
            continue
        frames = clip_frames(name)
        first = np.asarray(frames[0].getchannel("A")) > 128
        cbox = clip_box(first, alpha, box)
        # Each clip gets its own curve, built from its first frame the same
        # way as the photos': video exposure differs from photo exposure, and
        # equalising each against itself brings them to the same look.
        clut = tone_curve(np.asarray(ImageOps.grayscale(frames[0].convert("RGB"))), first)
        lums = []
        for f in frames:
            aligned = f.crop(tuple(round(v) for v in cbox)).resize(size, Image.LANCZOS)
            lums.append(to_lum(aligned, (0, 0, *size), clut))
        per = {dname: [cells(*l, cols) for l in lums] for dname, cols in DENSITIES.items()}
        # Each clip opens with a second or so of sitting still. Start just
        # before the movement, keep CLIP_FORWARD seconds of it.
        ref = "".join(per["medium"][0])
        changed = ["".join(f) for f in per["medium"]]
        changed = [sum(a != b for a, b in zip(ref, f)) / len(ref) for f in changed]
        start = max(0, next((i for i, c in enumerate(changed) if c >= MOTION * max(changed)), 0) - 2)
        end = min(len(lums), start + round(CLIP_FORWARD[name] * CLIP_FPS))
        for dname in DENSITIES:
            clips[dname][name] = per[dname][start:end]
        preview(clips["fine"][name][0], CHECK / f"clip_{name}_first.png")
        preview(clips["fine"][name][-1], CHECK / f"clip_{name}_peak.png")
        print(name, f"frames {start}-{end - 1} of {len(lums)}")

    # One file per density: the page loads only the one it is drawing.
    for dname in DENSITIES:
        f = js / f"portrait-clips-{dname}.js"
        f.write_text(f"window.PORTRAIT_CLIPS = " + json.dumps(clips[dname]) + ";\n", encoding="utf-8")
        print(f.name, f.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
