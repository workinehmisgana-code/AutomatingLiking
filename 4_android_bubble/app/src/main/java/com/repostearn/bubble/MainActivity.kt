package com.repostearn.bubble

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast

/**
 * No-UI launcher. Tapping the icon:
 *  1) ensures the "Display over other apps" permission,
 *  2) if not signed in yet, opens the dashboard's Google sign-in in the browser,
 *  3) otherwise starts the floating bubble.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "Allow 'Display over other apps', then reopen the app", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            finish()
            return
        }

        if (AuthStore.token(this) == null) {
            Toast.makeText(this, "Sign in with your dashboard Google account", Toast.LENGTH_LONG).show()
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Config.LOGIN_URL)))
            finish()
            return
        }

        val svc = Intent(this, BubbleService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc) else startService(svc)
        finish()
    }
}
