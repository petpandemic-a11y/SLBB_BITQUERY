import 'dotenv/config';
import express from 'express';

const PORT = process.env.PORT || 3000;

// Raydium AMM v4 program (mainnet)
const RAYDIUM_AMM = 'RVKd61ztZW9njDq5E7Yh5b2bb4a6JjAwjhH38GZ3oN7';

// Opcionális auth titok (ugyanezt tedd a Helius "Authentication Header"-ébe)
const INCOMING_AUTH = process.env.INCOMING_AUTH || null;

const app = express();
app.use(express.json({ limit: '5mb' })); // elég nagy a Helius enhanced payloadhoz

// Egyszerű auth + log
app.use((req, res, next) => {
  if (!INCOMING_AUTH) return next();
  const hdr = req.get('Authorization') || req.get('X-Auth') || '';
  if (hdr === INCOMING_AUTH) {
    console.log('[auth] ✅ Authorization OK');
    return next();
  } else {
    console.warn('[auth] ❌ Authorization FAIL', hdr);
    return res.status(401).send('Unauthorized');
  }
});

// Healthcheck
app.get('/', (_req, res) => {
  console.log('[health] GET / called');
  res.send('Raydium LP Burn webhook server ✅');
});

// Egyszerű futás-idő mérő
const nowNs = () => Number(process.hrtime.bigint()); // ns
const nsToMs = (ns) => (ns / 1_000_000).toFixed(3);

// Fő webhook
let REQ_SEQ = 0; // növekvő request azonosító a logok összefűzéséhez
app.post('/webhook', (req, res) => {
  const reqId = ++REQ_SEQ;
  const t0 = nowNs();

  console.log(`\n--- [webhook#${reqId}] 🔔 ÚJ REQUEST ÉRKEZETT ---`);
  console.log(`[webhook#${reqId}] Headers:`, JSON.stringify(req.headers, null, 2));

  try {
    // Body mint tömb
    const events = Array.isArray(req.body) ? req.body : [req.body];
    console.log(`[webhook#${reqId}] Raw body (cut 1000 chars): ${JSON.stringify(req.body).slice(0, 1000)}`);
    console.log(`[webhook#${reqId}] Elemek száma: ${events.length}`);

    // Összesítők
    let passedRaydium = 0;
    let totalBurnInstructions = 0;

    events.forEach((item, idx) => {
      const signature = item?.signature || item?.transactionSignature || 'n/a';
      const txType = item?.type || item?.transactionType || 'unknown';
      const accounts = item?.accounts || [];

      console.log(`\n[webhook#${reqId} tx${idx}] signature=${signature}`);
      console.log(`[webhook#${reqId} tx${idx}] type=${txType}`);
      console.log(`[webhook#${reqId} tx${idx}] accounts: ${JSON.stringify(accounts)}`);

      // Raydium ellenőrzés
      const mentionsRaydium = accounts.some((a) => {
        const acc = typeof a === 'string' ? a : a?.account;
        return acc === RAYDIUM_AMM;
      });
      console.log(`[webhook#${reqId} tx${idx}] mentionsRaydium=${mentionsRaydium}`);

      if (!mentionsRaydium) {
        console.log(`[webhook#${reqId} tx${idx}] ❌ Kihagyva: nem Raydium tx.`);
        return;
      }
      if (txType !== 'BURN') {
        console.log(`[webhook#${reqId} tx${idx}] ❌ Kihagyva: nem BURN típus.`);
        return;
      }

      passedRaydium += 1;

      // Burn instrukciók kigyűjtése (parsed)
      const burns = [];
      const scanInstrArray = (arr, label) => {
        if (!Array.isArray(arr)) return;
        for (const ins of arr) {
          const program = ins?.program || ins?.programId || '';
          const parsed = ins?.parsed || {};
          const pType = (parsed?.type || '').toLowerCase();
          if (program === 'spl-token' && pType === 'burn') {
            totalBurnInstructions += 1;
            const info = parsed?.info || {};
            burns.push(info);
            console.log(`[webhook#${reqId} tx${idx}] ✅ Burn in ${label}: ${JSON.stringify(info)}`);
          }
        }
      };

      scanInstrArray(item?.instructions, 'instructions');
      if (Array.isArray(item?.innerInstructions)) {
        for (const inner of item.innerInstructions) {
          scanInstrArray(inner?.instructions || inner, 'innerInstructions');
        }
      }

      if (burns.length === 0) {
        console.log(`[webhook#${reqId} tx${idx}] ⚠️ Raydium+BURN tx, de parsed burn részlet nem érkezett.`);
      } else {
        for (const b of burns) {
          console.log(
            `[webhook#${reqId} tx${idx}] 🔥 RAYDIUM LP BURN | mint=${b.mint || '-'} | amount=${b.amount || '-'} | owner=${b.owner || '-'}`
          );
        }
      }
    });

    const dtMs = nsToMs(nowNs() - t0);
    console.log(`\n--- [webhook#${reqId}] ✅ KÉSZ | feldolgozott tx-ek: ${events.length} | Raydium-hit: ${passedRaydium} | Burn instrukciók: ${totalBurnInstructions} | idő: ${dtMs} ms ---`);

    res.sendStatus(200);
  } catch (e) {
    const dtMs = nsToMs(nowNs() - t0);
    console.error(`[webhook#${reqId}] ❌ Hiba feldolgozás közben (${dtMs} ms):`, e);
    console.error(e.stack);
    // a webhook válasz maradjon 200, hogy Helius ne tiltsa
    res.sendStatus(200);
  }
});

// Indítás
app.listen(PORT, () => {
  console.log(`\n[server] 🚀 HTTP server listening on :${PORT}`);
  console.log(`[server] Webhook endpoint: POST /webhook`);
});
