// EVERY PROMPT THIS APP SENDS. One file, on purpose.
//
// They used to live in seven: the genre copy here, the comment builders in
// commentPrompt.ts, the "mark unrelated" question in titleClassify.ts, the
// audience categoriser in linkCategory.ts, the reply prompts in replyGen.ts,
// the promo brief in promoGen.ts and the presence analysis inside an API route.
// Every one of them was findable and none of them was findable TOGETHER, which
// is what you need when the question is "what are we actually telling the
// model" or "why does this product sound like that one".
//
// WHAT IS WHERE, top to bottom:
//
//   GENRE_COPY          per genre: what the product is, who is writing, the
//                       pitch per audience, the advert-words to reject, how a
//                       reply introduces it, the promo brief, and what counts
//                       as RELATED for the "Mark unrelated" button
//   comments + replies  the builders that assemble those parts into a prompt,
//                       plus the rules that do NOT vary by genre — word
//                       count, shape, emoji, the JSON contract
//   classifying         sorting a link into one audience
//   replies             what to say under somebody else's comment
//   everything else     promo captions, the presence analysis, the test probe
//
// TWO RULES THAT KEEP IT ONE FILE:
//
//   1. A generator may not write its own instruction text. scripts/
//      check-prompts-central.ts fails the build of anybody who does — a
//      system message has to name something defined here.
//   2. This file stays PURE: config and types only, nothing that reaches a
//      database or the network. The admin comments page renders the real
//      prompt in the browser, and a browser cannot load either.
//
// Changing wording here changes what thousands of public comments say, so
// scripts/snapshot-prompts.ts renders all 126 of them to JSON: snapshot, edit,
// snapshot again, and read the diff before deploying.

import {
  genreOfProduct,
  PROMO_EXTRA_TAG_MAX,
  PROMO_TITLE_COUNT,
  productForms,
  productWords,
  type CommentStyle,
  type Genre,
  type LinkCategory,
  type Product,
} from './config'
import type { WordBand } from './db'

export interface GenreCopy {
  /** One sentence: what the product is. `{PRODUCT}` is substituted. */
  what: string
  /**
   * Who is writing, the words they would never use, and the ones they would.
   *
   * The ban list is deliberately short and matches `jargon` below. A longer list
   * starves the model — banning "detector" and "tool" once left the AI-detector
   * audience with nothing to say and every batch came back empty.
   */
  voice: string
  /** The angle for each audience. `{PRODUCT}` is substituted. */
  angles: Record<LinkCategory, string>
  /**
   * Regex sources for words that read as an advert in this domain.
   *
   * Added to a shared core (see SHARED_JARGON). Narrow on purpose: a filter that
   * leaves nothing for the model to say produces empty batches, not better
   * comments.
   */
  jargon: string[]
  /** What a comment must be about before a reply belongs under it at all. */
  replyRelevance: string
  /** How a reply introduces the product, in one clause. */
  replyMention: string
  /** The brief for promo-video captions. `{PRODUCT}` is substituted. */
  promo: string
  /**
   * What makes a video RELATED to this genre, for the staging-list marker.
   *
   * The Links-to-verify page asks a model which staged titles are about this
   * genre at all, and blocks the rest. That question is entirely domain
   * specific: a video about building a website is unrelated to humanizers and
   * related to cocodly, and the same sentence cannot ask both. It was written
   * for humanizers only, so pressing the button on a website channel's links
   * marked every one of them unrelated.
   *
   * `subject` goes into the model's instruction; `keywords` is the
   * deterministic safety net underneath it — a title literally containing one
   * of these is related whatever the model says, which is what stops a short
   * or misaligned answer from binning obviously-relevant links. Keywords are
   * matched against a lowercased, alphanumerics-only form, so write them that
   * way: "ai detector" as "aidetector".
   */
  related: { subject: string; keywords: string[] }
  /**
   * The worked examples inside the three non-question voice shapes.
   *
   * These were inlined in voiceShapeRule and were pure humanizer: the plain-fact
   * voice told the model to say the product "fixes up writing so it sounds like
   * a person wrote it, it comes back clean on turnitin", and the recommendation
   * voice offered "mine passes" as a phrasing. A cocodly prompt carried all of
   * it — a website builder described as a Turnitin tool, under the right product
   * name, which is the most expensive kind of wrong because it reads fluently.
   *
   * One line each, written as the model should write it.
   */
  voiceExamples: {
    /** The product as a passing aside in a question about the creator. */
    curiousAside: string
    /** First-person phrasings a recommendation can use. */
    recommendVerbs: string
    /** What the product IS, stated flatly, with no opinion in it. */
    plainFact: string
  }
}

/**
 * The company's nouns for itself, in any domain.
 *
 * "tool" is deliberately absent: people do say "this tool", and banning it cost
 * more than it bought.
 */
export const SHARED_JARGON = [
  String.raw`\b(software|platform|solution|technology|engine)\b`,
  String.raw`\b(output|input)s?\b`,
  String.raw`\b(accuracy|efficiency|seamless(ly)?|effortless(ly)?|optimi[sz]e[ds]?)\b`,
]

