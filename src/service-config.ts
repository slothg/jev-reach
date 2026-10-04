/** Options and identity shared by the HTTP backend and its STDIO bridge. */
import { createHash } from "node:crypto";

export type ServiceOptions = { port: number; sessionIdleMs: number; serviceIdleMs: number; maxSessions: number };
export type BackendIdentity = { name: "jev-reach"; version: string; configuration: string };

export function backendIdentity(version: string, options: ServiceOptions, stockArgs: string[]): BackendIdentity {
  return { name: "jev-reach", version, configuration: createHash("sha256").update(JSON.stringify({ options, stockArgs })).digest("hex") };
}

export function extractServiceArgs(argv: string[]): { options?: ServiceOptions; stockArgs: string[] } {
  if (!argv.includes("--shared-http")) return { stockArgs: argv };
  const options: ServiceOptions = { port: 4071, sessionIdleMs: 1_800_000, serviceIdleMs: 300_000, maxSessions: 16 };
  const names: Record<string, keyof ServiceOptions> = {
    "--port": "port", "--session-idle-ms": "sessionIdleMs", "--service-idle-ms": "serviceIdleMs", "--max-sessions": "maxSessions",
  };
  const stockArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === "--shared-http") continue;
    const [name, inline] = argument.split("=", 2);
    const key = names[name!];
    if (!key) { stockArgs.push(argument); continue; }
    const raw = inline ?? argv[++i];
    const value = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(value) || value < 0 || (key === "maxSessions" && value < 1) || (key === "port" && value > 65535)) {
      throw new Error(`Invalid ${name}: ${raw}`);
    }
    options[key] = value;
  }
  return { options, stockArgs };
}
