import 'dotenv/config';
import WebSocket from 'ws';
import { createClient } from 'graphql-ws';

// --- ENV ---
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
if (!BITQUERY_API_KEY) {
  console.error('Hiányzik a BITQUERY_API_KEY környezeti változó.');
  process.exit(1);
}

// Ha a fiókodban Solana az EAP végponton van, állítsd be ezt az env-et:
// BITQUERY_WS_URL=wss://streaming.bitquery.io/eap?token=...
const WS_URL =
  process.env.BITQUERY_WS_URL ||
  `wss://streaming.bitquery.io/graphql?token=${encodeURIComponent(BITQUERY_API_KEY)}`;

// Opcionális szűrők
const METHOD_FILTER = (process.env.METHOD_FILTER || 'burn').toLowerCase();
const PROGRAM_NAME_FILTER = (process.env.PROGRAM_NAME_FILTER || '').toLowerCase(); // pl. "token" / "raydium" / "orca"
const MINT_ALLOWLIST = process.env.MINT_ALLOWLIST
  ? new Set(process.env.MINT_ALLOWLIST.split(',').map(s => s.trim()))
  : null;

// --- GraphQL Subscription ---
const SUBSCRIPTION = /* GraphQL */ `
  subscription LpBurns($method:String!) {
    Solana {
      Instructions(
        where: {
          Instruction: {
            Program: { Method: { includes: $method } }
          }
        }
      ) {
        Transaction { Signature Signer }
        Block { Time }
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

function fmtTs(iso) {
  try { return new Date(iso).toISOString(); } catch { return String(iso); }
}

function isLpCandidate(instr) {
  if (PROGRAM_NAME_FILTER) {
    const pname = (instr?.Program?.Name || '').toLowerCase();
    if (!pname.includes(PROGRAM_NAME_FILTER)) return false;
  }
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
  const time = entry?.Block?.Time;
  const program = entry?.Instruction?.Program?.Name || 'UnknownProgram';
  const method = entry?.Instruction?.Program?.Method || 'unknown';

  const mints = [];
  for (const acc of entry?.Instruction?.Accounts || []) {
    if (acc?.Token?.Mint && !mints.includes(acc.Token.Mint)) {
      mints.push(acc.Token.Mint);
    }
  }

  let amountHint = null;
  for (const line of entry?.Instruction?.Logs || []) {
    const m = String(line).match(/burn(?:ed)?\s+(\d[\d,\.]*)/i);
    if (m) { amountHint = m[1]; break; }
  }

  return {
    sig,
    time: fmtTs(time),
    program,
    method,
    mints,
    amountHint
  };
}

let attempt = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  for (;;) {
    try {
      console.log(`[ws] Kapcsolódás: ${WS_URL}`);
      const client = createClient({
        url: WS_URL,
        webSocketImpl: WebSocket,
        keepAlive: 12000,
        connectionAckWaitTimeout: 10000,
        lazy: false
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        client.subscribe(
          { query: SUBSCRIPTION, variables: { method: METHOD_FILTER } },
          {
            next: (data) => {
              attempt = 0;
              const rows = data?.data?.Solana?.Instructions || [];
              for (const row of rows) {
                const instr = row?.Instruction;
                if (!instr) continue;
                if (!isLpCandidate(instr)) continue;

                const s = summarize(row);
                console.log(
                  `[LP BURN] ${s.time} | ${s.program}:${s.method} | mints=${s.mints.join(',') || '-'} | sig=${s.sig}` +
                  (s.amountHint ? ` | amount≈${s.amountHint}` : '')
                );
              }
            },
            error: (err) => {
              if (!settled) { settled = true; reject(err); }
            },
            complete: () => {
              if (!settled) { settled = true; resolve(); }
            }
          }
        );
      });

      console.warn('[ws] Subscription complete – újracsatlakozás.');
    } catch (e) {
      const wait = Math.min(30000, 1000 * Math.pow(2, attempt++));
      console.error(`[ws] Hiba: ${e?.message || e}. Újracsatlakozás ${wait} ms múlva...`);
      await sleep(wait);
    }
  }
}

run().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
