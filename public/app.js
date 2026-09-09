const socket = io();

let allTickets = [];
let currentArea = 'sm';
let areaAccess = { sm: false, merge: false };

// ── Show logged-in user ───────────────────────────────────────────────────────
fetch('/auth/me').then(r => r.json()).then(data => {
  if (data.authenticated && data.user) {
    const el = document.getElementById('authUser');
    if (el) el.textContent = data.user.name || data.user.email || '';
  }
}).catch(() => {});

fetch('/api/version').then(r => r.json()).then(data => {
  const el = document.getElementById('appVersion');
  if (el && data.version) el.textContent = `v${data.version}`;
}).catch(() => {});

// ── Area access + tab setup ───────────────────────────────────────────────────
fetch('/auth/area').then(r => r.json()).then(access => {
  areaAccess = access;
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(btn => {
    const area = btn.dataset.area;
    if (access[area]) btn.classList.remove('hidden');
  });
  // default to first available area
  if (access.sm) {
    switchArea('sm');
  } else if (access.merge) {
    switchArea('merge');
  } else if (access.shift) {
    switchArea('shift');
  }
}).catch(() => {});

function switchArea(area) {
  currentArea = area;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.area === area);
  });
  // render with cached data
  if (area === 'shift') { renderShiftTable(); }
  else if (area === 'pool') { renderPoolTable(); }
  else { renderTable(); }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!areaAccess[btn.dataset.area]) return;
    switchArea(btn.dataset.area);
  });
});

const colFilters = {
  id: '', priority: '', subject: '', ticketStatus: '', comment: '',
  processor: '', category: '', prepStart: '', execStart: '',
  userStatus: '', validation: ''
};

// ── Persisted config ──────────────────────────────────────────────────────────
let processors = JSON.parse(localStorage.getItem('td_processors') ||
  '["Davod","Carlos","Almaraz","Karen","Milton","Marissa","David R","Raymundo","Leads"]');

let ticketStatuses = JSON.parse(localStorage.getItem('td_statuses') ||
  '[{"label":"In Process","color":"#0288D1"},{"label":"Waiting","color":"#FFB300"},{"label":"Done","color":"#4CAF50"},{"label":"Escalated","color":"#f44336"}]');

let userStatuses = JSON.parse(localStorage.getItem('td_userstatuses') ||
  '[{"value":"new","label":"🔵 New","color":"#0288D1"},{"value":"reviewing","label":"🟡 Reviewing","color":"#FFB300"},{"value":"done","label":"🟢 Done","color":"#4CAF50"},{"value":"ho","label":"🟣 Pass to HO","color":"#9C27B0"}]');

let validations = JSON.parse(localStorage.getItem('td_validations') ||
  '[{"value":"pending","label":"⬜ Pending","color":"#666"},{"value":"ok","label":"✅ All Good","color":"#4CAF50"},{"value":"check","label":"⚠️ Needs Check","color":"#FF9800"},{"value":"ho_ready","label":"🚀 HO Ready","color":"#2196F3"}]');

let categories = JSON.parse(localStorage.getItem('td_categories') ||
  '[{"value":"self","label":"Self","color":"#4FC3F7"},{"value":"non_self","label":"Non Self","color":"#FFB300"},{"value":"tqs","label":"TQS","color":"#81C784"}]');

function saveProcessors()   { localStorage.setItem('td_processors',   JSON.stringify(processors)); }
function saveStatuses()     { localStorage.setItem('td_statuses',     JSON.stringify(ticketStatuses)); }
function saveUserStatuses() { localStorage.setItem('td_userstatuses', JSON.stringify(userStatuses)); }
function saveValidations()  { localStorage.setItem('td_validations',  JSON.stringify(validations)); }
function saveCategories()   { localStorage.setItem('td_categories',   JSON.stringify(categories)); }

// ── Per-area ticket cache ─────────────────────────────────────────────────────
const areaTickets = { sm: [], merge: [] };
let poolTickets = [];
let shiftTickets = [];

const PRI_CLASS = { 'Very High': 'very-high', High: 'high', Medium: 'medium', Low: 'low' };

