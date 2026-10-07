/* ── State ───────────────────────────────────────────────────────────────── */
let currentArea      = null;
let currentSubtab    = 'pool';
let displayTz        = 'MTY';
let calCurrentMonday = null;

const areaPool           = { sm: [], merge: [] };
const activeShiftId      = { sm: null, merge: null };
const activeShiftTickets = { sm: [], merge: [] };
let   allShifts          = { sm: [], merge: [] };
let   areaHistory        = { sm: [], merge: [] };

const poolFilters    = { id:'', subject:'', customer:'', prepFrom:'', prepTo:'', execFrom:'', execTo:'' };
let   poolShiftOnly  = false;
const shiftFilters   = { id:'', subject:'', processor:'', category:'', userStatus:'', priority:'', hoReview:'', notes:'' };
const historyFilters = { id:'', subject:'', processor:'', category:'', ticketStatus:'', shiftDate:'' };

/* ── Config ──────────────────────────────────────────────────────────────── */
let config = {
  processors:    [{ name: 'Unassigned', color: '#888' }],
  ticketStatuses:[
    { name: 'New',             color: '#546E7A' },
    { name: 'In Process',      color: '#0288D1' },
    { name: 'Waiting',         color: '#F9A825' },
    { name: 'Pending Customer', color: '#EF6C00' },
    { name: 'Awaiting CR',      color: '#6A1B9A' },
    { name: 'Done',             color: '#2E7D32' },
  ],
  userStatuses:  [
    { name: 'new',         color: '#555' },
    { name: 'in-progress', color: '#0277BD' },
    { name: 'done',        color: '#2E7D32' },
    { name: 'HO',          color: '#CE93D8' },
  ],
  validations:   [
    { name: 'pending', color: '#555' },
    { name: 'ok',      color: '#2E7D32' },
    { name: 'fail',    color: '#C62828' },
  ],
  categories:    [
    { name: 'Self',        color: '#4CAF50' },
    { name: 'Non Self',    color: '#0288D1' },
    { name: 'TQS',         color: '#CE93D8' },
    { name: 'Seguimiento', color: '#FFB300' },
    { name: 'Análisis',    color: '#FF7043' },
    { name: 'Monitoreo',   color: '#26C6DA' },
  ],
  hoReviews: [
    { name: 'HO',   color: '#CE93D8' },
    { name: 'Done', color: '#2E7D32' },
    { name: 'Skip', color: '#555' },
  ],
};
function loadConfig() {
  try {
    const s = localStorage.getItem('ticketConfig');
    if (s) {
      const saved = JSON.parse(s);
      config = saved;
      // Migrate old category set to new one
      const oldNames = new Set(['Installations','Upgrade','Migration','Other']);
      const hasOnlyOld = config.categories?.length && config.categories.every(c => oldNames.has(c.name));
      if (!config.categories?.length || hasOnlyOld) {
        config.categories = [
          { name: 'Self',        color: '#4CAF50' },
          { name: 'Non Self',    color: '#0288D1' },
          { name: 'TQS',         color: '#CE93D8' },
          { name: 'Seguimiento', color: '#FFB300' },
          { name: 'Análisis',    color: '#FF7043' },
          { name: 'Monitoreo',   color: '#26C6DA' },
        ];
        saveConfig();
      }
      if (!config.hoReviews?.length) {
        config.hoReviews = [
          { name: 'HO',   color: '#CE93D8' },
          { name: 'Done', color: '#2E7D32' },
          { name: 'Skip', color: '#555' },
        ];
        saveConfig();
      }
      // Add HO to userStatuses if missing
      if (config.userStatuses?.length && !config.userStatuses.find(s => s.name === 'HO')) {
        config.userStatuses.push({ name: 'HO', color: '#CE93D8' });
        saveConfig();
      }
      // Add New/Waiting to ticketStatuses if missing
      const tsNames = new Set((config.ticketStatuses||[]).map(s => s.name));
      let tsDirty = false;
      if (!tsNames.has('New'))     { config.ticketStatuses.unshift({ name: 'New',     color: '#546E7A' }); tsDirty = true; }
      if (!tsNames.has('Waiting')) {
        const ipIdx = config.ticketStatuses.findIndex(s => s.name === 'In Process');
        config.ticketStatuses.splice(ipIdx >= 0 ? ipIdx + 1 : config.ticketStatuses.length, 0, { name: 'Waiting', color: '#F9A825' });
        tsDirty = true;
      }
      if (tsDirty) saveConfig();
    }
  } catch {}
}
function saveConfig() {
  localStorage.setItem('ticketConfig', JSON.stringify(config));
  fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(config) }).catch(() => {});
}
loadConfig();

/* ── Socket ──────────────────────────────────────────────────────────────── */
const socket = io();

socket.on('connect',    () => updateConnBadge(true));
socket.on('disconnect', () => updateConnBadge(false));
socket.on('users:count', n => { document.getElementById('userCount').textContent = `${n} online`; });

socket.on('sm:pool:update',    rows => { areaPool.sm    = rows; updatePoolCount('sm');    if (currentArea==='sm'    && currentSubtab==='pool')  renderPoolTable(); });
socket.on('merge:pool:update', rows => { areaPool.merge = rows; updatePoolCount('merge'); if (currentArea==='merge' && currentSubtab==='pool')  renderPoolTable(); });

socket.on('sm:shift:update',    data => onShiftUpdate('sm',    data));
socket.on('merge:shift:update', data => onShiftUpdate('merge', data));

function onShiftUpdate(area, data) {
  const { shift, tickets } = data || {};
  if (!shift) return;
  activeShiftTickets[area] = tickets || [];
  if (shift.id === activeShiftId[area] && currentArea === area) {
    if (currentSubtab === 'shift') renderShiftTable();
    else if (currentSubtab === 'ho') renderHOTable();
  }
  updateShiftCount(area);
}

function updateConnBadge(online) {
  const el = document.getElementById('connBadge');
  el.textContent = online ? '● Online' : '● Offline';
  el.classList.toggle('online', online);
}
function updatePoolCount(area) {
  if (currentArea === area) document.getElementById('poolCount').textContent = `${(areaPool[area]||[]).length} tickets in pool`;
}

function updateShiftCount(area) {
  if (currentArea === area) document.getElementById('shiftCount').textContent = `${(activeShiftTickets[area]||[]).length} tickets`;
}

/* ── Load processors from Authentik ─────────────────────────────────────── */
window._authentikUsers = {};
async function loadAuthentikUsers(area) {
  try {
    const url = area ? `/api/users?area=${area}` : '/api/users';
    const res = await fetch(url);
    if (!res.ok) return;
    const users = await res.json();
    if (!Array.isArray(users) || !users.length) return;
    const existing = new Map(config.processors.map(p => [p.name, p.color]));
    const COLORS = ['#0288D1','#7B1FA2','#E65100','#2E7D32','#C62828','#00838F','#5c3f7f','#6D4C41','#1565C0','#558B2F'];
    config.processors = users.map((name, i) => ({
      name,
      color: existing.get(name) || COLORS[i % COLORS.length],
    }));
    saveConfig();
    renderShiftTable();
    // Also load full user objects (pk + name) for calendar/matrix
    if (area) {
      const fullRes = await fetch(`/api/users/full?area=${area}`);
      if (fullRes.ok) window._authentikUsers[area] = await fullRes.json();
    }
  } catch {}
}
fetch('/auth/me').then(r=>r.ok?r.json():null).then(resp => {
  if (!resp?.authenticated) return;
  const u = resp.user || {};
  const displayName = u.name || u.email || u.sub || '';
  if (displayName) document.getElementById('authUser').textContent = displayName;
  const groups = u.groups || [];
  const canSM    = groups.some(g => ['sm-users','sm-leads','managers','authentik Admins'].includes(g));
  const canMerge = groups.some(g => ['merge-users','merge-leads','managers','authentik Admins'].includes(g));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const area = btn.dataset.area;
    if ((area==='sm' && canSM) || (area==='merge' && canMerge)) btn.classList.remove('hidden');
  });
  if      (canSM)    { switchArea('sm');    loadAuthentikUsers('sm'); }
  else if (canMerge) { switchArea('merge'); loadAuthentikUsers('merge'); }
  else               loadAuthentikUsers();
});

fetch('/api/version').then(r=>r.ok?r.json():null).then(v => {
  if (v?.version) document.getElementById('appVersion').textContent = `v${v.version}`;
});

/* ── Area + Subtab switching ─────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchArea(btn.dataset.area)));

function switchArea(area) {
  currentArea = area;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.area === area));
  document.getElementById('subtabBar').style.display = 'flex';
  loadAreaShifts(area);
  switchSubtab(currentSubtab);
  loadAuthentikUsers(area);
}

document.querySelectorAll('.subtab-btn').forEach(btn => btn.addEventListener('click', () => switchSubtab(btn.dataset.subtab)));

function switchSubtab(subtab) {
  currentSubtab = subtab;
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.toggle('active', b.dataset.subtab === subtab));

  ['poolToolbar','shiftToolbar','hoToolbar','historyToolbar'].forEach(id => document.getElementById(id).style.display = 'none');
  ['poolScrollArea','shiftScrollArea','hoScrollArea','historyScrollArea','calendarScrollArea','aconfigScrollArea'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('poolStats').style.display = 'none';

  if (subtab === 'pool') {
    document.getElementById('poolToolbar').style.display = 'flex';
    document.getElementById('poolScrollArea').style.display = 'block';
    updatePoolCount(currentArea);
    renderPoolTable();
  } else if (subtab === 'shift') {
    document.getElementById('shiftToolbar').style.display = 'flex';
    document.getElementById('shiftScrollArea').style.display = 'block';
    updateShiftCount(currentArea);
    renderShiftTable();
  } else if (subtab === 'ho') {
    document.getElementById('hoToolbar').style.display = 'flex';
    document.getElementById('hoScrollArea').style.display = 'block';
    renderHOTable();
  } else if (subtab === 'history') {
    document.getElementById('historyToolbar').style.display = 'flex';
    document.getElementById('historyScrollArea').style.display = 'block';
    loadHistory(currentArea);
  } else if (subtab === 'calendar') {
    document.getElementById('calendarScrollArea').style.display = 'block';
    calRenderWeek();
  } else if (subtab === 'aconfig') {
    document.getElementById('aconfigScrollArea').style.display = 'block';
    aconfigLoad();
  }
}

/* ── Shift management ────────────────────────────────────────────────────── */
async function loadAreaShifts(area) {
  try {
    const [todayRes, allRes] = await Promise.all([
      fetch(`/api/${area}/shifts/today`),
      fetch(`/api/${area}/shifts`),
    ]);
    const today = todayRes.ok ? await todayRes.json() : null;
    const all   = allRes.ok   ? await allRes.json()   : [];
    allShifts[area] = all;

    const sel = document.getElementById('shiftSelector');
    if (currentArea !== area) return;
    sel.innerHTML = '';
    all.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.date}${s.label ? ' — '+s.label : ''}${s.status==='closed' ? ' [closed]' : ''}`;
      sel.appendChild(opt);
    });

    if (today) {
      activeShiftId[area] = today.id;
      sel.value = today.id;
      const tickRes = await fetch(`/api/${area}/shifts/${today.id}/tickets`);
      if (tickRes.ok) {
        activeShiftTickets[area] = await tickRes.json();
        if (currentArea === area && currentSubtab === 'shift') renderShiftTable();
        if (currentArea === area && currentSubtab === 'ho') renderHOTable();
      }
    }
    updateShiftCount(area);
  } catch (e) { console.error('loadAreaShifts:', e); }
}

document.getElementById('shiftSelector').addEventListener('change', async function() {
  const shiftId = parseInt(this.value);
  if (!shiftId || !currentArea) return;
  activeShiftId[currentArea] = shiftId;
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets`);
  if (res.ok) {
    activeShiftTickets[currentArea] = await res.json();
    updateShiftCount(currentArea);
    if (currentSubtab === 'shift') renderShiftTable();
    else if (currentSubtab === 'ho') renderHOTable();
  }
});

document.getElementById('btnNewShift').addEventListener('click', async () => {
  const label = prompt('Label for new shift (optional):', '');
  if (label === null) return;
  const res = await fetch(`/api/${currentArea}/shifts`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ label }),
  });
  if (!res.ok) { alert('Error creating shift'); return; }
  await loadAreaShifts(currentArea);
});

document.getElementById('btnDeleteShift').addEventListener('click', async () => {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) return;
  const sel = document.getElementById('shiftSelector');
  const label = sel.options[sel.selectedIndex]?.text || shiftId;
  if (!confirm(`¿Borrar shift "${label}" y todos sus tickets?`)) return;
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}`, { method: 'DELETE' });
  if (!res.ok) { alert('Error deleting shift'); return; }
  await loadAreaShifts(currentArea);
});

async function reloadShiftTickets() {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) return;
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets`);
  if (res.ok) {
    activeShiftTickets[currentArea] = await res.json();
    updateShiftCount(currentArea);
    if (currentSubtab === 'shift') renderShiftTable();
    else if (currentSubtab === 'ho') renderHOTable();
  }
}

