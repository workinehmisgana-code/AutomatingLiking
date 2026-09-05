package com.repostearn.bubble

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.LinearLayout
import kotlin.math.abs

/**
 * Bubble root that can be dragged from ANY point. A short press that doesn't
 * move is passed to the child (so buttons still click); once the finger moves
 * past the touch slop it becomes a drag, and the child's press is cancelled.
 */
class DraggableLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    LinearLayout(context, attrs) {

    interface DragListener {
        fun onDragStart()
        fun onDrag(dx: Float, dy: Float) // total offset from where the drag began
        fun onDragEnd()
    }

    var dragListener: DragListener? = null

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var dragging = false

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.rawX; downY = ev.rawY; dragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && (abs(ev.rawX - downX) > touchSlop || abs(ev.rawY - downY) > touchSlop)) {
                    dragging = true
                    dragListener?.onDragStart()
                    return true // take over → children get CANCEL, we start dragging
                }
            }
        }
        return false
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX; downY = event.rawY
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging &&
                    (abs(event.rawX - downX) > touchSlop || abs(event.rawY - downY) > touchSlop)
                ) {
                    dragging = true
                    dragListener?.onDragStart()
                }
                if (dragging) dragListener?.onDrag(event.rawX - downX, event.rawY - downY)
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging) {
                    dragging = false
                    dragListener?.onDragEnd()
                }
                return true
            }
        }
        return super.onTouchEvent(event)
    }
}
