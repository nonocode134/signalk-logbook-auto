'use strict'

const API_BASE = '/plugins/signalk-logbook-auto'

// ──── WebSocket Signal K ────
let ws = null
let wsReconnectTimer = null

function connectWebSocket () {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}/signalk/v1/stream`
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

// ──── État trip ────
let _tripActive = false

// ──── État moteur ────
let _motorOn = false

function setMotorState (state) {
  _motorOn = state === 'on'
  _renderMotor(_motorOn)
}

function _renderMotor (isOn) {
  document.getElementById('motor-track')?.classList.toggle('on', isOn)
  document.getElementById('motor-h')?.classList.toggle('on', isOn)
}

function handleMotorToggle () {
  if (!_tripActive) { showNoTripModal(); return }
  vibrate(20)
  _motorOn = !_motorOn
  _renderMotor(_motorOn)
  postState('moteur', _motorOn ? 'on' : 'off').then(refreshJournal)
}

// ──── État voiles ────
// level : 0=plein  1=1ris  2=2ris  3=3ris  4=affalé(e)
const _sailLevel = { gv: 4, gen: 4 }
const _SAIL_LABELS = {
  gv:  ['Pleine', '1 ris', '2 ris', '3 ris', 'Affalée'],
  gen: ['Plein', '1 ris', '2 ris', '3 ris', 'Affalé']
}

function _renderSailGauge (sail, level) {
  for (let i = 0; i <= 3; i++) {
    const seg = document.getElementById(`${sail}-${i}`)
    if (!seg) continue
    seg.classList.remove('selected', 'fill')
    if (i === level)      seg.classList.add('selected')
    else if (i > level)   seg.classList.add('fill')  // segments sous le sélectionné = vert dim
    // i < level : au-dessus du ris actuel = fond sombre (voile affalée dans cette zone)
  }
  document.getElementById(`${sail}-aff`)?.classList.toggle('current', level === 4)
  const st = document.getElementById(`${sail}-state`)
  if (st) {
    st.textContent = _SAIL_LABELS[sail][level]
    st.classList.toggle('lit', level < 4)
  }
}

// Appelé par WebSocket / loadInitialStatus — reefs : -1=affalée, 0=full, 1-3=ris
function setGVButton (reefs) {
  const level = reefs === -1 ? 4 : reefs
  _sailLevel.gv = level
  _renderSailGauge('gv', level)
}

function setGenoisButton (reefs) {
  const level = reefs === -1 ? 4 : reefs
  _sailLevel.gen = level
  _renderSailGauge('gen', level)
}

// Appelé par les segments de la jauge (onclick dans le HTML)
function handleSailGauge (sail, level) {
  if (!_tripActive) { showNoTripModal(); return }
  vibrate(15)
  _sailLevel[sail] = level
  _renderSailGauge(sail, level)
  const apiSail = sail === 'gen' ? 'genois' : sail
  const furled = level === 4
  postState(apiSail, { reefs: furled ? 0 : level, active: !furled, furled }).then(refreshJournal)
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
  vibrate(20)
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
    vibrate(30)
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
  _tripActive = hasActiveTrip
  document.body.classList.toggle('no-trip', !hasActiveTrip)
  const dep = document.getElementById('btn-departure')
  const arr = document.getElementById('btn-arrival')
  if (dep) dep.style.display = hasActiveTrip ? 'none' : ''
  if (arr) arr.style.display = hasActiveTrip ? '' : 'none'
}

function showNoTripModal () {
  vibrate(30)
  document.getElementById('no-trip-modal').style.display = 'flex'
}

function closeNoTripModal () {
  document.getElementById('no-trip-modal').style.display = 'none'
}

function sendObservation () {
  if (!_tripActive) { showNoTripModal(); return }
  const el = document.getElementById('observation-text')
  const text = el?.value?.trim()
  if (!text) return
  vibrate(15)

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

function _updateLastEntry (entries) {
  const strip = document.getElementById('last-entry')
  if (!strip) return
  if (!Array.isArray(entries) || entries.length === 0) {
    strip.classList.add('empty')
    document.getElementById('last-entry-text').textContent = 'Aucune entrée'
    return
  }
  const entry = entries[0]
  const time = new Date(entry.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  strip.classList.remove('empty')
  document.getElementById('last-entry-time').textContent = time
  document.getElementById('last-entry-text').textContent = entry.summary
}

function renderJournal (entries) {
  _updateLastEntry(entries)
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
    const mobClass = entry.no_aggregate ? ' journal-entry--mob' : ''
    return `<li class="journal-entry${mobClass}">
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

    // Restaure l'état MOB si une alerte est active (ex. après rechargement de page)
    if (status.mob?.active && !_mobActive) initMob(status)
    else if (!status.mob?.active && _mobActive) {
      _mobActive = false
      _mobStartedAt = null
      if (_mobTimerInterval) { clearInterval(_mobTimerInterval); _mobTimerInterval = null }
      _renderMobInactive()
    }

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

// ──── Retour haptique ────
const vibrate = (ms = 15) => navigator.vibrate?.(ms)

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

// ──── MOB ────
let _mobActive = false
let _mobStartedAt = null
let _mobTimerInterval = null
let _mobPressTimer = null
let _mobConfirmPressTimer = null

function initMob (statusData) {
  if (statusData?.mob?.active) {
    _mobActive = true
    _mobStartedAt = new Date(statusData.mob.startedAt)
    _renderMobActive()
    _startMobTimer()
  }
}

// Tap simple → ouvre le modal de confirmation (seulement quand MOB inactif)
function handleMobClick () {
  if (_mobActive) return
  openMobStartModal()
}

