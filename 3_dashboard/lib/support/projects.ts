/**
 * Every site the support desk handles. One inbox, many products — each email
 * carries the tag of the project whose Gmail account received it, and every
 * action (lookup, refund, cancel, delete) routes to that project's billing
 * provider and database.
 *
 * A project appears in the dashboard as soon as its Gmail credentials are set.
 * Billing and database credentials are checked separately, so a half-configured
 * project still shows its mail instead of vanishing.
 */

export type ProviderKind = "polar" | "lemonsqueezy" | "freemius";

export type ProjectDefinition = {
  id: string;
  label: string;
  site: string;
  provider: ProviderKind;
  /** Baked in so you only ever need to supply the app password. */
  defaultGmailUser: string;
  /** Tailwind classes for the tag chip — one distinct colour per project. */
  tag: string;
};

export const PROJECT_DEFINITIONS: ProjectDefinition[] = [
  {
    id: "purifytext",
    label: "PurifyText",
    site: "purifytext.com",
    provider: "polar",
    defaultGmailUser: "purifytext@gmail.com",
    tag: "bg-sky-950/70 text-sky-300 ring-1 ring-sky-900/60",
  },
  {
    id: "prohumanly",
    label: "ProHumanly",
    site: "prohumanly.com",
    provider: "polar",
    defaultGmailUser: "prohumanlysupport@gmail.com",
    tag: "bg-violet-950/70 text-violet-300 ring-1 ring-violet-900/60",
  },
  {
    id: "cohumanly",
    label: "CoHumanly",
    site: "cohumanly.com",
    provider: "polar",
    defaultGmailUser: "cohumanlysupport@gmail.com",
    tag: "bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60",
  },
  {
    id: "humlexic",
    label: "Humlexic",
    site: "humlexic.com",
    provider: "polar",
    defaultGmailUser: "humlexic@gmail.com",
    tag: "bg-amber-950/70 text-amber-300 ring-1 ring-amber-900/60",
  },
  {
    id: "acoustictext",
    label: "AcousticText",
    site: "acoustictext.com",
    // Merchant of record moved from LemonSqueezy to Freemius.
    provider: "freemius",
    defaultGmailUser: "acoustictext@gmail.com",
    tag: "bg-red-950/70 text-red-300 ring-1 ring-red-900/60",
  },
];

export type GmailAccount = { user: string; password: string; fromName: string };

export type Project = ProjectDefinition & {
  gmail: GmailAccount | null;
  polar: { token: string; server: "production" | "sandbox"; organizationId: string } | null;
  lemon: { apiKey: string; storeId: string } | null;
  freemius: { token: string; productId: string } | null;
  databaseUrl: string | null;
  /** productId → credits granted. Drives the "credits used" figure. */
  creditMap: Record<string, number>;
  /** Mail is readable — the project shows up in the inbox. */
  active: boolean;
  /** Billing provider credentials are present. */
  billingReady: boolean;
  /** A database is configured, so credit usage can be shown. */
  databaseReady: boolean;
};

const prefixOf = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, "_");

function read(id: string, key: string, legacy?: string): string {
  const scoped = process.env[`${prefixOf(id)}_${key}`]?.trim();
  if (scoped) return scoped;
  // purifytext was configured before the dashboard went multi-project; its
  // original unprefixed variables still work.
  if (legacy) return process.env[legacy]?.trim() ?? "";
  return "";
}

/**
 * One variable per product, with the credits stated in the variable name:
 *
 *   <PREFIX>_CREDITS_<amount>[_<any label you like>]=<productId>
 *   PURIFYTEXT_CREDITS_20000_MEDIUM_YEARLY=7707eb17-…
 *
 * The number after CREDITS_ is what the product grants; everything after it is
 * a comment to you and is ignored. That keeps several products that grant the
 * same amount (monthly, yearly, top-up) from colliding.
 *
 * PurifyText additionally falls back to its original POLAR_PRODUCT_* variables.
 */
function readCreditMap(id: string): Record<string, number> {
  const map: Record<string, number> = {};
  const pattern = new RegExp(`^${prefixOf(id)}_CREDITS_(\\d+)(?:_.*)?$`);

  for (const [name, value] of Object.entries(process.env)) {
    const match = pattern.exec(name);
    const productId = value?.trim();
    if (!match || !productId) continue;

    const credits = Number(match[1]);
    if (Number.isFinite(credits)) map[productId] = credits;
  }

  if (id === "purifytext") {
    const legacy: [string, number][] = [
      ["POLAR_PRODUCT_SMALL", 5000],
      ["POLAR_PRODUCT_YEARLY_SMALL", 5000],
      ["POLAR_PRODUCT_MEDIUM", 20000],
      ["POLAR_PRODUCT_YEARLY_MEDIUM", 20000],
      ["POLAR_PRODUCT_LARGE", 45000],
      ["POLAR_PRODUCT_YEARLY_LARGE", 45000],
      ["POLAR_PRODUCT_LIFETIME", 20000],
      ["POLAR_CREDITS_5000", 5000],
      ["POLAR_CREDITS_20000", 20000],
      ["POLAR_CREDITS_45000", 45000],
    ];
    for (const [envName, credits] of legacy) {
      const productId = process.env[envName]?.trim();
      if (productId && map[productId] === undefined) map[productId] = credits;
    }
  }

  return map;
}

