// The system prompt for one product's comment set — pure, and shared.
//
// It lives here rather than in commentGen so the ADMIN PAGE can build it too.
// commentGen imports the database and the Groq client, which a browser cannot
// load; this file imports nothing but config. That is what lets the prompt
// editor show the real prompt updating as the settings are changed, instead of
// a copy that drifts from what is actually sent.
//
// ONE DEFINITION PER RULE. Every piece here is used by BOTH prompts — the
// ordinary set and the per-audience one in commentGen. They used to describe the
// voices separately and had drifted apart: the audience prompt had no naive-user
// rule at all, and the two copies of the banned-word list disagreed with each
// other and with the filter that enforces it. A rule stated twice is a rule that
// will eventually be two different rules.
//
// KEPT SHORT ON PURPOSE. This is read by a model with a batch of comments to
// write; instructions in the middle of a long prompt are the ones it drops. Say
// each thing once, in the fewest words that are still exact.

import { productWords, type CommentStyle, type LinkCategory, type Product } from './config'

/** Blank line between the prompt's sections, so they read as separate rules. */
const SEP = '\n\n'

/** The word range a batch is asked for. Mirrors db.WordBand, without the import. */
export interface PromptBand {
  min: number
  max: number
}

/**
 * What the product is. Context for the model, never vocabulary for the comment.
 *
 * The second sentence is not decoration: given this paragraph alone the model
 * treats it as the register to write in, and every comment comes back sounding
 * like the product's own about page.
 */
export function productBackground(product: Product): string {
  return (
    `"${product}" is a website that rewrites AI-written text so it reads as human and ` +
    `gets past AI detectors (Turnitin, GPTZero, Originality, Copyleaks, ZeroGPT). ` +
    `This paragraph is background for you only — never use its words in a comment. `
  )
}

/**
 * Who is writing. Applies to every voice.
 *
 * The banned list is deliberately short and matches the JARGON filter in
 * commentGen. A longer list starves the model: banning "detector" and "tool"
 * left the AI-detector audience with nothing to say and every batch came back
 * empty.
 */
export const NAIVE_VOICE =
  `WHO YOU ARE: an ordinary person — a student, someone who writes for work. Not an ` +
  `expert, not a reviewer. You do not know the technical words. Small everyday words, ` +
  `short sentences, a bit unpolished. ` +
  `NEVER write: humanizer, ai content, bypass, undetectable, algorithm, paraphrase, ` +
  `output, software, platform, generate, seamless, or how it works inside. ` +
  `Write like this instead: "it came back clean", "turnitin didn't flag it", "my ` +
  `teacher said nothing", "it still sounds like me". Name something that happened to ` +
  `you — an essay, a deadline, a class — rather than describing what the site does. `

/**
 * What SHAPE a comment takes. One definition, used by both prompts.
 *
 * Each voice is a different job, and which one lands is a thing to try rather
 * than reason about — it is a per-product setting on the comments page.
 */
export function voiceShapeRule(style: CommentStyle, mention: string): string {
  switch (style.voice) {
    // Ask the creator to measure what they are showing against ours. Nobody
    // argues with a question, and asking for the comparison already treats the
    // product as the thing worth comparing to.
    case 'question':
      return (
        `Write a QUESTION to the person in the video, ending in "?". Ask them to compare ` +
        `${mention} with what they are showing, to try it, or to make a video on it. ` +
        `Shapes to vary across the batch: "have you compared it with ${mention}?", "when ` +
        `will you show us trying ${mention}?", "how does this compare to ${mention}?", ` +
        `"does it give better results than ${mention}?", "would you run the same test on ` +
        `${mention}?". ` +
        `What is in question is THEIRS, never ours. Never ask whether ${mention} is any ` +
        `good, works, or is worth it. `
      )
    // The mirror image of the above: there the product is the subject, here the
    // PERSON is, and the product is an aside. That is what keeps it from
    // reading as an advert in question form.
    case 'curious':
      return (
        `Write a question to the creator about THEM — what they did, how they do it, what ` +
        `changed for them — ending in "?" and using "you". ` +
        `Mention the product in passing inside it, a few words at most, taking for granted ` +
        `it is good: "…? it came back clean for me every time". ` +
        `Never doubt it and never ask which is better. `
      )
    // A person answering "what do you use?". Plainer, and it says something a
    // reader can act on.
    case 'recommendation':
      return (
        `Write as someone who uses it and recommends it, in the first person from their own ` +
        `experience — "i use", "i switched to", "mine passes", "works for me". A ` +
        `recommendation, never a slogan. `
      )
    // What the thing IS, stated flatly. The least like an advert, because it
    // asks the reader for nothing.
    default:
      return (
        `State one plain fact and stop. No recommending, no praise, no superlatives, no ` +
        `comparisons, nothing in the first person. Say what it does in ordinary words: it ` +
        `fixes up writing so it sounds like a person wrote it, it comes back clean on ` +
        `turnitin, it keeps what you meant, it is a website you paste into. `
      )
  }
}

