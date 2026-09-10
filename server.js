const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ticketdash.db');

const OIDC = {
  clientId:     process.env.OIDC_CLIENT_ID     || 'P4XIClfTldgxOzQSzcALkkso8BWq67y0HqEF3Ihv',
  clientSecret: process.env.OIDC_CLIENT_SECRET || 'Z85zEJPdD5mHPcaTU7yHX4tP0ftlriL0QKFnW5H8D5Aw8q1KbTozHTiCuXkhNj22e80SmJ0ots8I8GkvUPDGA1xhHa5FTYvn1R6w1TraIvHqlhNrIswiT6R3MayuVY8h',
  authorizeUrl: process.env.OIDC_AUTHORIZE_URL || 'http://localhost:9000/application/o/authorize/',
  tokenUrl:     process.env.OIDC_TOKEN_URL     || 'http://localhost:9000/application/o/token/',
  userinfoUrl:  process.env.OIDC_USERINFO_URL  || 'http://localhost:9000/application/o/userinfo/',
  redirectUri:  process.env.OIDC_REDIRECT_URI  || 'http://localhost:3000/auth/callback',
  sessionSecret: process.env.SESSION_SECRET    || 'ticketmaster-session-secret-change-in-prod',
};

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH);

// ── Schemas ───────────────────────────────────────────────────────────────────
const TICKET_SCHEMA = `(
  id           TEXT PRIMARY KEY,
  priority     TEXT DEFAULT '',
  subject      TEXT DEFAULT '',
  ticketStatus TEXT DEFAULT '',
  comment      TEXT DEFAULT '',
  processor    TEXT DEFAULT '',
  category     TEXT DEFAULT '',
  execStart    TEXT DEFAULT '',
  ctRdy        TEXT DEFAULT '',
  userStatus   TEXT DEFAULT 'new',
  validation   TEXT DEFAULT 'pending',
  prepStart    TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  createdAt    TEXT DEFAULT (datetime('now')),
  updatedAt    TEXT DEFAULT (datetime('now'))
)`;

db.serialize(() => {
  // Existing ticket tables — untouched
  db.run(`CREATE TABLE IF NOT EXISTS tickets ${TICKET_SCHEMA}`);
  db.run(`CREATE TABLE IF NOT EXISTS tickets_merge ${TICKET_SCHEMA}`);
  db.run(`ALTER TABLE tickets ADD COLUMN validation TEXT DEFAULT 'pending'`, () => {});
  db.run(`ALTER TABLE tickets ADD COLUMN prepStart  TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE tickets_merge ADD COLUMN validation TEXT DEFAULT 'pending'`, () => {});
  db.run(`ALTER TABLE tickets_merge ADD COLUMN prepStart  TEXT DEFAULT ''`, () => {});

  // Drop old schema-less pool/shift tables and recreate with area support
  db.run(`DROP TABLE IF EXISTS pool_tickets`);
  db.run(`DROP TABLE IF EXISTS shift_tickets`);

  db.run(`CREATE TABLE IF NOT EXISTS pool_tickets (
    id            TEXT NOT NULL,
    area          TEXT NOT NULL,
    serviceExecId TEXT DEFAULT '',
    priority      TEXT DEFAULT '',
    subject       TEXT DEFAULT '',
    customer      TEXT DEFAULT '',
    ticketStatus  TEXT DEFAULT '',
    comment       TEXT DEFAULT '',
    processor     TEXT DEFAULT '',
    category      TEXT DEFAULT '',
    execStart     TEXT DEFAULT '',
    prepStart     TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    ctRdy         TEXT DEFAULT '',
    createdAt     TEXT DEFAULT (datetime('now')),
    updatedAt     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (id, area)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    area      TEXT NOT NULL,
    date      TEXT NOT NULL,
    label     TEXT DEFAULT '',
    status    TEXT DEFAULT 'open',
    createdAt TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS shift_tickets (
    id            TEXT NOT NULL,
    shiftId       INTEGER NOT NULL,
    area          TEXT NOT NULL,
    serviceExecId TEXT DEFAULT '',
    priority      TEXT DEFAULT '',
    subject       TEXT DEFAULT '',
    customer      TEXT DEFAULT '',
    ticketStatus  TEXT DEFAULT '',
    comment       TEXT DEFAULT '',
    processor     TEXT DEFAULT '',
    category      TEXT DEFAULT '',
    execStart     TEXT DEFAULT '',
    prepStart     TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    ctRdy         TEXT DEFAULT '',
    source        TEXT DEFAULT 'manual',
    createdAt     TEXT DEFAULT (datetime('now')),
    updatedAt     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (id, shiftId)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS change_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ticketId  TEXT NOT NULL,
    shiftId   INTEGER,
    area      TEXT NOT NULL,
    field     TEXT NOT NULL,
    oldValue  TEXT DEFAULT '',
    newValue  TEXT NOT NULL,
    changedBy TEXT NOT NULL,
    changedAt TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_change_log_ticket ON change_log (ticketId, area)`);
});

