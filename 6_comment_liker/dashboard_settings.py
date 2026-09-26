#!/usr/bin/env python3
"""What the dashboard can set, and how each setting reaches the scripts.

ONE TABLE, read by three things: the form the page renders, the settings file,
and the command line each run is built from. They used to be three lists in a
project like this and they drifted — run_parallel.py had a flag like.py
understood and simply could not reach it, which is invisible until somebody
notices a switch doing nothing. check_dashboard.py reads `--help` from both
scripts and fails if this table offers a flag either of them would reject.

TWO WAYS TO RUN, which is the distinction the whole dashboard is built around:

  IN COLLECTION   one run_parallel.py over one pool of links, shared out
                  between the profiles (--share split) or given to all of them
                  (--share stack). One set of settings, because there is one
                  run. This is what you want to cover ground.

  INDEPENDENTLY   one like.py per profile, each with its OWN settings and its
                  own links. Nothing is shared and nothing is co-ordinated.
                  This is what you want when the profiles are doing different
                  jobs — one working cluster 1, one re-trying failures, one on
                  a hand-written list.

A setting is per-profile or it is not. `delay` is: profile d can be slower than
profile a. `share` is not: it describes how one pool is divided, which is a
property of the run and meaningless for a single profile. The table says which,
and the page only offers an override where one exists.
"""
from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from typing import Any


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    kind: str                      # bool | int | str | choice
    default: Any
    flag: str = ""                 # the CLI flag; "" for a switch with no flag
    choices: tuple[str, ...] = ()
    # Which script understands it. A setting reaching neither is a setting that
    # does nothing, and check_dashboard fails on one.
    targets: tuple[str, ...] = ("like", "parallel")
    # Can one profile differ from another on this? Only meaningful when running
    # independently — in collection there is one run and one answer.
    per_profile: bool = True
    group: str = "work"
    help: str = ""


