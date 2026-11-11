// Polls weighted by reputation, and short member profiles. Both live in the
// append-only log next to the tree actions.
//
// Polls belong to a community: only its members create and vote in them, and a
// poll's weight per option is the sum of its voters' current reputation there,
// so open polls move as reputation changes; closing a poll freezes the tally.
// Only current members' votes count: someone who left (and came back) votes
// again. Its creator closes a poll, or once the creator has left the founder
// (the tree's root in a community without one, e.g. a fresh commons).
// Profiles belong to the account and show in every community.

import { randomBytes } from "node:crypto";
import { ActionError } from "./offchain";
import type { Poll, Profile, Store } from "./store";

const MAX_QUESTION = 200;
const MAX_OPTION = 80;
const MAX_BIO = 280;
const MAX_LINK = 200;
// Polls are kept forever and listed whole: a cap on each member's open ones,
// on the community's open ones, and on all it ever had.
const MAX_OPEN_POLLS_PER_MEMBER = 5;
const MAX_OPEN_POLLS = 30;
const MAX_POLLS = 500;

export type PollView = {
  id: string;
  by: string;
  byName: string;
  question: string;
  options: string[];
  createdAt: string;
  closedAt?: string;
  // per option: total reputation (as a decimal string, 18 decimals) and voters
  tally: { weight: string; voters: number }[];
  myVote?: number;
  // whether the viewer may close it
  canClose: boolean;
};

// One community's polls.
export class Polls {
  constructor(
    private store: Store,
    private community: string,
    private isMember: (id: string) => boolean,
    private reputationOf: (id: string) => bigint,
    // who closes polls whose creator left: the community's founder, or its
    // root without one ("" or address0 when there's nobody)
    private steward: () => string,
  ) {}

