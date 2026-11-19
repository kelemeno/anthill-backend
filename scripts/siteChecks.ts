// Checks of community sites (src/site.ts), run in-process on throwaway data
// dirs (no server needed): the defaults (Agents only with a commons) in
// summaries and GET /c/<id>/site; POST /c/<id>/site validated strictly
// (pages as a record of booleans, or a list without duplicates, known
// accents, the About's length as it's kept and its
// control characters gone but its line breaks kept, one with nothing
// visible none, nothing else), and
// nothing logged for a refused or unchanged save; who may save (the founder,
// the root of a founderless community, nobody for an empty one, others
// refused; a deleted founder's site stays the community's); the limit per
// account and minute, and the daily budget per account and per community
// (shared with settings, only logged changes counted); a private community's
// site invisible to outsiders (also in an
// invite's preview); the export; replay after a restart, and with the
// operator's commons taken away or added (a save meanwhile keeps the Agents
// choice); and older logs: one without sites
// starts unchanged and serves what it did, unknown entry types and names
// from a newer version are ignored.
//
//   npx tsx scripts/siteChecks.ts

import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SoftPasskey } from "./softPasskey";

// before the modules that read them are loaded
process.env.RP_ID = "localhost";
process.env.ORIGINS = "http://localhost:5173";
process.env.SEED = "empty";
delete process.env.SESSION_SECRET;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.INVITE_ONLY;
delete process.env.COMMONS_FOUNDER;

const COMMONS = JSON.stringify({ builders: { coordinator: "https://coordinator.test", site: "https://commons.test" } });

const ok = (name: string) => console.log(`ok: ${name}`);
// pages as the API has them: a boolean for each
const on = (...shown: string[]) => Object.fromEntries(["explore", "polls", "people", "agents"].map((p) => [p, shown.includes(p)]));
// The clock, moved on a minute at a time (new rate-limit windows).
const realNow = Date.now;
let skipped = 0;
const nextMinute = () => {
  skipped += 61_000;
  Date.now = () => realNow() + skipped;
};
// ...or a day (new daily budgets)
const nextDay = () => {
  skipped += 24 * 60 * 60_000 + 1_000;
  Date.now = () => realNow() + skipped;
};

