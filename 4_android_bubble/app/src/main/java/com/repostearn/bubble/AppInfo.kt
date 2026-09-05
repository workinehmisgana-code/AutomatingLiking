package com.repostearn.bubble

import android.content.Context
import android.os.Build

/**
 * This app's own version, read from the installed package. Reported to the
 * dashboard (so the admin can see who's on which build) and compared against the
 * latest published APK's versionCode to decide whether to self-update.
 */
object AppInfo {
    fun versionName(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (e: Exception) {
        ""
    }

    fun versionCode(ctx: Context): Long = try {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode
        else pi.versionCode.toLong()
    } catch (e: Exception) {
        0L
    }

    /** Headers every authenticated request adds so the server records this build. */
    fun headers(ctx: Context): Map<String, String> = mapOf(
        "X-App-Version" to versionName(ctx),
        "X-App-Version-Code" to versionCode(ctx).toString(),
    )
}
