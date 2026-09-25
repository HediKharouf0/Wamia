const query = `
  query {
    __type(name: "Market") {
      fields {
        name
        type { name kind }
      }
    }
  }
`;

async function main() {
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

main();