package com.repostearn.bubble

import kotlin.math.max
import kotlin.math.min

/**
 * How many hearts a comment should be sent — the same arithmetic as
 * `2_comment_automation/automate.py`.
 *
 * THIS IS A SECOND IMPLEMENTATION AND THAT IS A RISK WORTH NAMING. Playwright
 * cannot run on Android and a WebView cannot run Python, so the rules exist
 * twice. What stops them drifting is that the NUMBERS come from one place — the
 * dashboard hands the phone its margin, floor, ceiling and rounds — and that
 * the cases below are the same cases `check_to_top.py` asserts on the other
 * side. Change a rule in one and the other has to follow; nothing here can
 * detect that for you.
 *
 * The two limits, in words:
 *
 *   the floor    a comment under this share of the VIDEO's likes is worked even
 *                when it already leads the section — topping a section on 11
 *                hearts under a 40,000-like video still reads as a comment
 *                nobody noticed
 *   the ceiling  a comment carrying more hearts than the video it sits under is
 *                a comment nobody believes
 */
object LikerRules {

    /** The batch sizes Zefoy actually sells. */
    val HEART_OPTIONS = listOf(25, 50)

    enum class Action {
        /** Already past both targets. */
        NOTHING,
        /** At or over the ceiling: nothing can be sent without passing it. */
        CEILING,
        /** Short of the target, but the smallest batch would break the ceiling. */
        SHORT,
        /** Level with the best stranger: one batch, then move on. */
        TIE_BREAK,
        /** Send a batch and come back. */
        CHASE,
    }

    data class Decision(
        val action: Action,
        /** Hearts to send; 0 for everything but CHASE and TIE_BREAK. */
        val hearts: Int,
        /** How far short of the target this comment is, before sending. */
        val deficit: Int,
        /** True when the video needs no further visits. */
        val finished: Boolean,
        val why: String,
    )

    /**
     * @param ours      hearts on our comment right now
     * @param rival     hearts on the best comment that is not ours
     * @param likes     the VIDEO's like count, or 0 when it is not known
     */
    fun decide(
        ours: Int,
        rival: Int,
        likes: Int,
        margin: Int,
        floor: Double,
        threshold: Double,
    ): Decision {
        val leadAt = rival + margin
        // An unknown like count means no floor and no ceiling — the same
        // convention the Python runner uses. A number we were not told cannot
        // be a rule.
        val floorAt = if (likes > 0 && floor > 0) (likes * floor).toInt() else 0
        val target = max(leadAt, floorAt)
        val deficit = target - ours
        if (deficit <= 0) {
            return Decision(Action.NOTHING, 0, 0, true, "already past the lead and the floor")
        }

        val room = if (likes > 0) (likes * threshold).toInt() - ours else null
        if (room != null && room <= 0) {
            return Decision(
                Action.CEILING, 0, deficit, true,
                "at the ceiling: ${ours} of ${(likes * threshold).toInt()} allowed",
            )
        }

        val allowed = if (room == null) deficit else min(deficit, room)
        val smallest = HEART_OPTIONS.min()

        // A TIE IS THE ONE CASE WORTH OVERSHOOTING FOR. Level with the best
        // stranger, the only thing between our comment and the top of the
        // section is the margin, and the smallest batch is larger than that.
        if (room != null && allowed < smallest && ours == rival && room > 0) {
            return Decision(
                Action.TIE_BREAK, smallest, deficit, true,
                "tied at $ours — one batch to break it, then on",
            )
        }
        if (room != null && allowed < smallest) {
            return Decision(
                Action.SHORT, 0, deficit, true,
                "only $allowed under the ceiling and the smallest batch is $smallest",
            )
        }

        // The largest batch that fits. Zefoy sells 25 or 50; asking for 40 gets
        // 25, which is what the dropdown would give anyway.
        val send = HEART_OPTIONS.filter { it <= allowed }.maxOrNull() ?: smallest
        return Decision(
            Action.CHASE, send, deficit, false,
            if (floorAt > leadAt) "under the floor of $floorAt" else "chasing $target",
        )
    }

