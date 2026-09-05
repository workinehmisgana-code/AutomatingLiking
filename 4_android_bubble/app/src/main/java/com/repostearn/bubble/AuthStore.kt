package com.repostearn.bubble

import android.content.Context

/** Stores the per-user app token handed back after Google sign-in. */
object AuthStore {
    private const val PREFS = "bubble_auth"
    private const val KEY_TOKEN = "token"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun token(ctx: Context): String? = prefs(ctx).getString(KEY_TOKEN, null)?.ifBlank { null }

    fun setToken(ctx: Context, token: String) {
        prefs(ctx).edit().putString(KEY_TOKEN, token).apply()
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_TOKEN).apply()
    }
}
