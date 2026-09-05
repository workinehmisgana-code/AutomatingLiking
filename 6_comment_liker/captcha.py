#!/usr/bin/env python3
"""
Solve TikTok's rotation captcha through a solving API.

WHY NOT COMPUTE IT HERE
The earlier version worked the angle out locally by correlating the pixels
either side of the seam. The maths was right — it read discs rotated by known
angles to within 0.0 degrees — and it still failed on TikTok's widget, because
that widget is not the puzzle the method assumes. TikTok sends TWO images, an
outer annulus and an inner disc, and correlating every radius of one against
every radius of the other found nothing above 3 sd on live samples. There is no
ring correspondence to find, so no amount of tuning would have fixed it.

WHAT REPLACED IT
Those same two images are exactly what a solving service wants, so they are
lifted out of the DOM — they are data: URIs, already base64 — and the answer
comes back as a number.

TWO SERVICES, TWO REQUEST SHAPES. They advertise each other as drop-in
compatible; that is true of their browser extensions and NOT of the REST API:

  EulerStream  POST https://tiktok.eulerstream.com/tiktok/captchas/whirl
               multipart/form-data, outerImage + innerImage as BINARY FILES,
               key in an x-api-key header, answer nested under `response`.
  SadCaptcha   POST https://www.sadcaptcha.com/api/v1/rotate
               JSON, outerImageB64 + innerImageB64 as base64 strings,
               key in ?licenseKey=, answer at the top level.

A key beginning "euler" is routed to EulerStream whatever CAPTCHA_API_URL says —
posting one to SadCaptcha returns "licenseKey is invalid", which reads like a bad
key rather than the wrong address and is a miserable thing to debug.

TWO TRIES, THEN A PERSON
A captcha that survives two attempts is not going to fall to a third: either the
service is wrong about this puzzle or it is not the puzzle we think it is.
Rather than burn solves and look increasingly like a bot, it stops and hands over
to you — like.py raises a Windows notification and repeats a sound until the
slider is dragged (see notify.py).

Configure in .env, here or in ../3_dashboard/.env:

    CAPTCHA_API_KEY=...
    CAPTCHA_API_URL=...      # optional; inferred from the key when it can be
"""
import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DUMP = HERE / "captcha-dump"

# Attempts before a person is asked. Deliberately small — see the module note.
MAX_ATTEMPTS = 2

# How long to wait on the solving service before giving up on one attempt.
API_TIMEOUT_S = 20

# Whichever service the key belongs to. EulerStream calls this captcha "whirl";
# SadCaptcha calls it "rotate". They are the same puzzle and the same two images,
# but the REQUEST SHAPES differ — see solve_rotate.
EULER_URL = "https://tiktok.eulerstream.com/tiktok/captchas/whirl"
SADCAPTCHA_URL = "https://www.sadcaptcha.com/api/v1/rotate"
DEFAULT_API_URL = SADCAPTCHA_URL

# The puzzle images. Both carry alt="Captcha"; the outer one is the larger.
IMG_SELECTORS = [
    "img[alt='Captcha']",
    "[class*='captcha' i] img",
    "[id*='captcha' i] img",
]
# The draggable handle.
SLIDER_SELECTORS = [
    "[class*='secsdk-captcha-drag-icon']",
    "[class*='captcha_verify_slide'] [class*='drag']",
    "[class*='drag-icon']",
    "[class*='sc-drag']",
]
# The track it slides along.
TRACK_SELECTORS = [
    "[class*='captcha_verify_slide--slidebar']",
    "[class*='secsdk-captcha-drag-wrapper']",
    "[class*='slidebar']",
]
REFRESH_SELECTORS = [
    "[class*='secsdk_captcha_refresh']",
    "[class*='refresh']",
    "#captcha_refresh_button",
]

# How the widget names itself. Only a rotation is worth sending to the rotate
# endpoint; the jigsaw and pick-the-shapes ones are different problems.
ROTATE_WORDS = ("fit the puzzle", "rotate", "drag the slider")
OTHER_WORDS = ("select the", "click on", "in order", "objects", "shapes", "same shape")


def _load_env() -> dict:
    """Read .env here, falling back to the dashboard's, so the key lives once.

    Deliberately NOT imported from like.py: like.py imports this module, and a
    top-level import back would be a cycle that works when like.py is the entry
    point and breaks every other script.
    """
    out: dict = {}
    for path in (HERE / ".env", HERE.parent / "3_dashboard" / ".env"):
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out.setdefault(k.strip(), v.strip().strip("'\""))
        except Exception:  # noqa: BLE001
            continue
    return out


