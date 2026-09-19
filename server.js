const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'attendly.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    baseline_date TEXT NOT NULL DEFAULT '',
    saturday_off INTEGER NOT NULL DEFAULT 1,
    sunday_off INTEGER NOT NULL DEFAULT 1
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);
  CREATE TABLE IF NOT EXISTS subjects (
    name TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS timetable (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    day TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    teacher TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS baseline (
    subject TEXT PRIMARY KEY,
    held INTEGER NOT NULL DEFAULT 0,
    attended INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS attendance_records (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    class_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('attended','bunked','cancelled'))
  );
  CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT 'College holiday'
  );
`);

function readState() {
  const settings = db.prepare('SELECT baseline_date, saturday_off, sunday_off FROM settings WHERE id = 1').get();
  return {
    subjects: db.prepare('SELECT name FROM subjects ORDER BY name').all().map(r => r.name),
    timetable: db.prepare('SELECT id, subject, day, time, teacher FROM timetable ORDER BY day, time, subject').all(),
    records: db.prepare('SELECT id, date, class_id AS classId, subject, status FROM attendance_records ORDER BY date, subject').all(),
    holidays: db.prepare('SELECT date, note FROM holidays ORDER BY date').all(),
    weekendOff: { Saturday: Boolean(settings.saturday_off), Sunday: Boolean(settings.sunday_off) },
    baseline: {
      date: settings.baseline_date,
      items: db.prepare('SELECT subject, held, attended FROM baseline ORDER BY subject').all()
    }
  };
}

function asState(input) {
  const state = input || {};
  const weekendOff = state.weekendOff || {};
  const baseline = state.baseline || {};
  return {
    subjects: Array.isArray(state.subjects) ? state.subjects : [],
    timetable: Array.isArray(state.timetable) ? state.timetable : [],
    records: Array.isArray(state.records) ? state.records : [],
    holidays: Array.isArray(state.holidays) ? state.holidays : [],
    weekendOff: { Saturday: weekendOff.Saturday !== false, Sunday: weekendOff.Sunday !== false },
    baseline: { date: baseline.date || '', items: Array.isArray(baseline.items) ? baseline.items : [] }
  };
}

function writeState(input) {
  const state = asState(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DELETE FROM subjects; DELETE FROM timetable; DELETE FROM baseline; DELETE FROM attendance_records; DELETE FROM holidays;`);
    const set = db.prepare('UPDATE settings SET baseline_date = ?, saturday_off = ?, sunday_off = ? WHERE id = 1');
    set.run(state.baseline.date, state.weekendOff.Saturday ? 1 : 0, state.weekendOff.Sunday ? 1 : 0);
    const subject = db.prepare('INSERT OR IGNORE INTO subjects (name) VALUES (?)');
    for (const name of state.subjects) if (typeof name === 'string' && name.trim()) subject.run(name.trim());
    const timetable = db.prepare('INSERT INTO timetable (id, subject, day, time, teacher) VALUES (?, ?, ?, ?, ?)');
    for (const row of state.timetable) timetable.run(String(row.id), String(row.subject || ''), String(row.day || ''), String(row.time || ''), String(row.teacher || ''));
    const baseline = db.prepare('INSERT INTO baseline (subject, held, attended) VALUES (?, ?, ?)');
    for (const row of state.baseline.items) baseline.run(String(row.subject || ''), Number(row.held) || 0, Number(row.attended) || 0);
    const record = db.prepare('INSERT INTO attendance_records (id, date, class_id, subject, status) VALUES (?, ?, ?, ?, ?)');
    for (const row of state.records) record.run(String(row.id), String(row.date || ''), String(row.classId || ''), String(row.subject || ''), String(row.status || 'cancelled'));
    const holiday = db.prepare('INSERT INTO holidays (date, note) VALUES (?, ?)');
    for (const row of state.holidays) holiday.run(String(row.date || ''), String(row.note || 'College holiday'));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function collect(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function parseGeminiResponse(payload) {
  const raw = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Gemini returned an unexpected format');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error('Gemini did not return a timetable list');
  const allowedDays = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  return parsed
    .map((row, index) => ({
      id: `ai-${Date.now()}-${index}`,
      day: String(row.day || '').trim(),
      subject: String(row.subject || '').trim(),
      time: String(row.time || '').trim(),
      teacher: String(row.teacher || '').trim()
    }))
    .filter(row => allowedDays.has(row.day) && row.subject);
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && req.url === '/api/state') return send(res, 200, readState());
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, database: DB_PATH });
    if (req.method === 'POST' && req.url === '/api/parse-timetable') {
      if (!process.env.GEMINI_API_KEY) return send(res, 503, { error: 'Gemini is not configured. Set GEMINI_API_KEY on the server.' });
      const { text } = JSON.parse(await collect(req));
      if (!text || String(text).length > 10000) return send(res, 400, { error: 'Please provide timetable text under 10,000 characters.' });
      const prompt = `You extract a college timetable. Return ONLY a valid JSON array, with no Markdown or explanation. Each item must have exactly these string fields: day, subject, time, teacher. Use one of Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday for day. If time or teacher is missing, use an empty string. Do not invent classes. Timetable text:\n${String(text)}`;
      const apiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } })
      });
      const payload = await apiResponse.json();
      if (!apiResponse.ok) return send(res, 502, { error: payload?.error?.message || 'Gemini request failed' });
      return send(res, 200, { items: parseGeminiResponse(payload) });
    }
    if (req.method === 'PUT' && req.url === '/api/state') {
      const body = JSON.parse(await collect(req));
      writeState(body);
      return send(res, 200, readState());
    }
    if (req.method === 'GET') {
      const requested = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
      const filePath = path.resolve(ROOT, file);
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return send(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Attendly running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