async function patchShiftTicket(id, updates) {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) return;
  await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets/${id}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates),
  });
}

/* ── Shift toolbar actions ───────────────────────────────────────────────── */
document.getElementById('btnShiftLoadHO').addEventListener('click', () => showPanel('shiftHoPanel'));
document.getElementById('btnShiftHoCancel').addEventListener('click', () => hidePanel('shiftHoPanel'));

document.getElementById('btnShiftHoLoad').addEventListener('click', async () => {
  const raw = document.getElementById('shiftHoArea').value.trim();
  if (!raw) return;
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) { alert('No active shift'); return; }
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/load-ho`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ raw }),
  });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Error'); return; }
  document.getElementById('shiftHoArea').value = '';
  hidePanel('shiftHoPanel');
  await reloadShiftTickets();
});

const SR_DASHBOARD_URL = 'https://srdashboard.internal.cfapps.eu12.hana.ondemand.com/index.html#/sr/ticketServiceExecutions/?serviceTypes=&ticketWaitingReasonFilterMode=NE&serviceExecutionStatusCodes=&ticketWaitingReasonCodes=02&queues=MCD%2520SM%2520L2%252CMCD%2520SM%2520L2%2520WINDOWS&subcontractor=ACE15032&variant=standard';
document.getElementById('btnCopySRLink').addEventListener('click', () => {
  navigator.clipboard.writeText(SR_DASHBOARD_URL).then(() => {
    const btn = document.getElementById('btnCopySRLink');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    btn.style.background = '#2E7D32';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1800);
  });
});

document.getElementById('btnCopyHO').addEventListener('click', () => {
  const tickets = (activeShiftTickets[currentArea] || []).filter(t => t.hoReview === 'HO');
  if (!tickets.length) return;
  const HEADERS = ['Ticket ID','Subject','Processor','Notes','Category','Prep Start','Exec Start','My Status','Priority','HO Review'];
  const rows = tickets.map(t => [
    t.id,
    t.subject || '',
    t.processor || '',
    t.notes || t.comment || '',
    t.category || '',
    t.prepStart ? (fmtDate(t.prepStart) || t.prepStart) : '',
    t.execStart ? (fmtDate(t.execStart) || t.execStart) : '',
    t.userStatus || '',
    t.priority || '',
    t.hoReview || '',
  ].map(v => String(v).replace(/\t/g,' ')).join('\t'));
  const tsv = [HEADERS.join('\t'), ...rows].join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    const btn = document.getElementById('btnCopyHO');
    const orig = btn.textContent;
    btn.textContent = `✓ ${tickets.length} copiados`;
    btn.style.background = '#2E7D32';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1800);
  });
});

/* ── ICS export ──────────────────────────────────────────────────────────── */
function toICSDate(iso) {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}

function buildICS(tickets) {
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}@ticketdash`;
  const esc = s => (s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ticketdash//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];

  for (const t of tickets) {
    const desc = esc([t.processor && `Processor: ${t.processor}`, t.category && `Category: ${t.category}`, (t.notes||t.comment) && `Notes: ${t.notes||t.comment}`].filter(Boolean).join(' | '));

    if (t.prepStart) {
      const start = toICSDate(t.prepStart);
      const endD  = new Date((t.prepStart.endsWith('Z') ? t.prepStart : t.prepStart + 'Z'));
      endD.setUTCMinutes(endD.getUTCMinutes() + 20);
      const end = toICSDate(endD.toISOString());
      lines.push('BEGIN:VEVENT',`UID:prep-${t.id}-${uid()}`,`DTSTART:${start}`,`DTEND:${end}`,`SUMMARY:${esc(`[PREP] ${t.id} — ${t.subject||''}`)}`,`DESCRIPTION:${desc}`,'END:VEVENT');
    }

    if (t.execStart) {
      const start = toICSDate(t.execStart);
      let end;
      if (t.execEnd) {
        end = toICSDate(t.execEnd);
      } else {
        const endD = new Date((t.execStart.endsWith('Z') ? t.execStart : t.execStart + 'Z'));
        endD.setUTCMinutes(endD.getUTCMinutes() + 20);
        end = toICSDate(endD.toISOString());
      }
      lines.push('BEGIN:VEVENT',`UID:exec-${t.id}-${uid()}`,`DTSTART:${start}`,`DTEND:${end}`,`SUMMARY:${esc(`[EXEC] ${t.id} — ${t.subject||''}`)}`,`DESCRIPTION:${desc}`,'END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadICS(tickets, filename) {
  const eligible = tickets.filter(t => t.prepStart || t.execStart);
  if (!eligible.length) { alert('No tickets with Prep Start or Exec Start to export.'); return; }
  const blob = new Blob([buildICS(eligible)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('btnShiftExportICS').addEventListener('click', () => {
  const allTickets = activeShiftTickets[currentArea] || [];
  // respect active filters by re-applying shiftFilters
  const visible = allTickets.filter(t => {
    if (shiftFilters.id        && !t.id.includes(shiftFilters.id)) return false;
    if (shiftFilters.subject   && !(t.subject||'').toLowerCase().includes(shiftFilters.subject.toLowerCase())) return false;
    if (shiftFilters.notes     && !(t.notes||'').toLowerCase().includes(shiftFilters.notes.toLowerCase())) return false;
    if (shiftFilters.processor && (t.processor||'') !== shiftFilters.processor) return false;
    if (shiftFilters.category  && (t.category||'')  !== shiftFilters.category)  return false;
    if (shiftFilters.userStatus && (t.userStatus||'') !== shiftFilters.userStatus) return false;
    if (shiftFilters.priority  && (t.priority||'')   !== shiftFilters.priority)  return false;
    if (shiftFilters.hoReview  && (t.hoReview||'')   !== shiftFilters.hoReview)  return false;
    return true;
  });
  downloadICS(visible, `shift-${activeShiftId[currentArea]||'export'}.ics`);
});

document.getElementById('btnShiftLoadExec').addEventListener('click', async () => {
  const btn = document.getElementById('btnShiftLoadExec');
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) {
    btn.style.background = '#C62828';
    btn.textContent = '⚠ Sin turno activo';
    setTimeout(() => { btn.style.background = ''; btn.textContent = '⚡ Load executions'; }, 2000);
    return;
  }
  btn.disabled = true; btn.style.background = '#555'; btn.textContent = '⏳ Buscando…';
  try {
    const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/load-executions`, { method: 'POST' });
    const j = await res.json();
    btn.disabled = false; btn.style.background = ''; btn.textContent = '⚡ Load executions';
    if (!res.ok) { alert(j.error || 'Error del servidor'); return; }
    if (j.added === 0 && j.found === 0) {
      alert(`0 tickets encontrados en el pool.\nVentana buscada: ${j.window?.from} → ${j.window?.to}\n\nSube el XLSX en Pool para cargar las fechas.`);
    } else if (j.added === 0) {
      alert(`${j.found} tickets encontrados, ${j.skipped} ya estaban en el shift.`);
    } else {
      // éxito silencioso — la tabla se actualiza sola
    }
    await reloadShiftTickets();
  } catch(e) {
    btn.disabled = false; btn.style.background = '#C62828'; btn.textContent = '⚠ Error';
    setTimeout(() => { btn.style.background = ''; btn.textContent = '⚡ Load executions'; }, 3000);
    console.error('load-executions error:', e);
  }
});

document.getElementById('btnShiftAddToggle').addEventListener('click', () => {
  populateShiftAddSelects();
  shiftAddSelectedTicket = null;
  document.getElementById('shiftAddSearch').value = '';
  document.getElementById('shiftAddProcessor').value = '';
  document.getElementById('shiftAddCategory').value = '';
  document.getElementById('shiftAddNotes').value = '';
  document.getElementById('shiftAddSelected').style.display = 'none';
  document.getElementById('shiftAddFields').style.display = 'none';
  document.getElementById('btnShiftAddSave').style.display = 'none';
  renderShiftAddPoolList('');
  showPanel('shiftAddPanel');
  setTimeout(() => document.getElementById('shiftAddSearch').focus(), 50);
});
document.getElementById('btnShiftAddCancel').addEventListener('click', () => hidePanel('shiftAddPanel'));

let shiftAddSelectedTicket = null;

function renderShiftAddPoolList(q) {
  const pool = areaPool[currentArea] || [];
  const list = document.getElementById('shiftAddPoolList');
  const empty = document.getElementById('shiftAddPoolEmpty');
  const countEl = document.getElementById('shiftAddPoolCount');
  const lower = q.toLowerCase();
  const filtered = q ? pool.filter(t =>
    t.id.includes(q) || (t.subject||'').toLowerCase().includes(lower) || (t.customer||'').toLowerCase().includes(lower)
  ) : pool;

  countEl.textContent = `${filtered.length} / ${pool.length} tickets`;

  // remove previous rows
  list.querySelectorAll('.sapl-row').forEach(el => el.remove());

  if (!filtered.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const PRI_COLOR = {'Very High':'#f44336','High':'#FF9800','Medium':'#FFC107','Low':'#8BC34A'};

  filtered.forEach(t => {
    const row = document.createElement('div');
    row.className = 'sapl-row';
    const priColor = PRI_COLOR[t.priority] || '#555';
    row.style.cssText = 'display:grid;grid-template-columns:100px minmax(0,1fr) 90px 90px;gap:6px;padding:6px 10px;border-bottom:1px solid #222;cursor:pointer;font-size:11px;align-items:center;';
    row.innerHTML = `
      <span style="color:#4FC3F7;font-weight:600;">${t.id}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;" title="${(t.subject||'').replace(/"/g,'&quot;')}">${t.subject||'—'}</span>
      <span style="color:${priColor};font-size:10px;">${t.priority||'—'}</span>
      <span style="color:#888;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.customer||''}</span>
    `;
    row.addEventListener('mouseenter', () => row.style.background = '#252535');
    row.addEventListener('mouseleave', () => row.style.background = shiftAddSelectedTicket?.id === t.id ? '#1a2a1a' : '');
    row.addEventListener('click', () => selectShiftAddTicket(t));
    list.appendChild(row);
  });
}

function selectShiftAddTicket(t) {
  shiftAddSelectedTicket = t;

  // highlight row
  document.querySelectorAll('.sapl-row').forEach(r => r.style.background = '');
  document.querySelectorAll('.sapl-row').forEach(r => {
    if (r.querySelector('span')?.textContent === t.id) r.style.background = '#1a2a1a';
  });

  const sel = document.getElementById('shiftAddSelected');
  const PRI_COLOR = {'Very High':'#f44336','High':'#FF9800','Medium':'#FFC107','Low':'#8BC34A'};
  const priColor = PRI_COLOR[t.priority] || '#aaa';
  sel.innerHTML = [
    `<b style="color:#4FC3F7">${t.id}</b>`,
    t.priority  ? `<span style="color:${priColor}">${t.priority}</span>` : '',
    t.subject   ? `<span style="color:#eee">${t.subject}</span>` : '',
    t.customer  ? `<span style="color:#888">👤 ${t.customer}</span>` : '',
    t.execStart ? `<span style="color:#aaa">⚡ ${t.execStart.replace('T',' ')}</span>` : '',
    t.prepStart ? `<span style="color:#aaa">🔧 ${t.prepStart.replace('T',' ')}</span>` : '',
  ].filter(Boolean).join('<span style="color:#444">&nbsp;·&nbsp;</span>');
  sel.style.display = 'block';

  // prefill processor from pool
  if (t.processor) document.getElementById('shiftAddProcessor').value = t.processor;

  document.getElementById('shiftAddFields').style.display = 'block';
  document.getElementById('btnShiftAddSave').style.display = '';
}

document.getElementById('shiftAddSearch').addEventListener('input', function() {
  renderShiftAddPoolList(this.value.trim());
});

document.getElementById('btnShiftAddSave').addEventListener('click', async () => {
  if (!shiftAddSelectedTicket) { alert('Selecciona un ticket del pool'); return; }
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) { alert('No active shift'); return; }
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets/single`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      id:        shiftAddSelectedTicket.id,
      category:  document.getElementById('shiftAddCategory').value,
      processor: document.getElementById('shiftAddProcessor').value.trim(),
      notes:     document.getElementById('shiftAddNotes').value.trim(),
    }),
  });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Error adding ticket'); return; }
  hidePanel('shiftAddPanel');
  await reloadShiftTickets();
});

document.getElementById('btnShiftGenerateHO').addEventListener('click', async () => {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) { alert('No active shift'); return; }
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/generate-ho`);
  if (!res.ok) { alert('Error generating HO'); return; }
  const j = await res.json();
  document.getElementById('hoOutputText').value = j.text || '';
  showPanel('hoOutputPanel');
});
document.getElementById('btnHoOutputClose').addEventListener('click', () => hidePanel('hoOutputPanel'));
document.getElementById('btnHoOutputCopy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('hoOutputText').value);
});

document.getElementById('btnShiftClear').addEventListener('click', async () => {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) return;
  if (!confirm('Clear all tickets from this shift?')) return;
  await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets`, { method: 'DELETE' });
  await reloadShiftTickets();
});

document.getElementById('btnShiftSelLog').addEventListener('click', () => {
  if (selectedShiftTicketId) openChangeLog(selectedShiftTicketId);
});

document.getElementById('btnShiftSelPrep').addEventListener('click', () => {
  if (!selectedShiftTicketId) return;
  const t = (activeShiftTickets[currentArea] || []).find(x => x.id === selectedShiftTicketId);
  const btn = document.getElementById('btnShiftSelPrep');
  TDP.open(btn, t?.prepStart || '', iso => {
    patchShiftTicket(selectedShiftTicketId, { prepStart: iso });
    btn.textContent = iso ? `PS: ${fmtDate(iso)}` : 'PS: —';
  });
});

document.getElementById('btnShiftSelExec').addEventListener('click', () => {
  if (!selectedShiftTicketId) return;
  const t = (activeShiftTickets[currentArea] || []).find(x => x.id === selectedShiftTicketId);
  const btn = document.getElementById('btnShiftSelExec');
  TDP.open(btn, t?.execStart || '', iso => {
    patchShiftTicket(selectedShiftTicketId, { execStart: iso });
    btn.textContent = iso ? `ES: ${fmtDate(iso)}` : 'ES: —';
  });
});

document.getElementById('btnShiftSelDelete').addEventListener('click', async () => {
  if (!selectedShiftTicketId) return;
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) return;
  if (!confirm(`Remove ${selectedShiftTicketId} from shift?`)) return;
  await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets/${selectedShiftTicketId}`, { method:'DELETE' });
  setShiftSelection(null, '');
  await reloadShiftTickets();
});

/* ── Pool toolbar actions ────────────────────────────────────────────────── */
document.getElementById('btnPoolUpload').addEventListener('click', () => document.getElementById('poolFileInput').click());

document.getElementById('poolFileInput').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch(`/api/${currentArea}/pool/upload`, { method: 'POST', body: fd });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Upload failed'); return; }
  alert(`Pool updated: ${j.added} added, ${j.skipped} skipped`);
  this.value = '';
});

document.getElementById('btnPoolClear').addEventListener('click', async () => {
  if (!confirm('Clear the entire pool for this area?')) return;
  await fetch(`/api/${currentArea}/pool`, { method: 'DELETE' });
});

document.getElementById('btnPoolClearFilters').addEventListener('click', () => {
  Object.keys(poolFilters).forEach(k => poolFilters[k]='');
  poolShiftOnly = false;
  const btn = document.getElementById('btnPoolShiftOnly');
  btn.style.background='#1a3a2a'; btn.style.color='#66bb6a';
  renderPoolTable();
});

document.getElementById('btnPoolShiftOnly').addEventListener('click', () => {
  poolShiftOnly = !poolShiftOnly;
  const btn = document.getElementById('btnPoolShiftOnly');
  btn.style.background = poolShiftOnly ? '#2e6e2e' : '#1a3a2a';
  btn.style.color = poolShiftOnly ? '#fff' : '#66bb6a';
  renderPoolTable();
});

document.getElementById('btnFloatConfig').addEventListener('click', openConfig);
document.getElementById('btnConfigClose').addEventListener('click', () => hidePanel('configPanel'));

// Shift clear filters
document.getElementById('btnShiftClearFilters').addEventListener('click', () => {
  Object.keys(shiftFilters).forEach(k => shiftFilters[k] = '');
  // Reset all select/input filter controls in shiftGrid headers
  document.querySelectorAll('#shiftGrid .gh .col-filter, #shiftGrid .gh .col-filter-sel')
    .forEach(el => { el.value = ''; });
  document.getElementById('btnShiftClearFilters').style.display = 'none';
  renderShiftRows(null, null);
});

// History clear filters
document.getElementById('btnHistoryClearFilters').addEventListener('click', () => {
  Object.keys(historyFilters).forEach(k => historyFilters[k] = '');
  document.querySelectorAll('#historyGrid .gh .col-filter, #historyGrid .gh .col-filter-sel')
    .forEach(el => { el.value = ''; });
  document.getElementById('btnHistoryClearFilters').style.display = 'none';
  renderHistoryTable();
});

/* ── Timezone toggle ─────────────────────────────────────────────────────── */
document.querySelectorAll('.tz-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    displayTz = this.dataset.tz;
    localStorage.setItem('displayTz', displayTz);
    document.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('active', b.dataset.tz === displayTz));
    if (currentSubtab === 'shift') renderShiftTable();
    else if (currentSubtab === 'ho') renderHOTable();
    else if (currentSubtab === 'pool') renderPoolTable();
  });
});
(function initTz() {
  displayTz = localStorage.getItem('displayTz') || 'MTY';
  document.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('active', b.dataset.tz === displayTz));
})();

/* ── Panel helpers ───────────────────────────────────────────────────────── */
const backdrop = document.getElementById('panelBackdrop');
backdrop.addEventListener('click', hideAllPanels);

function showPanel(id) { hideAllPanels(); document.getElementById(id).classList.add('visible'); backdrop.classList.add('visible'); }
function hidePanel(id) { document.getElementById(id).classList.remove('visible'); if (!document.querySelector('.panel.visible')) backdrop.classList.remove('visible'); }
function hideAllPanels() { document.querySelectorAll('.panel.visible').forEach(p => p.classList.remove('visible')); backdrop.classList.remove('visible'); }

/* ── Date helpers ────────────────────────────────────────────────────────── */
// Ensures ISO strings without Z are treated as UTC, not browser local time
function toUtcDate(iso) {
  if (!iso) return null;
  const s = String(iso);
  const d = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !s.endsWith('Z') ? s + 'Z' : s);
  return isNaN(d) ? null : d;
}
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = toUtcDate(iso); if (!d) return iso;
    const ref = displayTz === 'MTY' ? new Date(d.getTime() - 6*3600000) : d;
    const mo = String(ref.getUTCMonth()+1).padStart(2,'0');
    const dy = String(ref.getUTCDate()).padStart(2,'0');
    const hh = String(ref.getUTCHours()).padStart(2,'0');
    const mm = String(ref.getUTCMinutes()).padStart(2,'0');
    return `${mo}/${dy} ${hh}:${mm}`;
  } catch { return iso; }
}

function dateUrgencyClass(iso, execEnd) {
  if (!iso) return '';
  try {
    const d = toUtcDate(iso); if (!d) return '';
    const min = (d.getTime() - Date.now()) / 60000; // minutes until event (negative = past)
    if (min > 15)          return 'date-future';   // blue  — more than 15 min away
    if (min > 5)           return 'date-warn';     // yellow — 5–15 min away
    if (min > 0)           return 'date-near';     // orange — less than 5 min away
    // active window: use execEnd if available, else 45 min default
    if (execEnd) {
      const end = toUtcDate(execEnd);
      if (end && Date.now() <= end.getTime()) return 'date-active'; // red — still within exec window
    } else {
      if (min >= -45)      return 'date-active';   // red — 0–45 min past (active window)
    }
    return 'date-expired';                         // gray — past exec window
  } catch { return ''; }
}

// Refresh urgency classes every minute without full re-render
setInterval(() => {
  document.querySelectorAll('.date-cell[data-iso]').forEach(cell => {
    const iso = cell.dataset.iso;
    const execEnd = cell.dataset.execend || '';
    const newCls = dateUrgencyClass(iso, execEnd);
    const urgencyClasses = ['date-future','date-warn','date-near','date-active','date-expired'];
    urgencyClasses.forEach(c => cell.classList.remove(c));
    if (newCls) cell.classList.add(newCls);
  });
}, 60000);

function priorityClass(p) {
  if (!p) return 'pri-bar-none';
  return `pri-bar-${p.toLowerCase().replace(' ','-')}`;
}

function makeDateInput(val, onchange) {
  const btn = document.createElement('button');
  btn.className = 'date-filter-btn';
  btn.title = val || 'Click to set date';

  let _current = val || '';

  function refresh() {
    btn.innerHTML = _current ? fmtDate(_current) : '—';
    btn.classList.toggle('active', !!_current);
  }
  refresh();

  btn.addEventListener('click', () => {
    TDP.open(btn, _current, iso => {
      _current = iso;
      refresh();
      onchange(iso);
    });
  });

  return btn;
}

function applySelectColor(sel, options) {
  const opt = (options||[]).find(o => (o.name||o) === sel.value);
  const color = opt?.color || '';
  if (color) {
    sel.style.background = color + '22'; // 13% opacity bg
    sel.style.color = color;
    sel.style.borderColor = color + '88';
  } else {
    sel.style.background = '';
    sel.style.color = '';
    sel.style.borderColor = '';
  }
}

function makeSelect(options, current, onchange, placeholder) {
  const sel = document.createElement('select'); sel.className = 'inline-select';
  if (placeholder) { const o=document.createElement('option'); o.value=''; o.textContent=placeholder; sel.appendChild(o); }
  (options||[]).forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.name || opt; o.textContent = opt.name || opt;
    if ((opt.name||opt) === current) o.selected = true;
    sel.appendChild(o);
  });
  // If current value isn't in the list, add it so it doesn't silently show as blank
  if (current && !(options||[]).some(o => (o.name||o) === current)) {
    const o = document.createElement('option'); o.value = current; o.textContent = current;
    o.selected = true; o.style.color = '#aaa'; sel.appendChild(o);
  }
  applySelectColor(sel, options);
  sel.addEventListener('change', () => {
    applySelectColor(sel, options);
    onchange(sel.value);
  });
  return sel;
}

function cell(classes) {
  const el = document.createElement('div'); el.className = 'gc ' + classes;
  el.addEventListener('mouseenter', () => el.classList.add('row-hover'));
  el.addEventListener('mouseleave', () => el.classList.remove('row-hover'));
  return el;
}

// Creates a <select> filter for column headers — options come from config arrays
function makeSelectFilter(filtersObj, key, getOptions, onChangeFn) {
  const sel = document.createElement('select');
  sel.className = 'col-filter-sel';
  const buildOptions = () => {
    const cur = sel.value || filtersObj[key] || '';
    sel.innerHTML = '';
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'All'; sel.appendChild(blank);
    (getOptions() || []).forEach(o => {
      const name = typeof o === 'string' ? o : o.name;
      const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
      if (name === cur) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!sel.value) sel.value = '';
  };
  buildOptions();
  sel.addEventListener('change', () => { filtersObj[key] = sel.value; onChangeFn(); });
  sel._rebuild = buildOptions; // allow caller to refresh options after config change
  return sel;
}

/* ── Change log modal ────────────────────────────────────────────────────── */
async function openChangeLog(ticketId) {
  const res = await fetch(`/api/${currentArea}/log/${ticketId}`);
  if (!res.ok) { alert('Error loading log'); return; }
  const entries = await res.json();
  const modal = document.getElementById('changeLogModal');
  document.getElementById('changeLogTitle').textContent = `Historial — ${ticketId}`;
  const body = document.getElementById('changeLogBody');
  body.innerHTML = '';
  if (!entries.length) {
    body.innerHTML = '<div style="color:#666;text-align:center;padding:20px;">Sin cambios registrados</div>';
  } else {
    const FIELD_LABELS = { ticketStatus:'T.Status', processor:'Processor', category:'Cat.', prepStart:'Prep Start', execStart:'Exec Start', notes:'Notes', comment:'Comment', priority:'Priority', customer:'Customer', serviceExecId:'Exec ID' };
    entries.forEach(e => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:130px 90px 1fr 1fr;gap:6px;padding:4px 0;border-bottom:1px solid #2a2a2a;font-size:11px;';
      const dt = new Date(e.changedAt);
      const dtStr = isNaN(dt) ? e.changedAt : fmtDate(e.changedAt+'Z').replace('T',' ');
      row.innerHTML = `
        <span style="color:#888">${dtStr}</span>
        <span style="color:#CE93D8;font-weight:bold">${e.changedBy||'?'}</span>
        <span style="color:#aaa">${FIELD_LABELS[e.field]||e.field}: <span style="color:#f44;text-decoration:line-through">${e.oldValue||'—'}</span></span>
        <span style="color:#aaa">→ <span style="color:#4fc3f7">${e.newValue||'—'}</span></span>
      `;
      body.appendChild(row);
    });
  }
  showPanel('changeLogModal');
}
document.getElementById('btnChangeLogClose').addEventListener('click', () => hidePanel('changeLogModal'));

/* ── Pool table ──────────────────────────────────────────────────────────── */
function statusBadge(status) {
  const s = (status||'').toLowerCase().replace(/\s+/g,'');
  let cls = 'badge-s-other';
  if (s.includes('new'))        cls = 'badge-s-new';
  else if (s.includes('inprocess') || s.includes('in process') || s.includes('process')) cls = 'badge-s-inprocess';
  else if (s.includes('sent'))  cls = 'badge-s-sent';
  else if (s.includes('complete') || s.includes('closed')) cls = 'badge-s-completed';
  else if (s.includes('reject') || s.includes('cancel'))  cls = 'badge-s-rejected';
  const b = document.createElement('span');
  b.className = `badge-status ${cls}`;
  b.textContent = status || '';
  b.title = status || '';
  return b;
}

function procColor(name) {
  const p = (config.processors||[]).find(p => p.name === name);
  return p ? p.color : null;
}

function renderPoolStats(all, visible) {
  const bar = document.getElementById('poolStats');
  if (!all.length) { bar.style.display='none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '';

  const now = Date.now();
  let urgent=0, overdue=0;
  const statusCount = {};
  visible.forEach(t => {
    const st = t.ticketStatus || 'Unknown';
    statusCount[st] = (statusCount[st]||0)+1;
    const cls = dateUrgencyClass(t.execStart||t.prepStart);
    if (cls==='date-imminent') urgent++;
    if (cls==='date-started')  overdue++;
  });

  const add = (label, val, cls) => {
    const s=document.createElement('div'); s.className=`pool-stat ${cls}`;
    s.innerHTML=`<span class="pool-stat-val">${val}</span> ${label}`;
    bar.appendChild(s);
  };
  add('total', `${visible.length}/${all.length}`, 'total');
  if (overdue)  add('overdue', overdue,  'overdue');
  if (urgent)   add('urgent',  urgent,   'urgent');

  const sep = document.createElement('div');
  sep.style.cssText='flex:1';
  bar.appendChild(sep);

  Object.entries(statusCount).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([s,n]) => {
    const chip=document.createElement('div'); chip.className='pool-stat proc-chip';
    const dot=document.createElement('span'); dot.style.cssText='display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:3px;';
    if (s.toLowerCase().includes('new'))     dot.style.background='#66bb6a';
    else if (s.toLowerCase().includes('process')) dot.style.background='#4FC3F7';
    else if (s.toLowerCase().includes('sent'))    dot.style.background='#FFB300';
    else dot.style.background='#666';
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(`${s}: ${n}`));
    bar.appendChild(chip);
  });
}

function makeDateFilterBtn(filterFromKey, filterToKey, onChangeCb) {
  const wrap = document.createElement('div');
  wrap.style.cssText='display:flex;gap:2px;';

  const fromBtn = document.createElement('button');
  fromBtn.className = 'date-filter-btn' + (poolFilters[filterFromKey] ? ' active' : '');
  fromBtn.title = 'Filter from date';
  fromBtn.innerHTML = `<span class="dfb-icon">▶</span>${poolFilters[filterFromKey] ? fmtDate(poolFilters[filterFromKey]) : 'From'}`;

  const toBtn = document.createElement('button');
  toBtn.className = 'date-filter-btn' + (poolFilters[filterToKey] ? ' active' : '');
  toBtn.title = 'Filter to date';
  toBtn.innerHTML = `<span class="dfb-icon">◀</span>${poolFilters[filterToKey] ? fmtDate(poolFilters[filterToKey]) : 'To'}`;

  fromBtn.addEventListener('click', () => {
    TDP.open(fromBtn, poolFilters[filterFromKey]||'', iso => {
      poolFilters[filterFromKey] = iso;
      onChangeCb();
    });
  });
  toBtn.addEventListener('click', () => {
    TDP.open(toBtn, poolFilters[filterToKey]||'', iso => {
      poolFilters[filterToKey] = iso;
      onChangeCb();
    });
  });

  wrap.appendChild(fromBtn);
  wrap.appendChild(toBtn);
  return wrap;
}

function inShiftWindow(isoStr) {
  if (!isoStr) return false;
  const d = toUtcDate(isoStr);
  if (!d) return false;
  // Convert to MTY (UTC-6)
  const mty = new Date(d.getTime() - 6 * 3600000);
  const nowMty = new Date(Date.now() - 6 * 3600000);
  // Same calendar day in MTY?
  if (mty.getUTCFullYear() !== nowMty.getUTCFullYear()) return false;
  if (mty.getUTCMonth()    !== nowMty.getUTCMonth())    return false;
  if (mty.getUTCDate()     !== nowMty.getUTCDate())     return false;
  // Within 09:30 – 18:30 MTY
  const hhmm = mty.getUTCHours() * 60 + mty.getUTCMinutes();
  return hhmm >= 9*60+30 && hhmm <= 18*60+30;
}

function renderPoolTable() {
  const poolTickets = areaPool[currentArea] || [];

  // check if any date filters active
  const hasDateFilter = poolFilters.prepFrom||poolFilters.prepTo||poolFilters.execFrom||poolFilters.execTo;
  const hasTxtFilter  = poolFilters.id||poolFilters.subject||poolFilters.customer;
  const clearBtn = document.getElementById('btnPoolClearFilters');
  if (clearBtn) clearBtn.style.display = (hasDateFilter||hasTxtFilter||poolShiftOnly) ? '' : 'none';

  const visible = poolTickets.filter(t => {
    if (poolFilters.id      && !t.id.includes(poolFilters.id)) return false;
    if (poolFilters.subject && !(t.subject||'').toLowerCase().includes(poolFilters.subject.toLowerCase())) return false;
    if (poolFilters.customer && !(t.customer||'').toLowerCase().includes(poolFilters.customer.toLowerCase())) return false;
    if (poolFilters.prepFrom && t.prepStart && t.prepStart < poolFilters.prepFrom) return false;
    if (poolFilters.prepTo   && t.prepStart && t.prepStart > poolFilters.prepTo)   return false;
    if (poolFilters.execFrom && t.execStart && t.execStart < poolFilters.execFrom) return false;
    if (poolFilters.execTo   && t.execStart && t.execStart > poolFilters.execTo)   return false;
    if (poolShiftOnly && !inShiftWindow(t.prepStart) && !inShiftWindow(t.execStart)) return false;
    return true;
  });

  renderPoolStats(poolTickets, visible);

  const grid = document.getElementById('poolGrid');

  // Build headers only once — date filter buttons are stateful
  const COLS = [
    { label:'Ticket ID', key:'id',       type:'text' },
    { label:'Subject',   key:'subject',  type:'text' },
    { label:'Status',    key:'',         type:'none' },
    { label:'Prep Start',key:'',         type:'date', from:'prepFrom', to:'prepTo' },
    { label:'Exec Start',key:'',         type:'date', from:'execFrom', to:'execTo' },
    { label:'Exec End',  key:'',         type:'none' },
    { label:'Customer',  key:'customer', type:'text' },
    { label:'Processor', key:'',         type:'none' },
    { label:'',          key:'',         type:'none' },
  ];

  if (grid.querySelectorAll('.gh').length !== COLS.length) {
    grid.querySelectorAll('.gh').forEach(h => h.remove());
    COLS.forEach((col, i) => {
      const gh=document.createElement('div'); gh.className='gh';
      const lbl=document.createElement('div'); lbl.className='gh-label'; lbl.textContent=col.label; gh.appendChild(lbl);
      if (col.type==='text') {
        const inp=document.createElement('input'); inp.className='col-filter'; inp.placeholder='…'; inp.value=poolFilters[col.key]||'';
        inp.addEventListener('input', () => { poolFilters[col.key]=inp.value; renderPoolRows(poolTickets, null); });
        gh.appendChild(inp);
      } else if (col.type==='date') {
        gh.appendChild(makeDateFilterBtn(col.from, col.to, () => renderPoolRows(poolTickets, null)));
      } else {
        const sp=document.createElement('div'); sp.style.height='22px'; gh.appendChild(sp);
      }
      grid.insertBefore(gh, grid.children[i] || null);
    });
  }

  renderPoolRows(poolTickets, visible);
}

function renderPoolRows(poolTickets, visible) {
  if (!visible) {
    poolTickets = areaPool[currentArea] || [];
    visible = poolTickets.filter(t => {
      if (poolFilters.id      && !t.id.includes(poolFilters.id)) return false;
      if (poolFilters.subject && !(t.subject||'').toLowerCase().includes(poolFilters.subject.toLowerCase())) return false;
      if (poolFilters.customer && !(t.customer||'').toLowerCase().includes(poolFilters.customer.toLowerCase())) return false;
      if (poolFilters.prepFrom && t.prepStart && t.prepStart < poolFilters.prepFrom) return false;
      if (poolFilters.prepTo   && t.prepStart && t.prepStart > poolFilters.prepTo)   return false;
      if (poolFilters.execFrom && t.execStart && t.execStart < poolFilters.execFrom) return false;
      if (poolFilters.execTo   && t.execStart && t.execStart > poolFilters.execTo)   return false;
      if (poolShiftOnly && !inShiftWindow(t.prepStart) && !inShiftWindow(t.execStart)) return false;
      return true;
    });
  }
  const grid = document.getElementById('poolGrid');
  grid.querySelectorAll('.gc, .empty-state').forEach(el => el.remove());

  if (!visible.length) {
    const emp=document.createElement('div'); emp.className='empty-state'; emp.style.gridColumn='1/-1';
    emp.textContent = poolTickets.length ? 'No tickets match filters.' : 'Pool vacío — sube un XLSX.';
    grid.appendChild(emp);
    document.getElementById('poolCount').textContent = `0 / ${poolTickets.length} tickets`;
    return;
  }

  visible.forEach(t => {
    const pc = '';

    const gcId=cell(pc);
    const a=document.createElement('a');
    a.href=`https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id)}`;
    a.target='_blank'; a.rel='noopener'; a.className='ticket-link'; a.textContent=t.id;
    gcId.appendChild(a); grid.appendChild(gcId);

    const gcSubj=cell(pc+' top');
    const wrap=document.createElement('div'); wrap.className='subj-wrap';
    const st=document.createElement('div'); st.className='subj-text'; st.textContent=t.subject||''; st.title=t.subject||'';
    wrap.appendChild(st);
    if (t.ctRdy) { const cr=document.createElement('div'); cr.className='ct-rdy'; cr.textContent='⏰ '+(fmtDate(t.ctRdy)||t.ctRdy); wrap.appendChild(cr); }
    gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    const gcStatus=cell(pc);
    if (t.ticketStatus) gcStatus.appendChild(statusBadge(t.ticketStatus));
    grid.appendChild(gcStatus);

    const urgP=dateUrgencyClass(t.prepStart);
    const gcPrep=cell(pc+(urgP?' '+urgP:'')+' date-cell');
    if (t.prepStart) gcPrep.dataset.iso = t.prepStart;
    const pText=document.createElement('span'); pText.className='date-text'; pText.textContent=fmtDate(t.prepStart)||'—';
    gcPrep.appendChild(pText); grid.appendChild(gcPrep);

    const urgE=dateUrgencyClass(t.execStart, t.execEnd);
    const gcExecS=cell(pc+(urgE?' '+urgE:'')+' date-cell');
    if (t.execStart) gcExecS.dataset.iso = t.execStart;
    if (t.execEnd)   gcExecS.dataset.execend = t.execEnd;
    const eText=document.createElement('span'); eText.className='date-text'; eText.textContent=fmtDate(t.execStart)||'—';
    gcExecS.appendChild(eText); grid.appendChild(gcExecS);

    const gcExecE=cell(pc+' date-cell');
    const eEndText=document.createElement('span'); eEndText.className='date-text'; eEndText.textContent=fmtDate(t.execEnd)||'—';
    gcExecE.appendChild(eEndText); grid.appendChild(gcExecE);

    const gcCust=cell(pc); gcCust.textContent=t.customer||''; gcCust.title=t.customer||''; grid.appendChild(gcCust);

    const gcProc=cell(pc);
    if (t.processor) {
      const col=procColor(t.processor);
      if (col) { const dot=document.createElement('span'); dot.className='proc-dot'; dot.style.background=col; gcProc.appendChild(dot); }
      const txt=document.createElement('span'); txt.textContent=t.processor; txt.title=t.processor;
      txt.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      gcProc.appendChild(txt);
    }
    grid.appendChild(gcProc);

    const gcDel=cell(pc);
    const delBtn=document.createElement('button'); delBtn.className='btn-icon'; delBtn.textContent='🗑'; delBtn.title='Remove from pool';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${t.id} from pool?`)) return;
      await fetch(`/api/${currentArea}/pool/${t.id}`, { method:'DELETE' });
    });
    gcDel.appendChild(delBtn); grid.appendChild(gcDel);
  });

  document.getElementById('poolCount').textContent = `${visible.length} / ${poolTickets.length} tickets`;
}

