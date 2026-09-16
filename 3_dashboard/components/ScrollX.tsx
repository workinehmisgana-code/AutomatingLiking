'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A horizontal scroller whose width does NOT depend on what is listed, with its
 * scrollbar at the TOP.
 *
 * TWO problems, one component.
 *
 * WIDTH. A table wrapped in a bare `overflow-x-auto` scrolls while it is full
 * and stops scrolling the moment you filter it: a scrollbar appears only when
 * the content is wider than the box, and the content is the rows. Narrow the
 * rows and the table narrows with them, taking the scroll and the right-hand
 * columns with it. So the width is pinned here, making it a property of the
 * COLUMNS — an empty result is exactly as wide as a full one.
 *
 * POSITION. A native scrollbar sits under the content, which on a 500-row table
 * is a page and a half below the headers you are trying to line up. The bar
 * above is a real scroller of its own — an empty box holding a spacer as wide as
 * the table — with its scroll position tied to the table's in both directions.
 * The browser then shows it exactly when the table overflows and hides it when
 * it does not, with no extra logic.
 */
export default function ScrollX({
  children,
  /**
   * Width below which the scroller starts scrolling instead of squashing.
   *
   * Omit it and the HEADER is measured instead — the first element child, whose
   * cells are fixed-width and shrink-0, so its scrollWidth is the real table
   * width in every column mode and follows a dragged column. That is more
   * reliable than a number kept in step by hand, and it is the only thing that
   * works where the rows carry content-visibility (see below).
   */
  min,
  /** Classes for the scrolling box itself (max-height, rounding, borders). */
  className = '',
  /** Set false for a short table where a second bar is just noise. */
  topBar = true,
}: {
  children: React.ReactNode
  min?: number
  className?: string
  topBar?: boolean
}) {
  const top = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const inner = useRef<HTMLDivElement | null>(null)
  const [measured, setMeasured] = useState(0)

  // No feedback loop: the header's cells are shrink-0 with explicit widths, so
  // its scrollWidth does not change when the wrapper around it gets wider.
  useEffect(() => {
    if (min !== undefined) return
    const header = inner.current?.firstElementChild
    if (!header || typeof ResizeObserver === 'undefined') return
    const read = () => setMeasured(Math.ceil(header.scrollWidth))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(header)
    return () => ro.disconnect()
  }, [min])

  const width = min ?? measured
  // Which element the user is actually dragging. Without this the two scrollers
  // push each other back and forth — each one's scroll handler writes to the
  // other, which fires its handler, which writes back.
  const driving = useRef<'top' | 'body' | null>(null)

  const sync = useCallback((from: 'top' | 'body') => {
    const a = from === 'top' ? top.current : body.current
    const b = from === 'top' ? body.current : top.current
    if (!a || !b) return
    if (driving.current && driving.current !== from) return
    driving.current = from
    b.scrollLeft = a.scrollLeft
    // Released on the next frame rather than immediately: the write above fires
    // the other element's scroll event asynchronously.
    requestAnimationFrame(() => {
      driving.current = null
    })
  }, [])

  // The top bar is only useful while the table actually overflows. It hides
  // itself when it does not, because its spacer is then no wider than the box.
  useEffect(() => {
    const el = body.current
    if (!el || !top.current) return
    top.current.scrollLeft = el.scrollLeft
  }, [width])

  return (
    <div>
      {topBar && (
        <div
          ref={top}
          onScroll={() => sync('top')}
          // Scrolls, but holds nothing: its only child is a strip as wide as the
          // table. aria-hidden because it duplicates the table's own scrolling
          // and has nothing for a screen reader to read.
          aria-hidden
          className="overflow-x-auto overflow-y-hidden"
        >
          <div style={{ minWidth: `${width}px`, height: 1 }} />
        </div>
      )}
      <div ref={body} onScroll={() => sync('body')} className={`overflow-x-auto ${className}`}>
        <div ref={inner} style={{ minWidth: width ? `${width}px` : undefined }}>
          {children}
        </div>
      </div>
    </div>
  )
}