// The three below are word-for-word what voiceShapeRule used to hardcode, so
// the humanizer prompts are unchanged by this move.
const HUMANIZER_VOICE_EXAMPLES = {
  curiousAside: '"…? it came back clean for me every time"',
  recommendVerbs: '"i use", "i switched to", "mine passes", "works for me"',
  plainFact:
    'it fixes up writing so it sounds like a person wrote it, it comes back clean on ' +
    'turnitin, it keeps what you meant, it is a website you paste into',
}

// Word for word what titleClassify.ts asked before the question had a genre,
// so the humanizer marker behaves identically after the move.
const HUMANIZER_RELATED = {
  subject:
    'about any of these topics/brands: humanizer, AI detector, AI detectors, NaturalWrite (the ' +
    'humanizer), GrubbyAI (the humanizer), WalterWritesAI (the humanizer), Undetectable AI, ' +
    'AI humanizer, Turnitin (the AI detector), GPTZero (the AI detector), Originality AI (the ' +
    'detector), AI detection, or humanize (humanizing AI-generated text so it reads as human / ' +
    'bypasses AI detectors)',
  keywords: [
    'humanizer', // covers "ai humanizer"
    'humanize',
    'aidetector', // covers "ai detectors"
    'aidetection',
    'naturalwrite',
    'grubbyai',
    'walterwrites', // covers "walter writes ai"
    'undetectableai',
    'turnitin',
    'gptzero',
    'originalityai',
    'bypassai',
    'bypassgpt',
    '#essay',
    'essayhacks',
    'essaytips',
    'essaywriting',
  ],
}

const HUMANIZER: GenreCopy = {
  what:
    `"{PRODUCT}" is a website that rewrites AI-written text so it reads as human and ` +
    `gets past AI detectors (Turnitin, GPTZero, Originality, Copyleaks, ZeroGPT).`,
  voice:
    `WHO YOU ARE: an ordinary person — a student, someone who writes for work. Not an ` +
    `expert, not a reviewer. You do not know the technical words. Small everyday words, ` +
    `short sentences, a bit unpolished. ` +
    `NEVER write: humanizer, ai content, bypass, undetectable, algorithm, paraphrase, ` +
    `output, software, platform, generate, seamless, or how it works inside. ` +
    `Write like this instead: "it came back clean", "turnitin didn't flag it", "my ` +
    `teacher said nothing", "it still sounds like me". Name something that happened to ` +
    `you — an essay, a deadline, a class — rather than describing what the site does. `,
  angles: {
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
  },
  jargon: [
    String.raw`\bhumaniz(e|es|ed|er|ers|ing|ation)\b`,
    String.raw`\bai[\s-]?(content|text|writing|generated)\b`,
    String.raw`\bbypass(es|ed|ing)?\b`,
    String.raw`\bundetectable\b`,
    String.raw`\balgorithm(s|ic)?\b`,
    String.raw`\bparaphras(e|es|ed|ing|er)\b`,
    String.raw`\b(nlp|api)\b`,
    String.raw`\bgenerat(e|es|ed|ing|ion)\b`,
  ],
  replyRelevance:
    'ONLY reply when the comment is about AI WRITING or AI DETECTION: humanizers, paraphrasers, ' +
    '"bypass AI", Turnitin, GPTZero and other detectors, being flagged or caught, ' +
    'ChatGPT-written essays, or how to make AI text sound human.\n',
  replyMention:
    'a humanizer that rewrites AI text so it reads as human and passes AI detectors',
  promo:
    `"{PRODUCT}" is an AI humanizer website — it rewrites AI text so it reads as human and ` +
    `bypasses every AI detector (Turnitin, GPTZero, Originality, Copyleaks, ZeroGPT). It is the ` +
    `best humanizer right now. Generate short, catchy social-media video captions/titles that ` +
    `advertise "{PRODUCT}" in that light (best humanizer, beats all detectors, 0% AI)`,
  voiceExamples: HUMANIZER_VOICE_EXAMPLES,
  related: HUMANIZER_RELATED,
}

