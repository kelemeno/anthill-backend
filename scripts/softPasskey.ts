// A minimal software platform authenticator holding one passkey (P-256,
// "none" attestation), for driving the backend's passkey endpoints from scripts
// the way a browser would. Test use only.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const origin = process.env.ORIGIN || "http://localhost:5173";
const rpID = "localhost";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftPasskey {
  private keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credentialId = randomBytes(16);
  private counter = 0;
  userHandle = "";

  private authData(flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter++);
    return Buffer.concat([sha256(rpID), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(options: any) {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(0x45, attested)],
      ]) as any,
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(options: any) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const authenticatorData = this.authData(0x05);
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.keys.privateKey,
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

