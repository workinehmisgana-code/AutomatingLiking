// The system prompt for one product's comment set — pure, and shared.
//
// It lives here rather than in commentGen so the ADMIN PAGE can build it too.
// commentGen imports the database and the Groq client, which a browser cannot
// load; this file imports nothing but config. That is what lets the prompt
// editor show the real prompt updating as the settings are changed, instead of
// a copy that drifts from what is actually sent.

import { productWords, type CommentStyle, type Product } from './config'

/** The word range a batch is asked for. Mirrors db.WordBand, without the import. */
export interface PromptBand {
  min: number
  max: number
}

/**
 * Who is writing, in every prompt that produces a comment.
 *
 * Shared rather than repeated: the audience prompt in commentGen did not have
 * this at all, so the two paths disagreed about who the writer was — one wrote
 * as a classmate and the other as the company.
 */
export const NAIVE_VOICE =
  `WHO YOU ARE: an ordinary person — a student, someone who writes for work — ` +
  `not an expert and not a reviewer. You do not know the technical words and you ` +
  `would not use them if you did. You are not explaining the tool, you are just ` +
  `mentioning something that worked for you, the way you would to a classmate. ` +
  `Use SMALL EVERYDAY WORDS and short simple sentences. Plain and a bit ` +
  `unpolished is right; neat and professional is wrong. ` +
  `NEVER use technical or marketing words. Banned: humanizer, humanize, ai content, ` +
  `ai-generated, bypass, undetectable, algorithm, output, input, software, platform, ` +
  `solution, technology, engine, generate, paraphrase, nlp, api, accuracy, ` +
  `seamless, effortless, optimise, and any talk of how it works under the hood. ` +
  `Say it the way a person would instead: "it came back clean", "my teacher didn't ` +
  `say anything", "turnitin didn't flag it", "it still sounds like me", "i stopped ` +
  `worrying about it", "the site i use". Name a real thing that happened to you — ` +
  `an essay, a deadline, a class — rather than describing what the site does. `

/**
 * What SHAPE each comment takes, for the two question voices.
 *
 * The audience prompt used to ask for a question only when the voice was
 * 'question'. Under the 'curious' voice it asked for nothing of the sort while
 * the filter still demanded one — so every line was rejected and all three
 * audiences failed with "No valid rewrites returned". One helper now, used by
 * both prompts, so the ask and the check cannot drift apart again.
 */
