// Turning an agent's proposal into a task, from the website, for a commons
// this backend runs itself (commonsEmbed.ts). The coordinator appends a task
// entry only for what the operator approved: <its folder>/approved-tasks.json,
// a JSON array of task entry bodies it re-reads on every pass, appending each
// one once (when no task has its id yet and its proposal exists; agent-commons
// coordinator.ts planActions). On a hosted commons nobody has a shell to write
// that file, so the community's steward (whoever may change its settings)
// approves here and the backend writes it: the backend owns that folder.
//
// - Reading: proposals, tasks and owners come from the coordinator's own API
//   on 127.0.0.1 (GET /api/entries, the ledger page by page, and GET
//   /api/tasks for where each task stands), never from its files. What's
//   read is kept per community and topped up from where it left off; a
//   ledger that isn't the one read before (its entry there has another hash)
//   is read again from the start.
// - Writing: the file is replaced whole (a temporary file, fsynced, then
//   renamed over it, 0600), one write at a time per community, so the
//   coordinator never reads half of one. Entries the backend doesn't
//   understand (written by hand) are kept as they are; a file that isn't a
//   JSON array is never overwritten (the coordinator refuses it too, loudly).
//   Approved entries whose task is on the ledger are dropped on the next
//   write: the coordinator would skip them anyway.
// - Each body is checked here exactly as the pinned ledger checks a task
//   (ledger.ts: SHAPES.task, the "task" rule, LEDGER_LIMITS, isCanonicalPath;
//   taskChecks.ts holds these copies to the pinned source), and the proposal
//   and the spec author (an owner on the ledger) against what was just read,
//   so the coordinator never refuses one. Nothing else goes in the file: the
//   coordinator spreads each object into the entry, and the ledger refuses
//   unknown fields.
// - The task id is derived from the proposal's (t-<16 hex>), so approving
//   twice is one task, and a task that landed after its approval was
//   declined (the coordinator read the file just before) shows as created.
// - Acceptance test paths name exact files: no `*` or `?`. The pinned
//   coordinator reads them as globs (rules.ts globToRegExp, in the gates'
//   isAcceptancePath, run inside its HTTP process on every changed file), and
//   a crafted one (`**/` repeated) backtracks for hours: one approved path
//   would stop the whole embedded commons for good, since a task can't be
//   taken back.
// - The size estimate is held to the ledger's own rules, read with it: at
//   most rules.maxLinesPerSubmission (more can't be submitted at once), and
//   no more than an agent can lock to claim it (its claim stake within
//   stake.allowance and the kit's default COMMONS_MAX_STAKE). Larger work is
//   several proposals.
// - Declining takes a pending approval out of the file. A task on the ledger
//   is there for good: there's no entry that takes one back. A coordinator
//   pass that read the file just before can still append it moments later,
//   so a declined proposal is watched for a while (`watchUntil`): the list
//   says so, and the website keeps looking until then.
// - The list is a page: proposals waiting on the coordinator (a pending
//   approval, or one just declined) always come first, then the others,
//   newest first, a page at a time (`next`, then ?before=<next>), so a flood
//   of proposals can't push one out of reach. Each lists at most a few pieces
//   of evidence (GET /commons/proposals/:id has them all).

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { childDataDir, type Embed, type EmbeddedCommons } from "./commonsEmbed";
import { keyIdOf } from "./commonsLink";
import { RelayError, rateLimit } from "./http";
import { ActionError } from "./offchain";

////////////////////////////////////////////
//// the pinned ledger's rules for a task (agent-commons src/ledger.ts)

// LEDGER_LIMITS: id, path, acceptanceTestPaths, title, evidence
export const TASK_LIMITS = { id: 128, path: 512, acceptanceTestPaths: 100, title: 300, evidence: 20 } as const;
// ID_RE
export const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// The largest size estimate taken here. The ledger takes any safe integer
// from 0 (changed lines), but a claim's stake grows faster than the size,
// so a huge one is a task nobody can claim.
export const MAX_SIZE_ESTIMATE = 100_000;

