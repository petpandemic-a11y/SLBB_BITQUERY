import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';

// --- ENV (állítsd be Renderen is) ---
const RPC_WSS = process.env.RPC_WSS;     // pl. wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
const RPC_HTTP = process.env.RPC_HTTP;   // pl. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
if (!RPC_WSS || !RPC_HTTP) {
  console.error('Állítsd be az RPC_WSS és RPC_HTTP környezeti változókat (Helius kulccsal).');
  process.exit(1);
}

// SPL Token program (itt születik a "Instruction: Burn")
const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// Raydium AMM v4 program (ezt akarjuk szűrni)
const RAYDIUM_AMM = new PublicKey('RVKd61ztZW9njDq5E7Yh5b2bb4a6JjAwjhH38GZ3oN7');

const COMMITMENT = (process.env.COMMITMENT || 'confirmed'); // processed|confirmed|finalized
const connection = new Connection(RPC_HTTP, COMMITMENT);

// A web3.js WSS feliratkozás a HTTP URL-t is használja a connection létrehozásakor,
// de a logs subscription WSS-en megy, ha az RPC szolgáltató támogatja (Helius igen).
// Itt külön WSS-t adunk meg a low-level log figyeléshez:
const wsConn = new Connection(RPC_WSS, COMMITMENT);

// Gyors helper: tranzakció betöltése + Raydium szűrés + burn adatok kinyerése
async function handleTx(signature) {
  try {
    // Parzolt TX-t kérünk, hogy emberi-olvashatóak legyenek a token műveletek
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: COMMITMENT
    });
    if (!tx) return;

    // A Raydium feltétel: a tranzakció accountjai közt szerepel a Raydium program
    const mentionsRaydium = tx.transaction.message.accountKeys
      .some(k => k.pubkey?.toBase58() === RAYDIUM_AMM.toBase58());
    if (!mentionsRaydium) return; // nem Raydium-hoz köthető

    // Keressünk minden parsed "burn" műveletet (SPL Token)
    const burns = [];
    const inspectInstr = (i) => {
      if (i?.program === 'spl-token' && i?.parsed?.type === 'burn') {
        const info = i.parsed.info || {};
        burns.push({
          mint: info.mint,
          owner: info.owner,
          amount: info.amount,
          account: info.account
        });
      }
    };

    // fő instrukciók
    for (const i of tx.transaction.message.instructions || []) {
      inspectInstr(i);
    }
    // belső instrukciók
    for (const inner of tx.meta?.innerInstructions || []) {
      for (const i of inner.instructions || []) inspectInstr(i);
    }

    if (burns.length) {
      const slot = tx.slot;
      const ts = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : 'n/a';
      for (const b of burns) {
        console.log(
          `[RAYDIUM LP BURN] ${ts} | slot=${slot} | sig=${signature} | mint=${b.mint} | amount=${b.amount} | owner=${b.owner || '-'}`
        );
      }
    }
  } catch (e) {
    console.error('[tx fetch error]', signature, e.message);
  }
}

(async () => {
  console.log('[ws] Subscribing to SPL Token program logs (Burn)…');
  const subId = await wsConn.onLogs(SPL_TOKEN_PROGRAM, async (log) => {
    try {
      const { signature, logs } = log;
      if (!logs?.length) return;

      // Gyors szűrés: csak akkor nézzük a TX-t, ha tényleg Burn történt
      const hasBurn = logs.some(l => /Instruction:\s*Burn/i.test(l));
      if (!hasBurn) return;

      // Részletek betöltése és Raydium-szűrés
      await handleTx(signature);
    } catch (e) {
      console.error('[onLogs error]', e.message);
    }
  }, COMMITMENT);

  console.log('[ws] Listening. Subscription ID:', subId);
})();
