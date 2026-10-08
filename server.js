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

db.serialize(() => {
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
    execEnd       TEXT DEFAULT '',
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
    execEnd       TEXT DEFAULT '',
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
  db.run(`ALTER TABLE shift_tickets ADD COLUMN hoReview TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE shift_tickets ADD COLUMN userStatus TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE pool_tickets ADD COLUMN execEnd TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE shift_tickets ADD COLUMN execEnd TEXT DEFAULT ''`, () => {});

  // ── Auto-assign: availability calendar ───────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS availability_calendar (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    date       TEXT NOT NULL,
    shift_code TEXT NOT NULL,
    area       TEXT NOT NULL,
    UNIQUE(user_id, date, area)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cal_area_date ON availability_calendar (area, date)`);

  // ── Auto-assign: clients (shared SM+Merge) ────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    is_critical INTEGER NOT NULL DEFAULT 0,
    sed         TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`ALTER TABLE clients ADD COLUMN sed TEXT NOT NULL DEFAULT ''`, () => {});

  // ── Auto-assign: activities per area ─────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS sm_activities (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    estimated_minutes  INTEGER NOT NULL DEFAULT 60,
    sd_id              TEXT NOT NULL DEFAULT '',
    category           TEXT NOT NULL DEFAULT '',
    is_manual          INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS merge_activities (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    estimated_minutes  INTEGER NOT NULL DEFAULT 60,
    sd_id              TEXT NOT NULL DEFAULT '',
    category           TEXT NOT NULL DEFAULT '',
    is_manual          INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`ALTER TABLE sm_activities ADD COLUMN sd_id TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(`ALTER TABLE sm_activities ADD COLUMN category TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(`ALTER TABLE sm_activities ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE merge_activities ADD COLUMN sd_id TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(`ALTER TABLE merge_activities ADD COLUMN category TEXT NOT NULL DEFAULT ''`, () => {});
  db.run(`ALTER TABLE merge_activities ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0`, () => {});

  // Seed SM activities if table is empty
  db.get(`SELECT COUNT(*) as n FROM sm_activities`, (err, row) => {
    if (err || row.n > 0) {
      // Update is_manual for existing rows (migration for DBs seeded before this column existed)
      const manualIds = ['ACE28490','ACE28672','ACE28677','ACE28937','ACE34901','ACE10587','CCE123','CCE136',
        'CCE157','CCE42','CCE2271','ACE30479','CCE43','CCE3020','CCE2996','ACE37297','ACE37311','CCE2662',
        'ACE33245','ACE35403','CCE3651','CCE2983','CCE126','ACE33651','ACE46402','ACE49738','ACE10385','ACE24901'];
      manualIds.forEach(sd => db.run(`UPDATE sm_activities SET is_manual=1 WHERE sd_id=? AND is_manual=0`, [sd]));
      return;
    }
    // name, sd_id, category, estimated_minutes, is_manual
    // is_manual: 1=Manual starting type, 0=automated/auto-at-prep-start
    const acts = [
      ['Manage Application Security Audit Logs','CCE156','Uptime',135,0],      // S01 Auto at Prep Start? no — Manual
      ['Reboot IaaS Server','ACE10433','Downtime',100,0],                      // S02 Auto at Prep Start
      ['Allowlist Squid Proxy Access: OUTBOUND to EXTERNAL Destn','CCE2323','Uptime',65,0], // S03 Auto at Prep Start
      ['Manage Firewall (NSG) Rules and Inbound Connectivity (Hyperscaler)','ACE28490','Uptime',90,1], // S04 Manual
      ['Allowlist Hyperscaler LB access: OUTBOUND to EXTERNAL destn','ACE28672','Uptime',180,1], // S05 Manual
      ['Create Hyperscaler LB for OUTBOUND traffic to EXTERNAL source','ACE28677','Uptime',90,1], // S06 Manual
      ['Set Up Hyperscaler VPC/VNet Peering','ACE28937','Uptime',270,1],       // S07 Manual
      ['Set Up and Configure SFTP Server','CCE120','Uptime',90,1],             // S08 Manual
      ['Migrate DNS Domain','ACE34901','Downtime',510,1],                      // S09 Manual
      ['Create/Manage Users for CIFS Share','ACE10587','Uptime',25,1],         // S10 Manual
      ['Set Up or Manage SAMBA/CIFS Server','CCE123','Uptime',50,1],           // S11 Manual
      ['Mount CIFS (aka Samba) shares','CCE124','Uptime',45,0],                // S12 Auto at Prep Start
      ['Create or Extend Local / NFS Volume','CCE125','Uptime',60,1],          // S13 Manual
      ['Scale Capacity (Memory and CPU)','CCE136','Downtime',200,1],           // S14 Manual
      ['Apply Other Security Patch to OS (Linux, Windows)','CCE137','Downtime',420,0], // S15 MMI/Auto
      ['Upgrade SLES OS to Major Version','CCE157','Downtime',210,1],          // S16 Manual
      ['Apply latest Security Patch to OS (Linux, Windows)','CCE262','Downtime',420,0], // S17 Auto at Prep Start
      ['Update OS Service Pack (Linux)','CCE42','Downtime',180,1],             // S18 Manual
      ['Migrate Physical Database Server to New Hardware','CCE2271','Downtime',360,1], // S19 Manual
      ['Set Up Hyperscaler AWS Transit Gateway','ACE30479','Uptime',150,1],    // S20 Manual
      ['Manage Volumes','CCE43','Uptime',60,1],                                // S21 Manual
      ['Migrate Volume','CCE3020','Downtime',255,1],                           // S22 Manual
      ['Manage OS Files & Folders','CCE2996','Uptime',80,1],                   // S23 Manual
      ['Hyperscaler Maintenance','ACE37297','Downtime',140,1],                 // S24 Manual
      ['Enable Stronger Ciphers (TLS 1.2)','ACE37311','Downtime',120,1],       // S25 Manual
      ['DNS Forward and Zone Transfer','CCE2662','Uptime',50,1],               // S26 Manual
      ['Encrypt AWS root EBS volume','ACE33245','Downtime',160,1],             // S27 Manual
      ['Change the UID for OS user','ACE35403','Downtime',620,1],              // S28 Manual
      ['Samba Server Security Enhancement','CCE3651','Downtime',93,1],         // S29 Manual
      ['Add servers to Proximity Placement Group (PPG) in Azure','CCE2983','Downtime',150,1], // S30 Manual
      ['Assist with OS Tasks','CCE126','Downtime',80,1],                       // S31 Manual
      ['Change Azure VM to non-temp OS flavor','ACE33651','Downtime',180,1],   // S32 Manual
      ['Configure availability zone Azure VM','ACE46402','Downtime',330,1],    // S33 Manual
      ['Move NFS volume to Production storage','ACE49738','Downtime',330,1],   // S34 Manual
      ['Assisted Service Request','ACE10385','Downtime',270,1],                // S35 Manual
      ['Enhance SDDR system with Load Balancer based approach','ACE49221','Downtime',300,1], // S36 Manual
    ];
    const stmt = db.prepare(`INSERT OR IGNORE INTO sm_activities (name,sd_id,category,estimated_minutes,is_manual) VALUES (?,?,?,?,?)`);
    acts.forEach(([name,sd_id,cat,mins,manual]) => stmt.run(name,sd_id,cat,mins,manual));
    stmt.finalize();
  });

  // ── Auto-assign: processor config (shared) ────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS processor_config (
    user_id      TEXT PRIMARY KEY,
    can_critical INTEGER NOT NULL DEFAULT 0
  )`);

  // ── Auto-assign: processor skills per area ────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS sm_processor_skills (
    user_id     TEXT NOT NULL,
    activity_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, activity_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS merge_processor_skills (
    user_id     TEXT NOT NULL,
    activity_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, activity_id)
  )`);
});

