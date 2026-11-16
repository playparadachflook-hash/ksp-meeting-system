require('dotenv').config();
const mysql = require('mysql2/promise');
const iconv = require('iconv-lite');
const db = require('../src/db');

function smartDecode(val) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'string') return String(val);

  const buf = Buffer.from(val, 'latin1');
  let hasUtf8Thai = false;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xe0 && (buf[i + 1] === 0xb8 || buf[i + 1] === 0xb9) && buf[i + 2] >= 0x80 && buf[i + 2] <= 0xbf) {
      hasUtf8Thai = true;
      break;
    }
  }
  if (hasUtf8Thai) {
    return buf.toString('utf8');
  }
  return iconv.decode(buf, 'win874');
}

function cleanDate(val, fallbackDate) {
  if (!val || val === '0000-00-00' || val === '0000-00-00 00:00:00') return null;
  const s = String(val);
  const year = Number(s.slice(0, 4));
  if (year > 2035 && fallbackDate && !String(fallbackDate).startsWith('0000')) {
    return `${String(fallbackDate).slice(0, 4)}${s.slice(4)}`;
  }
  return s;
}

async function migrate() {
  const host = process.env.LEGACY_MYSQL_HOST || '192.168.2.254';
  const port = Number(process.env.LEGACY_MYSQL_PORT || 3306);
  const user = process.env.LEGACY_MYSQL_USER || 'opd';
  const password = process.env.LEGACY_MYSQL_PASS || 'opd';
  const database = process.env.LEGACY_MYSQL_DB || 'metting';

  console.log(`Connecting to legacy MySQL at ${host}:${port}/${database}...`);
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    charset: 'LATIN1_SWEDISH_CI',
    dateStrings: true,
    typeCast: (field, next) => {
      if (field.type === 'VAR_STRING' || field.type === 'STRING' || field.type === 'BLOB' || field.type === 'TINY_BLOB' || field.type === 'MEDIUM_BLOB' || field.type === 'LONG_BLOB') {
        const buf = field.buffer();
        if (!buf) return null;
        return buf.toString('latin1');
      }
      return next();
    },
  });

  try {
    // 1. unit_all
    const [units] = await conn.query('SELECT * FROM unit_all ORDER BY row_id');
    db.exec('DELETE FROM unit_all');
    const insUnit = db.prepare(`
      INSERT INTO unit_all (row_id, unit_code, unit_name, unit_head, unit_head_position, unit_head_level, tel, note, hcode, d_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction((rows) => {
      for (const r of rows) {
        insUnit.run(
          r.row_id,
          smartDecode(r.unit_code) || '',
          smartDecode(r.unit_name) || '',
          smartDecode(r.unit_head) || '',
          smartDecode(r.unit_head_position) || '',
          smartDecode(r.unit_head_level) || '',
          smartDecode(r.tel) || '',
          smartDecode(r.note) || '',
          smartDecode(r.hcode) || '',
          cleanDate(r.d_update)
        );
      }
    })(units);
    console.log(`Migrated unit_all: ${units.length} rows`);

    // 2. type_conference
    const [types] = await conn.query('SELECT * FROM type_conference ORDER BY type_conference_id');
    db.exec('DELETE FROM type_conference');
    const insType = db.prepare(`INSERT INTO type_conference (type_conference_id, type_conference_name, d_update) VALUES (?, ?, ?)`);
    db.transaction((rows) => {
      for (const r of rows) {
        insType.run(r.type_conference_id, smartDecode(r.type_conference_name) || '', cleanDate(r.d_update));
      }
    })(types);
    console.log(`Migrated type_conference: ${types.length} rows`);

    // 3. room (meeting rooms)
    const [rooms] = await conn.query('SELECT * FROM room ORDER BY row_id');
    db.exec('DELETE FROM room');
    const insRoom = db.prepare(`
      INSERT INTO room (row_id, name, place, numper, owner_id, tel, memo, picture, from_ip, from_user, d_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction((rows) => {
      for (const r of rows) {
        insRoom.run(
          r.row_id,
          smartDecode(r.name) || '',
          smartDecode(r.place) || '',
          smartDecode(r.numper) || '0',
          r.owner_id || 0,
          smartDecode(r.tel) || '',
          smartDecode(r.memo) || '',
          smartDecode(r.picture) || '',
          smartDecode(r.from_ip) || '',
          r.from_user || 0,
          cleanDate(r.d_update)
        );
      }
    })(rooms);
    console.log(`Migrated room: ${rooms.length} rows`);

    // 4. equip (meeting equipment)
    const [equips] = await conn.query('SELECT * FROM equip ORDER BY row_id');
    db.exec('DELETE FROM equip');
    const insEquip = db.prepare(`INSERT INTO equip (row_id, name, d_update) VALUES (?, ?, ?)`);
    db.transaction((rows) => {
      for (const r of rows) {
        insEquip.run(r.row_id, smartDecode(r.name) || '', cleanDate(r.d_update));
      }
    })(equips);
    console.log(`Migrated equip: ${equips.length} rows`);

    // 5. personaldata (users)
    const [users] = await conn.query('SELECT * FROM personaldata ORDER BY row_id');
    db.exec('DELETE FROM personaldata');
    const insUser = db.prepare(`
      INSERT OR IGNORE INTO personaldata (row_id, personalid, title, fname, lname, telephone, unit_id, usertype, puchai, rahuspan, from_ip, from_user, d_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction((rows) => {
      for (const r of rows) {
        insUser.run(
          r.row_id,
          smartDecode(r.personalid) || '',
          smartDecode(r.title) || '',
          smartDecode(r.fname) || '',
          smartDecode(r.lname) || '',
          smartDecode(r.telephone) || '',
          r.unit_id || 0,
          smartDecode(r.usertype) || 'user',
          smartDecode(r.puchai) || `user_${r.row_id}`,
          smartDecode(r.rahuspan) || '',
          smartDecode(r.from_ip) || '',
          smartDecode(r.from_user) || '',
          cleanDate(r.d_update)
        );
      }
    })(users);
    console.log(`Migrated personaldata: ${users.length} rows`);

    // 6. bookroom (meeting bookings)
    const [bookings] = await conn.query('SELECT * FROM bookroom ORDER BY row_id');
    db.exec('DELETE FROM bookroom');
    const insBooking = db.prepare(`
      INSERT INTO bookroom (row_id, datereg, subject, perhead, numper, type_conference_id, room_id, datemeet, s_time, e_time, equip, food, memo, perbook, b_status, from_ip, unit_out, unit_id, user_id, d_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction((rows) => {
      for (const r of rows) {
        insBooking.run(
          r.row_id,
          cleanDate(r.datereg),
          smartDecode(r.subject) || '',
          smartDecode(r.perhead) || '',
          r.numper ?? 0,
          r.type_conference_id ?? 0,
          r.room_id || 0,
          cleanDate(r.datemeet, r.datereg),
          smartDecode(r.s_time) || '',
          smartDecode(r.e_time) || '',
          smartDecode(r.equip) || '',
          smartDecode(r.food) || '',
          smartDecode(r.memo) || '',
          smartDecode(r.perbook) || '',
          r.b_status ?? 0,
          smartDecode(r.from_ip) || '',
          smartDecode(r.unit_out) || '',
          r.unit_id || 0,
          r.user_id || 0,
          cleanDate(r.d_update)
        );
      }
    })(bookings);
    console.log(`Migrated bookroom: ${bookings.length} rows`);

    console.log('Migration completed successfully!');
  } finally {
    await conn.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
