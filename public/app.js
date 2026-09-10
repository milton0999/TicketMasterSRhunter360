/* ── State ───────────────────────────────────────────────────────────────── */
let currentArea   = null;
let currentSubtab = 'pool';
let displayTz     = 'MTY';

const areaPool           = { sm: [], merge: [] };
const activeShiftId      = { sm: null, merge: null };
const activeShiftTickets = { sm: [], merge: [] };
let   allShifts          = { sm: [], merge: [] };

const poolFilters  = { id:'', serviceExecId:'', subject:'', customer:'' };
const shiftFilters = { id:'', subject:'', customer:'', processor:'', category:'', source:'', notes:'' };

/* ── Config ──────────────────────────────────────────────────────────────── */
let config = {
  processors:    [{ name: 'Unassigned', color: '#888' }],
  ticketStatuses:[
    { name: 'In Process',      color: '#0288D1' },
    { name: 'Pending Customer', color: '#F9A825' },
    { name: 'Awaiting CR',      color: '#6A1B9A' },
    { name: 'Done',             color: '#2E7D32' },
  ],
  userStatuses:  [
    { name: 'new',         color: '#555' },
    { name: 'in-progress', color: '#0277BD' },
    { name: 'done',        color: '#2E7D32' },
  ],
  validations:   [
    { name: 'pending', color: '#555' },
    { name: 'ok',      color: '#2E7D32' },
    { name: 'fail',    color: '#C62828' },
  ],
  categories:    [
    { name: 'Installations', color: '#0097A7' },
    { name: 'Upgrade',       color: '#7B1FA2' },
    { name: 'Migration',     color: '#EF6C00' },
    { name: 'Other',         color: '#616161' },
  ],
};
function loadConfig() {
  try { const s = localStorage.getItem('ticketConfig'); if (s) config = JSON.parse(s); } catch {}
}
function saveConfig() { localStorage.setItem('ticketConfig', JSON.stringify(config)); }
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
  if (shift.id === activeShiftId[area] && currentArea === area && currentSubtab === 'shift') renderShiftTable();
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
async function loadAuthentikUsers() {
  try {
    const res = await fetch('/api/users');
    if (!res.ok) return;
    const users = await res.json();
    if (!Array.isArray(users) || !users.length) return;
    // Preserve existing colors if already configured
    const existing = new Map(config.processors.map(p => [p.name, p.color]));
    const COLORS = ['#0288D1','#7B1FA2','#E65100','#2E7D32','#C62828','#00838F','#5c3f7f','#6D4C41','#1565C0','#558B2F'];
    config.processors = users.map((name, i) => ({
      name,
      color: existing.get(name) || COLORS[i % COLORS.length],
    }));
    saveConfig();
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
  if      (canSM)    switchArea('sm');
  else if (canMerge) switchArea('merge');
  loadAuthentikUsers();
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
}

document.querySelectorAll('.subtab-btn').forEach(btn => btn.addEventListener('click', () => switchSubtab(btn.dataset.subtab)));

function switchSubtab(subtab) {
  currentSubtab = subtab;
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.toggle('active', b.dataset.subtab === subtab));

  ['poolToolbar','shiftToolbar'].forEach(id => document.getElementById(id).style.display = 'none');
  ['poolScrollArea','shiftScrollArea'].forEach(id => document.getElementById(id).style.display = 'none');

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

async function reloadShiftTickets() {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) return;
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets`);
  if (res.ok) {
    activeShiftTickets[currentArea] = await res.json();
    updateShiftCount(currentArea);
    if (currentSubtab === 'shift') renderShiftTable();
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

document.getElementById('btnShiftLoadExec').addEventListener('click', async () => {
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) { alert('No active shift'); return; }
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/load-executions`, {
    method: 'POST',
  });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Error'); return; }
  await reloadShiftTickets();
});

document.getElementById('btnShiftAddToggle').addEventListener('click', () => {
  populateShiftAddSelects();
  showPanel('shiftAddPanel');
});
document.getElementById('btnShiftAddCancel').addEventListener('click', () => hidePanel('shiftAddPanel'));