function build(definition: ProjectDefinition): Project {
  const { id } = definition;
  // NO UNPREFIXED FALLBACKS HERE. The standalone desk let PurifyText read plain
  // DATABASE_URL, GMAIL_APP_PASSWORD and POLAR_ACCESS_TOKEN. In this dashboard
  // DATABASE_URL is the dashboard's own database — whose Better Auth table is
  // also called "user" — so the fallback would point PurifyText's lookups,
  // credit edits and account deletes at the workers' accounts. Every product,
  // PurifyText included, is configured with its PREFIX_ names only.
  const isPurify = false && id === "purifytext";

  const user = read(id, "GMAIL_USER", isPurify ? "GMAIL_USER" : undefined) || definition.defaultGmailUser;
  const password = read(id, "GMAIL_APP_PASSWORD", isPurify ? "GMAIL_APP_PASSWORD" : undefined);
  const fromName =
    read(id, "GMAIL_FROM_NAME", isPurify ? "GMAIL_FROM_NAME" : undefined) ||
    `${definition.label} Support`;

  const polarToken = read(id, "POLAR_ACCESS_TOKEN", isPurify ? "POLAR_ACCESS_TOKEN" : undefined);
  const lemonKey = read(id, "LEMONSQUEEZY_API_KEY");
  const freemiusToken = read(id, "FREEMIUS_API_TOKEN");
  const databaseUrl = read(id, "DATABASE_URL", isPurify ? "DATABASE_URL" : undefined);

  const gmail = user && password ? { user: user.toLowerCase(), password, fromName } : null;

  const polar =
    definition.provider === "polar" && polarToken
      ? {
          token: polarToken,
          server:
            (read(id, "POLAR_ENV", isPurify ? "POLAR_ENV" : undefined) || "production") === "sandbox"
              ? ("sandbox" as const)
              : ("production" as const),
          organizationId: read(
            id,
            "POLAR_ORGANIZATION_ID",
            isPurify ? "POLAR_ORGANIZATION_ID" : undefined,
          ),
        }
      : null;

  const lemon =
    definition.provider === "lemonsqueezy" && lemonKey
      ? { apiKey: lemonKey, storeId: read(id, "LEMONSQUEEZY_STORE_ID") }
      : null;

  const freemiusProductId = read(id, "FREEMIUS_PRODUCT_ID");
  const freemius =
    definition.provider === "freemius" && freemiusToken && freemiusProductId
      ? { token: freemiusToken, productId: freemiusProductId }
      : null;

  return {
    ...definition,
    gmail,
    polar,
    lemon,
    freemius,
    databaseUrl: databaseUrl || null,
    creditMap: readCreditMap(id),
    active: Boolean(gmail),
    billingReady: Boolean(polar ?? lemon ?? freemius),
    databaseReady: Boolean(databaseUrl),
  };
}

export function allProjects(): Project[] {
  return PROJECT_DEFINITIONS.map(build);
}

/** Projects whose mail can actually be read — what the inbox iterates over. */
export function activeProjects(): Project[] {
  return allProjects().filter((project) => project.active);
}

export function getProject(id: string): Project | null {
  const definition = PROJECT_DEFINITIONS.find((entry) => entry.id === id);
  return definition ? build(definition) : null;
}

/** Client-safe summary — never includes tokens or passwords. */
export type ProjectSummary = {
  id: string;
  label: string;
  site: string;
  provider: ProviderKind;
  tag: string;
  email: string;
  active: boolean;
  billingReady: boolean;
  databaseReady: boolean;
  sandbox: boolean;
};

export function projectSummaries(): ProjectSummary[] {
  return allProjects().map((project) => ({
    id: project.id,
    label: project.label,
    site: project.site,
    provider: project.provider,
    tag: project.tag,
    email: project.gmail?.user ?? project.defaultGmailUser,
    active: project.active,
    billingReady: project.billingReady,
    databaseReady: project.databaseReady,
    sandbox: project.polar?.server === "sandbox",
  }));
}