/** How to use the original comment it is given. Differs by voice. */
function rewriteRule(style: CommentStyle, mention: string): string {
  switch (style.voice) {
    case 'question':
      return (
        `Each original says something the product does well. Use it only to choose WHAT the ` +
        `comparison is about, then write a new question asking for it. `
      )
    case 'curious':
      return `Each original names something good. Fold it in as the aside, and ask about a related theme. `
    case 'recommendation':
      return `Keep the same core recommendation as the original — do not invent a new theme. `
    default:
      return `Keep the fact the original states; drop the opinion and the first person. `
  }
}

/** The rules every comment obeys, whichever prompt asked for it. */
export function outputRules(band: PromptBand, style: CommentStyle, mention: string): string {
  const q = style.voice === 'question' || style.voice === 'curious'
  return (
    `EVERY comment: ${q ? 'ends in "?", ' : ''}` +
    // Each input names its own exact length. Asking for a range produces a
    // clump — the model settles on one comfortable length and repeats it.
    `is exactly the number of words its line asks for (${band.min}-${band.max}), ` +
    `spells the product "${mention}" exactly, lowercase and casual, no hashtags, no quotes ` +
    `around it, and is not a tagline — no "#1", "secret weapon", "goat", "never fails", no ` +
    `crowning it, no wordplay on the name. ` +
    // Diversity has to be in the SUBJECT, or every comment is one sentence with
    // a different adjective in it.
    `Vary the batch by changing what each one is ABOUT, not by using bigger words. ` +
    (style.emoji
      ? `End each with one upbeat emoji that fits, varied across the batch; emoji do not ` +
        `count as words. `
      : `No emoji. `) +
    `Return strict JSON: {"comments": ["...", ...]}, one per input, same order.`
  )
}

// ── Audience-tailored comments ───────────────────────────────────────────────
// The same product, pitched three ways. A link's category (lib/linkCategory.ts)
// decides which set the app serves under it, so the comment answers what that
// video's viewers are actually thinking about.
//
// These live HERE rather than in commentGen for the same reason the main prompt
// does: the admin page can then show exactly what will be sent, instead of a
// description of it that drifts.

