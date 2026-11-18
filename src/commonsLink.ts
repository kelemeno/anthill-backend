// What Anthill signs for an agent commons (github.com/kelemeno/agent-commons)
// linked to one of its communities. The commons is a separate app with its own
// ledger; it takes two things from Anthill:
//
// - the community's tree, signed, which the commons pins in its ledger and
//   draws reviewers over (people far apart in the tree review each other);
// - attestations that a commons signing key belongs to a member, so members
//   join the commons as themselves, with their Anthill user id.
//
// Both are ed25519 signatures over domain-separated canonical JSON. The
// commons checks them in src/anthill.ts and src/ledger.ts; the message format
// here must match its treeMessage and ownerMessage byte for byte.
//
// The signing key is ANTHILL_SIGNING_KEY (an ed25519 PKCS8 DER key, base64url)
// or, without it, one generated once and kept in the data folder. A commons
// records the public key (GET /commons/key) when it is created, so replacing
// the key cuts every linked commons off until it is re-linked: keep the file.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { address1 } from "./engine";
import type { OffchainTree } from "./offchain";

export const TREE_DOMAIN = "anthill-commons/tree/v1";
export const OWNER_DOMAIN = "anthill-commons/owner/v1";

export type TreeSnapshot = {
  community: string;
  version: number;
  at: string;
  parents: Record<string, string | null>;
};

export type OwnerAttestation = {
  community: string;
  user: string;
  publicKey: string;
  at: string;
};

// Deterministic JSON, as the commons' crypto.canonical: object keys sorted, no
// whitespace. Only what these messages hold (strings, integers, null, plain
// objects) is accepted.
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonical: ${value} is not a safe integer`);
    return JSON.stringify(value);
  }
  if (typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonical: cannot encode ${typeof value}`);
}

export const treeMessage = (s: TreeSnapshot) => `${TREE_DOMAIN}\n${canonical(s)}`;
export const ownerMessage = (a: OwnerAttestation) => `${OWNER_DOMAIN}\n${canonical(a)}`;

export class CommonsSigner {
  private key: KeyObject;
  readonly publicKey: string; // base64url SPKI DER, as the commons stores keys

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    let der: string;
    if (env.ANTHILL_SIGNING_KEY) {
      der = env.ANTHILL_SIGNING_KEY.trim();
    } else {
      const path = join(dataDir, "commons-signing-key");
      if (!existsSync(path)) {
        const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "der" }, publicKeyEncoding: { type: "spki", format: "der" } });
        writeFileSync(path, privateKey.toString("base64url"), { mode: 0o600 });
      }
      der = readFileSync(path, "utf8").trim();
    }
    this.key = createPrivateKey({ key: Buffer.from(der, "base64url"), format: "der", type: "pkcs8" });
    if (this.key.asymmetricKeyType !== "ed25519") throw new Error("ANTHILL_SIGNING_KEY is not an ed25519 key");
    this.publicKey = createPublicKey(this.key).export({ type: "spki", format: "der" }).toString("base64url");
  }

  // The community's tree: every member the root reaches, under its parent, the
  // root under null. `version` is the community's count of history steps,
  // which grows with every action (and survives restarts, being rebuilt from
  // the log).
  tree(tree: OffchainTree, version: number, at: string): { snapshot: TreeSnapshot; signature: string } {
    const parents: Record<string, string | null> = {};
    for (const id of tree.engine.members()) {
      if (!tree.isMember(id)) continue;
      const parent = tree.engine.parent(id);
      parents[id] = parent === address1 ? null : parent;
    }
    const snapshot: TreeSnapshot = { community: tree.id, version, at, parents };
    return { snapshot, signature: this.sign(treeMessage(snapshot)) };
  }

  owner(community: string, user: string, publicKey: string, at: string): { attestation: OwnerAttestation; signature: string } {
    const attestation: OwnerAttestation = { community, user, publicKey, at };
    return { attestation, signature: this.sign(ownerMessage(attestation)) };
  }

  private sign(message: string): string {
    return sign(null, Buffer.from(message, "utf8"), this.key).toString("base64url");
  }
}

// True for an ed25519 public key in the commons' one spelling (base64url SPKI
// DER). The commons refuses any other spelling, so Anthill does too, rather
// than vouch for a key the commons would then turn away.
export function isCommonsPublicKey(v: unknown): v is string {
  if (typeof v !== "string" || v === "" || v.length > 200) return false;
  try {
    const der = Buffer.from(v, "base64url");
    if (der.toString("base64url") !== v) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "der" }).toString("base64url") === v;
  } catch {
    return false;
  }
}