const WEBSITE: GenreCopy = {
  what:
    `"{PRODUCT}" is a website that builds a working website for you from a description — ` +
    `the pages, the words on them and the layout — with no coding.`,
  voice:
    `WHO YOU ARE: an ordinary person — someone with a small business, a side project, a ` +
    `portfolio to put up. Not a developer, not a designer. You do not know the technical ` +
    `words. Small everyday words, short sentences, a bit unpolished. ` +
    `NEVER write: no-code, deploy, responsive, SEO, conversion, drag-and-drop, template ` +
    `engine, hosting, domain setup, software, platform, solution, seamless, or how it works ` +
    `inside. ` +
    `Write like this instead: "it was live the same evening", "i can't code at all", ` +
    `"a client asked who made it", "cheaper than the quote i got", "i only changed the ` +
    `photos". Name something that happened to you — a launch, a client, a deadline — rather ` +
    `than describing what the site does. `,
  angles: {
    competitors:
      'AUDIENCE: the video promotes or reviews a RIVAL website builder, and the viewer is ' +
      'already shopping for one.\n' +
      'YOUR SITUATION: someone who tried a few of these over months and settled on ' +
      `"{PRODUCT}" — not a fan, just someone who stopped looking.\n` +
      'WHAT TO SAY: that it is the one you ended up keeping. Earn it the way a real person ' +
      'does, with one small concrete reason: you gave up on a template halfway, this one ' +
      'wrote the pages as well as building them, it was live the same day, a client asked ' +
      'who designed it, you had paid for another first. Plain words only — no jargon, and do ' +
      'not describe what it does.\n' +
      'NEVER name the rival, and NEVER use comparison-ad words (beats, wins, unbeatable, ' +
      'outperforms, rivals, the competition, number one, hands down, game changer). Let the ' +
      'comparison live in your own experience. Write a comment, not a verdict.',
    // NOT USED. The categoriser only assigns audiences to humanizer links, and
    // fallbackCategory sends this genre to `generic` — a video about Turnitin has
    // nothing to do with building a website. Kept pointing at the general angle
    // so a stray link with this category still gets a comment that makes sense,
    // rather than one about AI detectors.
    ai_detector:
      'AUDIENCE: general content about getting something online — a business, a portfolio, a ' +
      'side project — with no tool being discussed.\n' +
      `YOUR SITUATION: someone who built theirs with "{PRODUCT}" and found it easy.\n` +
      'WHAT TO SAY: what you put up and how quickly, in ordinary words. A tip, not a pitch.',
    generic:
      'AUDIENCE: general small-business, freelance, portfolio or side-project content, with no ' +
      'tool being discussed. The viewer is not shopping for a builder, so lead with what you ' +
      'got rather than with the thing you used.\n' +
      'YOUR SITUATION: the same person as in the competitor case — someone who built theirs ' +
      `with "{PRODUCT}" and now uses it for everything.\n` +
      'WHAT TO SAY: recommend it the way you would tell someone at the next table what you ' +
      'used — it did the whole site, you did not write a line of code, it took an evening, ' +
      'it cost less than the quote. A tip, not a pitch.\n' +
      'Same ban: no beats / wins / unbeatable / rivals / number-one language.',
  },
  jargon: [
    String.raw`\bno[\s-]?code\b`,
    String.raw`\bdeploy(s|ed|ing|ment)?\b`,
    String.raw`\bresponsive\b`,
    String.raw`\bseo\b`,
    String.raw`\bconversion(s)?\b`,
    String.raw`\bdrag[\s-]?and[\s-]?drop\b`,
    String.raw`\b(cms|api|ui|ux)\b`,
    String.raw`\bscalab(le|ility)\b`,
    String.raw`\bboilerplate\b`,
  ],
  replyRelevance:
    'ONLY reply when the comment is about GETTING A WEBSITE MADE: needing a site, not being ' +
    'able to code, what a developer quoted, website builders, templates, a landing page, a ' +
    'portfolio or a shop to put online.\n',
  replyMention:
    'a site builder that makes the whole website — pages and words — from a description, with ' +
    'no coding',
  promo:
    `"{PRODUCT}" builds a whole working website from a description — the pages, the copy and ` +
    `the layout, with no coding. Generate short, catchy social-media video captions/titles ` +
    `that advertise "{PRODUCT}" in that light (a site in minutes, no code, cheaper than a ` +
    `developer)`,
  related: {
    subject:
      'about building or making a WEBSITE: website builders, AI website builders, no-code site ' +
      'builders, landing pages, making a site for a business or portfolio, web design, ' +
      'Wix, Squarespace, Webflow, Framer, WordPress, Shopify, Lovable, v0, Bolt, Durable, ' +
      'Hostinger AI, GoDaddy, 10Web, or getting a site online without a developer',
    // Lowercased, alphanumerics only - the matcher strips everything else.
    keywords: [
      'websitebuilder',
      'aiwebsite',
      'buildawebsite',
      'buildyourwebsite',
      'makeawebsite',
      'landingpage',
      'nocode',
      'webflow',
      'squarespace',
      'wordpress',
      'shopify',
      'framer',
      'lovable',
      'durable',
      'hostinger',
      'godaddy',
      '10web',
      'webdesign',
      'portfoliosite',
    ],
  },
  voiceExamples: {
    curiousAside: '"\u2026? mine was live the same evening"',
    recommendVerbs: '"i used", "i built mine with", "mine took an evening", "worked for me"',
    plainFact:
      'it builds the whole site from a description, it writes the pages as well as laying ' +
      'them out, it needs no coding, it is a website you type into',
  },
}