/* ── Shift table ─────────────────────────────────────────────────────────── */
let selectedShiftTicketId = null;

function setShiftSelection(id, subjectText) {
  selectedShiftTicketId = id;
  const actions = document.getElementById('shiftSelActions');
  const label   = document.getElementById('shiftSelLabel');
  if (id) {
    actions.style.display = 'flex';
    label.textContent = id + (subjectText ? ' — ' + subjectText.slice(0, 40) : '');
    const t = (activeShiftTickets[currentArea] || []).find(x => x.id === id);
    document.getElementById('btnShiftSelPrep').textContent = t?.prepStart ? `PS: ${fmtDate(t.prepStart)}` : 'PS: —';
    document.getElementById('btnShiftSelExec').textContent = t?.execStart ? `ES: ${fmtDate(t.execStart)}` : 'ES: —';
  } else {
    actions.style.display = 'none';
    label.textContent = '';
    document.getElementById('btnShiftSelPrep').textContent = 'PS: —';
    document.getElementById('btnShiftSelExec').textContent = 'ES: —';
  }
  // Highlight selected row
  document.querySelectorAll('.shift-grid .gc').forEach(el => {
    if (el.dataset.rowId === id) el.classList.add('row-selected');
    else el.classList.remove('row-selected');
  });
}

