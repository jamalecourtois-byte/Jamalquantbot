# Récupération de production — 6 novembre 2026

## Sources et infrastructure

Les trois services applicatifs du projet Railway `JamalQuantBot` ont été observés en production et leurs sources embarquées dans les commandes de démarrage ont été décodées puis archivées dans le dépôt :

| Service | Source sauvegardée | Rôle |
|---|---|---|
| `jamalquantbot-api` | `services/api/index.ts` | Webhook Telegram, commandes, Mini App, appels IA, appels auto-engine |
| `jamalquant-auto-engine` | `services/auto-engine/index.ts` | Scanner multi-marchés et paper trading |
| `jamalquant-exchange-hub` | `services/exchange-hub/index.ts` | CCXT, cotations, OHLCV, dashboard |
| `Postgres` | service géré Railway | Portefeuilles, historiques, sessions |

Le projet avait un environnement `production`, sans changements Railway en attente. Les trois services applicatifs et PostgreSQL avaient un dernier déploiement déclaré SUCCESS au moment de l'inspection.

## Vérifications observées dans les logs API

Un contrôle d'intégration récent déclarait :
- API en ligne et PostgreSQL connecté ;
- Exchange Hub et auto-engine joignables ;
- webhook Telegram configuré et sans erreur de livraison signalée ;
- 104 connecteurs d'exchange listés ;
- endpoints ticker et OHLCV répondant HTTP 200 ;
- résolution de symbole fonctionnelle ;
- mode `paper-trading-only`.

Les logs de l'auto-engine montrent des scans multi-marchés sur 19 instruments avec `errors: 0`.

Ces observations ne remplacent pas un test interactif complet dans Telegram.

## Cause identifiée pour le bouton « Démarrer » inopérant hors Telegram

Le dashboard récupéré utilise `window.Telegram.WebApp.initData` pour autoriser les actions `auto_start`, `auto_status` et `auto_stop`. Si le dashboard est ouvert dans Safari ou un navigateur externe, `initData` est vide : le code affiche explicitement « Session Telegram absente » et n'envoie pas la commande au serveur.

Le terminal doit donc être ouvert avec le bouton clavier Telegram « Ouvrir terminal 3D + trader » dans une conversation privée avec le bot. L'ouverture de la même URL directement dans Safari ne fournit pas l'identité Mini App requise.

## Gestion de « Session already running »

L'auto-engine contient une protection `cycleBusy` : si un cycle est déjà en cours, un nouvel appel `/cycle` retourne `{ busy: true }` au lieu de lancer un second cycle. La route `/start` est idempotente pour un portefeuille déjà marqué `RUNNING` et retourne `alreadyRunning: true` sans créer une deuxième session.

Le message exact « Session already running » n'apparaît pas dans le code de démarrage récupéré de l'auto-engine. Il peut provenir d'une autre couche d'exécution ou d'une version antérieure. Ne pas le confondre avec la réponse normale `alreadyRunning: true`.

## Limites et prochaines corrections

1. Effectuer un vrai test du bouton depuis Telegram sur iPhone, pas depuis Safari.
2. Vérifier le retour HTTP et la réponse JSON de `/miniapp/auto` pour les trois actions.
3. Vérifier l'état PostgreSQL du portefeuille après start/stop.
4. Ajouter une suite de tests automatisés pour les transitions STOPPED/RUNNING et les appels concurrents.
5. Connecter Railway à ce dépôt GitHub seulement après vérification des chemins et commandes de démarrage par service. Les services Railway observés utilisaient actuellement des commandes Bun embarquées et n'étaient pas reliés à un dépôt GitHub.

## Secrets

Les valeurs de variables Railway ne sont pas copiées dans ce dépôt. Le token Telegram précédemment exposé dans une conversation doit être révoqué auprès de BotFather, puis remplacé dans Railway.
