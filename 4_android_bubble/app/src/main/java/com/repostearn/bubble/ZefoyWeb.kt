package com.repostearn.bubble

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A WebView driven one blocking call at a time from a worker thread.
 *
 * WHY IT BLOCKS. The PC's runner is a straight line — fill the box, click
 * Search, read the rows, submit — and that is the shape the rules were written
 * and tested in. `evaluateJavascript` is a callback on the main thread, so the
 * same flow written natively becomes a state machine of nested callbacks, where
 * "wait up to fifteen seconds for the count button" stops being one line.
 *
 * So the orchestration runs on its own thread and every DOM call posts to the
 * main thread and waits for the answer. That is a deadlock the moment it is
 * called from the main thread, which is why [eval] refuses to.
 *
 * Two failures are told apart here because the engine treats them differently:
 * [Stopped] is the user pressing Stop and is not worth a word of complaint;
 * [Gone] is the page no longer answering, which is the phone's version of the
 * "browser went away" the Python runner reconnects on.
 */
class ZefoyWeb(private val web: WebView) {

    class Stopped : Exception("stopped")
    class Gone(message: String) : Exception(message)

    private val ui = Handler(Looper.getMainLooper())

    /** Bumped by the activity's WebViewClient so [load] can tell a page apart. */
    @Volatile
    private var loads = 0

    @Volatile
    var stop = false

    fun noteLoad() {
        loads++
    }

    // ── the bridge ──────────────────────────────────────────────────────────

    /** Evaluate a JS expression and block for its JSON result. Never on main. */
    fun eval(script: String, timeoutMs: Long = 15_000): String {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw IllegalStateException("ZefoyWeb.eval blocks and cannot run on the main thread")
        }
        if (stop) throw Stopped()
        val latch = CountDownLatch(1)
        var out = "null"
        ui.post {
            try {
                web.evaluateJavascript(script) { v ->
                    out = v ?: "null"
                    latch.countDown()
                }
            } catch (e: Throwable) {
                // A destroyed WebView throws here rather than calling back.
                out = "null"
                latch.countDown()
            }
        }
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            throw Gone("the page stopped answering after ${timeoutMs}ms")
        }
        if (stop) throw Stopped()
        return out
    }

    private fun decode(raw: String): Any? = try {
        if (raw.isBlank() || raw == "null") null else JSONTokener(raw).nextValue()
    } catch (e: Exception) {
        null
    }

    /** Call one of the injected driver's functions, e.g. `z("where()")`. */
    fun z(expr: String, timeoutMs: Long = 15_000): Any? = decode(
        eval(
            "(function(){try{return window.__Z ? window.__Z.$expr : null}catch(e){return null}})()",
            timeoutMs,
        )
    )

    fun zs(expr: String): String = z(expr)?.toString() ?: ""
    fun zb(expr: String): Boolean = z(expr) == true
    fun zi(expr: String): Int = when (val v = z(expr)) {
        is Number -> v.toInt()
        is String -> v.toIntOrNull() ?: 0
        else -> 0
    }

    /** A function that returns `JSON.stringify(...)`, parsed. */
    fun zArray(expr: String): JSONArray = try {
        JSONArray(zs(expr).ifBlank { "[]" })
    } catch (e: Exception) {
        JSONArray()
    }

    fun zObject(expr: String): JSONObject = try {
        JSONObject(zs(expr).ifBlank { "{}" })
    } catch (e: Exception) {
        JSONObject()
    }

    // ── navigation and waiting ──────────────────────────────────────────────

    /**
     * Put the driver back on the page if it is not there.
     *
     * Checked rather than assumed on every step: Zefoy navigates on its own (a
     * captcha submit is a form post) and an injected script does not survive
     * that. A `window.__Z` that quietly became undefined turns every later call
     * into `null`, which reads as "the element is not there" — a page that looks
     * broken when nothing is wrong but the injection.
     */
    fun ensure() {
        val kind = decode(eval("(function(){return typeof window.__Z})()"))?.toString()
        if (kind == "object") return
        eval(ZefoyScript.JS, 20_000)
    }

    fun load(url: String, seconds: Int = 60) {
        val before = loads
        ui.post { web.loadUrl(url) }
        // A load that never fires is not fatal on its own — the page may already
        // be the one we asked for — so this waits and then carries on.
        waitUntil(seconds) { loads != before }
        sleep(800)
        ensure()
    }

    /** Sleep, in pieces, so Stop is felt within a fraction of a second. */
    fun sleep(ms: Long) {
        var left = ms
        while (left > 0) {
            if (stop) throw Stopped()
            val step = minOf(left, 250L)
            try {
                Thread.sleep(step)
            } catch (e: InterruptedException) {
                throw Stopped()
            }
            left -= step
        }
        if (stop) throw Stopped()
    }

    /** Poll until the condition holds. Returns false on timeout. */
    fun waitUntil(seconds: Int, everyMs: Long = 400, cond: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + seconds * 1000L
        while (true) {
            if (stop) throw Stopped()
            if (cond()) return true
            if (System.currentTimeMillis() >= deadline) return false
            sleep(everyMs)
        }
    }
}
