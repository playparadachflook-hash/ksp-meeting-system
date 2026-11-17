const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_REG = path.join(__dirname, '..', 'fonts', 'Sarabun-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'fonts', 'Sarabun-Bold.ttf');

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

const THAI_SHORT_MONTHS = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

const STATUS_INFO = {
  0: { label: 'รออนุมัติ', color: '#b45309', bg: '#fef3c7' },
  1: { label: 'อนุมัติแล้ว', color: '#15803d', bg: '#dcfce7' },
  6: { label: 'ไม่อนุมัติ', color: '#b91c1c', bg: '#fee2e2' },
  9: { label: 'ยกเลิกการจอง', color: '#7e22ce', bg: '#f3e8ff' },
};

function fmtThaiDateFull(iso) {
  if (!iso || String(iso).startsWith('0000')) return '-';
  const p = String(iso).slice(0, 10).split('-');
  if (p.length !== 3) return String(iso);
  const y = Number(p[0]) + 543;
  const m = THAI_MONTHS[Number(p[1]) - 1] || p[1];
  return `${Number(p[2])} ${m} ${y}`;
}

function fmtThaiDateShort(iso) {
  if (!iso || String(iso).startsWith('0000')) return '-';
  const p = String(iso).slice(0, 10).split('-');
  if (p.length !== 3) return String(iso);
  const y = Number(p[0]) + 543;
  const m = THAI_SHORT_MONTHS[Number(p[1]) - 1] || p[1];
  return `${Number(p[2])} ${m} ${String(y).slice(-2)}`;
}

function formatFood(foodStr) {
  const parts = String(foodStr || '').split('|');
  const labels = [];
  if (parts[0] === '1') labels.push('อาหารว่างเช้า');
  if (parts[1] === '1') labels.push('อาหารกลางวัน');
  if (parts[2] === '1') labels.push('อาหารว่างบ่าย');
  return labels.length ? labels.join(', ') : '-';
}

function generateMeetingBookingPdf(booking, res, download = false) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 42, right: 42 },
    info: {
      Title: `ใบขออนุญาตใช้ห้องประชุม #${booking.row_id}`,
      Author: 'โรงพยาบาลโคกศรีสุพรรณ',
    },
  });

  const filename = `meeting-booking-${booking.row_id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  doc.pipe(res);

  doc.registerFont('Sarabun', FONT_REG);
  doc.registerFont('Sarabun-Bold', FONT_BOLD);

  const pageW = doc.page.width;
  const left = 42;
  const contentW = pageW - left * 2;

  // ===== HEADER BANNER =====
  doc.roundedRect(left, 38, contentW, 68, 6).fillAndStroke('#f0f9ff', '#0284c7');

  doc.fillColor('#0369a1').font('Sarabun-Bold').fontSize(16)
    .text('ใบขออนุญาตใช้ห้องประชุมออนไลน์', left + 16, 48, { width: 330 });
  doc.fillColor('#334155').font('Sarabun').fontSize(11)
    .text('โรงพยาบาลโคกศรีสุพรรณ จังหวัดสกลนคร', left + 16, 70, { width: 330 });
  doc.fillColor('#64748b').fontSize(9.5)
    .text(`วันที่บันทึกคำขอ: ${booking.datereg || '-'}`, left + 16, 86, { width: 330 });

  const st = STATUS_INFO[booking.b_status] || { label: `สถานะ ${booking.b_status}`, color: '#334155', bg: '#e2e8f0' };
  doc.roundedRect(left + contentW - 155, 46, 142, 52, 5).fillAndStroke('#ffffff', '#bae6fd');
  doc.fillColor('#64748b').font('Sarabun').fontSize(9)
    .text('เลขที่ใบจองห้องประชุม', left + contentW - 155, 50, { width: 142, align: 'center' });
  doc.fillColor('#0f172a').font('Sarabun-Bold').fontSize(14)
    .text(`#${booking.row_id}`, left + contentW - 155, 62, { width: 142, align: 'center' });

  doc.roundedRect(left + contentW - 135, 81, 102, 14, 7).fill(st.bg);
  doc.fillColor(st.color).font('Sarabun-Bold').fontSize(8.5)
    .text(st.label, left + contentW - 135, 82, { width: 102, align: 'center' });

  // ===== SECTION 1 =====
  let y = 122;
  doc.fillColor('#0369a1').font('Sarabun-Bold').fontSize(12).text('1. รายละเอียดการขอใช้ห้องประชุม', left, y);
  y += 20;

  const labelW = 155;
  const valW = contentW - labelW;

  const rows1 = [
    ['หน่วยงานที่ขอใช้ห้อง', booking.unit_name || booking.unit_out || '-'],
    ['ห้องประชุม', booking.room_name || '-', true],
    ['รูปแบบการประชุม', booking.type_conference_name || '-'],
    ['เรื่อง / หัวข้อประชุม', booking.subject || '-', true],
    ['กลุ่มผู้เข้าประชุม', `${booking.perhead || '-'}${booking.numper ? `  (จำนวน ${booking.numper} คน)` : ''}`],
    ['วันที่ / เวลาที่ใช้ห้อง', `${fmtThaiDateFull(booking.datemeet)}   เวลา ${booking.s_time || '-'} - ${booking.e_time || '-'} น.`],
    ['ชื่อผู้จองห้องประชุม', booking.perbook || '-'],
  ];

  for (let i = 0; i < rows1.length; i++) {
    const [lbl, val, boldVal] = rows1[i];
    doc.font(boldVal ? 'Sarabun-Bold' : 'Sarabun').fontSize(10.5);
    const textH = doc.heightOfString(String(val), { width: valW - 16 });
    const rowH = Math.max(25, textH + 12);

    doc.rect(left, y, labelW, rowH).fillAndStroke('#f8fafc', '#cbd5e1');
    doc.rect(left + labelW, y, valW, rowH).fillAndStroke('#ffffff', '#cbd5e1');

    doc.fillColor('#334155').font('Sarabun-Bold').fontSize(10)
      .text(lbl, left + 10, y + 6, { width: labelW - 16 });
    doc.fillColor('#0f172a').font(boldVal ? 'Sarabun-Bold' : 'Sarabun').fontSize(10.5)
      .text(String(val), left + labelW + 10, y + 6, { width: valW - 16 });

    y += rowH;
  }

  // ===== SECTION 2 =====
  y += 16;
  doc.fillColor('#0369a1').font('Sarabun-Bold').fontSize(12).text('2. อุปกรณ์โสตทัศนูปกรณ์ อาหารว่าง และการอนุมัติ', left, y);
  y += 20;

  const equipNames = (booking.equipNames && booking.equipNames.length) ? booking.equipNames.join(', ') : '-';
  const foodText = formatFood(booking.food);

  const rows2 = [
    ['อุปกรณ์ที่ใช้ในห้องประชุม', equipNames],
    ['การเตรียมอาหารว่าง', foodText],
    ['ผู้รับผิดชอบ / ผู้ดูแลห้องที่ดำเนินการ', booking.assigned_to || '-'],
    ['สถานะการอนุมัติ', st.label, true],
    ['หมายเหตุ', booking.memo || '-'],
  ];

  for (let i = 0; i < rows2.length; i++) {
    const [lbl, val, boldVal] = rows2[i];
    doc.font(boldVal ? 'Sarabun-Bold' : 'Sarabun').fontSize(10.5);
    const textH = doc.heightOfString(String(val), { width: valW - 16 });
    const rowH = Math.max(25, textH + 12);

    doc.rect(left, y, labelW, rowH).fillAndStroke('#f0f9ff', '#cbd5e1');
    doc.rect(left + labelW, y, valW, rowH).fillAndStroke('#ffffff', '#cbd5e1');

    doc.fillColor('#334155').font('Sarabun-Bold').fontSize(10)
      .text(lbl, left + 10, y + 6, { width: labelW - 16 });
    doc.fillColor('#0f172a').font(boldVal ? 'Sarabun-Bold' : 'Sarabun').fontSize(10.5)
      .text(String(val), left + labelW + 10, y + 6, { width: valW - 16 });

    y += rowH;
  }

  // ===== SIGNATURE BLOCK =====
  let sigY = y + 24;
  if (sigY + 170 > 775) {
    doc.addPage({ size: 'A4', margins: { top: 40, bottom: 40, left: 42, right: 42 } });
    sigY = 60;
  }
  const colW = contentW / 3;
  const sigs = [
    { title: 'ผู้ขอจองห้องประชุม', name: booking.perbook || '' },
    { title: 'ผู้ดูแลโสตฯ / ห้องประชุม', name: '' },
    { title: 'หัวหน้างาน / ผู้รับรอง', name: '' },
  ];

  sigs.forEach((s, idx) => {
    const sx = left + idx * colW;
    doc.fillColor('#334155').font('Sarabun').fontSize(9.5)
      .text('ลงชื่อ ...............................................', sx, sigY, { width: colW, align: 'center' });
    doc.text(`( ${s.name ? s.name : '...........................................'} )`, sx, sigY + 17, { width: colW, align: 'center' });
    doc.font('Sarabun-Bold').text(s.title, sx, sigY + 34, { width: colW, align: 'center' });
    doc.font('Sarabun').fontSize(8.5).fillColor('#64748b')
      .text('วันที่ ........../........../..........', sx, sigY + 51, { width: colW, align: 'center' });
  });

  // ===== DIRECTOR SIGNATURE (CENTER BOTTOM) =====
  const dirY = sigY + 84;
  doc.fillColor('#0f172a').font('Sarabun').fontSize(9.5)
    .text('ลงชื่อ ...............................................', left, dirY, { width: contentW, align: 'center' })
    .text('( นางณัฐปภัสร์ นวัตชัยศิริกุล )', left, dirY + 17, { width: contentW, align: 'center' });
  doc.font('Sarabun-Bold').text('นายแพทย์ชำนาญการพิเศษ', left, dirY + 34, { width: contentW, align: 'center' });
  doc.font('Sarabun').fontSize(9)
    .text('รักษาการในตำแหน่ง\nผู้อำนวยการ รพ.โคกศรีสุพรรณ', left, dirY + 50, { width: contentW, align: 'center' });

  const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  doc.fillColor('#94a3b8').font('Sarabun').fontSize(8.5)
    .text(`พิมพ์จากระบบจองห้องประชุมออนไลน์ โรงพยาบาลโคกศรีสุพรรณ | พิมพ์เมื่อ ${nowStr}`, left, 785, {
      width: contentW,
      align: 'center',
    });

  doc.end();
}