// ── Date helpers ──────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s || !s.trim()) return null;
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(s)) return new Date(s);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s))  return new Date(s + 'Z');
  let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\s+(\d{2}):(\d{2})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4]}:${m[5]}Z`);
  return null;
}

function getDateClass(s) {
  const d = parseDate(s);
  if (!d) return '';
  const min = (d - Date.now()) / 60000;
  if (min > 30)   return 'date-ok';
  if (min > 10)   return 'date-soon';
  if (min > 0)    return 'date-imminent';
  if (min > -60)  return 'date-started';
  return 'date-passed';
}

function formatShortDate(s, prefix) {
  const d = parseDate(s);
  if (!d) return s || '—';
  const tz    = (typeof TDP !== 'undefined' ? TDP.getTz() : null) || localStorage.getItem('td_tz') || 'UTC';
  const offset = tz === 'MTY' ? -6 * 60 : 0;
  const local  = new Date(d.getTime() + offset * 60000);
  const dd = String(local.getUTCDate()).padStart(2,'0');
  const mm = String(local.getUTCMonth()+1).padStart(2,'0');
  const hh = String(local.getUTCHours()).padStart(2,'0');
  const mi = String(local.getUTCMinutes()).padStart(2,'0');
  const tzTag = tz === 'MTY' ? ' MTY' : ' UTC';
  return `${prefix} ${dd}-${mm} ${hh}:${mi}${tzTag}`;
}

// ── Timezone toggle ───────────────────────────────────────────────────────────
function applyTzToggleUI() {
  const tz = localStorage.getItem('td_tz') || 'UTC';
  document.querySelectorAll('.tz-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tz === tz);
  });
}

document.querySelectorAll('.tz-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    localStorage.setItem('td_tz', btn.dataset.tz);
    applyTzToggleUI();
    document.querySelectorAll('[data-datefield]').forEach(cell => {
      const v   = cell.dataset.datevalue || '';
      const pfx = cell.dataset.datefield === 'prepStart' ? 'PS' : 'ES';
      const lbl = cell.querySelector('.date-text');
      if (lbl) lbl.textContent = v ? formatShortDate(v, pfx) : `— ${pfx} —`;
    });
  });
});
applyTzToggleUI();

// ── Socket ────────────────────────────────────────────────────────────────────
socket.on('connect', () => {
  const b = document.getElementById('connBadge');
  b.textContent = '● Online'; b.classList.add('online');
});
socket.on('disconnect', () => {
  const b = document.getElementById('connBadge');
  b.textContent = '● Offline'; b.classList.remove('online');
});
socket.on('sm:tickets:update', t => {
  areaTickets.sm = t;
  if (currentArea === 'sm') { allTickets = t; renderTable(); }
});
socket.on('merge:tickets:update', t => {
  areaTickets.merge = t;
  if (currentArea === 'merge') { allTickets = t; renderTable(); }
});
socket.on('pool:tickets:update', t => {
  poolTickets = t;
  document.getElementById('poolCount').textContent = `${t.length} ticket${t.length !== 1 ? 's' : ''} in pool`;
  if (currentArea === 'pool') renderPoolTable();
});
socket.on('shift:tickets:update', t => {
  shiftTickets = t;
  if (currentArea === 'shift') renderShiftTable();
});
socket.on('users:count', n => {
  document.getElementById('userCount').textContent = `${n} user${n !== 1 ? 's' : ''} connected`;
});

function switchArea(area) {
  currentArea = area;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.area === area);
  });

  // Show/hide toolbars and scroll areas
  const isSmMerge = area === 'sm' || area === 'merge';
  document.getElementById('smToolbar').style.display    = isSmMerge ? '' : 'none';
  document.getElementById('shiftToolbar').style.display = area === 'shift' ? '' : 'none';
  document.getElementById('poolToolbar').style.display  = area === 'pool'  ? '' : 'none';
  document.getElementById('smScrollArea').style.display    = isSmMerge ? '' : 'none';
  document.getElementById('shiftScrollArea').style.display = area === 'shift' ? '' : 'none';
  document.getElementById('poolScrollArea').style.display  = area === 'pool'  ? '' : 'none';

  if (area === 'sm' || area === 'merge') {
    allTickets = areaTickets[area] || [];
    renderTable();
  } else if (area === 'shift') {
    renderShiftTable();
  } else if (area === 'pool') {
    renderPoolTable();
  }
}

setInterval(() => {
  document.querySelectorAll('[data-datefield]').forEach(cell => {
    const v = cell.dataset.datevalue || '';
    cell.className = cell.className.replace(/\bdate-\w+/g, '').trim();
    const c = getDateClass(v);
    if (c) cell.classList.add(c);
    const lbl = cell.querySelector('.date-text');
    if (lbl && !lbl.dataset.editing) {
      const prefix = cell.dataset.datefield === 'prepStart' ? 'PS' : 'ES';
      lbl.textContent = v ? formatShortDate(v, prefix) : '—';
    }
  });
}, 30000);

// ── Panel helpers ─────────────────────────────────────────────────────────────
const backdrop = document.getElementById('panelBackdrop');
function openPanel(id) { document.getElementById(id).classList.add('visible'); backdrop.classList.add('visible'); }
function closeAllPanels() {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('visible'));
  backdrop.classList.remove('visible');
  TDP.close();
}
backdrop.addEventListener('click', closeAllPanels);

// ── Toolbar ───────────────────────────────────────────────────────────────────
document.getElementById('btnPasteToggle').addEventListener('click', () => {
  const p = document.getElementById('pastePanel');
  if (p.classList.contains('visible')) { closeAllPanels(); return; }
  closeAllPanels(); openPanel('pastePanel');
});
document.getElementById('btnPasteCancel').addEventListener('click', () => {
  closeAllPanels(); document.getElementById('pasteArea').value = '';
});
const pasteArea = document.getElementById('pasteArea');
pasteArea.addEventListener('paste', e => {
  e.preventDefault();
  pasteArea.value = (e.clipboardData || window.clipboardData).getData('text');
});
document.getElementById('btnPasteLoad').addEventListener('click', async () => {
  const raw = pasteArea.value.trim();
  if (!raw) { alert('Nothing to load — paste the handover first.'); return; }
  const res = await fetch(`/api/${currentArea}/tickets/handover`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({raw})
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Error'); return; }
  pasteArea.value = ''; closeAllPanels();
  showToast(`${data.added} ticket(s) added${data.skipped ? `, ${data.skipped} skipped` : ''}`);
});

document.getElementById('btnAddToggle').addEventListener('click', () => {
  const p = document.getElementById('addPanel');
  if (p.classList.contains('visible')) { closeAllPanels(); return; }
  closeAllPanels(); openPanel('addPanel');
});
document.getElementById('btnAddCancel').addEventListener('click', () => { closeAllPanels(); clearAddForm(); });
document.getElementById('btnAddSave').addEventListener('click', async () => {
  const id = document.getElementById('addId').value.trim();
  if (!id) { alert('Ticket ID is required.'); return; }
  const body = {
    id,
    priority:     document.getElementById('addPriority').value,
    subject:      document.getElementById('addSubject').value.trim(),
    ticketStatus: document.getElementById('addTicketStatus').value.trim(),
    processor:    document.getElementById('addProcessor').value.trim(),
    category:     document.getElementById('addCategory').value.trim(),
    prepStart:    document.getElementById('addPrepStart').value,
    execStart:    document.getElementById('addExecStart').value,
    notes:        document.getElementById('addNotes').value.trim(),
  };
  const res = await fetch(`/api/${currentArea}/tickets/single`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Error'); return; }
  clearAddForm(); closeAllPanels(); showToast('Ticket added');
});
function clearAddForm() {
  ['addId','addSubject','addTicketStatus','addProcessor','addCategory','addPrepStart','addExecStart','addNotes']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('addPriority').value = '';
}

document.getElementById('btnConfigToggle').addEventListener('click', () => {
  const p = document.getElementById('configPanel');
  if (p.classList.contains('visible')) { closeAllPanels(); return; }
  closeAllPanels(); renderConfigLists(); openPanel('configPanel');
});
document.getElementById('btnConfigClose').addEventListener('click', closeAllPanels);

document.getElementById('btnClearAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL tickets in this area? This cannot be undone.')) return;
  await fetch(`/api/${currentArea}/tickets`, { method: 'DELETE' });
});

// ── Config: render all four lists ─────────────────────────────────────────────
function renderConfigLists() {
  renderSimpleList('processorList', processors,
    (i) => { processors.splice(i,1); saveProcessors(); renderConfigLists(); rebuildHeaders(); },
    (i, val) => { processors[i] = val; saveProcessors(); renderConfigLists(); rebuildHeaders(); }
  );
  renderStatusList('ticketStatusList', ticketStatuses,
    saveStatuses, () => { renderConfigLists(); renderTable(); }
  );
  renderStatusValueList('userStatusList', userStatuses,
    saveUserStatuses, () => { renderConfigLists(); rebuildHeaders(); renderTable(); }
  );
  renderStatusValueList('validationList', validations,
    saveValidations, () => { renderConfigLists(); rebuildHeaders(); renderTable(); }
  );
  renderStatusValueList('categoryList', categories,
    saveCategories, () => { renderConfigLists(); rebuildHeaders(); renderTable(); }
  );
  // sync addCategory select
  const addCatSel = document.getElementById('addCategory');
  if (addCatSel) {
    addCatSel.innerHTML = '<option value="">— Select —</option>';
    categories.forEach(c => { const o=document.createElement('option'); o.value=c.value; o.textContent=c.label; addCatSel.appendChild(o); });
  }
}

function renderSimpleList(containerId, arr, onDelete, onEdit) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  arr.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'config-item';

    const nameSpan = document.createElement('span');
    nameSpan.contentEditable = true;
    nameSpan.className = 'config-editable';
    nameSpan.textContent = name;
    nameSpan.addEventListener('blur', e => {
      const v = e.target.textContent.trim();
      if (v && v !== arr[i]) onEdit(i, v);
    });
    nameSpan.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

    const del = document.createElement('button');
    del.className = 'btn-icon'; del.title = 'Remove'; del.textContent = '🗑️';
    del.addEventListener('click', () => onDelete(i));

    item.appendChild(nameSpan);
    item.appendChild(del);
    el.appendChild(item);
  });
}

function renderStatusList(containerId, arr, save, onChanged) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  arr.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'config-item';

    const colorIn = document.createElement('input');
    colorIn.type = 'color'; colorIn.value = s.color;
    colorIn.className = 'config-color-input';
    colorIn.addEventListener('change', e => { arr[i].color = e.target.value; save(); onChanged(); });

    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.background = s.color;
    colorIn.addEventListener('input', e => { dot.style.background = e.target.value; });

    const nameSpan = document.createElement('span');
    nameSpan.contentEditable = true;
    nameSpan.className = 'config-editable';
    nameSpan.textContent = s.label;
    nameSpan.addEventListener('blur', e => {
      const v = e.target.textContent.trim();
      if (v && v !== arr[i].label) { arr[i].label = v; save(); onChanged(); }
    });
    nameSpan.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

    const del = document.createElement('button');
    del.className = 'btn-icon'; del.title = 'Remove'; del.textContent = '🗑️';
    del.addEventListener('click', () => { arr.splice(i,1); save(); onChanged(); });

    item.appendChild(dot);
    item.appendChild(colorIn);
    item.appendChild(nameSpan);
    item.appendChild(del);
    el.appendChild(item);
  });
}

function renderStatusValueList(containerId, arr, save, onChanged) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  arr.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'config-item';

    const colorIn = document.createElement('input');
    colorIn.type = 'color'; colorIn.value = s.color || '#666';
    colorIn.className = 'config-color-input';
    colorIn.addEventListener('change', e => { arr[i].color = e.target.value; save(); onChanged(); });

    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.background = s.color || '#666';
    colorIn.addEventListener('input', e => { dot.style.background = e.target.value; });

    const nameSpan = document.createElement('span');
    nameSpan.contentEditable = true;
    nameSpan.className = 'config-editable';
    nameSpan.title = `key: ${s.value}`;
    nameSpan.textContent = s.label;
    nameSpan.addEventListener('blur', e => {
      const v = e.target.textContent.trim();
      if (v && v !== arr[i].label) { arr[i].label = v; save(); onChanged(); }
    });
    nameSpan.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

    const del = document.createElement('button');
    del.className = 'btn-icon'; del.title = 'Remove'; del.textContent = '🗑️';
    del.addEventListener('click', () => { arr.splice(i,1); save(); onChanged(); });

    item.appendChild(dot);
    item.appendChild(colorIn);
    item.appendChild(nameSpan);
    item.appendChild(del);
    el.appendChild(item);
  });
}

document.getElementById('btnAddProcessor').addEventListener('click', () => {
  const val = document.getElementById('newProcessorInput').value.trim();
  if (!val || processors.includes(val)) return;
  processors.push(val); saveProcessors();
  document.getElementById('newProcessorInput').value = '';
  renderConfigLists(); rebuildHeaders();
});
document.getElementById('newProcessorInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnAddProcessor').click();
});

document.getElementById('btnAddStatus').addEventListener('click', () => {
  const label = document.getElementById('newStatusInput').value.trim();
  if (!label) return;
  const color = document.getElementById('newStatusColor').value;
  ticketStatuses.push({label, color}); saveStatuses();
  document.getElementById('newStatusInput').value = '';
  renderConfigLists(); renderTable();
});

document.getElementById('btnAddUserStatus').addEventListener('click', () => {
  const label = document.getElementById('newUserStatusInput').value.trim();
  if (!label) return;
  const color = document.getElementById('newUserStatusColor').value;
  const value = label.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/__+/g,'_');
  userStatuses.push({value, label, color}); saveUserStatuses();
  document.getElementById('newUserStatusInput').value = '';
  renderConfigLists(); rebuildHeaders(); renderTable();
});

document.getElementById('btnAddValidation').addEventListener('click', () => {
  const label = document.getElementById('newValidationInput').value.trim();
  if (!label) return;
  const color = document.getElementById('newValidationColor').value;
  const value = label.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/__+/g,'_');
  validations.push({value, label, color}); saveValidations();
  document.getElementById('newValidationInput').value = '';
  renderConfigLists(); rebuildHeaders(); renderTable();
});

document.getElementById('btnAddCategory').addEventListener('click', () => {
  const label = document.getElementById('newCategoryInput').value.trim();
  if (!label) return;
  const color = document.getElementById('newCategoryColor').value;
  const value = label.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/__+/g,'_');
  categories.push({value, label, color}); saveCategories();
  document.getElementById('newCategoryInput').value = '';
  renderConfigLists(); rebuildHeaders(); renderTable();
});

// ── Select builders ───────────────────────────────────────────────────────────
function buildSimpleSelect(options, current, cls) {
  const sel = document.createElement('select');
  sel.className = cls || 'inline-select';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}
function buildProcessorSelect(current, cls) {
  const sel = document.createElement('select');
  sel.className = cls || 'inline-select';
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '— Assign —';
  if (!current) blank.selected = true;
  sel.appendChild(blank);
  processors.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    if (p === current) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}
function buildTicketStatusSelect(current) {
  const sel = document.createElement('select');
  sel.className = 'inline-select';
  if (current && !ticketStatuses.find(s => s.label === current)) {
    const opt = document.createElement('option');
    opt.value = current; opt.textContent = current; opt.selected = true;
    sel.appendChild(opt);
  }
  ticketStatuses.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.label; opt.textContent = s.label;
    if (s.label === current) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

// ── Column definitions ────────────────────────────────────────────────────────
const COLUMNS = [
  { field: 'id',           label: 'Ticket ID',  filter: 'text' },
  { field: 'priority',     label: 'Priority',   filter: 'select-priority' },
  { field: 'subject',      label: 'Subject',    filter: 'text' },
  { field: 'ticketStatus', label: 'T. Status',  filter: 'text' },
  { field: 'comment',      label: 'Comment',    filter: 'text' },
  { field: 'processor',    label: 'Processor',  filter: 'select-processor' },
  { field: 'category',     label: 'Cat.',       filter: 'select-category' },
  { field: 'prepStart',    label: 'Prep Start', filter: 'text' },
  { field: 'execStart',    label: 'Exec Start', filter: 'text' },
  { field: 'userStatus',   label: 'My Status',  filter: 'select-userstatus' },
  { field: 'validation',   label: 'Validation', filter: 'select-validation' },
  { field: '_del',         label: '',           filter: 'none' },
];

function buildHeaderCell(col) {
  const gh = document.createElement('div');
  gh.className = 'gh'; gh.dataset.col = col.field;
  const lbl = document.createElement('span');
  lbl.className = 'gh-label'; lbl.textContent = col.label;
  gh.appendChild(lbl);
  if (col.filter === 'none') return gh;

  if (col.filter === 'text') {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'col-filter'; inp.placeholder = '…';
    inp.value = colFilters[col.field] || '';
    inp.addEventListener('input', e => { colFilters[col.field] = e.target.value.toLowerCase(); renderTable(); });
    gh.appendChild(inp);
  } else if (col.filter === 'select-priority') {
    const sel = document.createElement('select'); sel.className = 'col-filter';
    [['','All'],['Very High','Very High'],['High','High'],['Medium','Medium'],['Low','Low']]
      .forEach(([v,l]) => { const o = document.createElement('option'); o.value=v; o.textContent=l; if(v===colFilters[col.field])o.selected=true; sel.appendChild(o); });
    sel.addEventListener('change', e => { colFilters[col.field]=e.target.value; renderTable(); });
    gh.appendChild(sel);
  } else if (col.filter === 'select-processor') {
    const sel = buildProcessorSelect(colFilters[col.field], 'col-filter');
    sel.options[0].textContent = 'All';
    sel.addEventListener('change', e => { colFilters[col.field]=e.target.value; renderTable(); });
    gh.appendChild(sel);
  } else if (col.filter === 'select-userstatus') {
    const sel = document.createElement('select'); sel.className = 'col-filter';
    const all = document.createElement('option'); all.value=''; all.textContent='All'; if(!colFilters[col.field])all.selected=true; sel.appendChild(all);
    userStatuses.forEach(s => { const o=document.createElement('option'); o.value=s.value; o.textContent=s.label; if(s.value===colFilters[col.field])o.selected=true; sel.appendChild(o); });
    sel.addEventListener('change', e => { colFilters[col.field]=e.target.value; renderTable(); });
    gh.appendChild(sel);
  } else if (col.filter === 'select-category') {
    const sel = document.createElement('select'); sel.className = 'col-filter';
    const allOpt = document.createElement('option'); allOpt.value=''; allOpt.textContent='All'; if(!colFilters[col.field])allOpt.selected=true; sel.appendChild(allOpt);
    categories.forEach(c => { const o=document.createElement('option'); o.value=c.value; o.textContent=c.label; if(c.value===colFilters[col.field])o.selected=true; sel.appendChild(o); });
    sel.addEventListener('change', e => { colFilters[col.field]=e.target.value; renderTable(); });
    gh.appendChild(sel);
  } else if (col.filter === 'select-validation') {
    const sel = document.createElement('select'); sel.className = 'col-filter';
    const all = document.createElement('option'); all.value=''; all.textContent='All'; if(!colFilters[col.field])all.selected=true; sel.appendChild(all);
    validations.forEach(s => { const o=document.createElement('option'); o.value=s.value; o.textContent=s.label; if(s.value===colFilters[col.field])o.selected=true; sel.appendChild(o); });
    sel.addEventListener('change', e => { colFilters[col.field]=e.target.value; renderTable(); });
    gh.appendChild(sel);
  }
  return gh;
}

function buildHeaders() {
  const grid = document.getElementById('ticketGrid');
  grid.querySelectorAll('.gh').forEach(h => h.remove());
  const first = grid.firstChild;
  COLUMNS.forEach(col => grid.insertBefore(buildHeaderCell(col), first));
}
function rebuildHeaders() { buildHeaders(); }

// ── Filters ───────────────────────────────────────────────────────────────────
function applyFilters(tickets) {
  return tickets.filter(t => {
    for (const col of COLUMNS) {
      const fv = colFilters[col.field];
      if (!fv) continue;
      const tv = (t[col.field] || '').toLowerCase();
      if (col.filter === 'text') { if (!tv.includes(fv)) return false; }
      else { if (tv !== fv.toLowerCase()) return false; }
    }
    return true;
  });
}

function escHtml(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Render table ──────────────────────────────────────────────────────────────
function renderTable() {
  const grid = document.getElementById('ticketGrid');
  const visible = applyFilters(allTickets);
  document.getElementById('ticketCount').textContent = `${visible.length} of ${allTickets.length} tickets`;
  grid.querySelectorAll('.gc, .empty-state').forEach(c => c.remove());

  if (!visible.length) {
    const emp = document.createElement('div');
    emp.className = 'empty-state';
    emp.textContent = allTickets.length === 0
      ? 'No tickets loaded — paste a handover or add one manually.'
      : 'No tickets match the current filters.';
    grid.appendChild(emp);
    return;
  }

  visible.forEach(t => {
    const priKey = PRI_CLASS[t.priority] || 'none';
    const cells = [];

    const c1 = document.createElement('div');
    c1.className = `gc pri-bar-${priKey}`;
    const link = document.createElement('a');
    link.className = 'ticket-link'; link.href = '#'; link.textContent = t.id;
    link.addEventListener('click', e => {
      e.preventDefault();
      window.open(`https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id.trim())}`, '_blank');
    });
    c1.appendChild(link); cells.push(c1);

    const c2 = document.createElement('div'); c2.className = 'gc';
    if (t.priority) {
      const badge = document.createElement('span');
      badge.className = `badge-pri badge-${priKey}`; badge.textContent = t.priority;
      c2.appendChild(badge);
    } else { c2.textContent = '—'; }
    cells.push(c2);

    const c3 = document.createElement('div'); c3.className = 'gc top';
    const wrap = document.createElement('div'); wrap.className = 'subj-wrap';
    const st = document.createElement('span'); st.className='subj-text'; st.title=t.subject||''; st.textContent=t.subject||'—';
    wrap.appendChild(st);
    if (t.ctRdy) { const ct=document.createElement('span'); ct.className='ct-rdy'; ct.textContent=`⏰ ${t.ctRdy}`; wrap.appendChild(ct); }
    c3.appendChild(wrap); cells.push(c3);

    const c4 = document.createElement('div'); c4.className = 'gc';
    const tsSel = buildTicketStatusSelect(t.ticketStatus);
    const tsMatch = ticketStatuses.find(s => s.label === t.ticketStatus);
    if (tsMatch) { tsSel.style.borderColor = tsMatch.color; tsSel.style.color = tsMatch.color; }
    tsSel.addEventListener('change', e => {
      const m = ticketStatuses.find(s => s.label === e.target.value);
      tsSel.style.borderColor = m ? m.color : ''; tsSel.style.color = m ? m.color : '';
      patchTicket(t.id, {ticketStatus: e.target.value});
    });
    c4.appendChild(tsSel); cells.push(c4);

    const c5 = document.createElement('div'); c5.className = 'gc top';
    c5.title = (t.comment||'') + (t.notes ? '\n---\n'+t.notes : '');
    const cw = document.createElement('div'); cw.className = 'subj-wrap';
    const cx = document.createElement('span'); cx.className='subj-text'; cx.textContent=t.comment||'—';
    cw.appendChild(cx);
    if (t.notes) {
      const ns = document.createElement('span');
      ns.style.cssText='color:#aaa;font-size:9px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      ns.textContent=t.notes; cw.appendChild(ns);
    }
    c5.appendChild(cw); cells.push(c5);

    const c6 = document.createElement('div'); c6.className = 'gc';
    const pSel = buildProcessorSelect(t.processor);
    pSel.addEventListener('change', e => patchTicket(t.id, {processor: e.target.value}));
    c6.appendChild(pSel); cells.push(c6);

    const c7 = document.createElement('div'); c7.className = 'gc';
    const catSel = document.createElement('select'); catSel.className='inline-input';
    const catEmpty = document.createElement('option'); catEmpty.value=''; catEmpty.textContent='—'; catSel.appendChild(catEmpty);
    categories.forEach(c => {
      const o = document.createElement('option'); o.value=c.value; o.textContent=c.label;
      if((t.category||'')==c.value) o.selected=true; catSel.appendChild(o);
    });
    catSel.addEventListener('change', e => patchTicket(t.id, {category: e.target.value}));
    c7.appendChild(catSel); cells.push(c7);

    cells.push(makeDateCell(t, 'prepStart', 'PS'));
    cells.push(makeDateCell(t, 'execStart', 'ES'));

    const c10 = document.createElement('div'); c10.className = 'gc';
    const uSel = buildSimpleSelect(userStatuses, t.userStatus || (userStatuses[0]||{value:''}).value);
    const uMatch = userStatuses.find(s => s.value === (t.userStatus || (userStatuses[0]||{}).value));
    if (uMatch) { uSel.style.borderColor = uMatch.color; uSel.style.color = uMatch.color; }
    uSel.addEventListener('change', e => {
      const m = userStatuses.find(s => s.value === e.target.value);
      uSel.style.borderColor = m ? m.color : ''; uSel.style.color = m ? m.color : '';
      patchTicket(t.id, {userStatus: e.target.value});
    });
    c10.appendChild(uSel); cells.push(c10);

    const c11 = document.createElement('div'); c11.className = 'gc';
    const vSel = buildSimpleSelect(validations, t.validation || (validations[0]||{value:''}).value);
    const vMatch = validations.find(s => s.value === (t.validation || (validations[0]||{}).value));
    if (vMatch) { vSel.style.borderColor = vMatch.color; vSel.style.color = vMatch.color; }
    vSel.addEventListener('change', e => {
      const m = validations.find(s => s.value === e.target.value);
      vSel.style.borderColor = m ? m.color : ''; vSel.style.color = m ? m.color : '';
      patchTicket(t.id, {validation: e.target.value});
    });
    c11.appendChild(vSel); cells.push(c11);

    const c12 = document.createElement('div'); c12.className='gc'; c12.style.justifyContent='center';
    const del = document.createElement('button'); del.className='btn-icon'; del.title='Delete'; del.textContent='🗑️';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ticket ${t.id}?`)) return;
      await fetch(`/api/${currentArea}/tickets/${t.id}`, {method:'DELETE'});
    });
    c12.appendChild(del); cells.push(c12);

    cells.forEach(c => {
      c.dataset.row = `row-${t.id}`;
      c.addEventListener('mouseenter', () => cells.forEach(x => x.classList.add('row-hover')));
      c.addEventListener('mouseleave', () => cells.forEach(x => x.classList.remove('row-hover')));
      grid.appendChild(c);
    });
  });
}

