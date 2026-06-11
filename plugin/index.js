'use strict'

const fs = require('fs')
const path = require('path')

// Sert les fichiers statiques sans dépendre d'express.static
// (Express n'est pas une dépendance directe du plugin)
function createStaticHandler (dir) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png'
  }
  return function (req, res, next) {
    const rel = req.path === '/' ? '/index.html' : req.path
    const file = path.join(dir, rel)
    // Protection contre le path traversal
    if (!file.startsWith(dir + path.sep) && file !== dir) return next()
    fs.readFile(file, (err, data) => {
      if (err) {
        // Fallback : essaie avec l'extension .html pour les URLs propres (/history → history.html)
        if (!path.extname(rel)) {
          const fileHtml = file + '.html'
          if (!fileHtml.startsWith(dir + path.sep)) return next()
          return fs.readFile(fileHtml, (err2, data2) => {
            if (err2) return next()
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('Cache-Control', 'public, max-age=300')
            res.end(data2)
          })
        }
        return next()
      }
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.end(data)
    })
  }
}

const Logger = require('./logger')
const Detector = require('./detector')
const StateManager = require('./stateManager')
const Consolidator = require('./consolidator')
const Exporter = require('./exporter')

module.exports = (app) => {
  // Le chemin /plugins/<id>/ est réservé par SK pour ses métadonnées JSON.
  // On monte le handler statique une seule fois au chargement du module,
  // sur un chemin libre, avant que start()/stop() soient jamais appelés.
  app.use('/logbook', createStaticHandler(path.join(__dirname, '../public')))

  // Variables réinitialisées à chaque appel de start()
  let logger = null
  let detector = null
  let stateManager = null
  let windowMs = 300000  // taille de fenêtre en ms, mise à jour dans start()
  let consolidator = null
  let exporter = null
  let unsubscribes = []
  let periodicTimer = null
  let consolidationTimer = null
  let currentSnapshot = {}   // dernières valeurs capteurs reçues (point instantané)

  // Buffers glissants pour moyennes 2 min (SOG 1 Hz = 120 samples, vent 5 s = 24 samples)
  const SOG_BUF  = 120
  const WIND_BUF = 24
  let sogBuffer       = []
  let windSpeedBuffer = []
  let windAngleBuffer = []

  const plugin = {
    id: 'signalk-logbook-auto',
    name: 'Logbook Auto',

    schema: {
      type: 'object',
      properties: {
        departSpeedKnots: {
          type: 'number',
          title: 'Vitesse seuil de départ (nœuds)',
          default: 0.5
        },
        logIntervalMinutes: {
          type: 'number',
          title: 'Intervalle de log périodique (minutes)',
          default: 15
        },
        consolidationWindowMin: {
          type: 'number',
          title: 'Fenêtre de consolidation (minutes)',
          default: 5
        }
      }
    },

    start: (settings) => {
      const dataDir = app.getDataDirPath()
      const dbPath = path.join(dataDir, 'logbook.db')

      try {
        logger = new Logger(dbPath)
      } catch (e) {
        app.setPluginError('Erreur ouverture SQLite : ' + e.message)
        return
      }

      windowMs = (settings.consolidationWindowMin || 5) * 60 * 1000
      stateManager = new StateManager(app, logger, plugin.id)
      consolidator = new Consolidator(logger, windowMs)
      exporter = new Exporter(logger, consolidator)

      detector = new Detector(settings, _onDepart, _onArrivee)

      // Reprendre un trip actif si le plugin a été redémarré en cours de navigation
      const activeTrip = logger.getActiveTrip()
      if (activeTrip) {
        detector.setActiveTrip(activeTrip)
        stateManager.recoverState(activeTrip.id)
        app.setPluginStatus(`En navigation · Trip #${activeTrip.id}`)
      } else {
        stateManager.recoverState(null)
        app.setPluginStatus('En attente de navigation')
      }

      // S'abonner aux paths SK — SOG à 1 Hz pour le compteur consécutif du détecteur
      const subscription = {
        context: 'vessels.self',
        subscribe: [
          { path: 'navigation.speedOverGround', period: 1000 },
          { path: 'navigation.position', period: 1000 },
          { path: 'navigation.courseOverGroundTrue', period: 1000 },
          { path: 'environment.wind.speedApparent', period: 5000 },
          { path: 'environment.wind.angleApparent', period: 5000 },
          { path: 'environment.outside.pressure', period: 30000 },
          { path: 'environment.outside.temperature', period: 30000 },
          { path: 'navigation.log', period: 5000 }
        ]
      }

      // 4 arguments requis : command, unsubscribes, errorCallback, deltaCallback
      app.subscriptionmanager.subscribe(
        subscription,
        unsubscribes,
        (err) => app.debug('subscription error: ' + err),
        (delta) => {
          delta.updates.forEach(update => {
            update.values?.forEach(({ path, value }) => _handleSkUpdate(path, value))
          })
        }
      )

      // Timer log périodique (défaut 15 min) — passe complète après chaque log
      const logMs = (settings.logIntervalMinutes || 15) * 60 * 1000
      periodicTimer = setInterval(() => {
        const trip = logger.getActiveTrip()
        if (trip) {
          logger.writePeriodicLog(_getAveragedSnapshot(), trip.id)
          consolidator.consolidateAll(trip.id)
        }
      }, logMs)

      // Timer consolidation de fond (défaut 5 min) — passe complète, rattrape les écarts
      const consMs = (settings.consolidationWindowMin || 5) * 60 * 1000
      consolidationTimer = setInterval(() => {
        const trip = logger.getActiveTrip()
        if (trip) consolidator.consolidateAll(trip.id)
      }, consMs)

      app.debug('Plugin démarré, DB : ' + dbPath)
    },

    stop: () => {
      unsubscribes.forEach(f => f())
      unsubscribes = []
      if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null }
      if (consolidationTimer) { clearInterval(consolidationTimer); consolidationTimer = null }
      if (logger) { logger.close(); logger = null }
      detector = null
      stateManager = null
      consolidator = null
      exporter = null
      currentSnapshot = {}
      sogBuffer = []; windSpeedBuffer = []; windAngleBuffer = []
    },

    registerWithRouter: (router) => {

      // GET /api/logbook — export JSON complet
      router.get('/api/logbook', (req, res) => {
        if (!exporter) return res.status(503).json({ error: 'Plugin non démarré' })
        try { res.json(exporter.export()) } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // GET /api/logbook/recent — 10 dernières entrées consolidées avec conditions capteurs + distance
      router.get('/api/logbook/recent', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        try {
          const rows = logger.getRecentLogbookEntriesJoined(10)
          const enriched = rows.map(row => {
            const dist = _haversineNm(row.trip_start_lat, row.trip_start_lon, row.lat, row.lon)
            return {
              id: row.id,
              trip_id: row.trip_id,
              timestamp: row.timestamp,
              summary: row.summary,
              lat: row.lat,
              lon: row.lon,
              conditions: row.conditions ? JSON.parse(row.conditions) : null,
              distance_from_start_nm: dist != null ? +dist.toFixed(1) : null
            }
          })
          res.json(enriched)
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // GET /api/status — état courant (trip, moteur, voiles, capteurs)
      router.get('/api/status', (req, res) => {
        if (!stateManager) return res.status(503).json({ error: 'Plugin non démarré' })
        try {
          res.json({
            currentTrip: logger.getActiveTrip(),
            ...stateManager.getStatus(),
            latestSensors: currentSnapshot
          })
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // POST /api/state — { type: 'moteur'|'gv'|'genois', value, timestamp }
      router.post('/api/state', (req, res) => {
        if (!stateManager) return res.status(503).json({ error: 'Plugin non démarré' })
        const { type, value, timestamp } = req.body || {}
        try {
          let result
          const snap = _getAveragedSnapshot()
          if (type === 'moteur') result = stateManager.setMotor(value, timestamp, snap)
          else if (type === 'gv') result = stateManager.setGV(value, timestamp, snap)
          else if (type === 'genois') result = stateManager.setGenois(value, timestamp, snap)
          else return res.status(400).json({ error: 'Type inconnu : ' + type })
          _consolidateNow()
          res.json(result)
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // POST /api/trip/start — départ manuel (la détection auto est un fallback)
      router.post('/api/trip/start', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        if (logger.getActiveTrip()) return res.status(400).json({ error: 'Trip déjà en cours' })
        try {
          const snap = { ..._getAveragedSnapshot(), timestamp: req.body?.timestamp || new Date().toISOString() }
          const tripId = _startTrip(snap)
          res.json({ ok: true, tripId })
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // POST /api/trip/end — arrivée manuelle avec détails mouillage/port
      router.post('/api/trip/end', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        if (!logger.getActiveTrip()) return res.status(400).json({ error: 'Aucun trip en cours' })
        const { type, depth, bottom, mooring, chain_m, observation, timestamp } = req.body || {}
        if (type !== 'mouillage' && type !== 'port') return res.status(400).json({ error: 'type doit être mouillage ou port' })
        try {
          const snap = { ..._getAveragedSnapshot(), timestamp: timestamp || new Date().toISOString() }
          _endTrip(snap, { type, depth, bottom, mooring, chain_m, observation })
          res.json({ ok: true })
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // GET /api/trips — liste tous les trips pour la page historique
      router.get('/api/trips', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        try { res.json(logger.getAllTrips()) } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // GET /api/trips/:id/logbook — toutes les entrées d'un trip (ordre chronologique)
      router.get('/api/trips/:id/logbook', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        const id = parseInt(req.params.id)
        if (!id) return res.status(400).json({ error: 'id invalide' })
        try {
          const entries = logger.getAllLogbookEntries(id)
          res.json(entries.map(e => ({
            ...e,
            conditions: e.conditions ? JSON.parse(e.conditions) : null
          })))
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // POST /api/trips/export — retourne le JSON des trips sélectionnés pour téléchargement
      router.post('/api/trips/export', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        const ids = req.body?.ids
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids requis' })
        try { res.json(logger.getTripsForExport(ids)) } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // DELETE /api/trips — supprime les trips passés en body { ids: [...] }
      router.delete('/api/trips', (req, res) => {
        if (!logger) return res.status(503).json({ error: 'Plugin non démarré' })
        const ids = req.body?.ids
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids requis' })
        const activeTrip = logger.getActiveTrip()
        if (activeTrip && ids.includes(activeTrip.id)) {
          return res.status(400).json({ error: 'Impossible de supprimer le trip en cours' })
        }
        try {
          logger.deleteTrips(ids)
          res.json({ ok: true, deleted: ids.length })
        } catch (e) { res.status(500).json({ error: e.message }) }
      })

      // POST /api/observation — { text, timestamp }
      router.post('/api/observation', (req, res) => {
        if (!stateManager) return res.status(503).json({ error: 'Plugin non démarré' })
        const { text, timestamp } = req.body || {}
        if (!text) return res.status(400).json({ error: 'Champ text requis' })
        try {
          const result = stateManager.addObservation(text, timestamp, _getAveragedSnapshot())
          _consolidateNow()
          res.json(result)
        } catch (e) { res.status(500).json({ error: e.message }) }
      })
    }
  }

  // Consolide uniquement la fenêtre courante — O(1), appelé après chaque action UI
  function _consolidateNow () {
    const trip = logger && logger.getActiveTrip()
    if (!trip || !consolidator) return
    const windowKey = Math.floor(Date.now() / windowMs)
    consolidator.consolidateWindow(trip.id, windowKey)
  }

  // Reçoit les mises à jour SK et met à jour currentSnapshot + buffers glissants + détecteur
  function _handleSkUpdate (skPath, value) {
    currentSnapshot.timestamp = new Date().toISOString()

    switch (skPath) {
      case 'navigation.speedOverGround':
        currentSnapshot.sog_ms = value
        if (value != null) { sogBuffer.push(value); if (sogBuffer.length > SOG_BUF) sogBuffer.shift() }
        if (detector) detector.update(currentSnapshot)
        break
      case 'navigation.position':
        currentSnapshot.lat = value?.latitude
        currentSnapshot.lon = value?.longitude
        break
      case 'navigation.courseOverGroundTrue':
        currentSnapshot.cog_rad = value
        break
      case 'environment.wind.speedApparent':
        currentSnapshot.wind_speed = value
        if (value != null) { windSpeedBuffer.push(value); if (windSpeedBuffer.length > WIND_BUF) windSpeedBuffer.shift() }
        break
      case 'environment.wind.angleApparent':
        currentSnapshot.wind_angle = value
        if (value != null) { windAngleBuffer.push(value); if (windAngleBuffer.length > WIND_BUF) windAngleBuffer.shift() }
        break
      case 'environment.outside.pressure':
        currentSnapshot.pressure_pa = value
        break
      case 'environment.outside.temperature':
        currentSnapshot.temp_k = value
        break
    }
  }

  // Retourne un snapshot avec SOG et vent remplacés par leurs moyennes sur ~2 min.
  // Le vent utilise une moyenne circulaire pour gérer correctement le wrap-around 0°/360°.
  function _getAveragedSnapshot () {
    const snap = { ...currentSnapshot }
    if (sogBuffer.length > 0) {
      snap.sog_ms = sogBuffer.reduce((s, v) => s + v, 0) / sogBuffer.length
    }
    if (windSpeedBuffer.length > 0) {
      snap.wind_speed = windSpeedBuffer.reduce((s, v) => s + v, 0) / windSpeedBuffer.length
    }
    if (windAngleBuffer.length > 0) {
      const sinSum = windAngleBuffer.reduce((s, a) => s + Math.sin(a), 0)
      const cosSum = windAngleBuffer.reduce((s, a) => s + Math.cos(a), 0)
      snap.wind_angle = Math.atan2(sinSum, cosSum)
    }
    return snap
  }

  function _onDepart (snapshot) {
    try { _startTrip(snapshot) } catch (e) {
      app.setPluginError('Erreur création trip : ' + e.message)
    }
  }

  function _onArrivee (snapshot) {
    try { _endTrip(snapshot, null) } catch (e) {
      app.setPluginError('Erreur clôture trip : ' + e.message)
    }
  }

  function _startTrip (snapshot) {
    const tripId = logger.createTrip({
      start_timestamp: snapshot.timestamp,
      start_lat: snapshot.lat,
      start_lon: snapshot.lon
    })
    logger.insertEvent({ ...snapshot, type: 'depart', trip_id: tripId })
    detector.setActiveTrip({ id: tripId })
    stateManager.setCurrentTrip(tripId)
    app.setPluginStatus(`En navigation · Trip #${tripId}`)
    app.debug('Départ, Trip #' + tripId)
    return tripId
  }

  function _endTrip (snapshot, arrivalData) {
    const activeTrip = logger.getActiveTrip()
    if (!activeTrip) return

    const distNm = _haversineNm(
      activeTrip.start_lat, activeTrip.start_lon,
      snapshot.lat, snapshot.lon
    )

    logger.closeTrip({
      id: activeTrip.id,
      end_timestamp: snapshot.timestamp,
      end_lat: snapshot.lat,
      end_lon: snapshot.lon,
      distance_nm: distNm
    })

    consolidator.consolidateAll(activeTrip.id)

    logger.insertEvent({
      ...snapshot, type: 'arrivee',
      data: arrivalData || {},
      trip_id: activeTrip.id
    })

    if (arrivalData) {
      const ts = snapshot.timestamp || new Date().toISOString()
      logger.insertLogbookEntry({
        trip_id: activeTrip.id,
        timestamp: ts,
        summary: _buildArrivalSummary(ts, arrivalData),
        event_ids: [],
        lat: snapshot.lat,
        lon: snapshot.lon,
        conditions: _buildConditions(snapshot)
      })
    }

    detector.clearActiveTrip()
    stateManager.setCurrentTrip(null)
    app.setPluginStatus('En attente de navigation')
    app.debug(`Arrivée, Trip #${activeTrip.id}, distance ${distNm?.toFixed(1)} nm`)
  }

  function _buildArrivalSummary (ts, data) {
    const hour = new Date(ts)
      .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      .replace(':', 'h')
    const parts = []
    if (data.type === 'mouillage') {
      parts.push('Mouillage')
      if (data.depth) parts.push(data.depth)
      if (data.chain_m) parts.push(`Chaîne ${data.chain_m} m`)
      if (data.bottom) parts.push(
        { vase: 'Fond vase', sable: 'Fond sable', roche: 'Fond roche',
          tache_sable: 'Fond tache de sable', autre: 'Fond autre' }[data.bottom] || data.bottom
      )
    } else {
      parts.push('Arrivée au port')
      if (data.mooring) parts.push(
        { pendille: 'Pendille', ancre: 'Ancre', autre: 'Autre' }[data.mooring] || data.mooring
      )
    }
    if (data.observation) parts.push(`'${data.observation}'`)
    return `${hour} — ${parts.join(' · ')}`
  }

  function _buildConditions (snap) {
    if (!snap) return null
    return {
      sog_kts: snap.sog_ms != null ? +(snap.sog_ms * 1.94384).toFixed(1) : null,
      cog_deg: snap.cog_rad != null ? +(snap.cog_rad * 180 / Math.PI).toFixed(0) : null,
      wind_speed_kts: snap.wind_speed != null ? +(snap.wind_speed * 1.94384).toFixed(0) : null,
      wind_angle_deg: snap.wind_angle != null ? +(snap.wind_angle * 180 / Math.PI).toFixed(0) : null,
      pressure_hpa: snap.pressure_pa != null ? +(snap.pressure_pa / 100).toFixed(0) : null,
      temp_c: snap.temp_k != null ? +(snap.temp_k - 273.15).toFixed(1) : null
    }
  }

  // Formule de Haversine — retourne la distance en milles nautiques
  function _haversineNm (lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null
    const R = 3440.065
    const φ1 = lat1 * Math.PI / 180
    const φ2 = lat2 * Math.PI / 180
    const Δφ = (lat2 - lat1) * Math.PI / 180
    const Δλ = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  return plugin
}
