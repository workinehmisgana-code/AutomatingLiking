package com.repostearn.bubble

import android.content.Context
import org.json.JSONArray

/**
 * Caches the comment pool for the bubble.
 *
 * The pool is CROSS-PRODUCT (see /api/app/comments): each comment belongs to one
 * of the admin's active products. `commentProducts` from the API is index-aligned
 * with `comments`, and we keep it so a click can be reported against the product
 * whose comment was actually served — which is what the dashboard counts per
 * product. Without it every click would be attributed to the user's assigned
 * product, which usually isn't the one being advertised.
 */
object CommentStore {
    private const val PREFS = "bubble_comments"
    private const val KEY_PRODUCT = "product"
    private const val KEY_COMMENTS = "comments_json"
    private const val KEY_PRODUCTS = "comment_products_json"

    /** A comment plus the product it advertises (null when the API didn't say). */
    data class Pick(val text: String, val product: String?)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun set(ctx: Context, product: String?, commentsJson: String, productsJson: String = "[]") {
        prefs(ctx).edit()
            .putString(KEY_PRODUCT, product)
            .putString(KEY_COMMENTS, commentsJson)
            .putString(KEY_PRODUCTS, productsJson)
            .apply()
    }

    private fun productsList(ctx: Context): List<String> {
        val s = prefs(ctx).getString(KEY_PRODUCTS, "").orEmpty()
        if (s.isBlank()) return emptyList()
        return try {
            val arr = JSONArray(s)
            (0 until arr.length()).map { arr.optString(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * Pick a random comment from the pool, together with its product. Returns null
     * when the pool is empty. The product is null if this build cached the pool
     * before the API started sending `commentProducts` — the server then falls
     * back to the user's assigned product, i.e. the old behaviour.
     */
    fun pick(ctx: Context): Pick? {
        val list = comments(ctx)
        if (list.isEmpty()) return null
        val i = kotlin.random.Random.nextInt(list.size)
        return Pick(list[i], productsList(ctx).getOrNull(i)?.ifBlank { null })
    }

    fun product(ctx: Context): String? = prefs(ctx).getString(KEY_PRODUCT, null)?.ifBlank { null }

    fun comments(ctx: Context): List<String> {
        val s = prefs(ctx).getString(KEY_COMMENTS, "").orEmpty()
        if (s.isBlank()) return emptyList()
        return try {
            val arr = JSONArray(s)
            (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
