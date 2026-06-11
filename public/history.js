'use strict'

const API_BASE = '/plugins/signalk-logbook-auto'

let _selectedIds = new Set()
let _currentTripId = null
let _tripsData = []
let _deleteTimer = null
let _confirmTimer = null

// ──── Chargement des trips ────
async function loadTrips () {
  try {
    const res = await fetch(`${API_BASE}/api/trips`)
    _tripsData = await res.json()
    renderTripsTable(_tripsData)
  } catch (e) { console.error('loadTrips error:', e) }
}

function renderTripsTable (trips) {
  const tbody = document.getElementById('trips-tbody')
  const countEl = document.getElementById('trip-count')
  countEl.textContent = trips.length + (trips.length > 1 ? ' trips' : ' trip')

  if (!trips.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="journal-empty" style="padding:16px 12px">Aucun trip enregistré.</td></tr>'
    return
  }

  tbody.innerHTML = trips.map(trip => {
    const start = _formatDt(trip.start_timestamp)
    const end = trip.end_timestamp ? _formatDt(trip.end_timestamp) : null
    const dur = trip.start_timestamp && trip.end_timestamp
      ? _formatDuration(trip.start_timestamp, trip.end_timestamp) : '—'
    const dist = trip.distance_nm != null ? trip.distance_nm.toFixed(1) + ' nm' : '—'
    const isActive = trip.status === 'active'

    return `<tr class="trip-row${isActive ? ' trip-active' : ''}" data-id="${trip.id}"
        onclick="handleRowClick(event, ${trip.id})">
      <td class="col-check" onclick="event.stopPropagation()">
        <input type="checkbox" class="trip-check" data-id="${trip.id}"
          ${isActive ? 'disabled' : ''} onchange="handleCheckChange(this)">
      </td>
      <td class="trip-id">#${trip.id}</td>
      <td class="trip-dt">
        <span class="trip-date">${start.date}</span>
        <span class="trip-time">${start.time}</span>
      </td>
      <td class="trip-dt">
        ${end
          ? `<span class="trip-date">${end.date}</span><span class="trip-time">${end.time}</span>`
          : `<span class="badge-active">EN COURS</span>`
        }
      </td>
      <td class="trip-mono">${dur}</td>
      <td class="trip-mono">${dist}</td>
    </tr>`
  }).join('')
}

// ──── Sélection pour détail ────
function handleRowClick (event, tripId) {
  if (event.target.tagName === 'INPUT') return
  if (_currentTripId === tripId) { closeDetail(); return }
  selectTripForDetail(tripId)
}

