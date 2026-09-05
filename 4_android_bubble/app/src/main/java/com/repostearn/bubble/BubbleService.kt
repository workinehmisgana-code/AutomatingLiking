package com.repostearn.bubble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlin.random.Random

/**
 * Foreground service that shows the floating bubble on top of every app. It
 * loads the signed-in user's links + assigned comments from the dashboard, and
 * each Next records the click (respecting the hourly limit) then opens the link.
 */
class BubbleService : Service() {

    private enum class PanelKind { PLATFORM, DETAILS }

    // A per-platform chip that shows the available count or a live reset timer.
    private class PlatformStat(val tv: TextView, val name: String, val available: Int, val resetAt: Long)

    private lateinit var wm: WindowManager
    private var view: View? = null
    private var panel: View? = null
    private var panelKind: PanelKind? = null
    private var panelFullWidth = false
    private lateinit var params: WindowManager.LayoutParams
    private var counterView: TextView? = null
    private var urlView: TextView? = null
    private var platformButton: Button? = null
    private var nextButton: Button? = null
    private var unrelatedButton: Button? = null
    /** The Next button's resting label, so the countdown can put it back. */
    private var nextLabel: CharSequence = "Next"
    private var cooldownTicker: Runnable? = null

    // Guards against a burst of taps: while an action (open/advance) is in flight —
    // and for a short cooldown after — Next/Unrelated are ignored, so users can't
    // skip several links before the video has loaded.
    private var busy = false
    // Set when the server refuses links because this app build is out of date. While
    // true the bubble tells the user to update instead of opening links.
    private var needsUpdate = false
    private var updateInfo: Pair<String, String>? = null // versionName, url
    private val ui = Handler(Looper.getMainLooper())
    private val platformStats = mutableListOf<PlatformStat>()
    private var statusTicker: Runnable? = null
    private var messageBanner: View? = null

    // We don't preview the pending link; a link only opens/navigates when the user
    // taps Next (or Unrelated). This is what the bubble shows while idle.
    private val nextHint = "Tap Next ▶ to open a link"
    private fun idleText(): String =
        if (LinkStore.size(this) > 0) nextHint else "No links — reopen to reload"

