'use strict'

const API_BASE = '/plugins/signalk-logbook-auto'
const SK_PORT = 3000

// ──── WebSocket Signal K ────
let ws = null
let wsReconnectTimer = null

function connectWebSocket () {
  const url = `ws://${window.location.hostname}:${SK_PORT}/signalk/v1/stream`
  ws = new WebSocket(url)

  ws.onmessage = (e) => {
    try {
      const delta = JSON.parse(e.data)
      if (!delta.updates) return
      delta.updates.forEach(update => {
        update.values?.forEach(({ path, value }) => updateUI(path, value))
      })
    } catch (_) {}
  }

  ws.onclose = () => {
    // Polling de secours si WebSocket déconnecté
    wsReconnectTimer = setTimeout(connectWebSocket, 3000)
  }

  ws.onerror = () => ws.close()
}

// ──── Mise à jour DOM depuis les données SK ────
function updateUI (path, value) {
  const handlers = {
    'navigation.speedOverGround': v =>
      updateValue('status-sog', v != null ? msToKts(v).toFixed(1) + ' kt' : '---'),
    'navigation.courseOverGroundTrue': v =>
      updateValue('status-cog', v != null ? radToDeg(v).toFixed(0) + '°' : '---'),
    'environment.wind.speedApparent': v =>
      updateValue('status-wind-speed', v != null ? msToKts(v).toFixed(0) + ' kt' : '---'),
    'environment.wind.angleApparent': v =>
      updateValue('status-wind-angle', v != null ? radToDeg(v).toFixed(0) + '°' : '---'),
    'environment.outside.pressure': v =>
      updateValue('status-pressure', v != null ? (v / 100).toFixed(0) + ' hPa' : '---'),
    'environment.outside.temperature': v =>
      updateValue('status-temp', v != null ? (v - 273.15).toFixed(1) + ' °C' : '---'),
    'propulsion.main.state': v => setMotorState(v === 'started' ? 'on' : 'off'),
    'sails.inventory.main.reefs': v => setGVButton(v),
    'sails.inventory.main.furled': v => { if (v) setGVButton(-1) },
    'sails.inventory.headsail.reefs': v => setGenoisButton(v),
    'sails.inventory.headsail.furled': v => { if (v) setGenoisButton(-1) },
    'navigation.state': v => setNavStateDisplay(v)
  }
  handlers[path]?.(value)
}

// Met à jour un élément de valeur + déclenche l'animation pulse
function updateValue (id, text) {
  const el = document.getElementById(id)
  if (!el || el.textContent === text) return
  el.textContent = text
  el.classList.remove('value-updated')
  void el.offsetWidth  // force reflow pour relancer l'animation CSS
  el.classList.add('value-updated')
}

// ──── État moteur ────
function setMotorState (state) {
  const onBtn = document.getElementById('motor-on')
  const offBtn = document.getElementById('motor-off')
  if (!onBtn || !offBtn) return
  if (state === 'on') {
    onBtn.classList.add('active', 'motor-amber')
    offBtn.classList.remove('active', 'motor-amber')
  } else {
    offBtn.classList.add('active')
    onBtn.classList.remove('active', 'motor-amber')
  }
}

// ──── État voiles ────
// reefs : -1=affalée, 0=full, 1-3=ris
function setGVButton (reefs) {
  const map = { '-1': 'gv-furled', 0: 'gv-full', 1: 'gv-ris1', 2: 'gv-ris2', 3: 'gv-ris3' }
  activateSailButton('gv', map[reefs] || null)
}

function setGenoisButton (reefs) {
  const map = { '-1': 'genois-furled', 0: 'genois-full', 1: 'genois-ris1', 2: 'genois-ris2', 3: 'genois-ris3' }
  activateSailButton('genois', map[reefs] || null)
}

