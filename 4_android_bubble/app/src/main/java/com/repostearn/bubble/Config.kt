package com.repostearn.bubble

/**
 * Only the dashboard base URL needs setting. The platform is chosen at runtime
 * from the bubble's platform button; DEFAULT_PLATFORM is just the initial value.
 */
object Config {
    const val DASHBOARD = "https://comments-delta-sand.vercel.app"

    // "" = all platforms; or "tiktok", "youtube_shorts", "youtube_videos", "instagram", "reddit".
    const val DEFAULT_PLATFORM = ""

    // The tester signs in through the same page, which hands its token back on
    // the tester's own deep-link scheme.
    val LOGIN_URL: String get() = "$DASHBOARD/app-login" + if (BuildConfig.TESTER) "?app=tester" else ""
    /** Tester only: is this account's comment visible on a video? */
    val CHECK_URL: String get() = "$DASHBOARD/api/app/check-comment"
    val TESTER_COMMENTS_URL: String get() = "$DASHBOARD/api/app/tester-comments"
    /** Tester only: does this video carry a comment naming one of our products? */
    val HAS_OURS_URL: String get() = "$DASHBOARD/api/app/link-has-ours"
    val ME_URL: String get() = "$DASHBOARD/api/app/me"
    val CLICK_URL: String get() = "$DASHBOARD/api/app/click"
    val COMMENTS_URL: String get() = "$DASHBOARD/api/app/comments"
    val UNRELATED_URL: String get() = "$DASHBOARD/api/app/unrelated"
    // The tester's counts are of the humanizer links it is served (see linksUrl).
    val STATUS_URL: String get() =
        "$DASHBOARD/api/app/status" + if (BuildConfig.TESTER) "?genre=humanizer" else ""
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

    fun linksUrl(platform: String): String {
        val q = mutableListOf<String>()
        if (platform.isNotBlank()) q += "platform=$platform"
        // The tester is served only links that carry none of our comments.
        if (BuildConfig.TESTER) q += "clean=1"
        // ...and only humanizer links, whatever the workers' genre mix is.
        if (BuildConfig.TESTER) q += "genre=humanizer"
        return "$DASHBOARD/api/app/links" + if (q.isEmpty()) "" else "?" + q.joinToString("&")
    }
}