# ── the table ────────────────────────────────────────────────────────────────
# Grouped the way the page lays them out. `flag` is exactly what the scripts
# accept; nothing here is invented.
FIELDS: tuple[Field, ...] = (
    # Where the links come from.
    Field("links_file", "Links file", "str", "", "--links", group="links",
          help="A .txt or .csv of video URLs. Overrides the dashboard query below."),
    Field("cluster_by", "Cluster by", "choice", "date", "--cluster-by",
          choices=("rank", "date", "combined"), targets=("like", "parallel", "web"), group="links"),
    Field("clusters", "Clusters", "str", "1", "--clusters", targets=("like", "parallel", "web"), group="links",
          help="e.g. 1,2 — blank means every cluster."),
    # Which platform this run works. Run-level: it decides the script, the
    # profile directory and the links all at once, so a profile cannot differ
    # from the run it is part of. To work two platforms at the same time, start
    # a run, switch this, and start another — they use different directories
    # and do not collide.
    Field("platform", "Platform", "choice", "tiktok", "--platform",
          choices=("tiktok", "instagram", "youtube_shorts", "youtube_videos"),
          targets=("like", "parallel", "web"), per_profile=False, group="links",
          help="TikTok runs like.py; the others run like_web.py against their own "
               "Chrome profile (profile-ig-x, profile-yt-x), so the same letter can "
               "work all four at once"),
    Field("category", "Category", "str", "", "--category", targets=("like", "parallel", "web"), group="links",
          help="competitors | ai_detector | generic — blank for any."),
    Field("max_links", "Max links", "int", 20000, "--max-links", targets=("like", "parallel", "web"), group="links"),

    # What counts as a target.
    # like.py only: run_parallel hard-codes --products for every child it starts,
    # so offering it there would be a switch that changes nothing.
    Field("products", "Active products only", "bool", True, "--products",
          targets=("like", "web"), group="targets"),
    Field("all_products", "Every product", "bool", False, "--all-products", targets=("like", "parallel", "web"), group="targets",
          help="Includes deactivated ones."),
    Field("all", "Every comment", "bool", False, "--all", targets=("like", "parallel", "web"), group="targets",
          help="Likes everything on the video, not just ours."),
    Field("users", "Watched handles", "str", "", "--users", targets=("like", "parallel", "web"), group="targets",
          help="Comma-separated @handles whose comments to like."),

    # How it works.
    Field("mode", "Mode", "choice", "dom", "--mode", choices=("dom", "fast", "api"),
          group="work", help="dom is the only mode that works."),
    Field("delay", "Delay between videos", "str", "2,5", "--delay", targets=("like", "parallel", "web"), group="work",
          help="seconds, min,max"),
    Field("scrolls", "Comment scrolls", "int", 6, "--scrolls", group="work"),
    Field("pages", "Comment pages", "int", 3, "--pages", group="work"),
    Field("limit", "Likes cap", "int", 0, "--limit", targets=("like", "parallel", "web"), group="work",
          help="0 = no cap. run_parallel calls this --per-account."),
    Field("no_dom_sweep", "No DOM sweep", "bool", False, "--no-dom-sweep", group="work"),
    Field("keep_going", "Keep going after failures", "bool", True, "--keep-going", group="work"),
    Field("keep_failures", "Keep failed rows", "bool", False, "--keep-failures", targets=("like", "parallel", "web"), group="work"),

    # The browser.
    Field("headed", "Show the browser", "bool", False, "--headed", targets=("like", "parallel", "web"), group="browser"),
    Field("with_media", "Load images and video", "bool", False, "--with-media", group="browser"),
    Field("solve_captcha", "Try the captcha API", "bool", False, "--solve-captcha", group="browser"),
    Field("no_captcha_window", "No window for captchas", "bool", False, "--no-captcha-window",
          group="browser",
          help="Headless runs open a window when a captcha appears, so you can solve it "
               "and the run carries on. Tick this to give up on the account instead — "
               "for a run nobody is sitting in front of."),
    Field("no_relogin", "Never re-login", "bool", False, "--no-relogin", group="browser"),

    # Things that write, or undo.
    Field("dry_run", "Dry run", "bool", False, "--dry-run", targets=("like", "parallel", "web"), group="danger",
          help="Find targets, like nothing."),
    Field("unlike", "Unlike instead", "bool", False, "--unlike", group="danger"),
    Field("comment_empty", "Comment on empty videos", "bool", False, "--comment-empty",
          group="danger",
          help="The only thing here that writes something public."),
    Field("comment_product", "Comment product", "str", "", "--comment-product", group="danger"),
    # Written the way the thread is already talking. Only does anything with
    # "Comment on empty videos" on — that is what posts anything at all.
    Field("mimic_comments", "Match the thread's comments", "bool", False, "--mimic-comments",
          targets=("like", "parallel"), group="danger",
          help="When commenting, look at the comments already under the video. If one "
               "recommends a rival tool, write ours in the same vein instead of taking "
               "a stored comment. Falls back to the stored set when the thread mentions "
               "no rival."),
    # The other half of the same job: a run that only seeds comments.
    Field("no_like", "Comment only, never like", "bool", False, "--no-like",
          targets=("like", "parallel"), group="danger",
          help="Likes nothing. Pointless on its own — it is for a run whose job is to "
               "put a comment on links that carry none of ours, with the setting above."),

    # Run-level only: these describe how several profiles are co-ordinated, so
    # they mean nothing to a single like.py and nothing per profile.
    Field("share", "Share of work", "choice", "split", "--share", choices=("split", "stack"),
          targets=("parallel",), per_profile=False, group="run",
          help="split: each link to one profile. stack: every profile visits every link."),
    Field("stagger", "Stagger", "int", 6, "--stagger", targets=("parallel",),
          per_profile=False, group="run", help="seconds between starting each profile"),
    Field("at_once", "Browsers at once", "int", 0, "--at-once", targets=("parallel",),
          per_profile=False, group="run",
          help="0 = all of them. THE memory lever: one Chromium is seven processes, "
               "so nineteen accounts is a hundred and thirty. The same accounts work "
               "the same shards either way — this only says how many at a time."),
    # Per profile, deliberately: debugging one account that keeps failing
    # should not bury the other sixteen in detail.
    Field("debug", "Detailed log", "bool", False, "--debug", targets=("like", "parallel"),
          group="run",
          help="say far more, for debugging: elapsed time on every line, how long each "
               "page took, and what a failed page actually contained — written into the "
               "ledger's note as well, so a failure can be read the next morning"),
    Field("sequential", "One at a time", "bool", False, "--sequential", targets=("parallel",),
          per_profile=False, group="run", help="the same as Browsers at once = 1"),
    Field("timeout_min", "Give up after", "int", 0, "--timeout-min", targets=("parallel",),
          per_profile=False, group="run", help="minutes; 0 = wait"),
    Field("loop", "Loop", "bool", False, "--loop", targets=("parallel",),
          per_profile=False, group="run"),
    Field("loop_pause", "Loop pause", "int", 300, "--loop-pause", targets=("parallel",),
          per_profile=False, group="run", help="seconds between passes"),
    Field("videos", "First N videos only", "int", 0, "--videos", targets=("parallel",),
          per_profile=False, group="run",
          help="0 = the whole list. For a quick trial before committing a run."),
)