// ── Date cell ─────────────────────────────────────────────────────────────────
function makeDateCell(t, field, prefix) {
  const cell = document.createElement('div');
  cell.className = 'gc date-cell';
  const val = t[field] || '';
  const cls = getDateClass(val);
  if (cls) cell.classList.add(cls);
  cell.dataset.datefield = field;
  cell.dataset.datevalue = val;

  const lbl = document.createElement('span');
  lbl.className = 'date-text';
  lbl.textContent = val ? formatShortDate(val, prefix) : `— ${prefix} —`;
  lbl.title = 'Click to pick date/time';

  lbl.addEventListener('click', e => {
    e.stopPropagation();
    TDP.open(cell, cell.dataset.datevalue, async newVal => {
      await patchTicket(t.id, { [field]: newVal });
      cell.dataset.datevalue = newVal;
      cell.className = cell.className.replace(/\bdate-\w+/g, '').trim();
      if (!cell.classList.contains('gc')) cell.classList.add('gc');
      if (!cell.classList.contains('date-cell')) cell.classList.add('date-cell');
      const nc = getDateClass(newVal);
      if (nc) cell.classList.add(nc);
      lbl.textContent = newVal ? formatShortDate(newVal, prefix) : `— ${prefix} —`;
    });
  });

  cell.appendChild(lbl);
  return cell;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function patchTicket(id, updates) {
  await fetch(`/api/${currentArea}/tickets/${id}`, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(updates)
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, color) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position:'fixed', bottom:'20px', right:'20px',
    background: color || '#2E7D32', color:'#fff', padding:'8px 16px',
    borderRadius:'4px', fontSize:'12px', zIndex:'9999',
    boxShadow:'0 2px 8px rgba(0,0,0,0.4)'
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
buildHeaders();
renderConfigLists();

// ── Shift columns ─────────────────────────────────────────────────────────────
const SHIFT_COLUMNS = [
  { field: 'id',           label: 'Ticket ID' },
  { field: 'serviceExecId',label: 'Exec ID'   },
  { field: 'subject',      label: 'Subject'   },
  { field: 'priority',     label: 'Pri.'      },
  { field: 'ticketStatus', label: 'Status'    },
  { field: 'processor',    label: 'Processor' },
  { field: 'category',     label: 'Cat.'      },
  { field: 'prepStart',    label: 'Prep Start'},
  { field: 'execStart',    label: 'Exec Start'},
  { field: '_del',         label: ''          },
];

const POOL_COLUMNS = [
  { field: 'id',           label: 'Ticket ID' },
  { field: 'serviceExecId',label: 'Exec ID'   },
  { field: 'subject',      label: 'Subject'   },
  { field: 'priority',     label: 'Pri.'      },
  { field: 'customer',     label: 'Customer'  },
  { field: 'prepStart',    label: 'Prep Start'},
  { field: 'execStart',    label: 'Exec Start'},
  { field: '_add',         label: '+Turno'    },
];

function buildShiftHeaders() {
  const grid = document.getElementById('shiftGrid');
  grid.querySelectorAll('.gh').forEach(h => h.remove());
  const first = grid.firstChild;
  SHIFT_COLUMNS.forEach(col => {
    const gh = document.createElement('div'); gh.className = 'gh';
    const lbl = document.createElement('span'); lbl.className = 'gh-label'; lbl.textContent = col.label;
    gh.appendChild(lbl); grid.insertBefore(gh, first);
  });
}

function buildPoolHeaders() {
  const grid = document.getElementById('poolGrid');
  grid.querySelectorAll('.gh').forEach(h => h.remove());
  const first = grid.firstChild;
  POOL_COLUMNS.forEach(col => {
    const gh = document.createElement('div'); gh.className = 'gh';
    const lbl = document.createElement('span'); lbl.className = 'gh-label'; lbl.textContent = col.label;
    gh.appendChild(lbl); grid.insertBefore(gh, first);
  });
}

// ── Shift table render ────────────────────────────────────────────────────────
function renderShiftTable() {
  const grid = document.getElementById('shiftGrid');
  const count = document.getElementById('shiftTicketCount');
  grid.querySelectorAll('.gc, .empty-state').forEach(c => c.remove());
  count.textContent = `${shiftTickets.length} ticket${shiftTickets.length !== 1 ? 's' : ''}`;

  if (!shiftTickets.length) {
    const emp = document.createElement('div'); emp.className = 'empty-state';
    emp.textContent = 'No tickets en turno — carga el HO o agrega manualmente.';
    grid.appendChild(emp); return;
  }

  shiftTickets.forEach(t => {
    const priKey = PRI_CLASS[t.priority] || 'none';
    const cells = [];

    // ID
    const c1 = document.createElement('div'); c1.className = `gc pri-bar-${priKey}`;
    const link = document.createElement('a'); link.className = 'ticket-link'; link.href='#'; link.textContent=t.id;
    link.addEventListener('click', e => { e.preventDefault(); window.open(`https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id.trim())}`,'_blank'); });
    c1.appendChild(link); cells.push(c1);

    // Service Exec ID
    const c2 = document.createElement('div'); c2.className='gc';
    const execIn = document.createElement('input'); execIn.className='inline-input'; execIn.value=t.serviceExecId||''; execIn.style.width='100%';
    execIn.addEventListener('change', e => patchShiftTicket(t.id, {serviceExecId: e.target.value}));
    c2.appendChild(execIn); cells.push(c2);

    // Subject
    const c3 = document.createElement('div'); c3.className='gc top';
    const sw = document.createElement('div'); sw.className='subj-wrap';
    const st = document.createElement('span'); st.className='subj-text'; st.title=t.subject||''; st.textContent=t.subject||'—';
    sw.appendChild(st);
    if (t.ctRdy) { const ct=document.createElement('span'); ct.className='ct-rdy'; ct.textContent=`⏰ ${t.ctRdy}`; sw.appendChild(ct); }
    c3.appendChild(sw); cells.push(c3);

    // Priority
    const c4 = document.createElement('div'); c4.className='gc';
    if (t.priority) { const badge=document.createElement('span'); badge.className=`badge-pri badge-${priKey}`; badge.textContent=t.priority; c4.appendChild(badge); }
    else c4.textContent='—';
    cells.push(c4);

    // Status
    const c5 = document.createElement('div'); c5.className='gc';
    const tsSel = buildTicketStatusSelect(t.ticketStatus);
    const tsMatch = ticketStatuses.find(s => s.label===t.ticketStatus);
    if (tsMatch) { tsSel.style.borderColor=tsMatch.color; tsSel.style.color=tsMatch.color; }
    tsSel.addEventListener('change', e => {
      const m=ticketStatuses.find(s=>s.label===e.target.value);
      tsSel.style.borderColor=m?m.color:''; tsSel.style.color=m?m.color:'';
      patchShiftTicket(t.id,{ticketStatus:e.target.value});
    });
    c5.appendChild(tsSel); cells.push(c5);

    // Processor
    const c6 = document.createElement('div'); c6.className='gc';
    const pSel = buildProcessorSelect(t.processor);
    pSel.addEventListener('change', e => patchShiftTicket(t.id,{processor:e.target.value}));
    c6.appendChild(pSel); cells.push(c6);

    // Category
    const c7 = document.createElement('div'); c7.className='gc';
    const catSel = document.createElement('select'); catSel.className='inline-input';
    const catEmpty = document.createElement('option'); catEmpty.value=''; catEmpty.textContent='—'; catSel.appendChild(catEmpty);
    categories.forEach(c => {
      const o=document.createElement('option'); o.value=c.value; o.textContent=c.label;
      if((t.category||'')==c.value) o.selected=true; catSel.appendChild(o);
    });
    catSel.addEventListener('change', e => patchShiftTicket(t.id,{category:e.target.value}));
    c7.appendChild(catSel); cells.push(c7);

    // Prep Start
    cells.push(makeShiftDateCell(t, 'prepStart', 'PS'));
    // Exec Start
    cells.push(makeShiftDateCell(t, 'execStart', 'ES'));

    // Delete
    const c10 = document.createElement('div'); c10.className='gc'; c10.style.justifyContent='center';
    const del = document.createElement('button'); del.className='btn-icon'; del.title='Remove from shift'; del.textContent='🗑️';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove ${t.id} from shift?`)) return;
      await fetch(`/api/shift/tickets/${t.id}`,{method:'DELETE'});
    });
    c10.appendChild(del); cells.push(c10);

    cells.forEach(c => {
      c.dataset.row=`shift-row-${t.id}`;
      c.addEventListener('mouseenter', () => cells.forEach(x=>x.classList.add('row-hover')));
      c.addEventListener('mouseleave', () => cells.forEach(x=>x.classList.remove('row-hover')));
      grid.appendChild(c);
    });
  });
}

function makeShiftDateCell(t, field, prefix) {
  const cell = document.createElement('div'); cell.className='gc date-cell';
  const val = t[field]||'';
  const cls = getDateClass(val);
  if (cls) cell.classList.add(cls);
  cell.dataset.datefield=field; cell.dataset.datevalue=val;
  const lbl = document.createElement('span'); lbl.className='date-text';
  lbl.textContent = val ? formatShortDate(val, prefix) : `— ${prefix} —`;
  lbl.title='Click to pick date/time';
  lbl.addEventListener('click', e => {
    e.stopPropagation();
    TDP.open(cell, cell.dataset.datevalue, async newVal => {
      await patchShiftTicket(t.id,{[field]:newVal});
      cell.dataset.datevalue=newVal;
      cell.className=cell.className.replace(/\bdate-\w+/g,'').trim();
      if (!cell.classList.contains('gc')) cell.classList.add('gc');
      if (!cell.classList.contains('date-cell')) cell.classList.add('date-cell');
      const nc=getDateClass(newVal); if(nc) cell.classList.add(nc);
      lbl.textContent=newVal ? formatShortDate(newVal,prefix) : `— ${prefix} —`;
    });
  });
  cell.appendChild(lbl); return cell;
}

async function patchShiftTicket(id, updates) {
  await fetch(`/api/shift/tickets/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)});
}

// ── Pool table render ─────────────────────────────────────────────────────────
function renderPoolTable() {
  const grid = document.getElementById('poolGrid');
  grid.querySelectorAll('.gc, .empty-state').forEach(c => c.remove());
  document.getElementById('poolCount').textContent = `${poolTickets.length} ticket${poolTickets.length!==1?'s':''} in pool`;

  if (!poolTickets.length) {
    const emp = document.createElement('div'); emp.className='empty-state';
    emp.textContent='Pool vacío — sube un XLSX con los tickets del día.';
    grid.appendChild(emp); return;
  }

  poolTickets.forEach(t => {
    const cells = [];

    const c1 = document.createElement('div'); c1.className='gc';
    const link = document.createElement('a'); link.className='ticket-link'; link.href='#'; link.textContent=t.id;
    link.addEventListener('click', e=>{e.preventDefault();window.open(`https://spc.ondemand.com/open?ticket=${encodeURIComponent(t.id.trim())}`,'_blank');});
    c1.appendChild(link); cells.push(c1);

    const c2 = document.createElement('div'); c2.className='gc';
    c2.textContent=t.serviceExecId||'—'; cells.push(c2);

    const c3 = document.createElement('div'); c3.className='gc top';
    const sw=document.createElement('div'); sw.className='subj-wrap';
    const st=document.createElement('span'); st.className='subj-text'; st.title=t.subject||''; st.textContent=t.subject||'—';
    sw.appendChild(st); c3.appendChild(sw); cells.push(c3);

    const c4 = document.createElement('div'); c4.className='gc';
    const priKey=PRI_CLASS[t.priority]||'none';
    if (t.priority) { const badge=document.createElement('span'); badge.className=`badge-pri badge-${priKey}`; badge.textContent=t.priority; c4.appendChild(badge); }
    else c4.textContent='—'; cells.push(c4);

    const c5 = document.createElement('div'); c5.className='gc';
    c5.textContent=t.customer||'—'; cells.push(c5);

    cells.push(makePoolDateCell(t,'prepStart','PS'));
    cells.push(makePoolDateCell(t,'execStart','ES'));

    // + Turno button
    const c8=document.createElement('div'); c8.className='gc'; c8.style.justifyContent='center';
    const btn=document.createElement('button'); btn.className='btn'; btn.style.cssText='background:#7B1FA2;font-size:10px;padding:2px 6px;';
    btn.textContent='+'; btn.title='Add to shift';
    const inShift = shiftTickets.some(s=>s.id===t.id);
    if (inShift) { btn.style.background='#2E7D32'; btn.textContent='✓'; btn.title='Already in shift'; }
    btn.addEventListener('click', async () => {
      if (inShift) return;
      await fetch('/api/shift/tickets/single',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:t.id})});
      showToast(`${t.id} added to turno`,'#7B1FA2');
    });
    c8.appendChild(btn); cells.push(c8);

    cells.forEach(c=>{
      c.dataset.row=`pool-row-${t.id}`;
      c.addEventListener('mouseenter',()=>cells.forEach(x=>x.classList.add('row-hover')));
      c.addEventListener('mouseleave',()=>cells.forEach(x=>x.classList.remove('row-hover')));
      grid.appendChild(c);
    });
  });
}

