'use strict'

const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

// Couche persistance SQLite — toutes les méthodes sont synchrones (better-sqlite3)
class Logger {
  constructor (dbPath) {
    this.db = new Database(dbPath)
    // WAL = Write-Ahead Logging : évite les locks sur Pi 3B+ à faible RAM
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
    this.db.exec(schema)

    // Migration : ajout colonne conditions si absente (base existante)
    try { this.db.exec('ALTER TABLE logbook_entries ADD COLUMN conditions TEXT') } catch (_) {}

    this._prepare()
  }

  _prepare () {
    const db = this.db
    this.stmts = {
      insertEvent: db.prepare(`
        INSERT INTO events (timestamp, type, data, lat, lon, sog_ms, cog_rad,
          wind_speed, wind_angle, pressure_pa, temp_k, trip_id)
        VALUES (@timestamp, @type, @data, @lat, @lon, @sog_ms, @cog_rad,
          @wind_speed, @wind_angle, @pressure_pa, @temp_k, @trip_id)
      `),
      createTrip: db.prepare(`
        INSERT INTO trips (start_timestamp, start_lat, start_lon, status)
        VALUES (@start_timestamp, @start_lat, @start_lon, 'active')
      `),
      closeTrip: db.prepare(`
        UPDATE trips SET end_timestamp=@end_timestamp, end_lat=@end_lat,
          end_lon=@end_lon, distance_nm=@distance_nm, status='closed'
        WHERE id=@id
      `),
      getActiveTrip: db.prepare(`
        SELECT * FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1
      `),
      insertLogbookEntry: db.prepare(`
        INSERT INTO logbook_entries (trip_id, timestamp, summary, event_ids, lat, lon, conditions)
        VALUES (@trip_id, @timestamp, @summary, @event_ids, @lat, @lon, @conditions)
      `),
      getLogbookEntries: db.prepare(`
        SELECT * FROM logbook_entries WHERE trip_id=@trip_id
        ORDER BY timestamp ASC LIMIT @limit
      `),
      getRecentEntries: db.prepare(`
        SELECT * FROM logbook_entries ORDER BY timestamp DESC LIMIT @limit
      `),
      getRecentEntriesWithTrip: db.prepare(`
        SELECT le.*, t.start_lat AS trip_start_lat, t.start_lon AS trip_start_lon
        FROM logbook_entries le
        LEFT JOIN trips t ON le.trip_id = t.id
        ORDER BY le.timestamp DESC LIMIT @limit
      `),
      getEventsByTrip: db.prepare(`
        SELECT * FROM events WHERE trip_id=@trip_id ORDER BY timestamp ASC
      `),
      getTripsAll: db.prepare(`
        SELECT * FROM trips ORDER BY start_timestamp DESC
      `),
      getEntriesForTrip: db.prepare(`
        SELECT * FROM logbook_entries WHERE trip_id=@trip_id ORDER BY timestamp ASC
      `),
      // Cherche l'entrée existante pour une fenêtre donnée.
      // window_key = floor(unixMs / windowMs), divisor = windowMs/1000 (en secondes)
      getEntryForWindow: db.prepare(`
        SELECT * FROM logbook_entries
        WHERE trip_id=@trip_id
          AND CAST(strftime('%s', timestamp) AS INTEGER) / CAST(@divisor AS INTEGER) = @window_key
        LIMIT 1
      `),
      updateLogbookEntry: db.prepare(`
        UPDATE logbook_entries SET summary=@summary, event_ids=@event_ids, conditions=@conditions WHERE id=@id
      `),
      // Tous les events d'une fenêtre (même diviseur que ci-dessus)
      getEventsForWindow: db.prepare(`
        SELECT * FROM events
        WHERE trip_id=@trip_id
          AND CAST(strftime('%s', timestamp) AS INTEGER) / CAST(@divisor AS INTEGER) = @window_key
        ORDER BY timestamp ASC
      `),
      getEventById: db.prepare(`SELECT * FROM events WHERE id=?`)
    }
  }

  // Insère un événement brut, retourne l'id inséré
  insertEvent (evt) {
    const row = {
      timestamp: evt.timestamp || new Date().toISOString(),
      type: evt.type,
      data: evt.data != null ? JSON.stringify(evt.data) : null,
      lat: evt.lat ?? null,
      lon: evt.lon ?? null,
      sog_ms: evt.sog_ms ?? null,
      cog_rad: evt.cog_rad ?? null,
      wind_speed: evt.wind_speed ?? null,
      wind_angle: evt.wind_angle ?? null,
      pressure_pa: evt.pressure_pa ?? null,
      temp_k: evt.temp_k ?? null,
      trip_id: evt.trip_id ?? null
    }
    const result = this.stmts.insertEvent.run(row)
    return result.lastInsertRowid
  }

  // Crée un nouveau trip, retourne son id
  createTrip ({ start_timestamp, start_lat, start_lon }) {
    const result = this.stmts.createTrip.run({ start_timestamp, start_lat, start_lon })
    return result.lastInsertRowid
  }