const SLIDES: GenreCopy = {
  what:
    `"{PRODUCT}" is a website that builds a slide deck for you from a topic or your notes — ` +
    `the slides, the layout and the speaker notes.`,
  voice:
    `WHO YOU ARE: an ordinary person — a student with a presentation due, someone who has to ` +
    `present at work. Not a designer. You do not know the technical words. Small everyday ` +
    `words, short sentences, a bit unpolished. ` +
    `NEVER write: deck automation, visually stunning, engage your audience, storytelling ` +
    `framework, template library, software, platform, solution, seamless, or how it works ` +
    `inside. ` +
    `Write like this instead: "it was done before class", "i'd have been up all night", ` +
    `"my lecturer asked for the template", "i pasted my notes in", "the group let me do the ` +
    `deck now". Name something that happened to you — a seminar, a deadline, a defence — ` +
    `rather than describing what the site does. `,
  angles: {
    competitors:
      'AUDIENCE: the video promotes or reviews a RIVAL slide or deck tool, and the viewer is ' +
      'already shopping for one.\n' +
      'YOUR SITUATION: someone who tried a few of these and settled on ' +
      `"{PRODUCT}" — not a fan, just someone who stopped looking.\n` +
      'WHAT TO SAY: that it is the one you kept. One small concrete reason: the others gave ' +
      'you a pretty template and no content, this one read your notes, it picked a better ' +
      'order than you would, your lecturer asked where the deck came from, it did the ' +
      'speaker notes you never write. Plain words only — no jargon, and do not describe what ' +
      'it does.\n' +
      'NEVER name the rival, and NEVER use comparison-ad words (beats, wins, unbeatable, ' +
      'outperforms, rivals, the competition, number one, hands down, game changer). Let the ' +
      'comparison live in your own experience. Write a comment, not a verdict.',
    // NOT USED — see the note in the website genre. Points at the general angle.
    ai_detector:
      'AUDIENCE: general study or presentation content, with no tool being discussed.\n' +
      `YOUR SITUATION: someone whose last deck came out of "{PRODUCT}".\n` +
      'WHAT TO SAY: what you had due and how fast it was done, in ordinary words. A tip, not ' +
      'a pitch.',
    generic:
      'AUDIENCE: general study, coursework, seminar or workplace-presentation content, with no ' +
      'tool being discussed. The viewer is not shopping for one, so lead with the evening you ' +
      'got back rather than with the thing you used.\n' +
      'YOUR SITUATION: the same person as in the competitor case — someone whose decks all ' +
      `come out of "{PRODUCT}" now.\n` +
      'WHAT TO SAY: recommend it the way you would tell a classmate what you use — it was ' +
      'done before the class, you pasted your notes in, it did the design part you have no ' +
      'eye for. A tip, not a pitch.\n' +
      'Same ban: no beats / wins / unbeatable / rivals / number-one language.',
  },
  jargon: [
    String.raw`\bdeck automation\b`,
    String.raw`\bvisually stunning\b`,
    String.raw`\bengage(s|d|ment)?\s+(your\s+)?audience\b`,
    String.raw`\bstorytelling\b`,
    String.raw`\b(api|ui|ux)\b`,
    String.raw`\bbrand(ed|ing)\s+(kit|guidelines)\b`,
    String.raw`\binfographic(s)?\b`,
  ],
  replyRelevance:
    'ONLY reply when the comment is about PRESENTATIONS OR SLIDES: a deck due, powerpoint, ' +
    'google slides, having to present, spending all night on slides, or not being able to ' +
    'make them look right.\n',
  replyMention:
    'a slide maker that builds the whole deck — slides and speaker notes — from your notes or ' +
    'a topic',
  promo:
    `"{PRODUCT}" builds a whole slide deck from a topic or your notes — slides, layout and ` +
    `speaker notes. Generate short, catchy social-media video captions/titles that advertise ` +
    `"{PRODUCT}" in that light (a deck in minutes, from your notes, done before class)`,
  related: {
    subject:
      'about making a PRESENTATION or SLIDE DECK: slide decks, presentations, PowerPoint, ' +
      'Google Slides, Keynote, Canva presentations, AI presentation makers, pitch decks, ' +
      'thesis or seminar presentations, slide design, or turning notes into slides',
    keywords: [
      'powerpoint',
      'slidedeck',
      'slides',
      'presentation',
      'pitchdeck',
      'googleslides',
      'keynote',
      'gamma',
      'tome',
      'beautifulai',
      'slidesgo',
      'canvapresentation',
      'thesisdefence',
      'thesisdefense',
    ],
  },
  voiceExamples: {
    curiousAside: '"\u2026? mine was done before the class started"',
    recommendVerbs: '"i used", "i paste my notes into", "mine took minutes", "works for me"',
    plainFact:
      'it builds the whole deck from a topic or your notes, it lays the slides out, it ' +
      'writes the speaker notes, it is a website you paste into',
  },
}

export const GENRE_COPY: Record<Genre, GenreCopy> = {
  humanizer: HUMANIZER,
  website: WEBSITE,
  slides: SLIDES,
}

/** The copy for a product's genre. */
export function copyForProduct(product: string): GenreCopy {
  return GENRE_COPY[genreOfProduct(product)]
}

/** Substitute the product name into one of the templates above. */
export function withProduct(text: string, product: string): string {
  return text.replace(/\{PRODUCT\}/g, product)
}

