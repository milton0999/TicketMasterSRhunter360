/* ── TicketMasterSRhunter360 — popup.js ── */

const DEFAULT_SERVER = 'https://ticketmastersrhunter360.milcoms.org';

let serverUrl = DEFAULT_SERVER;
let currentUser = null;
let currentArea = null;
let currentShiftId = null;
let tickets = [];
let config  = { processors: [], categories: [], userStatuses: [] };
let refreshTimer = null;

// ── Urgency ───────────────────────────────────────────────────────────────────
function dateUrgencyClass(iso) {
  if (!iso) return 'date-none';
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d)) return 'date-none';
  const min = (d.getTime() - Date.now()) / 60000;
  if (min > 15)   return 'date-future';
  if (min > 5)    return 'date-warn';
  if (min > 0)    return 'date-near';
  if (min >= -45) return 'date-active';
  return 'date-expired';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d)) return '—';
  const mo = String(d.getUTCMonth()+1).padStart(2,'0');
  const dy = String(d.getUTCDate()).padStart(2,'0');
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${mo}/${dy} ${hh}:${mm}`;
}

// ── Tab-group opener ──────────────────────────────────────────────────────────
async function openTicketInGroup(t) {
  const url = `https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id)}`;
  const fmtShort = iso => {
    if (!iso) return '';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    if (isNaN(d)) return '';
    return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  };
  const ps = fmtShort(t.prepStart);
  const es = fmtShort(t.execStart);
  const datePart = [ps && `PS ${ps}`, es && `ES ${es}`].filter(Boolean).join(' | ');
  const groupTitle = datePart ? `${t.id} (${datePart})` : t.id;

  const urg = dateUrgencyClass(t.execStart || t.prepStart);
  const colorMap = { 'date-future':'blue','date-warn':'yellow','date-near':'orange','date-active':'red','date-expired':'grey' };
  const groupColor = colorMap[urg] || 'blue';

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab?.id && chrome.tabGroups) {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: groupTitle, color: groupColor });
    }
  } catch (e) { console.error('openTicketInGroup:', e); }
}

// ── Notes popover ─────────────────────────────────────────────────────────────
let _popoverTicket = null;
let _popoverTr = null;

function openNotesPopover(t, tr, anchorEl) {
  _popoverTicket = t;
  _popoverTr = tr;
  const pop = document.getElementById('notesPopover');
  document.getElementById('notesPopoverTitle').textContent = `Notes — ${t.id}`;
  document.getElementById('notesPopoverArea').value = t.notes || t.comment || '';

  // Position: below the anchor cell, constrained to popup width
  const rect = anchorEl.getBoundingClientRect();
  pop.style.top  = (rect.bottom + 4) + 'px';
  const left = Math.min(rect.left, window.innerWidth - 348);
  pop.style.left = Math.max(4, left) + 'px';

  pop.classList.add('visible');
  document.getElementById('notesPopoverArea').focus();
}

function closeNotesPopover() {
  document.getElementById('notesPopover').classList.remove('visible');
  _popoverTicket = null; _popoverTr = null;
}

async function saveNotesPopover() {
  if (!_popoverTicket) return;
  const val = document.getElementById('notesPopoverArea').value;
  _popoverTicket.notes = val;
  // Update the cell text
  const cell = _popoverTr?.querySelector('.notes-cell');
  if (cell) { cell.textContent = val || '✎'; cell.classList.toggle('has-notes', !!val); }
  closeNotesPopover();
  try { await patchTicket(_popoverTicket.id, { notes: val }); }
  catch { if (_popoverTr) { _popoverTr.style.outline = '1px solid #cc2200'; setTimeout(() => _popoverTr.style.outline = '', 1500); } }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnPopSave').addEventListener('click', saveNotesPopover);
  document.getElementById('btnPopClose').addEventListener('click', closeNotesPopover);
  // Click outside closes popover
  document.addEventListener('click', e => {
    const pop = document.getElementById('notesPopover');
    if (pop.classList.contains('visible') && !pop.contains(e.target) && !e.target.closest('.notes-cell')) {
      saveNotesPopover();
    }
  });
  // Ctrl+Enter saves
  document.getElementById('notesPopoverArea').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); saveNotesPopover(); }
    if (e.key === 'Escape') closeNotesPopover();
  });
});

// ── API ───────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(serverUrl + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function patchTicket(id, updates) {
  await apiFetch(`/api/${currentArea}/shifts/${currentShiftId}/tickets/${id}`, {
    method: 'PATCH', body: JSON.stringify(updates),
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['serverUrl']);
  if (stored.serverUrl) serverUrl = stored.serverUrl;

  document.getElementById('btnRefresh').addEventListener('click', loadTickets);
  document.getElementById('btnOpenApp').addEventListener('click', () => {
    chrome.tabs.create({ url: serverUrl });
  });

  ['filterProcessor','filterStatus'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderRows);
  });

  init();
});

async function init() {
  try {
    const me = await apiFetch('/auth/me');
    if (!me.authenticated) return showState('notLoggedIn');

    currentUser = me.user;
    document.getElementById('headerUser').textContent = currentUser.name || currentUser.email || '';

    const groups = currentUser.groups || [];
    const isSM    = groups.some(g => ['sm-users','sm-leads','managers','authentik Admins'].includes(g));
    const isMerge = groups.some(g => ['merge-users','merge-leads','managers','authentik Admins'].includes(g));
    if (!isSM && !isMerge) return showState('noArea');

    currentArea = isSM ? 'sm' : 'merge';
    const badge = document.getElementById('areaBadge');
    badge.textContent = currentArea.toUpperCase();
    badge.className = `area-badge area-${currentArea}`;

    try {
      const cfg = await apiFetch('/api/config');
      if (cfg) config = cfg;
      const users = await apiFetch(`/api/users?area=${currentArea}`);
      if (Array.isArray(users) && users.length) {
        const COLORS = ['#0288D1','#7B1FA2','#E65100','#2E7D32','#C62828','#00838F','#5c3f7f','#6D4C41','#1565C0','#558B2F'];
        const existing = new Map((config.processors||[]).map(p => [p.name, p.color]));
        config.processors = users.map((name, i) => ({ name, color: existing.get(name) || COLORS[i % COLORS.length] }));
      }
    } catch {}

    buildFilterOptions();
    loadTickets();
  } catch { showState('notLoggedIn'); }
}

function showState(state) {
  document.getElementById('notLoggedIn').style.display = state === 'notLoggedIn' ? '' : 'none';
  document.getElementById('noArea').style.display      = state === 'noArea'      ? '' : 'none';
  document.getElementById('tableWrap').style.display   = state === 'table'       ? '' : 'none';
}

function buildFilterOptions() {
  const fill = (id, items) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All</option>';
    (items||[]).forEach(o => {
      const name = typeof o === 'string' ? o : o.name;
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === cur) opt.selected = true;
      sel.appendChild(opt);
    });
  };
  fill('filterProcessor', config.processors);
  fill('filterStatus',    config.userStatuses);
}

async function loadTickets() {
  document.getElementById('btnRefresh').textContent = '↻';
  try {
    const shift = await apiFetch(`/api/${currentArea}/shifts/today`);
    currentShiftId = shift.id;
    const data = await apiFetch(`/api/${currentArea}/shifts/${currentShiftId}/tickets`);
    tickets = data || [];
    showState('table');
    renderRows();
  } catch { showState('notLoggedIn'); }
  finally { document.getElementById('btnRefresh').textContent = '↺'; }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderRows() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

  const fpProc   = document.getElementById('filterProcessor').value;
  const fpStatus = document.getElementById('filterStatus').value;

  const visible = tickets.filter(t => {
    if (fpProc   && (t.processor  ||'') !== fpProc)   return false;
    if (fpStatus && (t.userStatus ||'') !== fpStatus) return false;
    return true;
  });

  document.getElementById('ticketCount').textContent = `${visible.length} / ${tickets.length} tickets`;
  const tbody = document.getElementById('ticketBody');
  tbody.innerHTML = '';

  const empty = document.getElementById('emptyState');
  if (!visible.length) {
    empty.style.display = '';
    empty.textContent = tickets.length ? 'No tickets match filters.' : 'No tickets in active shift.';
    return;
  }
  empty.style.display = 'none';

  const patch = async (tr, id, updates) => {
    try {
      await patchTicket(id, updates);
    } catch {
      tr.style.outline = '1px solid #cc2200';
      setTimeout(() => tr.style.outline = '', 1500);
    }
  };

  visible.forEach(t => {
    const tr = document.createElement('tr');

    // Color bar — category color
    const catOpt = (config.categories||[]).find(c => c.name === t.category);
    const barColor = catOpt?.color || '#2a2a35';
    const tdBar = document.createElement('td');
    tdBar.className = 'td-bar';
    tdBar.style.borderLeft = `4px solid ${barColor}`;
    tr.appendChild(tdBar);

    // Ticket ID — opens in Tab Group
    const tdId = document.createElement('td');
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ticket-link'; a.textContent = t.id;
    a.addEventListener('click', e => { e.preventDefault(); openTicketInGroup(t); });
    tdId.appendChild(a); tr.appendChild(tdId);

    // Subject (read-only, ellipsis)
    const tdSubj = document.createElement('td');
    const subjWrap = document.createElement('div');
    subjWrap.className = 'subj-cell'; subjWrap.textContent = t.subject || ''; subjWrap.title = t.subject || '';
    tdSubj.appendChild(subjWrap);
    if (t.ctRdy) {
      const cr = document.createElement('div'); cr.className = 'ct-rdy';
      cr.textContent = '⏰ ' + fmtDate(t.ctRdy); tdSubj.appendChild(cr);
    }
    tr.appendChild(tdSubj);

    // Processor — editable select
    const tdProc = document.createElement('td');
    const procSel = document.createElement('select'); procSel.className = 'inline-sel';
    const blankProc = document.createElement('option'); blankProc.value = ''; blankProc.textContent = '—';
    procSel.appendChild(blankProc);
    (config.processors||[]).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.name; opt.textContent = o.name;
      if (o.name === t.processor) opt.selected = true;
      opt.style.color = o.color || '';
      procSel.appendChild(opt);
    });
    if (!t.processor) procSel.value = '';
    const applyProcColor = () => {
      const opt = (config.processors||[]).find(o => o.name === procSel.value);
      procSel.style.color = opt?.color || '#ccc';
    };
    applyProcColor();
    procSel.addEventListener('change', async () => {
      t.processor = procSel.value; applyProcColor();
      await patch(tr, t.id, { processor: procSel.value });
    });
    tdProc.appendChild(procSel); tr.appendChild(tdProc);

    // Notes — click to open popover
    const tdNotes = document.createElement('td');
    const noteSpan = document.createElement('span');
    const noteVal = t.notes || t.comment || '';
    noteSpan.className = 'notes-cell' + (noteVal ? ' has-notes' : '');
    noteSpan.textContent = noteVal || '✎';
    noteSpan.title = noteVal || 'Click to add notes';
    noteSpan.addEventListener('click', e => { e.stopPropagation(); openNotesPopover(t, tr, noteSpan); });
    tdNotes.appendChild(noteSpan); tr.appendChild(tdNotes);

    // Prep Start (read-only, semaphore)
    const tdPrep = document.createElement('td');
    tdPrep.className = `date-cell ${dateUrgencyClass(t.prepStart)}`;
    tdPrep.textContent = fmtDate(t.prepStart); tdPrep.title = t.prepStart || '';
    tr.appendChild(tdPrep);

    // Exec Start (read-only, semaphore)
    const tdExec = document.createElement('td');
    tdExec.className = `date-cell ${dateUrgencyClass(t.execStart)}`;
    tdExec.textContent = fmtDate(t.execStart); tdExec.title = t.execStart || '';
    tr.appendChild(tdExec);

    // My Status — editable select with color
    const tdStatus = document.createElement('td');
    const stSel = document.createElement('select'); stSel.className = 'inline-sel';
    const blankSt = document.createElement('option'); blankSt.value = ''; blankSt.textContent = '—';
    stSel.appendChild(blankSt);
    (config.userStatuses||[]).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.name; opt.textContent = o.name;
      if (o.name === t.userStatus) opt.selected = true;
      stSel.appendChild(opt);
    });
    if (!t.userStatus) stSel.value = '';
    const applyStColor = () => {
      const opt = (config.userStatuses||[]).find(o => o.name === stSel.value);
      stSel.style.color = opt?.color || '#ccc';
    };
    applyStColor();
    stSel.addEventListener('change', async () => {
      t.userStatus = stSel.value; applyStColor();
      await patch(tr, t.id, { userStatus: stSel.value });
    });
    tdStatus.appendChild(stSel); tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  });

  // Refresh semaphore every minute
  refreshTimer = setTimeout(renderRows, 60000);
}
