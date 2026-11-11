// Add the "Link in bio" genre (product: liinking) — the same thing the admin's
// Genres page saves, written here so the copy is reviewable in one place.
//
//   node scripts/run-ts-check.mjs scripts/add-genre-link-in-bio.ts
//
// Saving is validated exactly as the form is (lib/genreRegistry validateGenre).
import { readFileSync } from 'fs'
import { join } from 'path'

function loadEnv(): void {
  const text = readFileSync(join(process.cwd(), '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const generic =
  'AUDIENCE: creator, influencer, personal-branding or social-media growth content — growing on TikTok or Instagram, what to put in your bio, getting followers to your shop, music, YouTube or other pages. The viewer is not shopping for a tool, so lead with what happened to you rather than with the thing you used.\n' +
  'YOUR SITUATION: a small creator who keeps all their links on one "{PRODUCT}" page in their bio.\n' +
  'WHAT TO SAY: mention it the way you would tell another creator what helped — followers finally find your other accounts, your shop gets clicks from the bio, you set it up in a few minutes, you change one link instead of editing the bio every time. A tip, not a pitch.\n' +
  'NEVER name another link-in-bio service, and no beats / wins / unbeatable / number-one language.'

const competitors =
  'AUDIENCE: the video promotes or reviews a RIVAL link-in-bio page, and the viewer is already looking for one.\n' +
  'YOUR SITUATION: a creator who tried a few of these and settled on "{PRODUCT}" — not a fan, just someone who stopped looking.\n' +
  'WHAT TO SAY: that it is the one you kept. Earn it with one small concrete reason: it was set up in minutes, it looks clean on a phone, you can see which link people tap, your shop and socials are all in one place. Plain words only.\n' +
  'NEVER name the rival, and NEVER use comparison-ad words (beats, wins, unbeatable, outperforms, the competition, number one, hands down, game changer). Write a comment, not a verdict.'

const genre = {
  id: 'link-in-bio',
  label: 'Link in bio',
  products: [{ id: 'liinking', site: '' }],
  copy: {
    what:
      '"{PRODUCT}" is a link-in-bio page: one simple link for your TikTok or Instagram bio that opens a page with all your other links — your shop, music, YouTube, other socials and anything you are promoting.',
    voice:
      'WHO YOU ARE: an ordinary small creator or side-hustler posting on TikTok and Instagram — not a marketer, not a tech person. Small everyday words, short sentences, a bit unpolished, the way people actually type in comments. NEVER write: all-in-one solution, platform, seamless, leverage, optimize your conversions, cutting-edge, game changer, or how it works inside. Write like this instead: "people actually click my shop now", "set it up in like five minutes", "all my stuff is in one place", "i stopped changing my bio every week", "my followers found my youtube from it". Name something that happened to you rather than describing what the product does.',
    angles: { generic, competitors },
    jargon: [
      '\\ball[\\s-]?in[\\s-]?one (solution|platform)\\b',
      '\\bseamless(ly)?\\b',
      '\\bleverag(e|es|ed|ing)\\b',
      '\\boptimi[sz](e|es|ed|ing) (your )?conversions?\\b',
      '\\bcutting[\\s-]?edge\\b',
      '\\bgame[\\s-]?changer\\b',
    ],
    replyRelevance:
      'ONLY reply when the comment is about a creator\'s BIO or LINKS: what to put in a bio, only having one link, followers not finding their shop, music, YouTube or other accounts, link-in-bio pages, or growing as a creator on TikTok or Instagram.\n',
    replyMention: 'a link-in-bio page that puts all your links behind the one link in your bio',
    promo:
      '"{PRODUCT}" is a link-in-bio page — one link in your TikTok or Instagram bio that opens all your other links: shop, music, YouTube, socials. Generate short, catchy social-media video captions/titles about growing as a creator, getting followers to your other pages and making your bio work harder. Casual, creator-to-creator tone.',
    related: {
      subject:
        'link-in-bio pages, what to put in a TikTok or Instagram bio, creator tools, growing on TikTok or Instagram, personal branding, influencer or content-creator tips, or social media marketing',
      keywords: [
        'linkinbio', 'biolink', 'linktree', 'bio', 'creator', 'creators', 'contentcreator',
        'influencer', 'personalbranding', 'instagramgrowth', 'tiktokgrowth', 'socialmediamarketing',
        'socialmedia', 'growoninstagram', 'growontiktok', 'linkpage',
      ],
    },
    voiceExamples: {
      curiousAside: '"…? my shop only got clicks once everything was on one link"',
      recommendVerbs: '"i use", "i switched to", "my bio link is", "what fixed it for me was"',
      plainFact: 'one link in your bio that opens all your other links',
    },
  },
  seeds: {
    liinking: [
      'i put liinking in my bio and people finally found my shop',
      'liinking took me like five minutes to set up, all my links in one place',
      'my bio link is liinking now, way cleaner than before',
      'i stopped changing my bio every week after liinking',
      'my followers found my youtube from my liinking page',
      'liinking is what i use, i just update one page instead of my bio',
      'got my first sales from the bio once i switched to liinking',
      'i tried a few of these, liinking is the one i kept',
      'liinking looks clean on a phone which is where everyone clicks it',
      'all my music links are on liinking, people actually tap them now',
      'i can see which link people tap on liinking, that helped a lot',
      'small creator here, liinking made my bio actually useful',
    ],
  },
  searchPhrases: [
    'link in bio', 'best link in bio', 'TikTok bio link', 'Instagram bio link', 'link in bio tools',
    'Linktree bio link', 'Liinks bio link', 'Beacon bio link', 'creator tools', 'content creator tips',
    'Instagram growth', 'TikTok growth', 'personal branding', 'influencer tips', 'creator website',
    'social media marketing', 'link page',
  ].join('\n'),
}

async function main(): Promise<void> {
  loadEnv()
  const { saveCustomGenre, listCustomGenres } = await import('../lib/genreStore')
  const exists = (await listCustomGenres()).some((g) => g.id === genre.id)
  const r = await saveCustomGenre(genre as never, !exists)
  if ('problems' in r) {
    console.log('NOT SAVED:\n  ' + r.problems.join('\n  '))
    process.exit(1)
  }
  const saved = r.list.find((g) => g.id === genre.id)
  console.log(`saved "${saved?.label}" (${saved?.id}) — products: ${saved?.products.map((p) => p.id).join(', ')}`)
  console.log(`  seeds: ${saved?.seeds.liinking?.length}, search phrases: ${saved?.searchPhrases.split('\n').length}`)
  console.log('  genres now:', r.list.map((g) => g.id).join(', '))
  const { getGenreMix } = await import('../lib/db')
  console.log('  mix:', JSON.stringify(await getGenreMix()))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
