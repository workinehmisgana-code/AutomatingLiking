package com.repostearn.bubble

import android.content.Context
import org.json.JSONObject

/**
 * What the dashboard tells the phone to do.
 *
 * The app holds no settings of its own. It asks on every start, so the numbers
 * an admin typed on `/admin/liker` are the ones this run uses — a handset in
 * somebody's pocket is the worst place to keep a value you want to change.
 */
data class LikerJob(
    val enabled: Boolean,
    val margin: Int,
    val rounds: Int,
    val watchSeconds: Int,
    val floor: Double,
    val threshold: Double,
    val toTop: Boolean,
    val products: List<String>,
    val links: List<Link>,
    val matched: Int,
    val note: String = "",
) {
    data class Link(val url: String, val likes: Int, val cluster: Int?)

    companion object {
        /** An answer that means "do nothing", with the reason to show. */
        fun off(note: String) = LikerJob(
            enabled = false, margin = 3, rounds = 4, watchSeconds = 45,
            floor = 0.25, threshold = 0.85, toTop = true,
            products = emptyList(), links = emptyList(), matched = 0, note = note,
        )

        fun parse(body: String): LikerJob {
            val o = JSONObject(body)
            if (!o.optBoolean("enabled", false)) {
                return off("Switched off on the dashboard — nothing to do.")
            }
            val s = o.optJSONObject("settings") ?: JSONObject()
            val products = mutableListOf<String>()
            o.optJSONArray("products")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val p = arr.optString(i).trim()
                    if (p.isNotEmpty()) products += p
                }
            }
            val links = mutableListOf<Link>()
            o.optJSONArray("links")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val l = arr.optJSONObject(i) ?: continue
                    val url = l.optString("url").trim()
                    if (url.isEmpty()) continue
                    links += Link(
                        url = url,
                        likes = l.optInt("likes", 0),
                        cluster = if (l.isNull("cluster")) null else l.optInt("cluster"),
                    )
                }
            }
            return LikerJob(
                enabled = true,
                margin = s.optInt("margin", 3),
                rounds = s.optInt("rounds", 4),
                watchSeconds = s.optInt("watch", 45),
                floor = s.optDouble("floor", 0.25),
                threshold = s.optDouble("threshold", 0.85),
                toTop = s.optBoolean("toTop", true),
                products = products,
                links = links,
                matched = o.optInt("matched", links.size),
            )
        }
    }
}

object LikerApi {
    val URL: String get() = "${Config.DASHBOARD}/api/app/liker"

    /** Ask for the settings and the links. Never throws: it returns the reason. */
    fun fetch(ctx: Context, token: String): LikerJob {
        val (code, body) = Net.get(URL, token, ctx)
        if (code == 401) return LikerJob.off("Signed out — open the app and sign in again.")
        if (code !in 200..299 || body.isBlank()) {
            return LikerJob.off("The dashboard did not answer (HTTP $code).")
        }
        return try {
            LikerJob.parse(body)
        } catch (e: Exception) {
            LikerJob.off("Could not read the dashboard's answer: ${e.message}")
        }
    }
}
