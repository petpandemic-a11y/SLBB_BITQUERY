import 'dotenv/config';
import express from 'express';

// --- Konstansok ---
const PORT = process.env.PORT || 3000;

// Raydium AMM v4 program (mainnet)
const RAYDIUM_AMM = 'RVKd61ztZW9njDq5E7Yh5b2bb4a6JjAwjhH38GZ3oN7';

// Opcionális – ha beállítod a Helius webhook secretet, itt tudsz ellenőrizni.
// (A Helius "Authentication Header"-be tedd be ugyanazt a titkot, és itt hasonlítsd.)
const INCOMING_AUTH = process.env.INCOMING_AUTH || null;

// --- App ---
const app = express();

// Helius enhanced webhook JSON-t küld; engedjük a nagyobb body-t is
app.use(express.json({ limit: '2mb' }));

// Egyszerű auth fejléccel (ha kérsz)
app.use((req, res, next) => {
  if (!INCOMING_AUTH) return next();
  const hdr = req.get('Authorization') || req.get('X-Auth') || '';
  if (hdr === INCOMING_AUTH) return next();
  return res.status(401).send('Unauthorized');
});

// Healthcheck
app.get('/', (_req, res) => {
  res.send('Raydium LP Burn webhook server ✅');
});

// Fő webhook endpoint – ide mutasson a Helius (POST)
app.post('/webhook', (req, res) => {
  try {
    // Helius enhanced: tipikusan TÖMB jön (1..N tx/event)
    const arr = Array.isArray(req.body) ? req.body : [req.body];

    for (const item of arr) {
      const signature = item?.signature || item?.transactionSignature || 'n/a';
      const txType = item?.type || item?.transactionType || 'unknown';
      const accounts = item?.accounts || [];

      // Biztonsági ellenőrzés: Raydium szerepel-e a tranzakció érintett accountjai közt?
      const mentionsRaydium = accounts.some(a => {
        // Helius küldhet {account:"<addr>"} vagy plain stringet is
        const acc = typeof a === 'string' ? a : a?.account;
        return acc === RAYDIUM_AMM;
      });

      // Csak Raydium + Burn
      if (!mentionsRaydium || txType !== 'BURN') continue;

      // Próbáljuk kinyerni a burn részleteit az enhanced payloadból.
      // Helius gyakran ad "instructions" és "innerInstructions" parsed formában:
      const mints = new Set();
      const burns = [];

      const scanInstrArray = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const ins of arr) {
          // Formátumok lehetnek: { program:'spl-token', parsed:{ type:'burn', info:{ mint, amount, owner, account } } }
          const program = ins?.program || ins?.programId || '';
          const parsed = ins?.parsed || {};
          const pType = parsed?.type || '';
          if (program === 'spl-token' && String(pType).toLowerCase() === 'burn') {
            const info = parsed?.info || {};
            if (info?.mint) mints.add(info.mint);
            burns.push({
              mint: info?.mint || null,
              amount: info?.amount || null,
              owner: info?.owner || null,
              account: info?.account || null
            });
          }
        }
      };

      scanInstrArray(item?.instructions);
      // innerInstructions több szint lehet, kezeljük:
      if (Array.isArray(item?.innerInstructions)) {
        for (const inner of item.innerInstructions) {
          scanInstrArray(inner?.instructions || inner);
        }
      }

      // Ha nem találtunk részletes parsed adatot, akkor is logoljuk a minimumot:
      if (burns.length === 0) {
        console.log(`[RAYDIUM LP BURN] sig=${signature} | (parsed burn részletek nem érkeztek a payloadban)`);
      } else {
        for (const b of burns) {
          console.log(
            `[RAYDIUM LP BURN] sig=${signature} | mint=${b.mint || '-'} | amount=${b.amount || '-'} | owner=${b.owner || '-'}`
          );
        }
      }

      // Extra: jelezzük, ha több potenciális mint is volt
      if (mints.size > 1) {
        console.log(`[info] Több érintett mint ugyanabban a tx-ben: ${[...mints].join(', ')}`);
      }
    }

    // Mindig válaszoljunk gyorsan 200-zal
    res.sendStatus(200);
  } catch (e) {
    console.error('[webhook error]', e);
    res.sendStatus(200); // webhookot ne dobjuk vissza hibával, nehogy Helius letiltsa
  }
});

// Indítás
app.listen(PORT, () => {
  console.log(`HTTP server listening on :${PORT}`);
  console.log(`Webhook endpoint: POST /webhook`);
});
