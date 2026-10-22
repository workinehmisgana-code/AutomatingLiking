import { promises as dns, Resolver } from "node:dns";

/**
 * Hostname resolution that survives a flaky local resolver.
 *
 * This dashboard runs off a home connection whose router intermittently stops
 * answering DNS, which surfaced as `getaddrinfo ENOTFOUND imap.gmail.com` even
 * though Gmail was perfectly reachable. Three fallbacks, in order:
 *
 *   1. The OS resolver — normal path, and the one that respects a VPN or hosts
 *      file, so it must stay first.
 *   2. Public resolvers, which bypass the router entirely.
 *   3. The last address that worked. Gmail's IPs are stable enough over a
 *      session that a cached one beats failing outright.
 *
 * Callers connect to the returned IP and pass the original hostname as the TLS
 * servername, so certificate validation is unchanged.
 */

const publicResolver = new Resolver();
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);

type Entry = { ip: string; at: number };
const cache = new Map<string, Entry>();

/** Long enough to ride out an outage, short enough to follow Gmail's rotation. */
const FRESH_MS = 10 * 60 * 1000;

async function viaPublic(host: string): Promise<string | null> {
  try {
    const addresses = await new Promise<string[]>((resolve, reject) => {
      publicResolver.resolve4(host, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

export async function resolveHost(host: string): Promise<string> {
  const cached = cache.get(host);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.ip;

  try {
    const { address } = await dns.lookup(host, { family: 4 });
    cache.set(host, { ip: address, at: Date.now() });
    return address;
  } catch {
    // OS resolver is down — fall through.
  }

  const fromPublic = await viaPublic(host);
  if (fromPublic) {
    cache.set(host, { ip: fromPublic, at: Date.now() });
    return fromPublic;
  }

  if (cached) return cached.ip;

  throw new Error(
    `Could not resolve ${host} through the system resolver or 1.1.1.1/8.8.8.8 — the network looks down.`,
  );
}
