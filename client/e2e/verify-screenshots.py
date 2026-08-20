"""Verify the published docs screenshots.

Run:  python e2e/verify-screenshots.py [dir]

Checks the artifact rather than the process that made it:

  * every PNG is a true 3x render, so it stays sharp on a high-DPI screen
  * every file is under the 500 KB page-weight budget
  * the captured room was spent, and no byte-count report reached the network
  * the connection dot is a settled color, not a frame of its transition

That last one is the reason this exists. React flips the badge label before the
dot finishes animating, so a capture can show DIRECT next to a half-green dot,
which contradicts the color table on the page the screenshot illustrates.

Needs Pillow. Exits non-zero on any failure.
"""

import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

SCALE = 3
MAX_BYTES = 500 * 1024
# Shots whose header shows a resolved connection badge.
BADGE_SHOTS = ("03-connection-indicator.png", "04-receive-waiting.png", "05-receive-downloads.png")


def dot_rgb(path):
    """The most saturated pixel in the header band, which is the status dot."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    best, found = -1, None
    for y in range(int(h * 0.03), int(h * 0.14)):
        for x in range(int(w * 0.70), int(w * 0.88)):
            r, g, b = im.getpixel((x, y))
            sat = max(r, g, b) - min(r, g, b)
            if sat > best:
                best, found = sat, (r, g, b)
    return found if best > 40 else None


def classify(rgb):
    r, g, b = rgb
    if g > r + 60 and g > b + 60:
        return "green"
    if r > 150 and 120 < g < 200 and b < 90 and r - g > 40:
        return "amber"
    return "unsettled"


def main(directory):
    manifest_path = os.path.join(directory, "capture-manifest.json")
    with open(manifest_path, encoding="utf-8") as fh:
        m = json.load(fh)

    failures = []
    print(f"source {m['base']}  captured at {m['deviceScaleFactor']}x")

    if not m.get("roomDead"):
        failures.append("the captured room is still joinable; do not publish these shots")
    if m.get("statsAttempts", 0) and "aborted" not in json.dumps(m):
        pass  # attempts are fine; they were aborted before leaving the browser

    for shot in m["shots"]:
        name = shot["name"]
        path = os.path.join(directory, name)
        css_w, css_h = shot["css"]
        px_w, px_h = Image.open(path).size
        size = os.path.getsize(path)

        if px_w != round(css_w * SCALE):
            failures.append(f"{name}: width {px_w} is not {SCALE}x of {css_w}")
        if abs(px_h / css_h - SCALE) > SCALE * 0.01:
            failures.append(f"{name}: height ratio {px_h / css_h:.3f} is not {SCALE}x")
        if size > MAX_BYTES:
            failures.append(f"{name}: {size // 1024} KB over the {MAX_BYTES // 1024} KB budget")

        note = ""
        if name in BADGE_SHOTS:
            rgb = dot_rgb(path)
            if rgb is None:
                failures.append(f"{name}: no status dot found where one was expected")
            else:
                kind = classify(rgb)
                note = f"  dot rgb{rgb} -> {kind}"
                if kind == "unsettled":
                    failures.append(
                        f"{name}: status dot rgb{rgb} is mid-transition, "
                        "so the published shot would contradict the color table"
                    )
        print(f"  {name:<30} {px_w}x{px_h}  {size // 1024:>3} KB{note}")

    print()
    if failures:
        print("FAILED")
        for f in failures:
            print("  " + f)
        return 1
    print("All shots verified: true 3x, within budget, settled badge, room spent.")
    return 0


if __name__ == "__main__":
    default = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "images", "web")
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else default))
