const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ticketdash.db');

// Ensure data directory exists (for Docker volume path)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH);

// ── Schema ────────────────────────────────────────────────────────────────────
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
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
    )
  `);
  // migrate existing DB if column missing
  db.run(`ALTER TABLE tickets ADD COLUMN validation TEXT DEFAULT 'pending'`, () => {});
  db.run(`ALTER TABLE tickets ADD COLUMN prepStart  TEXT DEFAULT ''`, () => {});
});

// ── DB helpers ────────────────────────────────────────────────────────────────
const ORDER_SQL = `ORDER BY CASE priority
  WHEN 'Very High' THEN 1 WHEN 'High' THEN 2
  WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, createdAt ASC`;

function allTickets() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM tickets ${ORDER_SQL}`, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function broadcastAll() {
  return allTickets().then(rows => io.emit('tickets:update', rows));
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/tickets', async (req, res) => {
  try { res.json(await allTickets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/handover', async (req, res) => {
  const { raw } = req.body;
  if (!raw) return res.status(400).json({ error: 'No raw text provided' });

  const parsed = parseHandover(raw);
  if (parsed.length === 0) return res.status(400).json({ error: 'No tickets found in pasted text' });

  let added = 0, skipped = 0;
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tickets (id,priority,subject,ticketStatus,comment,ctRdy,category,userStatus)
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

  await broadcastAll();
  res.json({ added, skipped });
});

app.post('/api/tickets/single', async (req, res) => {
  const { id, priority, subject, ticketStatus, comment, processor, category, prepStart, execStart, ctRdy, notes } = req.body;
  if (!id || !/^\d{7,13}$/.test(id.trim())) return res.status(400).json({ error: 'Invalid ticket ID' });

  db.run(
    `INSERT OR IGNORE INTO tickets (id,priority,subject,ticketStatus,comment,processor,category,prepStart,execStart,ctRdy,notes,userStatus)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'new')`,
    [id.trim(),priority||'',subject||'',ticketStatus||'',comment||'',processor||'',category||'',prepStart||'',execStart||'',ctRdy||'',notes||''],
    async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      await broadcastAll();
      res.json({ ok: true });
    }
  );
});

app.patch('/api/tickets/:id', async (req, res) => {
  const allowed = ['processor','category','execStart','prepStart','userStatus','validation','notes','ticketStatus','comment','priority'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(updates), req.params.id];

  db.run(
    `UPDATE tickets SET ${sets}, updatedAt = datetime('now') WHERE id = ?`,
    vals,
    async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      await broadcastAll();
      res.json({ ok: true });
    }
  );
});

app.delete('/api/tickets/:id', (req, res) => {
  db.run('DELETE FROM tickets WHERE id = ?', [req.params.id], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await broadcastAll();
    res.json({ ok: true });
  });
});

app.delete('/api/tickets', (req, res) => {
  db.run('DELETE FROM tickets', async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('tickets:update', []);
    res.json({ ok: true });
  });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  socket.emit('tickets:update', await allTickets());
  io.emit('users:count', io.engine.clientsCount);
  socket.on('disconnect', () => io.emit('users:count', io.engine.clientsCount));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ticketdash running on http://localhost:${PORT}`));
