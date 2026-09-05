package com.repostearn.bubble

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** Native "Repost & earn" screen: account setup, videos, captions, submit links. */
class PromoActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var content: LinearLayout
    private var data: JSONObject? = null
    private var busy = false

    private data class Plat(val key: String, val label: String)
    private var platforms = listOf(Plat("tiktok", "TikTok"), Plat("youtube", "YouTube"), Plat("instagram", "Instagram"))
    private var payBirr = 10

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AuthStore.token(this) == null) { finish(); return }
        setContentView(buildScaffold())
        load()
    }

    private fun buildScaffold(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF0A0A0A.toInt())
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
            text = "Repost & earn"; setTextColor(Color.WHITE); textSize = 16f
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
        root.addView(ScrollView(this).apply { addView(content) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun load() {
        val token = AuthStore.token(this) ?: return
        setInfo("Loading…")
        thread {
            val (c, b) = Net.get(Config.PROMO_URL, token)
            ui.post {
                if (c == 401) { Toast.makeText(this, "Please sign in again", Toast.LENGTH_LONG).show(); finish(); return@post }
                if (c != 200) { setInfo("Couldn't load. Tap ⟳ to retry."); return@post }
                try {
                    val o = JSONObject(b)
                    data = o
                    payBirr = o.optInt("payBirr", 10)
                    o.optJSONArray("platforms")?.let { arr ->
                        val list = ArrayList<Plat>()
                        for (i in 0 until arr.length()) arr.optJSONObject(i)?.let {
                            list.add(Plat(it.optString("key"), it.optString("label")))
                        }
                        if (list.isNotEmpty()) platforms = list
                    }
                } catch (_: Exception) {}
                render()
            }
        }
    }

    private fun render() {
        content.removeAllViews()
        val o = data ?: run { setInfo("No data."); return }
        if (o.optBoolean("intro", false)) renderIntro(o) else renderTask(o)
    }

    // ── Intro: collect dedicated account links ────────────────────────────────
    private fun renderIntro(o: JSONObject) {
        val product = o.optString("product").ifBlank { "your product" }
        content.addView(card {
            addView(label("How it works", Color.WHITE, 15f, true))
            addView(label("1) Create a dedicated account on each platform for advertising $product.\n2) Download a video below and post it there.\n3) Copy a ready-made caption.\n4) Paste your post link back here — earn $payBirr birr per platform link.", 0xFF9CA3AF.toInt(), 12f))
        })
        val fields = HashMap<String, EditText>()
        val form = card {
            addView(label("Your dedicated accounts", Color.WHITE, 14f, true))
            addView(label("Add at least one to continue.", 0xFF9CA3AF.toInt(), 12f))
        }
        for (p in platforms) {
            form.addView(label("${p.label} profile link", 0xFF9CA3AF.toInt(), 11f))
            val e = editText("https://…/@your-${p.key}")
            fields[p.key] = e
            form.addView(e)
        }
        form.addView(primaryButton(if (busy) "Saving…" else "Save and start") {
            if (busy) return@primaryButton
            val body = JSONObject()
            var any = false
            for ((k, e) in fields) { val v = e.text.toString().trim(); if (v.isNotBlank()) { body.put(k, v); any = true } }
            if (!any) { Toast.makeText(this, "Add at least one link", Toast.LENGTH_SHORT).show(); return@primaryButton }
            postThen(Config.PROMO_ACCOUNT_URL, body, "Saved") { load() }
        })
        content.addView(form)
    }

    // ── Task: captions + videos ───────────────────────────────────────────────
    private fun renderTask(o: JSONObject) {
        val earned = countLinks(o) * payBirr
        content.addView(card {
            addView(label("Repost & earn", Color.WHITE, 15f, true))
            addView(label("Download a video, post it to your dedicated accounts, then submit each link for $payBirr birr. Earned so far: $earned birr.", 0xFF9CA3AF.toInt(), 12f))
        })

        // Captions (tap to copy)
        val groups = o.optJSONArray("captionGroups") ?: JSONArray()
        val caps = card { addView(label("Captions (tap to copy)", Color.WHITE, 14f, true)) }
        var capCount = 0
        for (gi in 0 until groups.length()) {
            val g = groups.optJSONObject(gi) ?: continue
            val list = g.optJSONArray("captions") ?: continue
            for (ci in 0 until list.length()) {
                val cap = list.optJSONObject(ci) ?: continue
                val text = cap.optString("text")
                if (text.isBlank()) continue
                capCount++
                caps.addView(TextView(this).apply {
                    this.text = cap.optString("title").ifBlank { text }
                    setTextColor(0xFFE5E7EB.toInt()); textSize = 13f
                    setPadding(dp(10), dp(10), dp(10), dp(10))
                    setBackgroundColor(0xFF15181F.toInt())
                    setOnClickListener { copy(text); Toast.makeText(this@PromoActivity, "Caption copied ✓", Toast.LENGTH_SHORT).show() }
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
                })
            }
        }
        if (capCount == 0) caps.addView(label("No captions yet.", 0xFF6B7280.toInt(), 12f))
        content.addView(caps)

        // Videos
        val videos = o.optJSONArray("videos") ?: JSONArray()
        val downloadLocked = o.optBoolean("downloadUsedToday", false)
        if (videos.length() == 0) {
            content.addView(card { addView(label("No videos available right now.", 0xFF6B7280.toInt(), 13f)) })
        }
        for (vi in 0 until videos.length()) {
            val v = videos.optJSONObject(vi) ?: continue
            content.addView(videoCard(v, downloadLocked))
        }
    }

    private fun videoCard(v: JSONObject, downloadLocked: Boolean): LinearLayout {
        val id = v.optInt("id")
        val url = v.optString("url")
        val downloaded = v.optBoolean("downloaded", false)
        val myLinks = v.optJSONArray("myLinks") ?: JSONArray()
        val submittedPlatforms = HashSet<String>()
        for (i in 0 until myLinks.length()) myLinks.optJSONObject(i)?.optString("platform")?.let { submittedPlatforms.add(it) }

        return card {
            addView(label(v.optString("filename").ifBlank { "Promo video" }, Color.WHITE, 14f, true))
            // Download / open
            val locked = downloadLocked && !downloaded
            addView(primaryButton(when {
                locked -> "🔒 Download locked (daily limit)"
                downloaded -> "⬇ Download again"
                else -> "⬇ Download video"
            }) {
                if (locked) { Toast.makeText(this@PromoActivity, "Daily download used — try tomorrow", Toast.LENGTH_SHORT).show(); return@primaryButton }
                downloadVideo(id, url)
            })
            // Per-platform submit
            addView(label("Submit your post link (one per account)", 0xFF9CA3AF.toInt(), 11f).apply { setPadding(0, dp(8), 0, dp(2)) })
            for (p in platforms) {
                if (submittedPlatforms.contains(p.key)) {
                    addView(label("${p.label}: submitted ✓", 0xFF34D399.toInt(), 12f))
                } else {
                    val e = editText("${p.label} post URL")
                    addView(e)
                    addView(ghostButton("Submit ${p.label}") {
                        val link = e.text.toString().trim()
                        if (!link.startsWith("http")) { Toast.makeText(this@PromoActivity, "Enter a valid link", Toast.LENGTH_SHORT).show(); return@ghostButton }
                        postThen(Config.PROMO_LINK_URL, JSONObject().apply { put("videoId", id); put("platform", p.key); put("url", link) }, "${p.label} link submitted — $payBirr birr") { load() }
                    })
                }
            }
        }
    }

    private fun downloadVideo(videoId: Int, url: String) {
        val token = AuthStore.token(this) ?: return
        thread {
            val code = Net.postJson(Config.PROMO_DOWNLOAD_URL, token, JSONObject().apply { put("videoId", videoId) })
            ui.post {
                if (code in 200..299) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    catch (_: Exception) { Toast.makeText(this, "Downloaded — open failed", Toast.LENGTH_SHORT).show() }
                    load()
                } else {
                    Toast.makeText(this, "Download locked (daily limit reached)", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────────
    private fun countLinks(o: JSONObject): Int {
        var n = 0
        val videos = o.optJSONArray("videos") ?: return 0
        for (i in 0 until videos.length()) n += videos.optJSONObject(i)?.optJSONArray("myLinks")?.length() ?: 0
        return n
    }

    private fun postThen(url: String, body: JSONObject, okMsg: String, onOk: () -> Unit) {
        val token = AuthStore.token(this) ?: return
        busy = true
        thread {
            val code = Net.postJson(url, token, body)
            ui.post {
                busy = false
                if (code in 200..299) { Toast.makeText(this, okMsg, Toast.LENGTH_SHORT).show(); onOk() }
                else Toast.makeText(this, "Failed ($code)", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun setInfo(msg: String) { content.removeAllViews(); content.addView(label(msg, 0xFF9CA3AF.toInt(), 13f)) }

    private fun copy(text: String) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("caption", text))
    }

    private fun card(build: LinearLayout.() -> Unit): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF12151C.toInt())
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10) }
        }
        c.build(); return c
    }

    private fun label(text: String, color: Int, size: Float, bold: Boolean = false): TextView =
        TextView(this).apply {
            this.text = text; setTextColor(color); textSize = size
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, dp(2), 0, dp(2))
        }

    private fun editText(hint: String): EditText =
        EditText(this).apply {
            this.hint = hint; setHintTextColor(0xFF6B7280.toInt()); setTextColor(Color.WHITE); textSize = 13f
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setBackgroundColor(0xFF0A0A0A.toInt())
            setPadding(dp(10), dp(10), dp(10), dp(10))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) }
        }

    private fun primaryButton(text: String, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text; isAllCaps = false; setTextColor(Color.WHITE); textSize = 14f
            setBackgroundColor(0xFF059669.toInt()); minHeight = 0; minimumHeight = 0
            setPadding(dp(12), dp(10), dp(12), dp(10)); setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
        }

    private fun ghostButton(text: String, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text; isAllCaps = false; setTextColor(0xFFE5E7EB.toInt()); textSize = 13f
            setBackgroundColor(0xFF1F2430.toInt()); minHeight = 0; minimumHeight = 0
            setPadding(dp(12), dp(8), dp(12), dp(8)); setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) }
        }

    private fun mw() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
