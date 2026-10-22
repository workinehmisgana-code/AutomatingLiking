import type { Project } from "../projects";
import { createFreemiusProvider } from "./freemius";
import { createLemonSqueezyProvider } from "./lemonsqueezy";
import { createPolarProvider } from "./polar";
import type { BillingProvider } from "./types";

export * from "./types";

/** Returns null when the project has no billing credentials configured yet. */
export function providerFor(project: Project): BillingProvider | null {
  if (!project.billingReady) return null;
  switch (project.provider) {
    case "freemius":
      return createFreemiusProvider(project);
    case "lemonsqueezy":
      return createLemonSqueezyProvider(project);
    default:
      return createPolarProvider(project);
  }
}

export function formatMoney(minor: number | null | undefined, currency = "usd"): string {
  if (minor === null || minor === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
