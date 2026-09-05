package com.repostearn.bubble

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast

/**
 * Receives the `nextbubble://auth?token=…` deep link that the dashboard opens
 * after Google sign-in. Saves the token and launches the bubble.
 */
class AuthActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val token = intent?.data?.getQueryParameter("token")
        if (token.isNullOrBlank()) {
            Toast.makeText(this, "Sign-in failed — please try again", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        AuthStore.setToken(this, token)
        Toast.makeText(this, "Signed in ✓", Toast.LENGTH_SHORT).show()

        if (Settings.canDrawOverlays(this)) {
            val svc = Intent(this, BubbleService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc) else startService(svc)
        } else {
            Toast.makeText(this, "Now allow 'Display over other apps', then open the app", Toast.LENGTH_LONG).show()
            startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))
            )
        }
        finish()
    }
}
