// For trying the signed-in UI locally without a real passkey prompt: registers
// a test account on a local backend with a software passkey, joins it under a
// random leaf, and prints the session to put in the browser's localStorage
// ("anthill.session"). Local development only.
//
//   npx tsx scripts/devSession.ts "Test User"     # BACKEND=http://localhost:5001/

import { SoftPasskey } from "./softPasskey";

const backend = process.env.BACKEND || "http://localhost:5001/";
const name = process.argv[2] || "Dev User";

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(backend + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

async function main() {
  const passkey = new SoftPasskey();
  const options = await post("auth/register/options", { name });
  const session = await post("auth/register/verify", {
    flowId: options.flowId,
    response: passkey.create(options.options),
  });
  const leaf = (await (await fetch(`${backend}c/commons/graph`)).json()).randomLeaf;
  await post("c/commons/action", { fn: "joinTree", args: { name, recipient: leaf } }, session.token);
  console.log(JSON.stringify({ token: session.token, user: session.user }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
