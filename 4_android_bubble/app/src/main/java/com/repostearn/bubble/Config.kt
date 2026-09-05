package com.repostearn.bubble

/**
 * Only the dashboard base URL needs setting. The platform is chosen at runtime
 * from the bubble's platform button; DEFAULT_PLATFORM is just the initial value.
 */
object Config {
    const val DASHBOARD = "https://comments-delta-sand.vercel.app"

    // "" = all platforms; or "tiktok", "youtube_shorts", "youtube_videos", "instagram".
    const val DEFAULT_PLATFORM = ""

    val LOGIN_URL: String get() = "$DASHBOARD/app-login"
    val ME_URL: String get() = "$DASHBOARD/api/app/me"
    val CLICK_URL: String get() = "$DASHBOARD/api/app/click"
    val COMMENTS_URL: String get() = "$DASHBOARD/api/app/comments"
    val UNRELATED_URL: String get() = "$DASHBOARD/api/app/unrelated"
    val STATUS_URL: String get() = "$DASHBOARD/api/app/status"
    val MESSAGES_URL: String get() = "$DASHBOARD/api/app/messages"
    val FINISH_URL: String get() = "$DASHBOARD/finish"

    // Native Video-task endpoints (bearer-authed).
    val VIDEO_URL: String get() = "$DASHBOARD/api/app/video"
    val VIDEO_REQUEST_URL: String get() = "$DASHBOARD/api/app/video/request"
    val VIDEO_UPLOAD_TOKEN_URL: String get() = "$DASHBOARD/api/app/video/upload"
    val VIDEO_SUBMIT_URL: String get() = "$DASHBOARD/api/app/video/submit"

    // Native Repost & earn endpoints (bearer-authed).
    val PROMO_URL: String get() = "$DASHBOARD/api/app/promo"
    val PROMO_ACCOUNT_URL: String get() = "$DASHBOARD/api/app/promo/account"
    val PROMO_DOWNLOAD_URL: String get() = "$DASHBOARD/api/app/promo/download"
    val PROMO_LINK_URL: String get() = "$DASHBOARD/api/app/promo/link"

    fun linksUrl(platform: String): String =
        "$DASHBOARD/api/app/links" + if (platform.isNotBlank()) "?platform=$platform" else ""
}