export function voiceShapeRule(style: CommentStyle): string {
  if (style.voice === 'question') {
    return (
      `Every comment is a QUESTION ending in a question mark, and it must ASSUME the ` +
      `product already works rather than asking whether it does. Never ask "is it any ` +
      `good", "does it actually work", "has anyone tried" or "which is better". `
    )
  }
  if (style.voice === 'curious') {
    return (
      `Every comment is a question ASKED OF A PERSON — the creator, or whoever wrote the ` +
      `comment above. Address them directly as "you", and end with a question mark. ` +
      `The question is about THEM: what they did, how they do it, what changed for them. ` +
      `The product is mentioned in passing inside that question, as a short aside that ` +
      `takes for granted it is good — a few words, never the subject. Never doubt it and ` +
      `never ask which is better. `
    )
  }
  if (style.voice === 'informational') {
    return (
      `State the fact and stop. No recommending, no praising, no superlatives, no ` +
      `comparisons, and nothing in the first person about your own results. `
    )
  }
  return ''
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
    `"${product}" is an AI humanizer website — it rewrites AI-generated text so it reads ` +
    `as human and bypasses every AI detector (Turnitin, GPTZero, Originality, Copyleaks, ` +
    `ZeroGPT, etc.). ` +
    // Said once, plainly: the paragraph above is context for YOU. The model
    // otherwise treats the description as the vocabulary it is supposed to use,
    // and every comment comes back sounding like the product's own about page.
    `That paragraph is background for you only — it is NOT how to write. Never repeat ` +
    `those words in a comment. ` +
    // The voice is the whole job here, and there are three of them. Which one
    // lands is a thing to try rather than reason about, so it is a per-product
    // setting on the comments page.
    //
    // QUESTION: the claim is carried in the PRESUPPOSITION rather than the
    // words. "why does purify text get through when the others don't" only
    // makes sense if it does, so the reader supplies the conclusion instead of
    // being told it.
    //
    // RECOMMENDATION: a person saying what they use and why it worked. Plainer,
    // and it says something a reader can act on — but six of them under one
    // video start to read as advertising.
    //
    // INFORMATIONAL: what the thing IS, stated flatly. No endorsement, no
    // superlative, no first person. The least like an advert of the three,
    // because it does not ask the reader for anything.
    //
    // All three replaced an earlier "hype it up" instruction that produced
    // mascot lines — "is my league forever", "takes the obvious #1 spot" —
    // which say nothing a reader can act on and read as paid promotion at a
    // glance.
    (style.voice === 'question'
      ? `Every comment you write is a QUESTION — one a real person would type under ` +
        `this video, ending in a question mark. ` +
        `The recommendation must never be stated outright. It has to be ASSUMED by the ` +
        `question, so that the question only makes sense if the product already works: ` +
        `that it is the best humanizer and that it gets work past every detector at 0% AI. ` +
        `Ask about the how, the why, the what-next, someone else's experience, or your own ` +
        `surprise — for example "how is it the only one still getting past turnitin", ` +
        `"is it normal for it to come back 0% every single time", "does anyone else run ` +
        `everything through it before submitting", "why does nothing else touch it". ` +
        `NEVER ask a question that doubts it, invites a comparison it could lose, or asks ` +
        `whether it works — no "is it any good", no "does it actually work", no "has anyone ` +
        `tried", no "should i use". The answer is already settled; the question is about ` +
        `something else. `
      : style.voice === 'curious'
        ? `Every comment you write is a question ASKED OF A PERSON — the creator of the ` +
          `video, or whoever wrote the comment above. Address them directly as "you", and ` +
          `ask something you would genuinely want an answer to. It ends in a question mark. ` +
          // The difference from the rhetorical style is the direction of the
          // sentence. There the product is the subject and the question is a
          // device; here the question is about the PERSON and the product is
          // an aside, which is what stops it reading as an advert in question
          // form.
          `The QUESTION is about them: what they did, how they do it, what they would ` +
          `pick, how long they have been at it, what changed for them. ` +
          `The product is mentioned IN PASSING, inside that question, as something that ` +
          `is good — a clause, not the subject. Say it plainly and briefly and move on: ` +
          `"the flow reads really clean", "it comes back clean every time", "that one ` +
          `actually holds up". Never spend more than a few words on it. ` +
          `For example: "what made you switch to it? the output reads really clean", ` +
          `"how long did it take you to trust it after it started passing everything", ` +
          `"do you run everything through it first, or only the long assignments". ` +
          `Curious, friendly, low-key. NEVER doubt it, never ask whether it works, never ` +
          `ask which is better — the aside takes for granted that it is good, and the ` +
          `question is about the person. `
      : style.voice === 'recommendation'
        ? `You write comments from ONE point of view: a real person who has used it and ` +
          `recommends it as the best humanizer — the one that gets their work past every ` +
          `detector, at 0% AI, every time. ` +
          `Write a RECOMMENDATION, never a slogan. It must sound like someone answering ` +
          `"what do you use?" in a comment section — first person, from their own experience ` +
          `("i use", "i switched to", "mine passes", "works for me"). `
        : `You write PLAIN INFORMATION, nothing more. State what the tool is and what it ` +
          `does, as a neutral fact someone might mention in passing. ` +
          `Do NOT recommend it, do NOT praise it, do NOT call it the best or the only one, ` +
          `do NOT compare it to anything, and do NOT speak in the first person about your ` +
          `own results — no "i use", no "mine passes", no "works for me", no "you should". ` +
          `No superlatives at all: nothing is best, top, perfect, unbeatable, amazing or ` +
          `a must. ` +
          // Still the plainest voice of the four, but plain is not the same as
          // technical: "the output comes back clean on detectors" is how a
          // company writes, not how someone mentions a site to a classmate.
          `Say what it does in ORDINARY WORDS, the way one person tells another about a ` +
          `site they know: it fixes up writing so it sounds like a person wrote it, it ` +
          `comes back clean on turnitin, it keeps what you meant, it works on essays, it ` +
          `is just a website you paste into. One small fact per comment, said evenly, ` +
          `with no jargon and no explaining how it does it. `) +
    // WHO IS TALKING. Everything above says what the comment is FOR; this says
    // who it sounds like, and it applies to all four voices.
    //
    // The writer is an ordinary person who does not know the jargon and has no
    // reason to. They are not reviewing a tool, they are mentioning a thing that
    // worked. The moment a comment explains HOW it works it stops sounding like
    // a classmate and starts sounding like the company, which is the one thing
    // a comment section notices.
    `WHO YOU ARE: an ordinary person — a student, someone who writes for work — ` +
    `not an expert and not a reviewer. You do not know the technical words and you ` +
    `would not use them if you did. You are not explaining the tool, you are just ` +
    `mentioning something that worked for you, the way you would to a classmate. ` +
    `Use SMALL EVERYDAY WORDS and short simple sentences. Plain and a bit ` +
    `unpolished is right; neat and professional is wrong. ` +
    `NEVER use technical or marketing words. Banned: humanizer, humanize, ai detector, ` +
    `detection, detector score, bypass, undetectable, algorithm, ai content, output, ` +
    `input, tool, software, platform, solution, feature, technology, generate, ` +
    `paraphrase, rewrite engine, nlp, model, prompt, accuracy, percentage scores like ` +
    `"0%" or "100%", and any talk of how it works under the hood. ` +
    `Say it the way a person would instead: "it came back clean", "my teacher didn't ` +
    `say anything", "turnitin didn't flag it", "it still sounds like me", "i stopped ` +
    `worrying about it", "the site i use". Name a real thing that happened to you — ` +
    `an essay, a deadline, a class — rather than describing what the site does. ` +
    `Banned outright: taglines, mascot lines, ad copy and anything that reads like a ` +
    `brand caption — no "#1", no "secret weapon", no "holy grail", no "goat", no ` +
    `"undefeated", no "king of", no "never fails" as a catchphrase, no crowning it, ` +
    `no rhymes, no wordplay on the product name. ` +
    (style.voice === 'question'
      ? `For each original comment, write ONE fresh QUESTION that rests on the SAME core ` +
        `claim as the original — that it is the best humanizer and that it passes the ` +
        `detectors. Do not invent unrelated themes and do not drop the claim. ` +
        // Converting the seed sentence word by word is the failure mode: it
        // produces lines like "why did i switch to it and stop?" and "how did
        // gptzero used to catch me before it?" - grammatical wreckage that
        // still ends in a question mark, so no filter catches it.
        `Do NOT turn the original sentence into a question word by word. Read what the ` +
        `original is about, then write a NEW, natural question about that same thing — ` +
        `one a person would actually type. It must read correctly as English on its own, ` +
        `with no leftover fragments from the original. `
      : style.voice === 'curious'
        ? `Each original comment names something good about the tool. For each one, write ` +
          `ONE question to the person, on a related theme, with that good thing folded in ` +
          `as a short aside. The question must stand on its own as natural English — do ` +
          `not convert the original sentence word by word. `
      : style.voice === 'recommendation'
        ? `For each original comment, write ONE fresh comment that keeps the SAME core ` +
          `recommendation as the original — that it is the best humanizer and that it passes ` +
          `the detectors. Do not invent unrelated themes and do not drop the claim. `
        : `Each original comment names a fact about the tool. For each one, write ONE ` +
          `fresh sentence stating that same fact plainly, with the opinion and the ` +
          `first person taken out. Keep what it says about detectors; drop any claim ` +
          `that it is the best or that it beats anything else. `) +
    // Diversity has to be in the REASON, not in the adjectives, or every comment
    // becomes the same sentence with a different superlative in it.
    `Make the batch genuinely varied by changing WHAT each ` +
    (style.voice === 'question'
      ? 'question is about'
      : style.voice === 'curious'
        ? 'question asks the person'
        : style.voice === 'recommendation'
          ? 'recommendation rests on'
          : 'comment states') +
    `, not by swapping in bigger words: the detector that used to catch you, the score ` +
    `that came back, the assignment you trusted it with, how long you have used it, that ` +
    `it still sounds like your own writing, that you stopped double-checking, who else ` +
    `uses it. Different comments should lean on different ones of those` +
    (style.voice === 'question' || style.voice === 'curious'
      ? `, and they must not all open the same way — vary between how, why, what, when, ` +
        `did you, do you and would you. `
      : `. `) +
    `Every rewrite MUST: ` +
    (style.voice === 'question' || style.voice === 'curious' ? 'end in a question mark, ' : '') +
    `be between ${band.min} and ${band.max} words, ` +
    `match the EXACT word count requested for its line (each input names one), ` +
    `so the batch contains a real mix of short and long comments, ` +
    `write the product as the two words ${mention} - exactly that spelling and ` +
    `spacing, and do NOT put quotes around it - be lowercase and casual like a real ` +
    `social-media reply, contain no hashtags and no quotes around the whole comment. ` +
    (style.emoji
      ? `End each comment with one upbeat emoji that fits what it says - vary them ` +
        `across the batch. Emoji do not count towards the word total. `
      : `Use no emoji at all. `) +
    `Return strict JSON: {"comments": ["...", ...]} with one rewrite per input, in the same order.`
  )
}