document.getElementById('btnShiftAddSave').addEventListener('click', async () => {
  const id = document.getElementById('shiftAddId').value.trim();
  if (!id || !/^\d{7,13}$/.test(id)) { alert('Invalid ticket ID'); return; }
  const shiftId = activeShiftId[currentArea];
  if (!shiftId) { alert('No active shift'); return; }
  const res = await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets/single`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      id,
      priority:  document.getElementById('shiftAddPriority').value,
      subject:   document.getElementById('shiftAddSubject').value.trim(),
      category:  document.getElementById('shiftAddCategory').value,
      processor: document.getElementById('shiftAddProcessor').value.trim(),
      prepStart: document.getElementById('shiftAddPrepStart').value,
      execStart: document.getElementById('shiftAddExecStart').value,
      notes:     document.getElementById('shiftAddNotes').value.trim(),
      source:    'manual',
    }),
  });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Error adding ticket'); return; }
  hidePanel('shiftAddPanel');
  document.getElementById('shiftAddId').value = '';
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

/* ── Tickets toolbar actions — kept for backward compat (hidden) ─────────── */
document.getElementById('btnPasteToggle').addEventListener('click', () => showPanel('pastePanel'));
document.getElementById('btnPasteCancel').addEventListener('click', () => hidePanel('pastePanel'));
document.getElementById('btnPasteLoad').addEventListener('click', loadHandover);
document.getElementById('btnAddToggle').addEventListener('click', () => { populateAddSelects(); showPanel('addPanel'); });
document.getElementById('btnAddCancel').addEventListener('click', () => hidePanel('addPanel'));
document.getElementById('btnAddSave').addEventListener('click', addTicket);
document.getElementById('btnClearAll').addEventListener('click', clearAllTickets);
document.getElementById('btnConfigToggle').addEventListener('click', openConfig);
document.getElementById('btnConfigClose').addEventListener('click', () => hidePanel('configPanel'));

/* ── Timezone toggle ─────────────────────────────────────────────────────── */
document.querySelectorAll('.tz-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    displayTz = this.dataset.tz;
    localStorage.setItem('displayTz', displayTz);
    document.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('active', b.dataset.tz === displayTz));
    if (currentSubtab === 'shift') renderShiftTable();
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

/* ── Ticket CRUD ─────────────────────────────────────────────────────────── */
async function loadHandover() {
  const raw = document.getElementById('pasteArea').value.trim();
  if (!raw) return;
  const res = await fetch(`/api/${currentArea}/tickets/handover`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ raw }),
  });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Error'); return; }
  document.getElementById('pasteArea').value = '';
  hidePanel('pastePanel');
  alert(`Loaded: ${j.added} new, ${j.skipped} already present`);
}

async function addTicket() {
  const id = document.getElementById('addId').value.trim();
  if (!id || !/^\d{7,13}$/.test(id)) { alert('Invalid ticket ID'); return; }
  const res = await fetch(`/api/${currentArea}/tickets/single`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      id,
      priority:     document.getElementById('addPriority').value,
      subject:      document.getElementById('addSubject').value.trim(),
      ticketStatus: document.getElementById('addTicketStatus').value.trim(),
      processor:    document.getElementById('addProcessor').value.trim(),
      category:     document.getElementById('addCategory').value,
      prepStart:    document.getElementById('addPrepStart').value,
      execStart:    document.getElementById('addExecStart').value,
      notes:        document.getElementById('addNotes').value.trim(),
    }),
  });
  const j = await res.json();
  if (!res.ok) { alert(j.error || 'Error'); return; }
  hidePanel('addPanel');
  document.getElementById('addId').value = '';
}

async function clearAllTickets() {
  if (!confirm('Delete ALL tickets in this area?')) return;
  await fetch(`/api/${currentArea}/tickets`, { method: 'DELETE' });
}

async function patchTicket(id, updates) {
  const area = (currentArea === 'sm' || currentArea === 'merge') ? currentArea : 'sm';
  await fetch(`/api/${area}/tickets/${id}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates),
  });
}

async function deleteTicket(id) {
  if (!confirm(`Delete ticket ${id}?`)) return;
  await fetch(`/api/${currentArea}/tickets/${id}`, { method: 'DELETE' });
}

/* ── Date helpers ────────────────────────────────────────────────────────── */
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso); if (isNaN(d)) return iso;
    const ref = displayTz === 'MTY' ? new Date(d.getTime() - 6*3600000) : d;
    const mo = String(ref.getUTCMonth()+1).padStart(2,'0');
    const dy = String(ref.getUTCDate()).padStart(2,'0');
    const hh = String(ref.getUTCHours()).padStart(2,'0');
    const mm = String(ref.getUTCMinutes()).padStart(2,'0');
    return `${mo}/${dy} ${hh}:${mm}`;
  } catch { return iso; }
}

