package com.repostearn.bubble

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Tiny HTTP helper (Bearer-authenticated) shared by the native screens. */
object Net {
    // App-version headers so the server records this build. Optional ctx keeps
    // the old call sites working; pass one wherever it's available.
    private fun HttpURLConnection.addVersion(ctx: Context?) {
        if (ctx == null) return
        AppInfo.headers(ctx).forEach { (k, v) -> setRequestProperty(k, v) }
    }

    fun get(urlStr: String, token: String, ctx: Context? = null): Pair<Int, String> = try {
        val c = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("Authorization", "Bearer $token")
            addVersion(ctx)
            connectTimeout = 15000
            readTimeout = 20000
        }
        val code = c.responseCode
        val body = (if (code in 200..299) c.inputStream else c.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        code to body
    } catch (e: Exception) {
        -1 to ""
    }

    fun postJson(urlStr: String, token: String, json: JSONObject, ctx: Context? = null): Int = try {
        val c = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
            addVersion(ctx)
            connectTimeout = 15000
            readTimeout = 20000
        }
        c.outputStream.use { it.write(json.toString().toByteArray()) }
        c.responseCode
    } catch (e: Exception) {
        -1
    }
}
