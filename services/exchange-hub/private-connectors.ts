import ccxt from "ccxt";

const env = Bun.env;
const exchangeIds = new Set(ccxt.exchanges);
const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "null",
    "vary": "Origin",
  },
});
const safeId = (value: unknown) =>
  typeof value === "string" && /^[a-z0-9_]{2,40}$/.test(value) && exchangeIds.has(value);

async function constantTimeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function authorized(req: Request) {
  const expected = String(env.CONNECTOR_ADMIN_TOKEN || "");
  const supplied = req.headers.get("authorization") || "";
  if (expected.length < 32 || !supplied.startsWith("Bearer ")) return false;
  return constantTimeEqual(supplied.slice(7), expected);
}
function credentials(id: string) {
  const prefix = "EXCHANGE_" + id.toUpperCase() + "_";
  const apiKey = env[prefix + "API_KEY"];
  const secret = env[prefix + "API_SECRET"];
  const password = env[prefix + "PASSWORD"];
  if (!apiKey || !secret) return null;
  // OKX EEA (CCXT myokx) requires its own regional API key and passphrase.
  if ((id === "okx" || id === "myokx") && !password) return null;
  return {
    apiKey,
    secret,
    password,
    uid: env[prefix + "UID"],
  };
}
function makeClient(id: string) {
  const creds = credentials(id);
  if (!creds) throw new Error("Identifiants non configurés pour cette plateforme.");
  const Constructor = (ccxt as any)[id];
  if (typeof Constructor !== "function") throw new Error("Adaptateur CCXT indisponible.");
  const client = new Constructor({
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
    ...(creds.uid ? { uid: creds.uid } : {}),
    enableRateLimit: true,
    timeout: 15000,
    options: { defaultType: env[prefixFor(id) + "DEFAULT_TYPE"] || "spot" },
  });
  // Binance Spot Testnet is opt-in and remains the default validation path.
  if (id === "binance" && String(env.BINANCE_SPOT_TESTNET || "").toLowerCase() === "true") {
    if (typeof client.setSandboxMode !== "function") throw new Error("Mode sandbox Binance indisponible dans CCXT.");
    client.setSandboxMode(true);
  }
  return client;
}
function prefixFor(id: string) { return "EXCHANGE_" + id.toUpperCase() + "_"; }