const isLedgerId = (v: unknown): v is string => typeof v === "string" && v.length <= TASK_LIMITS.id && LEDGER_ID.test(v);

// What the pinned coordinator's globToRegExp (rules.ts) reads as a wildcard
// in an acceptance test path: `*`, `**` and `?`. Everything else is literal.
export const GLOB_CHARS = /[*?]/;

// isCanonicalPath: a repo-relative POSIX path in its one spelling.
export function isCanonicalPath(p: unknown): p is string {
  if (typeof p !== "string" || p === "" || p.length > TASK_LIMITS.path) return false;
  if (p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export type Ring = 0 | 1 | 2;

// A task entry body (agent-commons src/types.ts, kind "task"), as written to
// approved-tasks.json.
export type TaskBody = {
  kind: "task";
  id: string;
  proposalId: string;
  ring: Ring;
  acceptanceTestPaths: string[];
  sizeEstimate: number;
  specAuthor: string;
};

// The task id for a proposal: the same every time, the shape of the CLI's
// own (`t-` and 16 hex digits).
export const taskIdFor = (proposalId: string) => `t-${createHash("sha256").update(`anthill-task:${proposalId}`).digest("hex").slice(0, 16)}`;

const USER_ID = /^0x[0-9a-f]{40}$/;
const APPROVAL_FIELDS = new Set(["ring", "sizeEstimate", "acceptanceTests", "specAuthor"]);

// The approval the steward sent, { ring, sizeEstimate, acceptanceTests,
// specAuthor? }, checked strictly (nothing else, nothing coerced). The spec
// author defaults to the approver. Whether the proposal exists and the spec
// author is an owner is checked against the ledger by the caller.
export function parseApproval(body: Record<string, unknown>, approver: string): Omit<TaskBody, "kind" | "id" | "proposalId"> {
  const unknown = Object.keys(body).filter((k) => !APPROVAL_FIELDS.has(k));
  if (unknown.length > 0) throw new ActionError(`Unknown fields: ${unknown.join(", ")}.`);
  const { ring, sizeEstimate, acceptanceTests } = body;
  if (ring !== 0 && ring !== 1 && ring !== 2) throw new ActionError("ring must be 0, 1 or 2.");
  if (typeof sizeEstimate !== "number" || !Number.isSafeInteger(sizeEstimate) || sizeEstimate < 0 || sizeEstimate > MAX_SIZE_ESTIMATE) {
    throw new ActionError(`sizeEstimate must be a whole number of changed lines, from 0 to ${MAX_SIZE_ESTIMATE}.`);
  }
  if (!Array.isArray(acceptanceTests) || acceptanceTests.length === 0) throw new ActionError("acceptanceTests must list at least one test file path.");
  if (acceptanceTests.length > TASK_LIMITS.acceptanceTestPaths) throw new ActionError(`acceptanceTests can list at most ${TASK_LIMITS.acceptanceTestPaths} paths.`);
  const paths: string[] = [];
  for (const p of acceptanceTests) {
    if (!isCanonicalPath(p) || /\p{Cc}/u.test(p)) {
      throw new ActionError(
        `${JSON.stringify(typeof p === "string" ? p.slice(0, 80) : p)} isn't a test file path in the repository: relative, with / between folders, no empty, . or .. parts, no backslashes, at most ${TASK_LIMITS.path} characters.`,
      );
    }
    if (GLOB_CHARS.test(p)) {
      throw new ActionError(`${JSON.stringify(p.slice(0, 80))} has a * or ?: name each test file exactly, without wildcards.`);
    }
    if (paths.includes(p)) throw new ActionError(`acceptanceTests names ${p} twice.`);
    paths.push(p);
  }
  const specAuthor = body.specAuthor === undefined ? approver : body.specAuthor;
  if (typeof specAuthor !== "string" || !USER_ID.test(specAuthor) || !isLedgerId(specAuthor)) {
    throw new ActionError("specAuthor must be an Anthill user id (0x and 40 lowercase hex digits).");
  }
  return { ring, sizeEstimate, acceptanceTestPaths: paths, specAuthor };
}

////////////////////////////////////////////
//// the ledger's rules for a task's size (agent-commons src/rules.ts)

// What a task's size is held to: the ledger's current rules (its genesis,
// then each rulesChange), just these fields.
export type SizeRules = {
  maxLinesPerSubmission: number;
  stake: { base: number; exponent: number; ringMultiplier: [number, number, number]; allowance: number };
};

// The kit's default COMMONS_MAX_STAKE (agent-commons client.ts
// DEFAULT_MAX_STAKE): an agent refuses to lock more than this by default.
export const AGENT_MAX_STAKE = 320;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// The fields above from a rules object on the ledger, or undefined if any is
// missing or odd (the ledger checked them; this reads defensively).
export function sizeRulesOf(r: unknown): SizeRules | undefined {
  const o = r as { maxLinesPerSubmission?: unknown; stake?: Record<string, unknown> } | null;
  if (typeof o !== "object" || o === null || typeof o.stake !== "object" || o.stake === null) return undefined;
  const { base, exponent, ringMultiplier: m, allowance } = o.stake;
  if (!finite(o.maxLinesPerSubmission) || !finite(base) || !finite(exponent) || !finite(allowance)) return undefined;
  if (!Array.isArray(m) || m.length !== 3 || !m.every(finite)) return undefined;
  return { maxLinesPerSubmission: o.maxLinesPerSubmission, stake: { base, exponent, ringMultiplier: [m[0], m[1], m[2]], allowance } };
}

// The stake an agent locks to claim a task (rules.ts claimStake, at least 1,
// as the ledger's claim rule and GET /api/tasks).
export function claimStakeFor(lines: number, ring: Ring, r: SizeRules): number {
  const { base, exponent, ringMultiplier } = r.stake;
  return Math.max(1, Math.ceil(base * Math.pow(Math.max(lines, 1) / 100, exponent) * ringMultiplier[ring]));
}

// The largest size estimate a task in `ring` can have and still be done:
// submitted in one go (maxLinesPerSubmission) and claimed (its claim stake
// within the allowance and the kit's default limit). -1: none can.
export function maxSizeFor(ring: Ring, r: SizeRules): number {
  const stakeLimit = Math.min(r.stake.allowance, AGENT_MAX_STAKE);
  let lo = 0;
  let hi = Math.min(Math.floor(r.maxLinesPerSubmission), MAX_SIZE_ESTIMATE);
  if (claimStakeFor(lo, ring, r) > stakeLimit) return -1;
  // the claim stake grows with the size: the last one that fits
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (claimStakeFor(mid, ring, r) <= stakeLimit) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// What the approval form needs to say about sizes: the largest estimate for
// each ring, and the rules to show a claim stake beside the field.
export function sizeLimits(r: SizeRules) {
  return {
    maxSizeEstimate: [maxSizeFor(0, r), maxSizeFor(1, r), maxSizeFor(2, r)],
    maxLinesPerSubmission: r.maxLinesPerSubmission,
    stakeLimit: Math.min(r.stake.allowance, AGENT_MAX_STAKE),
    claimStake: { base: r.stake.base, exponent: r.stake.exponent, ringMultiplier: r.stake.ringMultiplier },
  };
}

////////////////////////////////////////////
//// the ledger, as the coordinator's API gives it

export type Evidence = { kind: string; text: string };

export type LedgerProposal = { id: string; title: string; evidence: Evidence[]; signer: string; at: string; seq: number };
export type LedgerTask = Omit<TaskBody, "kind"> & { seq: number };

// What's kept of a ledger: just what proposals need.
export type LedgerView = {
  // entries read, and the hash of the last one
  length: number;
  lastHash: string;
  proposals: Map<string, LedgerProposal>;
  tasks: Map<string, LedgerTask>;
  // owner ids, and which key is whose: owners' keys, and agents (with their
  // model family)
  owners: Set<string>;
  ownerKeys: Map<string, string>;
  agents: Map<string, { owner: string; modelFamily: string }>;
  // the rules a task's size is held to (undefined: none readable yet)
  rules: SizeRules | undefined;
  // where each task stands (GET /api/tasks), as of `at`
  taskStatus: Map<string, string>;
  at: number;
  // whether the whole ledger was read (a long one takes several reads)
  complete: boolean;
};

const emptyView = (): LedgerView => ({
  length: 0,
  lastHash: "",
  proposals: new Map(),
  tasks: new Map(),
  owners: new Set(),
  ownerKeys: new Map(),
  agents: new Map(),
  rules: undefined,
  taskStatus: new Map(),
  at: 0,
  complete: false,
});

const MAX_TEXT = 500;
// participant-written text, as plain one-line text
const clean = (v: unknown, max = MAX_TEXT) =>
  typeof v === "string" ? v.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

// One piece of a proposal's evidence (agent-commons Evidence), in words.
export function evidenceText(e: unknown): Evidence {
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  const at = (file: unknown, line: unknown) => `${clean(file, 300)}${typeof line === "number" ? `:${line}` : ""}`;
  switch (o.kind) {
    case "failingTest":
      return { kind: "failingTest", text: clean(`${clean(o.testId, 200)} fails: ${clean(o.command)}`) };
    case "diagnostic":
      return { kind: "diagnostic", text: clean(`${clean(o.tool, 100)} at ${at(o.file, o.line)}: ${clean(o.message)}`) };
    case "location":
      return { kind: "location", text: clean(`${at(o.file, o.line)}: ${clean(o.note)}`) };
    default:
      return { kind: "other", text: "" };
  }
}

// One ledger entry into the view. The coordinator checked it when it was
// appended; what's read is still checked for shape, and anything odd skipped.
function fold(view: LedgerView, entry: Record<string, any>) {
  const body = entry.body;
  if (typeof body !== "object" || body === null) return;
  const str = (v: unknown): v is string => typeof v === "string";
  switch (body.kind) {
    case "genesis":
    case "rulesChange":
      view.rules = sizeRulesOf(body.rules);
      return;
    case "ownerKey":
      if (str(body.owner) && str(body.publicKey)) {
        view.owners.add(body.owner);
        view.ownerKeys.set(keyIdOf(body.publicKey), body.owner);
      }
      return;
    case "anthillOwner": {
      const a = body.attestation;
      if (str(a?.user) && str(a?.publicKey)) {
        view.owners.add(a.user);
        view.ownerKeys.set(keyIdOf(a.publicKey), a.user);
      }
      return;
    }
    case "anthillAgent": {
      const a = body.attestation;
      if (str(a?.user) && str(a?.agentKey)) {
        view.owners.add(a.user);
        view.agents.set(keyIdOf(a.agentKey), { owner: a.user, modelFamily: clean(a.modelFamily, 64) });
      }
      return;
    }
    case "agentRegistered":
      if (str(body.owner) && str(body.publicKey)) view.agents.set(keyIdOf(body.publicKey), { owner: body.owner, modelFamily: clean(body.modelFamily, 64) });
      return;
    case "proposal":
      if (isLedgerId(body.id) && Array.isArray(body.evidence)) {
        view.proposals.set(body.id, {
          id: body.id,
          title: clean(body.title, TASK_LIMITS.title),
          evidence: body.evidence.slice(0, TASK_LIMITS.evidence).map(evidenceText),
          signer: str(entry.signer) ? entry.signer : "",
          at: str(entry.at) ? entry.at : "",
          seq: entry.seq,
        });
      }
      return;
    case "task":
      if (isLedgerId(body.id) && isLedgerId(body.proposalId) && Array.isArray(body.acceptanceTestPaths)) {
        view.tasks.set(body.id, {
          id: body.id,
          proposalId: body.proposalId,
          ring: body.ring,
          acceptanceTestPaths: body.acceptanceTestPaths.filter(str),
          sizeEstimate: body.sizeEstimate,
          specAuthor: str(body.specAuthor) ? body.specAuthor : "",
          seq: entry.seq,
        });
      }
      return;
  }
}

// Requests to one coordinator a minute, at most (each page of entries is
// one). It limits each address, and every request from Anthill comes from
// one: this keeps the proposals' reads from using up what the relay needs.
export const LEDGER_READS_PER_MINUTE = 120;
// how long a read is reused for listing (approving reads again)
export const VIEW_CACHE_MS = 5_000;
const READ_TIMEOUT_MS = 15_000;
const PAGE = 500;
// pages read at most in one go, within the budget above: a longer ledger is
// read on in the next ones, and nothing is approved until it's all read
const MAX_PAGES = 50;

const unreadable = () => new RelayError("The commons' coordinator isn't answering properly right now; try again in a moment.");

// A community's ledger, read through its coordinator's API (`internal`: its
// URL on 127.0.0.1, with its base path).
export class LedgerReader {
  private view: LedgerView | undefined;
  private viewRead = 0;
  private pending: Promise<LedgerView> | undefined;
  // reads started so far: "read now" takes only one started after it was
  // asked for (the clock alone can't tell two in the same millisecond apart)
  private started = 0;

  constructor(
    readonly community: string,
    private internal: string,
    private fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  // The view, read at most `maxAgeMs` ago (0: a read started after this
  // call). One read at a time, shared by whoever asks meanwhile.
  async read(maxAgeMs = VIEW_CACHE_MS): Promise<LedgerView> {
    const asked = Date.now();
    const before = this.started;
    const fresh = () => this.view !== undefined && (maxAgeMs <= 0 ? this.viewRead > before : this.view.at >= asked - maxAgeMs);
    while (true) {
      if (fresh()) return this.view!;
      if (this.pending === undefined) break;
      await this.pending.catch(() => undefined);
    }
    const reading = this.topUp().finally(() => {
      if (this.pending === reading) this.pending = undefined;
    });
    this.pending = reading;
    return reading;
  }

  private async get(path: string): Promise<any> {
    rateLimit(`commons-read:${this.community}`, LEDGER_READS_PER_MINUTE);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.internal}${path}`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      throw new RelayError("The commons' coordinator can't be reached right now; try again in a moment.");
    }
    const data = await res.json().catch(() => undefined);
    if (res.status !== 200 || typeof data !== "object" || data === null) throw unreadable();
    return data;
  }

  // Reads what's new since the last read (the whole ledger if it isn't the
  // same one), then where each task stands.
  private async topUp(): Promise<LedgerView> {
    const started = Date.now();
    const readNo = ++this.started;
    const before = this.view;
    let view: LedgerView = before === undefined ? emptyView() : { ...before, proposals: new Map(before.proposals), tasks: new Map(before.tasks), owners: new Set(before.owners), ownerKeys: new Map(before.ownerKeys), agents: new Map(before.agents) };
    // the last entry read comes back first, to tell it's the same ledger
    let since = view.length === 0 ? 0 : view.length - 1;
    let check = view.length > 0;
    let complete = false;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = await this.get(`/api/entries?since=${since}&limit=${PAGE}`);
      if (!Array.isArray(page.entries)) throw unreadable();
      let entries = page.entries as Record<string, any>[];
      if (check) {
        check = false;
        const same = entries[0]?.seq === since && entries[0]?.hash === view.lastHash;
        if (!same) {
          // another ledger (a fresh disk): from the start
          view = emptyView();
          since = 0;
          pages = -1;
          continue;
        }
        entries = entries.slice(1);
      }
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null || entry.seq !== view.length || typeof entry.hash !== "string") throw unreadable();
        fold(view, entry);
        view.length += 1;
        view.lastHash = entry.hash;
      }
      if (page.next === null || page.next === undefined) {
        complete = true;
        break;
      }
      if (typeof page.next !== "number" || page.next !== view.length) throw unreadable();
      since = page.next;
    }
    const tasks = await this.get("/api/tasks");
    const status = new Map<string, string>();
    if (Array.isArray(tasks.tasks)) {
      for (const t of tasks.tasks) {
        if (typeof t?.id === "string" && typeof t.status === "string" && /^[a-z]{1,20}$/.test(t.status)) status.set(t.id, t.status);
      }
    }
    view.taskStatus = status;
    view.complete = complete;
    view.at = started;
    this.view = view;
    this.viewRead = readNo;
    return view;
  }
}

////////////////////////////////////////////
//// approved-tasks.json

export const approvedTasksPath = (c: EmbeddedCommons, embed: Embed) => join(childDataDir(c, embed), "approved-tasks.json");

// What the file holds: an array of objects (a missing file: none). A file
// that isn't that is an error, never overwritten.
export function readApproved(file: string): unknown[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "object" || t === null || Array.isArray(t))) {
    throw new RelayError("This commons' approved-tasks.json isn't a JSON array of task bodies, so it can't be changed from here; the operator has to fix it on the server.", "approved-tasks-malformed");
  }
  return parsed;
}

// Replaces the file whole: a temporary file beside it (0600), synced, then
// renamed over it.
export function writeApproved(file: string, list: unknown[]) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(list, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// An approved task the backend can read (a proposal id and a task id).
const approvedEntry = (t: unknown): t is { id: string; proposalId: string } & Record<string, unknown> =>
  typeof (t as { id?: unknown }).id === "string" && typeof (t as { proposalId?: unknown }).proposalId === "string";

////////////////////////////////////////////
//// what the website is given

export type ProposalTask = {
  // pending: approved, waiting for the coordinator's next pass; created: on
  // the ledger (`state`: open, claimed, merged, as the coordinator says)
  status: "pending" | "created";
  id: string;
  ring: number;
  sizeEstimate: number;
  acceptanceTestPaths: string[];
  specAuthor: { id: string; name: string };
  state?: string;
};

export type ProposalView = {
  id: string;
  title: string;
  proposedAt: string;
  // in the list, at most LIST_EVIDENCE of them (evidenceTotal: how many
  // there are)
  evidence: Evidence[];
  evidenceTotal: number;
  // who proposed it: the agent's key and model family, and its owner
  // (or the owner's own key: agent null)
  author: { agent: string | null; modelFamily: string | null; owner: { id: string; name: string } | null };
  task: ProposalTask | null;
  // declined just now, without a task (yet): the coordinator may still
  // append the one it read before; keep looking until then (ISO time)
  watchUntil?: string;
};

// proposals a page, and pieces of evidence each, in the list
export const PAGE_SIZE = 50;
export const LIST_EVIDENCE = 5;

// How long a declined approval is watched for: a coordinator pass reads the
// file, then appends its tasks first thing (planActions puts them first), so
// two passes (30 seconds apart) is more than the race can take.
export const DECLINE_WATCH_MS = 60_000;

// Per approved-tasks.json, the proposals declined lately: id -> until (ms).
const declined = new Map<string, Map<string, number>>();

// Until when a declined proposal is watched (undefined: it isn't).
export function watchUntil(file: string, proposalId: string, now = Date.now()): number | undefined {
  const forFile = declined.get(file);
  const until = forFile?.get(proposalId);
  if (until === undefined) return undefined;
  if (until > now) return until;
  forFile!.delete(proposalId);
  if (forFile!.size === 0) declined.delete(file);
  return undefined;
}

function watch(file: string, proposalId: string, until: number) {
  let forFile = declined.get(file);
  if (forFile === undefined) {
    forFile = new Map();
    declined.set(file, forFile);
  }
  forFile.set(proposalId, until);
}

function taskOf(view: LedgerView, approved: unknown[], proposalId: string, nameOf: (id: string) => string): ProposalTask | null {
  const person = (id: string) => ({ id, name: nameOf(id) });
  for (const t of view.tasks.values()) {
    if (t.proposalId !== proposalId) continue;
    const state = view.taskStatus.get(t.id);
    return {
      status: "created",
      id: t.id,
      ring: t.ring,
      sizeEstimate: t.sizeEstimate,
      acceptanceTestPaths: t.acceptanceTestPaths,
      specAuthor: person(t.specAuthor),
      ...(state === undefined ? {} : { state }),
    };
  }
  for (const t of approved) {
    if (!approvedEntry(t) || t.proposalId !== proposalId || view.tasks.has(t.id)) continue;
    return {
      status: "pending",
      id: t.id,
      ring: typeof t.ring === "number" ? t.ring : -1,
      sizeEstimate: typeof t.sizeEstimate === "number" ? t.sizeEstimate : 0,
      acceptanceTestPaths: Array.isArray(t.acceptanceTestPaths) ? t.acceptanceTestPaths.filter((p): p is string => typeof p === "string") : [],
      specAuthor: person(typeof t.specAuthor === "string" ? t.specAuthor : ""),
    };
  }
  return null;
}

// One proposal for the website. `file`: the community's approved-tasks.json
// (for whether it was declined just now); `evidence`: how many pieces at most.
export function proposalView(
  view: LedgerView,
  approved: unknown[],
  p: LedgerProposal,
  nameOf: (id: string) => string,
  o: { file?: string; evidence?: number; now?: number } = {},
): ProposalView {
  const agent = view.agents.get(p.signer);
  const owner = agent?.owner ?? view.ownerKeys.get(p.signer);
  const task = taskOf(view, approved, p.id, nameOf);
  const until = task === null && o.file !== undefined ? watchUntil(o.file, p.id, o.now) : undefined;
  return {
    id: p.id,
    title: p.title,
    proposedAt: p.at,
    evidence: o.evidence === undefined ? p.evidence : p.evidence.slice(0, o.evidence),
    evidenceTotal: p.evidence.length,
    author: {
      agent: agent === undefined ? null : p.signer,
      modelFamily: agent?.modelFamily ?? null,
      owner: owner === undefined ? null : { id: owner, name: nameOf(owner) },
    },
    task,
    ...(until === undefined ? {} : { watchUntil: new Date(until).toISOString() }),
  };
}

// One page of the list. The first (no `before`) starts with every proposal
// waiting on the coordinator: a pending approval, or one declined just now.
// Then the others, newest first, PAGE_SIZE at a time: `next` is the `before`
// for the next page (null: no more).
export function proposalList(
  view: LedgerView,
  approved: unknown[],
  nameOf: (id: string) => string,
  o: { file?: string; before?: number; now?: number } = {},
): { proposals: ProposalView[]; next: number | null } {
  const waiting = new Set<string>();
  for (const t of approved) {
    if (approvedEntry(t) && !view.tasks.has(t.id) && view.proposals.has(t.proposalId)) waiting.add(t.proposalId);
  }
  if (o.file !== undefined) {
    for (const id of declined.get(o.file)?.keys() ?? []) {
      if (view.proposals.has(id) && watchUntil(o.file, id, o.now) !== undefined) waiting.add(id);
    }
  }
  const newestFirst = (a: LedgerProposal, b: LedgerProposal) => b.seq - a.seq;
  const pinned = o.before === undefined ? [...waiting].map((id) => view.proposals.get(id)!).sort(newestFirst) : [];
  const rest = [...view.proposals.values()].filter((p) => !waiting.has(p.id) && (o.before === undefined || p.seq < o.before)).sort(newestFirst);
  const page = rest.slice(0, PAGE_SIZE);
  const next = rest.length > PAGE_SIZE ? page[page.length - 1].seq : null;
  const v = { file: o.file, evidence: LIST_EVIDENCE, now: o.now };
  return { proposals: [...pinned, ...page].map((p) => proposalView(view, approved, p, nameOf, v)), next };
}

////////////////////////////////////////////
//// approving and declining

// One change to a community's file at a time.
const queues = new Map<string, Promise<unknown>>();
function serially<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const result = (queues.get(file) ?? Promise.resolve()).then(fn);
  const settled = result.catch(() => undefined);
  queues.set(file, settled);
  void settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file);
  });
  return result;
}

// What's decided on must be the whole ledger.
function requireComplete(view: LedgerView) {
  if (!view.complete) throw new RelayError("This commons' ledger is long and still being read; try again in a minute.");
}

// The size estimate within what the ledger's rules let a task be done at.
function requireDoableSize(view: LedgerView, ring: Ring, size: number) {
  const rules = view.rules;
  if (rules === undefined) throw new RelayError("This commons' rules couldn't be read from its ledger; ask the operator.");
  const max = maxSizeFor(ring, rules);
  if (size <= max) return;
  if (max < 0) {
    throw new ActionError(`No ring ${ring} task can be claimed under this commons' rules: its claim stake is more than an agent can lock.`, "size-too-large");
  }
  if (size > rules.maxLinesPerSubmission) {
    throw new ActionError(
      `A task of ${size} changed lines can't be submitted at once: this commons takes at most ${rules.maxLinesPerSubmission} lines a submission. Split larger work into several proposals.`,
      "size-too-large",
    );
  }
  const stake = claimStakeFor(size, ring, rules);
  throw new ActionError(
    `A ring ${ring} task of ${size} changed lines needs a claim stake of ${stake}, more than an agent can lock (${Math.min(rules.stake.allowance, AGENT_MAX_STAKE)}): at most ${max} lines in ring ${ring}. Split larger work into several proposals.`,
    "size-too-large",
  );
}

// Adds the task to the file, unless it's already there or on the ledger.
// `view` was read just now. Returns whether it was added.
export function approve(
  file: string,
  view: LedgerView,
  proposalId: string,
  fields: Omit<TaskBody, "kind" | "id" | "proposalId">,
): Promise<{ added: boolean }> {
  requireComplete(view);
  const proposal = view.proposals.get(proposalId);
  if (proposal === undefined) throw new ActionError("There's no such proposal in this commons.");
  for (const t of view.tasks.values()) {
    if (t.proposalId === proposalId) throw new ActionError("That proposal is already a task.", "already-a-task");
  }
  if (!view.owners.has(fields.specAuthor)) {
    throw new ActionError(
      "The spec author must be an owner in this commons: someone with an agent connected here (or their own commons key). Connect an agent first, or name someone who has.",
      "not-an-owner",
    );
  }
  requireDoableSize(view, fields.ring, fields.sizeEstimate);
  const id = taskIdFor(proposalId);
  if (view.tasks.has(id)) throw new ActionError("Another task already has this proposal's task id; ask the operator.");
  const body: TaskBody = { kind: "task", id, proposalId, ...fields };
  return serially(file, () => {
    const list = readApproved(file);
    if (list.some((t) => approvedEntry(t) && t.proposalId === proposalId && !view.tasks.has(t.id))) return { added: false };
    // what's on the ledger already needn't stay
    const kept = list.filter((t) => !(approvedEntry(t) && view.tasks.has(t.id)));
    writeApproved(file, [...kept, body]);
    // approved again: no longer a declined one to watch
    declined.get(file)?.delete(proposalId);
    return { added: true };
  });
}

// Takes the proposal's pending task out of the file. Returns whether there
// was one, and if so until when to watch for the task anyway: a coordinator
// pass that read the file just before may still append it.
export function decline(file: string, view: LedgerView, proposalId: string, now = Date.now()): Promise<{ removed: boolean; watchUntil?: number }> {
  requireComplete(view);
  if (!view.proposals.has(proposalId)) throw new ActionError("There's no such proposal in this commons.");
  for (const t of view.tasks.values()) {
    if (t.proposalId === proposalId) throw new ActionError("That proposal is already a task, and a task can't be taken back.", "already-a-task");
  }
  return serially(file, () => {
    const list = readApproved(file);
    const kept = list.filter((t) => !(approvedEntry(t) && (t.proposalId === proposalId || view.tasks.has(t.id))));
    const removed = list.some((t) => approvedEntry(t) && t.proposalId === proposalId);
    if (kept.length !== list.length) writeApproved(file, kept);
    if (!removed) return { removed };
    const until = now + DECLINE_WATCH_MS;
    watch(file, proposalId, until);
    return { removed, watchUntil: until };
  });
}
