package com.repostearn.bubble

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** Native "Video task" screen: request access, upload videos, see submissions. */
class VideoTaskActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private val pickRequest = 5201
    private lateinit var content: LinearLayout
    private var status: String? = null
    private var payBirr = 100
    private var submissions = JSONArray()
    private var busy = false
    private var taskEnabled = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AuthStore.token(this) == null) { finish(); return }
        setContentView(buildScaffold("Video task"))
        load()
    }

    private fun buildScaffold(title: String): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0A0A0A.toInt())
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }
        bar.addView(TextView(this).apply {
            text = "←  Back"; setTextColor(0xFFE5E7EB.toInt()); textSize = 15f
            setPadding(dp(8), dp(8), dp(12), dp(8)); setOnClickListener { finish() }
        })
        bar.addView(TextView(this).apply {
            text = title; setTextColor(Color.WHITE); textSize = 16f
            setTypeface(typeface, android.graphics.Typeface.BOLD); gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        bar.addView(TextView(this).apply {
            text = "⟳"; setTextColor(0xFF34D399.toInt()); textSize = 20f
            setPadding(dp(12), dp(6), dp(10), dp(8)); setOnClickListener { load() }
        })
        root.addView(bar, mw())

        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(8), dp(14), dp(24))
        }
        val scroll = ScrollView(this).apply { addView(content) }
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun load() {
        val token = AuthStore.token(this) ?: return
        setInfo("Loading…")
        thread {
            val (c, b) = Net.get(Config.VIDEO_URL, token)
            ui.post {
                if (c == 401) { Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show(); finish(); return@post }
                if (c != 200) { setInfo("Couldn't load. Tap ⟳ to retry."); return@post }
                try {
                    val o = JSONObject(b)
                    status = o.optString("status").ifBlank { null }
                    payBirr = o.optInt("payBirr", 100)
                    submissions = o.optJSONArray("submissions") ?: JSONArray()
                    taskEnabled = o.optBoolean("taskEnabled", true)
                } catch (_: Exception) {}
                render()
            }
        }
    }

    private fun render() {
        content.removeAllViews()
        content.addView(card {
            addView(label("Create your own promo video", Color.WHITE, 15f, true))
            addView(label("Record a 30s–1min video, upload it here, and earn $payBirr birr per approved video.", 0xFF9CA3AF.toInt(), 12f))
        })

        if (!taskEnabled) {
            content.addView(card {
                addView(label("🎬 Video task paused", 0xFFFBBF24.toInt(), 14f, true))
                addView(label("The video task is currently turned off. Please check back later.", 0xFF9CA3AF.toInt(), 12f))
            })
            return
        }

        when (status) {
            null -> content.addView(card {
                addView(label("You haven't requested access yet.", 0xFFCBD5E1.toInt(), 13f))
                addView(primaryButton(if (busy) "Requesting…" else "Request access") { requestAccess() })
            })
            "pending" -> content.addView(card {
                addView(label("⏳ Access requested", 0xFFFBBF24.toInt(), 14f, true))
                addView(label("An admin will review and approve you soon. Check back later.", 0xFF9CA3AF.toInt(), 12f))
            })
            "rejected" -> content.addView(card {
                addView(label("Your request was declined.", 0xFFF87171.toInt(), 14f, true))
                addView(primaryButton(if (busy) "Requesting…" else "Request again") { requestAccess() })
            })
            "approved" -> content.addView(card {
                addView(label("✅ Approved — upload your videos", 0xFF34D399.toInt(), 14f, true))
                addView(primaryButton(if (busy) "Uploading…" else "⬆ Upload a video") { if (!busy) pickVideo() })
            })
        }

        // Submissions
        val submissionsCard = card {
            addView(label("Your submissions (${submissions.length()})", Color.WHITE, 14f, true))
        }
        if (submissions.length() == 0) {
            submissionsCard.addView(label("None yet.", 0xFF6B7280.toInt(), 12f))
        } else {
            for (i in 0 until submissions.length()) {
                val s = submissions.optJSONObject(i) ?: continue
                val paid = s.optBoolean("paid", false)
                val fn = s.optString("filename").ifBlank { "video ${i + 1}" }
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(8), 0, dp(8))
                }
                row.addView(label(fn, 0xFFD1D5DB.toInt(), 13f).apply {
                    maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                row.addView(label(if (paid) "paid ✓" else "pending", if (paid) 0xFF34D399.toInt() else 0xFFFBBF24.toInt(), 12f))
                submissionsCard.addView(row)
            }
        }
        content.addView(submissionsCard)
    }

    private fun requestAccess() {
        val token = AuthStore.token(this) ?: return
        busy = true; render()
        thread {
            val code = Net.postJson(Config.VIDEO_REQUEST_URL, token, JSONObject())
            ui.post {
                busy = false
                if (code in 200..299) { Toast.makeText(this, "Access requested", Toast.LENGTH_SHORT).show(); load() }
                else { Toast.makeText(this, "Couldn't request access", Toast.LENGTH_SHORT).show(); render() }
            }
        }
    }

    private fun pickVideo() {
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "video/*"; addCategory(Intent.CATEGORY_OPENABLE)
        }
        try { startActivityForResult(Intent.createChooser(intent, "Choose a video"), pickRequest) }
        catch (e: Exception) { Toast.makeText(this, "No file picker available", Toast.LENGTH_SHORT).show() }
    }

    @Deprecated("Framework file picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != pickRequest || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        uploadVideo(uri)
    }

    private fun uploadVideo(uri: Uri) {
        val token = AuthStore.token(this) ?: return
        var name = "video.mp4"; var size = 0L
        try {
            contentResolver.query(uri, null, null, null, null)?.use { cur: Cursor ->
                if (cur.moveToFirst()) {
                    val ni = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = cur.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0) name = cur.getString(ni) ?: name
                    if (si >= 0 && !cur.isNull(si)) size = cur.getLong(si)
                }
            }
        } catch (_: Exception) {}
        val mime = contentResolver.getType(uri) ?: "video/mp4"
        busy = true; render()
        Toast.makeText(this, "Uploading… keep the app open", Toast.LENGTH_LONG).show()
        val fname = name; val fsize = size
        thread {
            try {
                val blobUrl = BlobUpload.uploadVideo(this, token, uri, fname, mime, fsize)
                val code = Net.postJson(Config.VIDEO_SUBMIT_URL, token, JSONObject().apply {
                    put("url", blobUrl); put("filename", fname); put("size", fsize)
                })
                ui.post {
                    busy = false
                    if (code in 200..299) { Toast.makeText(this, "Video submitted ✓", Toast.LENGTH_SHORT).show(); load() }
                    else { Toast.makeText(this, "Uploaded, but saving failed ($code)", Toast.LENGTH_LONG).show(); render() }
                }
            } catch (e: Exception) {
                ui.post {
                    busy = false
                    Toast.makeText(this, e.message ?: "Upload failed", Toast.LENGTH_LONG).show(); render()
                }
            }
        }
    }

    // ── small view helpers ────────────────────────────────────────────────────
    private fun setInfo(msg: String) {
        content.removeAllViews()
        content.addView(label(msg, 0xFF9CA3AF.toInt(), 13f))
    }

    private fun card(build: LinearLayout.() -> Unit): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF12151C.toInt())
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
        c.build()
        return c
    }

    private fun label(text: String, color: Int, size: Float, bold: Boolean = false): TextView =
        TextView(this).apply {
            this.text = text; setTextColor(color); textSize = size
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, dp(2), 0, dp(2))
        }

    private fun primaryButton(text: String, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text; isAllCaps = false; setTextColor(Color.WHITE); textSize = 14f
            setBackgroundColor(0xFF059669.toInt()); minHeight = 0; minimumHeight = 0
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
        }

    private fun mw() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
