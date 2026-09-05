// Sorting each link into the audience its comment should be written for.
//
//   competitors  the video promotes or reviews a RIVAL humanizer / paraphraser.
//                Its viewers already want a tool like ours — the comment's job is
//                to win them over from the one on screen.
//   ai_detector  the video is about AI DETECTION: Turnitin, GPTZero, being
//                flagged, "my essay got detected". Its viewers have the problem
//                our product solves but may not know a fix exists.
//   generic      study/essay/AI content with no specific tool angle.
//
// Signal is the video's caption plus its CHANNEL BIO. The bio matters more than
// it looks: a caption like "this saved me 😭" says nothing, while the channel bio
// ("Cek Plagiasi Turnitin & Parafrase") places the whole account.

import { groqChat } from './groq'
import { type LinkCategory, DEFAULT_LINK_CATEGORY, isLinkCategory } from './config'

export interface Categorizable {
  url: string
  title: string
  bio: string
}

const SYSTEM =
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

// Deterministic overrides, applied AFTER the model — but ONLY for unambiguous
// BRAND names.
//
// The first version of this list also held topic words (humanizer, aidetector,
// bypassai...). That was wrong: in this niche "#humanizer #aidetector" is
// hashtag boilerplate stapled to almost every caption, so those words forced 24
// of 25 sampled links into "competitors" and overrode Groq on 8 of them. A
// brand name is a fact about the video; a topic hashtag is not, and judging it
// needs the surrounding context only the model sees.
//
// Matched against a normalised form (lowercased, non-alphanumerics stripped) so
// "Walter Writes", "walterwrites" and "#walterwrites" all hit the same key.
const COMPETITOR_BRANDS = [
  'grubbyai', 'naturalwrite', 'walterwrites', 'undetectableai', 'stealthwriter',
  'quillbot', 'hixbypass', 'humbot', 'phrasly', 'twixify', 'rephrasy',
]
const DETECTOR_BRANDS = [
  'turnitin', 'gptzero', 'originalityai', 'copyleaks', 'zerogpt', 'winstonai',
  'scribbr', 'quetext',
]

/**
 * Normalised text for brand matching, with HASHTAGS REMOVED.
 *
 * Hashtags are decoration in this niche — "#turnitin #gptzero #humanizer" is
 * stapled to humanizer ads that have nothing to do with detection. Matching them
 * sent five of thirteen sampled ai_detector links there wrongly, every one of
 * them actually promoting a rival tool. A brand named in the caption PROSE
 * ("new update to Turnitin, which can detect AI text") is a real signal; the
 * same word in a tag pile is not. Hashtags still reach the model, which can
 * weigh them against the sentence they follow.
 */
function norm(s: string): string {
  return s
    // No /u + \p{L}: the project's tsconfig target predates unicode property
    // escapes. Hashtag bodies here are ASCII word chars in practice.
    .replace(/[#＃][\w]+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Category forced by a named brand, or null to let the model decide.
 *
 * Competitor brands are checked first for the same reason the prompt prefers
 * them: naming a rival tool says more about what the viewer wants than the
 * detector they are worried about. Everything that is not a brand name — every
 * topic word and hashtag — is left to the model.
 */
export function keywordCategory(title: string, bio: string): LinkCategory | null {
  const hay = norm(`${title} ${bio}`)
  if (!hay) return null
  if (COMPETITOR_BRANDS.some((k) => hay.includes(k))) return 'competitors'
  if (DETECTOR_BRANDS.some((k) => hay.includes(k))) return 'ai_detector'
  return null
}

/** One prompt's worth of items. Small enough that a misaligned array is cheap. */
export const CHUNK = 25

/**
 * Categorise one chunk. Never throws: on any failure every item falls back to
 * its keyword verdict, or to `generic`. A failed chunk must not stall a sweep of
 * ~90k links, and `generic` is the safe default — its comments mention the
 * product without assuming the viewer is shopping or worried about detection.
 */
export async function categorizeChunk(items: Categorizable[]): Promise<LinkCategory[]> {
  const fallback = items.map((it) => keywordCategory(it.title, it.bio) ?? DEFAULT_LINK_CATEGORY)
  if (items.length === 0) return []

  const list = items
    .map((it, i) => {
      const bio = it.bio ? ` | channel bio: ${it.bio.slice(0, 160)}` : ''
      return `${i + 1}. caption: ${(it.title || '(no caption)').slice(0, 200)}${bio}`
    })
    .join('\n')

  try {
    const { content } = await groqChat({
      temperature: 0,
      jsonObject: true,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: list },
      ],
    })
    const parsed = JSON.parse(content) as { categories?: unknown }
    const arr = Array.isArray(parsed.categories) ? parsed.categories : []
    return items.map((it, i) => {
      // A named brand always wins — see COMPETITOR_BRANDS above.
      const forced = keywordCategory(it.title, it.bio)
      if (forced) return forced
      const v = arr[i]
      return isLinkCategory(v) ? v : fallback[i]
    })
  } catch {
    return fallback
  }
}
