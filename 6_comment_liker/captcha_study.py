#!/usr/bin/env python3
"""
Pull the two captcha images out of a dumped widget and describe them.

TikTok's rotation captcha is two pictures, not one: an outer annulus with a hole
punched in it and an inner disc that drops into the hole, both delivered as data:
URIs. Those two images are exactly what the solving API is sent, so this is the
tool for looking at what was sent when a solve comes back wrong.

    python captcha_study.py                                  # the newest dump
    python captcha_study.py captcha-dump/miss1-142131.html

captcha.py writes -outer.png and -inner.png directly now, so this is only needed
for the older dumps that captured the surrounding markup instead.
"""
import base64
import re
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

SRC = re.compile(r'<img[^>]*?src="data:image/(\w+);base64,([^"]+)"[^>]*>', re.I)
CLS = re.compile(r'class="([^"]*)"', re.I)
STYLE = re.compile(r'style="([^"]*)"', re.I)


def main() -> int:
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
    else:
        dumps = sorted(Path("captcha-dump").glob("*.html"))
        if not dumps:
            print("No dumped markup. captcha.py writes -outer.png / -inner.png directly;")
            print("look in captcha-dump/ for those instead.")
            return 1
        path = dumps[-1]

    html = path.read_text(encoding="utf-8", errors="replace")
    tags = list(SRC.finditer(html))
    print(f"{path.name}: {len(tags)} embedded image(s)\n")

    out = []
    for i, m in enumerate(tags):
        raw = base64.b64decode(m.group(2))
        img = Image.open(BytesIO(raw)).convert("RGB")
        tag = m.group(0)
        cls = (CLS.search(tag).group(1) if CLS.search(tag) else "")[:70]
        sty = (STYLE.search(tag).group(1) if STYLE.search(tag) else "")[:90]
        name = path.with_name(f"{path.stem}-img{i}.png")
        img.save(name)
        print(f"  [{i}] {img.size[0]}x{img.size[1]} {m.group(1)}  {len(raw) / 1024:.0f} KB")
        print(f"      class: {cls}")
        print(f"      style: {sty}")
        print(f"      -> {name.name}")
        out.append(img)

    if len(out) >= 2:
        print(
            f"\nouter {out[0].size[0]}px, inner {out[1].size[0]}px — the larger is the ring,"
            "\nthe smaller the disc. These go to the solving API as outerImageB64 and"
            "\ninnerImageB64, in that order."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
