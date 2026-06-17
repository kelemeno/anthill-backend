import {
  type Address,
  createPublicClient,
  defineChain,
  type GetContractReturnType,
  getContract,
  http,
  type PublicClient,
  type Transport,
  webSocket,
} from "viem";
import { anthillAbi } from "./anthillAbi";

export { anthillAbi };

// Local anvil chain pinned to id 1337 (used for the testing branch).
export const anvil1337 = defineChain({
  id: 1337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["http://localhost:8545"],
      webSocket: ["ws://localhost:8545"],
    },
  },
});

export function makeTransport(providerURL: string): Transport {
  if (providerURL.startsWith("ws://") || providerURL.startsWith("wss://")) {
    return webSocket(providerURL);
  }
  return http(providerURL);
}

export function makePublicClient(providerURL: string): PublicClient {
  return createPublicClient({
    chain: anvil1337,
    transport: makeTransport(providerURL),
  });
}

export function makeAnthillContract(address: Address, client: PublicClient) {
  return getContract({
    address,
    abi: anthillAbi,
    client,
  });
}

export type AnthillContractType = ReturnType<typeof makeAnthillContract>;