BY_KEY = {f.key: f for f in FIELDS}

# run_parallel.py calls the per-account like cap --per-account (it accepts
# --limit as an alias, but the one it documents is --per-account). Named here
# rather than special-cased in the builder, so the exception is visible.
PARALLEL_FLAG_OVERRIDE = {"limit": "--per-account"}


# ── the four platforms ───────────────────────────────────────────────────────
#
# A platform decides three things at once, and they are not the same thing:
#
#   THE LINKS      the dashboard feed labels every link with one of these four,
#                  and shorts are not videos — different pages, different
#                  comment sections, different work.
#   THE SCRIPT     TikTok has its own liker (like.py, which talks to TikTok's
#                  API as well as its DOM). Instagram and YouTube go through
#                  like_web.py, which is DOM-only because neither has a like
#                  endpoint worth signing.
#   THE PROFILE    a Chrome user data directory per SITE, which is why the same
#                  letter can work all four at once: profile-a, profile-ig-a and
#                  profile-yt-a are three directories and three browsers. Two
#                  runs over ONE directory cannot coexist; these never share one.
#
# Shorts and videos are one site and one profile — the difference between them
# is which links the feed hands out, nothing else.
PLATFORMS: dict[str, dict[str, str]] = {
    "tiktok": {"label": "TikTok", "site": "tiktok", "script": "like.py", "target": "like"},
    "instagram": {"label": "Instagram", "site": "instagram", "script": "like_web.py",
                  "target": "web"},
    "youtube_shorts": {"label": "YouTube Shorts", "site": "youtube",
                       "script": "like_web.py", "target": "web"},
    "youtube_videos": {"label": "YouTube videos", "site": "youtube",
                       "script": "like_web.py", "target": "web"},
}


def platform_of(s: dict[str, Any] | str) -> str:
    """The platform a settings dict (or a bare string) means. Always a real one."""
    key = s if isinstance(s, str) else str((s or {}).get("platform") or "")
    return key if key in PLATFORMS else "tiktok"


def site_of(platform: str) -> str:
    """Which login/profile family a platform uses: tiktok | instagram | youtube."""
    return PLATFORMS[platform_of(platform)]["site"]


def script_of(platform: str) -> str:
    """Which liker runs it."""
    return PLATFORMS[platform_of(platform)]["script"]


def target_of(platform: str) -> str:
    """Which column of the settings table applies to it."""
    return PLATFORMS[platform_of(platform)]["target"]


def label_of(platform: str) -> str:
    return PLATFORMS[platform_of(platform)]["label"]

GROUPS = (
    ("links", "Where the links come from"),
    ("targets", "What counts as a target"),
    ("work", "How it works"),
    ("browser", "The browser"),
    ("danger", "Writes and undos"),
    ("run", "Running together"),
)


def defaults() -> dict[str, Any]:
    return {f.key: f.default for f in FIELDS}


