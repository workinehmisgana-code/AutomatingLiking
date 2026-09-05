package com.repostearn.bubble

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast

/**
 * Self-update for the sideloaded APK. We deliberately DO NOT download or install
 * the APK in-app (that needs REQUEST_INSTALL_PACKAGES and trips Google Play
 * Protect's "harmful app" heuristics). Instead, when the user taps Update we open
 * the APK download link in the browser; they then open the downloaded file and
 * install it manually through the system installer.
 */
object ApkUpdater {
    /** True when [versionName] is newer than what's installed. */
    fun isUpdateAvailable(ctx: Context, versionName: String?): Boolean {
        val remote = versionName?.trim().orEmpty()
        if (remote.isBlank()) return false
        return isNewer(remote, AppInfo.versionName(ctx))
    }

    /** Open the APK download in the browser. The user installs it manually. */
    fun openDownload(ctx: Context, url: String) {
        if (url.isBlank()) return
        try {
            ctx.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            Toast.makeText(ctx, "Downloading update — open the file to install", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(ctx, "Couldn't open the download link", Toast.LENGTH_SHORT).show()
        }
    }

    // True when dotted version name [remote] is newer than [local]
    // ("1.10" > "1.9" > "1.1" > "1.0"). Non-numeric parts count as 0.
    private fun isNewer(remote: String, local: String): Boolean {
        val a = remote.split(".")
        val b = local.split(".")
        val n = maxOf(a.size, b.size)
        for (i in 0 until n) {
            val x = a.getOrNull(i)?.trim()?.toIntOrNull() ?: 0
            val y = b.getOrNull(i)?.trim()?.toIntOrNull() ?: 0
            if (x != y) return x > y
        }
        return false
    }
}
