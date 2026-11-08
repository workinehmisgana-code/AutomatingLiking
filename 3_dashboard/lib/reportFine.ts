// THE OVER-REPORTING FINE — one place for the rule and its wording, so the
// guide, both Finish forms and the broadcast message say exactly the same thing.
//
// Pure: no db, no React, so client components and scripts can import it.

/** Percent of a worker's total pay taken when they report more than they commented. */
export const REPORT_FINE_PCT = 25

export const REPORT_FINE_TITLE = {
  en: 'Warning: over-reporting is fined',
  am: 'ማስጠንቀቂያ፦ ከሰሩት በላይ ሪፖርት ማድረግ ያስቀጣል',
}

export const REPORT_FINE_TEXT = {
  en:
    `Report only the comments you actually posted. If you report more than you commented, ` +
    `you will be fined ${REPORT_FINE_PCT}% of the total pay for your work.`,
  am:
    `በእውነት የለጠፏቸውን አስተያየቶች ብቻ ሪፖርት ያድርጉ። ከሰጡት አስተያየት በላይ ቁጥር ሪፖርት ካደረጉ፣ ` +
    `ከሥራዎ ጠቅላላ ክፍያ ${REPORT_FINE_PCT}% ይቀጣሉ።`,
}
