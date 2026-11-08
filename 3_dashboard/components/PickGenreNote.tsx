/**
 * Shown in place of a screen that only works ONE genre at a time, while the
 * master genre switch is on All.
 *
 * Such a screen (the phone liker's settings, the promo review) saves or offers
 * something per genre. Quietly falling back to the default genre in All would
 * save a humanizer setting under an "All genres" heading, so it says so and
 * asks for a genre instead.
 */
export default function PickGenreNote({ what }: { what: string }) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <div className="rounded-xl border border-amber-700/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
        <div className="font-semibold mb-1">Pick a genre for this</div>
        <p className="text-amber-200/80">
          {what} works one genre at a time, and the switch at the top is on <b>All</b>. Pick a genre
          there to see and change it.
        </p>
      </div>
    </div>
  )
}