// ── DB helpers ────────────────────────────────────────────────────────────────
const ORDER_SQL = `ORDER BY CASE priority
  WHEN 'Very High' THEN 1 WHEN 'High' THEN 2
  WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, createdAt ASC`;

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

function requireArea(req, res, next)  {
  if (hasAreaAccess(req, req.params.area)) return next();
  res.status(403).json({ error: `No access to ${req.params.area} area` });
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_LONG  = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};

function extractCtRdy(subject) {
  if (!subject) return null;
  // Match CT_RDY(...) or CT_RDY[...] — also handle unclosed parens by taking up to ||
  const inner = subject.match(/CT_RDY\s*[\(\[](.*?)(?:[\)\]]|(?=\s*\|{2}|\s*$))/i);
  if (!inner) return null;
  let s = inner[1].replace(/\bat\b/gi, '').replace(/\.$/, '').replace(/^Schedule Start:\s*/i, '').trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (iso) return `${parseInt(iso[3])} ${MONTH_NAMES[parseInt(iso[2])-1]} ${iso[1]}, ${iso[4]}:${iso[5]} UTC`;
  // DD.MM.YYYY HH:MM (with optional comma)
  const dot = s.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s*,?\s*(\d{2}):(\d{2})/);
  if (dot) {
    let day = parseInt(dot[1]), mon = parseInt(dot[2]);
    if (day > 12) { /* DD.MM */ } else if (mon > 12) { [day,mon]=[mon,day]; }
    return `${day} ${MONTH_NAMES[mon-1]} ${dot[3]}, ${dot[4]}:${dot[5]} UTC`;
  }
  // MM/DD/YYYY HH:MM AM/PM
  const us = s.match(/^(\d{1,2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (us) {
    let h = parseInt(us[4]);
    if (us[6].toUpperCase()==='PM' && h!==12) h+=12;
    if (us[6].toUpperCase()==='AM' && h===12) h=0;
    return `${parseInt(us[2])} ${MONTH_NAMES[parseInt(us[1])-1]} ${us[3]}, ${String(h).padStart(2,'0')}:${us[5]} UTC`;
  }
  // DD-Mon-YY(YY) HH:MM  (e.g. 13-Sep-26 or 13-Sep-2026)
  const dash = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (dash) {
    let year = parseInt(dash[3]);
    if (year < 100) year += 2000;
    const monIdx = MONTH_LONG[dash[2].toLowerCase()] ?? MONTH_NAMES.findIndex(m => m.toLowerCase() === dash[2].toLowerCase().slice(0,3));
    return `${parseInt(dash[1])} ${MONTH_NAMES[monIdx]||dash[2].slice(0,3)} ${year}, ${dash[4]}:${dash[5]} UTC`;
  }
  // D/DD Month YYYY[,] HH:MM
  const full = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})[,\s]+(\d{2}):(\d{2})/);
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
  if (v instanceof Date) { return isNaN(v) ? '' : v.toISOString().slice(0,16)+'Z'; }
  const s = String(v).trim();
  if (!s || s === 'Invalid Date') return '';
  // Already ISO — ensure Z suffix so browser treats as UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0,16) + (s.endsWith('Z') ? 'Z' : 'Z');

  // Format: "14 Aug 2026, 16:00 GMT-6"  or  "1 Sept 2026, 03:46 GMT-6"
  const gmtMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*GMT([+-]\d+)?/i);
  if (gmtMatch) {
    const day    = parseInt(gmtMatch[1]);
    const monRaw = gmtMatch[2].toLowerCase().slice(0,3); // "aug", "sep", etc.
    const MON    = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mon    = MON[monRaw];
    if (mon === undefined) return s;
    const year     = parseInt(gmtMatch[3]);
    const h        = parseInt(gmtMatch[4]);
    const m        = parseInt(gmtMatch[5]);
    const tzOffset = gmtMatch[6] ? parseInt(gmtMatch[6]) : 0; // e.g. -6
    // UTC = local_time - tz_offset  (GMT-6 means local is UTC-6, so UTC = local + 6)
    const utcMs = Date.UTC(year, mon, day, h, m) - tzOffset * 60 * 60 * 1000;
    const d = new Date(utcMs);
    return d.toISOString().slice(0,16)+'Z';
  }

  // Format: "14 Aug 2026, 16:00 UTC"  (from extractCtRdy)
  const utcMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*UTC$/i);
  if (utcMatch) {
    const day    = parseInt(utcMatch[1]);
    const monRaw = utcMatch[2].toLowerCase().slice(0,3);
    const MON    = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mon    = MON[monRaw];
    if (mon === undefined) return s;
    const year = parseInt(utcMatch[3]);
    const h    = parseInt(utcMatch[4]);
    const m    = parseInt(utcMatch[5]);
    return new Date(Date.UTC(year, mon, day, h, m)).toISOString().slice(0,16)+'Z';
  }

  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0,16)+'Z';
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Allow Chrome extension origins (credentials: include)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://') || origin === '') {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
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
  let version = 'unknown';
  try { version = require('./package.json').version; } catch {}
  res.json({ version });
});

