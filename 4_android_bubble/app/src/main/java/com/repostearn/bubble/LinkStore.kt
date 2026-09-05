package com.repostearn.bubble

import android.content.Context
import org.json.JSONArray

/**
 * Holds the user's link list (as returned by /api/app/links) and the current
 * position. Each item keeps the platform + search_query so a click can be
 * recorded correctly on the dashboard.
 */
object LinkStore {
    data class Item(val url: String, val platform: String, val query: String)

    private const val PREFS = "bubble_links"
    private const val KEY_LINKS = "links_json"
    private const val KEY_INDEX = "index"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Replace the list from the API's `links` array (JSON string) and reset. */
    fun setFromJson(ctx: Context, linksJson: String) {
        prefs(ctx).edit().putString(KEY_LINKS, linksJson).putInt(KEY_INDEX, 0).apply()
    }

    fun items(ctx: Context): List<Item> {
        val s = prefs(ctx).getString(KEY_LINKS, "").orEmpty()
        if (s.isBlank()) return emptyList()
        return try {
            val arr = JSONArray(s)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val url = o.optString("url")
                if (url.isBlank()) null
                else Item(url, o.optString("platform"), o.optString("search_query"))
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun size(ctx: Context): Int = items(ctx).size
    fun index(ctx: Context): Int = prefs(ctx).getInt(KEY_INDEX, 0)

    /** The item the next tap will open (without advancing). */
    fun peek(ctx: Context): Item? = items(ctx).getOrNull(index(ctx))

    /** The link the user is currently on — the last one opened (index - 1), or
     *  null if nothing has been opened yet. */
    fun current(ctx: Context): Item? = items(ctx).getOrNull(index(ctx) - 1)

    fun advance(ctx: Context) {
        prefs(ctx).edit().putInt(KEY_INDEX, index(ctx) + 1).apply()
    }

    /**
     * Skip the rest of the current platform (used when its hourly quota is done
     * in "All platforms" mode). Links are grouped by platform, so this advances
     * the index past every consecutive item of the given platform.
     */
    fun skipPlatform(ctx: Context, platform: String) {
        val list = items(ctx)
        var i = index(ctx)
        while (i < list.size && list[i].platform == platform) i++
        prefs(ctx).edit().putInt(KEY_INDEX, i).apply()
    }
}