// ════════════════════════════════════════════════════════════════════════════
// COMMENTS AND REPLIES: assembling a prompt from the copy above
// ════════════════════════════════════════════════════════════════════════════
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
  // WHAT THE PRODUCT IS comes from the genre table, not from here. This used to
  // state the humanizer definition inline, which was invisible while every
  // product was a humanizer and wrong the moment one was not: a website builder
  // described to the model as something that beats Turnitin produces comments
  // about AI detectors under videos about building a website.
  return (
    `${withProduct(copyForProduct(product).what, product)} ` +
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
/**
 * Who is writing, for one product's genre.
 *
 * A FUNCTION NOW, not a constant: the words an ordinary person would never use
 * are domain-specific, and so are the ones they would. "turnitin didn't flag it"
 * is exactly the register for a humanizer and nonsense for a slide deck.
 */
export function naiveVoice(product: Product): string {
  return copyForProduct(product).voice
}

/**
 * What SHAPE a comment takes. One definition, used by both prompts.
 *
 * Each voice is a different job, and which one lands is a thing to try rather
 * than reason about — it is a per-product setting on the comments page.
 */
export function voiceShapeRule(
  style: CommentStyle,
  mention: string,
  /**
   * The product, for the worked examples in the non-question voices.
   *
   * THREE OF THE FOUR VOICES USED TO BE HUMANIZER-ONLY. The plain-fact voice
   * told the model to say the product "comes back clean on turnitin", the
   * recommendation voice offered "mine passes", and the curious aside was
   * "it came back clean for me every time" — so a cocodly prompt described a
   * website builder as a Turnitin tool under the right name. Fluent, confident
   * and entirely wrong, which is the worst way for a prompt to be broken.
   *
   * Optional so the admin page's preview and any older caller still compile;
   * absent means the default genre, which is what every caller meant before
   * genres existed.
   */
  product?: Product
): string {
  const ex = copyForProduct(product ?? '').voiceExamples
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
        `${mention}?", "is it better than ${mention}?". ` +
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
        `it is good: ${ex.curiousAside}. ` +
        `Never doubt it and never ask which is better. `
      )
    // A person answering "what do you use?". Plainer, and it says something a
    // reader can act on.
    case 'recommendation':
      return (
        `Write as someone who uses it and recommends it, in the first person from their own ` +
        `experience — ${ex.recommendVerbs}. A ` +
        `recommendation, never a slogan. `
      )
    // What the thing IS, stated flatly. The least like an advert, because it
    // asks the reader for nothing.
    default:
      return (
        `State one plain fact and stop. No recommending, no praise, no superlatives, no ` +
        `comparisons, nothing in the first person. Say what it does in ordinary words: ` +
        `${ex.plainFact}. `
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
export function outputRules(
  band: PromptBand,
  style: CommentStyle,
  mention: string,
  // Every phrasing the comment may use, canonical first — "purify text",
  // "purify texted", "purify texting". Given to the model so the name can be
  // conjugated into the sentence instead of dropped into a gap in it. Defaults
  // to the mention alone, which is what a caller that has no product to hand
  // can honestly offer.
  forms: readonly string[] = [],
  // False when the request does NOT give each line its own word count — the
  // mimic prompt does not. Left true there, the model was being told to hit "the
  // number of words its line asks for" by a request that asked for no such
  // thing, and it mangled sentences trying to obey: "prohumanly saved my a
  // midnight" is five words and not English.
  perLineLength = true
): string {
  const q = style.voice === 'question' || style.voice === 'curious'
  return (
    `EVERY comment: ${q ? 'ends in "?", ' : ''}` +
    // Each input names its own exact length. Asking for a range produces a
    // clump — the model settles on one comfortable length and repeats it.
    (perLineLength
      ? `is exactly the number of words its line asks for (${band.min}-${band.max}), `
      : `is ${band.min}-${band.max} words and reads as a real sentence, `) +
    `writes the product as ORDINARY WORDS inside the sentence — ` +
    `${(forms.length ? forms : [mention]).map((f) => `"${f}"`).join(', ')}` +
    `${forms.length > 1 ? ', whichever fits the grammar' : ''} — ` +
    `all lowercase, spelled with the space, never joined into one word, never capitalised, ` +
    `no quotation marks around it, no hashtag, and never at the very start of the sentence. ` +
    `It is something you are talking about, not a name you are announcing. ` +
    `Not a tagline — no "#1", "secret weapon", "goat", "never fails", no crowning it, no ` +
    `wordplay on the name. ` +
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

/**
 * Write like the comment already under this video.
 *
 * Used when the liker finds a comment recommending a RIVAL tool and wants ours
 * said the same way. Everything the ordinary prompt says about voice, length,
 * spelling and banned words still applies — this only replaces the part that
 * decides WHAT the comment is about, which here is "whatever that one was
 * about".
 *
 * THE ONE RULE THIS ADDS is against copying. A model given one comment and
 * asked for another will hand back the same sentence with the brand swapped,
 * and the same sentence under fifty videos is a pattern somebody can search
 * for. It is told, in as many words, to write a different sentence that makes
 * the same point.
 */
export function buildMimicPrompt(
  product: Product,
  band: PromptBand,
  style: CommentStyle
): string {
  const mention = productWords(product, style.splitBrand)
  const forms = productForms(product)
  return (
    productBackground(product) +
    SEP +
    naiveVoice(product) +
    SEP +
    voiceShapeRule(style, mention, product) +
    SEP +
    `You are given ONE real comment from under the video, which recommends some ` +
    `other tool. Write comments that would sit naturally beside it: the same kind ` +
    `of person, the same register, the same sort of claim, about "${mention}" ` +
    `instead. ` +
    // Matching the shape is the point; matching the words is the failure.
    `Do NOT rewrite it or swap the name in it — write your own sentence that makes ` +
    `the same kind of point. Different words, same vibe. ` +
    // Slang in, slang out. A comment that reads as an advert beside a thread of
    // "fr this saved me" is the thing being avoided.
    `Match how it is written: if it is lowercase and slangy, so are yours; if it ` +
    `is a full sentence, so are yours. Never name the other tool. ` +
    SEP +
    outputRules(band, style, mention, forms, false)
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

/**
 * The angle for each audience, for one genre.
 *
 * MOVED TO genreCopy.ts. An audience is a fact about the VIDEO — what its
 * viewers are already thinking about — so the same three slots mean different
 * things per genre: "the video reviews a rival" is a rival humanizer under one
 * and a rival website builder under another, and "the video is about AI
 * detectors" means nothing at all to a slides product.
 */
export function audienceAngles(product: Product): Record<LinkCategory, string> {
  return copyForProduct(product).angles
}

/** @deprecated The humanizer genre's angles. Use audienceAngles(product). */
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

/** The audience paragraph for this product's genre, with the name filled in. */
export function angleFor(product: Product, category: LinkCategory): string {
  return withProduct(audienceAngles(product)[category], product)
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
  const forms = productForms(product)
  return (
    productBackground(product) +
    SEP +
    angleFor(product, category) +
    SEP +
    naiveVoice(product) +
    SEP +
    voiceShapeRule(style, mention, product) +
    // The original is a STYLE reference only. An earlier version said "keep its
    // general intent", and the three audiences came back nearly identical —
    // "purifytext beats rivals" / "purifytext saved me" — because the base
    // comment, not the angle, was driving the message.
    `The original is a style reference only: take its LENGTH and tone, and take its ` +
    `MESSAGE from the audience above. Say something that only makes sense to that ` +
    `audience. ` +
    SEP +
    outputRules(band, style, mention, forms)
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
  const forms = productForms(product)
  return (
    productBackground(product) +
    SEP +
    naiveVoice(product) +
    SEP +
    voiceShapeRule(style, mention, product) +
    rewriteRule(style, mention) +
    // Word-by-word conversion of the seed is the failure mode: it produces
    // "why did i switch to it and stop?" — wreckage that still ends in a
    // question mark, so no filter catches it.
    `Write a NEW sentence, not the original reworded. It must read correctly on its own. ` +
    SEP +
    outputRules(band, style, mention, forms)
  )
}

// ════════════════════════════════════════════════════════════════════════════
// CLASSIFYING A LINK: which audience it is for
// ════════════════════════════════════════════════════════════════════════════

/**
 * Sorting a video into ONE audience, from its caption and the channel bio.
 *
 * Humanizer-shaped on purpose: the categoriser only runs on humanizer links
 * (audiencesForGenre sends every other genre to `generic` alone), so there is
 * no second version of this to keep in step.
 */
export const CATEGORISE_SYSTEM =
  'You sort short social-media videos into ONE audience each, using the caption and the ' +
  "channel's bio.\n" +
  'Categories:\n' +
  '"competitors" — the video promotes, demos, reviews or compares an AI HUMANIZER / ' +
  'paraphraser / "bypass AI" tool (e.g. GrubbyAI, NaturalWrite, WalterWrites, Undetectable AI, ' +
  'StealthWriter, Quillbot, HIX Bypass, Humanizer). The viewer is shopping for such a tool.\n' +
  '"ai_detector" — the video is about AI DETECTION: Turnitin, GPTZero, Originality AI, ' +
  'Copyleaks, "got flagged for AI", "my essay was detected", plagiarism checkers, how detectors ' +
  'work. The viewer fears or is fighting detection.\n' +
  '"generic" — everything else: study tips, essay writing, note-taking, student life, general ' +
  'AI/ChatGPT use, or anything unclear.\n' +
  'If a video fits BOTH competitors and ai_detector, choose "competitors" — naming a rival tool ' +
  'is the stronger signal about what the viewer already wants.\n' +
  'Return STRICT JSON {"categories":[...]} — a JSON array of strings, ONE PER ITEM IN THE SAME ' +
  'ORDER, each exactly "competitors", "ai_detector" or "generic", with exactly as many entries ' +
  'as there are items. Example for 3 items: {"categories":["generic","ai_detector","generic"]}.'

// ════════════════════════════════════════════════════════════════════════════
// REPLIES: what to say under somebody else's comment
// ════════════════════════════════════════════════════════════════════════════

function replyRules(band: WordBand): string {
  return (
    `- be ${band.min} to ${band.max} words, lowercase, casual, like a real person replying on ` +
    'their phone.\n' +
    '- contain NO hashtags, NO emojis, NO quotes, NO @mentions.\n' +
    '- never claim to be the video author and never insult the commenter.\n'
  )
}

// The relevance test, shared by both prompts. A reply only belongs under a
// comment whose author is already thinking about AI writing or getting caught —
// anywhere else it is an advert nobody asked for, which is what gets accounts
// restricted.
// WHAT COUNTS AS RELEVANT DEPENDS ON THE PRODUCT, so the first half comes from
// the genre table. A reply about beating Turnitin under a comment asking how to
// get a website made is the advert nobody asked for that this test exists to
// prevent — it was simply impossible to write while every product was a
// humanizer.
const replyRelevanceTest = (product: string) =>
  copyForProduct(product).replyRelevance +
  'If the comment is about ANYTHING ELSE — general study talk, the creator, jokes, unrelated ' +
  'questions, abuse, spam — return exactly "SKIP" for that item instead of a reply. Do not ' +
  'stretch to make something relevant: when in doubt, SKIP.\n'

export const REPLY_RECOMMEND = (band: WordBand, product: string) =>
  'You write REPLIES to comments under short videos on TikTok.\n' +
  replyRelevanceTest(product) +
  'When you do reply, it must:\n' +
  "- answer or react to the comment it replies to, in that comment's own terms. If the comment " +
  'asks something, answer it. If it complains, sympathise. Never ignore what it says.\n' +
  `- then mention the given product by name, once, as the thing that helped — ${copyForProduct(product).replyMention}.\n` +
  replyRules(band) +
  'Return STRICT JSON {"replies":[...]} — one string per item, SAME ORDER, exactly as many ' +
  'entries as items. Use "SKIP" for items you are not replying to.'

export const REPLY_AFFIRM = (band: WordBand) =>
  'You write short REPLIES agreeing with comments that already recommend a product.\n' +
  'The commenter has just named the product themselves and is happy with it. Your reply must:\n' +
  '- simply AGREE with them. Second their experience, nothing more.\n' +
  '- mention the SAME product they named, once.\n' +
  '- NOT pitch, NOT list features, NOT explain what it does, NOT try to convince anyone. They ' +
  'are already convinced. Anything salesy here reads as a bot.\n' +
  replyRules(band) +
  'If a comment only mentions the product in passing and is really about something else ' +
  'entirely, return exactly "SKIP" for it instead.\n' +
  'Return STRICT JSON {"replies":[...]} — one string per item, SAME ORDER, exactly as many ' +
  'entries as items.'

// ════════════════════════════════════════════════════════════════════════════
// EVERYTHING ELSE: promo captions, and the comment-presence analysis
// ════════════════════════════════════════════════════════════════════════════

/**
 * The brief for promo-video captions.
 *
 * `brief` is the genre's own promo line (see GENRE_COPY above, with the
 * product substituted); `mandatory` is the tag list the caller requires.
 */
export function promoSystem(brief: string, mandatory: string): string {
  return (
    `${brief}, and a set of extra relevant hashtags. ` +
    `Rules: titles are 4-12 words, catchy, lowercase-ish casual, no ` +
    `surrounding quotes, no emojis; do NOT include hashtags inside the titles. Extra tags are ` +
    `single hashtags (start with #, no spaces) relevant to what this product is for; ` +
    `do NOT repeat these already-required tags: ${mandatory}. ` +
    `Return strict JSON: {"titles": ["...", ...], "tags": ["#...", ...]} with ${PROMO_TITLE_COUNT} ` +
    `titles and AT MOST ${PROMO_EXTRA_TAG_MAX} extra tags.`
  )
}

/**
 * Working out why one worker's comments are not appearing.
 *
 * Static: everything that varies is sent in the user turn as `context` and
 * `samples`, which is what keeps this readable as the question being asked.
 */
export const PRESENCE_SYSTEM =
  'You are helping an admin work out why comments posted by one worker are ' +
  'not appearing on TikTok videos.\n\n' +
  'STATUS MEANINGS\n' +
  '  found   — the comment is visible on the video\n' +
  '  missing — the full comment list was read and the comment was not in it\n' +
  '  skipped — the comment list could not be read in full; proves nothing\n\n' +
  'A missing comment has several possible explanations. Weigh them against ' +
  'the evidence rather than assuming the first one:\n' +
  '  1. TikTok filtered or shadow-hid it — spam heuristics, text repeated ' +
  'across many videos, brand names or links in the comment, posting rate, or ' +
  'an account already under restriction.\n' +
  '  2. The video creator deleted it, or has keyword filters. Common when the ' +
  'video promotes a rival product.\n' +
  '  3. The worker never actually posted it.\n' +
  '  4. Nothing systematic — the read simply missed it.\n\n' +
  'EVIDENCE\n' +
  '`context` aggregates EVERY judged link in the window: per day, per ' +
  'product, per video size, the words over-represented in the titles of ' +
  'missing videos, the exact assigned comment text with its found/missing ' +
  'tally, and the working pace in seconds between consecutive clicks. ' +
  '`samples` are individual links you can quote.\n\n' +
  'WHAT TO LOOK FOR\n' +
  'Does missing cluster on particular DAYS? A clean run that stops dead ' +
  'points at the account, not the videos. Does it cluster on one PRODUCT, or ' +
  'one comment WORDING? That points at the text. Does it cluster on videos ' +
  'whose titles name rival tools or carry links? That points at creator ' +
  'moderation. Is the pace too fast for a human to have read the video and ' +
  'typed a comment? That points at explanation 3.\n\n' +
  'RULES\n' +
  'Quote the specific numbers, days, terms or phrases you reason from. Rank ' +
  'the explanations by how well the evidence supports each, and say plainly ' +
  'which ones this data cannot tell apart. Treat skipped as no evidence. If ' +
  'nothing separates found from missing, say so — a wrong pattern is worse ' +
  'than none, because the admin may block someone over it. End with the one ' +
  'thing the admin could most usefully check next.\n\n' +
  'Answer in under 300 words, plain prose, short paragraphs. Use NO markdown ' +
  'at all: no headings, no bullet lists, no ** for bold, no backticks. It is ' +
  'rendered as plain text and the symbols would show.'

/**
 * The one-line probe behind the admin LLM card’s Test button.
 *
 * Here with the rest not because it needs tuning, but so that “every prompt is
 * in prompts.ts” has no exceptions to remember.
 */
export const LLM_PROBE_SYSTEM = 'Reply with strict JSON: {"ok": true}. Nothing else.'
export const LLM_PROBE_USER = 'Are you there?'

// ── Support desk ─────────────────────────────────────────────────────────────

/**
 * The support desk's reply to a customer email (admin → Support).
 *
 * Written as the product the customer wrote to. The products are separate
 * brands, and a reply that names another of them tells a customer two "rival"
 * products are the same company.
 */
export const SUPPORT_REPLY_SYSTEM = (brand: { label: string; site: string }) =>
  `You are a senior customer support specialist writing on behalf of the ${brand.label} team (${brand.site}), an AI writing service.

Write the BODY of an email reply. Rules:
- Open with a greeting using the customer's first name when you know it, otherwise "Hi there,".
- Sign off as "Best regards,\nThe ${brand.label} Team" — never invent an individual's name.
- Never mention any brand other than ${brand.label}. This company runs several separate products and they must never be referenced in each other's support mail.
- Be concise: 3 short paragraphs maximum, no filler, no corporate padding.
- Address the customer's actual question directly in the first sentence after the greeting.
- State only facts you were given. Never invent refund amounts, dates, timelines, policies, or credit balances. If a detail is unknown, leave it out rather than guessing.
- When a refund was issued, say it is processed and note that banks typically take 5-10 business days to show it.
- When a subscription was cancelled, confirm it and say whether access continues until the period end.
- Never apologise more than once. Never use "I sincerely apologise for any inconvenience caused".
- Plain text only: no markdown, no bold, no bullet characters unless listing steps.
- Do not include a subject line. Do not include quoted text from the original email.
- Match the customer's language if they wrote in something other than English.`

// ── Adding a genre ───────────────────────────────────────────────────────────

/**
 * Drafts everything a new genre needs from three facts the admin types (the
 * genre, its product(s), what the product does). The admin reads and edits the
 * draft before saving; nothing generated here is used until they do.
 *
 * Modelled on the website and slides genres above, which are the reference for
 * tone: an ordinary person, plain words, the product as something that happened
 * to them, never an advert.
 */
export const GENRE_DRAFT_SYSTEM = [
  'You write the configuration for a new product category ("genre") in a system that posts',
  'natural-sounding social-media comments recommending a product under related TikTok, Instagram',
  'and YouTube videos.',
  '',
  'Reply with STRICT JSON only, with exactly these keys:',
  '- "what": one sentence saying what the product is. It must contain the token {PRODUCT} in double',
  '  quotes, like: "{PRODUCT}" is a website that ...',
  '- "voice": starts with WHO YOU ARE: and describes the ordinary person who would comment (not an',
  '  expert), lists 8-15 technical or advert words they would NEVER write, gives 4-6 short example',
  '  phrasings they WOULD write (in quotes), and ends with: Name something that happened to you',
  '  rather than describing what the site does.',
  '- "angleCompetitors": the comment angle when the video promotes a RIVAL tool of this kind.',
  '  Sections AUDIENCE:, YOUR SITUATION:, WHAT TO SAY:. End with: NEVER name the rival, and NEVER',
  '  use comparison-ad words (beats, wins, unbeatable, outperforms, rivals, the competition, number',
  '  one, hands down, game changer).',
  '- "angleGeneric": the angle for general content in this area with no tool discussed. Same three',
  '  sections; recommend it the way you would tell a friend, a tip not a pitch. End with: Same ban:',
  '  no beats / wins / unbeatable / rivals / number-one language.',
  '- "jargon": array of 5-9 JavaScript regular-expression sources with \\b word boundaries, for the',
  '  advert or technical words of this domain.',
  '- "replyRelevance": "ONLY reply when the comment is about ...: <the concrete topics>."',
  '- "replyMention": one lowercase clause describing the product, e.g. "a slide maker that builds',
  '  the whole deck from your notes".',
  '- "promo": "\\"{PRODUCT}\\" <what it does>. Generate short, catchy social-media video',
  '  captions/titles that advertise \\"{PRODUCT}\\" in that light (<3 short selling points>)"',
  '- "relatedSubject": "about <the topics and the main competitor brand names a related video',
  '  would be about>"',
  '- "relatedKeywords": array of 12-20 lowercase keywords with spaces and punctuation removed',
  '  (e.g. websitebuilder, landingpage, and competitor brand names).',
  '- "voiceCuriousAside": a short tail for a question, in quotes, e.g. "…? mine was done before class"',
  '- "voiceRecommendVerbs": 4 first-person phrasings in quotes, separated by commas.',
  '- "voicePlainFact": what it is, stated flatly with no opinion, 3-4 clauses separated by commas.',
  '- "seeds": array of 25 short comments (6-16 words) a real user would post recommending',
  '  {PRODUCT}: casual, lowercase, varied, each naming {PRODUCT} once, no hashtags, no emojis, no',
  '  advert words.',
  '- "searchPhrases": array of 14-18 phrases people would type on TikTok to find videos in this',
  '  category, including "<competitor> <category>" forms.',
  '',
  'Write in English. Be concrete to this category. Never mention AI humanizers or AI detectors',
  'unless the category is about them.',
].join('\n')