// ── DB helpers ────────────────────────────────────────────────────────────────
const ORDER_SQL = `ORDER BY CASE priority
  WHEN 'Very High' THEN 1 WHEN 'High' THEN 2
  WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, createdAt ASC`;

function getTickets(table) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM ${table} ${ORDER_SQL}`, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function getPoolTickets(area) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM pool_tickets WHERE area=? ${ORDER_SQL}`, [area], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function getShiftTickets(shiftId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM shift_tickets WHERE shiftId=? ${ORDER_SQL}`, [shiftId], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function broadcastSM()    { return getTickets('tickets').then(rows => io.emit('sm:tickets:update', rows)); }
function broadcastMerge() { return getTickets('tickets_merge').then(rows => io.emit('merge:tickets:update', rows)); }

function broadcastPool(area) {
  return getPoolTickets(area).then(rows => io.emit(`${area}:pool:update`, rows));
}

function broadcastShift(area, shiftId) {
  return Promise.all([
    new Promise(r => db.get('SELECT * FROM shifts WHERE id=?', [shiftId], (e, row) => r(row))),
    getShiftTickets(shiftId),
  ]).then(([shift, tickets]) => io.emit(`${area}:shift:update`, { shift, tickets }));
}

// ── Group / access helpers ────────────────────────────────────────────────────
function userGroups(req) { return req.session.user?.groups || []; }

function hasSMAccess(req) {
  return userGroups(req).some(x => ['sm-users','sm-leads','managers','authentik Admins'].includes(x));
}
function hasMergeAccess(req) {
  return userGroups(req).some(x => ['merge-users','merge-leads','managers','authentik Admins'].includes(x));
}
function hasAreaAccess(req, area) {
  return area === 'sm' ? hasSMAccess(req) : area === 'merge' ? hasMergeAccess(req) : false;
}

function requireSM(req, res, next)    { if (hasSMAccess(req))    return next(); res.status(403).json({ error: 'No access to SM area' }); }
function requireMerge(req, res, next) { if (hasMergeAccess(req)) return next(); res.status(403).json({ error: 'No access to Merge area' }); }
function requireArea(req, res, next)  {
  if (hasAreaAccess(req, req.params.area)) return next();
  res.status(403).json({ error: `No access to ${req.params.area} area` });
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_LONG  = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};

function extractCtRdy(subject) {
  if (!subject) return null;
  const inner = subject.match(/CT_RDY\s*[\(\[](.*?)[\)\]]/i);
  if (!inner) return null;
  let s = inner[1].replace(/\bat\b/gi, '').replace(/\.$/, '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (iso) return `${parseInt(iso[3])} ${MONTH_NAMES[parseInt(iso[2])-1]} ${iso[1]}, ${iso[4]}:${iso[5]} UTC`;
  const dot = s.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if (dot) {
    let day = parseInt(dot[1]), mon = parseInt(dot[2]);
    if (day > 12) { /* DD.MM */ } else if (mon > 12) { [day,mon]=[mon,day]; }
    return `${day} ${MONTH_NAMES[mon-1]} ${dot[3]}, ${dot[4]}:${dot[5]} UTC`;
  }
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (us) {
    let h = parseInt(us[4]);
    if (us[6].toUpperCase()==='PM' && h!==12) h+=12;
    if (us[6].toUpperCase()==='AM' && h===12) h=0;
    return `${parseInt(us[2])} ${MONTH_NAMES[parseInt(us[1])-1]} ${us[3]}, ${String(h).padStart(2,'0')}:${us[5]} UTC`;
  }
  const dash = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})\s+(\d{2}):(\d{2})/);
  if (dash) {
    let year = parseInt(dash[3]);
    if (year < 100) year += 2000;
    const monIdx = MONTH_LONG[dash[2].toLowerCase()] ?? MONTH_NAMES.indexOf(dash[2].slice(0,3));
    return `${parseInt(dash[1])} ${MONTH_NAMES[monIdx]||dash[2].slice(0,3)} ${year}, ${dash[4]}:${dash[5]} UTC`;
  }
  const full = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{2}):(\d{2})/);
  if (full) {
    const monIdx = MONTH_LONG[full[2].toLowerCase()];
    if (monIdx !== undefined) return `${parseInt(full[1])} ${MONTH_NAMES[monIdx]} ${full[3]}, ${full[4]}:${full[5]} UTC`;
  }
  return null;
}

function mtyDateString(date) {
  const mty = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  const y  = mty.getUTCFullYear();
  const mo = String(mty.getUTCMonth()+1).padStart(2,'0');
  const d  = String(mty.getUTCDate()).padStart(2,'0');
  return `${y}-${mo}-${d}`;
}

function parseXlsxDate(v) {
  if (!v) return '';
  if (v instanceof Date) { return isNaN(v) ? '' : v.toISOString().slice(0,16); }
  const s = String(v).trim();
  if (!s || s === 'Invalid Date') return '';
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0,16);

  // Format: "14 Aug 2026, 16:00 GMT-6"  or  "1 Sept 2026, 03:46 GMT-6"
  const gmtMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*GMT([+-]\d+)?/i);
  if (gmtMatch) {
    const day  = parseInt(gmtMatch[1]);
    const monRaw = gmtMatch[2].toLowerCase().slice(0,3); // "aug", "sep", etc.
    const MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mon  = MON[monRaw];
    if (mon === undefined) return s;
    const year = parseInt(gmtMatch[3]);
    const h    = parseInt(gmtMatch[4]);
    const m    = parseInt(gmtMatch[5]);
    const tzOffset = gmtMatch[6] ? parseInt(gmtMatch[6]) : 0; // e.g. -6
    // Convert local time to UTC: UTC = local - offset
    const utcMs = Date.UTC(year, mon, day, h, m) - tzOffset * 60 * 60 * 1000;
    const d = new Date(utcMs);
    return d.toISOString().slice(0,16);
  }

  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0,16);
  return s;
}

// ── Handover parser ───────────────────────────────────────────────────────────
function parseHandover(raw) {
  const PRIORITY_LABELS = new Set(['very high','high','medium','low']);
  const COLUMN_HEADERS  = new Set(['ticket id','handover category','subject','ticket status','comment']);
  const lines = raw.split(/\r\n|\n|\r|\t/).map(l => l.replace(/^"|"$/g,'').trim()).filter(Boolean);
  const tickets = [];
  let currentPriority = '';
  let i = 0;
  while (i < lines.length) {
    const lower = lines[i].toLowerCase();
    if (PRIORITY_LABELS.has(lower)) { currentPriority = lines[i]; i++; continue; }
    if (COLUMN_HEADERS.has(lower))  { i++; continue; }
    if (!/^\d{7,13}$/.test(lines[i])) { i++; continue; }
    const id       = lines[i];
    const subject  = lines[i+2] || '';
    const status   = lines[i+3] || '';
    const comment  = lines[i+4] || '';
    tickets.push({ id, priority: currentPriority, subject, ticketStatus: status, comment, ctRdy: extractCtRdy(subject) || '' });
    i += 5;
  }
  return tickets;
}

// ── Route factory for tickets area (SM / Merge) ───────────────────────────────
function makeAreaRoutes(router, table, broadcast) {
  router.get('/', async (req, res) => {
    try { res.json(await getTickets(table)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/handover', async (req, res) => {
    const { raw } = req.body;
    if (!raw) return res.status(400).json({ error: 'No raw text provided' });
    const parsed = parseHandover(raw);
    if (!parsed.length) return res.status(400).json({ error: 'No tickets found in pasted text' });
    let added = 0, skipped = 0;
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (id,priority,subject,ticketStatus,comment,ctRdy,category,userStatus) VALUES (?,?,?,?,?,?,?,'new')`);
        parsed.forEach(t => {
          stmt.run([t.id,t.priority,t.subject,t.ticketStatus,t.comment,t.ctRdy,''], function(err) {
            if (err) return;
            this.changes > 0 ? added++ : skipped++;
          });
        });
        stmt.finalize(err => err ? reject(err) : resolve());
      });
    });
    await broadcast();
    res.json({ added, skipped });
  });

  router.post('/single', async (req, res) => {
    const { id, priority, subject, ticketStatus, comment, processor, category, prepStart, execStart, ctRdy, notes } = req.body;
    if (!id || !/^\d{7,13}$/.test(id.trim())) return res.status(400).json({ error: 'Invalid ticket ID' });
    db.run(
      `INSERT OR IGNORE INTO ${table} (id,priority,subject,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,notes,userStatus) VALUES (?,?,?,?,?,?,?,?,?,?,?,'new')`,
      [id.trim(),priority||'',subject||'',ticketStatus||'',comment||'',processor||'',category||'',prepStart||'',execStart||'',ctRdy||'',notes||''],
      async (err) => { if (err) return res.status(500).json({ error: err.message }); await broadcast(); res.json({ ok: true }); }
    );
  });

  router.patch('/:id', async (req, res) => {
    const allowed = ['processor','category','execStart','prepStart','userStatus','validation','notes','ticketStatus','comment','priority'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.run(`UPDATE ${table} SET ${sets}, updatedAt=datetime('now') WHERE id=?`, [...Object.values(updates), req.params.id],
      async (err) => { if (err) return res.status(500).json({ error: err.message }); await broadcast(); res.json({ ok: true }); }
    );
  });

  router.delete('/:id', (req, res) => {
    db.run(`DELETE FROM ${table} WHERE id=?`, [req.params.id], async (err) => {
      if (err) return res.status(500).json({ error: err.message }); await broadcast(); res.json({ ok: true });
    });
  });

  router.delete('/', (req, res) => {
    db.run(`DELETE FROM ${table}`, async (err) => {
      if (err) return res.status(500).json({ error: err.message }); await broadcast(); res.json({ ok: true });
    });
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  secret: OIDC.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 },
}));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = new URL(OIDC.authorizeUrl);
  url.searchParams.set('client_id', OIDC.clientId);
  url.searchParams.set('redirect_uri', OIDC.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) return res.status(400).send('Invalid state');
  try {
    const tokenRes = await fetch(OIDC.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:OIDC.redirectUri, client_id:OIDC.clientId, client_secret:OIDC.clientSecret }),
    });
    const tokenText = await tokenRes.text();
    let tokens;
    try { tokens = JSON.parse(tokenText); } catch(e) { return res.status(500).send(`Token parse error (${tokenRes.status}): ${tokenText}`); }
    if (!tokens.access_token) return res.status(401).send('Token exchange failed: ' + JSON.stringify(tokens));
    const userRes = await fetch(OIDC.userinfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const user = await userRes.json();
    req.session.user = { name: user.name, email: user.email, sub: user.sub, groups: user.groups || [] };
    delete req.session.oauthState;
    res.redirect('/');
  } catch (e) { res.status(500).send('Auth error: ' + e.message); }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect(`${process.env.OIDC_AUTHORIZE_URL || 'http://localhost:9000/application/o/authorize/'}`
    .replace('/application/o/authorize/', '/application/o/ticketmastersrhunter360/end-session/'));
});