    /**
     * The OTHER rule, for when "pass the best other comment" is switched off.
     *
     * This one aims at a SHARE OF THE VIDEO'S LIKES and ignores the other
     * comments entirely: send the largest batch that keeps our comment under
     * `threshold` x the video's likes, and skip it once it is there. It is a
     * plausibility rule rather than a competitive one, and it is what
     * `choose_heart_count` does on the Python side -- down to the strict
     * comparison, because a batch has to fit UNDER what is left rather than
     * exactly fill it.
     *
     * Nothing in it needs the rival, so there is no floor here and no margin.
     * One visit per video is all it can use; a second would only run at the
     * ceiling the first one moved up to.
     */
    fun decideByShare(ours: Int, likes: Int, threshold: Double): Decision {
        val smallest = HEART_OPTIONS.min()
        if (likes <= 0) {
            // No like count means no ceiling to apply, the same convention
            // decide() uses. Refusing every video whose likes we were not told
            // is worse than the risk, and the batch is the smallest one.
            return Decision(
                Action.CHASE, smallest, smallest, false,
                "no like count for this video, so no ceiling applies",
            )
        }
        val limit = likes * threshold
        val eligible = HEART_OPTIONS.filter { it < limit - ours }
        if (eligible.isEmpty()) {
            return Decision(
                Action.CEILING, 0, 0, true,
                "already on $ours hearts of ${limit.toInt()} allowed",
            )
        }
        val send = eligible.max()
        return Decision(Action.CHASE, send, send, false, "under ${limit.toInt()}")
    }

    // ── which of our comments to work on ───────────────────────────────────

    /** Anything carrying hearts, so [pick] can choose between them. */
    interface Hearted {
        val hearts: Int
    }

    /**
     * @param target     the one to heart, or null when there is nothing to do
     * @param othersLeft how many MORE of ours still need work after this one
     * @param allLead    every one of ours is clear of the strangers and of the floor
     * @param floorAt    the floor in hearts, for the log line
     */
    data class Pick<T>(
        val target: T?,
        val othersLeft: Int,
        val allLead: Boolean,
        val floorAt: Int,
        val behind: Int,
        val thin: Int,
    )

    /**
     * Which of OUR comments on this video gets the hearts.
     *
     * A video often carries several of ours, and once one is clear of the
     * strangers the hearts belong on the next one rather than on the next video:
     * two of our comments at the top of a section is worth more than one of them
     * further clear.
     *
     * BEHIND BEFORE THIN. A comment a stranger is beating is losing the section
     * outright; one that leads but sits under the floor is only losing the second
     * glance. Both get worked, in that order. Within a group the one CLOSEST to
     * the line goes first, because it buys a top spot for the fewest hearts and
     * the rest of the budget then goes to the next.
     *
     * The rival is the same for all of them — the best comment that is not ours.
     * Aiming our second comment at our first would have them racing each other up
     * a section they already own.
     */
    fun <T : Hearted> pick(ours: List<T>, rival: Int, likes: Int, floor: Double): Pick<T> {
        val floorAt = if (likes > 0 && floor > 0) (likes * floor).toInt() else 0
        if (ours.isEmpty()) return Pick(null, 0, false, floorAt, 0, 0)
        // Held as indices, not as the objects: two of our comments can carry the
        // same text and heart count, and `in` on a list of data classes would
        // then treat one as the other.
        val behind = ours.indices.filter { ours[it].hearts <= rival }
        val thin = ours.indices.filter {
            it !in behind && floorAt > 0 && ours[it].hearts < floorAt
        }
        if (behind.isEmpty() && thin.isEmpty()) {
            return Pick(null, 0, true, floorAt, 0, 0)
        }
        val queue = if (behind.isNotEmpty()) behind else thin
        val at = queue.maxByOrNull { ours[it].hearts }!!
        return Pick(ours[at], behind.size + thin.size - 1, false, floorAt, behind.size, thin.size)
    }

    /**
     * Is this video finished after a batch landed?
     *
     * Clear of the strangers AND not thin: a comment that passed the rival but
     * is still under the floor has more to do, and calling it done here is how
     * it would be skipped for good.
     */
    fun finishedAfter(after: Int, rival: Int, likes: Int, floor: Double): Boolean {
        val floorMet = if (likes > 0 && floor > 0) after >= (likes * floor).toInt() else true
        return after > rival && floorMet
    }

    /**
     * Does this comment name one of our products?
     *
     * Folded to letters and digits before comparing, because the comment bank
     * writes a product as ordinary words on purpose: "purify text", "Purify-Text"
     * and "purifytext" are the same product and a plain substring match finds
     * only the last of them.
     */
    fun matchesProduct(commentText: String, product: String): Boolean {
        val k = fold(product)
        return k.isNotEmpty() && fold(commentText).contains(k)
    }

    // a-z0-9 ONLY, not Char.isLetterOrDigit(), which is Unicode-aware. The
    // Python side strips with [^a-z0-9], so a comment written in Amharic folds
    // differently in the two languages if this is widened — and the point of
    // this function is that both sides agree on which comments are ours.
    fun fold(s: String): String = buildString {
        for (c in s.lowercase()) if (c in 'a'..'z' || c in '0'..'9') append(c)
    }
}
