package com.repostearn.bubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's heart rules, against the cases the PC's runner is held to.
 *
 * Every case here is one `2_comment_automation/check_to_top.py` asserts on the
 * Python side. They are written out rather than imported because the two cannot
 * share code — that is the whole problem these tests exist for. If a rule
 * changes on one side, the number in the other file is what fails.
 */
class LikerRulesTest {

    private fun decide(ours: Int, rival: Int, likes: Int, floor: Double = 0.25) =
        LikerRules.decide(ours, rival, likes, margin = 3, floor = floor, threshold = 0.85)

    // ── the lead ───────────────────────────────────────────────────────────
    @Test
    fun `a comment already past the lead and the floor is left alone`() {
        val d = decide(ours = 60, rival = 50, likes = 100)
        assertEquals(LikerRules.Action.NOTHING, d.action)
        assertEquals(0, d.hearts)
        assertTrue(d.finished)
    }

    @Test
    fun `a rival ahead is chased`() {
        // 1,000 likes -> a floor of 250, which is further than the lead at 103.
        // Written out because it is easy to read this case as "chase the rival"
        // and be surprised by 250: the floor is a target too.
        val d = decide(ours = 0, rival = 100, likes = 1_000)
        assertEquals(LikerRules.Action.CHASE, d.action)
        assertEquals(250, d.deficit)
        // Zefoy sells 25 or 50, so a batch of 50 is the most that fits.
        assertEquals(50, d.hearts)
        assertFalse(d.finished)
    }

    @Test
    fun `with the floor off, the rival alone sets the target`() {
        val d = decide(ours = 0, rival = 100, likes = 1_000, floor = 0.0)
        assertEquals(103, d.deficit)
    }

    // ── the floor: leading is not the same as carrying weight ──────────────
    @Test
    fun `a comment that leads but is thin for the video is still worked`() {
        // 40,000 likes -> a floor of 10,000. Leading on 11 is not enough.
        val d = decide(ours = 11, rival = 4, likes = 40_000)
        assertEquals(LikerRules.Action.CHASE, d.action)
        assertEquals(9_989, d.deficit)
        assertEquals(50, d.hearts)
    }

    @Test
    fun `it stops once the floor is met`() {
        assertEquals(LikerRules.Action.NOTHING, decide(10_000, 4, 40_000).action)
    }

    @Test
    fun `a heart short of the floor sends nothing`() {
        // One short, and the smallest batch is 25: it stops rather than
        // overshooting a target it set itself.
        assertEquals(LikerRules.Action.SHORT, decide(9_999, 4, 40_000).action)
    }

    @Test
    fun `the further target wins`() {
        // 100 likes -> floor 25, but a rival on 80 needs 83.
        assertEquals(73, decide(10, 80, 100).deficit)
        // 40,000 likes -> floor 10,000, and a rival on 4 needs only 7.
        assertEquals(10_000, decide(0, 4, 40_000).deficit)
    }

    @Test
    fun `the floor sits under the ceiling at every size`() {
        for (likes in listOf(100, 1_000, 40_000, 170_000)) {
            assertTrue(
                "floor must stay under the ceiling at $likes likes",
                (likes * 0.25).toInt() < (likes * 0.85).toInt(),
            )
        }
    }

    // ── the ceiling ────────────────────────────────────────────────────────
    @Test
    fun `nothing is sent once the ceiling is reached`() {
        // 30 likes -> a ceiling of 25. Our comment is AT it and a rival on 30 is
        // still ahead, so there is something to chase and no room to chase it
        // with. (A comment already past both targets is NOTHING, not CEILING —
        // the ceiling only has to be consulted when work remains.)
        val d = decide(ours = 25, rival = 30, likes = 30)
        assertEquals(LikerRules.Action.CEILING, d.action)
        assertEquals(0, d.hearts)
        assertTrue(d.finished)
    }

    @Test
    fun `past both targets is nothing to do, not a ceiling`() {
        assertEquals(LikerRules.Action.NOTHING, decide(26, 1, 30).action)
    }

    // ── the tie ────────────────────────────────────────────────────────────
    @Test
    fun `a tie is broken with one batch`() {
        val d = decide(ours = 14, rival = 14, likes = 20)
        assertEquals(LikerRules.Action.TIE_BREAK, d.action)
        assertEquals(25, d.hearts)
        // One batch and on: another round would spend a second on a comment
        // that is already clear.
        assertTrue(d.finished)
    }

    @Test
    fun `no room at all is not a tie worth breaking`() {
        // 1 like: the ceiling allows 0, so there is nothing under it.
        assertEquals(LikerRules.Action.CEILING, decide(0, 0, 1).action)
    }

    @Test
    fun `behind rather than level is refused, not overshot`() {
        assertEquals(LikerRules.Action.SHORT, decide(10, 14, 20).action)
    }

    // ── no like count, and the floor switched off ──────────────────────────
    @Test
    fun `an unknown like count has no floor and no ceiling`() {
        assertEquals(LikerRules.Action.NOTHING, decide(11, 4, 0).action)
        val chasing = decide(0, 100, 0)
        assertEquals(LikerRules.Action.CHASE, chasing.action)
        assertEquals(50, chasing.hearts)
    }

    @Test
    fun `floor zero makes leading enough`() {
        assertEquals(LikerRules.Action.NOTHING, decide(11, 4, 40_000, floor = 0.0).action)
    }

    // ── when a video is done ───────────────────────────────────────────────
    @Test
    fun `clear of the strangers is not enough while under the floor`() {
        assertFalse(LikerRules.finishedAfter(after = 61, rival = 4, likes = 40_000, floor = 0.25))
        assertTrue(LikerRules.finishedAfter(after = 10_000, rival = 4, likes = 40_000, floor = 0.25))
        // No floor to meet: passing the rival is the whole test.
        assertTrue(LikerRules.finishedAfter(after = 61, rival = 4, likes = 0, floor = 0.25))
    }

    // ── finding our comment ────────────────────────────────────────────────
    @Test
    fun `a product is matched however it is spelled`() {
        for (text in listOf(
            "purifytext is the one",
            "purify text got me through",
            "Purify-Text honestly",
            "\"Purify Text\" always",
        )) {
            assertTrue(text, LikerRules.matchesProduct(text, "purifytext"))
        }
        assertFalse(LikerRules.matchesProduct("kinprose is fine", "purifytext"))
        assertFalse(LikerRules.matchesProduct("anything", ""))
        assertEquals("purifytext2", LikerRules.fold("Purify-Text 2!"))
    }
}
