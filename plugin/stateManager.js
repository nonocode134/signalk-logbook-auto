'use strict'

// Gère l'état moteur et voiles. Persiste via les événements SQLite —
// l'état est reconstruit depuis la DB au démarrage du plugin (survit aux redémarrages).
class StateManager {
  constructor (app, logger, pluginId) {
    this.app = app
    this.logger = logger
    this.pluginId = pluginId

    this.motorState = 'stopped'           // 'started' | 'stopped'
    this.navState = 'moored'              // 'sailing' | 'motoring' | 'moored'
    this.gv = { active: false, reefs: 0, furled: true }
    this.genois = { active: false, reefs: 0, furled: true }
    this.currentTripId = null
  }

  // Reconstruit l'état depuis les derniers événements DB (appelé dans index.js au start)
  recoverState (tripId) {
    this.currentTripId = tripId || null
    if (!this.currentTripId) {
      this._updateNavState()
      return
    }

    const events = this.logger.getEventsByTrip(this.currentTripId)
    let lastMotor = null, lastGV = null, lastGenois = null

    for (const evt of events) {
      if (evt.type === 'moteur_on' || evt.type === 'moteur_off') lastMotor = evt
      else if (evt.type === 'gv_change') lastGV = evt
      else if (evt.type === 'genois_change') lastGenois = evt
    }

    if (lastMotor) this.motorState = lastMotor.type === 'moteur_on' ? 'started' : 'stopped'
    if (lastGV?.data) { try { Object.assign(this.gv, JSON.parse(lastGV.data)) } catch (_) {} }
    if (lastGenois?.data) { try { Object.assign(this.genois, JSON.parse(lastGenois.data)) } catch (_) {} }

    this._updateNavState()
    this._emitSKPaths()
  }

  setCurrentTrip (tripId) {
    this.currentTripId = tripId
  }

  // type = 'on' | 'off'
  setMotor (value, timestamp, snapshot = {}) {
    const isOn = value === 'on'
    this.motorState = isOn ? 'started' : 'stopped'
    this.logger.insertEvent({
      timestamp: timestamp || new Date().toISOString(),
      type: isOn ? 'moteur_on' : 'moteur_off',
      trip_id: this.currentTripId,
      ...this._sensorFields(snapshot)
    })
    this._updateNavState()
    this._emitSKPaths()
    return { ok: true }
  }

  // state = { reefs: 0-3, active: bool, furled: bool }
  // reefs: 0=full, 1-3=ris, furled=true signifie voile affalée
  setGV (state, timestamp, snapshot = {}) {
    Object.assign(this.gv, state)
    this.logger.insertEvent({
      timestamp: timestamp || new Date().toISOString(),
      type: 'gv_change',
      data: this.gv,
      trip_id: this.currentTripId,
      ...this._sensorFields(snapshot)
    })
    this._updateNavState()
    this._emitSKPaths()
    return { ok: true }
  }

  setGenois (state, timestamp, snapshot = {}) {
    Object.assign(this.genois, state)
    this.logger.insertEvent({
      timestamp: timestamp || new Date().toISOString(),
      type: 'genois_change',
      data: this.genois,
      trip_id: this.currentTripId,
      ...this._sensorFields(snapshot)
    })
    this._updateNavState()
    this._emitSKPaths()
    return { ok: true }
  }

  addObservation (text, timestamp, snapshot = {}) {
    this.logger.insertEvent({
      timestamp: timestamp || new Date().toISOString(),
      type: 'observation',
      data: { text },
      trip_id: this.currentTripId,
      ...this._sensorFields(snapshot)
    })
    return { ok: true }
  }

  _sensorFields (s) {
    return {
      lat: s.lat ?? null,
      lon: s.lon ?? null,
      sog_ms: s.sog_ms ?? null,
      cog_rad: s.cog_rad ?? null,
      wind_speed: s.wind_speed ?? null,
      wind_angle: s.wind_angle ?? null,
      pressure_pa: s.pressure_pa ?? null,
      temp_k: s.temp_k ?? null
    }
  }

  getStatus () {
    return {
      motorState: this.motorState,
      navState: this.navState,
      gv: { ...this.gv },
      genois: { ...this.genois },
      currentTripId: this.currentTripId
    }
  }

  _updateNavState () {
    const sailing = this.gv.active || this.genois.active
    if (!this.currentTripId) {
      this.navState = 'moored'
    } else if (this.motorState === 'started') {
      this.navState = 'motoring'
    } else if (sailing) {
      this.navState = 'sailing'
    } else {
      this.navState = 'moored'
    }
  }

  _emitSKPaths () {
    this.app.handleMessage(this.pluginId, {
      updates: [{
        values: [
          { path: 'propulsion.main.state', value: this.motorState },
          { path: 'navigation.state', value: this.navState },
          { path: 'sails.inventory.main.active', value: this.gv.active },
          { path: 'sails.inventory.main.reefs', value: this.gv.reefs },
          { path: 'sails.inventory.main.furled', value: this.gv.furled },
          { path: 'sails.inventory.headsail.active', value: this.genois.active },
          { path: 'sails.inventory.headsail.reefs', value: this.genois.reefs },
          { path: 'sails.inventory.headsail.furled', value: this.genois.furled }
        ]
      }]
    })
  }
}

module.exports = StateManager