export async function handlePrivateConnectorRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/private/")) return null;
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "null",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-max-age": "600",
    }});
  }
  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "Méthode non autorisée." }, 405);
  if (!await authorized(req)) return json({ ok: false, error: "Authentification interne invalide ou non configurée." }, 401);

  if (url.pathname === "/private/connectors" && req.method === "GET") {
    const configured = ccxt.exchanges.filter((id: string) => !!credentials(id));
    return json({
      ok: true,
      library: "CCXT",
      totalSupported: ccxt.exchanges.length,
      configured,
      available: ccxt.exchanges.filter((id: string) => typeof (ccxt as any)[id] === "function"),
      permissionsRequired: "Clé API de lecture seule recommandée. Retraits et transferts désactivés sur la plateforme.",
      recommendedForEEA: "myokx",
      regionalNote: "Pour un compte OKX EEE/Europe, utiliser l’adaptateur CCXT myokx et des identifiants API créés sur le compte OKX Europe. Le mot de passe API (passphrase) est obligatoire. Les identifiants okx global et myokx EEE sont distincts.",
      tradingEnabled: false,
      orderPlacement: "disabled",
      binanceSpotTestnet: String(env.BINANCE_SPOT_TESTNET || "").toLowerCase() === "true",
      liveTradingEnabled: String(env.LIVE_TRADING_ENABLED || "").toLowerCase() === "true",
    });
  }

  if (url.pathname === "/private/account" && req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, error: "JSON invalide." }, 400); }
    const id = String(body?.exchange || "").toLowerCase();
    if (!safeId(id)) return json({ ok: false, error: "Identifiant de plateforme CCXT invalide." }, 400);
    if (!credentials(id)) return json({ ok: false, error: "Clés API absentes dans les variables sécurisées du serveur." }, 409);
    let client: any;
    try {
      client = makeClient(id);
      if (!client.has?.fetchBalance) return json({ ok: false, error: "Lecture du solde non prise en charge par cet adaptateur." }, 501);
      const balance = await client.fetchBalance();
      const totals = balance?.total || {};
      const assets = Object.entries(totals)
        .map(([asset, amount]) => ({ asset, total: Number(amount) }))
        .filter((item) => Number.isFinite(item.total) && item.total !== 0)
        .slice(0, 200);
      return json({
        ok: true,
        exchange: id,
        accountConnected: true,
        timestamp: Date.now(),
        assets,
        tradingEnabled: false,
        environment: id === "binance" && String(env.BINANCE_SPOT_TESTNET || "").toLowerCase() === "true" ? "binance-spot-testnet" : "production-read-only",
        note: "Connexion privée en lecture seule. Aucun ordre ne peut être envoyé par cette API.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur exchange inconnue.";
      console.warn("Private account check failed", id, message.slice(0, 180));
      return json({ ok: false, exchange: id, error: "Échec de vérification du compte. Vérifie les clés, permissions, IP autorisées et le type de compte." }, 502);
    } finally {
      try { await client?.close?.(); } catch {}
    }
  }

  // Strictly isolated Binance Spot Testnet order endpoint.
  // It cannot fall back to production: sandbox mode and LIVE_TRADING_ENABLED=false are mandatory.
  if (url.pathname === "/private/test-order" && req.method === "POST") {
    if (String(env.BINANCE_SPOT_TESTNET || "").toLowerCase() !== "true") {
      return json({ ok: false, error: "Ordres refusés : Binance Spot Testnet n'est pas activé." }, 403);
    }
    if (String(env.LIVE_TRADING_ENABLED || "").toLowerCase() === "true") {
      return json({ ok: false, error: "Configuration incohérente : le mode réel doit rester désactivé pour ce endpoint." }, 403);
    }
    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, error: "JSON invalide." }, 400); }
    const symbol = String(body?.symbol || "").toUpperCase();
    const side = String(body?.side || "").toLowerCase();
    const quoteAmount = Number(body?.quoteAmount);
    const baseAmount = Number(body?.baseAmount);
    if (!/^[A-Z0-9]{2,15}\/USDT$/.test(symbol)) return json({ ok: false, error: "Paire invalide. Format attendu : BTC/USDT." }, 400);
    if (side !== "buy" && side !== "sell") return json({ ok: false, error: "Sens invalide." }, 400);
    if (side === "buy" && (!Number.isFinite(quoteAmount) || quoteAmount <= 0 || quoteAmount > 25)) {
      return json({ ok: false, error: "Achat Testnet limité à 25 USDT par ordre." }, 400);
    }
    if (side === "sell" && (!Number.isFinite(baseAmount) || baseAmount <= 0)) {
      return json({ ok: false, error: "Quantité de vente invalide." }, 400);
    }
    let client: any;
    try {
      client = makeClient("binance");
      await client.loadMarkets();
      const market = client.market(symbol);
      if (!market || market.spot !== true || market.active === false) return json({ ok: false, error: "Marché Spot indisponible." }, 400);
      const ticker = await client.fetchTicker(symbol);
      const price = Number(ticker?.last);
      if (!Number.isFinite(price) || price <= 0) return json({ ok: false, error: "Prix de marché invalide." }, 502);
      let amount: number;
      if (side === "buy") {
        const balance = await client.fetchBalance();
        const freeQuote = Number(balance?.free?.USDT || 0);
        if (freeQuote < quoteAmount) return json({ ok: false, error: "Solde USDT Testnet insuffisant.", available: freeQuote }, 409);
        amount = Number(client.amountToPrecision(symbol, quoteAmount / price));
      } else {
        const balance = await client.fetchBalance();
        const base = symbol.split("/")[0];
        const freeBase = Number(balance?.free?.[base] || 0);
        if (freeBase < baseAmount) return json({ ok: false, error: "Solde disponible insuffisant pour cette vente.", available: freeBase }, 409);
        amount = Number(client.amountToPrecision(symbol, baseAmount));
      }
      if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Quantité arrondie invalide." }, 400);
      const estimatedQuote = amount * price;
      if (!Number.isFinite(estimatedQuote) || estimatedQuote <= 0 || estimatedQuote > 25.5) {
        return json({ ok: false, error: "Valeur de l'ordre hors limite Testnet (25 USDT max)." }, 400);
      }
      const order = await client.createOrder(symbol, "market", side, amount);
      return json({
        ok: true,
        environment: "binance-spot-testnet",
        simulatedFunds: true,
        tradingEnabled: false,
        order: {
          id: order.id || null,
          symbol,
          side,
          type: order.type || "market",
          amount: Number(order.amount || amount),
          filled: Number(order.filled || 0),
          average: Number(order.average || 0),
          status: order.status || "submitted",
        },
        message: "Ordre envoyé exclusivement à Binance Spot Testnet. Aucun argent réel n'a été engagé.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur Binance Testnet inconnue.";
      console.warn("Binance Testnet order failed", message.slice(0, 180));
      return json({ ok: false, environment: "binance-spot-testnet", error: "Ordre Testnet refusé. Vérifie les clés Testnet, le solde et les filtres de marché." }, 502);
    } finally {
      try { await client?.close?.(); } catch {}
    }
  }

  return json({ ok: false, error: "Route privée inconnue." }, 404);
}