function makePoolDateCell(t, field, prefix) {
  const cell=document.createElement('div'); cell.className='gc date-cell';
  const val=t[field]||'';
  const cls=getDateClass(val); if(cls) cell.classList.add(cls);
  const lbl=document.createElement('span'); lbl.className='date-text';
  lbl.textContent=val ? formatShortDate(val,prefix) : `— ${prefix} —`;
  cell.appendChild(lbl); return cell;
}

// ── Shift toolbar handlers ────────────────────────────────────────────────────
document.getElementById('btnShiftLoadHO').addEventListener('click', () => {
  const p=document.getElementById('shiftHoPanel');
  if (p.classList.contains('visible')) { closeAllPanels(); return; }
  closeAllPanels(); openPanel('shiftHoPanel');
});
document.getElementById('btnShiftHoCancel').addEventListener('click', () => {
  closeAllPanels(); document.getElementById('shiftHoArea').value='';
});
const shiftHoArea = document.getElementById('shiftHoArea');
shiftHoArea.addEventListener('paste', e => {
  e.preventDefault();
  shiftHoArea.value=(e.clipboardData||window.clipboardData).getData('text');
});
document.getElementById('btnShiftHoLoad').addEventListener('click', async () => {
  const raw=shiftHoArea.value.trim();
  if (!raw) { alert('Nothing to load.'); return; }
  const res=await fetch('/api/shift/load-ho',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({raw})});
  const data=await res.json();
  if (!res.ok) { alert(data.error||'Error'); return; }
  shiftHoArea.value=''; closeAllPanels();
  showToast(`${data.added} added, ${data.merged} merged into turno`,'#7B1FA2');
});

