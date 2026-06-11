-- signalk-logbook-auto : schéma SQLite
-- Toutes les tables utilisent IF NOT EXISTS → idempotent au redémarrage du plugin

CREATE TABLE IF NOT EXISTS trips (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  start_timestamp TEXT NOT NULL,
  end_timestamp   TEXT,               -- NULL si trip en cours
  start_lat       REAL,
  start_lon       REAL,
  end_lat         REAL,
  end_lon         REAL,
  distance_nm     REAL,               -- calculé à l'arrivée via Haversine
  status          TEXT DEFAULT 'active'  -- 'active' | 'closed'
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT NOT NULL,          -- ISO 8601
  type         TEXT NOT NULL,
  -- types : 'depart' | 'arrivee' | 'moteur_on' | 'moteur_off'
  --         'gv_change' | 'genois_change' | 'observation' | 'periodic'
  data         TEXT,                   -- JSON sérialisé (état voile, texte observation, etc.)
  lat          REAL,
  lon          REAL,
  sog_ms       REAL,                   -- m/s
  cog_rad      REAL,                   -- radians
  wind_speed   REAL,                   -- m/s
  wind_angle   REAL,                   -- radians
  pressure_pa  REAL,
  temp_k       REAL,
  trip_id      INTEGER REFERENCES trips(id)
);

CREATE TABLE IF NOT EXISTS logbook_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER NOT NULL REFERENCES trips(id),
  timestamp   TEXT NOT NULL,          -- timestamp représentatif du groupe (premier événement)
  summary     TEXT NOT NULL,          -- texte lisible généré par le consolidateur
  event_ids   TEXT NOT NULL,          -- JSON array des event.id consolidés
  lat         REAL,
  lon         REAL,
  conditions  TEXT                    -- JSON : {sog_kts, cog_deg, wind_speed_kts, wind_angle_deg, pressure_hpa, temp_c}
);

-- Index de performance (important sur Pi 3B+ avec CPU lent)
CREATE INDEX IF NOT EXISTS idx_events_trip_id    ON events(trip_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp  ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type       ON events(type);
CREATE INDEX IF NOT EXISTS idx_logbook_trip_id   ON logbook_entries(trip_id);
CREATE INDEX IF NOT EXISTS idx_trips_status      ON trips(status);