def api_config() -> tuple[str, str]:
    """(url, key). An empty key means no solving service is configured.

    A EulerStream key posted to SadCaptcha comes back "licenseKey is invalid",
    which reads like a bad key rather than the wrong address — so a key that
    announces itself is routed to its own service whatever the URL says.
    """
    env = _load_env()
    key = os.environ.get("CAPTCHA_API_KEY") or env.get("CAPTCHA_API_KEY", "")
    url = os.environ.get("CAPTCHA_API_URL") or env.get("CAPTCHA_API_URL", "") or DEFAULT_API_URL
    if key.startswith("euler") and "eulerstream" not in url:
        url = EULER_URL
    return url, key


def _frames(page):
    """The main page first, then any iframe.

    TikTok sometimes renders the widget inside an iframe, where every query
    against the page finds nothing at all while the captcha is plainly on screen.
    """
    try:
        return [page.main_frame] + [f for f in page.frames if f is not page.main_frame]
    except Exception:  # noqa: BLE001
        return [page]


def _first(scope, selectors):
    """First element that exists AND has a size.

    Hidden matches are worse than no match: they take the place of the real one
    and the drag goes nowhere.
    """
    for sel in selectors:
        try:
            for el in scope.query_selector_all(sel):
                box = el.bounding_box()
                if box and box["width"] > 4 and box["height"] > 4:
                    return el, box
        except Exception:  # noqa: BLE001
            continue
    return None, None


def _images(scope):
    """The two puzzle images as (outer_b64, inner_b64), largest first.

    Read from the img src rather than screenshotted. They arrive as data: URIs
    which are already base64, so this is the picture TikTok sent rather than a
    rendering of it — no scaling, no compositing, no guessing where the disc sits
    inside the box.
    """
    try:
        srcs = scope.evaluate(
            """(sels) => {
                const out = []
                const seen = new Set()
                for (const s of sels) {
                    for (const im of document.querySelectorAll(s)) {
                        const src = im.src || ''
                        if (!src.startsWith('data:image') || seen.has(src)) continue
                        const r = im.getBoundingClientRect()
                        if (r.width < 20) continue
                        seen.add(src)
                        out.push({ src, w: im.naturalWidth || r.width })
                    }
                }
                return out.sort((a, b) => b.w - a.w).map((x) => x.src)
            }""",
            IMG_SELECTORS,
        )
    except Exception:  # noqa: BLE001
        return None, None
    if not srcs or len(srcs) < 2:
        return None, None
    # Strip "data:image/webp;base64," — the API wants the payload only.
    return (srcs[0].split(",", 1)[-1], srcs[1].split(",", 1)[-1])


def find_widget(page, timeout_ms: int = 9000):
    """Locate the puzzle, waiting for it to render.

    The overlay appears before its contents, so a single look taken the moment a
    captcha is detected finds an empty box.
    """
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        for scope in _frames(page):
            handle, handle_box = _first(scope, SLIDER_SELECTORS)
            if not handle:
                continue
            outer, inner = _images(scope)
            if outer and inner:
                _, track_box = _first(scope, TRACK_SELECTORS)
                _, img_box = _first(scope, IMG_SELECTORS)
                return {
                    "scope": scope,
                    "outer": outer,
                    "inner": inner,
                    "handle_box": handle_box,
                    "track_box": track_box,
                    "img_box": img_box,
                }
        page.wait_for_timeout(400)
    return None


def instruction(page) -> str:
    """The words on the widget, lowercased. Empty when it says nothing."""
    for scope in _frames(page):
        try:
            txt = scope.evaluate(
                """() => {
                    const el = document.querySelector('[class*="captcha" i]') || document.body
                    return el ? (el.innerText || '').slice(0, 400) : ''
                }"""
            )
            if txt and txt.strip():
                return " ".join(txt.split()).lower()
        except Exception:  # noqa: BLE001
            continue
    return ""


def kind(page) -> str:
    """'rotate', 'other' or 'unknown'. Only 'rotate' fits the rotate endpoint."""
    text = instruction(page)
    if any(w in text for w in ROTATE_WORDS):
        return "rotate"
    if any(w in text for w in OTHER_WORDS):
        return "other"
    return "unknown"