function renderShiftTable() {
  const tickets = activeShiftTickets[currentArea] || [];
  const shiftId = activeShiftId[currentArea];

  const visible = tickets.filter(t => {
    if (shiftFilters.id        && !t.id.includes(shiftFilters.id)) return false;
    if (shiftFilters.subject   && !(t.subject||'').toLowerCase().includes(shiftFilters.subject.toLowerCase())) return false;
    if (shiftFilters.notes     && !(t.notes||'').toLowerCase().includes(shiftFilters.notes.toLowerCase())) return false;
    if (shiftFilters.processor && (t.processor||'') !== shiftFilters.processor) return false;
    if (shiftFilters.category  && (t.category||'')  !== shiftFilters.category)  return false;
    if (shiftFilters.userStatus && (t.userStatus||'') !== shiftFilters.userStatus) return false;
    if (shiftFilters.priority  && (t.priority||'')   !== shiftFilters.priority)  return false;
    if (shiftFilters.hoReview  && (t.hoReview||'')   !== shiftFilters.hoReview)  return false;
    return true;
  });

  const grid = document.getElementById('shiftGrid');

  // Col order: Ticket ID | Subject | Processor | Notes | Cat | Prep Start | Exec Start | My Status | Priority | HO Review
  const COLS = [
    { label:'Ticket ID',  key:'id',        type:'text' },
    { label:'Subject',    key:'subject',   type:'text' },
    { label:'Processor',  key:'processor', type:'select', opts:() => config.processors },
    { label:'Notes',      key:'notes',     type:'text' },
    { label:'Cat.',       key:'category',  type:'select', opts:() => config.categories },
    { label:'Prep Start', key:'',          type:'none' },
    { label:'Exec Start', key:'',          type:'none' },
    { label:'My Status',  key:'userStatus',type:'select', opts:() => config.userStatuses },
    { label:'Priority',   key:'priority',  type:'select', opts:() => [{name:'Very High'},{name:'High'},{name:'Medium'},{name:'Low'}] },
    { label:'HO Review',  key:'hoReview',  type:'select', opts:() => config.hoReviews },
  ];

  if (grid.querySelectorAll('.gh').length !== COLS.length) {
    grid.querySelectorAll('.gh').forEach(h => h.remove());
    COLS.forEach((col, i) => {
      const gh=document.createElement('div'); gh.className='gh';
      const lbl=document.createElement('div'); lbl.className='gh-label'; lbl.textContent=col.label; gh.appendChild(lbl);
      if (col.type==='text') {
        const inp=document.createElement('input'); inp.className='col-filter'; inp.placeholder='…'; inp.value=shiftFilters[col.key]||'';
        inp.addEventListener('input', () => { shiftFilters[col.key]=inp.value; renderShiftRows(null, null); });
        gh.appendChild(inp);
      } else if (col.type==='select') {
        gh.appendChild(makeSelectFilter(shiftFilters, col.key, col.opts, () => renderShiftRows(null, null)));
      } else { const sp=document.createElement('div'); sp.style.height='22px'; gh.appendChild(sp); }
      grid.insertBefore(gh, grid.children[i] || null);
    });
  }

  renderShiftRows(tickets, visible);
}

