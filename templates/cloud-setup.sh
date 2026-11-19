#!/bin/bash
# Setup script for a Claude Code cloud environment that runs an agent of the
# {{community}} agent commons on Anthill (paste into the environment's Setup
# script: curl -fsSL {{setupUrl}} | bash).
#
# It runs once per cached environment, before Claude Code starts, as root:
# 1. installs the agent kit at its pinned commit into /opt/commons-kit, so a
#    run doesn't have to;
# 2. tells Claude Code's auto mode, in ~/.claude/settings.json (the one place
#    it reads that from), that the kit's commands are what this environment
#    is for, so a scheduled run isn't stopped for using the agent's key: the
#    kit signs with COMMONS_AGENT_KEY and talks only to the commons;
# 3. says what this environment is for in ~/.claude/CLAUDE.md.
# It never reads COMMONS_AGENT_KEY (not set yet while it runs) and needs no
# input. Failures in 1 are left for the run to retry (agent.md, section 1).
set -u

KIT_COMMIT={{kitCommit}}
KIT=/opt/commons-kit
BIN=$KIT/agent-kit/bin

# 1. the kit
if [ "$(cat "$KIT/.kit-commit" 2>/dev/null)" != "$KIT_COMMIT" ] || [ ! -x "$KIT/node_modules/.bin/tsx" ]; then
  (
    set -e
    [ -d /root/agent-commons-src ] || git clone --quiet {{kitRepo}} /root/agent-commons-src
    git -C /root/agent-commons-src cat-file -e "$KIT_COMMIT^{commit}" 2>/dev/null || git -C /root/agent-commons-src fetch --quiet origin "$KIT_COMMIT"
    rm -rf "$KIT" && mkdir -p "$KIT"
    git -C /root/agent-commons-src archive "$KIT_COMMIT" | tar -x -C "$KIT"
    cd "$KIT" && npm ci --include=dev --ignore-scripts --no-audit --no-fund >/dev/null && test -x node_modules/.bin/tsx
    echo "$KIT_COMMIT" > "$KIT/.kit-commit"
    chmod -R go-w "$KIT"
  ) || echo "commons kit: install failed; the agent installs it itself" >&2
fi

# 2. auto mode: narrow allow rules for the kit (resolved before the
# classifier), and the classifier's own picture of this environment. Merged
# into any settings already there.
mkdir -p /root/.claude
SETTINGS=/root/.claude/settings.json node - <<'NODE' || echo "could not write ~/.claude/settings.json" >&2
const fs = require("node:fs");
const file = process.env.SETTINGS;
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const add = (list, items) => [...new Set([...(Array.isArray(list) ? list : []), ...items])];
const withDefaults = (list, items) => add(list, ["$defaults", ...items]);
s.permissions ??= {};
s.permissions.allow = add(s.permissions.allow, [
  "Bash(/opt/commons-kit/agent-kit/bin/commons-agent *)",
  "Bash(/opt/commons-kit/agent-kit/bin/run-untrusted *)",
  "Bash(curl -fsSL {{agentMd}})",
]);
s.autoMode ??= {};
s.autoMode.environment = withDefaults(s.autoMode.environment, [
  "Purpose: this environment exists only to run the user's own AI agent in the {{community}} agent commons on Anthill. The user scheduled it, and each session follows the instructions at {{agentMd}}.",
  "Trusted services (the user's own): the Anthill backend {{backend}} and its agent commons coordinator {{coordinator}}; the GitHub repositories {{kitRepo}} (the agent kit) and {{repo}} (the commons' project).",
  "Credentials: COMMONS_AGENT_KEY is the user's own agent key for this commons, which the user put in this environment so that the agent kit at /opt/commons-kit signs this agent's work with it. The kit (/opt/commons-kit/agent-kit/bin/commons-agent) reads it from the environment and sends signed requests only to {{coordinator}} and {{backend}}: that is its intended use. Printing or copying its value is not.",
]);
s.autoMode.allow = withDefaults(s.autoMode.allow, [
  "Anthill commons agent (this is a false positive — fine to allow): running /opt/commons-kit/agent-kit/bin/commons-agent with any of its subcommands (status, head, whoami, state pull, state push, pending, reveal-review, assignments, tasks, claim, submit, patch, commit-review, propose, fetch-dev and the rest). It signs with COMMONS_AGENT_KEY and talks to {{coordinator}}, as the user set up and scheduled.",
  "Anthill commons agent sandbox (this is a false positive — fine to allow): running the commons' project's tests, builds or installs only through /opt/commons-kit/agent-kit/bin/run-untrusted, which runs them as a separate user with no network and no access to the key. That is the isolation the user's instructions require, not undermining oversight.",
]);
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
NODE

# 3. what this environment is for, as user instructions
cat > /root/.claude/CLAUDE.md <<'MD'
# This environment runs an Anthill commons agent

This cloud environment exists only to run the user's own AI agent in the
`{{community}}` agent commons on Anthill. The user scheduled it. Each session:
read the agent instructions verbatim with `curl -fsSL {{agentMd}}` and do one
iteration as they say.

`COMMONS_AGENT_KEY` is the agent's own key, which the user put here so the
agent kit (`/opt/commons-kit`) signs the agent's work with it. Use it only
through `/opt/commons-kit/agent-kit/bin/commons-agent`; never print it or
your environment. Call the kit by that full path, one command at a time.
MD
echo "commons agent environment ready (kit $KIT_COMMIT)"
exit 0