// Config persisted in data/config.json — readable by extension without auth
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

// Local user roster — fallback when Authentik is unavailable, per-area
const LOCAL_USERS_FILE = path.join(__dirname, 'data', 'users.json');
function readLocalUsers(area) {
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_USERS_FILE, 'utf8'));
    // Support both old flat array (migrate on read) and new { sm:[], merge:[] } shape
    if (Array.isArray(data)) return area ? data : data;
    return area ? (data[area] || []) : data;
  } catch { return area ? [] : {}; }
}
function writeLocalUsers(area, users) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  let data = {};
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_USERS_FILE, 'utf8'));
    // Migrate flat array: put old list under 'sm' only
    data = Array.isArray(raw) ? { sm: raw, merge: [] } : raw;
  } catch { data = { sm: [], merge: [] }; }
  data[area] = users;
  fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}
const CONFIG_DEFAULTS = {
  processors: [{ name: 'Unassigned', color: '#888' }],
  categories: [
    { name: 'Self',        color: '#4CAF50' },
    { name: 'Non Self',    color: '#0288D1' },
    { name: 'TQS',         color: '#CE93D8' },
    { name: 'Seguimiento', color: '#FFB300' },
    { name: 'Análisis',    color: '#FF7043' },
    { name: 'Monitoreo',   color: '#26C6DA' },
  ],
  userStatuses: [
    { name: 'new',         color: '#555' },
    { name: 'in-progress', color: '#0277BD' },
    { name: 'done',        color: '#2E7D32' },
    { name: 'HO',          color: '#CE93D8' },
  ],
  ticketStatuses: [
    { name: 'New',              color: '#546E7A' },
    { name: 'In Process',       color: '#0288D1' },
    { name: 'Waiting',          color: '#F9A825' },
    { name: 'Pending Customer', color: '#EF6C00' },
    { name: 'Awaiting CR',      color: '#6A1B9A' },
    { name: 'Done',             color: '#2E7D32' },
  ],
  hoReviews: [
    { name: 'HO',   color: '#CE93D8' },
    { name: 'Done', color: '#2E7D32' },
    { name: 'Skip', color: '#555' },
  ],
};

function readConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return CONFIG_DEFAULTS; }
  // Keep userStatuses in sync with hoReviews: any hoReview name must exist in userStatuses
  if (Array.isArray(cfg.hoReviews) && Array.isArray(cfg.userStatuses)) {
    const usNames = new Set(cfg.userStatuses.map(s => s.name));
    let dirty = false;
    for (const hr of cfg.hoReviews) {
      if (!usNames.has(hr.name)) {
        cfg.userStatuses.push({ name: hr.name, color: hr.color });
        dirty = true;
      }
    }
    if (dirty) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  }
  return cfg;
}

app.get('/api/config', (req, res) => res.json(readConfig()));

// POST /api/config — called by app.js saveConfig() to persist user's config server-side
// Placed before requireAuth so extension can GET without auth; POST still requires session via requireAuth below


function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/auth/login');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/config', (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg || typeof cfg !== 'object') return res.status(400).json({ error: 'Invalid config' });
    // Keep userStatuses in sync: any hoReview name must exist in userStatuses
    if (Array.isArray(cfg.hoReviews) && Array.isArray(cfg.userStatuses)) {
      const usNames = new Set(cfg.userStatuses.map(s => s.name));
      for (const hr of cfg.hoReviews) {
        if (!usNames.has(hr.name)) cfg.userStatuses.push({ name: hr.name, color: hr.color });
      }
    }
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Authentik users cache + local fallback ────────────────────────────────────
const _usersCache = { data: null, ts: 0 };

