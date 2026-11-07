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
  if (!apiKey || !secret) return null;
  return {
    apiKey,
    secret,
    password: env[prefix + "PASSWORD"],
    uid: env[prefix + "UID"],
  };
}
function makeClient(id: string) {
  const creds = credentials(id);
  if (!creds) throw new Error("Identifiants non configurés pour cette plateforme.");
  const Constructor = (ccxt as any)[id];
  if (typeof Constructor !== "function") throw new Error("Adaptateur CCXT indisponible.");
  return new Constructor({
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
    ...(creds.uid ? { uid: creds.uid } : {}),
    enableRateLimit: true,
    timeout: 15000,
    options: { defaultType: env[prefixFor(id) + "DEFAULT_TYPE"] || "spot" },
  });
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
      permissionsRequired: "Clé API de lecture seule recommandée. Retraits désactivés sur la plateforme.",
      tradingEnabled: false,
      orderPlacement: "disabled",
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
  return json({ ok: false, error: "Route privée inconnue." }, 404);
}