app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

app.get('/api/version', (req, res) => {
  const { execSync } = require('child_process');
  let hash = 'unknown';
  try { hash = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
  res.json({ version: hash });
});

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/auth/login');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth/area', (req, res) => {
  res.json({ sm: hasSMAccess(req), merge: hasMergeAccess(req) });
});

// ── Tickets routes (SM / Merge) ───────────────────────────────────────────────
const smRouter = express.Router();
makeAreaRoutes(smRouter, 'tickets', broadcastSM);
app.use('/api/sm/tickets', requireSM, smRouter);

const mergeRouter = express.Router();
makeAreaRoutes(mergeRouter, 'tickets_merge', broadcastMerge);
app.use('/api/merge/tickets', requireMerge, mergeRouter);

// ── Pool routes (:area = sm | merge) ─────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const COL_MAP = {
  ticketid:'id', ticket:'id',
  serviceexecution:'serviceExecId', serviceexecutionid:'serviceExecId', sidcid:'serviceExecId',
  subject:'subject', title:'subject', ticketsubject:'subject',
  customer:'customer',
  prepstart:'prepStart', preparationstart:'prepStart', execstart:'execStart', executionstart:'execStart',
  priority:'priority',
  ticketstatus:'ticketStatus', status:'ticketStatus',
  comment:'comment', comments:'comment',
  processor:'processor',
};
function normCol(k) { return String(k).toLowerCase().replace(/[\s_-]/g,''); }

