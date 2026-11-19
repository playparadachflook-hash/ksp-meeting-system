require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const db = require('./src/db');
const { generateMeetingBookingPdf, generateMeetingBoardPdf, generateReportSectionPdf } = require('./src/pdf');
const { registerMophProviderRoutes } = require('./src/mophAuth');

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
app.get('/api/auth/me', async (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอก Username และ Password' });
  }
  const user = (await db.get('SELECT row_id, title, fname, lname, telephone, unit_id, usertype, puchai FROM personaldata WHERE puchai = ? AND rahuspan = ?', [String(username).trim(), String(password).trim()]));

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

app.post('/api/auth/logout', async (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

registerMophProviderRoutes(app, {
  resolveSessionUser: async (profile, opdUser) => {
    const loginname = String(opdUser.loginname || '').trim();
    const firstTh = String(profile.firstname_th || '').trim();
    const lastTh = String(profile.lastname_th || '').trim();
    const titleTh = String(profile.special_title_th || profile.title_th || '').trim();
    const cols = 'row_id, title, fname, lname, telephone, unit_id, usertype, puchai';
    let user = (await db.get(`SELECT ${cols} FROM personaldata WHERE LOWER(puchai) = LOWER(?) LIMIT 1`, [loginname]));
    if (!user && firstTh && lastTh) {
      user = (await db.get(`SELECT ${cols} FROM personaldata WHERE fname LIKE ? AND lname LIKE ? LIMIT 1`, [`%${firstTh}%`, `%${lastTh}%`]));
    }
    if (!user) {
      const f = firstTh || String(opdUser.name || loginname).split(/\s+/)[0] || loginname;
      const l = lastTh || String(opdUser.name || '').split(/\s+/).slice(1).join(' ');
      const info = await db.run("INSERT INTO personaldata (title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan) VALUES (?, ?, ?, '', 0, 'user', ?, '')", [titleTh, f, l, loginname || `moph_${Date.now()}`]);
      user = (await db.get(`SELECT ${cols} FROM personaldata WHERE row_id = ?`, [info.lastInsertRowid]));
    }
    const fullName = `${user.fname || ''} ${user.lname || ''}`.trim() || user.puchai;
    return {
      row_id: user.row_id,
      username: user.puchai,
      fullName,
      unit_id: user.unit_id || 0,
      telephone: user.telephone || '',
      usertype: user.usertype || 'user',
      isAdmin: user.usertype === 'adminn',
    };
  },
});

// ==================== STATS & ECO ====================
app.get('/api/stats', async (req, res) => {
  const total = (await db.get('SELECT COUNT(*) AS cnt FROM bookroom')).cnt;
  const statusRows = (await db.all('SELECT b_status, COUNT(*) AS cnt FROM bookroom GROUP BY b_status'));
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
      where.push("DATE_FORMAT(b.datemeet, '%Y') = ?");
      params.push(String(year));
    }
    if (month && Number(month) > 0) {
      where.push("DATE_FORMAT(b.datemeet, '%m') = ?");
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
    where.push('(b.subject LIKE ? OR b.perhead LIKE ? OR b.perbook LIKE ? OR CAST(b.row_id AS CHAR) LIKE ?)');
    params.push(like, like, like, like);
  }
  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

app.get('/api/bookings', async (req, res) => {
  const { whereSql, params } = buildBookingWhere(req.query, req.session.user);
  const totalRow = (await db.get(`SELECT COUNT(*) AS cnt FROM bookroom b ${whereSql}`, params));

  const pageNum = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const offset = (pageNum - 1) * pageSize;

  const rows = (await db.all(`SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       ${whereSql}
       ORDER BY COALESCE(NULLIF(b.datemeet, ''), substr(b.datereg, 1, 10)) DESC, b.row_id DESC
       LIMIT ? OFFSET ?`, [...params, pageSize, offset]));

  const equips = (await db.all('SELECT row_id, name FROM equip'));
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

app.get('/api/bookings/board/pdf', requireAdmin, async (req, res) => {
  const { whereSql, params } = buildBookingWhere(req.query, req.session.user);
  const rows = (await db.all(`SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       ${whereSql}
       ORDER BY b.datemeet DESC, b.row_id DESC
       LIMIT 200`, params));

  const equips = (await db.all('SELECT row_id, name FROM equip'));
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

app.get('/api/bookings/:id/pdf', requireAdmin, async (req, res) => {
  const row = (await db.get(`SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       WHERE b.row_id = ?`, [Number(req.params.id)]));
  if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const equips = (await db.all('SELECT row_id, name FROM equip'));
  const equipMap = Object.fromEntries(equips.map((e) => [String(e.row_id), e.name]));
  const equipIds = (row.equip || '').split('|').filter(Boolean);
  const booking = { ...row, equipIds, equipNames: equipIds.map((id) => equipMap[id] || id) };
  generateMeetingBookingPdf(booking, res, req.query.download === '1');
});

app.get('/api/bookings/:id', async (req, res) => {
  const row = (await db.get(`SELECT b.*, r.name AS room_name, u.unit_name AS unit_name, tc.type_conference_name
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       LEFT JOIN type_conference tc ON tc.type_conference_id = b.type_conference_id
       WHERE b.row_id = ?`, [Number(req.params.id)]));
  if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const equips = (await db.all('SELECT row_id, name FROM equip'));
  const equipMap = Object.fromEntries(equips.map((e) => [String(e.row_id), e.name]));
  const equipIds = (row.equip || '').split('|').filter(Boolean);
  res.json({ ...row, equipIds, equipNames: equipIds.map((id) => equipMap[id] || id) });
});

app.post('/api/bookings', requireAuth, async (req, res) => {
  const b = req.body;
  if (!b.subject) {
    return res.status(400).json({ error: 'กรุณากรอกหัวข้อการประชุม' });
  }
  const now = nowSql();
  const equipStr = Array.isArray(b.equipIds) && b.equipIds.length ? `${b.equipIds.join('|')}|` : '';
  const foodStr = [b.food0 ? '1' : '', b.food1 ? '1' : '', b.food2 ? '1' : ''].join('|');
  const unitId = b.unit_out ? 0 : Number(b.unit_id || 0);
  const perbook = b.perbook || req.session.user.fullName;

  const info = (await db.run(`INSERT INTO bookroom (
        datereg, subject, perhead, numper, type_conference_id, room_id,
        datemeet, s_time, e_time, equip, food, memo,
        perbook, b_status, from_ip, unit_out, unit_id, user_id, d_update
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [now,
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
      now]));

  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/bookings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await db.get('SELECT * FROM bookroom WHERE row_id = ?', [id]));
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

  (await db.run(`UPDATE bookroom SET
      subject = ?, perhead = ?, numper = ?, type_conference_id = ?,
      room_id = ?, datemeet = ?, s_time = ?, e_time = ?,
      equip = ?, food = ?, memo = ?, b_status = ?,
      unit_out = ?, unit_id = ?, d_update = ?
    WHERE row_id = ?`, [b.subject ?? existing.subject,
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
    id]));

  res.json({ ok: true });
});

app.patch('/api/bookings/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await db.get('SELECT * FROM bookroom WHERE row_id = ?', [id]));
  if (!existing) return res.status(404).json({ error: 'ไม่พบข้อมูลการจองห้องประชุม' });

  const { b_status, room_id, assigned_to, memo } = req.body;

  (await db.run(`UPDATE bookroom SET b_status = ?, room_id = ?, assigned_to = ?, memo = ?, d_update = ? WHERE row_id = ?`, [Number(b_status ?? existing.b_status),
    room_id !== undefined ? Number(room_id) : existing.room_id,
    (assigned_to ?? existing.assigned_to ?? '').trim(),
    memo !== undefined ? memo : existing.memo,
    nowSql(),
    id]));
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
  (await db.run('DELETE FROM bookroom WHERE row_id = ?', [Number(req.params.id)]));
  res.json({ ok: true });
});

// ==================== REPORTS ====================
function buildReportFilter(query, col = 'b.datemeet') {
  const { date, year, month, fiscalYear } = query;
  const where = [];
  const params = [];
  const desc = [];

  if (date) {
    where.push(`${col} = ?`);
    params.push(date);
    desc.push(`วันที่ ${date}`);
  } else if (fiscalYear) {
    const fy = Number(fiscalYear);
    const ce = fy > 2400 ? fy - 543 : fy;
    const start = `${ce - 1}-10-01`;
    const end = `${ce}-09-30`;
    where.push(`${col} >= ? AND ${col} <= ?`);
    params.push(start, end);
    desc.push(`ปีงบประมาณ ${ce + 543} (${start} ถึง ${end})`);
  } else {
    if (year) {
      where.push(`DATE_FORMAT(${col}, '%Y') = ?`);
      params.push(String(year));
      desc.push(`ปี พ.ศ. ${Number(year) + 543}`);
    }
    if (month && Number(month) > 0) {
      where.push(`DATE_FORMAT(${col}, '%m') = ?`);
      params.push(String(month).padStart(2, '0'));
      desc.push(`เดือน ${month}`);
    }
  }
  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    filterDesc: desc.join(' | ') || 'ข้อมูลทั้งหมด',
  };
}

async function getMeetingReportData(query) {
  const { whereSql, params, filterDesc } = buildReportFilter(query);

  const byDepartment = (await db.all(`SELECT COALESCE(NULLIF(u.unit_name, ''), NULLIF(b.unit_out, ''), 'ไม่ระบุหน่วยงาน') AS name,
              COUNT(*) AS total,
              COALESCE(SUM(b.numper), 0) AS total_people
       FROM bookroom b
       LEFT JOIN unit_all u ON u.row_id = b.unit_id
       ${whereSql}
       GROUP BY name
       ORDER BY total DESC`, params));

  const byRoom = (await db.all(`SELECT COALESCE(r.name, 'ไม่ระบุห้อง') AS name,
              COUNT(*) AS total,
              COALESCE(SUM(b.numper), 0) AS total_people
       FROM bookroom b
       LEFT JOIN room r ON r.row_id = b.room_id
       ${whereSql}
       GROUP BY b.room_id
       ORDER BY total DESC`, params));

  const byStatus = (await db.all(`SELECT b.b_status, COUNT(*) AS total FROM bookroom b ${whereSql} GROUP BY b.b_status`, params));

  const equips = (await db.all('SELECT row_id, name FROM equip ORDER BY row_id'));
  const rows = (await db.all(`SELECT equip, unit_out FROM bookroom b ${whereSql}`, params));

  const byEquipment = equips.map((e) => ({
    row_id: e.row_id,
    name: e.name,
    total: rows.filter((t) => (t.equip || '').split('|').includes(String(e.row_id))).length,
  }));

  return {
    filterDesc,
    byDepartment,
    byRoom,
    byStatus,
    byEquipment,
    internalCount: rows.filter((t) => !t.unit_out).length,
    externalCount: rows.filter((t) => !!t.unit_out).length,
  };
}

app.get('/api/reports/summary', async (req, res) => {
  res.json(await getMeetingReportData(req.query));
});

app.get('/api/reports/pdf', requireAdmin, async (req, res) => {
  const { section = 'room', download } = req.query;
  const data = await getMeetingReportData(req.query);
  const isDl = download === '1';

  if (section === 'room') {
    const cols = [
      { label: 'ลำดับ', w: 42, align: 'center' },
      { label: 'ห้องประชุม', w: 270 },
      { label: 'จำนวน (ครั้ง)', w: 95, align: 'center' },
      { label: 'ผู้เข้าร่วม (คน)', w: 116, align: 'right' },
    ];
    const rows = data.byRoom.map((r, i) => [i + 1, r.name, r.total, Number(r.total_people).toLocaleString()]);
    return generateReportSectionPdf('รายงานสรุปการใช้ห้องประชุม', data.filterDesc, cols, rows, res, isDl);
  }
  if (section === 'department') {
    const cols = [
      { label: 'ลำดับ', w: 42, align: 'center' },
      { label: 'หน่วยงาน', w: 270 },
      { label: 'จำนวน (ครั้ง)', w: 95, align: 'center' },
      { label: 'ผู้เข้าร่วม (คน)', w: 116, align: 'right' },
    ];
    const rows = data.byDepartment.map((d, i) => [i + 1, d.name, d.total, Number(d.total_people).toLocaleString()]);
    return generateReportSectionPdf('รายงานสรุปการใช้ห้องประชุมตามหน่วยงาน', data.filterDesc, cols, rows, res, isDl);
  }
  if (section === 'equipment') {
    const cols = [
      { label: 'ลำดับ', w: 45, align: 'center' },
      { label: 'อุปกรณ์โสตทัศนูปกรณ์', w: 350 },
      { label: 'จำนวน (ครั้ง)', w: 128, align: 'center' },
    ];
    const rows = data.byEquipment.map((e, i) => [i + 1, e.name, e.total]);
    return generateReportSectionPdf('รายงานสรุปการใช้อุปกรณ์ห้องประชุม', data.filterDesc, cols, rows, res, isDl);
  }
  const STATUS_NAMES = { 0: 'รออนุมัติ', 1: 'อนุมัติแล้ว', 6: 'ไม่อนุมัติ', 9: 'ยกเลิกการจอง' };
  const cols = [
    { label: 'รายการ', w: 350 },
    { label: 'จำนวน (ครั้ง)', w: 173, align: 'center' },
  ];
  const rows = [
    ...data.byStatus.map((s) => [STATUS_NAMES[s.b_status] || s.b_status, s.total]),
    ['ภายในโรงพยาบาล', data.internalCount],
    ['หน่วยงานภายนอก', data.externalCount],
  ];
  return generateReportSectionPdf('รายงานสรุปตามสถานะและพื้นที่', data.filterDesc, cols, rows, res, isDl);
});

// ==================== CONFERENCE TYPES ====================
app.get('/api/conference-types', async (req, res) => {
  res.json((await db.all('SELECT * FROM type_conference ORDER BY type_conference_id ASC')));
});

// ==================== ROOMS (room) ====================
app.get('/api/rooms', async (req, res) => {
  res.json((await db.all('SELECT * FROM room ORDER BY row_id ASC')));
});

app.post('/api/rooms', requireAdmin, async (req, res) => {
  const { name, place, numper, tel, memo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อห้องประชุม' });
  const info = (await db.run('INSERT INTO room (name, place, numper, tel, memo, d_update) VALUES (?, ?, ?, ?, ?, ?)', [name.trim(), place || '', numper || '0', tel || '', memo || '', nowSql()]));
  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/rooms/:id', requireAdmin, async (req, res) => {
  const { name, place, numper, tel, memo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อห้องประชุม' });
  (await db.run('UPDATE room SET name = ?, place = ?, numper = ?, tel = ?, memo = ?, d_update = ? WHERE row_id = ?', [name.trim(), place || '', numper || '0', tel || '', memo || '', nowSql(), Number(req.params.id)]));
  res.json({ ok: true });
});

app.delete('/api/rooms/:id', requireAdmin, async (req, res) => {
  (await db.run('DELETE FROM room WHERE row_id = ?', [Number(req.params.id)]));
  res.json({ ok: true });
});

// ==================== EQUIPMENT (equip) ====================
app.get('/api/equipment', async (req, res) => {
  res.json((await db.all('SELECT * FROM equip ORDER BY row_id ASC')));
});

app.post('/api/equipment', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่ออุปกรณ์' });
  const info = (await db.run('INSERT INTO equip (name, d_update) VALUES (?, ?)', [name.trim(), nowSql()]));
  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/equipment/:id', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่ออุปกรณ์' });
  (await db.run('UPDATE equip SET name = ?, d_update = ? WHERE row_id = ?', [name.trim(), nowSql(), Number(req.params.id)]));
  res.json({ ok: true });
});

app.delete('/api/equipment/:id', requireAdmin, async (req, res) => {
  (await db.run('DELETE FROM equip WHERE row_id = ?', [Number(req.params.id)]));
  res.json({ ok: true });
});

// ==================== UNITS (unit_all) ====================
app.get('/api/units', async (req, res) => {
  res.json((await db.all('SELECT * FROM unit_all ORDER BY unit_name ASC')));
});

app.post('/api/units', requireAdmin, async (req, res) => {
  const { unit_code, unit_name, unit_head, tel } = req.body;
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อหน่วยงาน' });
  const info = (await db.run('INSERT INTO unit_all (unit_code, unit_name, unit_head, tel, d_update) VALUES (?, ?, ?, ?, ?)', [unit_code || '', unit_name.trim(), unit_head || '', tel || '', nowSql()]));
  res.status(201).json({ row_id: info.lastInsertRowid });
});

app.put('/api/units/:id', requireAdmin, async (req, res) => {
  const { unit_code, unit_name, unit_head, tel } = req.body;
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อหน่วยงาน' });
  (await db.run('UPDATE unit_all SET unit_code = ?, unit_name = ?, unit_head = ?, tel = ?, d_update = ? WHERE row_id = ?', [unit_code || '', unit_name.trim(), unit_head || '', tel || '', nowSql(), Number(req.params.id)]));
  res.json({ ok: true });
});

app.delete('/api/units/:id', requireAdmin, async (req, res) => {
  (await db.run('DELETE FROM unit_all WHERE row_id = ?', [Number(req.params.id)]));
  res.json({ ok: true });
});

// ==================== USERS (personaldata) ====================
app.get('/api/users', requireAdmin, async (req, res) => {
  const rows = (await db.all(`SELECT p.row_id, p.title, p.fname, p.lname, p.telephone, p.unit_id, p.usertype, p.puchai, u.unit_name
       FROM personaldata p
       LEFT JOIN unit_all u ON u.row_id = p.unit_id
       ORDER BY p.row_id DESC`));
  res.json(rows);
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan } = req.body;
  if (!fname || !puchai || !rahuspan) {
    return res.status(400).json({ error: 'กรุณากรอก ชื่อ, Username และ Password' });
  }
  try {
    const info = (await db.run(`INSERT INTO personaldata (title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan, d_update)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [title || '', fname.trim(), lname || '', telephone || '', Number(unit_id || 0), usertype === 'adminn' ? 'adminn' : 'user', puchai.trim(), rahuspan.trim(), nowSql()]));
    res.status(201).json({ row_id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Username นี้มีอยู่ในระบบแล้ว' });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await db.get('SELECT * FROM personaldata WHERE row_id = ?', [id]));
  if (!existing) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });

  const { title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan } = req.body;
  (await db.run(`UPDATE personaldata SET title = ?, fname = ?, lname = ?, telephone = ?, unit_id = ?, usertype = ?, puchai = ?, rahuspan = ?, d_update = ? WHERE row_id = ?`, [title ?? existing.title,
    fname ?? existing.fname,
    lname ?? existing.lname,
    telephone ?? existing.telephone,
    Number(unit_id ?? existing.unit_id),
    usertype === 'adminn' ? 'adminn' : 'user',
    puchai ?? existing.puchai,
    rahuspan ? rahuspan : existing.rahuspan,
    nowSql(),
    id]));
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  (await db.run('DELETE FROM personaldata WHERE row_id = ?', [Number(req.params.id)]));
  res.json({ ok: true });
});

app.get('*', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KSP Meeting System running at http://0.0.0.0:${PORT}`);
});
