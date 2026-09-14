/* ── Ticketdash Monitor — popup.js ── */

const DEFAULT_SERVER = 'https://ticketmastersrhunter360.milcoms.org';

let serverUrl = DEFAULT_SERVER;
let currentUser = null;
let currentArea = null;
let currentShiftId = null;
let tickets = [];
let config  = { processors: [], categories: [], userStatuses: [] };

// ── Urgency class (same logic as Ticketdash) ─────────────────────────────────
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
  if (isNaN(d)) return iso;
  const mo = String(d.getUTCMonth()+1).padStart(2,'0');
  const dy = String(d.getUTCDate()).padStart(2,'0');
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${mo}/${dy} ${hh}:${mm}`;
}

// ── API helpers ───────────────────────────────────────────────────────────────
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
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved server URL
  const stored = await chrome.storage.local.get(['serverUrl']);
  if (stored.serverUrl) serverUrl = stored.serverUrl;
  document.getElementById('serverUrl').value = serverUrl;

  document.getElementById('btnSaveUrl').addEventListener('click', async () => {
    serverUrl = document.getElementById('serverUrl').value.trim().replace(/\/$/, '');
    await chrome.storage.local.set({ serverUrl });
    init();
  });

  document.getElementById('btnRefresh').addEventListener('click', loadTickets);
  document.getElementById('btnOpenApp').addEventListener('click', () => {
    chrome.tabs.create({ url: serverUrl });
  });

  // Filter listeners
  ['filterProcessor','filterCat','filterStatus'].forEach(id => {
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

    // Prefer SM; if only Merge, use Merge
    currentArea = isSM ? 'sm' : 'merge';
    const badge = document.getElementById('areaBadge');
    badge.textContent = currentArea.toUpperCase();
    badge.className = `area-badge area-${currentArea}`;

    // Load config for dropdowns
    try {
      const cfg = await apiFetch('/api/config');
      if (cfg) config = cfg;
      // Merge live processor list from Authentik users
      const users = await apiFetch(`/api/users?area=${currentArea}`);
      if (Array.isArray(users) && users.length) {
        const COLORS = ['#0288D1','#7B1FA2','#E65100','#2E7D32','#C62828','#00838F','#5c3f7f','#6D4C41','#1565C0','#558B2F'];
        const existingColors = new Map((config.processors||[]).map(p => [p.name, p.color]));
        config.processors = users.map((name, i) => ({
          name, color: existingColors.get(name) || COLORS[i % COLORS.length],
        }));
      }
    } catch {}

    buildFilterOptions();
    loadTickets();
  } catch (e) {
    showState('notLoggedIn');
  }
}

function showState(state) {
  document.getElementById('notLoggedIn').style.display = state === 'notLoggedIn' ? '' : 'none';
  document.getElementById('noArea').style.display      = state === 'noArea'      ? '' : 'none';
  document.getElementById('tableWrap').style.display   = state === 'table'       ? '' : 'none';
}

function buildFilterOptions() {
  const fill = (id, items) => {
    const sel = document.getElementById(id);
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
  fill('filterCat',       config.categories);
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
  } catch (e) {
    showState('notLoggedIn');
  } finally {
    document.getElementById('btnRefresh').textContent = '↺';
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderRows() {
  const fpProc   = document.getElementById('filterProcessor').value;
  const fpCat    = document.getElementById('filterCat').value;
  const fpStatus = document.getElementById('filterStatus').value;

  const visible = tickets.filter(t => {
    if (fpProc   && (t.processor  ||'') !== fpProc)   return false;
    if (fpCat    && (t.category   ||'') !== fpCat)    return false;
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

  visible.forEach(t => {
    const tr = document.createElement('tr');

    // Ticket ID
    const tdId = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id)}`;
    a.target = '_blank'; a.rel = 'noopener';
    a.className = 'ticket-link'; a.textContent = t.id;
    tdId.appendChild(a); tr.appendChild(tdId);

    // Subject
    const tdSubj = document.createElement('td');
    tdSubj.style.maxWidth = '0'; // allow ellipsis
    const subjWrap = document.createElement('div'); subjWrap.className = 'subj-cell';
    subjWrap.textContent = t.subject || ''; subjWrap.title = t.subject || '';
    tdSubj.appendChild(subjWrap);
    if (t.ctRdy) {
      const cr = document.createElement('div'); cr.className = 'ct-rdy';
      cr.textContent = '⏰ ' + fmtDate(t.ctRdy); tdSubj.appendChild(cr);
    }
    tr.appendChild(tdSubj);

    // Processor (read-only, colored if in config)
    const tdProc = document.createElement('td');
    const procOpt = (config.processors||[]).find(p => p.name === t.processor);
    tdProc.textContent = t.processor || '—';
    if (procOpt?.color) { tdProc.style.color = procOpt.color; tdProc.style.fontWeight = 'bold'; }
    tdProc.title = t.processor || '';
    tr.appendChild(tdProc);

    // Notes — editable
    const tdNotes = document.createElement('td');
    const ni = document.createElement('input');
    ni.className = 'inline-input'; ni.value = t.notes || t.comment || '';
    ni.placeholder = 'notes…'; ni.title = ni.value;
    ni.addEventListener('change', async () => {
      t.notes = ni.value;
      try { await patchTicket(t.id, { notes: ni.value }); } catch {}
    });
    tdNotes.appendChild(ni); tr.appendChild(tdNotes);

    // Category — editable select
    const tdCat = document.createElement('td');
    const catSel = document.createElement('select'); catSel.className = 'inline-sel';
    const blankCat = document.createElement('option'); blankCat.value = ''; blankCat.textContent = '—';
    catSel.appendChild(blankCat);
    (config.categories||[]).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.name; opt.textContent = o.name;
      if (o.name === t.category) opt.selected = true;
      catSel.appendChild(opt);
    });
    if (!t.category) catSel.value = '';
    catSel.addEventListener('change', async () => {
      t.category = catSel.value;
      try { await patchTicket(t.id, { category: catSel.value }); } catch {}
    });
    tdCat.appendChild(catSel); tr.appendChild(tdCat);

    // Prep Start
    const tdPrep = document.createElement('td');
    const prepCls = dateUrgencyClass(t.prepStart);
    tdPrep.className = `date-cell ${prepCls}`;
    tdPrep.textContent = fmtDate(t.prepStart);
    tdPrep.title = t.prepStart || '';
    tr.appendChild(tdPrep);

    // Exec Start
    const tdExec = document.createElement('td');
    const execCls = dateUrgencyClass(t.execStart);
    tdExec.className = `date-cell ${execCls}`;
    tdExec.textContent = fmtDate(t.execStart);
    tdExec.title = t.execStart || '';
    tr.appendChild(tdExec);

    // My Status — editable select
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
    stSel.addEventListener('change', async () => {
      t.userStatus = stSel.value;
      if (stSel.value && config.userStatuses) {
        const opt = config.userStatuses.find(o => o.name === stSel.value);
        stSel.style.color = opt?.color || '';
      } else { stSel.style.color = ''; }
      try { await patchTicket(t.id, { userStatus: stSel.value }); } catch {}
    });
    // Set initial color
    if (t.userStatus && config.userStatuses) {
      const opt = config.userStatuses.find(o => o.name === t.userStatus);
      stSel.style.color = opt?.color || '';
    }
    tdStatus.appendChild(stSel); tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  });

  // Auto-refresh dates every minute
  setTimeout(renderRows, 60000);
}
