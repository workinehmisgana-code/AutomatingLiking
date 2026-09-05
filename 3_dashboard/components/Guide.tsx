'use client'

import { useState } from 'react'
import Link from 'next/link'
import { en, am, type GuideProps } from '@/components/GuideContent'

type Props = GuideProps

type Lang = 'en' | 'am'

/**
 * One-page user guide, English + Amharic.
 *
 * Both languages live in this one file so they can't drift apart, and a toggle
 * swaps between them rather than stacking both — stacked bilingual text doubles
 * the scroll length and makes the steps hard to follow. Every number comes from
 * props (config + live DB) so the guide can't go stale when a quota changes.
 */
export default function Guide(props: Props) {
  const [lang, setLang] = useState<Lang>('en')
  const t = lang === 'am' ? am(props) : en(props)

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h1 className="text-2xl font-bold text-white">{t.title}</h1>
          <p className="text-sm text-zinc-500 mt-1">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex rounded-lg overflow-hidden border border-zinc-700">
            {(['en', 'am'] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  lang === l ? 'bg-emerald-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {l === 'en' ? 'English' : 'አማርኛ'}
              </button>
            ))}
          </div>
          <Link
            href="/"
            className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
          >
            {t.back}
          </Link>
        </div>
      </div>

      {/* Earnings summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 my-5">
        {t.rates.map((r) => (
          <div key={r.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{r.label}</div>
            <div className="text-base font-semibold text-emerald-300">{r.value}</div>
            <div className="text-[11px] text-zinc-600">{r.hint}</div>
          </div>
        ))}
      </div>

      {t.sections.map((sec) => (
        <section key={sec.heading} className="mb-7">
          <h2 className="text-base font-semibold text-white border-b border-zinc-800 pb-1.5 mb-3">
            {sec.heading}
          </h2>
          {sec.intro && <p className="text-sm text-zinc-400 mb-3 leading-relaxed">{sec.intro}</p>}
          {sec.steps && (
            <ol className="space-y-2.5">
              {sec.steps.map((s, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-zinc-800 text-zinc-300 text-xs flex items-center justify-center tabular-nums">
                    {i + 1}
                  </span>
                  <span className="text-zinc-300 leading-relaxed">{s}</span>
                </li>
              ))}
            </ol>
          )}
          {sec.rows && (
            <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800">
              {sec.rows.map((r) => (
                <div key={r.k} className="flex gap-3 px-3 py-2 text-sm">
                  <span className="w-32 shrink-0 text-zinc-200 font-medium">{r.k}</span>
                  <span className="text-zinc-400 leading-relaxed">{r.v}</span>
                </div>
              ))}
            </div>
          )}
          {sec.note && (
            <p className="text-xs text-amber-400/90 mt-3 leading-relaxed">⚠ {sec.note}</p>
          )}
        </section>
      ))}

      {/* Hourly quota table — live values */}
      <section className="mb-7">
        <h2 className="text-base font-semibold text-white border-b border-zinc-800 pb-1.5 mb-3">
          {t.quotaHeading}
        </h2>
        <p className="text-sm text-zinc-400 mb-3 leading-relaxed">{t.quotaIntro}</p>
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <div className="flex px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
            <span className="flex-1">{t.quotaCols[0]}</span>
            <span className="w-40 text-right">{t.quotaCols[1]}</span>
          </div>
          {props.quotas.map((q) => (
            <div key={q.platform} className="flex px-3 py-2 text-sm border-b border-zinc-800/60 last:border-0">
              <span className="flex-1 text-zinc-300">{q.platform}</span>
              <span className="w-40 text-right text-zinc-400 tabular-nums">
                {q.limit > 0 ? t.quotaValue(q.limit, q.hours) : t.quotaUnlimited}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-3 leading-relaxed">{t.quotaFoot}</p>
      </section>

      <p className="text-xs text-zinc-600 border-t border-zinc-800 pt-4">{t.footer}</p>
    </div>
  )
}
