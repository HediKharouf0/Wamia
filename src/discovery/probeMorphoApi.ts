import addresses from "../../config/addresses.json" with { type: "json" };

const ENDPOINTS = ["https://api.morpho.org/graphql", "https://blue-api.morpho.org/graphql"];

const query = `
  query Probe($marketIds: [String!]) {
    marketPositions(
      first: 3
      where: { marketUniqueKey_in: $marketIds }
    ) {
      pageInfo { count countTotal }
      items {
        user { address }
        state {
          collateral
          borrowShares
          borrowAssets
          supplyShares
        }
      }
    }
  }
`;

async function tryEndpoint(url: string, marketIds: string[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { marketIds } }),
  });
  const text = await res.text();
  console.log(`\n--- ${url} (HTTP ${res.status}) ---`);
  console.log(text.slice(0, 2000));
}

async function main() {
  const marketIds = Object.values(addresses.morphoMarkets).map((m: any) => m.id);
  for (const url of ENDPOINTS) {
    try {
      await tryEndpoint(url, marketIds);
    } catch (e) {
      console.log(`\n--- ${url} ---\nFAILED: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});