  listPolls(viewer?: string): PollView[] {
    return this.store
      .polls(this.community)
      .map((poll) => this.view(poll, viewer))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  createPoll(by: string, body: unknown): PollView {
    this.requireMember(by, "create polls");
    const { question, options } = (body ?? {}) as { question?: unknown; options?: unknown };
    if (
      typeof question !== "string" ||
      question.trim() === "" ||
      question.trim().length > MAX_QUESTION
    ) {
      throw new ActionError(`The question must be 1-${MAX_QUESTION} characters.`);
    }
    if (!Array.isArray(options)) {
      throw new ActionError("A poll needs 2-6 options.");
    }
    const cleaned = options.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (
      cleaned.length < 2 ||
      cleaned.length > 6 ||
      cleaned.some((o) => o === "" || o.length > MAX_OPTION) ||
      new Set(cleaned).size !== cleaned.length
    ) {
      throw new ActionError(
        `A poll needs 2-6 different options of 1-${MAX_OPTION} characters each.`,
      );
    }
    const all = this.store.polls(this.community);
    const open = all.filter((p) => p.closed === undefined);
    if (open.filter((p) => p.by === by).length >= MAX_OPEN_POLLS_PER_MEMBER) {
      throw new ActionError(
        `You already have ${MAX_OPEN_POLLS_PER_MEMBER} open polls here. Close one before you ask again.`,
      );
    }
    if (open.length >= MAX_OPEN_POLLS) {
      throw new ActionError(`This community already has ${MAX_OPEN_POLLS} open polls. Wait until some close.`);
    }
    if (all.length >= MAX_POLLS) {
      throw new ActionError(`This community has reached its ${MAX_POLLS} polls.`);
    }
    const id = randomBytes(8).toString("hex");
    this.store.addPoll(this.community, id, by, question.trim(), cleaned);
    return this.view(this.store.poll(id)!, by);
  }

  votePoll(by: string, pollId: string, body: unknown): PollView {
    this.requireMember(by, "vote in polls");
    const poll = this.openPoll(pollId);
    const { option } = (body ?? {}) as { option?: unknown };
    if (
      typeof option !== "number" ||
      !Number.isInteger(option) ||
      option < 0 ||
      option >= poll.options.length
    ) {
      throw new ActionError("Pick one of the poll's options.");
    }
    // the same vote again changes nothing (and isn't logged)
    if (this.voteOf(poll, by) !== option) this.store.votePoll(poll.id, by, option);
    return this.view(poll, by);
  }

  closePoll(by: string, pollId: string): PollView {
    const poll = this.openPoll(pollId);
    if (!this.mayClose(poll, by)) {
      throw new ActionError(
        "Only the person who created a poll can close it (or, once they've left, the community's founder).",
      );
    }
    const tally = this.liveTally(poll);
    this.store.closePoll(
      poll.id,
      tally.map((t) => t.weight.toString()),
      tally.map((t) => t.voters),
    );
    return this.view(poll, by);
  }

  private mayClose(poll: Poll, by: string) {
    if (by === poll.by) return true;
    const steward = this.steward();
    return steward !== "" && by === steward && !this.isMember(poll.by);
  }

  // The option `voter` picked, if their vote counts: they're a member, and
  // voted since they last joined (a vote from before they left doesn't come
  // back with them).
  private voteOf(poll: Poll, voter: string): number | undefined {
    const option = poll.votes.get(voter);
    if (option === undefined || !this.isMember(voter)) return undefined;
    const joined = this.store.joinedAt(this.community, voter);
    if (joined !== undefined && (poll.votedAt.get(voter) ?? "") < joined) return undefined;
    return option;
  }

  private openPoll(pollId: string): Poll {
    const poll = this.store.poll(pollId);
    if (poll === undefined || this.store.communityOf(poll) !== this.community) {
      throw new ActionError("That poll doesn't exist.");
    }
    if (poll.closed !== undefined) throw new ActionError("That poll is closed.");
    return poll;
  }

  private liveTally(poll: Poll) {
    const tally = poll.options.map(() => ({ weight: 0n, voters: 0 }));
    for (const voter of poll.votes.keys()) {
      const option = this.voteOf(poll, voter);
      if (option === undefined) continue;
      tally[option].weight += this.reputationOf(voter);
      tally[option].voters += 1;
    }
    return tally;
  }

  private view(poll: Poll, viewer?: string): PollView {
    const { closed } = poll;
    // closed before the voter counts were logged: every vote it had
    const allVoters = (i: number) => [...poll.votes.values()].filter((o) => o === i).length;
    const tally =
      closed !== undefined
        ? closed.tally.map((weight, i) => ({ weight, voters: closed.voters?.[i] ?? allVoters(i) }))
        : this.liveTally(poll).map((t) => ({ weight: t.weight.toString(), voters: t.voters }));
    return {
      id: poll.id,
      by: poll.by,
      byName: this.store.user(poll.by)?.name ?? "",
      question: poll.question,
      options: poll.options,
      createdAt: poll.at,
      closedAt: poll.closed?.at,
      tally,
      myVote:
        viewer === undefined ? undefined : closed !== undefined ? poll.votes.get(viewer) : this.voteOf(poll, viewer),
      canClose: viewer !== undefined && closed === undefined && this.mayClose(poll, viewer),
    };
  }

  private requireMember(id: string, what: string) {
    if (!this.isMember(id)) {
      throw new ActionError(`Join the community first to ${what}.`);
    }
  }
}

// Sets the profile; `changed` is false (and nothing is logged) when it was
// already this.
export function setProfile(
  store: Store,
  userId: string,
  body: unknown,
): { profile: Profile; changed: boolean } {
  const { bio = "", link = "" } = (body ?? {}) as { bio?: unknown; link?: unknown };
  if (typeof bio !== "string" || bio.trim().length > MAX_BIO) {
    throw new ActionError(`The bio can be at most ${MAX_BIO} characters.`);
  }
  if (typeof link !== "string" || link.trim().length > MAX_LINK) {
    throw new ActionError(`The link can be at most ${MAX_LINK} characters.`);
  }
  const trimmedLink = link.trim();
  if (trimmedLink !== "") {
    let url: URL;
    try {
      url = new URL(trimmedLink);
    } catch {
      throw new ActionError("The link must be a full web address, like https://example.com.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ActionError("The link must start with https://.");
    }
  }
  const profile = { bio: bio.trim(), link: trimmedLink };
  const before = store.profile(userId) ?? { bio: "", link: "" };
  if (before.bio === profile.bio && before.link === profile.link) return { profile, changed: false };
  store.setProfile(userId, profile);
  return { profile, changed: true };
}
