package com.repostearn.bubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which of OUR comments on a video gets the batch.
 *
 * The rule is small and the consequences of getting it wrong are quiet: aim at
 * the wrong one and a comment a stranger is beating never gets a heart, while
 * the run reports success on a video it has already won. These cases are the
 * block in `zefoy_process_url` that chooses between `behind` and `thin`.
 */
class LikerPickTest {

    private data class C(val name: String, override val hearts: Int) : LikerRules.Hearted

    private fun pick(ours: List<C>, rival: Int, likes: Int, floor: Double = 0.25) =
        LikerRules.pick(ours, rival, likes, floor)

    @Test
    fun `nothing of ours means nothing to pick`() {
        val p = pick(emptyList(), 10, 100)
        assertNull(p.target)
        assertFalse(p.allLead)
    }

    @Test
    fun `all of ours clear and carrying weight is nothing to do`() {
        // 100 likes -> floor 25. Both lead the rival and both are over the floor.
        val p = pick(listOf(C("a", 40), C("b", 30)), rival = 20, likes = 100)
        assertNull(p.target)
        assertTrue(p.allLead)
    }

    @Test
    fun `behind comes before thin`() {
        // 'a' leads but is under the 1,000-heart floor; 'b' is beaten outright.
        // Losing the section is the worse problem, so 'b' goes first.
        val p = pick(listOf(C("a", 900), C("b", 5)), rival = 50, likes = 4_000)
        assertEquals("b", (p.target as C).name)
        assertEquals(1, p.othersLeft)
        assertEquals(1_000, p.floorAt)
    }

    @Test
    fun `within a group the closest to the line goes first`() {
        // All three are behind the rival; the one needing the fewest hearts buys
        // a top spot soonest.
        val p = pick(listOf(C("far", 1), C("near", 48), C("mid", 20)), rival = 50, likes = 0)
        assertEquals("near", (p.target as C).name)
        assertEquals(2, p.othersLeft)
    }

    @Test
    fun `a comment level with the rival counts as behind`() {
        // Level is not a lead: the margin is still between it and the top.
        val p = pick(listOf(C("tied", 50)), rival = 50, likes = 0)
        assertEquals("tied", (p.target as C).name)
        assertFalse(p.allLead)
    }

    @Test
    fun `thin ones are worked when none is behind`() {
        val p = pick(listOf(C("a", 60), C("b", 300)), rival = 50, likes = 4_000)
        assertEquals(2, p.thin)
        assertEquals(0, p.behind)
        // The nearer the floor, the cheaper the fix.
        assertEquals("b", (p.target as C).name)
        assertEquals(1, p.othersLeft)
    }

    @Test
    fun `no floor means leading is enough`() {
        val p = pick(listOf(C("a", 60)), rival = 50, likes = 4_000, floor = 0.0)
        assertNull(p.target)
        assertTrue(p.allLead)
        assertEquals(0, p.floorAt)
    }

    @Test
    fun `an unknown like count has no floor`() {
        // The convention the ceiling uses too: a number we were not told cannot
        // be a rule. Without it, every leading comment would look thin.
        val p = pick(listOf(C("a", 60)), rival = 50, likes = 0)
        assertNull(p.target)
        assertTrue(p.allLead)
    }

    @Test
    fun `othersLeft counts both groups, not just the one being worked`() {
        // Two behind and one thin: finishing the first must not end the video.
        val p = pick(
            listOf(C("behind1", 10), C("behind2", 40), C("thin", 900)),
            rival = 50, likes = 4_000,
        )
        assertEquals("behind2", (p.target as C).name)
        assertEquals(2, p.othersLeft)
    }

    @Test
    fun `two identical comments are two comments`() {
        // Same text, same hearts. Held by index for exactly this reason: treated
        // by value, one would be mistaken for the other and the second would
        // never be hearted.
        val p = pick(listOf(C("same", 5), C("same", 5)), rival = 50, likes = 0)
        assertEquals(1, p.othersLeft)
        assertEquals(2, p.behind)
    }
}