async function selectTripForDetail (tripId) {
  _currentTripId = tripId

  document.querySelectorAll('.trip-row').forEach(r => r.classList.remove('selected'))
  document.querySelector(`.trip-row[data-id="${tripId}"]`)?.classList.add('selected')

  const trip = _tripsData.find(t => t.id === tripId)
  const start = _formatDt(trip.start_timestamp)
  const end = trip.end_timestamp ? _formatDt(trip.end_timestamp) : null
  document.getElementById('detail-title').textContent =
    `Trip #${tripId}  ·  ${start.date} ${start.time}${end ? '  →  ' + end.date + ' ' + end.time : '  (en cours)'}`
  document.getElementById('btn-close-detail').style.display = ''

  const logEl = document.getElementById('detail-log')
  logEl.innerHTML = '<li class="journal-empty">Chargement…</li>'

  try {
    const res = await fetch(`${API_BASE}/api/trips/${tripId}/logbook`)
    const entries = await res.json()
    renderDetailLog(entries)
  } catch (e) {
    logEl.innerHTML = '<li class="journal-empty">Erreur de chargement.</li>'
  }

  document.getElementById('detail-section').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function renderDetailLog (entries) {
  const logEl = document.getElementById('detail-log')
  if (!entries.length) {
    logEl.innerHTML = '<li class="journal-empty">Aucune entrée dans ce trip.</li>'
    return
  }
  logEl.innerHTML = entries.map(entry => {
    const dt = new Date(entry.timestamp)
    const time = dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    const date = dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
    const details = _buildDetails(entry)
    return `<li class="journal-entry">
      <span class="journal-time">${time}<br><span class="journal-date-sub">${date}</span></span>
      <span class="journal-body">
        <span class="journal-summary">${escapeHtml(entry.summary)}</span>
        ${details ? `<span class="journal-details">${details}</span>` : ''}
      </span>
    </li>`
  }).join('')
}

function closeDetail () {
  _currentTripId = null
  document.querySelectorAll('.trip-row').forEach(r => r.classList.remove('selected'))
  document.getElementById('btn-close-detail').style.display = 'none'
  document.getElementById('detail-title').textContent = 'Sélectionner un trip ci-dessus'
  document.getElementById('detail-log').innerHTML =
    '<li class="journal-empty">Cliquez sur une ligne pour afficher le journal complet du trip.</li>'
}

// ──── Sélection multi ────
function handleCheckChange (checkbox) {
  const id = parseInt(checkbox.dataset.id)
  if (checkbox.checked) _selectedIds.add(id)
  else _selectedIds.delete(id)
  updateActionBar()
  updateSelectAll()
}

function toggleSelectAll (master) {
  document.querySelectorAll('.trip-check:not([disabled])').forEach(cb => {
    cb.checked = master.checked
    const id = parseInt(cb.dataset.id)
    if (master.checked) _selectedIds.add(id)
    else _selectedIds.delete(id)
  })
  updateActionBar()
}

function updateActionBar () {
  const bar = document.getElementById('action-bar')
  const label = document.getElementById('selection-label')
  const n = _selectedIds.size
  bar.style.display = n === 0 ? 'none' : ''
  label.textContent = `${n} trip${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`
}

function updateSelectAll () {
  const all = document.querySelectorAll('.trip-check:not([disabled])')
  const checked = document.querySelectorAll('.trip-check:not([disabled]):checked')
  const master = document.getElementById('select-all')
  master.indeterminate = checked.length > 0 && checked.length < all.length
  master.checked = all.length > 0 && checked.length === all.length
}

// ──── Téléchargement ────
async function downloadSelected () {
  if (_selectedIds.size === 0) return
  try {
    const res = await fetch(`${API_BASE}/api/trips/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [..._selectedIds] })
    })
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `logbook-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { console.error('downloadSelected error:', e) }
}

// ──── Suppression — double long-press ────
function startDeletePress () {
  const btn = document.getElementById('btn-delete')
  btn.classList.add('pressing-del')
  _deleteTimer = setTimeout(() => {
    btn.classList.remove('pressing-del')
    openDeleteModal()
  }, 1500)
}

function cancelDeletePress () {
  clearTimeout(_deleteTimer)
  document.getElementById('btn-delete')?.classList.remove('pressing-del')
}

function openDeleteModal () {
  const n = _selectedIds.size
  document.getElementById('delete-warning-text').textContent =
    `Vous allez supprimer définitivement ${n} trip${n > 1 ? 's' : ''} et ` +
    `toutes les entrées de journal associées.`
  document.getElementById('delete-modal').style.display = 'flex'
}

function closeDeleteModal () {
  document.getElementById('delete-modal').style.display = 'none'
  clearTimeout(_confirmTimer)
  document.getElementById('btn-confirm-delete')?.classList.remove('pressing-confirm')
}

function startConfirmPress () {
  const btn = document.getElementById('btn-confirm-delete')
  btn.classList.add('pressing-confirm')
  _confirmTimer = setTimeout(() => {
    btn.classList.remove('pressing-confirm')
    executeDelete()
  }, 2000)
}

function cancelConfirmPress () {
  clearTimeout(_confirmTimer)
  document.getElementById('btn-confirm-delete')?.classList.remove('pressing-confirm')
}

async function executeDelete () {
  const ids = [..._selectedIds]
  try {
    const res = await fetch(`${API_BASE}/api/trips`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    if (!res.ok) {
      const err = await res.json()
      console.error('deleteTrips error:', err)
      closeDeleteModal()
      return
    }
    // Si le trip affiché dans le détail a été supprimé, fermer le panneau
    if (_currentTripId && ids.includes(_currentTripId)) closeDetail()
    _selectedIds.clear()
    updateActionBar()
    document.getElementById('select-all').checked = false
    closeDeleteModal()
    await loadTrips()
  } catch (e) { console.error('executeDelete error:', e) }
}

// ──── Utilitaires ────
function _formatDt (iso) {
  const d = new Date(iso)
  return {
    date: d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }),
    time: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  }
}

function _formatDuration (start, end) {
  const ms = new Date(end) - new Date(start)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`
}

function _buildDetails (entry) {
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
    if (c.wind_speed_kts != null) cParts.push(`Vent ${c.wind_speed_kts} kt`)
    if (c.pressure_hpa != null) cParts.push(`${c.pressure_hpa} hPa`)
    if (cParts.length) parts.push(`<span class="journal-conditions">${cParts.join(' · ')}</span>`)
  }

  return parts.join('')
}

const escapeHtml = s =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ──── Init ────
document.addEventListener('DOMContentLoaded', () => {
  loadTrips()

  // Long press sur "Supprimer"
  const delBtn = document.getElementById('btn-delete')
  if (delBtn) {
    delBtn.addEventListener('pointerdown', startDeletePress)
    delBtn.addEventListener('pointerup', cancelDeletePress)
    delBtn.addEventListener('pointercancel', cancelDeletePress)
    delBtn.addEventListener('contextmenu', e => e.preventDefault())
  }

  // Long press sur "Confirmer" dans le modal (2 s, plus long)
  const confirmBtn = document.getElementById('btn-confirm-delete')
  if (confirmBtn) {
    confirmBtn.addEventListener('pointerdown', startConfirmPress)
    confirmBtn.addEventListener('pointerup', cancelConfirmPress)
    confirmBtn.addEventListener('pointercancel', cancelConfirmPress)
    confirmBtn.addEventListener('contextmenu', e => e.preventDefault())
  }
})
