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
// Serialize submissions with the same Binance clientOrderId inside this service process.
// Binance remains the durable idempotency authority across restarts and retries.
const orderLocks = new Map<string, Promise<void>>();
async function acquireOrderLock(key: string): Promise<() => void> {
  const previous = orderLocks.get(key) || Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  const queued = previous.then(() => current);
  orderLocks.set(key, queued);
  await previous;
  return () => {
    unlock();
    if (orderLocks.get(key) === queued) orderLocks.delete(key);
  };
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

async function findTestnetOrderByClientId(client: any, market: any, clientOrderId: string, fallbackSide: string) {
  try {
    const raw = await client.request("order", "private", "GET", { symbol: market.id, origClientOrderId: clientOrderId });
    return typeof client.parseOrder === "function" ? client.parseOrder(raw, market) : {
      id: raw.orderId, clientOrderId: raw.clientOrderId, status: String(raw.status || "").toLowerCase(),
      amount: Number(raw.origQty || 0), filled: Number(raw.executedQty || 0),
      average: Number(raw.price || 0), cost: Number(raw.cummulativeQuoteQty || 0),
      type: String(raw.type || "market").toLowerCase(), side: String(raw.side || fallbackSide).toLowerCase(),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "OrderNotFound" || /-2013|order does not exist|order not found/i.test(message)) return null;
    throw new Error("ORDER_LOOKUP_UNCERTAIN");
  }
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
      const restricted = message.includes("451") || /restricted location|eligibility/i.test(message);
      return json({ ok: false, exchange: id, error: restricted ? "Binance refuse la connexion depuis la région réseau de ce serveur (HTTP 451). Vérifie l’éligibilité régionale Binance. Aucun ordre n’a été envoyé." : "Échec de vérification du compte. Vérifie les clés, permissions, IP autorisées et le type de compte." }, 502);
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
    const clientOrderId = String(body?.clientOrderId || "");
    const quoteAmount = Number(body?.quoteAmount);
    const baseAmount = Number(body?.baseAmount);
    if (!/^[A-Z0-9]{2,15}\/USDT$/.test(symbol)) return json({ ok: false, error: "Paire invalide. Format attendu : BTC/USDT." }, 400);
    if (side !== "buy" && side !== "sell") return json({ ok: false, error: "Sens invalide." }, 400);
    // A stable client order ID is mandatory so a caller can safely retry after a timeout.
    if (!/^[A-Za-z0-9_-]{8,36}$/.test(clientOrderId)) return json({ ok: false, error: "clientOrderId obligatoire (8 à 36 caractères) pour éviter les doublons." }, 400);
    if (side === "buy" && (!Number.isFinite(quoteAmount) || quoteAmount <= 0 || quoteAmount > 25)) {
      return json({ ok: false, error: "Achat Testnet limité à 25 USDT par ordre." }, 400);
    }
    if (side === "sell" && (!Number.isFinite(baseAmount) || baseAmount <= 0)) {
      return json({ ok: false, error: "Quantité de vente invalide." }, 400);
    }
    // Prevent concurrent requests in this process from both observing "not found"
    // and racing to submit the same client order ID.
    const releaseOrderLock = await acquireOrderLock(clientOrderId);
    let client: any;
    try {
      client = makeClient("binance");
      await client.loadMarkets();
      const market = client.market(symbol);
      if (!market || market.spot !== true || market.active === false) return json({ ok: false, error: "Marché Spot indisponible." }, 400);
      const ticker = await client.fetchTicker(symbol);
      const price = Number(ticker?.last);
      if (!Number.isFinite(price) || price <= 0) return json({ ok: false, error: "Prix de marché invalide." }, 502);

      // Binance is the durable idempotency authority: look up the client order ID
      // before any retry. Only a definite "not found" permits a new submission.
      let order: any = null;
      try {
        // Binance GET /api/v3/order accepts origClientOrderId without orderId.
        // Use CCXT's signed raw request because unified fetchOrder requires an exchange order id.
        const raw = await client.request("order", "private", "GET", {
          symbol: market.id,
          origClientOrderId: clientOrderId,
        });
        order = typeof client.parseOrder === "function" ? client.parseOrder(raw, market) : {
          id: raw.orderId, clientOrderId: raw.clientOrderId, status: String(raw.status || "").toLowerCase(),
          amount: Number(raw.origQty || 0), filled: Number(raw.executedQty || 0),
          average: Number(raw.price || 0), cost: Number(raw.cummulativeQuoteQty || 0),
          type: String(raw.type || "market").toLowerCase(), side: String(raw.side || side).toLowerCase(),
        };
      } catch (lookupError) {
        const name = lookupError instanceof Error ? lookupError.name : "";
        const message = lookupError instanceof Error ? lookupError.message : String(lookupError);
        const definitelyMissing = name === "OrderNotFound" || /-2013|order does not exist|order not found/i.test(message);
        if (!definitelyMissing) {
          console.warn("Binance Testnet idempotency lookup inconclusive", message.slice(0, 180));
          return json({ ok: false, error: "Impossible de vérifier l'identifiant de l'ordre. Nouvelle soumission bloquée par sécurité." }, 503);
        }
      }

      let amount: number | undefined;
      if (!order) {
        const balance = await client.fetchBalance();
        if (side === "buy") {
          const freeQuote = Number(balance?.free?.USDT || 0);
          if (freeQuote < quoteAmount) return json({ ok: false, error: "Solde USDT Testnet insuffisant.", available: freeQuote }, 409);
          const estimatedBase = quoteAmount / price;
          const minCost = Number(market.limits?.cost?.min || 0);
          if (minCost > quoteAmount) return json({ ok: false, error: "Montant inférieur au minimum du marché.", minimum: minCost }, 400);
          if (estimatedBase <= 0) return json({ ok: false, error: "Quantité estimée invalide." }, 400);
          // quoteOrderQty makes the spend limit exact in quote currency (USDT).
          try {
            order = await client.createOrder(symbol, "market", "buy", undefined, undefined, {
              quoteOrderQty: quoteAmount,
              newClientOrderId: clientOrderId,
            });
          } catch (submitError) {
            try {
              const recovered = await findTestnetOrderByClientId(client, market, clientOrderId, side);
              if (!recovered) throw submitError;
              order = recovered;
            } catch (recoveryError) {
              if (recoveryError === submitError) throw submitError;
              console.warn("Binance Testnet buy result uncertain; same clientOrderId required for retry");
              return json({ ok: false, error: "Résultat de soumission incertain. Réessaie uniquement avec le même clientOrderId ; aucun nouvel identifiant ne doit être créé." }, 503);
            }
          }
        } else {
          const base = symbol.split("/")[0];
          const freeBase = Number(balance?.free?.[base] || 0);
          if (freeBase < baseAmount) return json({ ok: false, error: "Solde disponible insuffisant pour cette vente.", available: freeBase }, 409);
          amount = Number(client.amountToPrecision(symbol, baseAmount));
          if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Quantité arrondie invalide." }, 400);
          const estimatedQuote = amount * price;
          if (!Number.isFinite(estimatedQuote) || estimatedQuote <= 0 || estimatedQuote > 50.5) {
            return json({ ok: false, error: "Valeur de vente supérieure à 50 USDT sur Testnet." }, 400);
          }
          try {
            order = await client.createOrder(symbol, "market", "sell", amount, undefined, { newClientOrderId: clientOrderId });
          } catch (submitError) {
            try {
              const recovered = await findTestnetOrderByClientId(client, market, clientOrderId, side);
              if (!recovered) throw submitError;
              order = recovered;
            } catch (recoveryError) {
              if (recoveryError === submitError) throw submitError;
              console.warn("Binance Testnet sell result uncertain; same clientOrderId required for retry");
              return json({ ok: false, error: "Résultat de soumission incertain. Réessaie uniquement avec le même clientOrderId ; aucun nouvel identifiant ne doit être créé." }, 503);
            }
          }
        }
      }

      // Re-read exchange state to return actual fills/fees rather than assuming submission == fill.
      if (order?.id && order.status !== "closed" && order.status !== "canceled" && typeof client.fetchOrder === "function") {
        try { order = await client.fetchOrder(order.id, symbol); } catch (pollError) {
          console.warn("Binance Testnet order status pending", pollError instanceof Error ? pollError.message.slice(0, 160) : "unknown");
        }
      }
      return json({
        ok: true,
        environment: "binance-spot-testnet",
        simulatedFunds: true,
        tradingEnabled: false,
        order: {
          clientOrderId,
          id: order?.id || null,
          symbol,
          side,
          type: order?.type || "market",
          amount: Number(order?.amount || amount || 0),
          filled: Number(order?.filled || 0),
          remaining: Number(order?.remaining || 0),
          cost: Number(order?.cost || 0),
          average: Number(order?.average || 0),
          fee: order?.fee || null,
          status: order?.status || "submitted",
        },
        message: "Ordre envoyé exclusivement à Binance Spot Testnet. Aucun argent réel n'a été engagé.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur Binance Testnet inconnue.";
      console.warn("Binance Testnet order failed", message.slice(0, 180));
      return json({ ok: false, environment: "binance-spot-testnet", error: "Ordre Testnet refusé. Vérifie les clés Testnet, le solde et les filtres de marché." }, 502);
    } finally {
      try { await client?.close?.(); } catch {}
      releaseOrderLock();
    }
  }

  return json({ ok: false, error: "Route privée inconnue." }, 404);
}
