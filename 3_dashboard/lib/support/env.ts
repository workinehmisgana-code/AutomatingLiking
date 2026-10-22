/**
 * Shared env helpers. Per-project credentials live in `projects.ts`; this file
 * only covers the settings that apply across every project (currently Groq).
 */

export function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing ${name} in .env — copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

export function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}
