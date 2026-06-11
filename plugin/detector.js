'use strict'

// Détection départ/arrivée par compteurs de secondes consécutives.
// Reçoit les mises à jour SOG à ~1 Hz (period: 1000ms dans la subscription SK).
// Anti-rebond : seules des secondes CONSÉCUTIVES comptent — un ralentissement
// bref sous le seuil remet le compteur à zéro.
class Detector {
  constructor (settings, onDepart, onArrivee) {
    // Conversion du seuil de vitesse nœuds → m/s
    this.threshold = (settings.departSpeedKnots || 0.5) * 0.514444

    this.onDepart = onDepart
    this.onArrivee = onArrivee

    this.consecutiveAbove = 0   // secondes où SOG > seuil
    this.consecutiveBelow = 0   // secondes où SOG < seuil
    this.activeTrip = null      // trip SK en cours (objet DB ou null)
  }

  // Appelée à chaque réception d'une valeur SOG depuis la subscription SK.
  // snapshot = { timestamp, sog_ms, lat, lon, cog_rad, wind_speed, wind_angle, pressure_pa, temp_k }
  update (snapshot) {
    const sog = snapshot.sog_ms
    if (sog == null) return

    if (sog > this.threshold) {
      this.consecutiveAbove++
      this.consecutiveBelow = 0

      // Départ confirmé : SOG > seuil pendant 120 s consécutives sans trip actif
      if (this.consecutiveAbove >= 120 && !this.activeTrip) {
        this.consecutiveAbove = 0
        this.onDepart(snapshot)
      }
    } else {
      this.consecutiveBelow++
      this.consecutiveAbove = 0

      // Arrivée confirmée : SOG < seuil pendant 300 s consécutives avec trip actif
      if (this.consecutiveBelow >= 300 && this.activeTrip) {
        this.consecutiveBelow = 0
        this.onArrivee(snapshot)
      }
    }
  }

  setActiveTrip (trip) {
    this.activeTrip = trip
    this.consecutiveAbove = 0
    this.consecutiveBelow = 0
  }

  clearActiveTrip () {
    this.activeTrip = null
    this.consecutiveAbove = 0
    this.consecutiveBelow = 0
  }
}

module.exports = Detector