app.get('/api/:area/pool', requireArea, async (req, res) => {
  try { res.json(await getPoolTickets(req.params.area)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/:area/pool/upload', requireArea, upload.single('file'), async (req, res) => {
  const area = req.params.area;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    let added = 0, skipped = 0;
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(`
          INSERT INTO pool_tickets (id,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,prepStart,execStart,ctRdy)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id,area) DO UPDATE SET
            serviceExecId=excluded.serviceExecId, subject=excluded.subject,
            customer=excluded.customer, prepStart=excluded.prepStart,
            execStart=excluded.execStart, priority=excluded.priority,
            ticketStatus=excluded.ticketStatus, updatedAt=datetime('now')
        `);
        rows.forEach(row => {
          const t = {};
          Object.entries(row).forEach(([k,v]) => { const m=COL_MAP[normCol(k)]; if(m) t[m]=v!=null?String(v).trim():''; });
          if (!t.id || !/^\d{7,13}$/.test(t.id.replace(/\D/g,''))) { skipped++; return; }
          t.id = t.id.replace(/\D/g,'');
          stmt.run([t.id, area, t.serviceExecId||'', t.priority||'', t.subject||'', t.customer||'',
            t.ticketStatus||'', t.comment||'', t.processor||'',
            parseXlsxDate(t.prepStart||''), parseXlsxDate(t.execStart||''), ''],
            function(err) { if (!err) added++; });
        });
        stmt.finalize(err => err ? reject(err) : resolve());
      });
    });
    await broadcastPool(area);
    res.json({ added, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/:area/pool/:id', requireArea, (req, res) => {
  const { area, id } = req.params;
  db.run(`DELETE FROM pool_tickets WHERE id=? AND area=?`, [id, area], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastPool(area);
    res.json({ ok: true });
  });
});