def present(page) -> bool:
    """Is a captcha on screen right now?"""
    for scope in _frames(page):
        try:
            if scope.evaluate(
                """() => {
                    const sel = ['#captcha-verify-image', '[class*="captcha" i]',
                                 '[id*="captcha" i]', '[class*="secsdk-captcha" i]']
                    for (const s of sel) {
                        const el = document.querySelector(s)
                        if (!el) continue
                        const r = el.getBoundingClientRect()
                        if (r.width > 0 && r.height > 0) return true
                    }
                    return false
                }"""
            ):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def _multipart(fields: dict[str, bytes]) -> tuple[bytes, str]:
    """A multipart/form-data body carrying image FILES.

    Hand-rolled to keep this module on the standard library — the whole liker
    runs on urllib, and one endpoint is not worth a dependency.
    """
    boundary = "----captcha" + str(random.randint(10**12, 10**13))
    out = bytearray()
    for name, blob in fields.items():
        out += f"--{boundary}\r\n".encode()
        out += (
            f'Content-Disposition: form-data; name="{name}"; filename="{name}.png"\r\n'
            f"Content-Type: image/png\r\n\r\n"
        ).encode()
        out += blob
        out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def _angle_in(data) -> float | None:
    """Find the angle wherever the service chose to put it.

    EulerStream nests the answer under `response`; SadCaptcha returns it flat.
    Rather than branch on the service twice, look in both and take the first
    number that could be an angle.
    """
    for scope in (data, (data or {}).get("response") if isinstance(data, dict) else None):
        if not isinstance(scope, dict):
            continue
        for field in ("angle", "rotate", "rotation", "degrees", "answer"):
            v = scope.get(field)
            try:
                if v is not None:
                    return float(v)
            except (TypeError, ValueError):
                continue
    return None


