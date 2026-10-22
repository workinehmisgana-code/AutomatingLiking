package com.repostearn.bubble

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The bubble's expand icon opens this: a native home for the earning tasks —
 * pending pay, then Video task, Repost & earn and the Comment liker, and
 * Finish. (No link list, no "clicked today".)
 *
 * The LOOK lives in Ui.kt, not here. This file decides what is on the screen
 * and in what order; it does not decide what a card's corner radius is, because
 * that is how four screens end up with four radii.
 */
class DashboardActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var pendingView: TextView
    private lateinit var pendingBreakdown: LinearLayout
    private lateinit var refreshView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AuthStore.token(this) == null) {
            Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show(); finish(); return
        }
        setContentView(buildUi())
        renderPending()
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        if (this::pendingView.isInitialized) renderPending() // reflect pay change after a task
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
        }
        root.addView(topBar(), mw())

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(6), dp(16), dp(28))
        }
        col.addView(payCard())
        col.addView(Ui.sectionLabel(this, "Tasks"))
        col.addView(
            Ui.taskRow(this, "🎥", "Video task", "Record and upload a short video") {
                startActivity(Intent(this, VideoTaskActivity::class.java))
            }
        )
        col.addView(
            Ui.taskRow(this, "📢", "Repost & earn", "Share a link on your own account") {
                startActivity(Intent(this, PromoActivity::class.java))
            }
        )
        col.addView(
            Ui.taskRow(this, "❤️", "Comment liker", "Send hearts to our comments") {
                startActivity(Intent(this, LikerActivity::class.java))
            }
        )
        col.addView(Ui.sectionLabel(this, "When you are done"))
        col.addView(Ui.primaryButton(this, "Finish & report work") { openUrl(Config.FINISH_URL) })

        root.addView(
            ScrollView(this).apply {
                isFillViewport = true
                addView(col)
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        return root
    }

    /** Close on the left, title centred, refresh on the right, over a hairline. */
    private fun topBar(): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(10), dp(6), dp(10))
        }
        bar.addView(TextView(this).apply {
            text = "‹  Close"
            setTextColor(Ui.MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(dp(10), dp(8), dp(12), dp(8))
            isClickable = true
            setOnClickListener { finish() }
        })
        bar.addView(TextView(this).apply {
            text = "Dashboard"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        refreshView = TextView(this).apply {
            text = "⟳"
            setTextColor(Ui.ACCENT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f)
            setPadding(dp(12), dp(6), dp(12), dp(8))
            isClickable = true
            setOnClickListener { refreshStatus() }
        }
        bar.addView(refreshView)
        wrap.addView(bar, mw())
        // A hairline, so the bar is a bar rather than the first thing in a list.
        wrap.addView(View(this).apply {
            setBackgroundColor(Ui.LINE)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1)
        })
        return wrap
    }

    /** What you are owed: the reason the screen is opened, so it leads. */
    private fun payCard(): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.card(this@DashboardActivity, Ui.CARD_HI, Ui.LINE_HI)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(12) }
        }
        card.addView(TextView(this).apply {
            text = "PENDING PAY"
            setTextColor(Ui.FAINT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            letterSpacing = 0.12f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        pendingView = TextView(this).apply {
            text = "—"
            setTextColor(Ui.ACCENT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, dp(4), 0, 0)
        }
        card.addView(pendingView)
        pendingBreakdown = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        card.addView(pendingBreakdown)
        return card
    }

    private fun refreshStatus() {
        val token = AuthStore.token(this) ?: return
        // Say it is working. A refresh icon that does nothing visible for a
        // second gets pressed again, and the second press is a second request.
        if (this::refreshView.isInitialized) refreshView.alpha = 0.35f
        thread {
            val (c, b) = Net.get(Config.STATUS_URL, token)
            if (c == 401) { ui.post { signOut() }; return@thread }
            if (c == 200) StatusStore.set(this, b)
            ui.post {
                refreshView.alpha = 1f
                renderPending()
            }
        }
    }

    private fun renderPending() {
        pendingBreakdown.removeAllViews()
        val json = StatusStore.json(this)
        if (json == null) { pendingView.text = "—"; return }
        try {
            val pending = JSONObject(json).optJSONObject("pending")
            val total = pending?.optDouble("total", 0.0) ?: 0.0
            val approvedBirr = pending?.optDouble("approvedBirr", 0.0) ?: 0.0
            val unapprovedBirr = pending?.optDouble("unapprovedBirr", 0.0) ?: 0.0
            if (total <= 0) {
                pendingView.text = "All paid ✓"
                return
            }
            pendingView.text = "${fmtBirr(total)} birr"
            // Two aligned lines instead of one wrapped string: the numbers are
            // what is being compared, so they line up down the right edge.
            pendingBreakdown.addView(
                Ui.statLine(this, "Approved", "${fmtBirr(approvedBirr)} birr", Ui.TEXT)
            )
            pendingBreakdown.addView(
                Ui.statLine(this, "Not yet approved", "${fmtBirr(unapprovedBirr)} birr", Ui.MUTED)
            )
        } catch (_: Exception) {
            pendingView.text = "—"
        }
    }

    private fun openUrl(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (e: Exception) { Toast.makeText(this, "Can't open this", Toast.LENGTH_SHORT).show() }
    }

    private fun signOut() {
        AuthStore.clear(this); Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show(); finish()
    }

    private fun fmtBirr(n: Double): String = if (n == Math.floor(n)) n.toLong().toString() else String.format("%.2f", n)
    private fun mw() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun dp(v: Int): Int = Ui.dp(this, v)
}