function activateSailButton (prefix, activeId) {
  const ids = [`${prefix}-furled`, `${prefix}-full`, `${prefix}-ris1`, `${prefix}-ris2`, `${prefix}-ris3`]
  for (const id of ids) {
    const btn = document.getElementById(id)
    if (btn) btn.classList.toggle('active', id === activeId)
  }
}

// ──── État navigation ────
function setNavStateDisplay (state) {
  const el = document.getElementById('nav-state-display')
  if (!el) return
  el.textContent = (state || 'moored').toUpperCase()
  el.className = 'header-navstate ' + (state || 'moored')
}

// ──── Départ / Arrivée ────
async function handleDeparture () {
  flashBtn('btn-departure')
  try {
    const res = await fetch(`${API_BASE}/api/trip/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString() })
    })
    if (res.ok) { await loadInitialStatus(); refreshJournal() }
  } catch (e) { console.error('handleDeparture error:', e) }
}

let _pressTimer = null

function startArrivalPress () {
  const btn = document.getElementById('btn-arrival')
  if (!btn) return
  btn.classList.add('pressing')
  _pressTimer = setTimeout(() => {
    btn.classList.remove('pressing')
    openArrivalModal()
  }, 1500)
}

function cancelArrivalPress () {
  clearTimeout(_pressTimer)
  document.getElementById('btn-arrival')?.classList.remove('pressing')
}

// Sélection active dans le modal (remplace les radio buttons)
const _modalSel = { type: null, depth: null, bottom: null, mooring: null }

function _selectModal (btn) {
  const group = btn.dataset.group
  const value = btn.dataset.value
  _modalSel[group] = value

  // Désactiver tous les boutons du groupe, activer celui-ci
  document.querySelectorAll(`.modal-opt-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'))
  btn.classList.add('active')

  if (group === 'type') _switchArrivalPanel(value)

  // Sélection du champ libre de profondeur → vider les autres états de depth
  if (group === 'depth' && value === '__free') {
    document.getElementById('arr-depth-free').focus()
  }
}

function openArrivalModal () {
  document.getElementById('arrival-modal').style.display = 'flex'

  // Reset état interne
  _modalSel.type = 'mouillage'
  _modalSel.depth = null
  _modalSel.bottom = null
  _modalSel.mooring = null

  // Reset visuel : retirer toutes les classes active
  document.querySelectorAll('.modal-opt-btn').forEach(b => b.classList.remove('active'))

  // Activer Mouillage par défaut
  const mouillageBtn = document.querySelector('.modal-opt-btn[data-group="type"][data-value="mouillage"]')
  if (mouillageBtn) mouillageBtn.classList.add('active')

  _switchArrivalPanel('mouillage')

  // Vider les champs libres
  document.getElementById('arr-obs').value = ''
  document.getElementById('arr-depth-free').value = ''
  const chainEl = document.getElementById('arr-chain')
  if (chainEl) chainEl.value = ''
}

function closeArrivalModal () {
  document.getElementById('arrival-modal').style.display = 'none'
}

function _switchArrivalPanel (type) {
  document.getElementById('panel-mouillage').style.display = type === 'mouillage' ? '' : 'none'
  document.getElementById('panel-port').style.display = type === 'port' ? '' : 'none'
}

async function confirmArrival () {
  const type = _modalSel.type
  if (!type) return
  const body = { type, timestamp: new Date().toISOString() }

  if (type === 'mouillage') {
    const depth = _modalSel.depth
    if (depth === '__free') {
      const val = document.getElementById('arr-depth-free').value
      if (val) body.depth = val + ' m'
    } else if (depth) {
      body.depth = depth
    }
    const chainVal = document.getElementById('arr-chain')?.value
    if (chainVal) body.chain_m = parseInt(chainVal, 10)
    if (_modalSel.bottom) body.bottom = _modalSel.bottom
  } else {
    if (_modalSel.mooring) body.mooring = _modalSel.mooring
  }
  const obs = document.getElementById('arr-obs').value.trim()
  if (obs) body.observation = obs

  try {
    await fetch(`${API_BASE}/api/trip/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    closeArrivalModal()
    await loadInitialStatus()
    refreshJournal()
  } catch (e) { console.error('confirmArrival error:', e) }
}

function _updateTripButtons (hasActiveTrip) {
  const dep = document.getElementById('btn-departure')
  const arr = document.getElementById('btn-arrival')
  if (dep) dep.style.display = hasActiveTrip ? 'none' : ''
  if (arr) arr.style.display = hasActiveTrip ? '' : 'none'
}

// ──── Handlers boutons ────
function handleMotor (state) {
  flashBtn('motor-' + state)
  postState('moteur', state).then(refreshJournal)
}

// sailType = 'gv' | 'genois', reefs = -1 (affalée) | 0 (full) | 1-3
function handleSail (sailType, reefs) {
  const ids = { '-1': `${sailType}-furled`, 0: `${sailType}-full`, 1: `${sailType}-ris1`, 2: `${sailType}-ris2`, 3: `${sailType}-ris3` }
  flashBtn(ids[reefs])

  const furled = reefs === -1
  const active = !furled
  const value = { reefs: furled ? 0 : reefs, active, furled }

  postState(sailType, value).then(() => {
    if (sailType === 'gv') setGVButton(reefs)
    else setGenoisButton(reefs)
    refreshJournal()
  })
}

function sendObservation () {
  const el = document.getElementById('observation-text')
  const text = el?.value?.trim()
  if (!text) return

  fetch(`${API_BASE}/api/observation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, timestamp: new Date().toISOString() })
  }).then(() => {
    el.value = ''
    refreshJournal()
  }).catch(console.error)
}