// Returns { sm: [{pk, name}], merge: [{pk, name}] } from Authentik groups API
async function fetchAuthentikUsersByArea() {
  if (_usersCache.data && Date.now() - _usersCache.ts < 5 * 60 * 1000) return _usersCache.data;
  const authentikUrl = process.env.AUTHENTIK_URL || 'http://localhost:9000';
  const token = process.env.AUTHENTIK_TOKEN || '';
  if (!token) return null;
  try {
    const SM_NAMES    = ['sm-users','sm-leads','managers'];
    const MERGE_NAMES = ['merge-users','merge-leads','managers'];
    const allTarget   = new Set([...SM_NAMES, ...MERGE_NAMES]);

    // Fetch all groups with their members in one call
    const r = await fetch(`${authentikUrl}/api/v3/core/groups/?include_users=true&page_size=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Authentik groups returned ${r.status}`);
    const data = await r.json();
    const groups = data.results || [];

    const smSet    = new Map(); // pk → name
    const mergeSet = new Map();

    for (const group of groups) {
      if (!allTarget.has(group.name)) continue;
      const isSM    = SM_NAMES.includes(group.name);
      const isMerge = MERGE_NAMES.includes(group.name);
      for (const u of (group.users_obj || [])) {
        if (isSM)    smSet.set(u.username, u.name || u.username);
        if (isMerge) mergeSet.set(u.username, u.name || u.username);
      }
    }

    const toList = map => [...map.entries()]
      .map(([pk, name]) => ({ pk, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    _usersCache.data = { sm: toList(smSet), merge: toList(mergeSet), connected: true };
    _usersCache.ts = Date.now();
    return _usersCache.data;
  } catch (e) {
    console.warn('[users] Authentik unreachable:', e.message);
    return null;
  }
}

// Legacy: returns flat array of raw user objects (used by old code paths)
async function fetchAuthentikUsers() {
  return []; // groups-based approach replaces this
}

// Convert local users list (pk+name) to the shape fetchAuthentikUsers returns
function localUsersAsAuthentik(area) {
  return readLocalUsers(area).map(u => ({
    username: u.pk,
    name: u.name,
    groups_obj: (u.groups || []).map(g => ({ name: g })),
  }));
}

app.get('/api/users', async (req, res) => {
  try {
    const area = req.query.area || 'sm';
    const byArea = await fetchAuthentikUsersByArea();
    let users = byArea ? (byArea[area] || []).map(u => u.name) : [];
    if (!users.length) users = readLocalUsers(area).map(u => u.name);
    res.json(users.sort());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full user objects (pk + name) for calendar/matrix
app.get('/api/users/full', async (req, res) => {
  try {
    const area = req.query.area || 'sm';
    const byArea = await fetchAuthentikUsersByArea();
    let users = byArea ? (byArea[area] || []) : [];
    if (!users.length) users = readLocalUsers(area).map(u => ({ pk: u.pk, name: u.name }));
    res.json(users.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Local user roster per area (fallback when Authentik unavailable) ──────────
app.get('/api/:area/local-users', requireArea, (req, res) => res.json(readLocalUsers(req.params.area)));

app.post('/api/:area/local-users', requireArea, (req, res) => {
  const area = req.params.area;
  const { pk, name } = req.body;
  if (!pk || !name) return res.status(400).json({ error: 'pk and name required' });
  const users = readLocalUsers(area);
  if (users.find(u => u.pk === pk.trim())) return res.status(409).json({ error: 'User already exists' });
  users.push({ pk: pk.trim(), name: name.trim() });
  users.sort((a, b) => a.name.localeCompare(b.name));
  writeLocalUsers(area, users);
  res.json({ ok: true });
});

app.patch('/api/:area/local-users/:pk', requireArea, (req, res) => {
  const area = req.params.area;
  const users = readLocalUsers(area);
  const u = users.find(u => u.pk === req.params.pk);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) u.name = req.body.name.trim();
  if (req.body.pk)   u.pk   = req.body.pk.trim();
  writeLocalUsers(area, users);
  res.json({ ok: true });
});

app.delete('/api/:area/local-users/:pk', requireArea, (req, res) => {
  const area = req.params.area;
  const users = readLocalUsers(area).filter(u => u.pk !== req.params.pk);
  writeLocalUsers(area, users);
  res.json({ ok: true });
});

// Sync local roster from Authentik — replaces list with current Authentik members for this area
app.post('/api/:area/local-users/sync', requireArea, async (req, res) => {
  const area = req.params.area;
  try {
    _usersCache.data = null;
    const byArea = await fetchAuthentikUsersByArea();
    const synced = byArea ? (byArea[area] || []) : [];
    if (!synced.length) return res.status(404).json({ error: 'No Authentik users found for this area — check group memberships' });
    writeLocalUsers(area, synced);
    res.json({ ok: true, synced: synced.length, users: synced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/auth/area', (req, res) => {
  res.json({ sm: hasSMAccess(req), merge: hasMergeAccess(req) });
});

// Authentik connectivity + area user count status
app.get('/api/authentik/status', async (req, res) => {
  const token = process.env.AUTHENTIK_TOKEN || '';
  if (!token) return res.json({ connected: false, reason: 'no token', smCount: 0, mergeCount: 0 });
  try {
    _usersCache.data = null;
    const byArea = await fetchAuthentikUsersByArea();
    if (!byArea) return res.json({ connected: false, reason: 'unreachable', smCount: 0, mergeCount: 0 });
    res.json({ connected: true, smCount: byArea.sm.length, mergeCount: byArea.merge.length, hasGroups: true });
  } catch (e) {
    res.json({ connected: false, reason: e.message, smCount: 0, mergeCount: 0 });
  }
});

// Debug: raw Authentik groups API response — shows what fields come back
app.get('/api/authentik/debug', async (req, res) => {
  const authentikUrl = process.env.AUTHENTIK_URL || 'http://localhost:9000';
  const token = process.env.AUTHENTIK_TOKEN || '';
  if (!token) return res.json({ error: 'no AUTHENTIK_TOKEN' });
  try {
    _usersCache.data = null;
    // Fetch one group to see raw shape
    const r = await fetch(`${authentikUrl}/api/v3/core/groups/?include_users=true&page_size=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = await r.json();
    // Also summarize what we parsed
    const parsed = await fetchAuthentikUsersByArea();
    res.json({ raw_sample: (raw.results||[]).slice(0,3), parsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pool routes (:area = sm | merge) ─────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const COL_MAP = {
  ticketid:'id', ticket:'id',
  serviceexecution:'serviceExecId', serviceexecutionid:'serviceExecId', sidcid:'serviceExecId',
  subject:'subject', title:'subject', ticketsubject:'subject',
  customer:'customer',
  prepstart:'prepStart', preparationstart:'prepStart', execstart:'execStart', executionstart:'execStart',
  execend:'execEnd', executionend:'execEnd', plannedexecutionend:'plannedExecEnd',
  priority:'priority',
  ticketstatus:'ticketStatus', status:'ticketStatus',
  comment:'comment', comments:'comment',
  processor:'processor', ticketprocessor:'processor',
};
function normCol(k) { return String(k).toLowerCase().replace(/[\s_-]/g,''); }

const normName = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// When a pool customer name comes in, sync it into the clients catalog:
// - exact match (normalized): do nothing, name is already correct
// - fuzzy match (one contains the other): update catalog row to use pool name (pool is source of truth)
// - no match: do nothing (catalog entry must be added manually or via bulk import)
function syncClientName(poolName, clientList) {
  if (!poolName || !clientList.length) return;
  const n = normName(poolName);
  const exact = clientList.find(c => normName(c.name) === n);
  if (exact) {
    // Already correct — update in-memory so repeated rows in same import don't re-trigger
    exact.name = poolName;
    return;
  }
  const fuzzy = clientList.find(c => {
    const cn = normName(c.name);
    return cn.includes(n) || n.includes(cn);
  });
  if (fuzzy && fuzzy.name !== poolName) {
    // Update catalog to use the pool name
    db.run(`UPDATE clients SET name=? WHERE name=?`, [poolName, fuzzy.name]);
    fuzzy.name = poolName; // update in-memory cache entry too
    _clientCache = null;   // force cache refresh for next request
  }
}

let _clientCache = null;
async function getClientList() {
  if (_clientCache) return _clientCache;
  return new Promise((resolve) => {
    db.all(`SELECT id, name, is_critical FROM clients ORDER BY name`, (err, rows) => {
      _clientCache = rows || [];
      setTimeout(() => { _clientCache = null; }, 60000);
      resolve(_clientCache);
    });
  });
}

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
    const clientList = await getClientList();
    let added = 0, skipped = 0;
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(`
          INSERT INTO pool_tickets (id,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,prepStart,execStart,execEnd,ctRdy)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id,area) DO UPDATE SET
            serviceExecId = COALESCE(NULLIF(excluded.serviceExecId,''), pool_tickets.serviceExecId),
            subject       = COALESCE(NULLIF(excluded.subject,''),       pool_tickets.subject),
            customer      = COALESCE(NULLIF(excluded.customer,''),      pool_tickets.customer),
            prepStart     = COALESCE(NULLIF(excluded.prepStart,''),     pool_tickets.prepStart),
            execStart     = COALESCE(NULLIF(excluded.execStart,''),     pool_tickets.execStart),
            execEnd       = COALESCE(NULLIF(excluded.execEnd,''),       pool_tickets.execEnd),
            ctRdy         = COALESCE(NULLIF(excluded.ctRdy,''),         pool_tickets.ctRdy),
            priority      = COALESCE(NULLIF(excluded.priority,''),      pool_tickets.priority),
            ticketStatus  = COALESCE(NULLIF(excluded.ticketStatus,''),  pool_tickets.ticketStatus),
            updatedAt     = datetime('now')
        `);
        rows.forEach(row => {
          const t = {};
          Object.entries(row).forEach(([k,v]) => { const m=COL_MAP[normCol(k)]; if(m) t[m]=v!=null?String(v).trim():''; });
          if (!t.id || !/^\d{7,13}$/.test(t.id.replace(/\D/g,''))) { skipped++; return; }
          t.id = t.id.replace(/\D/g,'');
          syncClientName(t.customer || '', clientList); // update catalog if fuzzy match, don't touch pool name
          // Extract ctRdy from subject and use as execStart fallback if no date columns
          const ctRdyRaw = extractCtRdy(t.subject || '');
          const ctRdyIso = ctRdyRaw ? parseXlsxDate(ctRdyRaw) : '';
          const prepStart = parseXlsxDate(t.prepStart || '');
          const execStart = parseXlsxDate(t.execStart || '') || ctRdyIso;
          const execEnd   = parseXlsxDate(t.execEnd || '') || parseXlsxDate(t.plannedExecEnd || '');
          stmt.run([t.id, area, t.serviceExecId||'', t.priority||'', t.subject||'', t.customer||'',
            t.ticketStatus||'', t.comment||'', t.processor||'',
            prepStart, execStart, execEnd, ctRdyIso],
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
        INSERT INTO shift_tickets (id,shiftId,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,execEnd,ctRdy,source)
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
          COALESCE(p.execEnd,''),
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
    db.all(
      `SELECT * FROM pool_tickets WHERE area=?
       AND ((prepStart >= ? AND prepStart < ?)
         OR (execStart >= ? AND execStart < ?))`,
      [area, shiftStartUtc, shiftEndUtc, shiftStartUtc, shiftEndUtc],
      (err, rows) => err ? reject(err) : resolve(rows)
    );
  });

  let added = 0, skipped = 0;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO shift_tickets (id,shiftId,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,execEnd,ctRdy,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'execution')
        ON CONFLICT(id,shiftId) DO UPDATE SET
          serviceExecId = COALESCE(NULLIF(excluded.serviceExecId,''), shift_tickets.serviceExecId),
          prepStart     = COALESCE(NULLIF(excluded.prepStart,''),     shift_tickets.prepStart),
          execStart     = COALESCE(NULLIF(excluded.execStart,''),     shift_tickets.execStart),
          execEnd       = COALESCE(NULLIF(excluded.execEnd,''),       shift_tickets.execEnd),
          updatedAt     = datetime('now')
      `);
      rows.forEach(t => {
        stmt.run([t.id, shiftId, area, t.serviceExecId||'', t.priority||'', t.subject||'', t.customer||'',
          t.ticketStatus||'', t.comment||'', t.processor||'', t.category||'',
          t.prepStart||'', t.execStart||'', t.execEnd||'', t.ctRdy||''],
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
    `INSERT INTO shift_tickets (id,shiftId,area,serviceExecId,priority,subject,customer,ticketStatus,comment,processor,category,prepStart,execStart,execEnd,notes,ctRdy,source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')
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
     poolRow?.execEnd||'',
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
  const allowed = ['processor','category','execStart','prepStart','notes','ticketStatus','comment','priority','serviceExecId','customer','hoReview','userStatus'];
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

// Delete shift (and all its tickets + log entries)
app.delete('/api/:area/shifts/:shiftId', requireArea, (req, res) => {
  const { area, shiftId } = req.params;
  db.serialize(() => {
    db.run(`DELETE FROM shift_tickets WHERE shiftId=?`, [shiftId]);
    db.run(`DELETE FROM change_log WHERE shiftId=?`, [shiftId]);
    db.run(`DELETE FROM shifts WHERE id=? AND area=?`, [shiftId, area], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
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
    const all = await getShiftTickets(req.params.shiftId);
    // If any ticket has a hoReview value set, filter to only 'HO' tickets
    const anyReviewed = all.some(t => t.hoReview && t.hoReview !== '');
    const tickets = anyReviewed ? all.filter(t => t.hoReview === 'HO') : all;
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
    res.json({ text: lines.join('\n'), count: tickets.length, total: all.length });
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


// ── Availability Calendar ─────────────────────────────────────────────────────

// Get week (or date range)
app.get('/api/:area/calendar', requireArea, (req, res) => {
  const { area } = req.params;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  db.all(
    `SELECT * FROM availability_calendar WHERE area=? AND date>=? AND date<=? ORDER BY user_id, date`,
    [area, from, to],
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
  );
});

// Upsert single day for a user
app.put('/api/:area/calendar/:userId/:date', requireArea, (req, res) => {
  const { area, userId, date } = req.params;
  const { shift_code } = req.body;
  if (!shift_code) return res.status(400).json({ error: 'shift_code required' });
  db.run(
    `INSERT INTO availability_calendar (user_id, date, shift_code, area)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id, date, area) DO UPDATE SET shift_code=excluded.shift_code`,
    [userId, date, shift_code, area],
    (err) => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true })
  );
});

// Import Excel calendar for an area — reuses same upload middleware as pool
app.post('/api/:area/calendar/import', requireArea, upload.single('file'), async (req, res) => {
  const area = req.params.area;
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  console.log(`[calendar/import] area=${area} file=${req.file.originalname} size=${req.file.size}`);
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // Use first sheet that has a user row (User ID matching I\d{5,})
    let raw = null;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const candidate = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const hasUsers = candidate.some(row => /^I\d{5,}$/i.test(String(row[2]||'').trim()));
      if (hasUsers) { raw = candidate; break; }
    }
    if (!raw) return res.status(400).json({ error: 'No person rows found (expected User ID like I564420 in column 3)' });

    // Structure: Row 0 = CW labels, Row 1 = date serials, Row 2 = day-of-week labels, Row 3+ = person rows
    const dateRow    = raw[1] || [];
    const personRows = raw.slice(3); // skip CW row, date row, and day-of-week header row

    // Date row contains Excel serial numbers (e.g. 46023 = 2026-01-01)
    // XLSX.SSF.parse_date_code converts them
    function serialToIso(val) {
      if (!val || typeof val !== 'number') return null;
      try {
        const d = XLSX.SSF.parse_date_code(val);
        if (!d || !d.y) return null;
        return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
      } catch { return null; }
    }

    // Build date index: col index → ISO date string
    const dateIndex = {};
    dateRow.forEach((cell, i) => {
      const iso = serialToIso(cell);
      if (iso) dateIndex[i] = iso;
    });

    if (!Object.keys(dateIndex).length) {
      return res.status(400).json({ error: 'Could not parse dates from row 2 — expected Excel date serial numbers' });
    }

    // Parse shift code — strip suffix like ,CC ,SL ,AM ,TQS_EXE etc. Keep only base code
    function parseShift(val) {
      if (!val) return null;
      const base = String(val).split(',')[0].trim();
      return base || null;
    }

    let inserted = 0;
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(
          `INSERT INTO availability_calendar (user_id, date, shift_code, area)
           VALUES (?,?,?,?)
           ON CONFLICT(user_id, date, area) DO UPDATE SET shift_code=excluded.shift_code`
        );
        personRows.forEach(row => {
          const userId = String(row[2] || '').trim();
          if (!/^I\d{5,}$/i.test(userId)) return; // skip summary/blank rows
          Object.entries(dateIndex).forEach(([colIdx, isoDate]) => {
            const code = parseShift(row[colIdx]);
            if (!code) return;
            stmt.run([userId, isoDate, code, area], (err) => { if (!err) inserted++; });
          });
        });
        stmt.finalize(err => err ? reject(err) : resolve());
      });
    });
    res.json({ ok: true, inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clients (shared) ──────────────────────────────────────────────────────────

app.get('/api/clients', (req, res) => {
  db.all(`SELECT * FROM clients ORDER BY name`, (err, rows) =>
    err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

app.post('/api/clients', (req, res) => {
  const { name, is_critical = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.run(`INSERT INTO clients (name, is_critical) VALUES (?,?)`, [name.trim(), is_critical ? 1 : 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      _clientCache = null;
      db.get(`SELECT * FROM clients WHERE id=?`, [this.lastID], (e, row) => res.json(row));
    });
});

app.patch('/api/clients/:id', (req, res) => {
  const { name, is_critical, sed } = req.body;
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name.trim()); }
  if (is_critical !== undefined) { sets.push('is_critical=?'); vals.push(is_critical ? 1 : 0); }
  if (sed !== undefined) { sets.push('sed=?'); vals.push(sed); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  db.run(`UPDATE clients SET ${sets.join(',')} WHERE id=?`, vals,
    (err) => { _clientCache = null; return err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }); });
});

app.delete('/api/clients/:id', (req, res) => {
  db.run(`DELETE FROM clients WHERE id=?`, [req.params.id],
    (err) => { _clientCache = null; return err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }); });
});

// Bulk import: POST /api/clients/bulk  body: { names: ["Client A", "Client B", ...] }
app.post('/api/clients/bulk', (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'names array required' });
  let inserted = 0;
  db.serialize(() => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO clients (name, is_critical) VALUES (?, 1)`);
    names.forEach(n => { if (n && n.trim()) { stmt.run(n.trim()); inserted++; } });
    stmt.finalize(() => {
      _clientCache = null;
      res.json({ inserted });
    });
  });
});

// ── Activities per area ───────────────────────────────────────────────────────

app.get('/api/:area/activities', requireArea, (req, res) => {
  const tbl = req.params.area === 'sm' ? 'sm_activities' : 'merge_activities';
  db.all(`SELECT * FROM ${tbl} ORDER BY name`, (err, rows) =>
    err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

app.post('/api/:area/activities', requireArea, (req, res) => {
  const tbl = req.params.area === 'sm' ? 'sm_activities' : 'merge_activities';
  const { name, estimated_minutes = 60, sd_id = '', category = '', is_manual = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.run(`INSERT INTO ${tbl} (name, estimated_minutes, sd_id, category, is_manual) VALUES (?,?,?,?,?)`,
    [name.trim(), estimated_minutes, sd_id.trim(), category.trim(), is_manual ? 1 : 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM ${tbl} WHERE id=?`, [this.lastID], (e, row) => res.json(row));
    });
});

app.patch('/api/:area/activities/:id', requireArea, (req, res) => {
  const tbl = req.params.area === 'sm' ? 'sm_activities' : 'merge_activities';
  const { name, estimated_minutes, sd_id, category, is_manual } = req.body;
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name.trim()); }
  if (estimated_minutes !== undefined) { sets.push('estimated_minutes=?'); vals.push(estimated_minutes); }
  if (sd_id !== undefined) { sets.push('sd_id=?'); vals.push(sd_id.trim()); }
  if (category !== undefined) { sets.push('category=?'); vals.push(category.trim()); }
  if (is_manual !== undefined) { sets.push('is_manual=?'); vals.push(is_manual ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  db.run(`UPDATE ${tbl} SET ${sets.join(',')} WHERE id=?`, vals,
    (err) => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
});

app.delete('/api/:area/activities/:id', requireArea, (req, res) => {
  const tbl = req.params.area === 'sm' ? 'sm_activities' : 'merge_activities';
  const skillTbl = req.params.area === 'sm' ? 'sm_processor_skills' : 'merge_processor_skills';
  db.serialize(() => {
    db.run(`DELETE FROM ${skillTbl} WHERE activity_id=?`, [req.params.id]);
    db.run(`DELETE FROM ${tbl} WHERE id=?`, [req.params.id],
      (err) => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
  });
});

// ── Processor config (can_critical) ──────────────────────────────────────────

app.get('/api/processor-config', (req, res) => {
  db.all(`SELECT * FROM processor_config`, (err, rows) =>
    err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

app.put('/api/processor-config/:userId', (req, res) => {
  const { can_critical = 0 } = req.body;
  db.run(
    `INSERT INTO processor_config (user_id, can_critical) VALUES (?,?)
     ON CONFLICT(user_id) DO UPDATE SET can_critical=excluded.can_critical`,
    [req.params.userId, can_critical ? 1 : 0],
    (err) => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true })
  );
});

// ── Processor skills per area ─────────────────────────────────────────────────

app.get('/api/:area/processor-skills', requireArea, (req, res) => {
  const tbl = req.params.area === 'sm' ? 'sm_processor_skills' : 'merge_processor_skills';
  db.all(`SELECT * FROM ${tbl}`, (err, rows) =>
    err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

app.put('/api/:area/processor-skills/:userId/:activityId', requireArea, (req, res) => {
  const tbl = req.params.area === 'sm' ? 'sm_processor_skills' : 'merge_processor_skills';
  const { userId, activityId } = req.params;
  const { enabled } = req.body;
  if (enabled) {
    db.run(`INSERT OR IGNORE INTO ${tbl} (user_id, activity_id) VALUES (?,?)`, [userId, activityId],
      (err) => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
  } else {
    db.run(`DELETE FROM ${tbl} WHERE user_id=? AND activity_id=?`, [userId, activityId],
      (err) => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true }));
  }
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const [smPool, mergePool] = await Promise.all([
    getPoolTickets('sm'),
    getPoolTickets('merge'),
  ]);
  socket.emit('sm:pool:update',    smPool);
  socket.emit('merge:pool:update', mergePool);
  io.emit('users:count', io.engine.clientsCount);
  socket.on('disconnect', () => io.emit('users:count', io.engine.clientsCount));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ticketdash running on http://localhost:${PORT}`));
