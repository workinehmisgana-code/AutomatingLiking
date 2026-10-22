// An added genre lands in every table, and leaves them all when removed.
//
//   node scripts/run-ts-check.mjs scripts/check-genre-registry.ts
//
// No database: applies a made-up genre directly and reads it back through the
// same functions the app uses.
import {
  GENRES,
  GENRE_LABELS,
  PRODUCTS,
  isGenre,
  isProduct,
  genreOfProduct,
  productsInGenre,
  genreOfRow,
  genreWeights,
  audiencesForGenre,
} from '../lib/config'
import { GENRE_COPY, copyForProduct } from '../lib/prompts'
import { COMMENTS } from '../lib/comments'
import { applyGenreRegistry, completeCopy, validateGenre, type CustomGenre } from '../lib/genreRegistry'

let bad = 0
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`)
}

const seeds = Array.from({ length: 6 }, (_, i) => `clipwise cut my video in minutes ${i}`)
const genre: CustomGenre = {
  id: 'video-editor',
  label: 'Video editor',
  products: [{ id: 'clipwise', site: 'clipwise.com' }],
  copy: completeCopy({
    what: '"{PRODUCT}" is a website that edits your videos for you.',
    voice: 'WHO YOU ARE: someone who posts videos.',
    angles: { competitors: '', ai_detector: '', generic: 'AUDIENCE: general video content.' },
    jargon: [String.raw`\bnonlinear\b`],
    replyRelevance: 'ONLY reply when the comment is about editing videos.',
    replyMention: 'a site that edits your videos for you',
    promo: '"{PRODUCT}" edits videos.',
    related: { subject: 'about editing videos', keywords: ['Video Editor', 'capcut'] },
  }),
  seeds: { clipwise: seeds },
  searchPhrases: 'ai video editor\ncapcut alternative',
}

const builtinCount = GENRES.length
console.log('validation:')
check('a complete genre passes', validateGenre(genre, [], true), [])
check('a built-in id is refused', validateGenre({ ...genre, id: 'website' }, [], true).length > 0, true)
check('a taken product is refused', validateGenre({ ...genre, products: [{ id: 'cocodly', site: '' }] }, [], true).some((p) => p.includes('another genre')), true)
check('too few base comments is refused', validateGenre({ ...genre, seeds: { clipwise: ['a'] } }, [], true).some((p) => p.includes('5 base comments')), true)

console.log('applied:')
applyGenreRegistry([genre])
check('it is a genre', isGenre('video-editor'), true)
check('it is on the genre list', GENRES.includes('video-editor'), true)
check('with its label', GENRE_LABELS['video-editor'], 'Video editor')
check('its product is a product', isProduct('clipwise'), true)
check('in that genre', genreOfProduct('clipwise'), 'video-editor')
check('productsInGenre finds it', productsInGenre('video-editor'), ['clipwise'])
check('a link stamped with it reads as it', genreOfRow({ genre: 'video-editor' }), 'video-editor')
check('its copy is the one served', copyForProduct('clipwise').replyMention, 'a site that edits your videos for you')
check('related keywords are normalised', GENRE_COPY['video-editor'].related.keywords, ['videoeditor', 'capcut'])
check('its seeds feed generation', (COMMENTS as Record<string, string[]>).clipwise?.length, 6)
check('one audience, like website and slides', audiencesForGenre('video-editor'), ['generic'])
check('no share until one is given', genreWeights({ humanizer: 50, website: 50 })['video-editor'], 0)
check('built-ins untouched', productsInGenre('website'), ['cocodly'])

console.log('applied twice (idempotent):')
applyGenreRegistry([genre])
check('listed once', GENRES.filter((g) => g === 'video-editor').length, 1)
check('product listed once', PRODUCTS.filter((p) => p === 'clipwise').length, 1)

console.log('removed:')
applyGenreRegistry([])
check('no longer a genre', isGenre('video-editor'), false)
check('genre list back to the built-ins', GENRES.length, builtinCount)
check('product gone', isProduct('clipwise'), false)
check('copy gone', 'video-editor' in GENRE_COPY, false)
check('seeds gone', 'clipwise' in COMMENTS, false)
check('a link stamped with it reads as the default', genreOfRow({ genre: 'video-editor' }), 'humanizer')

console.log(bad ? `\n${bad} failed` : '\nall good')
process.exit(bad ? 1 : 0)
