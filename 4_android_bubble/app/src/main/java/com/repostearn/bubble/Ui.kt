package com.repostearn.bubble

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The look of the native screens, in one place.
 *
 * These screens were built out of plain views with colours typed in at each
 * call site: square corners, four identical bright-green blocks one after
 * another, and no press feedback. Nothing was wrong with it except that it did
 * not look like something anybody would trust with their wages.
 *
 * So the palette and the handful of shapes live here and the screens compose
 * them. One place to change a colour, and a row cannot drift from the row above
 * it because they are the same function.
 */
object Ui {

    // ── palette ─────────────────────────────────────────────────────────────
    // Near-black rather than true black: a pure #000 panel on an OLED screen
    // has no edge, so cards float with nothing to sit against.
    const val BG = 0xFF0B0B0C.toInt()
    const val CARD = 0xFF141416.toInt()
    const val CARD_HI = 0xFF0F1A15.toInt()
    const val LINE = 0xFF232327.toInt()
    const val LINE_HI = 0xFF1F3A2E.toInt()
    const val TEXT = 0xFFF3F4F6.toInt()
    const val MUTED = 0xFF9CA3AF.toInt()
    const val FAINT = 0xFF6B7280.toInt()
    const val ACCENT = 0xFF34D399.toInt()
    const val ACCENT_DEEP = 0xFF059669.toInt()

    fun dp(ctx: Context, v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    // ── shapes ──────────────────────────────────────────────────────────────

    /** A rounded panel, optionally outlined. */
    fun card(ctx: Context, fill: Int, stroke: Int? = null, radius: Int = 16): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(ctx, radius).toFloat()
            setColor(fill)
            if (stroke != null) setStroke(dp(ctx, 1), stroke)
        }

    /**
     * The same, but it responds to a finger.
     *
     * A tappable row that does not react reads as a label, and people press it
     * twice. The ripple is the cheapest way to say "this is a button".
     */
    fun tappable(ctx: Context, fill: Int, stroke: Int? = null, radius: Int = 16): RippleDrawable =
        RippleDrawable(
            ColorStateList.valueOf(0x33FFFFFF),
            card(ctx, fill, stroke, radius),
            null,
        )

    /** A filled circle, for the icon well on a task row. */
    fun circle(ctx: Context, fill: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(fill)
            setSize(dp(ctx, 40), dp(ctx, 40))
        }

    // ── type ────────────────────────────────────────────────────────────────

    /** A small all-caps heading above a group. */
    fun sectionLabel(ctx: Context, text: String): TextView = TextView(ctx).apply {
        this.text = text.uppercase()
        setTextColor(FAINT)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        letterSpacing = 0.12f
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(dp(ctx, 4), dp(ctx, 18), 0, dp(ctx, 8))
    }

    fun title(ctx: Context, text: String, size: Float = 16f): TextView = TextView(ctx).apply {
        this.text = text
        setTextColor(TEXT)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    fun body(ctx: Context, text: String, color: Int = MUTED, size: Float = 13f): TextView =
        TextView(ctx).apply {
            this.text = text
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        }

    // ── composites ──────────────────────────────────────────────────────────

    /**
     * One task: an icon, what it is, what it is for, and a chevron.
     *
     * Replaces four identical bright-green blocks. They were the same size and
     * the same colour, so the eye had to read all four every time to find one -
     * and nothing said which was the thing you do most.
     */
    fun taskRow(
        ctx: Context,
        icon: String,
        name: String,
        detail: String,
        onClick: () -> Unit,
    ): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = tappable(ctx, CARD, LINE, 14)
            setPadding(dp(ctx, 14), dp(ctx, 14), dp(ctx, 14), dp(ctx, 14))
            isClickable = true
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(ctx, 10) }
        }
        row.addView(TextView(ctx).apply {
            text = icon
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            background = circle(ctx, 0xFF1C2A24.toInt())
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 40), dp(ctx, 40))
                .apply { rightMargin = dp(ctx, 14) }
        })
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        col.addView(title(ctx, name))
        col.addView(body(ctx, detail).apply { setPadding(0, dp(ctx, 2), 0, 0) })
        row.addView(col)
        row.addView(TextView(ctx).apply {
            text = "›"
            setTextColor(FAINT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            setPadding(dp(ctx, 8), 0, dp(ctx, 2), dp(ctx, 3))
        })
        return row
    }

    /** The one action the screen is for. Filled, so it is found without reading. */
    fun primaryButton(ctx: Context, label: String, onClick: () -> Unit): View =
        TextView(ctx).apply {
            text = label
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = Gravity.CENTER
            background = tappable(ctx, ACCENT_DEEP, null, 14)
            setPadding(dp(ctx, 18), dp(ctx, 16), dp(ctx, 18), dp(ctx, 16))
            isClickable = true
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(ctx, 6) }
        }

    /** A label on the left and its value on the right, aligned down a column. */
    fun statLine(ctx: Context, label: String, value: String, valueColor: Int = TEXT): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(ctx, 5), 0, 0)
        }
        row.addView(body(ctx, label).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        row.addView(body(ctx, value, valueColor).apply {
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        return row
    }
}
