# Raydium LP Burn – Helius Webhook (Express)

Renderre tehető **Web Service**, amely Helius **enhanced** webhookból fogad **BURN** tranzakciókat, és csak azokat dolgozza fel, amelyekben **Raydium AMM v4 program** is szerepel.

## Miért jó?
- Nincs 429/402 limitgond: Helius pusholja az eseményt.
- Nincs állandó RPC letöltögetés.
- Azonnali feldolgozás, egyszerű loggolás/TG posztolás.

## Telepítés / futtatás
1. Töltsd fel a repót GitHubra.
2. Render → **New +** → **Web Service** (ne Background Worker).
   - Build command: `npm install`
   - Start command: `npm start`
   - Root Directory: (repo gyökér)
   - Environment:
     - (opcionális) `INCOMING_AUTH=egy_titkos_jelszo` – ha szeretnél auth-ot a webhookra
3. Deploy.

## Helius beállítás
- **Webhook Type:** `enhanced`
- **Transaction Type(s):** `BURN`
- **Webhook URL:** `https://<your-render-service>.onrender.com/webhook`
- **Account Addresses:** add meg **csak** a Raydium AMM v4 program címet:
