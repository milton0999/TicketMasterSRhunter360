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

// ── OAuth2 / Authentik config ─────────────────────────────────────────────────
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

const POOL_SCHEMA = `(
  id           TEXT PRIMARY KEY,
  serviceExecId TEXT DEFAULT '',
  priority     TEXT DEFAULT '',
  subject      TEXT DEFAULT '',
  customer     TEXT DEFAULT '',
  ticketStatus TEXT DEFAULT '',
  comment      TEXT DEFAULT '',
  processor    TEXT DEFAULT '',
  category     TEXT DEFAULT '',
  execStart    TEXT DEFAULT '',
  prepStart    TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  ctRdy        TEXT DEFAULT '',
  createdAt    TEXT DEFAULT (datetime('now')),
  updatedAt    TEXT DEFAULT (datetime('now'))
)`;

const SHIFT_SCHEMA = `(
  id           TEXT PRIMARY KEY,
  serviceExecId TEXT DEFAULT '',
  priority     TEXT DEFAULT '',
  subject      TEXT DEFAULT '',
  customer     TEXT DEFAULT '',
  ticketStatus TEXT DEFAULT '',
  comment      TEXT DEFAULT '',
  processor    TEXT DEFAULT '',
  category     TEXT DEFAULT '',
  execStart    TEXT DEFAULT '',
  prepStart    TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  ctRdy        TEXT DEFAULT '',
  source       TEXT DEFAULT 'manual',
  createdAt    TEXT DEFAULT (datetime('now')),
  updatedAt    TEXT DEFAULT (datetime('now'))
)`;

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tickets ${TICKET_SCHEMA}`);
  db.run(`CREATE TABLE IF NOT EXISTS tickets_merge ${TICKET_SCHEMA}`);
  db.run(`ALTER TABLE tickets ADD COLUMN validation TEXT DEFAULT 'pending'`, () => {});
  db.run(`ALTER TABLE tickets ADD COLUMN prepStart  TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE tickets_merge ADD COLUMN validation TEXT DEFAULT 'pending'`, () => {});
  db.run(`ALTER TABLE tickets_merge ADD COLUMN prepStart  TEXT DEFAULT ''`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS pool_tickets ${POOL_SCHEMA}`);
  db.run(`CREATE TABLE IF NOT EXISTS shift_tickets ${SHIFT_SCHEMA}`);
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

function broadcastSM()    { return getTickets('tickets').then(rows => io.emit('sm:tickets:update', rows)); }
function broadcastMerge() { return getTickets('tickets_merge').then(rows => io.emit('merge:tickets:update', rows)); }
function broadcastPool()  { return getTickets('pool_tickets').then(rows => io.emit('pool:tickets:update', rows)); }
function broadcastShift() { return getTickets('shift_tickets').then(rows => io.emit('shift:tickets:update', rows)); }

// ── Group helpers ─────────────────────────────────────────────────────────────
function userGroups(req) { return req.session.user?.groups || []; }

function hasSMAccess(req) {
  const g = userGroups(req);
  return g.some(x => ['sm-users','sm-leads','managers','authentik Admins'].includes(x));
}

function hasMergeAccess(req) {
  const g = userGroups(req);
  return g.some(x => ['merge-users','merge-leads','managers','authentik Admins'].includes(x));
}

function hasShiftAccess(req) {
  const g = userGroups(req);
  return g.some(x => ['sm-users','sm-leads','merge-users','merge-leads','managers','authentik Admins'].includes(x));
}

function requireSM(req, res, next) {
  if (hasSMAccess(req)) return next();
  res.status(403).json({ error: 'No access to SM area' });
}

function requireMerge(req, res, next) {
  if (hasMergeAccess(req)) return next();
  res.status(403).json({ error: 'No access to Merge area' });
}

function requireShift(req, res, next) {
  if (hasShiftAccess(req)) return next();
  res.status(403).json({ error: 'No access to Shift area' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── Handover parser ───────────────────────────────────────────────────────────
function parseHandover(raw) {
  const PRIORITY_LABELS = new Set(['very high','high','medium','low']);
  const COLUMN_HEADERS  = new Set(['ticket id','handover category','subject','ticket status','comment']);

  const lines = raw
    .split(/\r\n|\n|\r|\t/)
    .map(l => l.replace(/^"|"$/g,'').trim())
    .filter(Boolean);

  const tickets = [];
  let currentPriority = '';
  let i = 0;

  while (i < lines.length) {
    const lower = lines[i].toLowerCase();
    if (PRIORITY_LABELS.has(lower)) { currentPriority = lines[i]; i++; continue; }
    if (COLUMN_HEADERS.has(lower))  { i++; continue; }
    if (!/^\d{7,13}$/.test(lines[i])) { i++; continue; }

    const id       = lines[i];
    const category = lines[i+1] || '';
    const subject  = lines[i+2] || '';
    const status   = lines[i+3] || '';
    const comment  = lines[i+4] || '';
    tickets.push({
      id, priority: currentPriority, subject,
      ticketStatus: status, comment,
      processor: '', execStart: '',
      ctRdy: extractCtRdy(subject) || '',
      category: ''
    });
    i += 5;
  }
  return tickets;
}

// ── Route factory for an area ─────────────────────────────────────────────────
function makeAreaRoutes(router, table, broadcast) {
  router.get('/', async (req, res) => {
    try { res.json(await getTickets(table)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/handover', async (req, res) => {
    const { raw } = req.body;
    if (!raw) return res.status(400).json({ error: 'No raw text provided' });
    const parsed = parseHandover(raw);
    if (parsed.length === 0) return res.status(400).json({ error: 'No tickets found in pasted text' });

    let added = 0, skipped = 0;
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO ${table} (id,priority,subject,ticketStatus,comment,ctRdy,category,userStatus)
          VALUES (?,?,?,?,?,?,?,'new')
        `);
        parsed.forEach(t => {
          stmt.run([t.id,t.priority,t.subject,t.ticketStatus,t.comment,t.ctRdy,t.category], function(err) {
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
      `INSERT OR IGNORE INTO ${table} (id,priority,subject,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,notes,userStatus)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'new')`,
      [id.trim(),priority||'',subject||'',ticketStatus||'',comment||'',processor||'',category||'',prepStart||'',execStart||'',ctRdy||'',notes||''],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        await broadcast();
        res.json({ ok: true });
      }
    );
  });

  router.patch('/:id', async (req, res) => {
    const allowed = ['processor','category','execStart','prepStart','userStatus','validation','notes','ticketStatus','comment','priority'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const vals = [...Object.values(updates), req.params.id];

    db.run(
      `UPDATE ${table} SET ${sets}, updatedAt = datetime('now') WHERE id = ?`,
      vals,
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        await broadcast();
        res.json({ ok: true });
      }
    );
  });

  router.delete('/:id', (req, res) => {
    db.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id], async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      await broadcast();
      res.json({ ok: true });
    });
  });

  router.delete('/', (req, res) => {
    db.run(`DELETE FROM ${table}`, async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      await broadcast();
      res.json({ ok: true });
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
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code, redirect_uri: OIDC.redirectUri,
        client_id: OIDC.clientId, client_secret: OIDC.clientSecret,
      }),
    });
    const tokenText = await tokenRes.text();
    let tokens;
    try { tokens = JSON.parse(tokenText); } catch(e) { return res.status(500).send(`Token parse error (${tokenRes.status}): ${tokenText}`); }
    if (!tokens.access_token) return res.status(401).send('Token exchange failed: ' + JSON.stringify(tokens));

    const userRes = await fetch(OIDC.userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();

    req.session.user = { name: user.name, email: user.email, sub: user.sub, groups: user.groups || [] };
    delete req.session.oauthState;
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Auth error: ' + e.message);
  }
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

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/auth/login');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Area access endpoint ──────────────────────────────────────────────────────
app.get('/auth/area', (req, res) => {
  res.json({ sm: hasSMAccess(req), merge: hasMergeAccess(req), shift: hasShiftAccess(req) });
});

// ── API routes ────────────────────────────────────────────────────────────────
const smRouter = express.Router();
makeAreaRoutes(smRouter, 'tickets', broadcastSM);
app.use('/api/sm/tickets', requireSM, smRouter);

const mergeRouter = express.Router();
makeAreaRoutes(mergeRouter, 'tickets_merge', broadcastMerge);
app.use('/api/merge/tickets', requireMerge, mergeRouter);

// ── Pool routes ───────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/pool/tickets', requireShift, async (req, res) => {
  try { res.json(await getTickets('pool_tickets')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pool/upload', requireShift, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    // Normalize column names (case-insensitive, ignore spaces/underscores)
    function norm(k) { return String(k).toLowerCase().replace(/[\s_-]/g,''); }
    const COL_MAP = {
      ticketid: 'id', ticket: 'id',
      serviceexecution: 'serviceExecId', serviceexecutionid: 'serviceExecId', sidcid: 'serviceExecId',
      subject: 'subject', title: 'subject',
      customer: 'customer',
      prepstart: 'prepStart',
      execstart: 'execStart',
      priority: 'priority',
      ticketstatus: 'ticketStatus', status: 'ticketStatus',
      comment: 'comment', comments: 'comment',
      processor: 'processor',
    };

    let added = 0, skipped = 0;
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(`
          INSERT INTO pool_tickets (id,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,prepStart,execStart,ctRdy)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            serviceExecId=excluded.serviceExecId, subject=excluded.subject,
            customer=excluded.customer, prepStart=excluded.prepStart,
            execStart=excluded.execStart, updatedAt=datetime('now')
        `);
        rows.forEach(row => {
          const t = {};
          Object.entries(row).forEach(([k, v]) => {
            const mapped = COL_MAP[norm(k)];
            if (mapped) t[mapped] = v != null ? String(v).trim() : '';
          });
          if (!t.id || !/^\d{7,13}$/.test(t.id.replace(/\D/g,''))) { skipped++; return; }
          t.id = t.id.replace(/\D/g,'');
          const ps = parseXlsxDate(t.prepStart || '');
          const es = parseXlsxDate(t.execStart || '');
          stmt.run([t.id, t.serviceExecId||'', t.priority||'', t.subject||'',
            t.customer||'', t.ticketStatus||'', t.comment||'', t.processor||'',
            ps, es, ''], function(err) {
            if (err) return;
            added++;
          });
        });
        stmt.finalize(err => err ? reject(err) : resolve());
      });
    });

    await broadcastPool();
    res.json({ added, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/pool/tickets', requireShift, (req, res) => {
  db.run(`DELETE FROM pool_tickets`, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastPool();
    res.json({ ok: true });
  });
});

function parseXlsxDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    return v.toISOString().slice(0,16);
  }
  const s = String(v).trim();
  if (!s || s === 'Invalid Date') return '';
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0,16);
  // Try native parse
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0,16);
  return s;
}

// ── Shift routes ──────────────────────────────────────────────────────────────
app.get('/api/shift/tickets', requireShift, async (req, res) => {
  try { res.json(await getTickets('shift_tickets')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Load HO text into shift (upsert from pool or create)
app.post('/api/shift/load-ho', requireShift, async (req, res) => {
  const { raw } = req.body;
  if (!raw) return res.status(400).json({ error: 'No raw text provided' });
  const parsed = parseHandover(raw);
  if (parsed.length === 0) return res.status(400).json({ error: 'No tickets found in pasted text' });

  let added = 0, merged = 0;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO shift_tickets (id,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,source)
        SELECT ?,COALESCE(p.serviceExecId,''),COALESCE(p.priority,?),COALESCE(p.subject,?),COALESCE(p.customer,''),
               COALESCE(p.ticketStatus,?),?,COALESCE(p.processor,''),'',
               COALESCE(p.prepStart,''),COALESCE(p.execStart,''),?,?
        FROM (SELECT NULL) _dummy LEFT JOIN pool_tickets p ON p.id=?
        ON CONFLICT(id) DO UPDATE SET
          subject=COALESCE(NULLIF(excluded.subject,''), shift_tickets.subject),
          ticketStatus=COALESCE(NULLIF(excluded.ticketStatus,''), shift_tickets.ticketStatus),
          comment=COALESCE(NULLIF(excluded.comment,''), shift_tickets.comment),
          ctRdy=COALESCE(NULLIF(excluded.ctRdy,''), shift_tickets.ctRdy),
          updatedAt=datetime('now')
      `);
      parsed.forEach(t => {
        stmt.run([t.id, t.priority, t.subject, t.ticketStatus, t.comment, t.ctRdy, 'ho', t.id],
          function(err) {
            if (err) return;
            this.changes > 0 ? added++ : merged++;
          });
      });
      stmt.finalize(err => err ? reject(err) : resolve());
    });
  });

  await broadcastShift();
  res.json({ added, merged });
});

// Load today's executions from pool (PS or ES within 9:30-18:30 GMT-6 today)
app.post('/api/shift/load-executions', requireShift, async (req, res) => {
  // Shift window: 9:30-18:30 MTY (GMT-6) = 15:30-00:30 UTC
  const now = new Date();
  // Get today's date in MTY
  const mtyOffset = -6 * 60 * 60 * 1000;
  const mtyNow = new Date(now.getTime() + mtyOffset);
  const y = mtyNow.getUTCFullYear();
  const mo = String(mtyNow.getUTCMonth()+1).padStart(2,'0');
  const d = String(mtyNow.getUTCDate()).padStart(2,'0');
  // Shift start: that day 9:30 MTY = 15:30 UTC
  const shiftStartUtc = `${y}-${mo}-${d}T15:30`;
  // Shift end: 18:30 MTY = 00:30 UTC next day
  const nextDay = new Date(Date.UTC(y, mtyNow.getUTCMonth(), mtyNow.getUTCDate()+1));
  const nd = String(nextDay.getUTCDate()).padStart(2,'0');
  const nm = String(nextDay.getUTCMonth()+1).padStart(2,'0');
  const ny = nextDay.getUTCFullYear();
  const shiftEndUtc = `${ny}-${nm}-${nd}T00:30`;

  const rows = await new Promise((resolve, reject) => {
    db.all(`
      SELECT * FROM pool_tickets
      WHERE (prepStart BETWEEN ? AND ?) OR (execStart BETWEEN ? AND ?)
    `, [shiftStartUtc, shiftEndUtc, shiftStartUtc, shiftEndUtc],
    (err, rows) => err ? reject(err) : resolve(rows));
  });

  let added = 0, skipped = 0;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO shift_tickets (id,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'execution')
        ON CONFLICT(id) DO UPDATE SET
          serviceExecId=COALESCE(NULLIF(excluded.serviceExecId,''), shift_tickets.serviceExecId),
          prepStart=COALESCE(NULLIF(excluded.prepStart,''), shift_tickets.prepStart),
          execStart=COALESCE(NULLIF(excluded.execStart,''), shift_tickets.execStart),
          updatedAt=datetime('now')
      `);
      rows.forEach(t => {
        stmt.run([t.id,t.serviceExecId||'',t.priority||'',t.subject||'',t.customer||'',
          t.ticketStatus||'',t.comment||'',t.processor||'',t.category||'',
          t.prepStart||'',t.execStart||'',t.ctRdy||''],
          function(err) { if (!err) this.changes > 0 ? added++ : skipped++; });
      });
      stmt.finalize(err => err ? reject(err) : resolve());
    });
  });

  await broadcastShift();
  res.json({ added, skipped, window: { from: shiftStartUtc, to: shiftEndUtc } });
});

// Add single ticket to shift
app.post('/api/shift/tickets/single', requireShift, async (req, res) => {
  const { id, priority, subject, customer, ticketStatus, comment, processor, category, prepStart, execStart, notes } = req.body;
  if (!id || !/^\d{7,13}$/.test(id.trim())) return res.status(400).json({ error: 'Invalid ticket ID' });

  // Try to enrich from pool
  const poolRow = await new Promise(r => db.get('SELECT * FROM pool_tickets WHERE id=?', [id.trim()], (e,row) => r(row)));

  db.run(
    `INSERT INTO shift_tickets (id,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,notes,ctRdy,source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')
     ON CONFLICT(id) DO NOTHING`,
    [id.trim(),
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
      await broadcastShift();
      res.json({ ok: true });
    }
  );
});

// Patch shift ticket
app.patch('/api/shift/tickets/:id', requireShift, async (req, res) => {
  const allowed = ['processor','category','execStart','prepStart','notes','ticketStatus','comment','priority','serviceExecId','customer'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(updates), req.params.id];
  db.run(`UPDATE shift_tickets SET ${sets}, updatedAt=datetime('now') WHERE id=?`, vals,
    async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      await broadcastShift();
      res.json({ ok: true });
    });
});

// Delete shift ticket
app.delete('/api/shift/tickets/:id', requireShift, (req, res) => {
  db.run(`DELETE FROM shift_tickets WHERE id=?`, [req.params.id], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastShift();
    res.json({ ok: true });
  });
});

// Clear shift
app.delete('/api/shift/tickets', requireShift, (req, res) => {
  db.run(`DELETE FROM shift_tickets`, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastShift();
    res.json({ ok: true });
  });
});

// Generate HO text
app.get('/api/shift/generate-ho', requireShift, async (req, res) => {
  try {
    const rows = await getTickets('shift_tickets');
    // Group by priority
    const groups = { 'Very High': [], High: [], Medium: [], Low: [], '': [] };
    rows.forEach(t => { (groups[t.priority] || groups['']).push(t); });
    const lines = [];
    const ORDER = ['Very High','High','Medium','Low',''];
    ORDER.forEach(pri => {
      if (!groups[pri]?.length) return;
      if (pri) lines.push(pri);
      lines.push('Ticket ID\tHandover Category\tSubject\tTicket Status\tComment');
      groups[pri].forEach(t => {
        lines.push(`${t.id}\t${t.serviceExecId||''}\t${t.subject||''}\t${t.ticketStatus||''}\t${t.comment||t.notes||''}`);
      });
      lines.push('');
    });
    res.json({ text: lines.join('\n'), count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const [smRows, mergeRows, poolRows, shiftRows] = await Promise.all([
    getTickets('tickets'),
    getTickets('tickets_merge'),
    getTickets('pool_tickets'),
    getTickets('shift_tickets'),
  ]);
  socket.emit('sm:tickets:update', smRows);
  socket.emit('merge:tickets:update', mergeRows);
  socket.emit('pool:tickets:update', poolRows);
  socket.emit('shift:tickets:update', shiftRows);
  io.emit('users:count', io.engine.clientsCount);
  socket.on('disconnect', () => io.emit('users:count', io.engine.clientsCount));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ticketdash running on http://localhost:${PORT}`));