  // Ferme un trip existant avec position finale et distance
  closeTrip ({ id, end_timestamp, end_lat, end_lon, distance_nm }) {
    this.stmts.closeTrip.run({ id, end_timestamp, end_lat, end_lon, distance_nm })
  }

  // Retourne le trip actif ou null
  getActiveTrip () {
    return this.stmts.getActiveTrip.get() || null
  }

  // Écrit un log périodique (appelé toutes les 15 min par le timer de index.js)
  writePeriodicLog (snapshot, trip_id) {
    return this.insertEvent({
      ...snapshot,
      type: 'periodic',
      trip_id
    })
  }

  // Insère une entrée consolidée de livre de bord
  insertLogbookEntry ({ trip_id, timestamp, summary, event_ids, lat, lon, conditions }) {
    const result = this.stmts.insertLogbookEntry.run({
      trip_id,
      timestamp,
      summary,
      event_ids: JSON.stringify(event_ids),
      lat: lat ?? null,
      lon: lon ?? null,
      conditions: conditions != null ? JSON.stringify(conditions) : null
    })
    return result.lastInsertRowid
  }

  // Retourne les entrées du livre de bord pour un trip
  getLogbookEntries (trip_id, limit = 50) {
    return this.stmts.getLogbookEntries.all({ trip_id, limit })
  }

  // Retourne les N dernières entrées (tous trips confondus)
  getRecentLogbookEntries (limit = 10) {
    return this.stmts.getRecentEntries.all({ limit })
  }

  // Retourne les N dernières entrées avec la position de départ du trip (pour calcul distance)
  getRecentLogbookEntriesJoined (limit = 10) {
    return this.stmts.getRecentEntriesWithTrip.all({ limit })
  }

  // Retourne tous les événements bruts d'un trip
  getEventsByTrip (trip_id) {
    return this.stmts.getEventsByTrip.all({ trip_id })
  }

  // Toutes les entrées d'un trip sans limite (pour consolidateAll)
  getAllLogbookEntries (trip_id) {
    return this.stmts.getEntriesForTrip.all({ trip_id })
  }

  // Entrée existante pour une fenêtre donnée
  // divisor = windowMs/1000 (secondes), doit correspondre à celui utilisé pour windowKey
  getEntryForWindow (trip_id, windowKey, divisor) {
    return this.stmts.getEntryForWindow.get({ trip_id, window_key: windowKey, divisor }) || null
  }

  // Met à jour le résumé et la liste d'événements d'une entrée existante
  updateLogbookEntry (id, { summary, event_ids, conditions }) {
    this.stmts.updateLogbookEntry.run({
      id,
      summary,
      event_ids: JSON.stringify(event_ids),
      conditions: conditions != null ? JSON.stringify(conditions) : null
    })
  }

  // Tous les événements d'une fenêtre donnée
  getEventsForWindow (trip_id, windowKey, divisor) {
    return this.stmts.getEventsForWindow.all({ trip_id, window_key: windowKey, divisor })
  }

  // Retourne tous les trips (pour l'export JSON)
  getAllTrips () {
    return this.stmts.getTripsAll.all()
  }

  // Retourne les entrées avec leurs événements pour l'export
  getEntriesWithEvents (trip_id) {
    const entries = this.stmts.getEntriesForTrip.all({ trip_id })
    return entries.map(entry => {
      const ids = JSON.parse(entry.event_ids || '[]')
      const events = ids.map(id => this.stmts.getEventById.get(id)).filter(Boolean)
      return { ...entry, events }
    })
  }

  // Retourne un trip par id
  getTripById (id) {
    return this.db.prepare('SELECT * FROM trips WHERE id = ?').get(id) || null
  }

  // Supprime trips + leurs events + leurs entrées logbook dans une transaction
  deleteTrips (ids) {
    const ph = ids.map(() => '?').join(',')
    const tx = this.db.transaction((ids) => {
      this.db.prepare(`DELETE FROM logbook_entries WHERE trip_id IN (${ph})`).run(ids)
      this.db.prepare(`DELETE FROM events WHERE trip_id IN (${ph})`).run(ids)
      this.db.prepare(`DELETE FROM trips WHERE id IN (${ph})`).run(ids)
    })
    tx(ids)
  }

  // Retourne trips + leurs entrées logbook pour export JSON
  getTripsForExport (ids) {
    const ph = ids.map(() => '?').join(',')
    const trips = this.db.prepare(
      `SELECT * FROM trips WHERE id IN (${ph}) ORDER BY start_timestamp ASC`
    ).all(ids)
    return trips.map(trip => {
      const entries = this.getAllLogbookEntries(trip.id).map(e => ({
        ...e,
        conditions: e.conditions ? JSON.parse(e.conditions) : null,
        event_ids: JSON.parse(e.event_ids || '[]')
      }))
      return { ...trip, logbook: entries }
    })
  }

  // Ferme proprement la connexion DB (appelé dans plugin.stop())
  close () {
    if (this.db && this.db.open) {
      this.db.close()
    }
  }
}

module.exports = Logger