def coerce(key: str, value: Any) -> Any:
    """Force a value from the page into the type the field says it is.

    A checkbox arrives as true/false, a number arrives as a string, and a select
    arrives as something that may not be one of its choices. Everything is
    pinned here rather than trusted, because the next thing that happens to it
    is being put on a command line.
    """
    f = BY_KEY.get(key)
    if f is None:
        raise KeyError(key)
    if f.kind == "bool":
        return bool(value) if not isinstance(value, str) else value.strip().lower() in (
            "1", "true", "yes", "on"
        )
    if f.kind == "int":
        try:
            n = int(str(value).strip() or 0)
        except ValueError:
            return f.default
        return max(0, n)
    if f.kind == "choice":
        v = str(value).strip()
        return v if v in f.choices else f.default
    return str(value)


def clean(raw: dict[str, Any]) -> dict[str, Any]:
    """A whole settings dict, coerced, with unknown keys dropped."""
    out = defaults()
    for k, v in (raw or {}).items():
        if k in BY_KEY:
            out[k] = coerce(k, v)
    return out


def merged(shared: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, Any]:
    """One profile's effective settings: the shared ones, then its own.

    Only per-profile fields may be overridden. A run-level field in an override
    is ignored rather than honoured, because honouring it would mean profile b
    could quietly change how the whole run is shared out.
    """
    out = clean(shared)
    for k, v in (overrides or {}).items():
        f = BY_KEY.get(k)
        if f is not None and f.per_profile:
            out[k] = coerce(k, v)
    return out


def _args_for(target: str, s: dict[str, Any]) -> list[str]:
    """The flags one script should be given for these settings."""
    argv: list[str] = []
    for f in FIELDS:
        if target not in f.targets:
            continue
        if f.key == "links_file":
            continue  # handled by the caller: the two modes source links differently
        v = s.get(f.key, f.default)
        flag = PARALLEL_FLAG_OVERRIDE.get(f.key, f.flag) if target == "parallel" else f.flag
        if f.kind == "bool":
            if v:
                argv.append(flag)
            continue
        # An empty string means "not set" for every string field here; passing
        # --category "" would filter on the empty category rather than on none.
        text = str(v)
        if text == "":
            continue
        argv += [flag, text]
    return argv


def like_command(python: str, script: str, profile: str, s: dict[str, Any],
                 links_file: str = "", slot: int = 0, count: int = 1) -> list[str]:
    """One profile, on its own, with its own settings.

    `slot` and `count` tile the window when --headed is on. run_parallel hands
    these to every child it starts; without them N independent runs open N
    windows stacked exactly on top of each other, and "running independently"
    looks like one browser doing nothing.
    """
    argv = [python, "-u", script, "--profile", profile,
            "--window-slot", str(slot), "--window-count", str(max(1, count))]
    src = links_file or str(s.get("links_file") or "")
    if src:
        argv += ["--links", src]
    else:
        argv.append("--from-dashboard")
    return argv + _args_for("like", s)


def web_command(python: str, script: str, profile: str, s: dict[str, Any],
                links_file: str = "") -> list[str]:
    """One profile on Instagram or YouTube, through like_web.py.

    --site is the profile family (instagram | youtube); --platform is the FEED
    filter, and those differ for YouTube: one site, two platforms, because
    shorts and videos are different pages with different comment sections and
    the dashboard labels them separately.

    No --window-slot/--window-count: like_web does not tile windows, and
    inventing flags a script would reject is the failure this whole table
    exists to prevent.
    """
    platform = platform_of(s)
    argv = [python, "-u", script, "--site", site_of(platform), "--profile", profile]
    src = links_file or str(s.get("links_file") or "")
    if src:
        argv += ["--links", src]
    else:
        argv.append("--from-dashboard")
    return argv + _args_for("web", s)


def parallel_command(python: str, script: str, profiles: list[str],
                     s: dict[str, Any]) -> list[str]:
    """Several profiles, over one pool of links, co-ordinated by run_parallel."""
    argv = [python, "-u", script, "--profiles", ",".join(profiles)]
    src = str(s.get("links_file") or "")
    if src:
        argv += ["--links", src]
    return argv + _args_for("parallel", s)
