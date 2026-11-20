"""Record every change on the Zefoy page, and the run's log, into one timeline.

WHY. Zefoy is a moving target: captchas, cooldowns, full-screen ads, "service
down" banners, Cloudflare checks, forms that appear and vanish. The liker only
handles the screens somebody has already seen. This records what the page
actually shows, change by change, next to what the script printed at that
moment, so every screen it can reach is on disk to be read and handled.

ON with --record (the Control Center ticks it by default). Each run writes

    zefoy-recordings/<date-time>-<pid>/
        timeline.jsonl   one line per event (sort by "t": page changes are
                         delivered when the script next touches the browser,
                         and stamped with the page's own clock):
                           log      a line the script printed
                           change   the page's visible content changed: what
                                    lines appeared / went, which state it is now
                           nav      a frame navigated
                           popup    a new tab or window opened (ads do this)
                           http     a page/document answered (status, url)
                           console  an error the page itself logged
                           close / crash
        states/<id>.html  the FULL page, once per distinct screen ("state")
        states/<id>.txt   that screen's visible text, and the elements on show
        states.jsonl      the index: each state's id, when first seen, where
        run.log           the plain log, with times

A "state" is the page's visible text with every number taken out, plus the
visible elements. So a cooldown counting down 59, 58, 57 is ONE state and not
reported tick by tick (the script's own log says the wait), while a new captcha,
an ad, an error banner or another video's comment list is a NEW state with its
full HTML kept. Disk is capped by RECORD_MAX_MB (default 1000): past it the
HTML stops being kept, the text and the timeline carry on.

How changes are seen: a MutationObserver injected into every page of the
browser (and into Zefoy / Cloudflare frames), batching changes for 0.6 s and
reporting only when what is VISIBLE differs from the last report. Nothing here
calls back into Playwright from an event, so it cannot stall the run.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "zefoy-recordings"
MAX_MB = float(os.getenv("RECORD_MAX_MB", "1000") or 1000)

_JS = r"""
(() => {
  if (window.__zrecInstalled) return;
  window.__zrecInstalled = true;
  const top = window.top === window;
  // Banner ad frames churn all the time and say nothing about Zefoy. A frame
  // the size of the screen is different: that is the ad in the way (reward
  // video, vignette), and its buttons are what the ad handler has to press.
  const bigFrame = !top && innerWidth >= 450 && innerHeight >= 450;
  if (!top && !bigFrame && !/zefoy|cloudflare|challenge|captcha/i.test(location.host + location.pathname)) return;
  let last = '', timer = null;
  const norm = (s) => s.replace(/\d+/g, '#').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  function shown() {
    const out = [];
    let els = [];
    try {
      els = document.querySelectorAll('[id],form,button,input,select,textarea,iframe,img,video,dialog,[role=dialog],[role=button],[aria-label],[class*=modal],[class*=alert],[class*=close],[class*=skip]');
    } catch (e) {}
    for (const el of els) {
      if (out.length >= 400) break;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      // Google's ad furniture (a glow border blinking on and off, ad slots
      // filling) is not a Zefoy screen; left in, one countdown read as two
      // alternating states.
      if (/google|aswift|adsbygoogle|gpt-ad|div-gpt/i.test((el.id || '') + ' ' + cls)) continue;
      if (el.closest && el.closest('ins.adsbygoogle,[id^="aswift"],[id^="google_ads"]')) continue;
      // A button's label is what an ad's close/resume control is known by.
      const lab = el.getAttribute && el.getAttribute('aria-label');
      out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls +
        (lab ? '[aria-label="' + lab.slice(0, 40).replace(/\s+/g, '_') + '"]' : ''));
    }
    return out.join(' ');
  }
  function send(reason) {
    timer = null;
    if (!document.body || typeof window.__zrec !== 'function') return;
    let text = '';
    try { text = document.body.innerText || ''; } catch (e) {}
    const struct = shown();
    const sig = norm(text).slice(0, 20000) + '\n--\n' + struct;
    if (sig === last) return;
    last = sig;
    let html = '';
    try { html = document.documentElement.outerHTML; } catch (e) {}
    try {
      window.__zrec({ at: Date.now(), url: location.href, title: document.title, top, reason,
        text: text.slice(0, 60000), struct, html: html.slice(0, 3000000) });
    } catch (e) {}
  }
  const schedule = (reason) => { if (!timer) timer = setTimeout(() => send(reason), 600); };
  const start = () => {
    try {
      new MutationObserver(() => schedule('mutation')).observe(document,
        { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
    send('load');
    // Belt and braces: a change the observer misses (canvas, a style sheet
    // swapped) still shows up within two seconds.
    setInterval(() => send('poll'), 2000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
"""

_DIGITS = re.compile(r"\d+")


def _norm(text: str) -> str:
    t = _DIGITS.sub("#", text)
    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n", t).strip()


class _Tee:
    """stdout/stderr that also hands each finished line to the recorder."""

    def __init__(self, stream, rec: "Recorder", kind: str):
        self._s, self._rec, self._kind = stream, rec, kind
        self._buf = threading.local()

    def write(self, s):
        n = self._s.write(s)
        try:
            pending = getattr(self._buf, "v", "") + s
            *lines, rest = pending.split("\n")
            self._buf.v = rest
            for line in lines:
                if line.strip():
                    self._rec.log(line, self._kind)
        except Exception:  # noqa: BLE001 - the recorder must never break printing
            pass
        return n

    def flush(self):
        return self._s.flush()

    def __getattr__(self, name):
        return getattr(self._s, name)


class Recorder:
    def __init__(self, argv: list[str]):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.dir = ROOT / f"{stamp}-{os.getpid()}"
        (self.dir / "states").mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._t0 = time.time()
        self._timeline = open(self.dir / "timeline.jsonl", "a", encoding="utf-8")
        self._runlog = open(self.dir / "run.log", "a", encoding="utf-8")
        self._index = open(self.dir / "states.jsonl", "a", encoding="utf-8")
        self._states: dict[str, int] = {}
        self._prev: dict[tuple, list[str]] = {}
        self._pages: dict[int, str] = {}
        self._bytes = 0
        self._html_off = False
        (self.dir / "meta.json").write_text(json.dumps({
            "started": datetime.now().isoformat(timespec="seconds"),
            "argv": argv, "pid": os.getpid(), "max_mb": MAX_MB,
        }, indent=1), encoding="utf-8")

    # ── writing ─────────────────────────────────────────────────────────────
    def _emit(self, kind: str, at: float | None = None, **data):
        # `at` is when the PAGE saw it. A sync-Playwright binding is only
        # delivered when the script next talks to the browser, which during a
        # five-minute cooldown sleep is five minutes later — so the page's own
        # clock is the one that puts a change in the right place in the log.
        when = at if at else time.time()
        rec = {"t": datetime.fromtimestamp(when).isoformat(timespec="milliseconds"),
               "s": round(when - self._t0, 2), "kind": kind, **data}
        if at:
            rec["delivered_late_s"] = round(time.time() - when, 1)
        line = json.dumps(rec, ensure_ascii=False)
        with self._lock:
            self._timeline.write(line + "\n")
            self._timeline.flush()

    def log(self, line: str, stream: str = "out"):
        stamp = datetime.now().strftime("%H:%M:%S")
        with self._lock:
            self._runlog.write(f"{stamp} {line}\n")
            self._runlog.flush()
        self._emit("log", line=line, **({"stream": "err"} if stream == "err" else {}))

    def install_tee(self):
        sys.stdout = _Tee(sys.stdout, self, "out")
        sys.stderr = _Tee(sys.stderr, self, "err")
        print(f"[*] Recording  : every Zefoy page change and this log -> {self.dir}")

    # ── the browser side ───────────────────────────────────────────────────
    def _page_name(self, page, window: str) -> str:
        key = id(page)
        if key not in self._pages:
            self._pages[key] = f"{window or 'W'}#p{len(self._pages) + 1}"
        return self._pages[key]

    def attach(self, context, page, window: str = ""):
        """Watch every page of this browser context. Safe to call again on a
        context it has seen (a phone reconnect hands back the same one)."""
        window = (window or "").strip("[]") or "main"

        def on_change(source, payload):
            try:
                self._on_change(source, payload, window)
            except Exception as e:  # noqa: BLE001
                self._emit("recorder_error", error=str(e)[:300])

        try:
            context.expose_binding("__zrec", on_change)
        except Exception as e:  # noqa: BLE001 - already registered on this context
            if "already registered" not in str(e):
                self._emit("recorder_error", error=f"expose_binding: {str(e)[:300]}")
        try:
            context.add_init_script(_JS)
        except Exception as e:  # noqa: BLE001
            self._emit("recorder_error", error=f"init_script: {str(e)[:300]}")

        def watch(pg, opened_as: str):
            name = self._page_name(pg, window)
            self._emit(opened_as, page=name, url=pg.url)
            pg.on("framenavigated", lambda fr: self._emit(
                "nav", page=name, url=fr.url, top=fr == pg.main_frame) if (
                fr == pg.main_frame or re.search(r"zefoy|cloudflare|challenge", fr.url or "", re.I)) else None)
            pg.on("close", lambda _p: self._emit("close", page=name))
            pg.on("crash", lambda _p: self._emit("crash", page=name))
            pg.on("pageerror", lambda err: self._emit(
                "pageerror", page=name, error=str(err)[:500]) if "zefoy" in (pg.url or "") else None)
            pg.on("console", lambda m: self._emit(
                "console", page=name, level=m.type, text=m.text[:500])
                if m.type in ("error", "warning") and "zefoy" in (pg.url or "") else None)
            pg.on("response", lambda r: self._emit(
                "http", page=name, status=r.status, url=r.url[:300])
                if r.request.resource_type == "document" or r.status >= 400 and "zefoy" in r.url else None)

        for pg in list(context.pages):
            if pg != page:
                watch(pg, "page")
        watch(page, "page")
        context.on("page", lambda pg: watch(pg, "popup"))
        # A page that was already open (the phone's tab) never runs the init
        # script for its current document, so it is given it now.
        for pg in list(context.pages):
            try:
                pg.evaluate(_JS)
            except Exception:  # noqa: BLE001 - a page mid-navigation; it gets the init script next load
                pass

    def _on_change(self, source, p: dict, window: str):
        page = source.get("page") if isinstance(source, dict) else None
        name = self._page_name(page, window) if page is not None else window
        text = str(p.get("text") or "")
        struct = str(p.get("struct") or "")
        url = str(p.get("url") or "")
        top = bool(p.get("top"))
        sid = hashlib.sha1((_norm(text)[:20000] + "\n--\n" + struct).encode("utf-8")).hexdigest()[:12]

        # What appeared and what went, against this page/frame's last report.
        key = (name, top, url.split("?")[0] if not top else "")
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
        prev = self._prev.get(key)
        self._prev[key] = lines
        added = removed = None
        if prev is not None:
            ps, ns = set(prev), set(lines)
            added = [ln[:200] for ln in lines if ln not in ps][:40]
            removed = [ln[:200] for ln in prev if ln not in ns][:40]

        new_state = False
        with self._lock:
            seen = self._states.get(sid, 0)
            self._states[sid] = seen + 1
            new_state = seen == 0
        if new_state:
            self._save_state(sid, p, name, url, text, struct)
        try:
            at = float(p.get("at")) / 1000.0
        except (TypeError, ValueError):
            at = None
        self._emit("change", at=at, page=name, frame="top" if top else "frame", url=url[:300],
                   title=str(p.get("title") or "")[:200], reason=p.get("reason"),
                   state=sid, new_state=new_state,
                   **({"added": added, "removed": removed} if prev is not None
                      else {"text_head": [ln[:200] for ln in lines[:40]]}))

    def _save_state(self, sid, p, name, url, text, struct):
        html = str(p.get("html") or "")
        txt = f"URL: {url}\nTITLE: {p.get('title')}\nPAGE: {name}\n\n{text}\n\n--- visible elements ---\n" \
              + struct.replace(" ", "\n")
        st = self.dir / "states"
        (st / f"{sid}.txt").write_text(txt, encoding="utf-8")
        self._bytes += len(txt.encode("utf-8"))
        kept_html = False
        if not self._html_off:
            if self._bytes + len(html) > MAX_MB * 1024 * 1024:
                self._html_off = True
                self._emit("recorder_note", note=f"RECORD_MAX_MB ({MAX_MB:g}) reached: "
                                                 "new states keep their text only from here")
            else:
                (st / f"{sid}.html").write_text(html, encoding="utf-8")
                self._bytes += len(html.encode("utf-8"))
                kept_html = True
        with self._lock:
            self._index.write(json.dumps({
                "state": sid, "first_seen": datetime.now().isoformat(timespec="seconds"),
                "page": name, "url": url[:300], "title": str(p.get("title") or "")[:200],
                "html": kept_html, "text_head": text.strip()[:300],
            }, ensure_ascii=False) + "\n")
            self._index.flush()


_REC: Recorder | None = None


def start(argv: list[str]) -> Recorder:
    global _REC
    if _REC is None:
        _REC = Recorder(argv)
        _REC.install_tee()
    return _REC


def current() -> Recorder | None:
    return _REC