    @Suppress("DEPRECATION")
    private fun overlayType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else WindowManager.LayoutParams.TYPE_PHONE

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(1, buildNotification())
        addBubble()
        startUpdatePolling()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent != null) refreshData()
        return START_STICKY
    }

    // ── Bubble UI ────────────────────────────────────────────────────────────
    private fun addBubble() {
        if (view != null) return
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val v = LayoutInflater.from(this).inflate(R.layout.bubble, null)
        view = v

        @Suppress("DEPRECATION")
        val type =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else WindowManager.LayoutParams.TYPE_PHONE

        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 24; y = 220 }
        wm.addView(v, params)

        counterView = v.findViewById(R.id.counter)
        urlView = v.findViewById(R.id.urlText)
        platformButton = v.findViewById(R.id.btnPlatform)
        val next = v.findViewById<Button>(R.id.btnNext)
        val unrelated = v.findViewById<Button>(R.id.btnUnrelated)
        nextButton = next
        nextLabel = next.text
        unrelatedButton = unrelated
        val comments = v.findViewById<Button>(R.id.btnComments)
        // The comment LIST is no longer shown — the app auto-copies a random comment
        // from the admin's active-product pool on each Next. Hide the button.
        comments.visibility = View.GONE
        val details = v.findViewById<Button>(R.id.btnDetails)
        val expand = v.findViewById<Button>(R.id.btnExpand)
        val finish = v.findViewById<Button>(R.id.btnFinish)
        val closeTop = v.findViewById<TextView>(R.id.btnCloseTop)

        refreshCounter()
        updatePlatformLabel()
        urlView?.text = if (LinkStore.size(this) > 0) nextHint else "loading…"

        next.setOnClickListener { animateTap(it); onNext() }
        unrelated.setOnClickListener { animateTap(it); onMarkUnrelated() }
        platformButton?.setOnClickListener { togglePanel(PanelKind.PLATFORM) }
        details.setOnClickListener { togglePanel(PanelKind.DETAILS) }
        counterView?.setOnClickListener { togglePanel(PanelKind.DETAILS) }
        expand.setOnClickListener { openDashboard() }
        finish.setOnClickListener { animateTap(it); openUrl(Config.FINISH_URL) }
        closeTop.setOnClickListener { stopSelf() }

        // Drag from ANYWHERE on the bubble (buttons still tap; a move becomes a drag).
        (v as? DraggableLayout)?.dragListener = object : DraggableLayout.DragListener {
            private var baseX = 0
            private var baseY = 0
            override fun onDragStart() {
                baseX = params.x; baseY = params.y
                showCloseZone()
            }
            override fun onDrag(dx: Float, dy: Float) {
                params.x = baseX + dx.toInt()
                params.y = baseY + dy.toInt()
                wm.updateViewLayout(v, params)
                panel?.let { positionPanel(); wm.updateViewLayout(it, panelParams) }
                val over = isOverCloseZone()
                closeZone?.scaleX = if (over) 1.25f else 1f
                closeZone?.scaleY = if (over) 1.25f else 1f
            }
            override fun onDragEnd() {
                val closing = isOverCloseZone()
                hideCloseZone()
                if (closing) stopSelf()
            }
        }
    }

    // ── Drag-to-bottom to close ──────────────────────────────────────────────
    private var closeZone: View? = null

    private fun showCloseZone() {
        if (closeZone != null) return
        val tv = TextView(this).apply {
            text = "✕"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 24f
            gravity = Gravity.CENTER
            setBackgroundResource(R.drawable.close_zone_bg)
        }
        closeZone = tv
        val p = WindowManager.LayoutParams(
            dp(64), dp(64), overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; y = dp(48) }
        runCatching { wm.addView(tv, p) }
    }

    private fun hideCloseZone() {
        closeZone?.let { runCatching { wm.removeView(it) } }
        closeZone = null
    }

    // True when the bubble has been dragged into the bottom close area.
    private fun isOverCloseZone(): Boolean {
        val screenH = resources.displayMetrics.heightPixels
        val bubbleBottom = params.y + (view?.height ?: 0)
        return bubbleBottom > screenH - dp(150)
    }

    // Quick tap feedback: a small scale-down bounce so a click feels responsive.
    private fun animateTap(v: View) {
        v.animate().cancel()
        v.scaleX = 1f
        v.scaleY = 1f
        v.animate().scaleX(0.85f).scaleY(0.85f).setDuration(90).withEndAction {
            v.animate().scaleX(1f).scaleY(1f).setDuration(150).start()
        }.start()
    }

    private fun refreshCounter() {
        val n = LinkStore.size(this)
        // Progress = how many links opened so far (index), so it starts at 0 on
        // open and climbs to n as the user taps Next.
        val i = LinkStore.index(this).coerceIn(0, n)
        counterView?.text = if (n == 0) "…" else "$i/$n"
    }

    // How long the Next/Unrelated buttons stay locked after opening a link, so a
    // burst of taps can't skip several links before the video has loaded.
    // How long the actions stay dead after a link is opened.
    //
    // Randomised, not fixed: a tap at exactly the same interval every time is a
    // pattern in its own right, and the pause is also the point - it leaves room
    // to read the video and write the comment before the next link is queued,
    // instead of racing down the list.
    private val cooldownMinMs = 12_000L
    private val cooldownMaxMs = 22_000L

    private fun setActionsEnabled(enabled: Boolean) {
        nextButton?.isEnabled = enabled
        unrelatedButton?.isEnabled = enabled
        nextButton?.alpha = if (enabled) 1f else 0.5f
        unrelatedButton?.alpha = if (enabled) 1f else 0.5f
    }

    private fun lock() { busy = true; setActionsEnabled(false) }
    private fun unlock() { cancelCooldown(); busy = false; setActionsEnabled(true) }

    /**
     * Hold the actions closed for a random 12-22 seconds, counting down on the
     * button.
     *
     * The countdown is not decoration: a button that is simply dead for twenty
     * seconds reads as a broken app, and people force-close it and reopen it.
     * Showing the seconds turns the same wait into an obvious rule.
     *
     * Unrelated is held too - it calls openNextLink() itself, so leaving it live
     * would just be a second Next with no pause.
     */
    private fun startCooldown() {
        cancelCooldown()
        val endAt = SystemClock.elapsedRealtime() + Random.nextLong(cooldownMinMs, cooldownMaxMs + 1)
        val tick = object : Runnable {
            override fun run() {
                val left = endAt - SystemClock.elapsedRealtime()
                if (left <= 0L) {
                    cooldownTicker = null
                    unlock()
                    return
                }
                // Rounded up, so the last number shown is 1s rather than 0s.
                nextButton?.text = "$nextLabel  ${(left + 999L) / 1000L}s"
                ui.postDelayed(this, 250L)
            }
        }
        cooldownTicker = tick
        ui.post(tick)
    }

    private fun cancelCooldown() {
        cooldownTicker?.let { ui.removeCallbacks(it) }
        cooldownTicker = null
        nextButton?.text = nextLabel
    }

    // ── Next → record click, then open the link ──────────────────────────────
    private fun onNext() {
        if (busy) return
        openNextLink()
    }

    /**
     * Record a click on the next queued link and open it. This is the whole Next
     * flow minus the `busy` guard, so Unrelated can reuse it after flagging —
     * see onMarkUnrelated(). Callers are responsible for the guard.
     */
    private fun openNextLink() {
        if (needsUpdate) {
            updateInfo?.let { (vn, url) -> showUpdateBanner(vn, url) }
            Toast.makeText(this, "Update the app first to get links.", Toast.LENGTH_LONG).show()
            return
        }
        val item = LinkStore.peek(this)
        if (item == null) {
            Toast.makeText(this, "No more links — reopen the app to reload", Toast.LENGTH_SHORT).show()
            return
        }
        val token = AuthStore.token(this)
        if (token == null) { promptSignIn(); return }

        // Fallback only: used if the server's reply carries no comment (offline,
        // or an older server). Normally the SERVER chooses, so that each link's
        // comments are spread fairly across products.
        val fallback = CommentStore.pick(this)

        lock()
        thread {
            val (code, respBody) = postClick(token, item)
            val serverComment = try {
                JSONObject(respBody).optString("comment").ifBlank { null }
            } catch (e: Exception) {
                null
            }
            val commentText = serverComment ?: fallback?.text
            ui.post {
                when (code) {
                    401 -> { promptSignIn(); unlock() }
                    429 -> {
                        if (SettingsStore.platform(this).isBlank()) {
                            // "All platforms" mode → this platform's quota is done,
                            // jump to the next platform's links and show the details
                            // panel so the finished quota + reset timer are visible.
                            Toast.makeText(this, "${item.platform} hourly quota finished — moving to the next platform", Toast.LENGTH_LONG).show()
                            LinkStore.skipPlatform(this, item.platform)
                            urlView?.text = idleText()
                            refreshCounter()
                            refreshStatusThenShow() // opens Details with the finished quota timer
                        } else {
                            Toast.makeText(this, "Hourly limit reached for ${item.platform} — see the timer", Toast.LENGTH_LONG).show()
                            refreshStatusThenShow()
                        }
                        unlock()
                    }
                    else -> {
                        // 200 or a transient error → advance, then auto-copy a comment
                        // to the clipboard and open the link so the user can just paste.
                        LinkStore.advance(this)
                        urlView?.text = item.url
                        refreshCounter()
                        copyCommentThen(commentText) { openUrl(item.url) }
                        // Only this branch opened a link, so only this branch waits.
                        // A 401 or a spent quota unlocks at once: there is nothing to
                        // go and comment on.
                        startCooldown()
                    }
                }
            }
        }
    }

    // Flag the link the user is CURRENTLY on (the last one opened) as unrelated —
    // the server drops its click so it does NOT count toward the quota, and hides
    // it from this user from now on — then move straight on to the next link, so
    // one tap replaces "Unrelated, then Next".
    private fun onMarkUnrelated() {
        if (busy) return
        val token = AuthStore.token(this) ?: run { promptSignIn(); return }
        val current = LinkStore.current(this)
        if (current == null) {
            Toast.makeText(this, "Open a link first (tap Next)", Toast.LENGTH_SHORT).show()
            return
        }
        // Hold the guard across the flag request so a double tap can't flag twice
        // or race the advance.
        lock()
        thread {
            Net.postJson(Config.UNRELATED_URL, token, JSONObject().apply {
                put("url", current.url); put("platform", current.platform)
            }, this)
            ui.post {
                Toast.makeText(this, "Marked unrelated — moving to the next link", Toast.LENGTH_SHORT).show()
                // Hand the guard straight to the Next flow: unlock and re-enter in
                // the same UI turn, so no tap can slip in between. openNextLink()
                // takes the lock again itself, or leaves the buttons enabled if it
                // bails out (no links left / update required).
                unlock()
                openNextLink()
            }
        }
    }

    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Toast.makeText(this, "Can't open this link", Toast.LENGTH_SHORT).show()
        }
    }

    // Expand the bubble into the full, native in-app dashboard screen.
    private fun openDashboard() {
        val token = AuthStore.token(this)
        if (token == null) {
            Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show()
            return
        }
        try {
            startActivity(
                Intent(this, DashboardActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            Toast.makeText(this, "Couldn't open the dashboard", Toast.LENGTH_SHORT).show()
        }
    }

    // ── Panels (comments / platform) ─────────────────────────────────────────
    private lateinit var panelParams: WindowManager.LayoutParams

    private fun togglePanel(kind: PanelKind) {
        if (panel != null && panelKind == kind) { removePanel(); return }
        removePanel()
        panelKind = kind

        val p: View
        if (kind == PanelKind.DETAILS) {
            // Full-width "Details" panel (mirrors the dashboard strips).
            p = buildDetailsView()
            panelFullWidth = true
        } else {
            p = LayoutInflater.from(this).inflate(R.layout.comments_panel, null)
            val title = p.findViewById<TextView>(R.id.panelTitle)
            val list = p.findViewById<LinearLayout>(R.id.commentsList)
            buildPlatformPanel(title, list) // only the platform picker uses this panel now
            panelFullWidth = false
        }
        panel = p

        // Focusable (no NOT_FOCUSABLE) so the app has focus when tapping a row —
        // required for the clipboard copy to work on Android 10+. NOT_TOUCH_MODAL
        // lets taps outside the panel still reach the app behind it.
        panelParams = WindowManager.LayoutParams(
            if (panelFullWidth) WindowManager.LayoutParams.MATCH_PARENT else WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START }
        positionPanel()
        wm.addView(p, panelParams)

        // Let the hardware Back button close the panel (it has focus now).
        p.isFocusableInTouchMode = true
        p.requestFocus()
        p.setOnKeyListener { _, keyCode, e ->
            if (keyCode == KeyEvent.KEYCODE_BACK && e.action == KeyEvent.ACTION_UP) {
                removePanel(); true
            } else false
        }
    }

    private fun buildPlatformPanel(title: TextView, list: LinearLayout) {
        title.text = "Choose platform"
        val current = SettingsStore.platform(this)
        SettingsStore.PLATFORMS.forEach { (name, value) ->
            val label = if (value == current) "●  $name" else name
            list.addView(makeCommentRow(label) {
                SettingsStore.setPlatform(this, value)
                updatePlatformLabel()
                removePanel()
                Toast.makeText(this, "Loading $name…", Toast.LENGTH_SHORT).show()
                refreshData()
            })
        }
    }

    private fun updatePlatformLabel() {
        platformButton?.text = "${SettingsStore.platformLabel(this)} ▾"
    }

    // ── Admin messages (banner on top of the bubble, own close per message) ──
    private fun showMessages(msgs: List<Pair<Int, String>>) {
        removeMessageBanner()
        if (msgs.isEmpty()) return
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bubble_bg)
            setPadding(14, 10, 8, 10)
        }
        val header = TextView(this).apply {
            text = "Message from admin"
            setTextColor(0xFF34D399.toInt())
            textSize = 11f
            setPadding(2, 0, 2, 6)
        }
        container.addView(header)
        msgs.forEach { (id, body) -> container.addView(makeMessageRow(id, body, container)) }
        messageBanner = container

        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 0; y = 24 }
        wm.addView(container, p)
    }

    private fun makeMessageRow(id: Int, body: String, container: LinearLayout): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val msgText = TextView(this).apply {
            text = body
            setTextColor(0xFFE5E7EB.toInt())
            textSize = 13f
            setPadding(2, 8, 8, 8)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val close = TextView(this).apply {
            text = "✕"
            setTextColor(0xFF9CA3AF.toInt())
            textSize = 16f
            setPadding(16, 8, 12, 8)
        }
        close.setOnClickListener {
            dismissMessage(id)
            container.removeView(row)
            // header + rows; when only the header is left, hide the banner.
            if (container.childCount <= 1) removeMessageBanner()
        }
        row.addView(msgText)
        row.addView(close)
        return row
    }

    private fun dismissMessage(id: Int) {
        val token = AuthStore.token(this) ?: return
        thread {
            try {
                val c = (URL(Config.MESSAGES_URL).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; doOutput = true
                    setRequestProperty("Authorization", "Bearer $token")
                    setRequestProperty("Content-Type", "application/json")
                    connectTimeout = 15000; readTimeout = 20000
                }
                c.outputStream.use { it.write(JSONObject().put("id", id).toString().toByteArray()) }
                c.responseCode
            } catch (_: Exception) {
            }
        }
    }

    private fun removeMessageBanner() {
        messageBanner?.let { runCatching { wm.removeView(it) } }
        messageBanner = null
    }

    // ── Details panel (mirrors the dashboard's clicked-today / pending / platforms) ──
    private fun buildDetailsView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xF00A0A0A.toInt())
            setPadding(dp(12), dp(10), dp(12), dp(12))
        }
        populateDetails(root, null)
        val token = AuthStore.token(this) ?: run {
            populateDetails(root, "Not signed in — reopen the app to sign in.")
            return root
        }
        thread {
            val (c, b) = httpGet(Config.STATUS_URL, token)
            ui.post {
                if (panelKind != PanelKind.DETAILS || panel == null) return@post
                when {
                    c == 200 -> { StatusStore.set(this, b); checkForUpdate(b); populateDetails(root, null) }
                    c == 404 -> populateDetails(root, "Details endpoint missing (404) — redeploy the dashboard.")
                    c == 401 -> populateDetails(root, "Session expired (401) — reopen the app to sign in.")
                    else -> populateDetails(root, "Couldn't load details (HTTP $c).")
                }
            }
        }
        return root
    }

    private fun populateDetails(root: LinearLayout, error: String?) {
        statusTicker?.let { ui.removeCallbacks(it) }
        statusTicker = null
        platformStats.clear()
        root.removeAllViews()

        var email = ""
        var today: JSONObject? = null
        var pending: JSONObject? = null
        var platforms: JSONObject? = null
        // Server controls whether the "Clicked today" card shows (SHOW_CLICKED_TODAY env).
        var showClickedToday = true
        val json = StatusStore.json(this)
        if (json != null) {
            try {
                val o = JSONObject(json)
                email = o.optString("email")
                today = o.optJSONObject("today")
                pending = o.optJSONObject("pending")
                platforms = o.optJSONObject("platforms")
                showClickedToday = o.optBoolean("showClickedToday", true)
            } catch (_: Exception) {}
        }

        root.addView(detailsHeader())
        if (email.isNotBlank()) root.addView(label("Signed in as $email", 0xFF6B7280.toInt(), 10f))
        if (error != null) root.addView(label("⚠ $error", 0xFFF87171.toInt(), 12f))
        if (showClickedToday) root.addView(clickedTodayCard(today))
        root.addView(pendingCard(pending))
        root.addView(platformsCard(platforms))
        startDetailsTicker()
    }

    private fun detailsHeader(): View {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        row.addView(label("Details", 0xFFFFFFFF.toInt(), 15f, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        row.addView(TextView(this).apply {
            text = "✕"; setTextColor(0xFF9CA3AF.toInt()); textSize = 16f
            setPadding(dp(12), dp(4), dp(6), dp(4))
            setOnClickListener { removePanel() }
        })
        return row
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun fmtBirr(d: Double): String =
        if (d == d.toLong().toDouble()) d.toLong().toString()
        else "%.2f".format(d).trimEnd('0').trimEnd('.')

    private fun label(text: String, color: Int, sizeSp: Float, bold: Boolean = false): TextView =
        TextView(this).apply {
            this.text = text; setTextColor(color); textSize = sizeSp
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.bubble_bg)
        setPadding(dp(10), dp(9), dp(10), dp(9))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) }
    }

    private fun hScroll(row: View): HorizontalScrollView = HorizontalScrollView(this).apply {
        isHorizontalScrollBarEnabled = false
        addView(row)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        )
    }

    private fun rowH(): LinearLayout =
        LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }

    private fun clickedTodayCard(today: JSONObject?): View {
        val c = card()
        val plats = listOf(
            Triple("tiktok", "TikTok", 0xFFEC4899.toInt()),
            Triple("youtube_shorts", "YT Shorts", 0xFFF97316.toInt()),
            Triple("youtube_videos", "YT Videos", 0xFFEF4444.toInt()),
            Triple("instagram", "Instagram", 0xFFD946EF.toInt()),
        )
        var total = 0
        plats.forEach { (k, _, _) -> total += today?.optInt(k, 0) ?: 0 }
        val strip = rowH()
        strip.addView(label("CLICKED TODAY · $total", 0xFF9CA3AF.toInt(), 11f, bold = true).apply { setPadding(0, 0, dp(12), 0) })
        plats.forEach { (k, name, color) ->
            val row = rowH().apply { setPadding(0, 0, dp(12), 0) }
            row.addView(label("●", color, 12f).apply { setPadding(0, 0, dp(4), 0) })
            row.addView(label(name, 0xFF9CA3AF.toInt(), 12f).apply { setPadding(0, 0, dp(4), 0) })
            row.addView(label((today?.optInt(k, 0) ?: 0).toString(), 0xFFFFFFFF.toInt(), 13f, bold = true))
            strip.addView(row)
        }
        c.addView(hScroll(strip))
        return c
    }

    private fun pendingCard(pending: JSONObject?): View {
        val c = card()
        val total = pending?.optDouble("total", 0.0) ?: 0.0
        val approved = pending?.optBoolean("approved", false) ?: false
        val strip = rowH()
        val head = rowH().apply { setPadding(0, 0, dp(12), 0) }
        head.addView(label("PENDING PAY · ", 0xFF9CA3AF.toInt(), 11f, bold = true))
        head.addView(label("${fmtBirr(total)} BIRR", 0xFF34D399.toInt(), 12f, bold = true).apply { setPadding(0, 0, dp(4), 0) })
        if (total > 0.0) head.addView(
            label(if (approved) "(Approved)" else "(Unapproved)", if (approved) 0xFF34D399.toInt() else 0xFFFBBF24.toInt(), 11f, bold = true)
        )
        strip.addView(head)
        strip.addView(payChip("Comments", pending?.optJSONObject("comments")))
        strip.addView(payChip("Video", pending?.optJSONObject("video")))
        strip.addView(payChip("Repost", pending?.optJSONObject("promo")))
        c.addView(hScroll(strip))
        return c
    }

    private fun payChip(name: String, obj: JSONObject?): View {
        val birr = obj?.optDouble("birr", 0.0) ?: 0.0
        val count = obj?.optInt("count", 0) ?: 0
        val row = rowH().apply { setPadding(0, 0, dp(12), 0) }
        row.addView(label(name, 0xFF9CA3AF.toInt(), 12f).apply { setPadding(0, 0, dp(4), 0) })
        row.addView(label(fmtBirr(birr), 0xFFE5E7EB.toInt(), 13f, bold = true).apply { setPadding(0, 0, dp(3), 0) })
        row.addView(label("($count)", 0xFF6B7280.toInt(), 11f))
        return row
    }

    private fun platformsCard(platforms: JSONObject?): View {
        val c = card()
        val fetchedAt = StatusStore.fetchedAt(this)
        val strip = rowH()
        listOf("tiktok" to "TikTok", "youtube_shorts" to "YT Shorts", "youtube_videos" to "YT Videos", "instagram" to "Instagram")
            .forEach { (key, name) ->
                val pj = platforms?.optJSONObject(key)
                val available = pj?.optInt("available", 0) ?: 0
                val resetInMs = pj?.optLong("resetInMs", 0L) ?: 0L
                val resetAt = if (resetInMs > 0 && fetchedAt > 0) fetchedAt + resetInMs else 0L
                val chip = platformChip("")
                platformStats.add(PlatformStat(chip, name, available, resetAt))
                strip.addView(chip)
            }
        listOf("Reddit", "X", "Blog Post").forEach { name ->
            strip.addView(platformChip("$name  soon").apply { alpha = 0.45f })
        }
        c.addView(hScroll(strip))
        return c
    }

    private fun platformChip(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(0xFFE5E7EB.toInt())
        textSize = 13f
        setBackgroundResource(R.drawable.btn_ghost_bg)
        setPadding(dp(12), dp(8), dp(12), dp(8))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = dp(6) }
    }

    private fun startDetailsTicker() {
        statusTicker?.let { ui.removeCallbacks(it) }
        val r = object : Runnable {
            override fun run() {
                val now = System.currentTimeMillis()
                platformStats.forEach { s ->
                    s.tv.text =
                        if (s.resetAt > 0 && s.resetAt - now > 0) "${s.name}  🔒 ${mmss(s.resetAt - now)}"
                        else "${s.name}  ${s.available}"
                }
                if (panelKind == PanelKind.DETAILS) ui.postDelayed(this, 1000)
            }
        }
        statusTicker = r
        ui.post(r)
    }

    private fun mmss(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return "%d:%02d".format(s / 60, s % 60)
    }


    private fun positionPanel() {
        panelParams.x = if (panelFullWidth) 0 else params.x
        panelParams.y = params.y + (view?.height ?: dp(120)) + dp(6)
    }

    private fun removePanel() {
        statusTicker?.let { ui.removeCallbacks(it) }
        statusTicker = null
        platformStats.clear()
        panel?.let { runCatching { wm.removeView(it) } }
        panel = null
        panelKind = null
    }

    private val ROW_BG = 0x22FFFFFF          // idle row background
    private val ROW_BG_FLASH = 0x6634D399    // brief emerald flash on tap

    private fun makeCommentRow(text: String, onClick: (() -> Unit)?): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.setTextColor(0xFFE5E7EB.toInt())
        tv.textSize = 13f
        tv.setPadding(12, 12, 12, 12)
        tv.setBackgroundColor(ROW_BG)
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 8 }
        tv.layoutParams = lp
        if (onClick != null) tv.setOnClickListener {
            // Flash the background briefly to show it was tapped.
            tv.setBackgroundColor(ROW_BG_FLASH)
            ui.postDelayed({ runCatching { tv.setBackgroundColor(ROW_BG) } }, 300)
            onClick()
        }
        return tv
    }

    // Copy [text] — the comment already chosen for this link by the caller, see
    // onNext/openNextLink — so each Next pre-loads a comment ready to paste, THEN
    // run [after]. The caller picks it (rather than this function) so the same
    // comment's product can be reported with the click. A clipboard write is only
    // honored on Android 10+ while our window has focus, so we briefly flip the
    // bubble to focusable, write, revert, and only then continue (the link opens
    // after the comment is set).
    private fun copyCommentThen(text: String?, after: () -> Unit) {
        val v = view
        if (text.isNullOrBlank() || v == null) { after(); return }

        // Focusable (+ NOT_TOUCH_MODAL so touches still pass through) for the write.
        params.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        runCatching { wm.updateViewLayout(v, params) }
        ui.postDelayed({
            runCatching {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("comment", text))
            }
            // Revert to the normal non-focusable overlay.
            params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            runCatching { wm.updateViewLayout(v, params) }
            after()
        }, 120)
    }

    // ── Networking ───────────────────────────────────────────────────────────
    private fun refreshData() {
        val token = AuthStore.token(this) ?: run { ui.post { promptSignIn() }; return }
        thread {
            // Links (for the currently selected platform)
            val (lc, lb) = httpGet(Config.linksUrl(SettingsStore.platform(this)), token)
            if (lc == 401) { ui.post { promptSignIn() }; return@thread }
            // Version gate: the server sends updateRequired=true (and no links) when
            // this build is older than the published APK. Force an update first.
            needsUpdate = false
            updateInfo = null
            if (lc == 200) {
                try {
                    val o = JSONObject(lb)
                    if (o.optBoolean("updateRequired", false)) {
                        needsUpdate = true
                        val upd = o.optJSONObject("update")
                        val vn = upd?.optString("versionName").orEmpty()
                        val url = upd?.optString("url").orEmpty()
                        if (vn.isNotBlank() && url.isNotBlank()) updateInfo = vn to url
                        LinkStore.setFromJson(this, "[]") // clear any stale links
                    } else {
                        val arr = o.optJSONArray("links")
                        LinkStore.setFromJson(this, (arr ?: org.json.JSONArray()).toString())
                    }
                } catch (_: Exception) {}
            }
            // Comments
            val (cc, cb) = httpGet(Config.COMMENTS_URL, token)
            if (cc == 200) {
                try {
                    val o = JSONObject(cb)
                    CommentStore.set(
                        this,
                        o.optString("product").ifBlank { null },
                        o.optJSONArray("comments")?.toString() ?: "[]",
                        // Index-aligned with `comments`; absent on older servers.
                        o.optJSONArray("commentProducts")?.toString() ?: "[]",
                    )
                } catch (_: Exception) {}
            }
            // Quota status
            val (stc, stb) = httpGet(Config.STATUS_URL, token)
            if (stc == 200) {
                StatusStore.set(this, stb)
                checkForUpdate(stb)
            }
            // Admin messages
            val (mc, mb) = httpGet(Config.MESSAGES_URL, token)
            val msgs = mutableListOf<Pair<Int, String>>()
            if (mc == 200) {
                try {
                    val arr = JSONObject(mb).optJSONArray("messages")
                    if (arr != null) for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        val body = o.optString("body")
                        if (body.isNotBlank()) msgs.add(o.optInt("id") to body)
                    }
                } catch (_: Exception) {}
            }
            ui.post {
                // Only when nothing is cooling down. This runs on the background
                // refresh, and unlocking here would hand back a Next button the
                // cooldown is deliberately holding shut.
                if (cooldownTicker == null) unlock()
                refreshCounter()
                showMessages(msgs)
                if (needsUpdate) {
                    updateInfo?.let { (vn, url) -> showUpdateBanner(vn, url) }
                    urlView?.text = "Update required — tap Download to update"
                    Toast.makeText(this, "Please update the app to keep getting links.", Toast.LENGTH_LONG).show()
                } else {
                    urlView?.text = idleText()
                    Toast.makeText(this, "Loaded ${LinkStore.size(this)} links", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // Parse the status JSON's "update" block. If a newer APK (higher versionName)
    // has been published, show a prompt banner with an "Update" button — we never
    // download automatically; the user must tap Update.
    private fun checkForUpdate(statusJson: String) {
        try {
            val upd = JSONObject(statusJson).optJSONObject("update") ?: return
            val vn = upd.optString("versionName", "")
            val url = upd.optString("url", "")
            if (vn.isNotBlank() && url.isNotBlank() && ApkUpdater.isUpdateAvailable(this, vn)) {
                ui.post { showUpdateBanner(vn, url) }
            }
        } catch (_: Exception) {}
    }

    // ── Update prompt (banner with an Update button; download is user-initiated) ──
    private var updateBanner: View? = null
    private var updateBannerVersion: String? = null

    private fun showUpdateBanner(versionName: String, url: String) {
        // Already prompting for this exact version → don't rebuild it.
        if (updateBanner != null && updateBannerVersion == versionName) return
        removeUpdateBanner()
        updateBannerVersion = versionName

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bubble_bg)
            setPadding(dp(14), dp(10), dp(8), dp(10))
        }
        val msg = TextView(this).apply {
            text = "Update available · v$versionName"
            setTextColor(0xFFE5E7EB.toInt())
            textSize = 13f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val updateBtn = Button(this).apply {
            this.text = "Download"
            setAllCaps(false)
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 13f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setBackgroundResource(R.drawable.btn_next_bg)
            minWidth = 0; minHeight = 0
            setPadding(dp(16), dp(7), dp(16), dp(7))
        }
        updateBtn.setOnClickListener {
            // Open the APK in the browser; the user installs it manually.
            ApkUpdater.openDownload(this, url)
            removeUpdateBanner()
        }
        val close = TextView(this).apply {
            text = "✕"
            setTextColor(0xFF9CA3AF.toInt())
            textSize = 16f
            setPadding(dp(12), dp(6), dp(8), dp(6))
            setOnClickListener { removeUpdateBanner() }
        }
        container.addView(msg)
        container.addView(updateBtn)
        container.addView(close)
        updateBanner = container

        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 0; y = 0 }
        runCatching { wm.addView(container, p) }
    }

    private fun removeUpdateBanner() {
        updateBanner?.let { runCatching { wm.removeView(it) } }
        updateBanner = null
        updateBannerVersion = null
    }

    // Poll the status endpoint every 30 min while the bubble is alive so a newly
    // published APK installs itself even if the user never restarts the app.
    private var updatePoll: Runnable? = null
    private fun startUpdatePolling() {
        val r = object : Runnable {
            override fun run() {
                val token = AuthStore.token(this@BubbleService)
                if (token != null) thread {
                    val (c, b) = httpGet(Config.STATUS_URL, token)
                    if (c == 200) {
                        StatusStore.set(this@BubbleService, b)
                        checkForUpdate(b)
                    }
                }
                ui.postDelayed(this, 30 * 60 * 1000L)
            }
        }
        updatePoll = r
        ui.postDelayed(r, 30 * 60 * 1000L) // startup already checks; first poll in 30 min
    }

    private fun httpGet(urlStr: String, token: String): Pair<Int, String> {
        return try {
            val c = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Authorization", "Bearer $token")
                AppInfo.headers(this@BubbleService).forEach { (k, v) -> setRequestProperty(k, v) }
                connectTimeout = 15000; readTimeout = 20000
            }
            val code = c.responseCode
            val body = (if (code in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            code to body
        } catch (e: Exception) {
            -1 to ""
        }
    }

    /** POST the click; returns the HTTP status (or -1 on network error). */
    /**
     * Record the click. Returns (httpStatus, responseBody).
     *
     * The server picks which product's comment to serve for this link — fairly,
     * balancing each link's comment mix — and returns it in the body, so we no
     * longer send a product of our own. The cached pool is only a fallback for
     * when the response carries no comment (offline, older server).
     */
    private fun postClick(token: String, item: LinkStore.Item): Pair<Int, String> {
        return try {
            val c = (URL(Config.CLICK_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Content-Type", "application/json")
                AppInfo.headers(this@BubbleService).forEach { (k, v) -> setRequestProperty(k, v) }
                connectTimeout = 15000; readTimeout = 20000
            }
            val body = JSONObject().apply {
                put("url", item.url); put("platform", item.platform); put("search_query", item.query)
            }.toString()
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            val text = try {
                val stream = if (code in 200..299) c.inputStream else c.errorStream
                stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            } catch (e: Exception) {
                ""
            }
            code to text
        } catch (e: Exception) {
            -1 to ""
        }
    }

    // Pull fresh status, then open the Details panel so the reset timer shows.
    private fun refreshStatusThenShow() {
        val token = AuthStore.token(this) ?: return
        thread {
            val (c, b) = httpGet(Config.STATUS_URL, token)
            if (c == 200) { StatusStore.set(this, b); checkForUpdate(b) }
            ui.post {
                removePanel()
                togglePanel(PanelKind.DETAILS)
            }
        }
    }

    private fun promptSignIn() {
        AuthStore.clear(this)
        Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show()
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Config.LOGIN_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun buildNotification(): Notification {
        val channelId = "bubble"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(channelId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(channelId, "Next-link bubble", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        @Suppress("DEPRECATION")
        val b =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, channelId)
            else Notification.Builder(this)
        return b.setContentTitle("Next-link bubble running")
            .setContentText("Tap the floating Next button to open links")
            .setSmallIcon(android.R.drawable.ic_menu_send)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        updatePoll?.let { ui.removeCallbacks(it) }
        updatePoll = null
        cooldownTicker?.let { ui.removeCallbacks(it) }
        cooldownTicker = null
        removePanel()
        removeMessageBanner()
        removeUpdateBanner()
        hideCloseZone()
        view?.let { runCatching { wm.removeView(it) } }
        view = null
    }
}
