"""Which way of turning an Instagram /p/<code>/ link into a username works?

The account is not in the URL, so it has to be fetched. Four candidates, tested
against real codes from the results CSVs rather than assumed:

  1. the post's embed page (/embed/captioned/) — public, no login
  2. the plain post page's og:title / meta
  3. oEmbed (needs an app token these days, but cheap to rule out)
  4. the GraphQL media endpoint used by the web client

    python probe_ig_owner.py [count]
"""
import csv
import glob
import json
import re
import sys
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def codes(n):
    out = []
    seen = set()
    for p in sorted(glob.glob("results/*.csv")):
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                u = (row.get("url") or "")
                m = re.search(r"instagram\.com/(?:p|reel|tv)/([\w-]+)", u)
                if m and m.group(1) not in seen:
                    seen.add(m.group(1))
                    out.append((m.group(1), u))
                    if len(out) >= n:
                        return out
    return out


def try_embed(code):
    st, body = get(f"https://www.instagram.com/p/{code}/embed/captioned/")
    if st != 200:
        return f"HTTP {st}", None
    # The embed carries the owner in a few shapes; take whichever appears.
    for pat in (
        r'"owner"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"',
        r'"username"\s*:\s*"([^"]+)"',
        r'class="Header"[\s\S]{0,600}?instagram\.com/([A-Za-z0-9_.]+)/\?',
        r'<a[^>]+href="https://www\.instagram\.com/([A-Za-z0-9_.]+)/?\?[^"]*"[^>]*class="[^"]*Name',
    ):
        m = re.search(pat, body)
        if m:
            return "ok", m.group(1)
    return f"200 but no username ({len(body)} bytes)", None


def try_page(code):
    st, body = get(f"https://www.instagram.com/p/{code}/")
    if st != 200:
        return f"HTTP {st}", None
    for pat in (
        r'"owner"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"',
        r'<meta property="og:title" content="[^"]*?\(@([A-Za-z0-9_.]+)\)',
        r'"alternateName"\s*:\s*"@?([A-Za-z0-9_.]+)"',
    ):
        m = re.search(pat, body)
        if m:
            return "ok", m.group(1)
    login = "loginForm" in body or "accounts/login" in body
    return f"200 but no username ({len(body)} bytes{', login wall' if login else ''})", None


def try_oembed(code):
    st, body = get(
        f"https://api.instagram.com/oembed/?url=https://www.instagram.com/p/{code}/"
    )
    if st != 200:
        return f"HTTP {st}", None
    try:
        return "ok", json.loads(body).get("author_name")
    except Exception:
        return "unparseable", None


def try_graphql(code):
    st, body = get(
        f"https://www.instagram.com/api/v1/media/{code}/info/",
        {"X-IG-App-ID": "936619743392459"},
    )
    if st != 200:
        return f"HTTP {st}", None
    try:
        d = json.loads(body)
        return "ok", d["items"][0]["user"]["username"]
    except Exception:
        return f"200 but unparseable ({len(body)} bytes)", None


n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
sample = codes(n)
print(f"{len(sample)} real code(s) from the results\n")

score = {k: 0 for k in ("embed", "page", "oembed", "api")}
for code, url in sample:
    print(f"{url}")
    for name, fn in (("embed", try_embed), ("page", try_page),
                     ("oembed", try_oembed), ("api", try_graphql)):
        note, who = fn(code)
        if who:
            score[name] += 1
        print(f"   {name:<7} {('@' + who) if who else '-':<28} {note}")
    print()

print("resolved, out of", len(sample))
for k, v in sorted(score.items(), key=lambda kv: -kv[1]):
    print(f"   {k:<7} {v}")
