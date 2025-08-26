import 'dotenv/config';
import express from 'express';

const PORT = process.env.PORT || 3000;

// Raydium AMM v4 program (mainnet)
const RAYDIUM_AMM = 'RVKd61ztZW9njDq5E7Yh5b2bb4a6JjAwjhH38GZ3oN7';

// Opcionális auth titok
const INCOMING_AUTH = process.env.INCOMING_AUTH || null;

const app = express();
app.use(express.json({ limit: '5mb' })); // elég nagy limit a payloadnak

// Egyszerű auth log + check
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

// Healthcheck endpoint
app.get('/', (_req, res) => {
  console.log('[health] GET / called');
  res.send('Raydium LP Burn webhook server ✅');
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
  console.log('--- [webhook] 🔔 ÚJ REQUEST ÉRKEZETT ---');
  console.log('[webhook] Headers:', JSON.stringify(req.headers, null, 2));

  try {
    // Az egész body logolása (max 1k karakter, hogy ne öntse el a logot)
    const rawBody = JSON.stringify(req.body);
    console.log('[webhook] Raw body (cut to 1000 chars):', rawBody.slice(0, 1000));

    const arr = Array.isArray(req.body) ? req.body : [req.body];
    console.log(`[webhook] Feldolgozandó elemek száma: ${arr.length}`);

    for (const [i, item] of arr.entries()) {
      console.log(`\n[tx ${i}] signature=${item?.signature || item?.transactionSignature}`);
      console.log(`[tx ${i}] type=${item?.type || item?.transactionType}`);

      const accounts = item?.accounts || [];
      console.log(`[tx ${i}] accounts:`, JSON.stringify(accounts));

      // Check: szerepel-e a Raydium AMM
      const mentionsRaydium = accounts.some((a) => {
        const acc = typeof a === 'string' ? a : a?.account;
        return acc === RAYDIUM_AMM;
      });
      console.log(`[tx ${i}] mentionsRaydium=${mentionsRaydium}`);

      if (!mentionsRaydium) {
        console.log(`[tx ${i}] ❌ Kihagyva, mert nem tartalmazza Raydium programot.`);
        continue;
      }
      if ((item?.type || item?.transactionType) !== 'BURN') {
        console.log(`[tx ${i}] ❌ Kihagyva, mert nem BURN típus.`);
        continue;
      }

      // Burn instr. keresése
      const burns = [];
      const scanInstrArray = (arr2, label) => {
        if (!Array.isArray(arr2)) return;
        for (const ins of arr2) {
          const program = ins?.program || ins?.programId || '';
          const parsed = ins?.parsed || {};
          const pType = parsed?.type || '';
          if (program === 'spl-token' && String(pType).toLowerCase() === 'burn') {
            burns.push(parsed?.info || {});
            console.log(`[tx ${i}] ✅ Burn instruction találtunk in ${label}:`, JSON.stringify(parsed?.info));
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
        console.log(`[tx ${i}] ⚠️ Nem találtunk parsed burn adatot, de Raydium+BURN volt a tx.`);
      } else {
        for (const b of burns) {
          console.log(`[tx ${i}] 🔥 RAYDIUM LP BURN | mint=${b.mint} | amount=${b.amount} | owner=${b.owner}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] ❌ Feldolgozási hiba:', e);
    console.error(e.stack);
    res.sendStatus(200); // Heliusnak mindig 200-at küldünk vissza
  }
});

// Indítás
app.listen(PORT, () => {
  console.log(`\n[server] 🚀 HTTP server listening on :${PORT}`);
  console.log(`[server] Webhook endpoint: POST /webhook`);
});