function renderShiftRows(tickets, visible) {
  const shiftId = activeShiftId[currentArea];
  if (!visible) {
    tickets = activeShiftTickets[currentArea] || [];
    visible = tickets.filter(t => {
      if (shiftFilters.id        && !t.id.includes(shiftFilters.id)) return false;
      if (shiftFilters.subject   && !(t.subject||'').toLowerCase().includes(shiftFilters.subject.toLowerCase())) return false;
      if (shiftFilters.notes     && !(t.notes||'').toLowerCase().includes(shiftFilters.notes.toLowerCase())) return false;
      if (shiftFilters.processor && (t.processor||'') !== shiftFilters.processor) return false;
      if (shiftFilters.category  && (t.category||'')  !== shiftFilters.category)  return false;
      if (shiftFilters.userStatus && (t.userStatus||'') !== shiftFilters.userStatus) return false;
      if (shiftFilters.priority  && (t.priority||'')   !== shiftFilters.priority)  return false;
      if (shiftFilters.hoReview  && (t.hoReview||'')   !== shiftFilters.hoReview)  return false;
      return true;
    });
  }
  const grid = document.getElementById('shiftGrid');
  grid.querySelectorAll('.gc, .empty-state').forEach(el => el.remove());

  if (!shiftId) {
    const emp=document.createElement('div'); emp.className='empty-state'; emp.style.gridColumn='1/-1';
    emp.textContent='No hay shift activo.'; grid.appendChild(emp); return;
  }
  if (!visible.length) {
    const emp=document.createElement('div'); emp.className='empty-state'; emp.style.gridColumn='1/-1';
    emp.textContent = tickets.length ? 'No tickets match filters.' : 'Shift vacío — carga el HO o agrega tickets.';
    grid.appendChild(emp);
    document.getElementById('shiftCount').textContent=`0 / ${tickets.length} tickets`; return;
  }

  const PRIS = [{name:'Very High',color:'#f44336'},{name:'High',color:'#FF9800'},{name:'Medium',color:'#FFC107'},{name:'Low',color:'#4CAF50'}];

  visible.forEach(t => {
    const pc = priorityClass(t.priority);
    const isSelected = t.id === selectedShiftTicketId;

    const rowCells = [];
    const mkCell = (cls) => {
      const el = cell(cls + (isSelected ? ' row-selected' : ''));
      el.dataset.rowId = t.id;
      el.addEventListener('click', e => {
        // Don't steal clicks from inputs/selects inside the cell
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'A') return;
        if (selectedShiftTicketId === t.id) { setShiftSelection(null, ''); }
        else { setShiftSelection(t.id, t.subject||''); }
      });
      rowCells.push(el);
      return el;
    };

    // Ticket ID — color reflects Ticket Status from pool/system
    const gcId = mkCell(pc);
    const tsOpt = (config.ticketStatuses||[]).find(o => o.name === t.ticketStatus);
    const tsColor = tsOpt?.color || '#4FC3F7';
    const a = document.createElement('a');
    a.href = `https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id)}`;
    a.target='_blank'; a.rel='noopener'; a.className='ticket-link';
    a.style.color = tsColor;
    a.textContent=t.id;
    a.title = t.ticketStatus ? `Status: ${t.ticketStatus}` : '';
    gcId.appendChild(a); grid.appendChild(gcId);

    // Subject + ctRdy
    const gcSubj = mkCell(pc+' top');
    const wrap = document.createElement('div'); wrap.className='subj-wrap';
    const st = document.createElement('div'); st.className='subj-text'; st.textContent=t.subject||''; st.title=t.subject||'';
    wrap.appendChild(st);
    if (t.ctRdy) { const cr=document.createElement('div'); cr.className='ct-rdy'; cr.textContent='⏰ '+(fmtDate(t.ctRdy)||t.ctRdy); wrap.appendChild(cr); }
    gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    // Processor
    const gcProc = mkCell(pc);
    gcProc.appendChild(makeSelect(config.processors, t.processor, val => patchShiftTicket(t.id, {processor:val}), '—'));
    grid.appendChild(gcProc);

    // Notes
    const gcNotes = mkCell(pc+' top');
    const ni = document.createElement('input'); ni.className='inline-input'; ni.value=t.notes||t.comment||''; ni.placeholder='notes…'; ni.style.width='100%';
    ni.addEventListener('change', () => patchShiftTicket(t.id, {notes:ni.value}));
    gcNotes.appendChild(ni); grid.appendChild(gcNotes);

    // Category
    const gcCat = mkCell(pc);
    gcCat.appendChild(makeSelect(config.categories, t.category, val => patchShiftTicket(t.id, {category:val}), '—'));
    grid.appendChild(gcCat);

    // Prep Start
    const urgP = dateUrgencyClass(t.prepStart);
    const gcPrep = mkCell(pc+(urgP?' '+urgP:'')+' date-cell');
    if (t.prepStart) gcPrep.dataset.iso = t.prepStart;
    const pTxtS = document.createElement('span'); pTxtS.className='date-text'; pTxtS.textContent=fmtDate(t.prepStart)||'—';
    gcPrep.appendChild(pTxtS); grid.appendChild(gcPrep);

    // Exec Start
    const urgE = dateUrgencyClass(t.execStart, t.execEnd);
    const gcExec = mkCell(pc+(urgE?' '+urgE:'')+' date-cell');
    if (t.execStart) gcExec.dataset.iso = t.execStart;
    if (t.execEnd)   gcExec.dataset.execend = t.execEnd;
    const eTxtS = document.createElement('span'); eTxtS.className='date-text'; eTxtS.textContent=fmtDate(t.execStart)||'—';
    gcExec.appendChild(eTxtS); grid.appendChild(gcExec);

    // My Status
    const gcMyStatus = mkCell(pc);
    gcMyStatus.appendChild(makeSelect(config.userStatuses, t.userStatus, val => patchShiftTicket(t.id, {userStatus:val}), '—'));
    grid.appendChild(gcMyStatus);

    // Priority
    const gcPri = mkCell(pc);
    const priSel = makeSelect(PRIS, t.priority, val => { patchShiftTicket(t.id, {priority:val}); renderShiftTable(); }, '—');
    gcPri.appendChild(priSel); grid.appendChild(gcPri);

    // HO Review
    const gcHO = mkCell(pc);
    const hoSel = makeSelect(config.hoReviews, t.hoReview, val => patchShiftTicket(t.id, {hoReview:val}), '—');
    const hoOpt = (config.hoReviews||[]).find(o => o.name === t.hoReview);
    if (hoOpt?.color) hoSel.style.color = hoOpt.color;
    hoSel.addEventListener('change', () => {
      const opt = (config.hoReviews||[]).find(o => o.name === hoSel.value);
      hoSel.style.color = opt?.color || '';
    });
    gcHO.appendChild(hoSel); grid.appendChild(gcHO);
  });

  document.getElementById('shiftCount').textContent=`${visible.length} / ${tickets.length} tickets`;
  const hasShiftFilter = Object.values(shiftFilters).some(v => v !== '');
  document.getElementById('btnShiftClearFilters').style.display = hasShiftFilter ? '' : 'none';
}

