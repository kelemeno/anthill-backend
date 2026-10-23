// Polls weighted by reputation, and short member profiles. Both live in the
// append-only log next to the tree actions.
//
// Polls belong to a community: only its members create and vote in them, and a
// poll's weight per option is the sum of its voters' current reputation there,
// so open polls move as reputation changes; closing a poll freezes the tally.
// Profiles belong to the account and show in every community.

import { randomBytes } from "node:crypto";
import { ActionError } from "./offchain";
import type { Poll, Profile, Store } from "./store";

const MAX_QUESTION = 200;
const MAX_OPTION = 80;
const MAX_BIO = 280;
const MAX_LINK = 200;

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
};

// One community's polls.
export class Polls {
  constructor(
    private store: Store,
    private community: string,
    private isMember: (id: string) => boolean,
    private reputationOf: (id: string) => bigint,
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
    this.store.votePoll(poll.id, by, option);
    return this.view(poll, by);
  }

  closePoll(by: string, pollId: string): PollView {
    const poll = this.openPoll(pollId);
    if (poll.by !== by) {
      throw new ActionError("Only the person who created a poll can close it.");
    }
    this.store.closePoll(
      poll.id,
      this.liveTally(poll).map((t) => t.weight.toString()),
    );
    return this.view(poll, by);
  }

  private openPoll(pollId: string): Poll {
    const poll = this.store.poll(pollId);
    if (poll === undefined || poll.community !== this.community) {
      throw new ActionError("That poll doesn't exist.");
    }
    if (poll.closed !== undefined) throw new ActionError("That poll is closed.");
    return poll;
  }

  private liveTally(poll: Poll) {
    const tally = poll.options.map(() => ({ weight: 0n, voters: 0 }));
    for (const [voter, option] of poll.votes) {
      tally[option].weight += this.reputationOf(voter);
      tally[option].voters += 1;
    }
    return tally;
  }

  private view(poll: Poll, viewer?: string): PollView {
    const live = this.liveTally(poll);
    const tally = live.map((t, i) => ({
      weight: poll.closed !== undefined ? poll.closed.tally[i] : t.weight.toString(),
      voters: t.voters,
    }));
    return {
      id: poll.id,
      by: poll.by,
      byName: this.store.user(poll.by)?.name ?? "",
      question: poll.question,
      options: poll.options,
      createdAt: poll.at,
      closedAt: poll.closed?.at,
      tally,
      myVote: viewer === undefined ? undefined : poll.votes.get(viewer),
    };
  }

  private requireMember(id: string, what: string) {
    if (!this.isMember(id)) {
      throw new ActionError(`Join the community first to ${what}.`);
    }
  }
}

export function setProfile(store: Store, userId: string, body: unknown): Profile {
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
  store.setProfile(userId, profile);
  return profile;
}
