package com.repostearn.bubble

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The bubble's "expand" icon opens this: a native home for the dashboard's
 * earning tasks — pending pay, plus native Comments, Video task and Repost &
 * earn screens, and Finish. (No link list, no "clicked today".)
 */
class DashboardActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var pendingView: TextView
    private lateinit var pendingBreakdownView: TextView

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
            orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF0A0A0A.toInt())
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }
        bar.addView(TextView(this).apply {
            text = "✕  Close"; setTextColor(0xFFE5E7EB.toInt()); textSize = 15f
            setPadding(dp(8), dp(8), dp(12), dp(8)); setOnClickListener { finish() }
        })
        bar.addView(TextView(this).apply {
            text = "Dashboard"; setTextColor(Color.WHITE); textSize = 16f
            setTypeface(typeface, android.graphics.Typeface.BOLD); gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        bar.addView(TextView(this).apply {
            text = "⟳"; setTextColor(0xFF34D399.toInt()); textSize = 20f
            setPadding(dp(12), dp(6), dp(10), dp(8)); setOnClickListener { refreshStatus() }
        })
        root.addView(bar, mw())

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(10), dp(16), dp(24))
        }

        // Pending pay card
        val payCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0F1A15.toInt())
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(16) }
        }
        payCard.addView(TextView(this).apply {
            text = "PENDING PAY"; setTextColor(0xFF6B7280.toInt()); textSize = 11f
        })
        pendingView = TextView(this).apply {
            text = "—"; setTextColor(0xFF34D399.toInt()); textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD); setPadding(0, dp(2), 0, 0)
        }
        payCard.addView(pendingView)
        pendingBreakdownView = TextView(this).apply {
            text = ""; setTextColor(0xFF9CA3AF.toInt()); textSize = 13f; setPadding(0, dp(6), 0, 0)
        }
        payCard.addView(pendingBreakdownView)
        col.addView(payCard)

        // Task buttons. (The comments LIST is intentionally not shown — the bubble
        // auto-copies a random comment from the active-product pool on each Next.)
        col.addView(bigButton("🎥  Video task") { startActivity(Intent(this, VideoTaskActivity::class.java)) })
        col.addView(bigButton("📢  Repost & earn") { startActivity(Intent(this, PromoActivity::class.java)) })
        col.addView(bigButton("✅  Finish & report work") { openUrl(Config.FINISH_URL) })

        root.addView(ScrollView(this).apply { addView(col) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun refreshStatus() {
        val token = AuthStore.token(this) ?: return
        thread {
            val (c, b) = Net.get(Config.STATUS_URL, token)
            if (c == 401) { ui.post { signOut() }; return@thread }
            if (c == 200) StatusStore.set(this, b)
            ui.post { renderPending() }
        }
    }

    private fun renderPending() {
        val json = StatusStore.json(this)
        if (json == null) { pendingView.text = "—"; pendingBreakdownView.text = ""; return }
        try {
            val pending = JSONObject(json).optJSONObject("pending")
            val total = pending?.optDouble("total", 0.0) ?: 0.0
            val approvedBirr = pending?.optDouble("approvedBirr", 0.0) ?: 0.0
            val unapprovedBirr = pending?.optDouble("unapprovedBirr", 0.0) ?: 0.0
            if (total <= 0) {
                pendingView.text = "All paid ✓"
                pendingBreakdownView.text = ""
            } else {
                pendingView.text = "${fmtBirr(total)} birr"
                pendingBreakdownView.text =
                    "Approved: ${fmtBirr(approvedBirr)} birr\nUnapproved: ${fmtBirr(unapprovedBirr)} birr"
            }
        } catch (_: Exception) {
            pendingView.text = "—"; pendingBreakdownView.text = ""
        }
    }

    private fun bigButton(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label; isAllCaps = false; setTextColor(Color.WHITE); textSize = 16f
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            setBackgroundColor(0xFF059669.toInt()); minHeight = 0; minimumHeight = 0
            setPadding(dp(18), dp(16), dp(18), dp(16)); setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10) }
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
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
