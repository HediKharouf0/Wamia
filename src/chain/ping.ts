import { archive, fork } from "./client.js";

async function main() {
  const archiveBlock = await archive.getBlockNumber();
  console.log("archive block:", archiveBlock);

  try {
    const forkBlock = await fork.getBlockNumber();
    console.log("fork block:", forkBlock);
  } catch (e) {
    console.log("fork not reachable (is anvil running on :8545?)");
  }
}

main();