'use strict'

// Consolide les événements bruts en entrées lisibles de livre de bord.
//
// Deux modes :
//   consolidateWindow(tripId, windowKey) — O(1), appelé après chaque action UI
//   consolidateAll(tripId)              — O(N fenêtres), appelé par le timer 5 min et à l'arrivée
//
// Dans les deux cas : upsert (UPDATE si l'entrée existe, INSERT sinon).
class Consolidator {
  constructor (logger, windowMs = 300000) {
    this.logger = logger
    this.windowMs = windowMs
    this.divisor = Math.round(windowMs / 1000)  // secondes, pour les requêtes SQLite
  }

  // O(1) — consolide uniquement la fenêtre courante.
  // windowKey = Math.floor(Date.now() / windowMs)
  consolidateWindow (tripId, windowKey) {
    const events = this.logger.getEventsForWindow(tripId, windowKey, this.divisor)
    if (events.length === 0) return
    const existing = this.logger.getEntryForWindow(tripId, windowKey, this.divisor)
    this._upsert(tripId, events, existing)
  }

  // O(N fenêtres) — passe complète sur tous les événements du trip.
  // Optimisé : 2 requêtes SQL bulk + N upserts (pas de SELECT par fenêtre).
  consolidateAll (tripId) {
    const allEvents = this.logger.getEventsByTrip(tripId)
    if (allEvents.length === 0) return

    // Charger toutes les entrées existantes en une seule requête,
    // les indexer par clé de fenêtre pour éviter un SELECT par fenêtre.
    const existing = this.logger.getAllLogbookEntries(tripId)
    const entryByWindow = new Map()
    for (const entry of existing) {
      const key = Math.floor(Date.parse(entry.timestamp) / this.windowMs)
      entryByWindow.set(key, entry)
    }

    const windows = this._groupByWindow(allEvents)
    for (const [windowKey, events] of windows) {
      this._upsert(tripId, events, entryByWindow.get(windowKey) || null)
    }
  }

  // Upsert d'une fenêtre : UPDATE si entrée existante, INSERT sinon.
  // Les entrées no_aggregate (MOB) ne sont jamais écrasées.
  _upsert (tripId, events, existing) {
    if (existing && existing.no_aggregate) return
    const summary = this._buildSummary(events)
    const eventIds = events.map(e => e.id)
    const conditions = this._bestConditions(events)
    if (existing) {
      this.logger.updateLogbookEntry(existing.id, { summary, event_ids: eventIds, conditions })
    } else {
      const first = events[0]
      const posSource = events.find(e => e.lat != null) || first
      this.logger.insertLogbookEntry({
        trip_id: tripId,
        timestamp: first.timestamp,
        summary,
        event_ids: eventIds,
        lat: posSource.lat,
        lon: posSource.lon,
        conditions
      })
    }
  }

  // Retourne les meilleures conditions capteurs de la fenêtre, converties en unités affichables.
  // Préfère l'événement periodic (snapshot complet), puis le premier événement avec des données.
  _bestConditions (events) {
    const periodic = events.find(e => e.type === 'periodic')
    const source = periodic || events.find(e => e.sog_ms != null || e.wind_speed != null)
    if (!source) return null
    return {
      sog_kts: source.sog_ms != null ? +(source.sog_ms * 1.94384).toFixed(1) : null,
      cog_deg: source.cog_rad != null ? +(source.cog_rad * 180 / Math.PI).toFixed(0) : null,
      wind_speed_kts: source.wind_speed != null ? +(source.wind_speed * 1.94384).toFixed(0) : null,
      wind_angle_deg: source.wind_angle != null ? +(source.wind_angle * 180 / Math.PI).toFixed(0) : null,
      pressure_hpa: source.pressure_pa != null ? +(source.pressure_pa / 100).toFixed(0) : null,
      temp_c: source.temp_k != null ? +(source.temp_k - 273.15).toFixed(1) : null
    }
  }

  // Regroupe les événements par fenêtres de taille windowMs
  _groupByWindow (events) {
    const windows = new Map()
    for (const evt of events) {
      const key = Math.floor(Date.parse(evt.timestamp) / this.windowMs)
      if (!windows.has(key)) windows.set(key, [])
      windows.get(key).push(evt)
    }
    return windows
  }

  // Génère le résumé texte d'un groupe d'événements dans une fenêtre
  _buildSummary (events) {
    const hour = new Date(events[0].timestamp)
      .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      .replace(':', 'h')

    const parts = []

    // Un seul représentant par type, dans l'ordre de priorité d'affichage.
    // Pour gv_change/genois_change/observation on prend le DERNIER (état le plus récent).
    const first = {}
    const last = {}
    for (const e of events) {
      if (!first[e.type]) first[e.type] = e
      last[e.type] = e
    }

    if (first.depart)  parts.push('Départ')
    if (first.arrivee) parts.push('Arrivée')

    // Moteur : seul le dernier état de la fenêtre est affiché (comme les voiles)
    let lastMotor = null
    for (const e of events) {
      if (e.type === 'moteur_on' || e.type === 'moteur_off') lastMotor = e
    }
    if (lastMotor) parts.push(lastMotor.type === 'moteur_on' ? 'Moteur ON' : 'Moteur OFF')

    if (last.gv_change) {
      try { parts.push(this._sailLabel('GV', JSON.parse(last.gv_change.data || '{}'))) } catch (_) {}
    }
    if (last.genois_change) {
      try { parts.push(this._sailLabel('Génois', JSON.parse(last.genois_change.data || '{}'))) } catch (_) {}
    }

    // Toutes les observations de la fenêtre (pas uniquement la dernière)
    const obs = events.filter(e => e.type === 'observation')
    for (const o of obs) {
      try { parts.push(`Obs : '${JSON.parse(o.data || '{}').text || ''}'`) } catch (_) {}
    }

    if (last.periodic) {
      const e = last.periodic
      const sogKts  = e.sog_ms      != null ? (e.sog_ms * 1.94384).toFixed(1) + ' kts' : '---'
      const windKts = e.wind_speed  != null ? (e.wind_speed * 1.94384).toFixed(0) + ' kts' : '---'
      const windDeg = e.wind_angle  != null ? (e.wind_angle * 180 / Math.PI).toFixed(0) + '°' : '---'
      const hpa     = e.pressure_pa != null ? (e.pressure_pa / 100).toFixed(0) + ' hPa' : '---'
      parts.push(`Log · SOG ${sogKts} · Vent ${windKts} / ${windDeg} · ${hpa}`)
    }

    if (parts.length === 0) parts.push('Événement')
    return `${hour} — ${parts.join(' · ')}`
  }

  _sailLabel (name, data) {
    if (data.furled || data.active === false) return `${name} Affalée`
    if (data.reefs === 0) return `${name} Full ▲`
    return `${name} ${data.reefs} ris`
  }
}

module.exports = Consolidator
