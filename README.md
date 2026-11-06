# JamalQuantBot

Archive du code source récupéré dans les anciens échanges ChatGPT le 6 novembre 2026.

## État et limites
- Cette version est un ancien service Telegram écrit en TypeScript pour Bun.
- Elle reçoit les mises à jour Telegram via webhook et utilise Gemini pour générer les réponses.
- Elle ne contient pas encore le moteur de marché, le dashboard, la base PostgreSQL ni les services Railway plus récents mentionnés dans le projet.
- Elle ne récupère pas de cotations en temps réel : le prompt l'indique explicitement.
- Ce dépôt sert de sauvegarde de départ ; ne pas le considérer comme la version complète actuellement déployée.

## Variables d'environnement
- TELEGRAM_BOT_TOKEN
- GEMINI_API_KEY
- GEMINI_MODEL (défaut : gemini-2.5-flash)
- WEBHOOK_SECRET (optionnel)
- PORT (défaut : 3000)

## Exécution
Nécessite Bun. Installer les dépendances (aucune dépendance externe dans cette version), puis lancer :
```bash
bun run index.ts
```

Webhook attendu : POST /webhook. Santé : GET /health.

## Sécurité
Ne jamais committer de token Telegram, clé Gemini ou secret. Utiliser les variables d'environnement du fournisseur d'hébergement. Le token Telegram précédemment partagé dans une conversation doit être révoqué auprès de BotFather et remplacé.