app.delete('/api/:area/pool', requireArea, (req, res) => {
  db.run(`DELETE FROM pool_tickets WHERE area=?`, [req.params.area], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastPool(req.params.area);
    res.json({ ok: true });
  });
});

// ── Shift routes (:area = sm | merge) ────────────────────────────────────────

// List shifts for area
app.get('/api/:area/shifts', requireArea, (req, res) => {
  db.all(`SELECT * FROM shifts WHERE area=? ORDER BY date DESC, id DESC`, [req.params.area], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Create shift
app.post('/api/:area/shifts', requireArea, (req, res) => {
  const area = req.params.area;
  const date  = req.body.date  || mtyDateString(new Date());
  const label = req.body.label || '';
  db.run(`INSERT INTO shifts (area,date,label) VALUES (?,?,?)`, [area, date, label], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT * FROM shifts WHERE id=?`, [this.lastID], (e, row) => res.json(row));
  });
});

// Get or create today's shift
app.get('/api/:area/shifts/today', requireArea, (req, res) => {
  const area = req.params.area;
  const today = mtyDateString(new Date());
  db.get(`SELECT * FROM shifts WHERE area=? AND date=? ORDER BY id DESC LIMIT 1`, [area, today], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) return res.json(row);
    db.run(`INSERT INTO shifts (area,date,label) VALUES (?,?,?)`, [area, today, ''], function(e) {
      if (e) return res.status(500).json({ error: e.message });
      db.get(`SELECT * FROM shifts WHERE id=?`, [this.lastID], (e2, newRow) => res.json(newRow));
    });
  });
});

// Get tickets for a shift
app.get('/api/:area/shifts/:shiftId/tickets', requireArea, async (req, res) => {
  try { res.json(await getShiftTickets(req.params.shiftId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Load HO into shift
app.post('/api/:area/shifts/:shiftId/load-ho', requireArea, async (req, res) => {
  const area = req.params.area;
  const shiftId = req.params.shiftId;
  const { raw } = req.body;
  if (!raw) return res.status(400).json({ error: 'No raw text provided' });
  const parsed = parseHandover(raw);
  if (!parsed.length) return res.status(400).json({ error: 'No tickets found in pasted text' });

  let added = 0, merged = 0;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO shift_tickets (id,shiftId,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,source)
        SELECT ?,?,?,
          COALESCE(p.serviceExecId,''),
          COALESCE(NULLIF(p.priority,''),?),
          COALESCE(NULLIF(p.subject,''),?),
          COALESCE(p.customer,''),
          COALESCE(NULLIF(p.ticketStatus,''),?),
          ?,
          COALESCE(p.processor,''),
          COALESCE(p.category,''),
          COALESCE(p.prepStart,''),
          COALESCE(p.execStart,''),
          ?,
          'ho'
        FROM (SELECT NULL) _d LEFT JOIN pool_tickets p ON p.id=? AND p.area=?
        ON CONFLICT(id,shiftId) DO UPDATE SET
          subject     = COALESCE(NULLIF(excluded.subject,''),     shift_tickets.subject),
          ticketStatus= COALESCE(NULLIF(excluded.ticketStatus,''),shift_tickets.ticketStatus),
          comment     = COALESCE(NULLIF(excluded.comment,''),     shift_tickets.comment),
          ctRdy       = COALESCE(NULLIF(excluded.ctRdy,''),       shift_tickets.ctRdy),
          updatedAt   = datetime('now')
      `);
      parsed.forEach(t => {
        stmt.run([t.id, shiftId, area, t.priority, t.subject, t.ticketStatus, t.comment, t.ctRdy, t.id, area],
          function(err) { if (!err) this.changes > 0 ? added++ : merged++; });
      });
      stmt.finalize(err => err ? reject(err) : resolve());
    });
  });
  await broadcastShift(area, shiftId);
  res.json({ added, merged });
});

