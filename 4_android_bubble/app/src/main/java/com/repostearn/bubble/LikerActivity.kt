package com.repostearn.bubble

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import kotlin.concurrent.thread

/**
 * Press Start and the phone does the hearting.
 *
 * TWO TABS, AND THE BROWSER ONE IS NOT A DEBUGGING AID. Zefoy asks for a captcha
 * and the phone does not read captchas, so the WebView has to be on screen and
 * usable: the engine stops, says "type the captcha", and waits for it to be
 * typed in exactly that view. Hiding the browser would make the app unable to
 * start.
 *
 * The screen is kept awake for the same reason it would be during a video call:
 * a WebView in a sleeping phone stops rendering, and Zefoy's flow is a sequence
 * of clicks on things that have to have been laid out.
 *
 * No setting is editable here. They live on the dashboard at `/admin/liker` and
 * are fetched on every Start, so a change there is what the next run uses — see
 * [LikerApi].
 */
class LikerActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())

    private lateinit var web: WebView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var statusView: TextView
    private lateinit var countsView: TextView
    private lateinit var startBtn: Button
    private lateinit var stopBtn: Button
    private lateinit var browserTab: TextView
    private lateinit var logTab: TextView

    private var driver: ZefoyWeb? = null
    private var worker: Thread? = null
    private val lines = StringBuilder()

    @Volatile
    private var running = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AuthStore.token(this) == null) {
            Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        showTab(browser = true)
        append("Settings and links come from the dashboard. Press Start.")
    }

    // ── layout ──────────────────────────────────────────────────────────────

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0A0A0A.toInt())
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }
        bar.addView(TextView(this).apply {
            text = "←  Back"
            setTextColor(0xFFE5E7EB.toInt()); textSize = 15f
            setPadding(dp(8), dp(8), dp(12), dp(8))
            setOnClickListener { leave() }
        })
        bar.addView(TextView(this).apply {
            text = "Comment liker"
            setTextColor(Color.WHITE); textSize = 16f
            setTypeface(typeface, Typeface.BOLD); gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        bar.addView(TextView(this).apply {
            text = "Copy log"
            setTextColor(0xFF34D399.toInt()); textSize = 13f
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setOnClickListener { copyLog() }
        })
        root.addView(bar, mw())

        // Status card
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0F1A15.toInt())
            setPadding(dp(14), dp(10), dp(14), dp(10))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { leftMargin = dp(10); rightMargin = dp(10); bottomMargin = dp(10) }
        }
        statusView = TextView(this).apply {
            text = "Idle"
            setTextColor(0xFF34D399.toInt()); textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
        }
        card.addView(statusView)
        countsView = TextView(this).apply {
            text = ""
            setTextColor(0xFF9CA3AF.toInt()); textSize = 13f
            setPadding(0, dp(3), 0, 0)
        }
        card.addView(countsView)
        root.addView(card)

        // Start / Stop
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), 0, dp(10), dp(10))
        }
        startBtn = Button(this).apply {
            text = "▶  Start"
            isAllCaps = false; setTextColor(Color.WHITE); textSize = 16f
            setBackgroundColor(0xFF059669.toInt()); minHeight = 0; minimumHeight = 0
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setOnClickListener { start() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                .apply { rightMargin = dp(8) }
        }
        buttons.addView(startBtn)
        stopBtn = Button(this).apply {
            text = "■  Stop"
            isAllCaps = false; setTextColor(Color.WHITE); textSize = 16f
            setBackgroundColor(0xFF3F3F46.toInt()); minHeight = 0; minimumHeight = 0
            setPadding(dp(14), dp(14), dp(14), dp(14))
            isEnabled = false
            setOnClickListener { stop() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        buttons.addView(stopBtn)
        root.addView(buttons, mw())

        // Tabs
        val tabs = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), 0, dp(10), dp(8))
        }
        browserTab = tab("Browser") { showTab(browser = true) }
        logTab = tab("Log") { showTab(browser = false) }
        tabs.addView(browserTab)
        tabs.addView(logTab)
        root.addView(tabs, mw())

        // The page itself
        web = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Android's WebView advertises itself with "; wv" in the UA and a
            // fair number of sites treat that as a bot. The rest of the string
            // is left exactly as the system built it.
            settings.userAgentString = settings.userAgentString.replace("; wv", "")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    driver?.noteLoad()
                }

                // Keep every navigation inside this WebView: a link that opens
                // Chrome takes the session with it.
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): Boolean = false
            }
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        root.addView(
            web,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        logView = TextView(this).apply {
            setTextColor(0xFFD4D4D8.toInt()); textSize = 12f
            typeface = Typeface.MONOSPACE
            setPadding(dp(12), dp(8), dp(12), dp(24))
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply {
            addView(logView)
            setBackgroundColor(0xFF09090B.toInt())
        }
        root.addView(
            logScroll,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        return root
    }

    private fun tab(label: String, onClick: () -> Unit): TextView = TextView(this).apply {
        text = label
        textSize = 14f; gravity = Gravity.CENTER
        setPadding(dp(10), dp(9), dp(10), dp(9))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            .apply { rightMargin = dp(6) }
    }

    private fun showTab(browser: Boolean) {
        web.visibility = if (browser) View.VISIBLE else View.GONE
        logScroll.visibility = if (browser) View.GONE else View.VISIBLE
        browserTab.setBackgroundColor(if (browser) 0xFF1F2937.toInt() else 0xFF111113.toInt())
        browserTab.setTextColor(if (browser) Color.WHITE else 0xFF9CA3AF.toInt())
        logTab.setBackgroundColor(if (browser) 0xFF111113.toInt() else 0xFF1F2937.toInt())
        logTab.setTextColor(if (browser) 0xFF9CA3AF.toInt() else Color.WHITE)
    }

    // ── the run ─────────────────────────────────────────────────────────────

    private fun start() {
        if (running) return
        val token = AuthStore.token(this) ?: return
        running = true
        startBtn.isEnabled = false
        stopBtn.isEnabled = true
        status("Asking the dashboard…")
        append("")
        append("── ${now()} ─────────────────────────")

        val d = ZefoyWeb(web)
        driver = d

        worker = thread(name = "liker") {
            try {
                val job = LikerApi.fetch(this, token)
                if (!job.enabled) {
                    ui.post {
                        // THE REASON GOES IN THE STATUS, not only the log.
                        //
                        // This said "Nothing to do" for every one of: switched
                        // off on the dashboard, signed out, and the dashboard
                        // not answering at all. Three different problems with
                        // three different fixes, shown identically, on the line
                        // somebody actually reads - the real reason was one tab
                        // away in the log and nobody went looking.
                        append("[!] ${job.note}")
                        status(job.note)
                        finished()
                    }
                    return@thread
                }
                if (job.links.isEmpty()) {
                    ui.post {
                        append("[!] The dashboard matched no links. Check the clusters and platform on /admin/liker.")
                        status("No links")
                        finished()
                    }
                    return@thread
                }
                if (job.products.isEmpty()) {
                    // Without a product there is nothing to tell our comments
                    // from everyone else's, and hearting the first row would
                    // push a stranger's comment. The Python runner refuses here
                    // for the same reason.
                    ui.post {
                        append("[!] No products are switched on, so there is no way to tell which comments are ours.")
                        status("No products")
                        finished()
                    }
                    return@thread
                }
                ui.post { append("Dashboard sent ${job.links.size} link(s) of ${job.matched} matching.") }

                ZefoyEngine(
                    web = d,
                    job = job,
                    log = { line -> ui.post { append(line) } },
                    status = { s -> ui.post { status(s) } },
                    progress = { done, total, hearts ->
                        ui.post {
                            countsView.text = "$done of $total done · ${String.format("%,d", hearts)} hearts sent"
                        }
                    },
                ).run()
            } catch (e: ZefoyWeb.Stopped) {
                ui.post { append("Stopped."); status("Stopped") }
            } catch (e: ZefoyWeb.Gone) {
                ui.post { append("[!] The page stopped answering: ${e.message}"); status("Lost the page") }
            } catch (e: Throwable) {
                ui.post { append("[!] ${e.javaClass.simpleName}: ${e.message}"); status("Failed") }
            } finally {
                ui.post { finished() }
            }
        }
    }

    private fun stop() {
        driver?.stop = true
        stopBtn.isEnabled = false
        status("Stopping…")
        append("Stopping after the current step…")
    }

    private fun finished() {
        running = false
        startBtn.isEnabled = true
        stopBtn.isEnabled = false
    }

    private fun leave() {
        if (running) {
            Toast.makeText(this, "Press Stop first", Toast.LENGTH_SHORT).show()
            return
        }
        finish()
    }

    override fun onBackPressed() {
        leave()
    }

    override fun onDestroy() {
        driver?.stop = true
        try {
            web.loadUrl("about:blank")
            web.destroy()
        } catch (e: Exception) {
            // Already gone.
        }
        super.onDestroy()
    }

    // ── log ─────────────────────────────────────────────────────────────────

    private fun append(line: String) {
        lines.append(line).append('\n')
        // A long run writes thousands of lines and a TextView holding all of
        // them is a TextView that stops scrolling smoothly.
        if (lines.length > 120_000) lines.delete(0, lines.length - 100_000)
        logView.text = lines
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun copyLog() {
        val cb = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cb.setPrimaryClip(ClipData.newPlainText("liker log", lines.toString()))
        Toast.makeText(this, "Log copied", Toast.LENGTH_SHORT).show()
    }

    private fun status(s: String) {
        statusView.text = s
    }

    private fun now(): String =
        android.text.format.DateFormat.format("HH:mm:ss", System.currentTimeMillis()).toString()

    private fun mw() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
