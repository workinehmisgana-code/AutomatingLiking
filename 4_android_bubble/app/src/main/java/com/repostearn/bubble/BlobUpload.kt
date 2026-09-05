package com.repostearn.bubble

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Uploads a file straight to Vercel Blob, the same way @vercel/blob's client
 * `upload()` does — so large videos bypass the serverless body-size limit:
 *   1) POST a "blob.generate-client-token" request to our own bearer-authed
 *      endpoint → get a short-lived clientToken.
 *   2) PUT the file bytes to the Blob API with that token.
 * Returns the public blob URL. Throws on failure.
 */
object BlobUpload {
    private const val BLOB_API = "https://blob.vercel-storage.com/"

    private fun clientToken(appToken: String, pathname: String): String {
        val body = JSONObject().apply {
            put("type", "blob.generate-client-token")
            put("payload", JSONObject().apply {
                put("pathname", pathname)
                put("callbackUrl", Config.VIDEO_UPLOAD_TOKEN_URL)
                put("clientPayload", JSONObject.NULL)
                put("multipart", false)
            })
        }
        val c = (URL(Config.VIDEO_UPLOAD_TOKEN_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true
            setRequestProperty("Authorization", "Bearer $appToken")
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 15000; readTimeout = 20000
        }
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        val resp = (if (code in 200..299) c.inputStream else c.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) throw RuntimeException("Couldn't start upload ($code)")
        return JSONObject(resp).optString("clientToken").ifBlank {
            throw RuntimeException("Upload token missing")
        }
    }

    private fun put(ctx: Context, clientToken: String, pathname: String, uri: Uri, mime: String, length: Long): String {
        val encoded = pathname.split("/").joinToString("/") { Uri.encode(it) }
        val c = (URL(BLOB_API + encoded).openConnection() as HttpURLConnection).apply {
            requestMethod = "PUT"; doOutput = true
            setRequestProperty("authorization", "Bearer $clientToken")
            setRequestProperty("x-api-version", "9")
            setRequestProperty("x-content-type", mime)
            setRequestProperty("x-add-random-suffix", "0")
            setRequestProperty("Content-Type", mime)
            if (length > 0) {
                setRequestProperty("x-content-length", length.toString())
                setFixedLengthStreamingMode(length)
            } else {
                setChunkedStreamingMode(0)
            }
            connectTimeout = 20000; readTimeout = 120000
        }
        (ctx.contentResolver.openInputStream(uri)
            ?: throw RuntimeException("Can't read the file")).use { input ->
            c.outputStream.use { output -> input.copyTo(output, 64 * 1024) }
        }
        val code = c.responseCode
        val resp = (if (code in 200..299) c.inputStream else c.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) throw RuntimeException("Upload failed ($code)")
        return JSONObject(resp).optString("url").ifBlank { throw RuntimeException("No blob URL returned") }
    }

    /** Upload a video content Uri; returns the public blob URL. */
    fun uploadVideo(ctx: Context, appToken: String, uri: Uri, filename: String, mime: String, length: Long): String {
        val safe = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "video.mp4" }
        val pathname = "videos/${System.currentTimeMillis()}-$safe"
        val token = clientToken(appToken, pathname)
        return put(ctx, token, pathname, uri, mime.ifBlank { "video/mp4" }, length)
    }
}
