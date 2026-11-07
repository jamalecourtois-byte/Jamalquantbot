# Connecteurs privés universels (CCXT)

Le hub expose l'adaptateur public CCXT et peut reconnaître toutes les plateformes présentes dans la version installée de la bibliothèque. Cela ne signifie pas que chaque plateforme ou produit (spot, marge, futures, options) est identique ou disponible : les capacités doivent être vérifiées par exchange.

## Sécurité actuelle

- Les clés restent exclusivement dans les variables d'environnement Railway. Ne jamais les mettre dans Git, le navigateur, Telegram ou les logs.
- Le service exige `CONNECTOR_ADMIN_TOKEN` (minimum 32 caractères) pour toutes les routes `/private/*`.
- Les identifiants sont définis par plateforme : `EXCHANGE_<ID>_API_KEY`, `EXCHANGE_<ID>_API_SECRET`, et si nécessaire `EXCHANGE_<ID>_PASSWORD`, `EXCHANGE_<ID>_UID`, `EXCHANGE_<ID>_DEFAULT_TYPE`.
- Exemple pour Binance : `EXCHANGE_BINANCE_API_KEY`, `EXCHANGE_BINANCE_API_SECRET`.
- Créer des clés API avec lecture seule au départ, sans retrait et sans transfert. Activer une liste blanche IP sur la plateforme.
- Ne pas réutiliser une clé entre plateformes. Révoquer immédiatement toute clé exposée.
- Les secrets sont lus côté serveur et ne sont jamais renvoyés au client.

## Routes internes

Toutes les routes exigent `Authorization: Bearer <CONNECTOR_ADMIN_TOKEN>`.

- `GET /private/connectors` : liste les exchanges CCXT et ceux dont les identifiants sont configurés.
- `POST /private/account` avec `{"exchange":"binance"}` : vérifie l'accès privé et renvoie les soldes non nuls, sans exposer les secrets.

## Limite volontaire

Cette première intégration est en **lecture seule** : aucun endpoint d'ordre n'existe, aucun ordre réel ne peut être soumis et `tradingEnabled` reste faux. Ne pas activer des droits de trading sur les clés avant une revue indépendante des contrôles de risque, de l'idempotence, de la précision des quantités/prix, du minimum notionnel, du mode hedge/one-way, du levier, du margin mode, des ordres partiellement exécutés et du coupe-circuit. Les brokers non pris en charge par CCXT nécessitent un adaptateur natif distinct.

La prise en charge dépend de CCXT et des capacités déclarées par chaque exchange ; le catalogue ne garantit ni l'ouverture d'un compte, ni l'accès à un marché, ni la disponibilité géographique ou réglementaire.


## Commandes Telegram (administrateur)

- `/monid` : affiche l'identifiant numérique Telegram à autoriser.
- `/connecteurs` : affiche le nombre d'exchanges supportés et ceux dont les clés serveur sont configurées.
- `/compte binance` : vérifie un compte en lecture seule et affiche les soldes non nuls. Cette commande fonctionne uniquement en conversation privée et pour les identifiants présents dans `CONNECTOR_ADMIN_TELEGRAM_IDS` (liste séparée par des virgules).

Le secret `CONNECTOR_ADMIN_TOKEN` est partagé uniquement entre l'API Telegram et l'Exchange Hub via les variables Railway. Il ne doit jamais être communiqué à l'utilisateur ni envoyé dans Telegram. Les clés exchange restent à ajouter dans les variables Railway du service Exchange Hub. L'absence de clés signifie qu'aucun compte n'est connecté.
