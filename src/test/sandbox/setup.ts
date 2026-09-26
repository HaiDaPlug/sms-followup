import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Points the real data layer at the LOCAL Supabase stack, and nowhere else.
 *
 * Credentials come from "supabase status", which only inspects the local
 * Docker containers. They are deliberately never read from .env files: this
 * repo's .env.local holds production credentials, and a sandbox run that fell
 * back to them would run sandbox_reset() -- a truncate of every patient --
 * against the live database.
 */

const repoRoot = path.resolve(__dirname, "../../..");

// Pinned alongside the package.json sandbox scripts: the CLI version decides
// which image tags "supabase start" pulls, so an unpinned npx could silently
// switch the stack under a run.
const SUPABASE_CLI = "supabase@2.117.0";

function readLocalStatus(): Record<string, string> {
  let output: string;
  try {
    output = execSync(`npx --yes ${SUPABASE_CLI} status -o env`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local Supabase is not running (run "npm run sandbox:start" first): ${detail}`
    );
  }

  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * The [api] port this repo's own stack listens on, read from config.toml so
 * the pin cannot drift from the config. A loopback host alone does not prove
 * the target is THIS stack: other projects on this machine run their own local
 * Supabase (crm-khyte-local on 54321), and sandbox_reset() would truncate
 * their tables just as readily. Any parse failure refuses.
 */
function readConfiguredApiPort(): number {
  const configPath = path.join(repoRoot, "supabase", "config.toml");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Sandbox refused: cannot read ${configPath} to pin the API port: ${detail}`);
  }

  let inApi = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      // Exactly [api]: [api.tls] and the like are separate tables in TOML.
      inApi = header[1].trim() === "api";
      continue;
    }
    const port = inApi ? /^port\s*=\s*(\d+)$/.exec(line) : null;
    if (port) return Number(port[1]);
  }
  throw new Error(`Sandbox refused: no [api] port found in ${configPath}`);
}

const status = readLocalStatus();
const url = status.API_URL;
// The new-style secret key first, the legacy service_role JWT as fallback;
// both are the local stack's own keys, printed by the CLI.
const key = status.SECRET_KEY || status.SERVICE_ROLE_KEY;

// Refuse before touching process.env: nothing below may run unless the target
// is provably this machine, and this repo's stack on it.
let parsedUrl: URL;
try {
  parsedUrl = new URL(url ?? "");
} catch {
  throw new Error(`Sandbox refused: "supabase status" returned no usable API_URL (${url})`);
}
const host = parsedUrl.hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(`Sandbox refused: API_URL host "${host}" is not local`);
}
const expectedPort = readConfiguredApiPort();
// URL.port is "" for a scheme's default port, which a local stack never uses,
// so an empty value refuses too.
if (parsedUrl.port !== String(expectedPort)) {
  throw new Error(
    `Sandbox refused: API_URL ${url} is not on port ${expectedPort}, the [api] port in ` +
      "supabase/config.toml. It may be another project's local Supabase; the sandbox only runs " +
      "against this repo's stack."
  );
}
if (!key) {
  throw new Error('Sandbox refused: "supabase status" printed no SECRET_KEY or SERVICE_ROLE_KEY');
}

// keys.ts prefers SUPABASE_URL / SUPABASE_SECRET_KEY, but a leftover legacy or
// public variable from the shell must not be able to win either.
for (const name of [
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  // No SMS provider may be configured, even though the tests also mock it:
  // with these unset, a missed mock fails closed instead of sending.
  "FORTYSIX_ELKS_USERNAME",
  "FORTYSIX_ELKS_PASSWORD",
  "FORTYSIX_ELKS_FROM",
  "SMS_PROVIDER",
  "SMS_PROVIDER_WEBHOOK_URL",
  "SMS_PROVIDER_API_KEY"
]) {
  delete process.env[name];
}

process.env.SUPABASE_URL = url;
process.env.SUPABASE_SECRET_KEY = key;