// Load executions from pool for the shift's date
app.post('/api/:area/shifts/:shiftId/load-executions', requireArea, async (req, res) => {
  const area    = req.params.area;
  const shiftId = req.params.shiftId;

  // Get the shift's date (YYYY-MM-DD in MTY)
  const shift = await new Promise((r, j) => db.get('SELECT * FROM shifts WHERE id=?', [shiftId], (e, row) => e ? j(e) : r(row)));
  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  // shift.date is YYYY-MM-DD in MTY (GMT-6). Window: 09:30–18:30 MTY = 15:30–00:30 UTC next day
  const [y, mo, d] = shift.date.split('-').map(Number);
  const shiftStartUtc = `${shift.date}T15:30`;
  const nextDay       = new Date(Date.UTC(y, mo - 1, d + 1));
  const nextStr       = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth()+1).padStart(2,'0')}-${String(nextDay.getUTCDate()).padStart(2,'0')}`;
  const shiftEndUtc   = `${nextStr}T00:30`;

  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT * FROM pool_tickets WHERE area=? AND ((prepStart BETWEEN ? AND ?) OR (execStart BETWEEN ? AND ?))`,
      [area, shiftStartUtc, shiftEndUtc, shiftStartUtc, shiftEndUtc],
      (err, rows) => err ? reject(err) : resolve(rows));
  });

  let added = 0, skipped = 0;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO shift_tickets (id,shiftId,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'execution')
        ON CONFLICT(id,shiftId) DO UPDATE SET
          serviceExecId = COALESCE(NULLIF(excluded.serviceExecId,''), shift_tickets.serviceExecId),
          prepStart     = COALESCE(NULLIF(excluded.prepStart,''),     shift_tickets.prepStart),
          execStart     = COALESCE(NULLIF(excluded.execStart,''),     shift_tickets.execStart),
          updatedAt     = datetime('now')
      `);
      rows.forEach(t => {
        stmt.run([t.id, shiftId, area, t.serviceExecId||'', t.priority||'', t.subject||'', t.customer||'',
          t.ticketStatus||'', t.comment||'', t.processor||'', t.category||'',
          t.prepStart||'', t.execStart||'', t.ctRdy||''],
          function(err) { if (!err) this.changes > 0 ? added++ : skipped++; });
      });
      stmt.finalize(err => err ? reject(err) : resolve());
    });
  });
  await broadcastShift(area, shiftId);
  res.json({ added, skipped, window: { from: shiftStartUtc, to: shiftEndUtc }, found: rows.length });
});

// Add single ticket to shift
app.post('/api/:area/shifts/:shiftId/tickets/single', requireArea, async (req, res) => {
  const area = req.params.area;
  const shiftId = req.params.shiftId;
  const { id, priority, subject, customer, ticketStatus, comment, processor, category, prepStart, execStart, notes } = req.body;
  if (!id || !/^\d{7,13}$/.test(id.trim())) return res.status(400).json({ error: 'Invalid ticket ID' });
  const poolRow = await new Promise(r => db.get('SELECT * FROM pool_tickets WHERE id=? AND area=?', [id.trim(), area], (e,row) => r(row)));
  db.run(
    `INSERT INTO shift_tickets (id,shiftId,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,notes,ctRdy,source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')
     ON CONFLICT(id,shiftId) DO NOTHING`,
    [id.trim(), shiftId, area,
     poolRow?.serviceExecId||'',
     priority||poolRow?.priority||'',
     subject||poolRow?.subject||'',
     customer||poolRow?.customer||'',
     ticketStatus||poolRow?.ticketStatus||'',
     comment||poolRow?.comment||'',
     processor||poolRow?.processor||'',
     category||poolRow?.category||'',
     prepStart||poolRow?.prepStart||'',
     execStart||poolRow?.execStart||'',
     notes||'',
     poolRow?.ctRdy||''],
    async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      await broadcastShift(area, shiftId);
      res.json({ ok: true });
    }
  );
});

// Patch shift ticket
app.patch('/api/:area/shifts/:shiftId/tickets/:id', requireArea, async (req, res) => {
  const area = req.params.area;
  const shiftId = req.params.shiftId;
  const ticketId = req.params.id;
  const changedBy = req.session.user?.name || req.session.user?.email || 'unknown';
  const allowed = ['processor','category','execStart','prepStart','notes','ticketStatus','comment','priority','serviceExecId','customer'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  // Fetch current values for diff
  const current = await new Promise(r => db.get('SELECT * FROM shift_tickets WHERE id=? AND shiftId=?', [ticketId, shiftId], (e, row) => r(row||{})));

  const sets = Object.keys(updates).map(k => `${k}=?`).join(', ');
  db.run(`UPDATE shift_tickets SET ${sets}, updatedAt=datetime('now') WHERE id=? AND shiftId=?`,
    [...Object.values(updates), ticketId, shiftId],
    async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      // Write change log entries
      const logStmt = db.prepare(`INSERT INTO change_log (ticketId,shiftId,area,field,oldValue,newValue,changedBy) VALUES (?,?,?,?,?,?,?)`);
      Object.entries(updates).forEach(([field, newVal]) => {
        const oldVal = String(current[field] ?? '');
        if (oldVal !== String(newVal)) {
          logStmt.run([ticketId, shiftId, area, field, oldVal, String(newVal), changedBy]);
        }
      });
      logStmt.finalize();
      await broadcastShift(area, shiftId);
      res.json({ ok: true });
    }
  );
});

// Delete shift ticket
app.delete('/api/:area/shifts/:shiftId/tickets/:id', requireArea, (req, res) => {
  const { area, shiftId } = req.params;
  db.run(`DELETE FROM shift_tickets WHERE id=? AND shiftId=?`, [req.params.id, shiftId], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastShift(area, shiftId);
    res.json({ ok: true });
  });
});

// Clear shift tickets
app.delete('/api/:area/shifts/:shiftId/tickets', requireArea, (req, res) => {
  const { area, shiftId } = req.params;
  db.run(`DELETE FROM shift_tickets WHERE shiftId=?`, [shiftId], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastShift(area, shiftId);
    res.json({ ok: true });
  });
});

// Generate HO
app.get('/api/:area/shifts/:shiftId/generate-ho', requireArea, async (req, res) => {
  try {
    const tickets = await getShiftTickets(req.params.shiftId);
    const groups = { 'Very High':[], High:[], Medium:[], Low:[], '':[] };
    tickets.forEach(t => (groups[t.priority] || groups['']).push(t));
    const lines = [];
    ['Very High','High','Medium','Low',''].forEach(pri => {
      if (!groups[pri]?.length) return;
      if (pri) lines.push(pri);
      lines.push('Ticket ID\tHandover Category\tSubject\tTicket Status\tComment\tCategory');
      groups[pri].forEach(t => {
        lines.push(`${t.id}\t${t.serviceExecId||''}\t${t.subject||''}\t${t.ticketStatus||''}\t${t.notes||t.comment||''}\t${t.category||''}`);
      });
      lines.push('');
    });
    res.json({ text: lines.join('\n'), count: tickets.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: inspect pool dates
app.get('/api/:area/pool/debug-dates', requireArea, (req, res) => {
  db.all(`SELECT id, prepStart, execStart FROM pool_tickets WHERE area=? LIMIT 20`, [req.params.area],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

// ── Historia: todos los tickets de todos los turnos del área ─────────────────
app.get('/api/:area/history', requireArea, (req, res) => {
  db.all(
    `SELECT st.*, s.date AS shiftDate, s.label AS shiftLabel
     FROM shift_tickets st
     JOIN shifts s ON s.id = st.shiftId
     WHERE st.area = ?
     ORDER BY s.date DESC, s.id DESC, st.createdAt ASC`,
    [req.params.area],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
  );
});

// ── Change log endpoint ───────────────────────────────────────────────────────
app.get('/api/:area/log/:ticketId', requireArea, (req, res) => {
  db.all(
    `SELECT * FROM change_log WHERE ticketId=? AND area=? ORDER BY changedAt DESC LIMIT 200`,
    [req.params.ticketId, req.params.area],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
  );
});

// ── Authentik users endpoint ──────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const authentikUrl = process.env.AUTHENTIK_URL || 'http://localhost:9000';
    const token = process.env.AUTHENTIK_TOKEN || '';
    if (!token) {
      // Fallback: return names from session groups context — just the logged-in user
      return res.json([req.session.user.name || req.session.user.email || 'unknown']);
    }
    const r = await fetch(`${authentikUrl}/api/v3/core/users/?is_active=true&page_size=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(502).json({ error: `Authentik returned ${r.status}` });
    const data = await r.json();
    const users = (data.results || []).map(u => u.name || u.username).filter(Boolean).sort();
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const [smRows, mergeRows, smPool, mergePool] = await Promise.all([
    getTickets('tickets'),
    getTickets('tickets_merge'),
    getPoolTickets('sm'),
    getPoolTickets('merge'),
  ]);
  socket.emit('sm:tickets:update',    smRows);
  socket.emit('merge:tickets:update', mergeRows);
  socket.emit('sm:pool:update',       smPool);
  socket.emit('merge:pool:update',    mergePool);
  io.emit('users:count', io.engine.clientsCount);
  socket.on('disconnect', () => io.emit('users:count', io.engine.clientsCount));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ticketdash running on http://localhost:${PORT}`));
