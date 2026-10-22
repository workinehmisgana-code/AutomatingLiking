// Every prompt this app sends, rendered, as one JSON blob.
//
//   node scripts/run-ts-check.mjs scripts/snapshot-prompts.ts > before.json
//   ...refactor...
//   node scripts/run-ts-check.mjs scripts/snapshot-prompts.ts > after.json
//   node scripts/diff-prompts.mjs before.json after.json
//
// Moving prompt text between files is the kind of change that looks safe and
// is not: a lost space, a reordered clause or a dropped sentence changes what
// the model writes, and nothing fails - the comments just come back slightly
// wrong, in public, days later.
//
// So the move is made provable instead of careful. Render everything, move the
// text, render again, and require the two to be byte-identical.
//
// Pure: no database, no network. Anything needing either is rendered with the
// defaults, since what is being compared is the TEXT, not the settings.
async function main(): Promise<void> {
  const cfg = await import('../lib/config')
  const prompt = await import('../lib/prompts')
  const classify = await import('../lib/titleClassify')

  const out: Record<string, string> = {}

  // Comment prompts: every product against every audience its genre uses, at
  // the default band and style - the two things that vary per product but are
  // not prompt TEXT.
  const band = { min: cfg.COMMENT_WORD_MIN, max: cfg.COMMENT_WORD_MAX }
  for (const p of cfg.PRODUCTS) {
    for (const c of cfg.audiencesForProduct(p)) {
      for (const voice of ['question', 'curious', 'recommendation', 'informational'] as const) {
        const style = { ...cfg.DEFAULT_COMMENT_STYLE, voice }
        out[`comment/${p}/${c}/${voice}`] = prompt.buildAudiencePrompt(p, c, band, style as never)
      }
    }
  }

  // The "Mark unrelated" question, per genre.
  for (const g of cfg.GENRES) {
    out[`classify/${g}`] = classify.systemFor(g)
  }

  // Everything the genre table holds, flattened - this is the text the builders
  // above read, and a move that changed it would show here even if the assembled
  // prompt happened to look the same.
  const { GENRE_COPY, SHARED_JARGON } = await import('../lib/prompts')
  out['jargon/shared'] = SHARED_JARGON.join('\n')
  for (const g of cfg.GENRES) {
    const c = GENRE_COPY[g]
    out[`copy/${g}/what`] = c.what
    out[`copy/${g}/voice`] = c.voice
    out[`copy/${g}/jargon`] = c.jargon.join('\n')
    out[`copy/${g}/replyRelevance`] = c.replyRelevance
    out[`copy/${g}/replyMention`] = c.replyMention
    out[`copy/${g}/promo`] = c.promo
    out[`copy/${g}/related.subject`] = c.related.subject
    out[`copy/${g}/related.keywords`] = c.related.keywords.join(',')
    out[`copy/${g}/voice.curiousAside`] = c.voiceExamples.curiousAside
    out[`copy/${g}/voice.recommendVerbs`] = c.voiceExamples.recommendVerbs
    out[`copy/${g}/voice.plainFact`] = c.voiceExamples.plainFact
    for (const a of cfg.LINK_CATEGORIES) out[`copy/${g}/angle.${a}`] = c.angles[a]
  }

  process.stdout.write(JSON.stringify(out, null, 1))
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
