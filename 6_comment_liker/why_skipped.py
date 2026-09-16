#!/usr/bin/env python3
"""
Why was that comment passed over?

Reading comments is a plain unsigned HTTP call, so this can answer the question
for a real video without opening a browser or liking anything. It applies the
same three tests the run applies, in the same order, and reports which one each
comment fell at.

    python why_skipped.py https://www.tiktok.com/@x/video/123
    python why_skipped.py --from-done 3     # the last 3 videos actually worked
"""
import argparse
import csv
import sys
from pathlib import Path

import like

HERE = Path(__file__).resolve().parent


def classify(url: str, pages: int, products: list[str], done: set[str]) -> None:
    aweme = like.video_id(url)
    if not aweme:
        print(f"  not a TikTok video URL: {url}")
        return
    comments = like.fetch_comments(aweme, pages)
    buckets = {"liked/likeable": [], "no product named": [], "already liked": [], "done before": []}
    for c in comments:
        if not like.wanted(c, products, set(), False):
            buckets["no product named"].append(c)
        elif c["already"]:
            buckets["already liked"].append(c)
        elif c["cid"] in done:
            buckets["done before"].append(c)
        else:
            buckets["liked/likeable"].append(c)

    print(f"\n{url}")
    print(f"  {len(comments)} top-level comment(s) read ({pages} page(s) deep)")
    for name, items in buckets.items():
        print(f"    {name:<18} {len(items)}")
    # The interesting half: show a couple of each skip reason, so the answer is
    # the actual text rather than a category.
    for name in ("no product named", "already liked", "done before"):
        for c in buckets[name][:2]:
            txt = c["text"].replace("\n", " ")[:64]
            print(f"      [{name}] @{c['user']}: {txt}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="*")
    ap.add_argument("--from-done", type=int, default=0,
                    help="instead of URLs, take the last N distinct videos from the ledgers")
    ap.add_argument("--pages", type=int, default=3, help="comment pages to read, as the run does")
    args = ap.parse_args()

    products = like.NORM_PRODUCTS
    print(f"matching against: {', '.join(products)}")

    done: set[str] = set()
    urls = list(args.urls)
    if args.from_done:
        seen: list[str] = []
        for f in sorted(HERE.glob("done-*.csv")) + [HERE / "done.csv"]:
            if not f.exists():
                continue
            with f.open(encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    if r.get("cid"):
                        done.add(r["cid"])
                    u = (r.get("url") or "").strip()
                    if u and u not in seen:
                        seen.append(u)
        urls = seen[-args.from_done:]
        print(f"ledger holds {len(done)} comment(s) already done")

    if not urls:
        print("give a URL, or --from-done N")
        return 1
    for u in urls:
        classify(u, args.pages, products, done)
    return 0


if __name__ == "__main__":
    sys.exit(main())
