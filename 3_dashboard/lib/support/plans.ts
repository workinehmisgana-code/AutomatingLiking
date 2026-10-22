/**
 * Credit allocation lookup. The authoritative source is each project's
 * `creditMap` (productId → credits, from `<PREFIX>_CREDIT_MAP`); this file only
 * holds the fallback used when a product isn't mapped but the stored plan name
 * is recognisable.
 */
export function creditsForPlanName(plan?: string | null): number | null {
  switch (plan?.toLowerCase()) {
    case "basic":
      return 5000;
    case "pro":
    case "lifetime":
      return 20000;
    case "ultra":
      return 45000;
    default:
      return null;
  }
}
