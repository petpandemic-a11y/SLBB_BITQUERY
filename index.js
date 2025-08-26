import 'dotenv/config';

// --- ENV ---
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
if (!BITQUERY_API_KEY) {
  console.error("⚠️ Állítsd be a BITQUERY_API_KEY változót!");
  process.exit(1);
}

// Bitquery GraphQL endpoint (HTTP poll)
const BITQUERY_HTTP_URL =
  process.env.BITQUERY_HTTP_URL || "https://graphql.bitquery.io";

// Raydium program cím (mainnet)
const RAYDIUM_PROGRAM = "RVKd61ztZW9njDq5E7Yh5b2bb4a6JjAwjhH38GZ3oN7";

// Poll paraméterek
const POLL_INTERVAL_SEC = Number(process.env.POLL_INTERVAL_SEC || 20);
const START_MINUTES_AGO = Number(process.env.START_MINUTES_AGO || 2);
const LIMIT = Number(process.env.PAGE_LIMIT || 25);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoNowMinus = (mins) =>
  new Date(Date.now() - mins * 60_000).toISOString();

// --- GraphQL query ---
const QUERY = /* GraphQL */ `
  query RaydiumBurns($since: DateTime, $limit: Int!, $program: String!) {
    Solana {
      Instructions(
        where: {
          Block: { Time: { since: $since } }
          Instruction: {
            Program: {
              Address: { is: $program }
              Method: { includes: "burn" }
            }
          }
        }
        orderBy: { ascending: Block_Time }
        limit: $limit
      ) {
        Block { Time }
        Transaction { Signature }
        Instruction {
          Program { Name Address Method }
          Accounts {
            Address
            Token { Mint }
          }
        }
      }
    }
  }
`;

async function gqlFetch(query, variables) {
  const res = await fetch(BITQUERY_HTTP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": BITQUERY_API_KEY,
      Authorization: `Bearer ${BITQUERY_API_KEY}`
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function fmtTs(iso) {
  try {
    return new Date(iso).toISOString();
  } catch {
    return String(iso);
  }
}

function summarize(entry) {
  const sig = entry?.Transaction?.Signature;
  const time = fmtTs(entry?.Block?.Time);
  const mints = [
    ...new Set(
      (entry?.Instruction?.Accounts || [])
        .map((a) => a?.Token?.Mint)
        .filter(Boolean)
    ),
  ];
  return { sig, time, mints };
}

async function run() {
  let since = isoNowMinus(START_MINUTES_AGO);
  console.log(
    `[poll] Raydium LP burn watcher indul — since=${since}, interval=${POLL_INTERVAL_SEC}s`
  );

  for (;;) {
    try {
      const data = await gqlFetch(QUERY, {
        since,
        limit: LIMIT,
        program: RAYDIUM_PROGRAM,
      });
      const rows = data?.Solana?.Instructions || [];

      if (rows.length > 0) {
        for (const r of rows) {
          const { sig, time, mints } = summarize(r);
          console.log(
            `[RAYDIUM BURN] ${time} | sig=${sig} | LP mints=${mints.join(",") || "-"}`
          );
        }
        // legutolsó idő tovább léptetése
        const lastTime = rows[rows.length - 1]?.Block?.Time;
        if (lastTime) {
          since = new Date(new Date(lastTime).getTime() + 1).toISOString();
        }
      }
      await sleep(POLL_INTERVAL_SEC * 1000);
    } catch (e) {
      console.error("[poll] hiba:", e.message);
      await sleep(30_000);
    }
  }
}

run().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
