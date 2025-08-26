import 'dotenv/config';

// ---- ENV ----
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
if (!BITQUERY_API_KEY) {
  console.error('Hiányzik: BITQUERY_API_KEY');
  process.exit(1);
}

// Alap HTTP GraphQL endpoint. Ha nálad más, állítható:
const BITQUERY_HTTP_URL =
  process.env.BITQUERY_HTTP_URL ||
  'https://streaming.bitquery.io/graphql'; // alternatíva: 'https://graphql.bitquery.io'

const POLL_INTERVAL_SEC = Number(process.env.POLL_INTERVAL_SEC || 10);     // lekérdezés gyakorisága
const START_MINUTES_AGO = Number(process.env.START_MINUTES_AGO || 15);     // honnan induljon az első ablak
const METHOD_FILTER = (process.env.METHOD_FILTER || 'burn').toLowerCase(); // "burn"
const PROGRAM_NAME_FILTER = (process.env.PROGRAM_NAME_FILTER || '').toLowerCase();
const MINT_ALLOWLIST = process.env.MINT_ALLOWLIST
  ? new Set(process.env.MINT_ALLOWLIST.split(',').map(s => s.trim()))
  : null;

const LIMIT = Number(process.env.PAGE_LIMIT || 100); // soronként max. 100

// --- Segédek ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isoNowMinus = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

function fmtTs(iso) { try { return new Date(iso).toISOString(); } catch { return String(iso); } }

function passFilters(entry) {
  const instr = entry?.Instruction;
  if (!instr) return false;

  // method includes "burn"
  const method = (instr?.Program?.Method || '').toLowerCase();
  if (!method.includes(METHOD_FILTER)) return false;

  // program name substring
  if (PROGRAM_NAME_FILTER) {
    const pname = (instr?.Program?.Name || '').toLowerCase();
    if (!pname.includes(PROGRAM_NAME_FILTER)) return false;
  }

  // mint allowlist
  if (MINT_ALLOWLIST) {
    const ok = (instr?.Accounts || []).some(a => {
      const m = a?.Token?.Mint;
      return m && MINT_ALLOWLIST.has(m);
    });
    if (!ok) return false;
  }
  return true;
}

function summarize(entry) {
  const sig = entry?.Transaction?.Signature;
  const time = fmtTs(entry?.Block?.Time);
  const program = entry?.Instruction?.Program?.Name || 'UnknownProgram';
  const method = entry?.Instruction?.Program?.Method || 'unknown';

  const mints = [];
  for (const acc of entry?.Instruction?.Accounts || []) {
    if (acc?.Token?.Mint && !mints.includes(acc.Token.Mint)) mints.push(acc.Token.Mint);
  }

  let amountHint = null;
  for (const line of entry?.Instruction?.Logs || []) {
    const m = String(line).match(/burn(?:ed)?\s+(\d[\d,\.]*)/i);
    if (m) { amountHint = m[1]; break; }
  }

  return { sig, time, program, method, mints, amountHint };
}

// Dedup: signature + method + firstMint
const seen = new Set();
function dedupKey(e) {
  const sig = e?.Transaction?.Signature || '';
  const method = e?.Instruction?.Program?.Method || '';
  const firstMint = e?.Instruction?.Accounts?.[0]?.Token?.Mint || '';
  return `${sig}|${method}|${firstMint}`;
}

// --- GraphQL query (HTTP) ---
// Időalapú ablak + "includes: burn" method szűrés. V2-höz illesztett mezőnevek.
const QUERY = /* GraphQL */ `
  query PollBurns($since: DateTime, $limit: Int!) {
    Solana {
      Instructions(
        where: {
          Block: { Time: { since: $since } }
          Instruction: { Program: { Method: { includes: "burn" } } }
        }
        orderBy: { ascending: Block_Time }  # idő szerint előre
        limit: $limit
      ) {
        Block { Time }
        Transaction { Signature }
        Instruction {
          Logs
          Program { Name Address Method }
          Accounts {
            Address
            Token { Mint Symbol Name Decimals }
          }
        }
      }
    }
  }
`;

async function gqlFetch(query, variables) {
  const res = await fetch(BITQUERY_HTTP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // V2: Bearer/OAuth és a régi X-API-KEY is működhetnek környezettől függően.
      // Ha a szerver Bearer-t vár:
      Authorization: `Bearer ${BITQUERY_API_KEY}`,
      // Biztonság kedvéért sok helyen elfogadják az X-API-KEY-t is:
      'X-API-KEY': BITQUERY_API_KEY
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json.data;
}

async function run() {
  let since = isoNowMinus(START_MINUTES_AGO);

  console.log(`[poll] indul: since=${since}, interval=${POLL_INTERVAL_SEC}s, endpoint=${BITQUERY_HTTP_URL}`);

  for (;;) {
    try {
      const data = await gqlFetch(QUERY, { since, limit: LIMIT });
      const rows = data?.Solana?.Instructions || [];

      // ha jött sor, frissítjük a "since"-t az utolsó elem idejére
      if (rows.length > 0) {
        for (const r of rows) {
          if (!passFilters(r)) continue;
          const key = dedupKey(r);
          if (seen.has(key)) continue;
          seen.add(key);

          const s = summarize(r);
          console.log(
            `[LP BURN] ${s.time} | ${s.program}:${s.method} | mints=${s.mints.join(',') || '-'} | sig=${s.sig}` +
            (s.amountHint ? ` | amount≈${s.amountHint}` : '')
          );
        }
        // lépjünk tovább időben (utolsó blokk ideje + 1 ms)
        const lastTime = rows[rows.length - 1]?.Block?.Time;
        if (lastTime) since = new Date(new Date(lastTime).getTime() + 1).toISOString();
      }

      await sleep(POLL_INTERVAL_SEC * 1000);
    } catch (e) {
      // Rate limit vagy átmeneti hiba esetén várjunk többet
      console.error(`[poll] hiba: ${e.message}`);
      await sleep(Math.max(POLL_INTERVAL_SEC, 15) * 1000);
    }
  }
}

run().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
