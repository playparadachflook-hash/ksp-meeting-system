require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const db = require('./src/db');
const { generateMeetingBookingPdf, generateMeetingBoardPdf } = require('./src/pdf');

const app = express();
const PORT = Number(process.env.PORT || 3532);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'ksp-meeting-system-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

function nowSql() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.isAdmin) {
    return res.status(403).json({ error: 'เฉพาะผู้ดูแลห้องประชุมเท่านั้น' });
  }
  next();
}

// ==================== AUTH ====================
app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอก Username และ Password' });
  }
  const user = db
    .prepare('SELECT row_id, title, fname, lname, telephone, unit_id, usertype, puchai FROM personaldata WHERE puchai = ? AND rahuspan = ?')
    .get(String(username).trim(), String(password).trim());

  if (!user) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }

  const fullName = `${user.fname || ''} ${user.lname || ''}`.trim() || user.puchai;
  req.session.user = {
    row_id: user.row_id,
    username: user.puchai,
    fullName,
    unit_id: user.unit_id || 0,
    telephone: user.telephone || '',
    usertype: user.usertype || 'user',
    isAdmin: user.usertype === 'adminn',
  };
  res.json({ user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ==================== STATS & ECO ====================
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM bookroom').get().cnt;
  const statusRows = db.prepare('SELECT b_status, COUNT(*) AS cnt FROM bookroom GROUP BY b_status').all();
  const counts = { 0: 0, 1: 0, 6: 0, 9: 0 };
  for (const r of statusRows) {
    counts[r.b_status] = r.cnt;
  }
  res.json({
    total,
    pending: counts[0] || 0,
    approved: counts[1] || 0,
    rejected: counts[6] || 0,
    cancelled: counts[9] || 0,
    eco: {
      paper: total,
      baht: Number((total * 0.45).toFixed(2)),
      ghg: Number(((total * 0.8049) / 180).toFixed(3)),
    },
  });
});

// ==================== BOOKINGS (bookroom) ====================
function buildBookingWhere(query, user) {
  const { month, year, status, room_id, unit_id, date, q, mine } = query;
  const where = [];
  const params = [];

  if (date) {
    where.push('b.datemeet = ?');
    params.push(date);
  } else {
    if (year) {
      where.push("strftime('%Y', b.datemeet) = ?");
      params.push(String(year));
    }
    if (month && Number(month) > 0) {
      where.push("strftime('%m', b.datemeet) = ?");
      params.push(String(month).padStart(2, '0'));
    }
  }
  if (status !== undefined && status !== '') {
    where.push('b.b_status = ?');
    params.push(Number(status));
  }
  if (room_id) {
    where.push('b.room_id = ?');
    params.push(Number(room_id));
  }
  if (unit_id) {
    where.push('b.unit_id = ?');
    params.push(Number(unit_id));
  }
  if (mine === '1' && user) {
    where.push('(b.perbook = ? OR b.user_id = ?)');
    params.push(user.fullName, user.row_id);
  }
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(b.subject LIKE ? OR b.perhead LIKE ? OR b.perbook LIKE ? OR CAST(b.row_id AS TEXT) LIKE ?)');
    params.push(like, like, like, like);
  }
  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