export const AUDIENCE_ANGLE: Record<LinkCategory, string> = {
  competitors:
    'AUDIENCE: the video promotes or reviews a RIVAL humanizer, and the viewer is already ' +
    'shopping for one.\n' +
    'YOUR SITUATION: someone who has genuinely been through several of these tools over months ' +
    `and settled on "{PRODUCT}" — not a fan, just someone who stopped looking.\n` +
    'WHAT TO SAY: that it is the one you ended up sticking with, and the one you trust ' +
    'when it actually matters. Earn that the way a real person does, with a small ' +
    'concrete reason: you kept getting flagged until you switched, you tried a few and ' +
    'this was the only one that came back clean, you stopped re-checking, it still ' +
    'sounds like you afterwards, you paid for others first and wish you had started ' +
    'here. Plain words only — no jargon, and do not describe what it does.\n' +
    'NEVER name the rival, and NEVER use comparison-ad words (beats, wins, unbeatable, ' +
    'outperforms, rivals, the competition, number one, hands down, game changer). Let the ' +
    'comparison live in your own experience. Write a comment, not a verdict.',
  ai_detector:
    'AUDIENCE: the video is about AI DETECTORS — Turnitin, GPTZero, Originality, Copyleaks, ' +
    'ZeroGPT, being flagged, AI percentage scores. The viewer is worried about getting ' +
    'caught and may not know a fix exists.\n' +
    'YOUR SITUATION: someone who had exactly that problem and for whom it is simply over now.\n' +
    `WHAT TO SAY: that with "{PRODUCT}" it stopped being a problem — told specifically, ` +
    'like a person, not a slogan. Vary what you anchor on: what the check said when it ' +
    'came back, the moment (pasting it in before handing it in, running it through again, ' +
    'the professor never saying anything), turnitin or gptzero by name, how many times it ' +
    'has held up, or that it still reads like your own writing afterwards. Ordinary ' +
    'words only.\n' +
    'Relief, not sales. Do not open every comment the same way, and do not simply say it ' +
    'saved you — say what actually happened.',
  generic:
    'AUDIENCE: general study, essay, homework or student content, with no tool being ' +
    'discussed. The viewer is not thinking about detectors, so lead with the writing rather ' +
    'than with a warning.\n' +
    'YOUR SITUATION: the same person as in the competitor case — someone who has tried the ' +
    `others and quietly uses "{PRODUCT}" for everything now.\n` +
    'WHAT TO SAY: recommend it with that same conviction — it is the one that actually ' +
    'works, the most reliable, it makes the writing read like you, and yes, it clears the ' +
    'checkers every time. Drop it in the way you would tell a classmate what you use: a ' +
    'tip, not a pitch.\n' +
    'Same ban: no beats / wins / unbeatable / rivals / number-one language.',
}

/** The audience paragraph with the product filled in. */
export function angleFor(product: Product, category: LinkCategory): string {
  return AUDIENCE_ANGLE[category].replace(/\{PRODUCT\}/g, product)
}

/**
 * The system prompt for ONE product's ONE audience.
 *
 * The same pieces as the ordinary prompt with the audience's angle inserted, so
 * the two cannot describe the voice or the register differently — they used to,
 * and the audience path had no naive-user rule at all.
 */
export function buildAudiencePrompt(
  product: Product,
  category: LinkCategory,
  band: PromptBand,
  style: CommentStyle
): string {
  const mention = productWords(product, style.splitBrand)
  return (
    productBackground(product) +
    SEP +
    angleFor(product, category) +
    SEP +
    NAIVE_VOICE +
    SEP +
    voiceShapeRule(style, mention) +
    // The original is a STYLE reference only. An earlier version said "keep its
    // general intent", and the three audiences came back nearly identical —
    // "purifytext beats rivals" / "purifytext saved me" — because the base
    // comment, not the angle, was driving the message.
    `The original is a style reference only: take its LENGTH and tone, and take its ` +
    `MESSAGE from the audience above. Say something that only makes sense to that ` +
    `audience. ` +
    SEP +
    outputRules(band, style, mention)
  )
}

/**
 * The system prompt for one product's ordinary comment set.
 *
 * Exported and pure so the admin page can SHOW what will be sent before it is
 * sent, and so an edited version can replace it wholesale. A prompt that can
 * only be read by running it is a prompt nobody edits.
 */
export function buildSystemPrompt(
  product: Product,
  band: PromptBand,
  style: CommentStyle
): string {
  const mention = productWords(product, style.splitBrand)
  return (
    productBackground(product) +
    SEP +
    NAIVE_VOICE +
    SEP +
    voiceShapeRule(style, mention) +
    rewriteRule(style, mention) +
    // Word-by-word conversion of the seed is the failure mode: it produces
    // "why did i switch to it and stop?" — wreckage that still ends in a
    // question mark, so no filter catches it.
    `Write a NEW sentence, not the original reworded. It must read correctly on its own. ` +
    SEP +
    outputRules(band, style, mention)
  )
}
