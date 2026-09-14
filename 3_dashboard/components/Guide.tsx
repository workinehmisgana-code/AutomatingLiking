'use client'

import { useState } from 'react'
import { en, am, type GuideProps } from '@/components/GuideContent'

type Props = GuideProps

type Lang = 'en' | 'am'

/**
 * One-page user guide, English + Amharic.
 *
 * Both languages live in this one file so they can't drift apart, and a toggle
 * swaps between them rather than stacking both — stacked bilingual text doubles
 * the scroll length and makes the steps hard to follow. Every number comes from
 * props (config + live DB) so the guide can't go stale when a rate changes.
 */
export default function Guide(props: Props & { signedIn?: boolean }) {
  const [lang, setLang] = useState<Lang>('en')
  const t = lang === 'am' ? am(props) : en(props)
  // Absolute, because this page gets shared off-site — see SITE_URL in config.
  const start = props.startUrl || '/'

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
          <a
            href={start}
            className={`text-xs rounded-lg px-2.5 py-1.5 border transition-colors ${
              props.signedIn === false
                ? 'text-white bg-emerald-600 hover:bg-emerald-500 border-emerald-500'
                : 'text-zinc-400 hover:text-white border-zinc-700 hover:bg-zinc-800'
            }`}
          >
            {props.signedIn === false ? t.signIn : t.back}
          </a>
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

      <a
        href={start}
        className="block rounded-xl border border-emerald-500/40 bg-emerald-600/10 px-4 py-3 mb-6 hover:bg-emerald-600/20 transition-colors group"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-emerald-300 group-hover:text-emerald-200">
              {t.startCta}
            </div>
            <div className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{t.startHint}</div>
          </div>
          <span className="text-xs text-zinc-500 truncate hidden sm:block">
            {start.replace(/^https?:\/\//, '')}
          </span>
        </div>
      </a>

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

      {/* Video walkthroughs — whatever the admin has uploaded, in their order */}
      {props.videos && props.videos.length > 0 && (
        <section className="mb-7">
          <h2 className="text-base font-semibold text-white border-b border-zinc-800 pb-1.5 mb-3">
            {t.videoHeading}
          </h2>
          <p className="text-sm text-zinc-400 mb-3 leading-relaxed">{t.videoIntro}</p>
          <div className="space-y-4">
            {props.videos.map((v) => (
              <figure key={v.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                {/* preload="none" — several clips on one page would otherwise
                    each start pulling data on a phone before anyone pressed
                    play. The poster frame appears once playback starts. */}
                <video
                  src={v.url}
                  controls
                  preload="none"
                  playsInline
                  className="w-full bg-black aspect-video"
                />
                <figcaption className="px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-zinc-200">{v.title}</span>
                    {v.lang && (
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">
                        {v.lang === 'am' ? 'አማርኛ' : v.lang}
                      </span>
                    )}
                  </div>
                  {v.note && <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{v.note}</p>}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <div className="border-t border-zinc-800 pt-4">
        <a
          href={start}
          className="inline-flex items-center gap-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 transition-colors"
        >
          {t.startCta}
        </a>
        <p className="text-xs text-zinc-600 mt-4">{t.footer}</p>
      </div>
    </div>
  )
}