app.get('/api/bookings', (req, res) => {
  const { whereSql, params } = buildBookingWhere(req.query, req.session.user);
  const totalRow = db.prepare(`SELECT COUNT(*) AS cnt FROM bookroom b ${whereSql}`).get(...params);

  const pageNum = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const offset = (pageNum - 1) * pageSize;

  const rows = db
    .prepare(
      `SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       ${whereSql}
       ORDER BY COALESCE(NULLIF(b.datemeet, ''), substr(b.datereg, 1, 10)) DESC, b.row_id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  const equips = db.prepare('SELECT row_id, name FROM equip').all();
  const equipMap = Object.fromEntries(equips.map((e) => [String(e.row_id), e.name]));

  const items = rows.map((row) => {
    const equipIds = (row.equip || '').split('|').filter(Boolean);
    return { ...row, equipIds, equipNames: equipIds.map((id) => equipMap[id] || id) };
  });

  res.json({
    items,
    total: totalRow.cnt,
    page: pageNum,
    limit: pageSize,
    totalPages: Math.ceil(totalRow.cnt / pageSize) || 1,
  });
});

app.get('/api/bookings/board/pdf', requireAdmin, (req, res) => {
  const { whereSql, params } = buildBookingWhere(req.query, req.session.user);
  const rows = db
    .prepare(
      `SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       ${whereSql}
       ORDER BY b.datemeet DESC, b.row_id DESC
       LIMIT 200`
    )
    .all(...params);

  const equips = db.prepare('SELECT row_id, name FROM equip').all();
  const equipMap = Object.fromEntries(equips.map((e) => [String(e.row_id), e.name]));
  const items = rows.map((row) => {
    const equipIds = (row.equip || '').split('|').filter(Boolean);
    return { ...row, equipIds, equipNames: equipIds.map((id) => equipMap[id] || id) };
  });

  const parts = [];
  if (req.query.year) parts.push(`ปี พ.ศ. ${Number(req.query.year) + 543}`);
  if (req.query.month && Number(req.query.month) > 0) parts.push(`เดือน ${req.query.month}`);
  parts.push(`จำนวน ${items.length} รายการ`);
  generateMeetingBoardPdf(items, parts.join(' | '), res, req.query.download === '1');
});

app.get('/api/bookings/:id/pdf', requireAdmin, (req, res) => {
  const row = db
    .prepare(
      `SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       WHERE b.row_id = ?`
    )
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const equips = db.prepare('SELECT row_id, name FROM equip').all();
  const equipMap = Object.fromEntries(equips.map((e) => [String(e.row_id), e.name]));
  const equipIds = (row.equip || '').split('|').filter(Boolean);
  const booking = { ...row, equipIds, equipNames: equipIds.map((id) => equipMap[id] || id) };
  generateMeetingBookingPdf(booking, res, req.query.download === '1');
});

app.get('/api/bookings/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       WHERE b.row_id = ?`
    )
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const equips = db.prepare('SELECT row_id, name FROM equip').all();
  const equipMap = Object.fromEntries(equips.map((e) => [String(e.row_id), e.name]));
  const equipIds = (row.equip || '').split('|').filter(Boolean);
  res.json({ ...row, equipIds, equipNames: equipIds.map((id) => equipMap[id] || id) });
});