async function postState (type, value) {
  try {
    await fetch(`${API_BASE}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, value, timestamp: new Date().toISOString() })
    })
  } catch (e) { console.error('postState error:', e) }
}

// ──── Journal ────
async function refreshJournal () {
  try {
    const res = await fetch(`${API_BASE}/api/logbook/recent`)
    const entries = await res.json()
    renderJournal(entries)
  } catch (e) { console.error('journal fetch error:', e) }
}

function renderJournal (entries) {
  const list = document.getElementById('journal-list')
  if (!list) return

  if (!Array.isArray(entries) || entries.length === 0) {
    list.innerHTML = '<li class="journal-empty">Aucune entrée pour l\'instant.</li>'
    return
  }

  list.innerHTML = entries.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    const details = _buildJournalDetails(entry)
    return `<li class="journal-entry">
      <span class="journal-time">${time}</span>
      <span class="journal-body">
        <span class="journal-summary">${escapeHtml(entry.summary)}</span>
        ${details ? `<span class="journal-details">${details}</span>` : ''}
      </span>
    </li>`
  }).join('')
}

function _buildJournalDetails (entry) {
  const parts = []
  const c = entry.conditions

  if (entry.lat != null && entry.lon != null) {
    const lat = entry.lat.toFixed(4) + (entry.lat >= 0 ? 'N' : 'S')
    const lon = entry.lon.toFixed(4) + (entry.lon >= 0 ? 'E' : 'W')
    parts.push(`<span class="journal-coords">${lat} ${lon}</span>`)
  }

  if (c) {
    const cParts = []
    if (c.sog_kts != null) cParts.push(`SOG ${c.sog_kts} kt`)
    if (c.cog_deg != null) cParts.push(`COG ${c.cog_deg}°`)
    if (c.wind_speed_kts != null && c.wind_angle_deg != null)
      cParts.push(`Vent ${c.wind_speed_kts} kt / ${c.wind_angle_deg}°`)
    else if (c.wind_speed_kts != null)
      cParts.push(`Vent ${c.wind_speed_kts} kt`)
    if (c.pressure_hpa != null) cParts.push(`${c.pressure_hpa} hPa`)
    if (cParts.length) parts.push(`<span class="journal-conditions">${cParts.join(' · ')}</span>`)
  }

  if (entry.distance_from_start_nm != null)
    parts.push(`<span class="journal-distance">D+ ${entry.distance_from_start_nm} nm</span>`)

  return parts.join('')
}

// ──── Chargement initial du statut ────
async function loadInitialStatus () {
  try {
    const res = await fetch(`${API_BASE}/api/status`)
    const status = await res.json()

    setMotorState(status.motorState === 'started' ? 'on' : 'off')
    setNavStateDisplay(status.navState)

    if (status.gv) {
      setGVButton(status.gv.furled ? -1 : status.gv.reefs)
    }
    if (status.genois) {
      setGenoisButton(status.genois.furled ? -1 : status.genois.reefs)
    }

    _updateTripButtons(!!status.currentTrip)

    if (status.currentTrip) {
      const trip = status.currentTrip
      const start = new Date(trip.start_timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      document.getElementById('trip-status').textContent = `Trip #${trip.id} en cours`
      document.getElementById('trip-details').textContent = `Depuis ${start}`
    } else {
      document.getElementById('trip-status').textContent = 'Aucun trip actif'
      document.getElementById('trip-details').textContent = ''
    }

    if (status.latestSensors) {
      const s = status.latestSensors
      if (s.sog_ms != null) updateValue('status-sog', msToKts(s.sog_ms).toFixed(1) + ' kt')
      if (s.cog_rad != null) updateValue('status-cog', radToDeg(s.cog_rad).toFixed(0) + '°')
      if (s.wind_speed != null) updateValue('status-wind-speed', msToKts(s.wind_speed).toFixed(0) + ' kt')
      if (s.wind_angle != null) updateValue('status-wind-angle', radToDeg(s.wind_angle).toFixed(0) + '°')
      if (s.pressure_pa != null) updateValue('status-pressure', (s.pressure_pa / 100).toFixed(0) + ' hPa')
      if (s.temp_k != null) updateValue('status-temp', (s.temp_k - 273.15).toFixed(1) + ' °C')
    }
  } catch (e) { console.warn('Impossible de charger le statut initial:', e) }
}