function dateUrgencyClass(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso); if (isNaN(d)) return '';
    const h = (d.getTime() - Date.now()) / 3600000;
    if (h < 0)   return 'date-passed';
    if (h < 0.5) return 'date-started';
    if (h < 2)   return 'date-imminent';
    if (h < 6)   return 'date-soon';
    return 'date-ok';
  } catch { return ''; }
}

function priorityClass(p) {
  if (!p) return 'pri-bar-none';
  return `pri-bar-${p.toLowerCase().replace(' ','-')}`;
}

function makeDateInput(val, onchange) {
  // Show formatted date text; clicking opens a hidden datetime-local picker
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:100%;cursor:pointer;';

  const txt = document.createElement('span');
  txt.className = 'date-text';
  txt.textContent = val ? fmtDate(val) : '—';
  txt.title = val || '';

  const inp = document.createElement('input');
  inp.type = 'datetime-local';
  inp.value = val ? val.slice(0,16) : '';
  inp.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;top:0;left:0;';

  txt.addEventListener('click', () => {
    inp.style.pointerEvents = 'auto';
    inp.showPicker ? inp.showPicker() : inp.click();
  });
  inp.addEventListener('change', () => {
    txt.textContent = inp.value ? fmtDate(inp.value) : '—';
    txt.title = inp.value || '';
    inp.style.pointerEvents = 'none';
    onchange(inp.value);
  });
  inp.addEventListener('blur', () => { inp.style.pointerEvents = 'none'; });

  wrap.appendChild(txt);
  wrap.appendChild(inp);
  return wrap;
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

/* ── Ticket table ────────────────────────────────────────────────────────── */
function renderTicketTable() {
  const tickets = areaTickets[currentArea] || [];
  const visible = tickets.filter(t => {
    if (ticketFilters.id           && !t.id.includes(ticketFilters.id)) return false;
    if (ticketFilters.subject      && !(t.subject||'').toLowerCase().includes(ticketFilters.subject.toLowerCase())) return false;
    if (ticketFilters.processor    && !(t.processor||'').toLowerCase().includes(ticketFilters.processor.toLowerCase())) return false;
    if (ticketFilters.category     && !(t.category||'').toLowerCase().includes(ticketFilters.category.toLowerCase())) return false;
    if (ticketFilters.ticketStatus && !(t.ticketStatus||'').toLowerCase().includes(ticketFilters.ticketStatus.toLowerCase())) return false;
    return true;
  });

  const grid = document.getElementById('ticketGrid');
  grid.innerHTML = '';

  const COLS = [
    { label:'Ticket ID',     key:'id' },
    { label:'Priority',      key:'' },
    { label:'Subject / CT_RDY', key:'subject' },
    { label:'Ticket Status', key:'ticketStatus' },
    { label:'Comment',       key:'' },
    { label:'Processor',     key:'processor' },
    { label:'Category',      key:'category' },
    { label:'Prep Start',    key:'' },
    { label:'Exec Start',    key:'' },
    { label:'User Status',   key:'' },
    { label:'Validation',    key:'' },
    { label:'',              key:'' },
  ];

  COLS.forEach(col => {
    const gh = document.createElement('div'); gh.className = 'gh';
    const lbl = document.createElement('div'); lbl.className = 'gh-label'; lbl.textContent = col.label; gh.appendChild(lbl);
    if (col.key) {
      const inp = document.createElement('input');
      inp.className='col-filter'; inp.placeholder='…'; inp.value=ticketFilters[col.key]||'';
      inp.addEventListener('input', () => { ticketFilters[col.key]=inp.value; renderTicketTable(); });
      gh.appendChild(inp);
    } else { const sp=document.createElement('div'); sp.style.height='22px'; gh.appendChild(sp); }
    grid.appendChild(gh);
  });

  if (!visible.length) {
    const emp = document.createElement('div'); emp.className='empty-state'; emp.style.gridColumn='1/-1';
    emp.textContent = tickets.length ? 'No tickets match filters.' : 'No tickets — paste a handover or add manually.';
    grid.appendChild(emp);
    document.getElementById('ticketCount').textContent = `0 / ${tickets.length} tickets`;
    return;
  }

  visible.forEach(t => {
    const pc = priorityClass(t.priority);

    const gcId = cell(pc);
    const a = document.createElement('a');
    a.href=`https://itsm.services.sap.com/index.do?uri=ComponentPage&Name=UserActions&Action=displayitem&ExternalKey=${t.id}`;
    a.target='_blank'; a.rel='noopener'; a.className='ticket-link'; a.textContent=t.id;
    gcId.appendChild(a); grid.appendChild(gcId);

    const gcPri = cell(pc);
    if (t.priority) { const b=document.createElement('span'); b.className=`badge-pri badge-${t.priority.toLowerCase().replace(' ','-')}`; b.textContent=t.priority; gcPri.appendChild(b); }
    grid.appendChild(gcPri);

    const gcSubj = cell(pc+' top');
    const wrap=document.createElement('div'); wrap.className='subj-wrap';
    const st=document.createElement('div'); st.className='subj-text'; st.textContent=t.subject||''; st.title=t.subject||'';
    wrap.appendChild(st);
    if (t.ctRdy) { const cr=document.createElement('div'); cr.className='ct-rdy'; cr.textContent='⏰ '+t.ctRdy; wrap.appendChild(cr); }
    gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    const gcTS = cell(pc);
    gcTS.appendChild(makeSelect(config.ticketStatuses, t.ticketStatus, val => patchTicket(t.id, {ticketStatus:val}), '—'));
    grid.appendChild(gcTS);

    const gcCom = cell(pc); gcCom.textContent=t.comment||''; gcCom.title=t.comment||''; grid.appendChild(gcCom);

    const gcProc = cell(pc);
    gcProc.appendChild(makeSelect(config.processors, t.processor, val => patchTicket(t.id, {processor:val}), '—'));
    grid.appendChild(gcProc);

    const gcCat = cell(pc);
    gcCat.appendChild(makeSelect(config.categories, t.category, val => patchTicket(t.id, {category:val}), '—'));
    grid.appendChild(gcCat);

    const urgP = dateUrgencyClass(t.prepStart);
    const gcPrep = cell(pc+(urgP?' '+urgP:'')+' date-cell');
    gcPrep.appendChild(makeDateInput(t.prepStart, val => patchTicket(t.id, {prepStart:val}))); grid.appendChild(gcPrep);

    const urgE = dateUrgencyClass(t.execStart);
    const gcExec = cell(pc+(urgE?' '+urgE:'')+' date-cell');
    gcExec.appendChild(makeDateInput(t.execStart, val => patchTicket(t.id, {execStart:val}))); grid.appendChild(gcExec);

    const gcUS = cell(pc);
    gcUS.appendChild(makeSelect(config.userStatuses, t.userStatus, val => patchTicket(t.id, {userStatus:val}), '—'));
    grid.appendChild(gcUS);

    const gcVal = cell(pc);
    gcVal.appendChild(makeSelect(config.validations, t.validation, val => patchTicket(t.id, {validation:val}), '—'));
    grid.appendChild(gcVal);

    const gcDel = cell(pc);
    const delBtn=document.createElement('button'); delBtn.className='btn-icon'; delBtn.textContent='🗑';
    delBtn.addEventListener('click', () => deleteTicket(t.id)); gcDel.appendChild(delBtn); grid.appendChild(gcDel);
  });

  document.getElementById('ticketCount').textContent = `${visible.length} / ${tickets.length} tickets`;
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
function renderPoolTable() {
  const poolTickets = areaPool[currentArea] || [];
  const visible = poolTickets.filter(t => {
    if (poolFilters.id           && !t.id.includes(poolFilters.id)) return false;
    if (poolFilters.serviceExecId && !(t.serviceExecId||'').includes(poolFilters.serviceExecId)) return false;
    if (poolFilters.subject      && !(t.subject||'').toLowerCase().includes(poolFilters.subject.toLowerCase())) return false;
    if (poolFilters.customer     && !(t.customer||'').toLowerCase().includes(poolFilters.customer.toLowerCase())) return false;
    return true;
  });

  const grid = document.getElementById('poolGrid');
  grid.innerHTML = '';

  const COLS = [
    { label:'Ticket ID',   key:'id' },
    { label:'Exec ID',     key:'serviceExecId' },
    { label:'Subject',     key:'subject' },
    { label:'Priority',    key:'' },
    { label:'Prep Start',  key:'' },
    { label:'Exec Start',  key:'' },
    { label:'Customer',    key:'customer' },
    { label:'',            key:'' },
  ];

  COLS.forEach(col => {
    const gh=document.createElement('div'); gh.className='gh';
    const lbl=document.createElement('div'); lbl.className='gh-label'; lbl.textContent=col.label; gh.appendChild(lbl);
    if (col.key) {
      const inp=document.createElement('input'); inp.className='col-filter'; inp.placeholder='…'; inp.value=poolFilters[col.key]||'';
      inp.addEventListener('input', () => { poolFilters[col.key]=inp.value; renderPoolTable(); });
      gh.appendChild(inp);
    } else { const sp=document.createElement('div'); sp.style.height='22px'; gh.appendChild(sp); }
    grid.appendChild(gh);
  });

  if (!visible.length) {
    const emp=document.createElement('div'); emp.className='empty-state'; emp.style.gridColumn='1/-1';
    emp.textContent = poolTickets.length ? 'No tickets match filters.' : 'Pool vacío — sube un XLSX.';
    grid.appendChild(emp);
    document.getElementById('poolCount').textContent = `0 / ${poolTickets.length} tickets in pool`;
    return;
  }

  visible.forEach(t => {
    const pc = priorityClass(t.priority);

    const gcId=cell(pc);
    const a=document.createElement('a');
    a.href=`https://itsm.services.sap.com/index.do?uri=ComponentPage&Name=UserActions&Action=displayitem&ExternalKey=${t.id}`;
    a.target='_blank'; a.rel='noopener'; a.className='ticket-link'; a.textContent=t.id;
    gcId.appendChild(a); grid.appendChild(gcId);

    const gcExecId=cell(pc); gcExecId.textContent=t.serviceExecId||''; grid.appendChild(gcExecId);

    const gcSubj=cell(pc+' top');
    const wrap=document.createElement('div'); wrap.className='subj-wrap';
    const st=document.createElement('div'); st.className='subj-text'; st.textContent=t.subject||''; st.title=t.subject||'';
    wrap.appendChild(st);
    if (t.ctRdy) { const cr=document.createElement('div'); cr.className='ct-rdy'; cr.textContent='⏰ '+t.ctRdy; wrap.appendChild(cr); }
    gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    const gcPri=cell(pc);
    if (t.priority) { const b=document.createElement('span'); b.className=`badge-pri badge-${t.priority.toLowerCase().replace(' ','-')}`; b.textContent=t.priority; gcPri.appendChild(b); }
    grid.appendChild(gcPri);

    const urgP=dateUrgencyClass(t.prepStart);
    const gcPrep=cell(pc+(urgP?' '+urgP:'')+' date-cell');
    const pText=document.createElement('span'); pText.className='date-text'; pText.textContent=fmtDate(t.prepStart)||'—';
    gcPrep.appendChild(pText); grid.appendChild(gcPrep);

    const urgE=dateUrgencyClass(t.execStart);
    const gcExecS=cell(pc+(urgE?' '+urgE:'')+' date-cell');
    const eText=document.createElement('span'); eText.className='date-text'; eText.textContent=fmtDate(t.execStart)||'—';
    gcExecS.appendChild(eText); grid.appendChild(gcExecS);

    const gcCust=cell(pc); gcCust.textContent=t.customer||''; gcCust.title=t.customer||''; grid.appendChild(gcCust);

    const gcDel=cell(pc);
    const delBtn=document.createElement('button'); delBtn.className='btn-icon'; delBtn.textContent='🗑'; delBtn.title='Remove from pool';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${t.id} from pool?`)) return;
      await fetch(`/api/${currentArea}/pool/${t.id}`, { method:'DELETE' });
    });
    gcDel.appendChild(delBtn); grid.appendChild(gcDel);
  });

  document.getElementById('poolCount').textContent = `${visible.length} / ${poolTickets.length} tickets in pool`;
}

/* ── Shift table ─────────────────────────────────────────────────────────── */
function renderShiftTable() {
  const tickets = activeShiftTickets[currentArea] || [];
  const shiftId = activeShiftId[currentArea];

  const visible = tickets.filter(t => {
    if (shiftFilters.id        && !t.id.includes(shiftFilters.id)) return false;
    if (shiftFilters.subject   && !(t.subject||'').toLowerCase().includes(shiftFilters.subject.toLowerCase())) return false;
    if (shiftFilters.customer  && !(t.customer||'').toLowerCase().includes(shiftFilters.customer.toLowerCase())) return false;
    if (shiftFilters.processor && !(t.processor||'').toLowerCase().includes(shiftFilters.processor.toLowerCase())) return false;
    if (shiftFilters.category  && !(t.category||'').toLowerCase().includes(shiftFilters.category.toLowerCase())) return false;
    if (shiftFilters.source    && !(t.source||'').toLowerCase().includes(shiftFilters.source.toLowerCase())) return false;
    return true;
  });

  const grid = document.getElementById('shiftGrid');
  grid.innerHTML = '';

  const COLS = [
    { label:'Ticket ID',     key:'id' },
    { label:'Priority',      key:'' },
    { label:'Subject',       key:'subject' },
    { label:'T. Status',     key:'' },
    { label:'Notes',         key:'notes' },
    { label:'Processor',     key:'processor' },
    { label:'Cat.',          key:'category' },
    { label:'Prep Start',    key:'' },
    { label:'Exec Start',    key:'' },
    { label:'Customer',      key:'customer' },
    { label:'Src',           key:'source' },
    { label:'Log',           key:'' },
    { label:'',              key:'' },
  ];

  COLS.forEach(col => {
    const gh=document.createElement('div'); gh.className='gh';
    const lbl=document.createElement('div'); lbl.className='gh-label'; lbl.textContent=col.label; gh.appendChild(lbl);
    if (col.key) {
      const inp=document.createElement('input'); inp.className='col-filter'; inp.placeholder='…'; inp.value=shiftFilters[col.key]||'';
      inp.addEventListener('input', () => { shiftFilters[col.key]=inp.value; renderShiftTable(); });
      gh.appendChild(inp);
    } else { const sp=document.createElement('div'); sp.style.height='22px'; gh.appendChild(sp); }
    grid.appendChild(gh);
  });

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

  const srcColors = { HO:'#7B1FA2', EX:'#0277BD', manual:'#444', execution:'#0277BD', handover:'#7B1FA2' };

  visible.forEach(t => {
    const pc = priorityClass(t.priority);

    const gcId=cell(pc);
    const a=document.createElement('a');
    a.href=`https://itsm.services.sap.com/index.do?uri=ComponentPage&Name=UserActions&Action=displayitem&ExternalKey=${t.id}`;
    a.target='_blank'; a.rel='noopener'; a.className='ticket-link'; a.textContent=t.id;
    gcId.appendChild(a); grid.appendChild(gcId);

    // Priority
    const gcPri=cell(pc);
    if (t.priority) { const b=document.createElement('span'); b.className=`badge-pri badge-${t.priority.toLowerCase().replace(' ','-')}`; b.textContent=t.priority; gcPri.appendChild(b); }
    grid.appendChild(gcPri);

    // Subject + ctRdy
    const gcSubj=cell(pc+' top');
    const wrap=document.createElement('div'); wrap.className='subj-wrap';
    const st=document.createElement('div'); st.className='subj-text'; st.textContent=t.subject||''; st.title=t.subject||'';
    wrap.appendChild(st);
    if (t.ctRdy) { const cr=document.createElement('div'); cr.className='ct-rdy'; cr.textContent='⏰ '+t.ctRdy; wrap.appendChild(cr); }
    gcSubj.appendChild(wrap); grid.appendChild(gcSubj);

    // Ticket Status
    const gcTS=cell(pc);
    gcTS.appendChild(makeSelect(config.ticketStatuses, t.ticketStatus, val => patchShiftTicket(t.id, {ticketStatus:val}), '—'));
    grid.appendChild(gcTS);

    // Notes (replaces Comment in tickets view)
    const gcNotes=cell(pc+' top');
    const ni=document.createElement('input'); ni.className='inline-input'; ni.value=t.notes||t.comment||''; ni.placeholder='notes…'; ni.style.width='100%';
    ni.addEventListener('change', () => patchShiftTicket(t.id, {notes:ni.value}));
    gcNotes.appendChild(ni); grid.appendChild(gcNotes);

    // Processor
    const gcProc=cell(pc);
    gcProc.appendChild(makeSelect(config.processors, t.processor, val => patchShiftTicket(t.id, {processor:val}), '—'));
    grid.appendChild(gcProc);

    // Category
    const gcCat=cell(pc);
    gcCat.appendChild(makeSelect(config.categories, t.category, val => patchShiftTicket(t.id, {category:val}), '—'));
    grid.appendChild(gcCat);

    // Prep Start
    const urgP=dateUrgencyClass(t.prepStart);
    const gcPrep=cell(pc+(urgP?' '+urgP:'')+' date-cell');
    gcPrep.appendChild(makeDateInput(t.prepStart, val => patchShiftTicket(t.id, {prepStart:val}))); grid.appendChild(gcPrep);

    // Exec Start
    const urgE=dateUrgencyClass(t.execStart);
    const gcExecD=cell(pc+(urgE?' '+urgE:'')+' date-cell');
    gcExecD.appendChild(makeDateInput(t.execStart, val => patchShiftTicket(t.id, {execStart:val}))); grid.appendChild(gcExecD);

    // Customer (last info col)
    const gcCust=cell(pc); gcCust.textContent=t.customer||''; gcCust.title=t.customer||''; grid.appendChild(gcCust);

    // Source badge
    const gcSrc=cell(pc); gcSrc.style.justifyContent='center';
    const srcLabel = { manual:'M', HO:'HO', ho:'HO', execution:'EX', handover:'HO' }[t.source] || (t.source||'M').slice(0,2).toUpperCase();
    const srcBadge=document.createElement('span');
    srcBadge.style.cssText=`font-size:9px;font-weight:bold;padding:1px 4px;border-radius:3px;background:${srcColors[t.source]||'#444'};color:#fff`;
    srcBadge.textContent=srcLabel; gcSrc.appendChild(srcBadge); grid.appendChild(gcSrc);

    // Change log button
    const gcLog=cell(pc);
    const logBtn=document.createElement('button'); logBtn.className='btn-icon'; logBtn.textContent='🕐'; logBtn.title='Ver historial de cambios';
    logBtn.addEventListener('click', () => openChangeLog(t.id));
    gcLog.appendChild(logBtn); grid.appendChild(gcLog);

    // Delete
    const gcDel=cell(pc);
    const delBtn=document.createElement('button'); delBtn.className='btn-icon'; delBtn.textContent='🗑'; delBtn.title='Remove from shift';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${t.id} from shift?`)) return;
      await fetch(`/api/${currentArea}/shifts/${shiftId}/tickets/${t.id}`, { method:'DELETE' });
      await reloadShiftTickets();
    });
    gcDel.appendChild(delBtn); grid.appendChild(gcDel);
  });

  document.getElementById('shiftCount').textContent=`${visible.length} / ${tickets.length} tickets`;
}

/* ── Config panel ────────────────────────────────────────────────────────── */
function openConfig() {
  populateConfigSection('processorList',    config.processors,    false, 'processors');
  populateConfigSection('ticketStatusList', config.ticketStatuses,true,  'ticketStatuses');
  populateConfigSection('userStatusList',   config.userStatuses,  true,  'userStatuses');
  populateConfigSection('validationList',   config.validations,   true,  'validations');
  populateConfigSection('categoryList',     config.categories,    true,  'categories');
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
    const sectionMap = { processors:'processorList', ticketStatuses:'ticketStatusList', userStatuses:'userStatusList', validations:'validationList', categories:'categoryList' };
    populateConfigSection(sectionMap[key], config[key], hasColor, key);
  });
}

setupAddConfig('btnAddProcessor',  'newProcessorInput',  null,               'processors',    false);
setupAddConfig('btnAddStatus',     'newStatusInput',     'newStatusColor',   'ticketStatuses',true);
setupAddConfig('btnAddUserStatus', 'newUserStatusInput', 'newUserStatusColor','userStatuses',  true);
setupAddConfig('btnAddValidation', 'newValidationInput', 'newValidationColor','validations',   true);
setupAddConfig('btnAddCategory',   'newCategoryInput',   'newCategoryColor', 'categories',    true);

function populateAddSelects() {
  const catSel=document.getElementById('addCategory'); catSel.innerHTML='<option value="">—</option>';
  config.categories.forEach(c => { const o=document.createElement('option'); o.value=c.name; o.textContent=c.name; catSel.appendChild(o); });
}
function populateShiftAddSelects() {
  const catSel=document.getElementById('shiftAddCategory'); catSel.innerHTML='<option value="">—</option>';
  config.categories.forEach(c => { const o=document.createElement('option'); o.value=c.name; o.textContent=c.name; catSel.appendChild(o); });
}