document.getElementById('btnShiftLoadExec').addEventListener('click', async () => {
  const res=await fetch('/api/shift/load-executions',{method:'POST'});
  const data=await res.json();
  if (!res.ok) { alert(data.error||'Error'); return; }
  showToast(`${data.added} execuciones added to turno (window ${data.window?.from?.slice(0,16)} – ${data.window?.to?.slice(0,16)} UTC)`,'#7B1FA2');
});

document.getElementById('btnShiftClear').addEventListener('click', async () => {
  if (!confirm('Clear all tickets from turno?')) return;
  await fetch('/api/shift/tickets',{method:'DELETE'});
});

// Shift: Add ticket
document.getElementById('btnShiftAddToggle').addEventListener('click', () => {
  const p=document.getElementById('shiftAddPanel');
  if (p.classList.contains('visible')) { closeAllPanels(); return; }
  // sync category select
  const sel=document.getElementById('shiftAddCategory');
  sel.innerHTML='<option value="">— Select —</option>';
  categories.forEach(c=>{const o=document.createElement('option');o.value=c.value;o.textContent=c.label;sel.appendChild(o);});
  closeAllPanels(); openPanel('shiftAddPanel');
});
document.getElementById('btnShiftAddCancel').addEventListener('click', () => { closeAllPanels(); clearShiftAddForm(); });
document.getElementById('btnShiftAddSave').addEventListener('click', async () => {
  const id=document.getElementById('shiftAddId').value.trim();
  if (!id) { alert('Ticket ID is required.'); return; }
  const body={
    id, priority:document.getElementById('shiftAddPriority').value,
    subject:document.getElementById('shiftAddSubject').value.trim(),
    category:document.getElementById('shiftAddCategory').value,
    processor:document.getElementById('shiftAddProcessor').value.trim(),
    prepStart:document.getElementById('shiftAddPrepStart').value,
    execStart:document.getElementById('shiftAddExecStart').value,
    notes:document.getElementById('shiftAddNotes').value.trim(),
  };
  const res=await fetch('/api/shift/tickets/single',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json();
  if (!res.ok) { alert(data.error||'Error'); return; }
  clearShiftAddForm(); closeAllPanels(); showToast('Ticket added to turno','#7B1FA2');
});
function clearShiftAddForm() {
  ['shiftAddId','shiftAddSubject','shiftAddProcessor','shiftAddPrepStart','shiftAddExecStart','shiftAddNotes']
    .forEach(id=>{ document.getElementById(id).value=''; });
  document.getElementById('shiftAddPriority').value='';
  document.getElementById('shiftAddCategory').value='';
}

// Generate HO
document.getElementById('btnShiftGenerateHO').addEventListener('click', async () => {
  const res=await fetch('/api/shift/generate-ho');
  const data=await res.json();
  if (!res.ok) { alert(data.error||'Error'); return; }
  document.getElementById('hoOutputText').value=data.text;
  closeAllPanels(); openPanel('hoOutputPanel');
});
document.getElementById('btnHoOutputClose').addEventListener('click', closeAllPanels);
document.getElementById('btnHoOutputCopy').addEventListener('click', () => {
  const ta=document.getElementById('hoOutputText');
  ta.select();
  document.execCommand('copy');
  showToast('Handover copiado al clipboard','#2E7D32');
});

// ── Pool toolbar handlers ─────────────────────────────────────────────────────
document.getElementById('poolFileInput').addEventListener('change', async e => {
  const file=e.target.files[0]; if (!file) return;
  const fd=new FormData(); fd.append('file',file);
  const res=await fetch('/api/pool/upload',{method:'POST',body:fd});
  const data=await res.json();
  e.target.value='';
  if (!res.ok) { alert(data.error||'Upload failed'); return; }
  showToast(`Pool: ${data.added} updated/added, ${data.skipped} skipped`,'#00838F');
});

document.getElementById('btnPoolClear').addEventListener('click', async () => {
  if (!confirm('Clear all tickets from pool?')) return;
  await fetch('/api/pool/tickets',{method:'DELETE'});
  showToast('Pool cleared','#444');
});

// ── Init shift/pool headers ───────────────────────────────────────────────────
buildShiftHeaders();
buildPoolHeaders();