// ──── Utilitaires ────
const msToKts = ms => ms * 1.94384
const radToDeg = rad => rad * 180 / Math.PI
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function flashBtn (id) {
  const btn = document.getElementById(id)
  if (!btn) return
  btn.classList.add('flash')
  setTimeout(() => btn.classList.remove('flash'), 150)
}

// ──── Horloge ────
function startClock () {
  const update = () => {
    document.getElementById('status-time').textContent =
      new Date().toLocaleTimeString('fr-FR')
  }
  update()
  setInterval(update, 1000)
}

// ──── Init ────
document.addEventListener('DOMContentLoaded', () => {
  startClock()
  connectWebSocket()
  loadInitialStatus()
  refreshJournal()

  // Long-press sur le bouton ARRIVÉE
  const arrBtn = document.getElementById('btn-arrival')
  if (arrBtn) {
    arrBtn.addEventListener('pointerdown', startArrivalPress)
    arrBtn.addEventListener('pointerup', cancelArrivalPress)
    arrBtn.addEventListener('pointercancel', cancelArrivalPress)
    arrBtn.addEventListener('contextmenu', e => e.preventDefault())
  }

  // Sélectionner le groupe depth=__free quand on tape dans le champ libre
  const freeDepth = document.getElementById('arr-depth-free')
  if (freeDepth) {
    freeDepth.addEventListener('focus', () => {
      const freeBtn = document.querySelector('.modal-opt-btn[data-group="depth"][data-value="__free"]')
      if (freeBtn) _selectModal(freeBtn)
    })
  }

  // Rafraîchir le journal toutes les 30s et le statut toutes les 10s
  setInterval(refreshJournal, 30000)
  setInterval(loadInitialStatus, 10000)
})