/* ── HO table ────────────────────────────────────────────────────────────── */
function renderHOTable() {
  const tickets = activeShiftTickets[currentArea] || [];
  const hoTickets = tickets.filter(t => t.hoReview === 'HO');

  const grid = document.getElementById('hoGrid');

  const COLS = [
    'Ticket ID', 'Subject', 'Processor', 'Notes',
    'Cat.', 'Prep Start', 'Exec Start', 'My Status', 'Priority', 'HO Review',
  ];
  if (grid.querySelectorAll('.gh').length !== COLS.length) {
    grid.querySelectorAll('.gh').forEach(h => h.remove());
    COLS.forEach((label, i) => {
      const gh = document.createElement('div'); gh.className = 'gh';
      const lbl = document.createElement('div'); lbl.className = 'gh-label'; lbl.textContent = label;
      gh.appendChild(lbl);
      const sp = document.createElement('div'); sp.style.height = '22px'; gh.appendChild(sp);
      grid.insertBefore(gh, grid.children[i] || null);
    });
  }
  grid.querySelectorAll('.gc, .empty-state').forEach(el => el.remove());

  document.getElementById('hoCount').textContent = `${hoTickets.length} ticket${hoTickets.length !== 1 ? 's' : ''}`;

  if (!hoTickets.length) {
    const emp = document.createElement('div'); emp.className = 'empty-state'; emp.style.gridColumn = '1/-1';
    emp.textContent = tickets.length ? 'No hay tickets marcados HO.' : 'Shift vacío.';
    grid.appendChild(emp); return;
  }

  const PRIS = [{name:'Very High',color:'#f44336'},{name:'High',color:'#FF9800'},{name:'Medium',color:'#FFC107'},{name:'Low',color:'#4CAF50'}];

  hoTickets.forEach(t => {
    const pc = priorityClass(t.priority);

    // Ticket ID
    const gcId = cell(pc);
    const tsOpt = (config.ticketStatuses||[]).find(o => o.name === t.ticketStatus);
    const a = document.createElement('a');
    a.href = `https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id)}`;
    a.target = '_blank'; a.rel = 'noopener'; a.className = 'ticket-link';
    a.style.color = tsOpt?.color || '#4FC3F7';
    a.textContent = t.id;
    a.title = t.ticketStatus ? `Status: ${t.ticketStatus}` : '';
    gcId.appendChild(a); grid.appendChild(gcId);

    // Subject
    const gcSubj = cell(pc + ' top');
    const wrap = document.createElement('div'); wrap.className = 'subj-wrap';
    const st = document.createElement('div'); st.className = 'subj-text'; st.textContent = t.subject || ''; st.title = t.subject || '';
    wrap.appendChild(st);
    if (t.ctRdy) { const cr = document.createElement('div'); cr.className = 'ct-rdy'; cr.textContent = '⏰ ' + (fmtDate(t.ctRdy) || t.ctRdy); wrap.appendChild(cr); }
    gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    // Processor
    const gcProc = cell(pc);
    gcProc.appendChild(makeSelect(config.processors, t.processor, val => patchShiftTicket(t.id, {processor:val}), '—'));
    grid.appendChild(gcProc);

    // Notes
    const gcNotes = cell(pc + ' top');
    const ni = document.createElement('input'); ni.className = 'inline-input'; ni.value = t.notes || t.comment || ''; ni.placeholder = 'notes…'; ni.style.width = '100%';
    ni.addEventListener('change', () => patchShiftTicket(t.id, {notes:ni.value}));
    gcNotes.appendChild(ni); grid.appendChild(gcNotes);

    // Category
    const gcCat = cell(pc);
    gcCat.appendChild(makeSelect(config.categories, t.category, val => patchShiftTicket(t.id, {category:val}), '—'));
    grid.appendChild(gcCat);

    // Prep Start
    const urgP = dateUrgencyClass(t.prepStart);
    const gcPrep = cell(pc + (urgP ? ' ' + urgP : '') + ' date-cell');
    if (t.prepStart) gcPrep.dataset.iso = t.prepStart;
    gcPrep.appendChild(makeDateInput(t.prepStart, val => patchShiftTicket(t.id, {prepStart:val}))); grid.appendChild(gcPrep);

    // Exec Start
    const urgE = dateUrgencyClass(t.execStart, t.execEnd);
    const gcExec = cell(pc + (urgE ? ' ' + urgE : '') + ' date-cell');
    if (t.execStart) gcExec.dataset.iso = t.execStart;
    if (t.execEnd)   gcExec.dataset.execend = t.execEnd;
    gcExec.appendChild(makeDateInput(t.execStart, val => patchShiftTicket(t.id, {execStart:val}))); grid.appendChild(gcExec);

    // My Status
    const gcMyStatus = cell(pc);
    gcMyStatus.appendChild(makeSelect(config.userStatuses, t.userStatus, val => patchShiftTicket(t.id, {userStatus:val}), '—'));
    grid.appendChild(gcMyStatus);

    // Priority
    const gcPri = cell(pc);
    gcPri.appendChild(makeSelect(PRIS, t.priority, val => { patchShiftTicket(t.id, {priority:val}); renderHOTable(); }, '—'));
    grid.appendChild(gcPri);

    // HO Review
    const gcHO = cell(pc);
    const hoSel = makeSelect(config.hoReviews, t.hoReview, val => patchShiftTicket(t.id, {hoReview:val}), '—');
    const hoOpt = (config.hoReviews||[]).find(o => o.name === t.hoReview);
    if (hoOpt?.color) hoSel.style.color = hoOpt.color;
    hoSel.addEventListener('change', () => {
      const opt = (config.hoReviews||[]).find(o => o.name === hoSel.value);
      hoSel.style.color = opt?.color || '';
    });
    gcHO.appendChild(hoSel); grid.appendChild(gcHO);
  });
}

/* ── Historia table ──────────────────────────────────────────────────────── */
async function loadHistory(area) {
  try {
    const res = await fetch(`/api/${area}/history`);
    if (!res.ok) return;
    areaHistory[area] = await res.json();
    renderHistoryTable();
  } catch (e) { console.error('loadHistory:', e); }
}

function renderHistoryTable() {
  const all = areaHistory[currentArea] || [];
  const visible = all.filter(t => {
    if (historyFilters.id          && !t.id.includes(historyFilters.id)) return false;
    if (historyFilters.subject     && !(t.subject||'').toLowerCase().includes(historyFilters.subject.toLowerCase())) return false;
    if (historyFilters.processor   && (t.processor||'')    !== historyFilters.processor)    return false;
    if (historyFilters.category    && (t.category||'')     !== historyFilters.category)     return false;
    if (historyFilters.ticketStatus && (t.ticketStatus||'') !== historyFilters.ticketStatus) return false;
    if (historyFilters.shiftDate   && !(t.shiftDate||'').includes(historyFilters.shiftDate)) return false;
    return true;
  });

  const grid = document.getElementById('historyGrid');

  const COLS = [
    { label:'Turno',      key:'shiftDate',    type:'text' },
    { label:'Ticket ID',  key:'id',           type:'text' },
    { label:'Priority',   key:'',             type:'none' },
    { label:'Subject',    key:'subject',      type:'text' },
    { label:'T. Status',  key:'ticketStatus', type:'select', opts:() => config.ticketStatuses },
    { label:'Notes',      key:'',             type:'none' },
    { label:'Processor',  key:'processor',    type:'select', opts:() => config.processors },
    { label:'Cat.',       key:'category',     type:'select', opts:() => config.categories },
    { label:'Prep Start', key:'',             type:'none' },
    { label:'Exec Start', key:'',             type:'none' },
    { label:'Customer',   key:'',             type:'none' },
    { label:'Src',        key:'',             type:'none' },
    { label:'Log',        key:'',             type:'none' },
  ];

  // Build headers only once — reuse existing inputs/selects to preserve focus
  let headers = grid.querySelectorAll('.gh');
  if (headers.length !== COLS.length) {
    grid.querySelectorAll('.gh').forEach(h => h.remove());
    COLS.forEach((col, i) => {
      const gh = document.createElement('div'); gh.className = 'gh';
      const lbl = document.createElement('div'); lbl.className = 'gh-label'; lbl.textContent = col.label; gh.appendChild(lbl);
      if (col.type === 'text') {
        const inp = document.createElement('input'); inp.className = 'col-filter'; inp.placeholder = '…'; inp.value = historyFilters[col.key] || '';
        inp.addEventListener('input', () => { historyFilters[col.key] = inp.value; renderHistoryRows(all); });
        gh.appendChild(inp);
      } else if (col.type === 'select') {
        gh.appendChild(makeSelectFilter(historyFilters, col.key, col.opts, () => renderHistoryRows(all)));
      } else { const sp = document.createElement('div'); sp.style.height = '22px'; gh.appendChild(sp); }
      grid.insertBefore(gh, grid.children[i] || null);
    });
  }

  renderHistoryRows(all, visible);
}

function renderHistoryRows(all, visible) {
  if (!visible) {
    const all2 = areaHistory[currentArea] || [];
    visible = all2.filter(t => {
      if (historyFilters.id          && !t.id.includes(historyFilters.id)) return false;
      if (historyFilters.subject     && !(t.subject||'').toLowerCase().includes(historyFilters.subject.toLowerCase())) return false;
      if (historyFilters.processor   && (t.processor||'')    !== historyFilters.processor)    return false;
      if (historyFilters.category    && (t.category||'')     !== historyFilters.category)     return false;
      if (historyFilters.ticketStatus && (t.ticketStatus||'') !== historyFilters.ticketStatus) return false;
      if (historyFilters.shiftDate   && !(t.shiftDate||'').includes(historyFilters.shiftDate)) return false;
      return true;
    });
    all = all2;
  }

  const grid = document.getElementById('historyGrid');

  // Remove only data rows (not headers)
  grid.querySelectorAll('.gc, .empty-state').forEach(el => el.remove());

  if (!visible.length) {
    const emp = document.createElement('div'); emp.className = 'empty-state'; emp.style.gridColumn = '1/-1';
    emp.textContent = all.length ? 'No hay resultados.' : 'Sin historia — crea y trabaja turnos primero.';
    grid.appendChild(emp);
    document.getElementById('historyCount').textContent = '0 tickets';
    return;
  }

  const srcColors = { HO:'#7B1FA2', ho:'#7B1FA2', execution:'#0277BD', handover:'#7B1FA2', manual:'#444' };

  visible.forEach(t => {
    const pc = priorityClass(t.priority);

    // Turno date
    const gcDate = cell(pc); gcDate.textContent = t.shiftDate || '—';
    gcDate.style.color = '#CE93D8'; gcDate.style.fontWeight = 'bold';
    grid.appendChild(gcDate);

    // Ticket ID
    const gcId = cell(pc);
    const a = document.createElement('a');
    a.href = `https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id)}`;
    a.target = '_blank'; a.rel = 'noopener'; a.className = 'ticket-link'; a.textContent = t.id;
    gcId.appendChild(a); grid.appendChild(gcId);

    // Priority badge
    const gcPri = cell(pc);
    if (t.priority) { const b = document.createElement('span'); b.className = `badge-pri badge-${t.priority.toLowerCase().replace(' ','-')}`; b.textContent = t.priority; gcPri.appendChild(b); }
    grid.appendChild(gcPri);

    // Subject
    const gcSubj = cell(pc + ' top');
    const wrap = document.createElement('div'); wrap.className = 'subj-wrap';
    const st = document.createElement('div'); st.className = 'subj-text'; st.textContent = t.subject || ''; st.title = t.subject || '';
    wrap.appendChild(st); gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    // Ticket Status (read-only)
    const gcTS = cell(pc);
    const tsOpt = (config.ticketStatuses||[]).find(o => o.name === t.ticketStatus);
    if (tsOpt?.color) { gcTS.style.color = tsOpt.color; gcTS.style.fontWeight = 'bold'; }
    gcTS.textContent = t.ticketStatus || '—'; grid.appendChild(gcTS);

    // Notes
    const gcNotes = cell(pc + ' top'); gcNotes.textContent = t.notes || t.comment || ''; gcNotes.title = t.notes || t.comment || ''; grid.appendChild(gcNotes);

    // Processor
    const gcProc = cell(pc);
    const prOpt = (config.processors||[]).find(o => o.name === t.processor);
    if (prOpt?.color) { gcProc.style.color = prOpt.color; gcProc.style.fontWeight = 'bold'; }
    gcProc.textContent = t.processor || '—'; grid.appendChild(gcProc);

    // Category
    const gcCat = cell(pc);
    const catOpt = (config.categories||[]).find(o => o.name === t.category);
    if (catOpt?.color) { gcCat.style.color = catOpt.color; }
    gcCat.textContent = t.category || '—'; grid.appendChild(gcCat);

    // Prep Start
    const urgP = dateUrgencyClass(t.prepStart);
    const gcPrep = cell(pc + (urgP ? ' '+urgP : '') + ' date-cell');
    if (t.prepStart) gcPrep.dataset.iso = t.prepStart;
    const pTxt = document.createElement('span'); pTxt.className = 'date-text'; pTxt.textContent = fmtDate(t.prepStart) || '—';
    gcPrep.appendChild(pTxt); grid.appendChild(gcPrep);

    // Exec Start
    const urgE = dateUrgencyClass(t.execStart, t.execEnd);
    const gcExec = cell(pc + (urgE ? ' '+urgE : '') + ' date-cell');
    if (t.execStart) gcExec.dataset.iso = t.execStart;
    if (t.execEnd)   gcExec.dataset.execend = t.execEnd;
    const eTxt = document.createElement('span'); eTxt.className = 'date-text'; eTxt.textContent = fmtDate(t.execStart) || '—';
    gcExec.appendChild(eTxt); grid.appendChild(gcExec);

    // Customer
    const gcCust = cell(pc); gcCust.textContent = t.customer || ''; gcCust.title = t.customer || ''; grid.appendChild(gcCust);

    // Source badge
    const gcSrc = cell(pc); gcSrc.style.justifyContent = 'center';
    const srcLabel = { manual:'M', HO:'HO', ho:'HO', execution:'EX', handover:'HO' }[t.source] || (t.source||'M').slice(0,2).toUpperCase();
    const srcBadge = document.createElement('span');
    srcBadge.style.cssText = `font-size:9px;font-weight:bold;padding:1px 4px;border-radius:3px;background:${srcColors[t.source]||'#444'};color:#fff`;
    srcBadge.textContent = srcLabel; gcSrc.appendChild(srcBadge); grid.appendChild(gcSrc);

    // Log button
    const gcLog = cell(pc);
    const logBtn = document.createElement('button'); logBtn.className = 'btn-icon'; logBtn.textContent = '🕐'; logBtn.title = 'Ver historial de cambios';
    logBtn.addEventListener('click', () => openChangeLog(t.id));
    gcLog.appendChild(logBtn); grid.appendChild(gcLog);
  });

  document.getElementById('historyCount').textContent = `${visible.length} / ${all.length} tickets`;
  const hasHistFilter = Object.values(historyFilters).some(v => v !== '');
  const hcfBtn = document.getElementById('btnHistoryClearFilters');
  if (hcfBtn) hcfBtn.style.display = hasHistFilter ? '' : 'none';
}

