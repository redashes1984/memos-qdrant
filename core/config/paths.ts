/**
 * The single source of truth for "where does runtime data live for agent X?"
 *
 * Every other module asks this resolver instead of joining its own paths.
 * That way, when the convention changes (or `MEMOS_HOME` overrides it), only
 * this file needs to know.
 */

import { homedir } from "node:os";
import { resolve as pathResolve, join } from "node:path";

import type { AgentKind } from "../types.js";

export interface ResolvedHome {
  /** Absolute path to the runtime root (e.g. ~/.openclaw/memos-plugin). */
  root: string;
  /** Absolute path to config.yaml. */
  configFile: string;
  /** SQLite DB lives under here. */
  dataDir: string;
  dbFile: string;
  /** Crystallized skills package directory. */
  skillsDir: string;
  /** Logs directory (app, error, audit, llm, perf, events, …). */
  logsDir: string;
  /** Daemon pid/port files. */
  daemonDir: string;
}

const DEFAULT_HOME_BY_AGENT: Record<string, string> = {
  openclaw: "{HOME}/.openclaw/memos-plugin",
  hermes:   "{HOME}/.hermes/memos-plugin",
};

/**
 * Resolve the runtime home for `agent`. Override precedence (highest first):
 *
 *   1. `MEMOS_HOME` environment variable (covers everything).
 *   2. `MEMOS_CONFIG_FILE` environment variable (covers only the config file
 *      path; data/skills/logs still derive from the same parent dir).
 *   3. Agent-specific env var (`HERMES_HOME` for hermes) — auto-detects
 *      profile path so bridge.cts picks up the right config without manual
 *      `MEMOS_HOME` overrides.
 *   4. `defaultHome` argument.
 *   5. Built-in default for `agent` (`~/.openclaw/memos-plugin/` etc.).
 */
export function resolveHome(agent: AgentKind, defaultHome?: string): ResolvedHome {
  const env = process.env;
  const envHome = env["MEMOS_HOME"];
  const envConfig = env["MEMOS_CONFIG_FILE"];

  // Auto-detect profile home from agent-specific env var (e.g. HERMES_HOME
  // set by Hermes Gateway to the profile directory). Only applies when
  // MEMOS_HOME / MEMOS_CONFIG_FILE are NOT set, so explicit overrides win.
  const agentEnvVar = `HERMES_HOME`;
  const agentProfileHome = agent === "hermes" ? env[agentEnvVar] : undefined;

  let root: string;
  let configFile: string;

  if (envHome && envHome.trim()) {
    root = pathResolve(expandHome(envHome));
    configFile = join(root, "config.yaml");
  } else if (envConfig && envConfig.trim()) {
    configFile = pathResolve(expandHome(envConfig));
    root = pathResolve(configFile, "..");
  } else if (agentProfileHome && agentProfileHome.trim()) {
    // HERMES_HOME points to the profile dir (e.g. ~/.hermes/profiles/nova),
    // so memos-plugin data lives inside it as a subdirectory.
    root = pathResolve(join(expandHome(agentProfileHome), "memos-plugin"));
    configFile = join(root, "config.yaml");
  } else if (defaultHome && defaultHome.trim()) {
    root = pathResolve(expandHome(defaultHome));
    configFile = join(root, "config.yaml");
  } else {
    const tmpl = DEFAULT_HOME_BY_AGENT[String(agent)] ?? `{HOME}/.${agent}/memos-plugin`;
    root = pathResolve(expandHome(tmpl));
    configFile = join(root, "config.yaml");
  }

  return {
    root,
    configFile,
    dataDir: join(root, "data"),
    dbFile: join(root, "data", "memos.db"),
    skillsDir: join(root, "skills"),
    logsDir: join(root, "logs"),
    daemonDir: join(root, "daemon"),
  };
}

/**
 * Replace the `{HOME}` placeholder and a leading `~` with the user's home dir.
 * (Done explicitly rather than via shell so cross-platform behaviour is sane.)
 */
export function expandHome(p: string): string {
  let out = p;
  if (out.startsWith("~/") || out === "~") {
    out = out.replace(/^~/, homedir());
  }
  out = out.replace(/\{HOME\}/g, homedir());
  return out;
}
