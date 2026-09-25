import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

if (!process.env.ARCHIVE_RPC_URL) {
  throw new Error("ARCHIVE_RPC_URL missing from .env");
}

export const archive = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ARCHIVE_RPC_URL),
});

export const fork = createPublicClient({
  chain: mainnet,
  transport: http("http://127.0.0.1:8545"),
});