/* ── Config panel ────────────────────────────────────────────────────────── */
function openConfig() {
  populateConfigSection('processorList',    config.processors,    true, 'processors');
  populateConfigSection('ticketStatusList', config.ticketStatuses,true,  'ticketStatuses');
  populateConfigSection('userStatusList',   config.userStatuses,  true,  'userStatuses');
  populateConfigSection('validationList',   config.validations,   true,  'validations');
  populateConfigSection('categoryList',     config.categories,    true,  'categories');
  populateConfigSection('hoReviewList',     config.hoReviews,     true,  'hoReviews');
  showPanel('configPanel');
}

function populateConfigSection(listId, arr, hasColor, key) {
  const list = document.getElementById(listId); list.innerHTML = '';
  arr.forEach((item, i) => {
    const row=document.createElement('div'); row.className='config-item';
    if (hasColor) {
      const dot=document.createElement('div'); dot.className='color-dot'; dot.style.background=item.color; row.appendChild(dot);
      const cp=document.createElement('input'); cp.type='color'; cp.className='config-color-input'; cp.value=item.color;
      cp.addEventListener('input', () => { item.color=cp.value; dot.style.background=cp.value; saveConfig(); });
      row.appendChild(cp);
    }
    const lbl=document.createElement('span'); lbl.className='config-editable'; lbl.contentEditable=true;
    lbl.textContent=item.name||item;
    lbl.addEventListener('blur', () => {
      const v=lbl.textContent.trim(); if (!v) { lbl.textContent=item.name||item; return; }
      if (typeof item==='object') item.name=v; else arr[i]=v; saveConfig();
    });
    row.appendChild(lbl);
    const del=document.createElement('button'); del.className='btn-icon'; del.textContent='✕'; del.style.marginLeft='auto';
    del.addEventListener('click', () => { arr.splice(i,1); saveConfig(); populateConfigSection(listId,arr,hasColor,key); });
    row.appendChild(del); list.appendChild(row);
  });
}

function setupAddConfig(btnId, inputId, colorId, key, hasColor) {
  document.getElementById(btnId).addEventListener('click', () => {
    const v=document.getElementById(inputId).value.trim(); if (!v) return;
    const c=hasColor ? document.getElementById(colorId).value : '';
    config[key].push(hasColor ? {name:v,color:c} : v);
    saveConfig(); document.getElementById(inputId).value='';
    const sectionMap = { processors:'processorList', ticketStatuses:'ticketStatusList', userStatuses:'userStatusList', validations:'validationList', categories:'categoryList', hoReviews:'hoReviewList' };
    populateConfigSection(sectionMap[key], config[key], hasColor, key);
  });
}

setupAddConfig('btnAddProcessor',  'newProcessorInput',  null,               'processors',    false);
setupAddConfig('btnAddStatus',     'newStatusInput',     'newStatusColor',   'ticketStatuses',true);
setupAddConfig('btnAddUserStatus', 'newUserStatusInput', 'newUserStatusColor','userStatuses',  true);
setupAddConfig('btnAddValidation', 'newValidationInput', 'newValidationColor','validations',   true);
setupAddConfig('btnAddCategory',   'newCategoryInput',   'newCategoryColor', 'categories',    true);
setupAddConfig('btnAddHoReview',   'newHoReviewInput',   'newHoReviewColor', 'hoReviews',     true);

function populateShiftAddSelects() {
  const catSel=document.getElementById('shiftAddCategory'); catSel.innerHTML='<option value="">—</option>';
  config.categories.forEach(c => { const o=document.createElement('option'); o.value=c.name; o.textContent=c.name; catSel.appendChild(o); });
  const dl=document.getElementById('shiftAddProcessorList'); dl.innerHTML='';
  config.processors.forEach(p => { const o=document.createElement('option'); o.value=p; dl.appendChild(o); });
}

/* ── Availability Calendar ─────────────────────────────────────────────────── */

const SHIFT_LABELS = {
  'S3':             { label: 'S3',       cls: 'shift-S3' },
  'HO>':            { label: 'HO>',      cls: 'shift-HO-out' },
  '>HO':            { label: '>HO',      cls: 'shift-HO-in' },
  'Half Day':       { label: '½ Day',    cls: 'shift-half' },
  'AM_IM':          { label: 'AM/IM',    cls: 'shift-S3' },
  'OFF':            { label: 'OFF',      cls: 'shift-off' },
  'Approved Leave': { label: 'Apr.Lv',   cls: 'shift-leave' },
  'Planned Leave':  { label: 'Pln.Lv',   cls: 'shift-leave' },
  'Festivo':        { label: 'Festivo',  cls: 'shift-festivo' },
};

function calGetMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}

function calIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function calFormatDay(d) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

async function calRenderWeek() {
  if (!currentArea) return;
  if (!calCurrentMonday) calCurrentMonday = calGetMonday(new Date());

  const monday = calCurrentMonday;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }

  const from = calIsoDate(days[0]);
  const to   = calIsoDate(days[6]);

  // Update label
  const label = `${days[0].getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][days[0].getMonth()]} — ${days[6].getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][days[6].getMonth()]} ${days[6].getFullYear()}`;
  document.getElementById('calWeekLabel').textContent = label;

  // Fetch calendar data
  const calRes = await fetch(`/api/${currentArea}/calendar?from=${from}&to=${to}`).then(r => r.json()).catch(() => []);

  // Build lookup: user_id+date → shift_code
  const calMap = {};
  (Array.isArray(calRes) ? calRes : []).forEach(row => { calMap[`${row.user_id}|${row.date}`] = row.shift_code; });

  // Use authentik users for this area, fallback to config.processors
  let areaUsers = window._authentikUsers?.[currentArea] || [];
  if (!areaUsers.length && config.processors?.length) {
    areaUsers = config.processors.map(p => ({
      pk: typeof p === 'string' ? p : p.name,
      name: typeof p === 'string' ? p : p.name,
    }));
  }

  const grid = document.getElementById('calGrid');
  if (!areaUsers.length) {
    grid.innerHTML = '<div style="color:#555;padding:20px;">No processors found. Load a shift first so processors are cached.</div>';
    return;
  }

  let html = '<table><thead><tr>';
  html += '<th style="text-align:left;min-width:140px;">Processor</th>';
  days.forEach(d => {
    const isToday = calIsoDate(d) === calIsoDate(new Date());
    html += `<th style="${isToday ? 'color:#4FC3F7;' : ''}">${calFormatDay(d)}</th>`;
  });
  html += '</tr></thead><tbody>';

  areaUsers.forEach(user => {
    html += `<tr><td class="cal-name">${user.name}</td>`;
    days.forEach(d => {
      const iso = calIsoDate(d);
      const code = calMap[`${user.pk}|${iso}`] || '';
      const info = SHIFT_LABELS[code] || (code ? { label: code, cls: 'shift-S3' } : { label: '—', cls: 'shift-empty' });
      html += `<td><div class="cal-cell ${info.cls}" data-user="${user.pk}" data-date="${iso}" title="${code||'Not set'}">${info.label}</div></td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  grid.innerHTML = html;

  // Click to edit
  grid.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('click', () => calEditCell(cell.dataset.user, cell.dataset.date, calMap[`${cell.dataset.user}|${cell.dataset.date}`] || ''));
  });
}

function calEditCell(userId, date, currentCode) {
  const codes = ['S3', '>HO', 'HO>', 'Half Day', 'AM_IM', 'OFF', 'Approved Leave', 'Planned Leave', 'Festivo'];
  const sel = document.createElement('select');
  sel.innerHTML = codes.map(c => `<option value="${c}" ${c===currentCode?'selected':''}>${c}</option>`).join('');

  // Find the cell and replace content temporarily
  const cell = document.querySelector(`.cal-cell[data-user="${userId}"][data-date="${date}"]`);
  if (!cell) return;
  const orig = cell.innerHTML;
  cell.innerHTML = '';
  cell.appendChild(sel);
  sel.focus();

  async function save() {
    const code = sel.value;
    sel.remove();
    await fetch(`/api/${currentArea}/calendar/${userId}/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shift_code: code })
    });
    calRenderWeek();
  }
  sel.addEventListener('change', save);
  sel.addEventListener('blur', () => { cell.innerHTML = orig; });
}

document.getElementById('btnCalPrevWeek').addEventListener('click', () => {
  if (!calCurrentMonday) calCurrentMonday = calGetMonday(new Date());
  calCurrentMonday = new Date(calCurrentMonday);
  calCurrentMonday.setDate(calCurrentMonday.getDate() - 7);
  calRenderWeek();
});
document.getElementById('btnCalNextWeek').addEventListener('click', () => {
  if (!calCurrentMonday) calCurrentMonday = calGetMonday(new Date());
  calCurrentMonday = new Date(calCurrentMonday);
  calCurrentMonday.setDate(calCurrentMonday.getDate() + 7);
  calRenderWeek();
});
document.getElementById('btnCalToday').addEventListener('click', () => {
  calCurrentMonday = calGetMonday(new Date());
  calRenderWeek();
});

document.getElementById('calFileInput')?.addEventListener('change', async function() {
  console.log('[calImport] change fired, files:', this.files.length);
  const file = this.files[0];
  if (!file) { console.log('[calImport] no file'); return; }
  console.log('[calImport] file:', file.name, file.size, 'area:', currentArea);

  const label = document.querySelector('label[for="calFileInput"]');
  const origText = label.textContent;
  label.textContent = '⏳ Importing...';
  label.style.opacity = '0.6';
  label.style.pointerEvents = 'none';

  try {
    const fd = new FormData();
    fd.append('file', file);
    this.value = '';

    const res = await fetch(`/api/${currentArea}/calendar/import`, { method: 'POST', body: fd });
    const data = await res.json();

    if (data.ok) {
      label.textContent = `✅ ${data.inserted} entries`;
      setTimeout(() => { label.textContent = origText; }, 3000);
      calRenderWeek();
    } else {
      label.textContent = '❌ Error';
      setTimeout(() => { label.textContent = origText; }, 3000);
      alert('Import error: ' + data.error);
    }
  } catch(e) {
    label.textContent = '❌ Error';
    setTimeout(() => { label.textContent = origText; }, 3000);
    alert('Import error: ' + e.message);
  } finally {
    label.style.opacity = '';
    label.style.pointerEvents = '';
  }
});

/* ── Area Config (clients, activities, matrix) ────────────────────────────── */

let aconfigSection = 'clients';

document.querySelectorAll('.aconfig-nav').forEach(btn => {
  btn.addEventListener('click', () => {
    aconfigSection = btn.dataset.aconfig;
    document.querySelectorAll('.aconfig-nav').forEach(b => b.classList.toggle('active', b.dataset.aconfig === aconfigSection));
    document.getElementById('aconfigClients').style.display    = aconfigSection === 'clients'    ? '' : 'none';
    document.getElementById('aconfigActivities').style.display = aconfigSection === 'activities' ? '' : 'none';
    document.getElementById('aconfigMatrix').style.display     = aconfigSection === 'matrix'     ? '' : 'none';
    aconfigLoad();
  });
});

async function aconfigLoad() {
  if (aconfigSection === 'clients')    await aconfigLoadClients();
  if (aconfigSection === 'activities') await aconfigLoadActivities();
  if (aconfigSection === 'matrix')     await aconfigLoadMatrix();
}

// ── Clients ──

