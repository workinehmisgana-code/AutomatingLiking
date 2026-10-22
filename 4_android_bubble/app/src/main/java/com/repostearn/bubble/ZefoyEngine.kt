package com.repostearn.bubble

import org.json.JSONObject

/**
 * The Comments Hearts run, on the phone.
 *
 * This is the port of `zefoy_process_url` in `2_comment_automation/automate.py`
 * and it keeps that function's shape on purpose — fill the box, Search, sit out
 * the cooldown, click the count, read every comment page, pick which of ours to
 * work on, send one batch, then WATCH the real number arrive. Each of those
 * steps is there because a run failed without it, and the comments on the Python
 * side are the record of how. Read them before changing the order here.
 *
 * WHAT THE PHONE DOES NOT DO: solve the captcha. The PC's runner sends the image
 * to Gemini; this does not, because the person holding the phone is right there
 * and an API key on a handset is a key that leaves the building. The engine
 * stops, says so, and waits for the captcha to be typed into the WebView it is
 * already showing.
 *
 * Nothing here decides a number. The margin, floor, ceiling, rounds and the link
 * list all arrive in [LikerJob] from the dashboard, and the arithmetic is
 * [LikerRules] — which is tested against the same cases as the Python.
 */
class ZefoyEngine(
    private val web: ZefoyWeb,
    private val job: LikerJob,
    private val log: (String) -> Unit,
    private val status: (String) -> Unit,
    private val progress: (done: Int, total: Int, hearts: Int) -> Unit,
) {

    /** One comment as the page shows it now. `i` indexes the list it came from. */
    data class Row(val i: Int, val text: String, val hearts: Int, val user: String, val date: String)

    /** One of ours, and where it was found during the scan. */
    private data class Mine(
        val page: Int,
        val row: Int,
        val text: String,
        override val hearts: Int,
    ) : LikerRules.Hearted

    /**
     * One visit to one video.
     *
     * `capped` and `noComment` both mean "do not come back", for different
     * reasons: the first is the ceiling, the second is a video that has none of
     * our comments on it. `retryable` is the opposite — Zefoy did not answer, so
     * nothing is known about the video yet.
     */
    data class Visit(
        val ok: Boolean,
        val note: String,
        val sent: Int = 0,
        val isTop: Boolean = false,
        val capped: Boolean = false,
        val noComment: Boolean = false,
        val retryable: Boolean = false,
    )

    var done = 0; private set
    var heartsSent = 0; private set
    var failedLinks = 0; private set

    private val maxPages = 10

    // ── the run ─────────────────────────────────────────────────────────────

    fun run() {
        log("Opening ${ZefoyScript.HOME}")
        web.load(ZefoyScript.HOME)
        if (!gate()) return

        if (!openPanel()) {
            log("[!] Could not open Comments Hearts — stopping.")
            return
        }

        val total = job.links.size
        log("")
        log("$total link(s), up to ${job.rounds} batch(es) each.")
        log("Lead by ${job.margin} · floor ${pct(job.floor)} · ceiling ${pct(job.threshold)}")
        log("Looking for: ${job.products.joinToString(", ")}")
        log("")

        for ((idx, link) in job.links.withIndex()) {
            if (web.stop) return
            status("Video ${idx + 1} of $total")
            log("[${idx + 1}/$total] ${link.url}")
            if (link.likes > 0) log("  video likes: ${n(link.likes)}")

            var sentHere = 0
            var okHere = false
            for (round in 1..job.rounds) {
                if (job.rounds > 1 && round > 1) log("  round $round of ${job.rounds}")
                val v = visit(link.url, link.likes)
                log("  ${if (v.ok) "[+]" else "[-]"} ${v.note}")
                if (v.ok) {
                    okHere = true
                    sentHere += v.sent
                    heartsSent += v.sent
                }
                // A captcha mid-run is the session going, not this video failing.
                if (web.zs("where()") == "captcha") {
                    log("  [*] Zefoy wants the captcha again.")
                    if (!gate() || !openPanel()) return
                    continue
                }
                if (v.isTop || v.capped || v.noComment) break
                if (!v.ok && !v.retryable) break
                // Rounds chase a lead. With "pass the best other comment"
                // off there is no lead to chase, and a second visit would
                // only run at the ceiling the first one moved up to -- one
                // visit per video, as on the PC.
                if (!job.toTop && v.ok) break
                if (round < job.rounds) web.sleep(2_000)
            }
            if (!okHere) failedLinks++
            done++
            progress(done, total, heartsSent)
            if (sentHere > 0) log("  ${n(sentHere)} heart(s) sent here")
            log("")
            if (idx < total - 1) web.sleep(3_000)
        }

        status("Finished")
        log("Done. ${done} video(s), ${n(heartsSent)} heart(s) sent, $failedLinks with nothing sent.")
    }

    /**
     * Wait until we are logged in, whoever has to type what.
     *
     * Ten minutes, because the only thing it can be waiting for is a person, and
     * a person may well be putting the phone down to do something else.
     */
    private fun gate(): Boolean {
        var told = false
        val ok = web.waitUntil(600, everyMs = 1_500) {
            web.ensure()
            when (web.zs("where()")) {
                "dash", "panel" -> true
                "captcha" -> {
                    if (!told) {
                        told = true
                        status("Type the captcha")
                        log("[*] Zefoy is asking for the captcha — type it on the Browser tab.")
                    }
                    false
                }
                else -> {
                    if (!told) {
                        told = true
                        status("Waiting for zefoy.com")
                        log("[*] Waiting for the page…")
                    }
                    false
                }
            }
        }
        if (!ok) {
            log("[!] Gave up waiting to get past the captcha.")
            status("Stopped at the captcha")
        } else if (told) {
            log("[+] In.")
        }
        return ok
    }

    private fun openPanel(): Boolean {
        web.ensure()
        if (web.zb("hasUrl()")) return true
        web.z("openPanel()")
        web.sleep(1_500)
        return web.waitUntil(15) { web.zb("hasUrl()") }
    }

    // ── one video ───────────────────────────────────────────────────────────

    private fun visit(url: String, likes: Int): Visit {
        web.ensure()

        // THE PANEL SHUTS BY ITSELF. Zefoy drops back to its service menu and the
        // URL box is simply not on the page; the session is fine and the section
        // is closed. Every link after that failed on a timeout that named the
        // symptom and nothing else.
        if (!web.zb("hasUrl()")) {
            if (web.zb("expired()")) {
                return Visit(false, "Session expired — will log in again", retryable = true)
            }
            log("  [*] the Comments Hearts panel is closed — reopening")
            if (!openPanel()) {
                return Visit(
                    false, "The Comments Hearts panel is closed and would not reopen",
                    retryable = true,
                )
            }
        }

        if (web.z("fillUrl(${JSONObject.quote(url)})") != true) {
            return Visit(false, "Could not put the URL in the box", retryable = true)
        }
        web.sleep(700)
        if (web.z("search()") != true) {
            return Visit(false, "The Search button was not there", retryable = true)
        }
        web.sleep(2_500)

        // Zefoy can issue a second timer after the first, so this loops.
        for (attempt in 0 until 3) {
            val cd = web.zi("cooldown()")
            if (cd <= 0) break
            log("  [!] cooldown — waiting ${cd}s")
            status("Cooling down ${cd}s")
            web.sleep(cd * 1_000L)
            if (web.zb("expired()")) {
                return Visit(false, "Session expired during the cooldown", retryable = true)
            }
            web.z("search()")
            web.sleep(2_500)
        }
        if (web.zb("expired()")) {
            return Visit(false, "Session expired — will log in again", retryable = true)
        }

        if (!web.waitUntil(15) { web.zb("hasCount()") }) {
            if (web.zb("expired()")) {
                return Visit(false, "Session expired — will log in again", retryable = true)
            }
            // NOT "no comments": Zefoy did not answer, so nothing is known about
            // this video. It stays pending.
            return Visit(false, "The comment-count button never appeared", retryable = true)
        }
        web.z("clickCount()")
        web.sleep(2_500)

        // ── read every comment page ────────────────────────────────────────
        val ours = mutableListOf<Mine>()
        val seen = mutableSetOf<String>()
        var rivalHearts = 0
        var rivalText = ""
        var anyRows = false
        var page = 1
        var cur = 1

        while (page <= maxPages) {
            cur = page
            val rows = rowsNow()
            if (rows.isNotEmpty()) anyRows = true
            for (r in rows) {
                val mine = job.products.any { LikerRules.matchesProduct(r.text, it) }
                if (mine) {
                    // Keyed on the folded text so the same comment read twice —
                    // the list re-renders — is not counted as two of ours.
                    if (seen.add(key(r.text))) ours += Mine(page, r.i, r.text, r.hearts)
                } else if (r.hearts > rivalHearts) {
                    // THE BEST COMMENT THAT IS NOT ONE OF OURS. Ours are excluded
                    // by the keyword test rather than by position: two of our
                    // comments on one video would otherwise have us racing
                    // ourselves up a section we already own.
                    rivalHearts = r.hearts
                    rivalText = r.text.take(80)
                }
            }
            if (!clickPage(page + 1)) break
            page++
        }

        if (ours.isEmpty()) {
            return if (!anyRows) {
                Visit(false, "No comment list appeared", retryable = true)
            } else {
                Visit(
                    false,
                    "None of our comments are on this video (looked for ${job.products.joinToString(", ")})",
                    noComment = true,
                )
            }
        }

        // ── which of ours to work on ───────────────────────────────────────
        val pick: Mine
        val othersLeft: Int
        if (job.toTop) {
            val chosen = LikerRules.pick(ours, rivalHearts, likes, job.floor)
            if (ours.size > 1) {
                log("  [*] ${ours.size} comment(s) of ours here, ${ours.size - chosen.behind} already clear of ${n(rivalHearts)}")
            }
            if (chosen.thin > 0) {
                log("  [*] ${chosen.thin} of them lead but sit under ${n(chosen.floorAt)} hearts, ${pct(job.floor)} of this video's ${n(likes)} likes — working those too")
            }
            val target = chosen.target
            if (target == null) {
                // THE NUMBERS, not just the verdict: a line that says
                // "already leading" and nothing else cannot be checked
                // against anything.
                val best = ours.maxByOrNull { it.hearts }!!
                return Visit(
                    true,
                    "All ${ours.size} of our comments already lead — ours on ${n(best.hearts)} vs best stranger ${n(rivalHearts)}",
                    isTop = chosen.allLead,
                )
            }
            pick = target
            othersLeft = chosen.othersLeft
        } else {
            // THE SHARE-OF-THE-VIDEO RULE, which does not care about the
            // other comments: the first of ours with room under the ceiling,
            // in the order the pages were read. There is nothing to come back
            // for, so nothing is counted as left.
            val first = ours.firstOrNull {
                LikerRules.decideByShare(it.hearts, likes, job.threshold).hearts > 0
            }
            if (first == null) {
                return Visit(
                    false,
                    "All ${ours.size} of our comments are at the ceiling (${pct(job.threshold)} of ${n(likes)} likes)",
                    capped = true,
                )
            }
            pick = first
            othersLeft = 0
        }

        // ── back to its page, and re-read it there ─────────────────────────
        if (cur != pick.page && !gotoPage(pick.page, cur)) {
            val p = web.zObject("pager()")
            val scoped = p.optJSONArray("scoped")?.length() ?: 0
            val loose = p.optJSONArray("loose")?.length() ?: 0
            // NO PAGINATION AT ALL means the panel was replaced, not that the
            // button was out of reach — so the answer is to read the video
            // again rather than to walk a pager that is not there.
            return Visit(
                false,
                "Could not get back to comment page ${pick.page} from $cur (pager: $scoped in the panel, $loose on the page)",
                retryable = scoped == 0 && loose == 0,
            )
        }

        val want = key(pick.text)
        val live = rowsNow().firstOrNull { key(it.text) == want }
        // THE LIST CAN GO AWAY BETWEEN READING IT AND ACTING ON IT. Zefoy
        // replaces the whole panel with "Session expired" and every number above
        // was read before that happened, so the run reads as though it were
        // working. A target that has lost its row is a target that is gone.
        if (live == null || live.text.isBlank()) {
            if (web.zb("expired()")) {
                return Visit(false, "Session expired while reading the comment", retryable = true)
            }
            return Visit(
                false, "The comment list went away before the heart could be sent",
                retryable = true,
            )
        }

        log("  [*] ours: \"${live.text.take(90)}\"")

        // ── how many ───────────────────────────────────────────────────────
        val d = if (job.toTop) {
            LikerRules.decide(
                ours = live.hearts, rival = rivalHearts, likes = likes,
                margin = job.margin, floor = job.floor, threshold = job.threshold,
            )
        } else {
            LikerRules.decideByShare(live.hearts, likes, job.threshold)
        }
        if (job.toTop) {
            // AHEAD OR BEHIND, said in those words. "Leading comment now"
            // used to be printed for the best comment that is not ours
            // whether or not it actually led, so a video where ours had 12
            // hearts and the next best had 1 announced a leader and then
            // said ours was already top: two true statements that read as a
            // contradiction, because the label described the wrong thing.
            val ahead = live.hearts > rivalHearts
            log(
                "  [*] ours ${n(live.hearts)} | best other ${n(rivalHearts)} | " +
                    if (ahead) "ahead by ${n(live.hearts - rivalHearts)}" else "need ${n(maxOf(0, d.deficit))} more"
            )
            if (rivalText.isNotBlank()) {
                log("  [*] ${if (ahead) "next best" else "ahead of us"}: \"${rivalText}\"")
            }
        } else {
            log("  [*] ours ${n(live.hearts)} hearts | ceiling ${n((likes * job.threshold).toInt())} (${pct(job.threshold)} of ${n(likes)} likes)")
        }

        when (d.action) {
            LikerRules.Action.NOTHING ->
                return Visit(
                    true, "Already the top comment: ${n(live.hearts)} hearts vs ${n(rivalHearts)}",
                    isTop = othersLeft <= 0,
                )
            LikerRules.Action.CEILING ->
                return Visit(false, "At the ceiling — ${d.why}", capped = true)
            LikerRules.Action.SHORT ->
                return Visit(
                    false,
                    "Stopping ${n(d.deficit)} short of the target — ${d.why}",
                    capped = true,
                )
            LikerRules.Action.TIE_BREAK ->
                log("  [*] tied at ${n(live.hearts)} — one batch to break it, then on")
            LikerRules.Action.CHASE -> Unit
        }

        // ── the dropdown, the button, and what actually lands ──────────────
        var send = d.hearts
        val options = mutableListOf<Int>()
        val arr = web.zArray("qtyOptions(${live.i})")
        for (k in 0 until arr.length()) options += arr.optInt(k)
        val usable = options.filter { it > 0 }
        if (usable.isNotEmpty()) {
            val best = usable.filter { it <= d.hearts }.maxOrNull()
            if (best == null) {
                // Wanting fewer than the smallest batch: the overshoot cannot be
                // avoided, and it is worth saying because it can pass a ceiling.
                send = usable.min()
                log("  [~] Zefoy's smallest batch is $send, more than the ${d.hearts} wanted")
            } else {
                send = best
                if (best < d.hearts) {
                    log("  [~] Zefoy sends at most ${usable.max()} a submit: $best now, ${n(d.hearts - best)} left for the next round")
                }
            }
            if (web.z("setQty(${live.i}, $send)") != true) {
                log("  [~] could not set the quantity — using whatever is selected")
            }
            web.sleep(600)
        }

        // The page re-checks the row against our comment's own text before it
        // clicks, so a list that shifted under us costs a retry rather than a
        // batch of hearts on somebody else's comment.
        when (web.z("submitRow(${live.i}, ${JSONObject.quote(want)})")) {
            true -> Unit
            "moved" -> return Visit(
                false,
                "The comment list moved just before the heart - not sending it to the wrong row",
                retryable = true,
            )
            else -> return Visit(false, "Could not click the heart button", retryable = true)
        }
        web.sleep(6_000)
        val body = web.zs("body()")

        // THE HEARTS TRICKLE IN AND THE TOTAL IS ROUTINELY SHORT. "50" is what
        // the dropdown says, not what arrives, and every answer below is from
        // the watched number instead. The wait is Zefoy's cooldown either way,
        // so it costs nothing to spend it reading.
        var after = live.hearts + send
        if (job.watchSeconds > 0) {
            val watched = watch(pick.text, live.hearts, job.watchSeconds, rivalHearts + job.margin)
            if (watched == null || watched == live.hearts) {
                // COULD NOT READ IT IS NOT ZERO. Hearts that arrive after the
                // watch gives up are counted by the next scan, which is the
                // honest place for them.
                log("  [*] asked for $send; could not read the count — the next scan will say")
                after = live.hearts + send
            } else {
                after = watched
                val landed = after - live.hearts
                if (landed != send) log("  [*] asked for $send, landed ${n(landed)} (${n(after)} now)")
            }
        }

        val left = maxOf(0, rivalHearts + job.margin - after)
        // CLEAR OF THE STRANGERS AND NOT THIN — and not while another of ours is
        // still behind. `isTop` is what stops the rounds, so it has to mean
        // "nothing left to do here".
        val clear = LikerRules.finishedAfter(after, rivalHearts, likes, job.floor)
        val nowTop = clear && othersLeft <= 0
        // A tie broken above is finished: another round would spend a second
        // batch on a comment that is already clear.
        var spent = d.action == LikerRules.Action.TIE_BREAK
        if (!spent && !nowTop && left > 0 && likes > 0) {
            spent = (likes * job.threshold).toInt() - after < LikerRules.HEART_OPTIONS.min()
        }

        val tail = when {
            nowTop -> " — now the top comment at ${n(after)} vs ${n(rivalHearts)}"
            clear -> " — clear at ${n(after)}, now on to our other $othersLeft comment(s) here"
            spent -> " — at ${n(after)}, about ${n(left)} short, and the ceiling is spent"
            else -> " — at ${n(after)}, about ${n(left)} short of the target"
        }
        val confirmed = body.contains("successfully sent") || body.contains("comment hearts")
        return Visit(
            true,
            (if (confirmed) "Sent $send hearts" else "Submitted $send hearts (not confirmed)") + tail,
            sent = send, isTop = nowTop, capped = spent,
        )
    }

    // ── reading the page ────────────────────────────────────────────────────

    private fun rowsNow(): List<Row> {
        val arr = web.zArray("rows()")
        val out = ArrayList<Row>(arr.length())
        for (k in 0 until arr.length()) {
            val o = arr.optJSONObject(k) ?: continue
            out += Row(
                i = o.optInt("i", k),
                text = o.optString("text"),
                hearts = o.optInt("hearts"),
                user = o.optString("user"),
                date = o.optString("date"),
            )
        }
        return out
    }

    /**
     * The comment's real heart count while the batch lands, or null if it could
     * not be read at all.
     *
     * Stops early when the target is reached (nothing more to learn) or when the
     * number has stopped moving (the batch has arrived).
     */
    private fun watch(text: String, baseline: Int, seconds: Int, want: Int): Int? {
        val want64 = key(text)
        val started = System.currentTimeMillis()
        var last = baseline
        var still = 0
        var moved = false
        var missing = 0
        while (System.currentTimeMillis() - started < seconds * 1_000L) {
            web.sleep(4_000)
            val hearts = rowsNow().firstOrNull { key(it.text) == want64 }?.hearts
            if (hearts == null) {
                // The list re-rendered, or collapsed back to the video summary.
                // A row that never comes back ends the watch with what was last
                // seen rather than with a zero.
                if (++missing >= 3) {
                    log("  [~] watch: the row went off screen; last seen at ${n(last)}")
                    break
                }
                continue
            }
            missing = 0
            if (hearts != last) {
                if (hearts > baseline) moved = true
                log("  [*] watch: ${n(last)} -> ${n(hearts)} (+${n(hearts - baseline)} so far)")
                last = hearts
                still = 0
            } else {
                still++
            }
            if (last >= want) {
                log("  [*] watch: target reached at ${n(last)}")
                break
            }
            if (moved && still >= 3) {
                log("  [*] watch: settled at ${n(last)}")
                break
            }
        }
        return if (last == baseline && !moved) null else last
    }

    private fun clickPage(nth: Int): Boolean {
        if (!web.zb("clickPage($nth)")) return false
        web.sleep(2_000)
        return true
    }

    /**
     * Get to comment page `nth`, whatever the pager is showing.
     *
     * IT CANNOT ALWAYS JUMP. Zefoy's pager is a sliding window: standing on page
     * 5 the buttons read 3 4 5 6 7 and there is no "1" to click, so reading four
     * pages and then going back for the comment on page 1 failed outright and
     * the video was abandoned with the heart never sent. The neighbour is always
     * inside the window, so this walks there a page at a time.
     */
    private fun gotoPage(nth: Int, cur: Int): Boolean {
        if (clickPage(nth)) return true
        if (cur == 0 || cur == nth) return false
        val step = if (nth > cur) 1 else -1
        var at = cur
        while (at != nth) {
            val next = at + step
            if (!clickPage(next)) return false
            at = next
        }
        return true
    }

    // ── small things ────────────────────────────────────────────────────────

    /** The folded head of a comment, used to find the same row again. */
    private fun key(text: String): String = LikerRules.fold(text).take(60)

    private fun n(v: Int): String = String.format("%,d", v)
    private fun pct(v: Double): String = "${Math.round(v * 100)}%"
}
