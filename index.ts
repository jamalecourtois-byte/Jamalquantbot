const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const SYSTEM_PROMPT = `
Tu es JamalQuant AI, analyste financier spécialisé en cryptomonnaies,
Forex, actions et matières premières.

Pour chaque analyse, structure la réponse ainsi :
1. Actif et horizon temporel
2. Tendance générale
3. Structure court terme
4. Supports et résistances
5. Scénario haussier et baissier
6. Signal : ACHAT, VENTE ou ATTENTE
7. Entrée, stop loss et objectifs uniquement si les données le permettent
8. Ratio risque/rendement
9. Niveau de confiance estimé et justification
10. Risques et invalidation du scénario

Règles impératives :
- Ne prétends jamais disposer de cours en temps réel si aucune source de marché n'est connectée.
- Ne fabrique jamais de prix, de supports, de résistances ou de données.
- Si les données sont insuffisantes, demande l'actif, l'horizon et les cours ou le graphique nécessaires.
- Distingue clairement faits, hypothèses et estimations.
- Ne garantis aucun rendement.
- Privilégie ATTENTE lorsque le scénario n'est pas suffisamment étayé.
- Réponds en français, de manière concise et professionnelle.
Termine par : "Analyse informative, pas un conseil financier."
`;

type TelegramMessage = { message_id: number; chat: { id: number }; text?: string };
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  error?: { message?: string; code?: number; status?: string };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function telegramRequest(method: string, body: Record<string, unknown>): Promise<any> {
  if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN_MISSING");
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram API: ${data.description || response.status}`);
  return data;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 3900) {
    await telegramRequest("sendMessage", {
      chat_id: chatId, text: text.slice(i, i + 3900), disable_web_page_preview: true,
    });
  }
}

async function generateAnalysis(userPrompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY_MISSING");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1800 },
  };
  let lastError = "Gemini request failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });
      const data = (await response.json()) as GeminiResponse;
      if (!response.ok) {
        lastError = data.error?.message || `HTTP ${response.status}`;
        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        if (retryable && attempt < 2) { await sleep(1200 * (attempt + 1)); continue; }
        throw new Error(lastError);
      }
      const answer = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
      if (!answer) throw new Error(`Gemini returned no text (finish reason: ${data.candidates?.[0]?.finishReason || "unknown"})`);
      return answer;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
      if (attempt < 2 && !lastError.includes("GEMINI_API_KEY_MISSING")) { await sleep(1200 * (attempt + 1)); continue; }
      throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

async function performAnalysis(chatId: number, query: string): Promise<void> {
  await sendMessage(chatId, "JAMALQUANT AI\n\nAnalyse en cours...");
  try {
    const result = await generateAnalysis(query);
    await sendMessage(chatId, `JAMALQUANT AI\n\n${result}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    console.error("Analysis error:", message);
    let userMessage = "Erreur technique pendant l'analyse. Réessaie plus tard.";
    const lower = message.toLowerCase();
    if (message === "GEMINI_API_KEY_MISSING") userMessage = "Clé GEMINI_API_KEY absente dans les variables Railway.";
    else if (message.includes("429") || lower.includes("quota")) userMessage = "Quota Gemini atteint. Vérifie les quotas et la facturation Google AI Studio.";
    else if (message.includes("503") || lower.includes("overloaded")) userMessage = "Le modèle Gemini est temporairement surchargé. Réessaie dans quelques instants.";
    else if (lower.includes("api key not valid") || lower.includes("api_key_invalid")) userMessage = "La clé Gemini est invalide. Vérifie GEMINI_API_KEY dans Railway.";
    else if (message.includes("404")) userMessage = `Modèle Gemini introuvable : ${GEMINI_MODEL}. Vérifie GEMINI_MODEL et les modèles disponibles pour ta clé.`;
    await sendMessage(chatId, `ERREUR IA\n\n${userMessage}`);
  }
}

async function handleCommand(chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  const command = (trimmed.split(/\\s+/)[0] || "").split("@")[0].toLowerCase();
  if (command === "/start") {
    await sendMessage(chatId, `JAMALQUANT AI

Assistant d'analyse des marchés : crypto, Forex, actions et matières premières.

Commandes :
/start — Démarrer
/help — Aide
/status — État de configuration
/analyse BTC — Analyser un actif

Tu peux aussi envoyer directement une question.

Note : aucune cotation temps réel n'est disponible tant qu'une source de données de marché n'est pas connectée.`);
    return;
  }
  if (command === "/help") {
    await sendMessage(chatId, `EXEMPLES

/analyse BTC
/analyse ETH
/analyse EUR/USD
/analyse XAU/USD
/analyse NASDAQ

Tu peux préciser l'horizon : scalping, intraday, swing ou long terme.

Pour une analyse chiffrée fiable, fournis les cours ou un graphique.`);
    return;
  }
  if (command === "/status") {
    await sendMessage(chatId, `ÉTAT DU BOT

Telegram : ${TELEGRAM_TOKEN ? "token configuré" : "token manquant"}
Gemini : ${GEMINI_API_KEY ? "clé configurée" : "clé manquante"}
Modèle : ${GEMINI_MODEL}
Webhook secret : ${WEBHOOK_SECRET ? "configuré" : "non configuré"}`);
    return;
  }
  if (command === "/analyse") {
    const query = trimmed.replace(/^\\/analyse(?:@\\w+)?/i, "").trim();
    if (!query) { await sendMessage(chatId, "Indique un actif. Exemple : /analyse BTC"); return; }
    await performAnalysis(chatId, query);
    return;
  }
  if (trimmed.startsWith("/")) { await sendMessage(chatId, "Commande inconnue. Utilise /help."); return; }
  await performAnalysis(chatId, trimmed);
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return jsonResponse({ service: "JamalQuantBot", status: "online", version: "1.0.0" });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      status: "healthy", telegramConfigured: Boolean(TELEGRAM_TOKEN),
      geminiConfigured: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL,
    });
  }
  if (request.method === "POST" && url.pathname === "/webhook") {
    if (!TELEGRAM_TOKEN) return jsonResponse({ error: "Telegram token missing" }, 500);
    if (WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    let update: TelegramUpdate;
    try { update = (await request.json()) as TelegramUpdate; }
    catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const message = update.message;
    if (!message?.text || !message.chat?.id) return jsonResponse({ ok: true });
    try { await handleCommand(message.chat.id, message.text); }
    catch (error) {
      console.error("Telegram handler error:", error);
      try { await sendMessage(message.chat.id, "Erreur technique du bot. Réessaie dans quelques instants."); }
      catch (sendError) { console.error("Unable to send Telegram error:", sendError); }
    }
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

const port = Number(process.env.PORT || 3000);
Bun.serve({ port, fetch: handleRequest });
console.log(`JamalQuantBot listening on port ${port}`);