async function aconfigLoadClients() {
  const clients = await fetch('/api/clients').then(r => r.json()).catch(() => []);
  const el = document.getElementById('clientsList');
  if (!clients.length) { el.innerHTML = '<div style="color:#555;font-size:11px;padding:8px;">No clients yet.</div>'; return; }
  let html = '<table><thead><tr><th>Name</th><th>Critical</th><th></th></tr></thead><tbody>';
  clients.forEach(c => {
    html += `<tr>
      <td>${c.name}</td>
      <td><input type="checkbox" ${c.is_critical ? 'checked' : ''} onchange="aconfigPatchClient(${c.id},{is_critical:this.checked?1:0})" /></td>
      <td><button class="btn btn-red" style="font-size:10px;padding:2px 6px;" onclick="aconfigDeleteClient(${c.id})">✕</button></td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

document.getElementById('btnAddClient').addEventListener('click', async () => {
  const name = document.getElementById('newClientName').value.trim();
  const crit = document.getElementById('newClientCritical').checked ? 1 : 0;
  if (!name) return;
  await fetch('/api/clients', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, is_critical: crit }) });
  document.getElementById('newClientName').value = '';
  document.getElementById('newClientCritical').checked = false;
  aconfigLoadClients();
});

window.aconfigPatchClient = async (id, data) => {
  await fetch(`/api/clients/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  aconfigLoadClients();
};
window.aconfigDeleteClient = async (id) => {
  if (!confirm('Delete client?')) return;
  await fetch(`/api/clients/${id}`, { method:'DELETE' });
  aconfigLoadClients();
};

const DEFAULT_CLIENT_LIST = ["Wezen SRL","PwC US Group LLP","Unidasul Distribuidora Alimentar","Tecidos e Armarinhos Miguel","Reliper S.A.","Dellamed S.A.","Distribuidora Farmaceutica","Lansing Building Products","Alcaldia De Medellin","Ibema Companhia Brasileira","Tuberfil Industria e Comercio","Independence Drilling S.A.","Dohler S/A","Armorlitte S. A.","Plastilene S.A.","Parque Arauco S.A.","Unimaco S.A.","Blue Express S.A.","Divino S.A.","Automercado San Diego C.A.","SSM Health Care Corporation","Valco Instruments Company","Grupo Industrial Donde S.A.","Frigorificos De Guatemala","Wonder Brands Inc","Real Moto Pecas Ltda","Nikola Corporation","Pottencial Seguradora S/A","Alianza Compania de Seguros","Agricola Nacional S.A.C.E.I.","Salmones Aysen S.A.","Frigorifico Temuco S.A.","Distrisoda S.A.","Laboratorios Lansier S.A.C.","TECNOVAX S.A.","Luiz Guilherme Sartori & Cia","Naturgy Ban S.A.","Hidroelectrica La Higuera S.A.","360 Energy S.A.","Crescent Energy Company","ThompsonGas LLC","The Boelter Companies Inc","Mingledorff's Inc","Tessco Technologies LLC","Gas Uribe S.A. de C.V.","Atalco Gramercy LLC","Array Tech Inc","Comfrut S.A","Dole Packaged Foods LLC","Postobon S.A.","Red Hat LLC","Domino's Pizza LLC","Mathiesen S.A.C.","Bethel Church of Redding","CLOVER Internacional C.A.","Rinchem Company LLC","The Chamberlain Group LLC","Industrias de Hule Galgo S.A.","Electrify America LLC","Suramericana S.A.","Nationwide Mutual Insurance","Hunt Consolidated Inc.","Bunge North America Inc.","NBA Properties Inc.","Rumpke of Ohio Inc.","Bruks Siwertell AB","SOLEIL MINING","BMT INTERNATIONAL NV","W J Towell LLC","Zijin Zhixin Technology","Testo Industrial Services GmbH","LLC MC Resourse Finance","Brandcare Est 2014 SA","Bangkok Komatsu Sales","Chorus Research Engineering","Hans Willi Bohmer GmbH","GREENWEEE INTERNATIONAL","MLADINSKA KNJIGA TRGOVINA","FARMALOGIST","Aspen Glove Sdn Bhd","Tongding interconnection inc","Zijin Mining Group Co. Ltd.","ISI Steel Co. Ltd.","INDUSTRIAS MURTRA S.A.","International Company Egypt","INDUSTRIA TECNICA DEL SUR","Great Deals E-Commerce Corp","katerra India Private Limited","Abdulla Fouad Company","AlRomaih Industrial Commercial","SERVICIO PUBLICO DE EMPLEO","Organismo Autonomo Informatica","ADP AGUAS DE PORTUGAL","Public Service Department UAE","Muncipal Corporation of Greater","Ceylon Biscuits ltd","Ardo Foods NV","SOFIYA QANDOLAT LLC","Paulaner Brauerei Gruppe GmbH","Eve Power Hungary Kft.","AB INBEV EFES AO","Winkels Getranke Logistik GmbH","Lunch Garden Holding NV","SNCF RESEAU","Cambodia Airport Investment","INTERNATIONAL ALEXANDER","YEONG CHIN Machinery","AEM Holdings Ltd","SEATRIUM LIMITED","Incab LLC","CT PACK SRL","CAN ULUSLARARASI YATIRIM","BT Payment Services Nigeria","Colruyt Group Services","Colruyt Group nv","Biyue Beijing Technology","Sun Race Sturmey-Archer Inc","Bosch China Investment Ltd","SAIC HK Limited","Cycle & Carriage Bintang Bhd","MG JW Automobile Pakistan","VinFast Germany GmbH","University Hospitals Birmingham","Sky Italia S.r.l.","PT Alamtri Resources Indonesia","VSM-Vereinigte Schmirgel","Herbert Waldmann GmbH","Alibaba Cloud Computing Ltd","ADATA Technology Co. Ltd.","Testo SE & Co. KGaA","Husqvarna AB","Nilkamal Limited","Rauch Fruchtsafte GmbH","BELROS RETAIL S.A.","JYSK SE","Toya S.A.","Carl Geringhoff GmbH","Pirelli & C. S.p.A.","STELLANTIS EUROPE SPA","NTF INDIA PRIVATE LIMITED","OOO Volgo-Don AgroInvest","ENI S.p.A.","SAP MCD Service Engineering","Department of Corrections NZ","Weston Foods Canada Inc","Adient US LLC","777 Partners LLC","Clear Sale S.A.","Unipar Carbocloro S.A.","Ascenty Data Centers","SONDA S.A.","Sonae Arauco Portugal S.A.","Ball Corporation","Banco Macro S.A.","Corona Industrial S.A.S","Envalior B.V","Cooperatieve Rabobank U.A.","Raysut Cement Company","Davide Campari Milano N.V.","Barry Callebaut Services NV","D. Swarovski KG","ENAIRE","Latam Airlines Group S.A.","Crosland Servicios Administrativos","Sigma Company Limited","Concesionaria Vuela Compania","Border States Industries Inc.","SNCB","Breakthru Beverage Group","NTPC Limited","Suomen Osuuskauppojen Keskuskunta","Bruder Schlau GmbH","HCCOM SA","Grupo Marti S.A. de C.V.","Cooperativa Dos Plantadores","Shutterfly LLC","Arburg GmbH + Co KG","Danfoss A/S","IKEA IT AB","PT Astra Honda Motor","AVL List GmbH","Los Portales S.A.","BMW Brilliance Automotive","Harley-Davidson Inc.","DEUTZ Aktiengesellschaft","Bridgestone Asia Pacific","Mercedes-Benz Grand Prix","Grupa Azoty S.A.","Benjamin Moore & Co","Sopharma Trading AD","Vision Service Plan","Icatu Seguros S/A","Woodside Energy Limited","Cimpress USA Incorporated","Tyson Foods Inc.","Mimo Tech Co. Ltd.","Proximus S.A. de droit public","Al Khaleej Sugar Co LLC","Frisa Forjados S.A. de C.V.","Fondazione Human Technopole","Al Ahli Hospital","Agricola Cerro Prieto S.A.","Aramco Overseas Company","MRS Logistica S/A.","Minera Don Nicolas S.A.","Hannover Ruck SE","ESPRESSO AMERICANO S A","Apex Health Care Mfg. Inc.","Vistra Corporate Services","IBM India Pvt Ltd","Comercializadora GONAC","Nobia AB","Bru Textiles NV","BRFertil S/A.","Phillips 66 Company","IBM Corporation","El Palacio de Hierro S.A.","Egyptian Union for Construction","MULTIVAC Sepp Hagenmayer","Qassim Cement Company","Autoservicio Mayorista Diario","Petrobras Bolivia S.A.","Acme Intralog FZCO","PT APP Purinusa Ekapersada","GOTW Pty Ltd","MUNDYS SPA","Samvardhana Motherson International","CORDES & GRAEFE KG","United HealthCare Services","EnBW Energie Baden-Wurttemberg","dmTECH GmbH","PricewaterhouseCoopers Canada","Manweir","NEXUS ENERGIA S.A.","Industrial Danec S.A.","The Andersons Inc.","FCA ITEM S.p.A.","Abdulhadi Abdullah Al Qahtani","BFORBANK","Corning Incorporated","Wienerberger AG","Promocionales de Occidente","Klabin S.A.","CORMAN SPA","WIZ CHEMICALS SRL","SOFITEC AERO","Fisker Group Inc.","Termoelectrica Jose de San Martin","Kinjal Civilcon LLP","Beaumont New Ammonia LLC","Ike Grupo Empresarial S.A.","Inmobiliaria y Promotora Roca"];

document.getElementById('btnBulkImportClients').addEventListener('click', async () => {
  const btn = document.getElementById('btnBulkImportClients');
  btn.disabled = true;
  btn.textContent = '⏳ Loading...';
  try {
    const r = await fetch('/api/clients/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: DEFAULT_CLIENT_LIST }),
    });
    const data = await r.json();
    btn.textContent = `✅ Done (${data.inserted} added)`;
    await aconfigLoadClients();
  } catch (e) {
    btn.textContent = '❌ Error';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '📥 Load default list'; }, 3000);
});

// ── Activities ──

async function aconfigLoadActivities() {
  const acts = await fetch(`/api/${currentArea}/activities`).then(r => r.json()).catch(() => []);
  const el = document.getElementById('activitiesList');
  if (!acts.length) { el.innerHTML = '<div style="color:#555;font-size:11px;padding:8px;">No activities yet.</div>'; return; }
  let html = '<table><thead><tr><th>Name</th><th>Est. mins</th><th></th></tr></thead><tbody>';
  acts.forEach(a => {
    html += `<tr>
      <td>${a.name}</td>
      <td><input type="number" value="${a.estimated_minutes}" style="width:70px;font-size:11px;" onchange="aconfigPatchActivity(${a.id},{estimated_minutes:+this.value})" /></td>
      <td><button class="btn btn-red" style="font-size:10px;padding:2px 6px;" onclick="aconfigDeleteActivity(${a.id})">✕</button></td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

document.getElementById('btnAddActivity').addEventListener('click', async () => {
  const name = document.getElementById('newActivityName').value.trim();
  const mins = parseInt(document.getElementById('newActivityMins').value) || 60;
  if (!name) return;
  await fetch(`/api/${currentArea}/activities`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, estimated_minutes: mins }) });
  document.getElementById('newActivityName').value = '';
  document.getElementById('newActivityMins').value = '60';
  aconfigLoadActivities();
});

window.aconfigPatchActivity = async (id, data) => {
  await fetch(`/api/${currentArea}/activities/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  aconfigLoadActivities();
};
window.aconfigDeleteActivity = async (id) => {
  if (!confirm('Delete activity?')) return;
  await fetch(`/api/${currentArea}/activities/${id}`, { method:'DELETE' });
  aconfigLoadActivities();
};

// ── Matrix ──

async function aconfigLoadMatrix() {
  const [users, activities, skills, procConfigs] = await Promise.all([
    Promise.resolve(window._authentikUsers?.[currentArea]?.length
      ? window._authentikUsers[currentArea]
      : (config.processors||[]).map(p => ({ pk: typeof p==='string'?p:p.name, name: typeof p==='string'?p:p.name }))
    ),
    fetch(`/api/${currentArea}/activities`).then(r => r.json()).catch(() => []),
    fetch(`/api/${currentArea}/processor-skills`).then(r => r.json()).catch(() => []),
    fetch('/api/processor-config').then(r => r.json()).catch(() => []),
  ]);

  const skillSet = new Set(skills.map(s => `${s.user_id}|${s.activity_id}`));
  const critSet  = new Set(procConfigs.filter(p => p.can_critical).map(p => p.user_id));

  const el = document.getElementById('matrixGrid');
  if (!users.length || !activities.length) {
    el.innerHTML = '<div style="color:#555;font-size:11px;padding:8px;">Add activities and make sure processors are loaded from Authentik.</div>';
    return;
  }

  let html = '<table><thead><tr><th>Processor</th><th title="Can handle critical clients">Critical</th>';
  activities.forEach(a => { html += `<th title="${a.estimated_minutes} min">${a.name}</th>`; });
  html += '</tr></thead><tbody>';

  users.forEach(user => {
    html += `<tr><td class="mat-name">${user.name}</td>`;
    html += `<td class="mat-check"><input type="checkbox" ${critSet.has(user.pk)?'checked':''} onchange="aconfigSetCritical('${user.pk}',this.checked)" /></td>`;
    activities.forEach(a => {
      const checked = skillSet.has(`${user.pk}|${a.id}`);
      html += `<td class="mat-check"><input type="checkbox" ${checked?'checked':''} onchange="aconfigSetSkill('${user.pk}',${a.id},this.checked)" /></td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

window.aconfigSetCritical = async (userId, enabled) => {
  await fetch(`/api/processor-config/${userId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ can_critical: enabled ? 1 : 0 })
  });
};

window.aconfigSetSkill = async (userId, activityId, enabled) => {
  await fetch(`/api/${currentArea}/processor-skills/${userId}/${activityId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ enabled })
  });
};