app.post('/api/bookings', requireAuth, (req, res) => {
  const b = req.body;
  if (!b.subject) {
    return res.status(400).json({ error: 'กรุณากรอกหัวข้อการประชุม' });
  }
  const now = nowSql();
  const equipStr = Array.isArray(b.equipIds) && b.equipIds.length ? `${b.equipIds.join('|')}|` : '';
  const foodStr = [b.food0 ? '1' : '', b.food1 ? '1' : '', b.food2 ? '1' : ''].join('|');
  const unitId = b.unit_out ? 0 : Number(b.unit_id || 0);
  const perbook = b.perbook || req.session.user.fullName;

  const info = db
    .prepare(
      `INSERT INTO bookroom (
        datereg, subject, perhead, numper, type_conference_id, room_id,
        datemeet, s_time, e_time, equip, food, memo,
        perbook, b_status, from_ip, unit_out, unit_id, user_id, d_update
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      now,
      b.subject.trim(),
      (b.perhead || '').trim(),
      Number(b.numper || 0),
      Number(b.type_conference_id || 0),
      Number(b.room_id || 0),
      b.datemeet || now.slice(0, 10),
      b.s_time || '08:30',
      b.e_time || '16:30',
      equipStr,
      foodStr,
      (b.memo || '').trim(),
      perbook,
      req.session.user.isAdmin && b.b_status !== undefined ? Number(b.b_status) : 0,
      req.ip || '',
      (b.unit_out || '').trim(),
      unitId,
      req.session.user.row_id,
      now
    );

  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/bookings/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM bookroom WHERE row_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const isOwner = existing.perbook === req.session.user.fullName || existing.user_id === req.session.user.row_id;
  if (!req.session.user.isAdmin && !isOwner) {
    return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขการจองนี้' });
  }

  const b = req.body;
  const now = nowSql();
  const unitId = b.unit_out ? 0 : Number(b.unit_id ?? existing.unit_id);
  const equipStr = Array.isArray(b.equipIds)
    ? b.equipIds.length
      ? `${b.equipIds.join('|')}|`
      : ''
    : existing.equip;
  const foodStr =
    b.food0 !== undefined || b.food1 !== undefined || b.food2 !== undefined
      ? [b.food0 ? '1' : '', b.food1 ? '1' : '', b.food2 ? '1' : ''].join('|')
      : existing.food;

  db.prepare(
    `UPDATE bookroom SET
      subject = ?, perhead = ?, numper = ?, type_conference_id = ?,
      room_id = ?, datemeet = ?, s_time = ?, e_time = ?,
      equip = ?, food = ?, memo = ?, b_status = ?,
      unit_out = ?, unit_id = ?, d_update = ?
    WHERE row_id = ?`
  ).run(
    b.subject ?? existing.subject,
    b.perhead ?? existing.perhead,
    b.numper !== undefined ? Number(b.numper) : existing.numper,
    Number(b.type_conference_id ?? existing.type_conference_id),
    Number(b.room_id ?? existing.room_id),
    b.datemeet ?? existing.datemeet,
    b.s_time ?? existing.s_time,
    b.e_time ?? existing.e_time,
    equipStr,
    foodStr,
    b.memo ?? existing.memo,
    req.session.user.isAdmin ? Number(b.b_status ?? existing.b_status) : existing.b_status,
    b.unit_out !== undefined ? b.unit_out : existing.unit_out,
    unitId,
    now,
    id
  );

  res.json({ ok: true });
});

app.patch('/api/bookings/:id/approve', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM bookroom WHERE row_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const { b_status, room_id, assigned_to, memo } = req.body;

  db.prepare(
    `UPDATE bookroom SET b_status = ?, room_id = ?, assigned_to = ?, memo = ?, d_update = ? WHERE row_id = ?`
  ).run(
    Number(b_status ?? existing.b_status),
    room_id !== undefined ? Number(room_id) : existing.room_id,
    (assigned_to ?? existing.assigned_to ?? '').trim(),
    memo !== undefined ? memo : existing.memo,
    nowSql(),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM bookroom WHERE row_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== REPORTS ====================
app.get('/api/reports/summary', (req, res) => {
  const { year, month } = req.query;
  const where = [];
  const params = [];
  if (year) {
    where.push("strftime('%Y', b.datemeet) = ?");
    params.push(String(year));
  }
  if (month && Number(month) > 0) {
    where.push("strftime('%m', b.datemeet) = ?");
    params.push(String(month).padStart(2, '0'));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const byDepartment = db
    .prepare(
      `SELECT COALESCE(NULLIF(u.unit_name, ''), NULLIF(b.unit_out, ''), 'ไม่ระบุหน่วยงาน') AS name,
              COUNT(*) AS total,
              COALESCE(SUM(b.numper), 0) AS total_people
       FROM bookroom b
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       ${whereSql}
       GROUP BY name
       ORDER BY total DESC`
    )
    .all(...params);

  const byRoom = db
    .prepare(
      `SELECT COALESCE(r.name, 'ไม่ระบุห้อง') AS name,
              COUNT(*) AS total,
              COALESCE(SUM(b.numper), 0) AS total_people
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       ${whereSql}
       GROUP BY b.room_id
       ORDER BY total DESC`
    )
    .all(...params);

  const byStatus = db
    .prepare(`SELECT b.b_status, COUNT(*) AS total FROM bookroom b ${whereSql} GROUP BY b.b_status`)
    .all(...params);

  const equips = db.prepare('SELECT row_id, name FROM equip ORDER BY row_id').all();
  const rows = db.prepare(`SELECT equip, unit_out FROM bookroom b ${whereSql}`).all(...params);

  const byEquipment = equips.map((e) => ({
    row_id: e.row_id,
    name: e.name,
    total: rows.filter((t) => (t.equip || '').split('|').includes(String(e.row_id))).length,
  }));

  res.json({
    byDepartment,
    byRoom,
    byStatus,
    byEquipment,
    internalCount: rows.filter((t) => !t.unit_out).length,
    externalCount: rows.filter((t) => !!t.unit_out).length,
  });
});

// ==================== CONFERENCE TYPES ====================
app.get('/api/conference-types', (req, res) => {
  res.json(db.prepare('SELECT * FROM type_conference ORDER BY type_conference_id ASC').all());
});

// ==================== ROOMS (room) ====================
app.get('/api/rooms', (req, res) => {
  res.json(db.prepare('SELECT * FROM room ORDER BY row_id ASC').all());
});

app.post('/api/rooms', requireAdmin, (req, res) => {
  const { name, place, numper, tel, memo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อห้องประชุม' });
  const info = db
    .prepare('INSERT INTO room (name, place, numper, tel, memo, d_update) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), place || '', numper || '0', tel || '', memo || '', nowSql());
  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/rooms/:id', requireAdmin, (req, res) => {
  const { name, place, numper, tel, memo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อห้องประชุม' });
  db.prepare('UPDATE room SET name = ?, place = ?, numper = ?, tel = ?, memo = ?, d_update = ? WHERE row_id = ?').run(
    name.trim(), place || '', numper || '0', tel || '', memo || '', nowSql(), Number(req.params.id)
  );
  res.json({ ok: true });
});

app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM room WHERE row_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== EQUIPMENT (equip) ====================
app.get('/api/equipment', (req, res) => {
  res.json(db.prepare('SELECT * FROM equip ORDER BY row_id ASC').all());
});

app.post('/api/equipment', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่ออุปกรณ์' });
  const info = db.prepare('INSERT INTO equip (name, d_update) VALUES (?, ?)').run(name.trim(), nowSql());
  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/equipment/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่ออุปกรณ์' });
  db.prepare('UPDATE equip SET name = ?, d_update = ? WHERE row_id = ?').run(name.trim(), nowSql(), Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/equipment/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM equip WHERE row_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== UNITS (unit_all) ====================
app.get('/api/units', (req, res) => {
  res.json(db.prepare('SELECT * FROM unit_all ORDER BY unit_name ASC').all());
});

app.post('/api/units', requireAdmin, (req, res) => {
  const { unit_code, unit_name, unit_head, tel } = req.body;
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อหน่วยงาน' });
  const info = db
    .prepare('INSERT INTO unit_all (unit_code, unit_name, unit_head, tel, d_update) VALUES (?, ?, ?, ?, ?)')
    .run(unit_code || '', unit_name.trim(), unit_head || '', tel || '', nowSql());
  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/units/:id', requireAdmin, (req, res) => {
  const { unit_code, unit_name, unit_head, tel } = req.body;
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อหน่วยงาน' });
  db.prepare('UPDATE unit_all SET unit_code = ?, unit_name = ?, unit_head = ?, tel = ?, d_update = ? WHERE row_id = ?').run(
    unit_code || '', unit_name.trim(), unit_head || '', tel || '', nowSql(), Number(req.params.id)
  );
  res.json({ ok: true });
});

app.delete('/api/units/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM unit_all WHERE row_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== USERS (personaldata) ====================
app.get('/api/users', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.row_id, p.title, p.fname, p.lname, p.telephone, p.unit_id, p.usertype, p.puchai, u.unit_name
       FROM personaldata p
       LEFT JOIN unit_all u ON u.row_id = p.unit_id
       ORDER BY p.row_id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan } = req.body;
  if (!fname || !puchai || !rahuspan) {
    return res.status(400).json({ error: 'กรุณากรอก ชื่อ, Username และ Password' });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO personaldata (title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan, d_update)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title || '', fname.trim(), lname || '', telephone || '', Number(unit_id || 0), usertype === 'adminn' ? 'adminn' : 'user', puchai.trim(), rahuspan.trim(), nowSql());
    res.status(201).json({ row_id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Username นี้มีอยู่ในระบบแล้ว' });
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM personaldata WHERE row_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });

  const { title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan } = req.body;
  db.prepare(
    `UPDATE personaldata SET title = ?, fname = ?, lname = ?, telephone = ?, unit_id = ?, usertype = ?, puchai = ?, rahuspan = ?, d_update = ? WHERE row_id = ?`
  ).run(
    title ?? existing.title,
    fname ?? existing.fname,
    lname ?? existing.lname,
    telephone ?? existing.telephone,
    Number(unit_id ?? existing.unit_id),
    usertype === 'adminn' ? 'adminn' : 'user',
    puchai ?? existing.puchai,
    rahuspan ? rahuspan : existing.rahuspan,
    nowSql(),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM personaldata WHERE row_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KSP Meeting System running at http://0.0.0.0:${PORT}`);
});
