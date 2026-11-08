import { REPORT_FINE_TEXT, REPORT_FINE_TITLE } from '@/lib/reportFine'

/**
 * The hard warning about the over-reporting fine. Red and boxed on purpose —
 * it sits where the number is typed, and has to be read, not skimmed past.
 * `lang` picks one language; omitted, both are shown (the Finish forms have no
 * language toggle).
 */
export default function ReportFineWarning({ lang, className = '' }: { lang?: 'en' | 'am'; className?: string }) {
  const langs: ('en' | 'am')[] = lang ? [lang] : ['en', 'am']
  return (
    <div
      role="alert"
      className={`rounded-lg border-2 border-red-500/70 bg-red-500/15 px-3 py-2.5 space-y-2 ${className}`}
    >
      {langs.map((l) => (
        <div key={l}>
          <div className="text-sm font-bold text-red-200">⛔ {REPORT_FINE_TITLE[l]}</div>
          <p className="text-sm text-red-100/90 leading-relaxed mt-0.5">{REPORT_FINE_TEXT[l]}</p>
        </div>
      ))}
    </div>
  )
}
