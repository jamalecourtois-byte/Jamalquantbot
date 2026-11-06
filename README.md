# JamalQuantBot

Dépôt de sauvegarde et de maintenance du projet JamalQuantBot.

## Sources récupérées depuis Railway

Le 6 novembre 2026, les sources des trois services actuellement configurés dans le projet Railway `JamalQuantBot` ont été récupérées depuis leurs commandes de démarrage et archivées ici :

- `services/api/index.ts` — API Telegram, webhook, commandes, Mini App, authentification Telegram et intégration de l'auto-engine.
- `services/auto-engine/index.ts` — moteur multi-marchés en paper trading, scans et gestion des portefeuilles simulés.
- `services/exchange-hub/index.ts` — passerelle CCXT, cotations, OHLCV et dashboard graphique.
- Chaque service possède son propre `package.json`.

Les fichiers `index.ts` et `README.md` à la racine sont l'ancienne version simple du bot, conservée à titre d'archive. Pour la version Railway actuelle, se référer aux dossiers `services/`.

## Architecture de production observée

- Railway service `jamalquantbot-api`
- Railway service `jamalquant-auto-engine`
- Railway service `jamalquant-exchange-hub`
- PostgreSQL Railway

Les trois services applicatifs utilisent Bun. Les données de portefeuille et d'historique de simulation sont stockées dans PostgreSQL.

## Configuration

Les secrets sont fournis via les variables d'environnement Railway. Ne jamais les inscrire dans Git.

Variables principales observées :
- API : `BOT_TOKEN`, `DATABASE_URL`, `WEBHOOK_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `AUTO_ENGINE_URL`, `AUTO_ENGINE_SECRET`, `EXCHANGE_HUB_URL`.
- Auto-engine : `BOT_TOKEN`, `DATABASE_URL`, `AUTO_ENGINE_SECRET`.
- Exchange Hub : aucune clé de courtier requise pour les flux publics.

Voir `docs/PRODUCTION-RECOVERY.md` pour l'état et les limites connus.

## Sécurité et limites

- Le moteur est en **paper trading uniquement**. Aucun ordre réel n'est envoyé.
- Les connecteurs de courtiers listés ne signifient pas qu'un compte de courtage est connecté.
- Le token Telegram précédemment partagé dans une conversation doit être révoqué avec BotFather et remplacé dans Railway.
- Ne jamais committer de token, clé API, secret webhook ou URL de base de données.
