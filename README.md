# signalk-logbook-auto

Plugin Signal K de livre de bord automatique pour voilier.

Détecte les navigations via GPS, loggue toutes les 15 minutes, consolide les événements en entrées lisibles, et expose une interface web tactile style traceur Garmin.

---

## Prérequis

- Signal K Server 2.x installé globalement (`/usr/bin/signalk-server`)
- Node.js 22 (via NodeSource)
- Sur Raspberry Pi 3B+ : build tools pour compiler `better-sqlite3`
  ```bash
  sudo apt install build-essential python3-dev
  ```

---

## Installation

### Production — Raspberry Pi (depuis GitHub)

Le plugin s'installe directement depuis GitHub dans le répertoire Signal K de l'utilisateur `admin`.

```bash
# 1. Installer le plugin depuis GitHub
#    (compile better-sqlite3 depuis les sources automatiquement sur ARM)
cd /home/admin/.signalk
npm install nonocode134/signalk-logbook-auto --build-from-source

# 2. Redémarrer Signal K
sudo systemctl restart signalk
```

Le plugin apparaît ensuite dans l'interface admin Signal K → Plugins.

> La compilation de `better-sqlite3` prend quelques minutes sur Pi 3B+, c'est normal.

#### Mise à jour

```bash
cd /home/admin/.signalk
npm install nonocode134/signalk-logbook-auto --build-from-source
sudo systemctl restart signalk
```

---

### Développement (macBook)

```bash
# 1. Installer les dépendances
cd signalk-logbook-auto
npm install

# 2. Lier le plugin au serveur SK local
npm link
cd ~/.signalk
npm link signalk-logbook-auto

# 3. (Optionnel) Simulateur de capteurs
cd /chemin/vers/signalk-fake-sensors
npm install && npm link
cd ~/.signalk
npm link signalk-fake-sensors

# 4. Démarrer le serveur
signalk-server
# ou avec données NMEA synthétiques :
signalk-server --sample-n2k-data
```

> **Important** : ne pas installer `signalk-fake-sensors` sur le Pi en production.

---

## Interface web

Le plugin est enregistré comme webapp Signal K et apparaît dans l'**App Dock** de l'interface SK.

URL directe :

```
http://pi.local:3000/signalk-logbook-auto/
```

ou en développement :

```
http://localhost:3000/signalk-logbook-auto/
```

> L'ancienne URL `/logbook/` redirige automatiquement vers la nouvelle (301).

---

## Configuration

Dans l'interface admin Signal K → Plugins → Logbook Auto :

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `departSpeedKnots` | 0.5 | Vitesse seuil de détection de départ (nœuds) |
| `logIntervalMinutes` | 15 | Intervalle du log périodique automatique |
| `consolidationWindowMin` | 5 | Fenêtre de regroupement des événements (minutes) |

---

## API REST

Base URL : `/plugins/signalk-logbook-auto`

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/logbook` | Export JSON complet (tous les trips) |
| GET | `/api/logbook/recent` | 10 dernières entrées du journal |
| GET | `/api/status` | État courant (trip, moteur, voiles, capteurs) |
| POST | `/api/state` | Changer l'état moteur ou voiles |
| POST | `/api/observation` | Ajouter une observation manuelle |

### POST /api/state — exemples

```json
// Moteur
{ "type": "moteur", "value": "on" }
{ "type": "moteur", "value": "off" }

// Grande voile
{ "type": "gv", "value": { "reefs": 0, "active": true, "furled": false } }   // full
{ "type": "gv", "value": { "reefs": 2, "active": true, "furled": false } }   // 2 ris
{ "type": "gv", "value": { "reefs": 0, "active": false, "furled": true } }   // affalée

// Génois (même structure, type "genois")
```

### POST /api/observation

```json
{ "text": "Grain en vue au NW, empannage préventif" }
```

---

## Base de données

SQLite stockée dans : `~/.signalk/plugin-config-data/signalk-logbook-auto/logbook.db`

Tables : `trips`, `events`, `logbook_entries` — voir `db/schema.sql`.

---

## Paths Signal K gérés

Le plugin **lit** : `navigation.speedOverGround`, `navigation.position`, `navigation.courseOverGroundTrue`, `environment.wind.*`, `environment.outside.*`

Le plugin **écrit** : `navigation.state`, `propulsion.main.state`, `sails.inventory.main.*`, `sails.inventory.headsail.*`

---

## Dépannage

**Le plugin ne démarre pas :**
- Vérifier que `signalk-node-server-plugin` est bien dans les `keywords` du `package.json` (déjà présent)
- Vérifier les logs : `journalctl -u signalk -f` ou console du serveur

**`better-sqlite3` échoue à compiler sur Pi :**
- `sudo apt install build-essential python3-dev`
- `npm install --build-from-source`

**L'interface web affiche des `---` partout :**
- Vérifier que des capteurs émettent des données (tester avec `signalk-fake-sensors` en dev)
- Ouvrir la console du navigateur → vérifier les erreurs WebSocket

**Aucune détection de départ :**
- Le SOG doit dépasser le seuil (`departSpeedKnots`, défaut 0.5 kt) pendant **120 secondes consécutives**
- Avec `signalk-fake-sensors`, attendre ~2 min après le démarrage