async function main() {
  const { offchainServer } = await import("../src/offchainApi");
  const { AuthError, origins } = await import("../src/auth");
  const { corsPolicy, securityHeaders } = await import("../src/headers");
  const { NotFoundError, RateLimitError, RelayError } = await import("../src/http");
  const { ActionError } = await import("../src/offchain");
  const { Store } = await import("../src/store");
  const { MAX_ABOUT } = await import("../src/site");

  // A coordinator where nobody has agents (deleting an account asks it).
  const coordinator = async () => Response.json({ owner: "", agents: [] });

  // A server on `dir`, set up as App.ts does; `commons` is COMMONS_SITES
  // (null: unset).
  async function boot(dir: string, commons: string | null = COMMONS) {
    process.env.DATA_DIR = dir;
    if (commons === null) delete process.env.COMMONS_SITES;
    else process.env.COMMONS_SITES = commons;
    const app = new Hono();
    app.use("*", securityHeaders());
    app.use("*", corsPolicy(origins));
    app.onError((err, c) => {
      if (err instanceof AuthError) return c.json({ error: err.message, code: err.code }, 401);
      if (err instanceof ActionError) return c.json({ error: err.message, code: err.code }, 400);
      if (err instanceof NotFoundError) return c.json({ error: err.message || "Not found" }, 404);
      if (err instanceof RelayError) return c.json({ error: err.message, code: err.code }, 502);
      if (err instanceof RateLimitError) return c.json({ error: "rate limited" }, 429);
      console.error(err);
      return c.json({ error: "internal error" }, 500);
    });
    const { start } = offchainServer(app, () => {}, { fetch: coordinator as typeof fetch });
    await start();
    const call = async (path: string, body?: unknown, token?: string) => {
      const res = await app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, data };
    };
    return { call };
  }
  type Server = Awaited<ReturnType<typeof boot>>;

  const expect = (res: { status: number; data: any }, status: number, error?: string) => {
    assert.equal(res.status, status, JSON.stringify(res.data));
    if (error !== undefined) assert.equal(res.data.error, error);
    return res.data;
  };
  async function register(server: Server, name: string) {
    const passkey = new SoftPasskey();
    const options = await server.call("/auth/register/options", { name });
    const verified = await server.call("/auth/register/verify", {
      flowId: options.data.flowId,
      response: passkey.create(options.data.options),
    });
    return { ...(expect(verified, 200) as { token: string; user: { id: string; name: string } }), passkey };
  }
  // A fresh sign-in (deleting an account needs one from the last 10 minutes).
  async function signIn(server: Server, passkey: SoftPasskey) {
    const options = await server.call("/auth/login/options", {});
    const verified = await server.call("/auth/login/verify", { flowId: options.data.flowId, response: passkey.get(options.data.options) });
    return expect(verified, 200).token as string;
  }

  const root = mkdtempSync(join(tmpdir(), "anthill-sites-"));
  const dir = join(root, "data");
  const logPath = join(dir, "log.jsonl");
  const logText = () => readFileSync(logPath, "utf8");
  const siteEntries = (text = logText()) =>
    text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "communitySite");
  try {
    let server = await boot(dir);
    const founder = await register(server, "Fern");
    const member = await register(server, "Milo");
    const outsider = await register(server, "Otis");
    for (const [id, visibility, joinPolicy] of [
      ["builders", "public", "open"],
      ["plain", "public", "open"],
      ["hidden", "private", "invite"],
    ]) {
      expect(await server.call("/communities", { id, name: id, visibility, joinPolicy }, founder.token), 200);
    }
    expect(await server.call("/c/builders/action", { fn: "joinTree", args: { name: "Milo", recipient: founder.user.id } }, member.token), 200);

    ////////////////////////////////////////////
    //// the defaults

    const DEFAULT = { pages: on("explore", "polls", "people"), accent: "indigo", hasAbout: false };
    {
      const { communities } = expect(await server.call("/communities", undefined, founder.token), 200);
      const by = new Map<string, any>(communities.map((c: any) => [c.id, c]));
      assert.deepEqual(by.get("builders").site, { ...DEFAULT, pages: on("explore", "polls", "people", "agents") });
      for (const id of ["plain", "hidden", "commons"]) assert.deepEqual(by.get(id).site, DEFAULT, id);
      assert.deepEqual(expect(await server.call("/c/builders/site"), 200), {
        site: { pages: on("explore", "polls", "people", "agents"), accent: "indigo", about: "" },
      });
      assert.deepEqual(expect(await server.call("/c/plain/site"), 200), {
        site: { pages: on("explore", "polls", "people"), accent: "indigo", about: "" },
      });
    }
    ok("without a saved site: every page (Agents only with a commons), indigo, no About");

    // a log from before sites, kept for the checks at the end
    const oldDir = join(root, "old");
    mkdirSync(oldDir);
    copyFileSync(logPath, join(oldDir, "log.jsonl"));
    const oldLog = readFileSync(join(oldDir, "log.jsonl"), "utf8");
    const oldList = expect(await server.call("/communities"), 200);
    const oldGraph = expect(await server.call("/c/builders/graph"), 200);

    ////////////////////////////////////////////
    //// validation

    const valid = { pages: on("explore"), accent: "teal", about: "" };
    const RECORD = "pages must say, for each of explore, polls, people, agents, true or false.";
    expect(await server.call("/c/plain/site", valid), 401);
    const before = logText();
    for (const [body, error] of [
      [{}, RECORD],
      [{ ...valid, pages: "explore" }, RECORD],
      [{ ...valid, pages: null }, RECORD],
      [{ ...valid, pages: { explore: true, polls: true } }, RECORD],
      [{ ...valid, pages: { ...on("explore"), people: "yes" } }, RECORD],
      [{ ...valid, pages: { ...on("explore"), polls: 1 } }, RECORD],
      [{ ...valid, pages: { ...on("explore"), home: true } }, `Unknown page home: ${RECORD}`],
      [{ ...valid, pages: on("agents") }, "This community has no agent commons, so it can't show an Agents page."],
      // (a list of the pages shown is taken too)
      [{ ...valid, pages: ["explore", "home"] }, RECORD],
      [{ ...valid, pages: ["you"] }, RECORD],
      [{ ...valid, pages: [1] }, RECORD],
      [{ ...valid, pages: ["polls", "polls"] }, "pages lists a page twice."],
      [{ ...valid, pages: ["agents"] }, "This community has no agent commons, so it can't show an Agents page."],
      [{ ...valid, accent: undefined }, "Choose an accent colour: indigo, blue, teal, green, amber, orange, rose, violet."],
      [{ ...valid, accent: "#ff0000" }, "Choose an accent colour: indigo, blue, teal, green, amber, orange, rose, violet."],
      [{ ...valid, accent: "Teal" }, "Choose an accent colour: indigo, blue, teal, green, amber, orange, rose, violet."],
      [{ ...valid, about: undefined }, "about must be text."],
      [{ ...valid, about: 42 }, "about must be text."],
      [{ ...valid, about: "a".repeat(MAX_ABOUT + 1) }, "The About can be at most 10,000 characters; this one has 10,001."],
      // counted as it's kept: NFC makes each of these two characters, so the
      // count is said (the editor counts the same way)
      [{ ...valid, about: "\u0958".repeat(6_000) }, "The About can be at most 10,000 characters; this one has 12,000."],
      [{ ...valid, css: "body{}" }, "Unknown field css: a site has pages, accent and about."],
      [{ ...valid, hidden: [] }, "Unknown field hidden: a site has pages, accent and about."],
    ] as const) {
      // (each counts against the limit, checked below)
      nextMinute();
      expect(await server.call("/c/plain/site", body, founder.token), 400, error);
    }
    nextMinute();
    expect(await server.call("/c/plain/site", [valid], founder.token), 400, "expected a JSON object");
    expect(await server.call("/c/plain/site", "not json", founder.token), 400, "expected a JSON body");
    expect(await server.call("/c/nowhere/site", valid, founder.token), 404);
    assert.equal(logText(), before, "a refused save is never logged");
    assert.equal(
      expect(await server.call("/c/plain/site", valid, founder.token), 200).community.site.accent,
      "teal",
    );
    // Agents may be left out where there's no commons; a list is read as the
    // pages shown
    const { agents: _, ...noAgents } = on("explore", "people");
    assert.deepEqual(
      expect(await server.call("/c/plain/site", { ...valid, pages: noAgents }, founder.token), 200).community.site.pages,
      on("explore", "people"),
    );
    nextMinute();
    assert.deepEqual(
      expect(await server.call("/c/plain/site", { ...valid, pages: ["people", "polls"] }, founder.token), 200).community.site.pages,
      on("polls", "people"),
    );
    expect(await server.call("/c/plain/site", valid, founder.token), 200);
    ok("a site is validated strictly, and only a valid one is logged");

    // control characters go, line breaks become \n; 10,000 is counted after
    // that, and leading spaces (code, in Markdown) stay
    const messy = "\n \n    code\r\nHello\u0000 world\u001b[1m\u0007\r\tok\u2028end \u200d\u{1F44D}\n\n\n  ";
    expect(await server.call("/c/plain/site", { ...valid, about: messy }, founder.token), 200);
    assert.equal(
      expect(await server.call("/c/plain/site"), 200).site.about,
      "    code\nHello world[1m\n\tok\nend \u200d\u{1F44D}",
    );
    const longest = `${"a".repeat(MAX_ABOUT)}\r\n\r\n\u0000`;
    expect(await server.call("/c/plain/site", { ...valid, about: longest }, founder.token), 200);
    assert.equal(expect(await server.call("/c/plain/site"), 200).site.about, "a".repeat(MAX_ABOUT));
    // nothing visible (zero-width spaces, a word joiner, a soft hyphen, a
    // variation selector, a Hangul filler) is no About, not an empty tab
    nextMinute();
    for (const invisible of ["\u200b\u2060", "\n\u00ad \u200d\n\ufe0f\u3164\t"]) {
      const { site } = expect(await server.call("/c/plain/site", { ...valid, about: invisible }, founder.token), 200).community;
      assert.equal(site.hasAbout, false, JSON.stringify(invisible));
      assert.equal(expect(await server.call("/c/plain/site"), 200).site.about, "");
    }
    ok("the About loses control characters but keeps its line breaks and tabs; one with nothing visible is none");

    ////////////////////////////////////////////
    //// saving, and who may

    nextMinute();
    const about = "# Builders\n\nWe build *things*.\n\n- one\n- two";
    const saved = expect(
      await server.call("/c/builders/site", { pages: on("people", "explore"), accent: "violet", about }, founder.token),
      200,
    ).community;
    assert.deepEqual(saved.site, { pages: on("explore", "people"), accent: "violet", hasAbout: true });
    assert.equal(saved.canChangeSettings, true);
    assert.deepEqual(expect(await server.call("/c/builders/site"), 200).site, { pages: on("explore", "people"), accent: "violet", about });
    assert.deepEqual(expect(await server.call("/c/builders"), 200).community.site, saved.site);
    assert.deepEqual(expect(await server.call("/c/builders/graph"), 200).community.site, saved.site);
    {
      const listed = expect(await server.call("/communities"), 200).communities.find((c: any) => c.id === "builders");
      assert.deepEqual(listed.site, saved.site);
      // the list carries no About text
      assert.ok(!JSON.stringify(listed).includes("We build"));
    }
    const builderEntries = siteEntries().filter((e) => e.id === "builders");
    assert.equal(builderEntries.length, 1);
    // the pages it could choose are what's logged (see site.ts)
    assert.deepEqual(builderEntries[0].site, { pages: on("explore", "people"), accent: "violet", about });
    assert.equal(builderEntries[0].by, founder.user.id);
    // the same again isn't logged
    const count = siteEntries().length;
    expect(await server.call("/c/builders/site", { pages: on("explore", "people"), accent: "violet", about }, founder.token), 200);
    assert.equal(siteEntries().length, count);
    ok("the founder saves a site: in every summary, unchanged saves not logged");

    // a member, an outsider: refused, and nothing logged
    const memberView = expect(await server.call("/c/builders", undefined, member.token), 200).community;
    assert.equal(memberView.canChangeSettings, false);
    const tryIt = { pages: on("explore"), accent: "rose", about: "mine now" };
    expect(await server.call("/c/builders/site", tryIt, member.token), 400, "Only the founder can change the community's site.");
    expect(await server.call("/c/builders/site", tryIt, outsider.token), 400, "Only the founder can change the community's site.");
    // invalid too: who may is decided first, so nothing about the rules leaks
    expect(await server.call("/c/builders/site", {}, member.token), 400, "Only the founder can change the community's site.");
    expect(await server.call("/c/hidden/site", tryIt, outsider.token), 404);
    assert.equal(siteEntries().length, count);
    ok("only the founder: a member or an outsider is refused (a private community is a 404)");

    // the commons on a fresh data dir has no founder: nobody, until someone
    // starts its tree; then its root, and only its root
    expect(
      await server.call("/c/commons/site", tryIt, founder.token),
      400,
      "Only the root of the tree can change the site of a community without a founder.",
    );
    expect(await server.call("/c/commons/action", { fn: "joinTreeAsRoot", args: { name: "Fern" } }, founder.token), 200);
    expect(await server.call("/c/commons/action", { fn: "joinTree", args: { name: "Milo", recipient: founder.user.id } }, member.token), 200);
    expect(
      await server.call("/c/commons/site", tryIt, member.token),
      400,
      "Only the root of the tree can change the site of a community without a founder.",
    );
    assert.equal(expect(await server.call("/c/commons/site", tryIt, founder.token), 200).community.site.accent, "rose");
    ok("a founderless community's root saves its site, nobody else (nobody while it's empty)");

    // the limit per account: 10 saves a minute (unchanged ones count too)
    nextMinute();
    for (let i = 0; i < 10; i++) {
      expect(await server.call("/c/plain/site", { ...valid, about: `try ${i}` }, founder.token), 200);
    }
    expect(await server.call("/c/plain/site", valid, founder.token), 429);
    // someone else isn't held up by it
    expect(await server.call("/c/commons/site", tryIt, member.token), 400);
    nextMinute();
    ok("saves are limited per account");

    ////////////////////////////////////////////
    //// a private community's site

    const secret = { pages: on("explore", "people"), accent: "amber", about: "Members only: the meeting is on Tuesday." };
    expect(await server.call("/c/hidden/site", secret, founder.token), 200);
    expect(await server.call("/c/hidden/site"), 404);
    expect(await server.call("/c/hidden/site", undefined, outsider.token), 404);
    expect(await server.call("/c/hidden", undefined, outsider.token), 404);
    {
      const listed = expect(await server.call("/communities", undefined, outsider.token), 200).communities;
      assert.ok(!listed.some((c: any) => c.id === "hidden"));
    }
    // whoever holds an invite sees the default site, not this one
    const { code } = expect(await server.call("/c/hidden/invites", {}, founder.token), 200);
    const preview = expect(await server.call(`/invites/${code}`, undefined, outsider.token), 200);
    assert.deepEqual(preview.community.site, DEFAULT);
    assert.ok(!JSON.stringify(preview).includes("Tuesday"));
    assert.deepEqual(expect(await server.call(`/invites/${code}`, undefined, founder.token), 200).community.site, {
      pages: on("explore", "people"),
      accent: "amber",
      hasAbout: true,
    });
    assert.equal(expect(await server.call("/c/hidden/site", undefined, founder.token), 200).site.about, secret.about);
    ok("a private community's site is for its members: a 404 to outsiders, the defaults in an invite's preview");

    ////////////////////////////////////////////
    //// export

    {
      const exported = expect(await server.call("/auth/export", undefined, founder.token), 200);
      const mine = exported.log.filter((e: any) => e.type === "communitySite");
      assert.deepEqual(
        mine.map((e: any) => e.id),
        siteEntries()
          .filter((e) => e.by === founder.user.id)
          .map((e) => e.id),
      );
      assert.ok(mine.length > 0 && mine.every((e: any) => e.by === founder.user.id));
      const theirs = expect(await server.call("/auth/export", undefined, member.token), 200);
      assert.equal(theirs.log.filter((e: any) => e.type === "communitySite").length, 0);
    }
    ok("the export has the site entries the account saved, and nobody else's");

    ////////////////////////////////////////////
    //// a deleted founder's site stays the community's

    expect(await server.call("/auth/delete", { confirm: "Fern" }, await signIn(server, founder.passkey)), 200);
    // and nothing more is saved by the account
    expect(await server.call("/c/plain/site", valid, founder.token), 401);
    {
      const builders = expect(await server.call("/c/builders", undefined, member.token), 200).community;
      assert.equal(builders.founder, null);
      assert.equal(builders.canChangeSettings, true, "Milo is the root now");
      assert.deepEqual(builders.site, saved.site);
      assert.equal(expect(await server.call("/c/builders/site"), 200).site.about, about);
    }
    expect(
      await server.call("/c/builders/site", tryIt, outsider.token),
      400,
      "Only the root of the tree can change the site of a community without a founder.",
    );
    const milos = { pages: on("explore", "polls", "people", "agents"), accent: "green", about: "Milo looks after this now." };
    expect(await server.call("/c/builders/site", milos, member.token), 200);
    {
      const exported = expect(await server.call("/auth/export", undefined, member.token), 200);
      assert.deepEqual(
        exported.log.filter((e: any) => e.type === "communitySite").map((e: any) => e.id),
        ["builders"],
      );
    }
    ok("deleting the founder's account keeps the site; the new root changes it");

    ////////////////////////////////////////////
    //// replay

    const shown = async (s: Server) => {
      const out: Record<string, unknown> = {};
      for (const id of ["builders", "plain", "commons"]) out[id] = expect(await s.call(`/c/${id}/site`), 200).site;
      return out;
    };
    const live = await shown(server);
    const liveList = expect(await server.call("/communities"), 200);
    // "hidden" is seen by nobody now (its founder, alone in it, is gone)
    const hiddenSite = new Store(dir).site("hidden");
    // (no commons: Agents isn't one of its pages)
    assert.deepEqual(hiddenSite, { pages: { explore: true, polls: false, people: true }, accent: "amber", about: secret.about });
    const logNow = logText();
    server = await boot(dir);
    assert.equal(logText(), logNow, "starting writes nothing");
    assert.deepEqual(await shown(server), live);
    assert.deepEqual(live.builders, milos);
    assert.deepEqual(expect(await server.call("/communities"), 200), liveList);
    assert.deepEqual(new Store(dir).site("hidden"), hiddenSite);
    ok("sites replay the same after a restart");

    // the operator takes the commons away: no Agents page, and none can be
    // saved; gives "plain" one: its Agents page shows, as it never turned it off
    server = await boot(dir, null);
    assert.deepEqual(expect(await server.call("/c/builders/site"), 200).site.pages, on("explore", "polls", "people"));
    expect(
      await server.call("/c/builders/site", milos, member.token),
      400,
      "This community has no agent commons, so it can't show an Agents page.",
    );
    server = await boot(dir, JSON.stringify({ plain: { coordinator: "https://coordinator.test", site: "https://commons.test" } }));
    assert.deepEqual(expect(await server.call("/c/plain/site"), 200).site.pages, on("explore", "agents"));
    assert.equal(logText(), logNow);
    ok("the Agents page follows the operator's commons; a page the site couldn't choose is on");

    // A community that turned Agents off, saving while its commons is away
    // for a while (the editor then sends agents: false, or leaves it out):
    // the choice is kept, so Agents stays off when the commons comes back;
    // the same save again isn't logged
    server = await boot(dir);
    nextMinute();
    expect(await server.call("/c/builders/site", { ...milos, pages: on("explore", "polls", "people") }, member.token), 200);
    server = await boot(dir, null);
    for (const [pages, about] of [
      [on("explore", "people"), "Away for a while."],
      [{ explore: true, polls: true, people: true }, "Back soon."],
    ] as const) {
      expect(await server.call("/c/builders/site", { ...milos, pages, about }, member.token), 200);
      assert.equal(new Store(dir).site("builders")?.pages.agents, false);
    }
    const awayCount = siteEntries().length;
    expect(await server.call("/c/builders/site", { ...milos, pages: on("explore", "polls", "people"), about: "Back soon." }, member.token), 200);
    assert.equal(siteEntries().length, awayCount);
    server = await boot(dir);
    assert.deepEqual(expect(await server.call("/c/builders/site"), 200).site, {
      ...milos,
      pages: on("explore", "polls", "people"),
      about: "Back soon.",
    });
    ok("a save while the commons is away keeps the Agents choice");

    ////////////////////////////////////////////
    //// older logs

    // one from before sites starts unchanged and serves what it did, with the
    // default sites
    const old = await boot(oldDir);
    assert.equal(readFileSync(join(oldDir, "log.jsonl"), "utf8"), oldLog);
    assert.deepEqual(expect(await old.call("/communities"), 200), oldList);
    // (but its version, which counts rebuilds, and a start rebuilds)
    assert.deepEqual({ ...expect(await old.call("/c/builders/graph"), 200), version: 0 }, { ...oldGraph, version: 0 });
    ok("a log from before sites replays as it did");

    // what a newer version might write: an entry type this code doesn't
    // know is skipped (as code from before sites skips communitySite), a
    // page or accent it doesn't know, or a site in a shape it can't read,
    // shows as the default, a site for a community that doesn't exist is
    // dropped
    const newerDir = join(root, "newer");
    mkdirSync(newerDir);
    copyFileSync(join(oldDir, "log.jsonl"), join(newerDir, "log.jsonl"));
    const at = new Date(Date.now()).toISOString();
    appendFileSync(
      join(newerDir, "log.jsonl"),
      [
        { type: "communityTheme", at, id: "plain", by: member.user.id, theme: { font: "serif" } },
        {
          type: "communitySite",
          at,
          id: "plain",
          by: member.user.id,
          site: { pages: { explore: true, polls: false, people: true, gallery: true, agents: "maybe" }, accent: "chartreuse", about: "Hi" },
        },
        { type: "communitySite", at, id: "gone", by: member.user.id, site: { pages: {}, accent: "rose", about: "" } },
        { type: "communitySite", at, id: "builders", by: member.user.id, site: { pages: ["explore"], accent: 7, layout: "wide" } },
      ]
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(""),
    );
    const store = new Store(newerDir);
    assert.equal(store.site("gone"), undefined);
    const newer = await boot(newerDir);
    assert.deepEqual(expect(await newer.call("/c/plain/site"), 200).site, { pages: on("explore", "people"), accent: "indigo", about: "Hi" });
    assert.deepEqual(expect(await newer.call("/c/builders/site"), 200).site, {
      pages: on("explore", "polls", "people", "agents"),
      accent: "indigo",
      about: "",
    });
    ok("unknown entry types, pages and accents from a newer version are ignored");

    ////////////////////////////////////////////
    //// the daily budget

    // 50 logged changes a day per account, and per community, settings and
    // site together (each is kept in the log for good). Refused saves and
    // unchanged ones take nothing; whoever may not change the community is
    // refused as before, not told its budget is spent.
    {
      nextDay();
      const budgetDir = join(root, "budget");
      const s = await boot(budgetDir);
      const ana = await register(s, "Ana");
      const bo = await register(s, "Bo");
      for (const id of ["daily", "other"]) {
        expect(await s.call("/communities", { id, name: id, visibility: "public", joinPolicy: "open" }, id === "daily" ? ana.token : bo.token), 200);
      }
      expect(await s.call("/c/daily/action", { fn: "joinTree", args: { name: "Bo", recipient: ana.user.id } }, bo.token), 200);
      const site = (i: number) => ({ pages: on("explore"), accent: i % 4 === 0 ? "teal" : "rose", about: "Same text." });
      const settings = (i: number) => ({ name: `Daily ${i}`, visibility: "public", joinPolicy: "open" });
      const entries = () => readFileSync(join(budgetDir, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length;
      for (let i = 0; i < 50; i++) {
        if (i % 5 === 0) nextMinute();
        // refused and unchanged saves on the way take nothing
        if (i % 10 === 0) {
          expect(await s.call("/c/daily/site", { ...site(i), accent: "puce" }, ana.token), 400);
          if (i > 0) expect(await s.call("/c/daily/site", site(i - 2), ana.token), 200);
        }
        const logged = entries();
        if (i % 2 === 0) expect(await s.call("/c/daily/site", site(i), ana.token), 200);
        else expect(await s.call("/c/daily/settings", settings(i), ana.token), 200);
        assert.equal(entries(), logged + 1, `save ${i} is logged`);
      }
      nextMinute();
      expect(await s.call("/c/daily/site", site(50), ana.token), 429);
      expect(await s.call("/c/daily/settings", settings(50), ana.token), 429);
      // a member is refused for not being the founder, as ever
      expect(await s.call("/c/daily/site", site(50), bo.token), 400, "Only the founder can change the community's site.");
      // Bo's own budget, and his community's, are untouched
      expect(await s.call("/c/other/site", site(1), bo.token), 200);
      // the community's budget stays spent when someone else looks after it:
      // Ana deletes her account, Bo is its root now
      expect(await s.call("/auth/delete", { confirm: "Ana" }, await signIn(s, ana.passkey)), 200);
      assert.equal(expect(await s.call("/c/daily", undefined, bo.token), 200).community.canChangeSettings, true);
      const spent = entries();
      expect(await s.call("/c/daily/site", site(51), bo.token), 429);
      expect(await s.call("/c/daily/settings", settings(51), bo.token), 429);
      assert.equal(entries(), spent, "nothing past the budget is logged");
      // a day later there's room again
      nextDay();
      expect(await s.call("/c/daily/site", site(52), bo.token), 200);
      expect(await s.call("/c/daily/settings", settings(52), bo.token), 200);
    }
    ok("changes to settings and sites have a daily budget per account and per community");
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
