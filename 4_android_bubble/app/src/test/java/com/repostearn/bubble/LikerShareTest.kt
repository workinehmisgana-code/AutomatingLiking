package com.repostearn.bubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule used when "pass the best other comment" is switched off: a share of
 * the video's own likes, and nothing to do with the other comments.
 *
 * The cases are `choose_heart_count` in `2_comment_automation/automate.py`,
 * which is a short function with one sharp edge — the comparison is strict, so a
 * batch must fit UNDER what is left rather than exactly fill it. Ported by hand,
 * which is reason enough to pin it.
 */
class LikerShareTest {

    private fun share(ours: Int, likes: Int, threshold: Double = 0.85) =
        LikerRules.decideByShare(ours, likes, threshold)

    @Test
    fun `the largest batch that fits is sent`() {
        // 1,000 likes at 85% allows 850; nothing on the comment yet.
        val d = share(ours = 0, likes = 1_000)
        assertEquals(LikerRules.Action.CHASE, d.action)
        assertEquals(50, d.hearts)
    }

    @Test
    fun `a narrow gap takes the smaller batch`() {
        // 100 likes at 85% allows 85; on 50, that leaves 35 — 50 does not fit.
        assertEquals(25, share(ours = 50, likes = 100).hearts)
    }

    @Test
    fun `a comment at the ceiling is skipped`() {
        val d = share(ours = 85, likes = 100)
        assertEquals(LikerRules.Action.CEILING, d.action)
        assertEquals(0, d.hearts)
        assertTrue(d.finished)
    }

    @Test
    fun `a batch has to fit under what is left, not fill it`() {
        // 85 allowed, on 60: exactly 25 remain. The Python comparison is `<`,
        // so 25 is refused. Pinned because an off-by-one here is the difference
        // between stopping at the ceiling and stepping onto it.
        assertEquals(LikerRules.Action.CEILING, share(ours = 60, likes = 100).action)
        // One heart more of room and it goes.
        assertEquals(25, share(ours = 59, likes = 100).hearts)
    }

    @Test
    fun `an unknown like count sends the smallest batch`() {
        // No likes means no ceiling to apply. Refusing every video whose like
        // count we were not told is worse than the risk.
        val d = share(ours = 0, likes = 0)
        assertEquals(LikerRules.Action.CHASE, d.action)
        assertEquals(25, d.hearts)
    }

    @Test
    fun `the threshold is what moves the ceiling`() {
        // Same video, a tighter ceiling: 25% of 1,000 is 250, and a comment on
        // 240 has only 10 of room.
        assertEquals(LikerRules.Action.CEILING, share(ours = 240, likes = 1_000, threshold = 0.25).action)
        assertEquals(50, share(ours = 100, likes = 1_000, threshold = 0.25).hearts)
    }
}
