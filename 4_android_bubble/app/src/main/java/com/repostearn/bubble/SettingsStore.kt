package com.repostearn.bubble

import android.content.Context

/** Runtime settings chosen from the bubble (currently: which platform to pull). */
object SettingsStore {
    private const val PREFS = "bubble_settings"
    private const val KEY_PLATFORM = "platform"

    // (display name, api value). "" = all platforms.
    val PLATFORMS: List<Pair<String, String>> = listOf(
        "All platforms" to "",
        "TikTok" to "tiktok",
        "YT Shorts" to "youtube_shorts",
        "YT Videos" to "youtube_videos",
        "Instagram" to "instagram",
    )

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun platform(ctx: Context): String =
        prefs(ctx).getString(KEY_PLATFORM, Config.DEFAULT_PLATFORM) ?: Config.DEFAULT_PLATFORM

    fun setPlatform(ctx: Context, value: String) {
        prefs(ctx).edit().putString(KEY_PLATFORM, value).apply()
    }

    fun platformLabel(ctx: Context): String {
        val p = platform(ctx)
        return when (p) {
            "" -> "All"
            "tiktok" -> "TikTok"
            "youtube_shorts" -> "Shorts"
            "youtube_videos" -> "YT"
            "instagram" -> "IG"
            else -> p
        }
    }
}
