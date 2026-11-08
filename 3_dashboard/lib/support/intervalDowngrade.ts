/**
 * YEARLY → MONTHLY: what the customer keeps paying for, and what goes back.
 *
 * The policy: every month they have STARTED on the yearly plan is charged at
 * the monthly price; the rest of the yearly payment is refunded to the card.
 * Bought 2½ months ago at $96/yr with monthly at $12 → 3 months kept ($36),
 * $60 refunded, and monthly billing begins when those 3 months run out.
 *
 * Pure — shared by the dialog (to show the numbers) and the route (which
 * recomputes them from the provider's own data rather than trusting the page).
 */

export type IntervalDowngradeQuote = {
  /** Months started since the yearly payment, each kept at the monthly price. */
  monthsUsed: number;
  /** Minor units kept: monthsUsed × monthly price. */
  kept: number;
  /** Minor units owed back: paid − kept, never below zero. */
  difference: number;
  /** When the months they keep run out — the first monthly charge. ISO. */
  paidThrough: string;
};

/** Same day-of-month `months` later, clamped (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export function quoteYearlyToMonthly(input: {
  /** When the yearly payment was made (start of the period being refunded). */
  paidAt: string;
  /** Minor units paid for the year. */
  paid: number;
  /** Minor units per month on the new plan. */
  monthly: number;
  now?: Date;
}): IntervalDowngradeQuote {
  const start = new Date(input.paidAt);
  const now = input.now ?? new Date();
  // The month in progress counts as used: the smallest n whose end is still
  // in the future. Never less than one — they have had the product today.
  let monthsUsed = 1;
  while (monthsUsed < 12 && addMonths(start, monthsUsed).getTime() <= now.getTime()) monthsUsed++;
  const kept = monthsUsed * Math.max(0, Math.round(input.monthly));
  return {
    monthsUsed,
    kept,
    difference: Math.max(0, Math.round(input.paid) - kept),
    paidThrough: addMonths(start, monthsUsed).toISOString(),
  };
}

export const isYearly = (interval: string | null | undefined) => interval === "year";
export const isMonthly = (interval: string | null | undefined) => interval === "month";