def solve_rotate(outer_b64: str, inner_b64: str) -> float | None:
    """Ask the service how far the disc is turned. Degrees, or None.

    Two services, two request shapes, chosen by the configured URL:

      * EulerStream  POST multipart/form-data, the images as BINARY FILES
                     (outerImage / innerImage), key in an x-api-key header.
      * SadCaptcha   POST JSON, the images as base64 strings
                     (outerImageB64 / innerImageB64), key in ?licenseKey=.

    They advertise each other as drop-in compatible, which is true of their
    browser extensions and not of the REST API — sending SadCaptcha's JSON to
    EulerStream gets nothing back.

    None on any failure: no key, no network, a refused key, a reply with no
    number in it. The caller treats that as "could not solve", which ends in a
    person being asked rather than in a blind drag.
    """
    url, key = api_config()
    if not key:
        return None

    euler = "eulerstream" in url
    if euler:
        import base64 as _b64

        # Decoding can throw on a truncated src. Everything else here returns
        # None so the run hands over to a person; an exception escaping from
        # this one spot would break that contract.
        #
        # The SIZE check is the one that matters. b64decode with validate=False
        # silently drops anything outside the alphabet, so junk decodes to a few
        # bytes — or none — without complaint, and the request then posts empty
        # files and spends a solve on nothing. A PNG header alone is 8 bytes; a
        # real puzzle is a couple of kilobytes.
        try:
            outer_raw = _b64.b64decode(outer_b64, validate=False)
            inner_raw = _b64.b64decode(inner_b64, validate=False)
        except Exception as e:  # noqa: BLE001
            print(f"     captcha images were not readable: {str(e)[:70]}")
            return None
        if len(outer_raw) < 64 or len(inner_raw) < 64:
            print(
                f"     captcha images came out empty "
                f"({len(outer_raw)}b / {len(inner_raw)}b) — not sending them"
            )
            return None
        body, content_type = _multipart({"outerImage": outer_raw, "innerImage": inner_raw})
        full = url
    else:
        body = json.dumps({"outerImageB64": outer_b64, "innerImageB64": inner_b64}).encode()
        content_type = "application/json"
        full = url.replace("{key}", key) if "{key}" in url else (
            url + ("&" if "?" in url else "?") + "licenseKey=" + key
        )

    req = urllib.request.Request(
        full,
        data=body,
        headers={
            "Content-Type": content_type,
            # Both services accept the key this way; SadCaptcha also wants it in
            # the query string, which is added above.
            "x-api-key": key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:160]
        print(f"     solver API HTTP {e.code}: {detail}")
        return None
    except Exception as e:  # noqa: BLE001
        print(f"     solver API unreachable: {str(e)[:70]}")
        return None

    angle = _angle_in(data)
    if angle is None:
        print(f"     solver API returned no angle: {str(data)[:140]}")
    return angle


def _glide(page, x_from: float, x_to: float, y: float, steps: int = 0) -> None:
    """Drag the held handle, the way a hand does it.

    Eased and jittered on purpose: a constant-velocity drag across the track in
    three frames is a stronger bot signal than the captcha itself.
    """
    dist = x_to - x_from
    steps = steps or max(12, int(abs(dist) / 6))
    for i in range(1, steps + 1):
        t = i / steps
        eased = 1 - pow(1 - t, 3)  # fast at first, settling at the end
        page.mouse.move(
            x_from + dist * eased + random.uniform(-0.6, 0.6),
            y + random.uniform(-1.0, 1.0),
        )
        time.sleep(random.uniform(0.008, 0.020))


def dump(page, tag: str) -> None:
    """Keep what a failure looked like, so the next fix works from evidence."""
    try:
        DUMP.mkdir(exist_ok=True)
        stamp = time.strftime("%H%M%S")
        page.screenshot(path=str(DUMP / f"{tag}-{stamp}-page.png"))
        (DUMP / f"{tag}-{stamp}-text.txt").write_text(instruction(page), encoding="utf-8")
        for scope in _frames(page):
            outer, inner = _images(scope)
            if outer and inner:
                import base64

                (DUMP / f"{tag}-{stamp}-outer.png").write_bytes(base64.b64decode(outer))
                (DUMP / f"{tag}-{stamp}-inner.png").write_bytes(base64.b64decode(inner))
                break
    except Exception:  # noqa: BLE001
        pass


def solve(page, attempts: int = MAX_ATTEMPTS, verbose: bool = True) -> bool:
    """Clear the captcha through the solving API. True once it is gone.

    Two attempts, then False — which sends like.py to wait_out_captcha, where a
    notification and a repeating sound ask you to drag it yourself.
    """
    url, key = api_config()
    if not key:
        if verbose:
            print("     no CAPTCHA_API_KEY in .env — cannot solve, handing over")
        return False

    for attempt in range(1, max(1, attempts) + 1):
        if not present(page):
            return True

        widget = find_widget(page)
        if not widget:
            if verbose:
                print(f"    captcha {attempt}/{attempts}: puzzle did not render")
            dump(page, "norender")
            if attempt < attempts:
                _refresh(page)
            continue

        what = kind(page)
        if what == "other":
            # Not a rotation. The rotate endpoint would answer nonsense and the
            # drag would be wrong; a person is the right answer here.
            if verbose:
                print(f"    captcha is not the rotation type: {instruction(page)[:70]!r}")
            dump(page, "othertype")
            return False

        angle = solve_rotate(widget["outer"], widget["inner"])
        if angle is None:
            dump(page, "noanswer")
            if attempt < attempts:
                _refresh(page)
            continue

        hb = widget["handle_box"]
        track_w = (
            (widget["track_box"] or {}).get("width")
            or (widget["img_box"] or {}).get("width")
            or 260
        )
        usable = max(40.0, track_w - hb["width"])
        # The track spans one full turn: this is the conversion the solving
        # services publish alongside the angle, and the angle is theirs.
        distance = max(0.0, min(usable, usable * (angle % 360.0) / 360.0))
        x0 = hb["x"] + hb["width"] / 2
        y0 = hb["y"] + hb["height"] / 2

        if verbose:
            print(
                f"    captcha {attempt}/{attempts}: solver says {angle:.1f} deg -> "
                f"drag {distance:.0f}px of {usable:.0f}"
            )

        page.mouse.move(x0, y0)
        page.mouse.down()
        time.sleep(random.uniform(0.08, 0.18))
        _glide(page, x0, x0 + distance, y0)
        # Settle on the mark before letting go, as a hand does.
        time.sleep(random.uniform(0.10, 0.25))
        page.mouse.move(x0 + distance + random.uniform(-0.8, 0.8), y0 + random.uniform(-0.6, 0.6))
        time.sleep(random.uniform(0.08, 0.16))
        page.mouse.up()

        page.wait_for_timeout(2500)
        if not present(page):
            if verbose:
                print(f"    captcha solved on attempt {attempt}")
            page.wait_for_timeout(1200)
            return True

        dump(page, f"miss{attempt}")
        if attempt < attempts:
            _refresh(page)

    if verbose:
        print(f"    captcha not solved in {attempts} attempts — handing over")
    return False


def _refresh(page) -> None:
    """Ask for a different puzzle."""
    for scope in _frames(page):
        el, _ = _first(scope, REFRESH_SELECTORS)
        if el:
            try:
                el.click()
                break
            except Exception:  # noqa: BLE001
                pass
    page.wait_for_timeout(random.uniform(1200, 2000))
