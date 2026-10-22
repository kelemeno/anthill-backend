// Append-only log that is the off-chain source of truth. Each line of
// <DATA_DIR>/log.jsonl is one entry: the seed graph, a passkey registration, a
// passkey counter update, or a tree action. On startup the engine state is
// rebuilt by replaying the seed and the actions in order.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SeedGraph } from "./engine";

export type StoredUser = { id: string; name: string };

export type StoredPasskey = {
  id: string;
  userId: string;
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
};

export type Action =
  | { fn: "joinTree"; args: { name: string; recipient: string } }
  | { fn: "joinTreeAsRoot"; args: { name: string } }
  | { fn: "changeName"; args: { name: string } }
  | { fn: "addDagVote"; args: { recipient: string; weight: string } }
  | { fn: "removeDagVote"; args: { recipient: string } }
  | { fn: "leaveTree"; args: Record<string, never> }
  | { fn: "switchPositionWithParent"; args: Record<string, never> }
  | { fn: "moveTreeVote"; args: { recipient: string } };

export type ActionEntry = { type: "action"; at: string; by: string; action: Action };

type Entry =
  | { type: "seed"; at: string; graph: SeedGraph }
  | { type: "passkey"; at: string; user: StoredUser; passkey: StoredPasskey }
  | { type: "counter"; at: string; id: string; counter: number }
  | ActionEntry;

export class Store {
  private logPath: string;
  private secretPath: string;
  private users = new Map<string, StoredUser>();
  private passkeys = new Map<string, StoredPasskey>();
  private seedGraph: SeedGraph | undefined;
  private actionEntries: ActionEntry[] = [];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "log.jsonl");
    this.secretPath = join(dir, "session-secret");

    if (!existsSync(this.logPath)) {
      return;
    }
    for (const line of readFileSync(this.logPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.apply(JSON.parse(line, bigintReviver) as Entry);
    }
  }

  get seed() {
    return this.seedGraph;
  }

  get actions(): readonly ActionEntry[] {
    return this.actionEntries;
  }

  setSeed(graph: SeedGraph) {
    if (this.seedGraph !== undefined || this.actionEntries.length > 0) {
      throw new Error("the log already has a seed or actions");
    }
    this.append({ type: "seed", at: now(), graph });
  }

  appendAction(by: string, action: Action): ActionEntry {
    const entry: ActionEntry = { type: "action", at: now(), by, action };
    this.append(entry);
    return entry;
  }

  user(id: string) {
    return this.users.get(id);
  }

  passkey(id: string) {
    return this.passkeys.get(id);
  }

  addPasskey(user: StoredUser, passkey: StoredPasskey) {
    this.append({ type: "passkey", at: now(), user, passkey });
  }

  setPasskeyCounter(id: string, counter: number) {
    if (this.passkeys.get(id)?.counter === counter) return;
    this.append({ type: "counter", at: now(), id, counter });
  }

  renameUser(id: string, name: string) {
    const user = this.users.get(id);
    if (user !== undefined) user.name = name;
  }

  sessionSecret(generate: () => string): string {
    if (!existsSync(this.secretPath)) {
      writeFileSync(this.secretPath, generate(), { mode: 0o600 });
    }
    return readFileSync(this.secretPath, "utf8").trim();
  }

  private append(entry: Entry) {
    appendFileSync(this.logPath, `${JSON.stringify(entry, bigintReplacer)}\n`);
    this.apply(entry);
  }

  private apply(entry: Entry) {
    switch (entry.type) {
      case "seed":
        this.seedGraph = entry.graph;
        break;
      case "passkey":
        this.users.set(entry.user.id, { ...entry.user });
        this.passkeys.set(entry.passkey.id, { ...entry.passkey });
        break;
      case "counter": {
        const passkey = this.passkeys.get(entry.id);
        if (passkey !== undefined) passkey.counter = entry.counter;
        break;
      }
      case "action":
        this.actionEntries.push(entry);
        if (entry.action.fn === "changeName" || entry.action.fn === "joinTree") {
          this.renameUser(entry.by, entry.action.args.name);
        }
        break;
    }
  }
}

function now() {
  return new Date().toISOString();
}

// JSON (de)serialisation that survives bigints, same encoding as the snapshot.
export function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? { __bigint__: value.toString() } : value;
}

export function bigintReviver(_key: string, value: unknown) {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint__" in value &&
    typeof (value as { __bigint__: unknown }).__bigint__ === "string"
  ) {
    return BigInt((value as { __bigint__: string }).__bigint__);
  }
  return value;
}
