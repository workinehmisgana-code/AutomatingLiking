package com.repostearn.bubble

import android.content.Context

/** Caches the last /api/app/status payload + when it was fetched (for live timers). */
object StatusStore {
    private const val PREFS = "bubble_status"
    private const val KEY_JSON = "json"
    private const val KEY_AT = "fetched_at"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun set(ctx: Context, json: String) {
        prefs(ctx).edit().putString(KEY_JSON, json).putLong(KEY_AT, System.currentTimeMillis()).apply()
    }

    fun json(ctx: Context): String? = prefs(ctx).getString(KEY_JSON, null)?.ifBlank { null }
    fun fetchedAt(ctx: Context): Long = prefs(ctx).getLong(KEY_AT, 0L)
}