// Long-press 3 s → ouvre le modal FIN MOB (seulement quand MOB actif)
function startMobPress () {
  if (!_mobActive) return
  const btn = document.getElementById('btn-mob')
  if (!btn) return
  btn.classList.add('pressing')
  _mobPressTimer = setTimeout(() => {
    btn.classList.remove('pressing')
    vibrate(30)
    openMobEndModal()
  }, 3000)
}

function cancelMobPress () {
  if (!_mobActive) return
  clearTimeout(_mobPressTimer)
  document.getElementById('btn-mob')?.classList.remove('pressing')
}

function openMobStartModal () {
  vibrate(40)
  document.getElementById('mob-start-modal').style.display = 'flex'
}

function closeMobStartModal () {
  document.getElementById('mob-start-modal').style.display = 'none'
}

async function confirmMobStart () {
  vibrate([60, 40, 60])  // double impulsion pour l'alerte MOB
  closeMobStartModal()
  await _triggerMob()
}

async function _triggerMob () {
  try {
    const res = await fetch(`${API_BASE}/api/mob/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString() })
    })
    if (res.ok) {
      const data = await res.json()
      _mobActive = true
      _mobStartedAt = new Date(data.startedAt)
      _renderMobActive()
      _startMobTimer()
      refreshJournal()
    }
  } catch (e) { console.error('MOB start error:', e) }
}

function _renderMobActive () {
  const btn = document.getElementById('btn-mob')
  if (!btn) return
  btn.textContent = 'FIN MOB'
  btn.classList.add('active')
  document.getElementById('mob-timer').style.display = ''
}

function _renderMobInactive () {
  const btn = document.getElementById('btn-mob')
  if (!btn) return
  btn.textContent = 'MOB'
  btn.classList.remove('active')
  const timer = document.getElementById('mob-timer')
  timer.style.display = 'none'
  timer.textContent = '00:00:00'
}

function _startMobTimer () {
  if (_mobTimerInterval) clearInterval(_mobTimerInterval)
  _updateMobTimerDisplay()
  _mobTimerInterval = setInterval(_updateMobTimerDisplay, 1000)
}

function _updateMobTimerDisplay () {
  if (!_mobStartedAt) return
  const sec = Math.floor((Date.now() - _mobStartedAt.getTime()) / 1000)
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  document.getElementById('mob-timer').textContent = `${h}:${m}:${s}`
}

function openMobEndModal () {
  if (_mobStartedAt) {
    const sec = Math.floor((Date.now() - _mobStartedAt.getTime()) / 1000)
    const h = String(Math.floor(sec / 3600)).padStart(2, '0')
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
    const s = String(sec % 60).padStart(2, '0')
    const el = document.getElementById('mob-modal-elapsed')
    if (el) el.textContent = `Alerte active depuis ${h}:${m}:${s}`
  }
  document.getElementById('mob-end-modal').style.display = 'flex'
}

function closeMobEndModal () {
  document.getElementById('mob-end-modal').style.display = 'none'
  cancelMobConfirmPress()
}

function startMobConfirmPress () {
  const btn = document.getElementById('btn-mob-confirm')
  if (!btn) return
  btn.classList.add('pressing')
  _mobConfirmPressTimer = setTimeout(async () => {
    btn.classList.remove('pressing')
    vibrate([60, 40, 60])
    closeMobEndModal()
    await _endMob()
  }, 3000)
}

function cancelMobConfirmPress () {
  clearTimeout(_mobConfirmPressTimer)
  document.getElementById('btn-mob-confirm')?.classList.remove('pressing')
}

async function _endMob () {
  try {
    const res = await fetch(`${API_BASE}/api/mob/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString() })
    })
    if (res.ok) {
      _mobActive = false
      _mobStartedAt = null
      if (_mobTimerInterval) { clearInterval(_mobTimerInterval); _mobTimerInterval = null }
      _renderMobInactive()
      refreshJournal()
    }
  } catch (e) { console.error('MOB end error:', e) }
}

// ──── Mode jour / nuit ────
function toggleSunMode () {
  const active = document.documentElement.classList.toggle('sun-mode')
  localStorage.setItem('sun-mode', active ? '1' : '0')
}

// ──── Init ────
document.addEventListener('DOMContentLoaded', () => {
  // Retour haptique léger sur tous les boutons interactifs (Android Chrome)
  document.addEventListener('pointerdown', e => {
    if (e.target.closest('.btn, .prop-affaler, .modal-opt-btn'))
      navigator.vibrate?.(12)
  }, { passive: true })
  if (localStorage.getItem('sun-mode') === '1') {
    document.documentElement.classList.add('sun-mode')
  }

  connectWebSocket()
  loadInitialStatus()
  refreshJournal()

  // MOB : tap → modal confirmation (inactif) | long-press 3 s → FIN MOB (actif)
  const mobBtn = document.getElementById('btn-mob')
  if (mobBtn) {
    mobBtn.addEventListener('click', handleMobClick)
    mobBtn.addEventListener('pointerdown', startMobPress)
    mobBtn.addEventListener('pointerup', cancelMobPress)
    mobBtn.addEventListener('pointercancel', cancelMobPress)
    mobBtn.addEventListener('contextmenu', e => e.preventDefault())
  }

  // Long-press confirmation FIN MOB dans le modal
  const mobConfirmBtn = document.getElementById('btn-mob-confirm')
  if (mobConfirmBtn) {
    mobConfirmBtn.addEventListener('pointerdown', startMobConfirmPress)
    mobConfirmBtn.addEventListener('pointerup', cancelMobConfirmPress)
    mobConfirmBtn.addEventListener('pointercancel', cancelMobConfirmPress)
    mobConfirmBtn.addEventListener('contextmenu', e => e.preventDefault())
  }

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
