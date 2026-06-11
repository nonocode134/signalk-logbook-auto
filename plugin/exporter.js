'use strict'

// Helpers de conversion d'unités
const msToKts = ms => ms != null ? +(ms * 1.94384).toFixed(1) : null
const radToDeg = rad => rad != null ? +(rad * 180 / Math.PI).toFixed(0) : null
const paToHpa = pa => pa != null ? +(pa / 100).toFixed(1) : null
const kToC = k => k != null ? +(k - 273.15).toFixed(1) : null

// Génère l'export JSON structuré du livre de bord complet.
// Consolide d'abord les événements non encore traités avant d'exporter.
class Exporter {
  constructor (logger, consolidator) {
    this.logger = logger
    this.consolidator = consolidator
  }

  // Retourne l'objet JSON complet selon le format spec
  export () {
    const trips = this.logger.getAllTrips()
    const result = {
      generated_at: new Date().toISOString(),
      trips: []
    }

    for (const trip of trips) {
      // S'assurer que les entrées sont à jour avant l'export
      this.consolidator.consolidateAll(trip.id)
      result.trips.push(this._exportTrip(trip))
    }

    return result
  }

  _exportTrip (trip) {
    const entries = this.logger.getEntriesWithEvents(trip.id)

    return {
      id: trip.id,
      start: trip.start_timestamp,
      end: trip.end_timestamp || null,
      distance_nm: trip.distance_nm || null,
      status: trip.status,
      start_position: trip.start_lat != null
        ? { lat: trip.start_lat, lon: trip.start_lon }
        : null,
      end_position: trip.end_lat != null
        ? { lat: trip.end_lat, lon: trip.end_lon }
        : null,
      logbook: entries.map(entry => this._exportEntry(entry))
    }
  }

  _exportEntry (entry) {
    // Calculer les conditions moyennes à partir des événements associés
    const events = entry.events || []
    let sog = null, windSpeed = null, windAngle = null, pressure = null, temp = null

    // Préférer les valeurs du log périodique, sinon moyenne des événements
    const periodic = events.find(e => e.type === 'periodic')
    const source = periodic || events.find(e => e.sog_ms != null) || null

    if (source) {
      sog = msToKts(source.sog_ms)
      windSpeed = msToKts(source.wind_speed)
      windAngle = radToDeg(source.wind_angle)
      pressure = paToHpa(source.pressure_pa)
      temp = kToC(source.temp_k)
    }

    return {
      timestamp: entry.timestamp,
      position: entry.lat != null ? { lat: entry.lat, lon: entry.lon } : null,
      summary: entry.summary,
      conditions: {
        sog_kts: sog,
        wind_speed_kts: windSpeed,
        wind_angle_deg: windAngle,
        pressure_hpa: pressure,
        temp_c: temp
      },
      events: events.map(e => e.type)
    }
  }
}

module.exports = Exporter