function generateMeetingBoardPdf(items, filterDesc, res, download = false) {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 32, bottom: 32, left: 30, right: 30 },
    info: {
      Title: 'ตารางการใช้ห้องประชุม โรงพยาบาลโคกศรีสุพรรณ',
      Author: 'โรงพยาบาลโคกศรีสุพรรณ',
    },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="meeting-board.pdf"`);
  doc.pipe(res);

  doc.registerFont('Sarabun', FONT_REG);
  doc.registerFont('Sarabun-Bold', FONT_BOLD);

  const left = 30;
  const contentW = doc.page.width - left * 2;

  const drawHeader = () => {
    doc.fillColor('#0369a1').font('Sarabun-Bold').fontSize(14)
      .text('ตารางการใช้ห้องประชุม (กระดานห้องประชุม) โรงพยาบาลโคกศรีสุพรรณ', left, 26, { width: contentW, align: 'center' });
    doc.fillColor('#475569').font('Sarabun').fontSize(9.5)
      .text(filterDesc || 'รายการทั้งหมด', left, 46, { width: contentW, align: 'center' });

    const cols = [
      { label: 'เลขที่', w: 48 },
      { label: 'วันที่ / เวลา', w: 74 },
      { label: 'ห้องประชุม', w: 115 },
      { label: 'หัวข้อการประชุม', w: 200 },
      { label: 'หน่วยงาน', w: 105 },
      { label: 'ผู้จอง / จำนวน', w: 92 },
      { label: 'อุปกรณ์ / อาหาร', w: 85 },
      { label: 'สถานะ', w: 62 },
    ];
    let cx = left;
    const hy = 66;
    cols.forEach((c) => {
      doc.rect(cx, hy, c.w, 22).fillAndStroke('#e0f2fe', '#94a3b8');
      doc.fillColor('#0f172a').font('Sarabun-Bold').fontSize(9)
        .text(c.label, cx + 4, hy + 5, { width: c.w - 8, align: 'center' });
      cx += c.w;
    });
    return { cols, startY: hy + 22 };
  };

  let { cols, startY: y } = drawHeader();

  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const st = STATUS_INFO[r.b_status] || { label: String(r.b_status), color: '#334155' };
    const equipTxt = (r.equipNames && r.equipNames.length) ? r.equipNames.join(', ') : '-';
    const vals = [
      `#${r.row_id}`,
      `${fmtThaiDateShort(r.datemeet)}\n${r.s_time || ''}-${r.e_time || ''}`,
      r.room_name || '-',
      r.subject || '-',
      r.unit_name || r.unit_out || '-',
      `${r.perbook || '-'}${r.numper ? `\n(${r.numper} คน)` : ''}`,
      equipTxt,
      st.label,
    ];

    doc.font('Sarabun').fontSize(8.5);
    let maxH = 20;
    vals.forEach((v, idx) => {
      const h = doc.heightOfString(String(v), { width: cols[idx].w - 8 }) + 8;
      if (h > maxH) maxH = h;
    });

    if (y + maxH > doc.page.height - 36) {
      doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 32, bottom: 32, left: 30, right: 30 } });
      ({ cols, startY: y } = drawHeader());
    }

    let cx = left;
    const rowBg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    vals.forEach((v, idx) => {
      doc.rect(cx, y, cols[idx].w, maxH).fillAndStroke(rowBg, '#cbd5e1');
      doc.fillColor(idx === 7 ? st.color : '#0f172a')
        .font(idx === 7 ? 'Sarabun-Bold' : 'Sarabun')
        .fontSize(8.5)
        .text(String(v), cx + 4, y + 4, { width: cols[idx].w - 8 });
      cx += cols[idx].w;
    });
    y += maxH;
  }

  if (y + 105 > doc.page.height - 28) {
    doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 32, bottom: 32, left: 30, right: 30 } });
    y = 40;
  }
  const dirY = y + 18;
  doc.fillColor('#0f172a').font('Sarabun').fontSize(9.5)
    .text('ลงชื่อ ...............................................', left, dirY, { width: contentW, align: 'center' })
    .text('( นางณัฐปภัสร์ นวัตชัยศิริกุล )', left, dirY + 17, { width: contentW, align: 'center' });
  doc.font('Sarabun-Bold').text('นายแพทย์ชำนาญการพิเศษ', left, dirY + 34, { width: contentW, align: 'center' });
  doc.font('Sarabun').fontSize(9)
    .text('รักษาการในตำแหน่ง\nผู้อำนวยการ รพ.โคกศรีสุพรรณ', left, dirY + 50, { width: contentW, align: 'center' });

  doc.end();
}

module.exports = { generateMeetingBookingPdf, generateMeetingBoardPdf };
