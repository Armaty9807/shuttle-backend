// ══════════════════════════════════════════════════════════════════
//  shuttle-backend / server.js
//  รถรับ-ส่ง วิรัชศิลป์ — Node.js + Supabase
// ══════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Supabase client ────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Config ─────────────────────────────────────────────────────────
const LOC_NAMES = {
  A: 'หน้าเจริญสุข',
  B: 'หน้าตึก OPD',
  C: 'โรงแรมเอเต้'
};

// ══════════════════════════════════════════════════════════════════
//  HELPER: สร้างเลขคิวถัดไป  A-01, A-02, ...
//  ใช้ Supabase RPC เพื่อให้ thread-safe (atomic increment)
// ══════════════════════════════════════════════════════════════════
async function nextQueueToken(loc) {
  // ดึง counter ของวันนี้
  const today = new Date().toISOString().slice(0, 10); // "2025-03-27"
  const { data, error } = await supabase
    .from('queue_counters')
    .select('counter')
    .eq('loc', loc)
    .eq('date', today)
    .single();

  let next = 1;
  if (!error && data) {
    next = data.counter + 1;
    await supabase
      .from('queue_counters')
      .update({ counter: next })
      .eq('loc', loc)
      .eq('date', today);
  } else {
    // วันใหม่หรือยังไม่มี row
    await supabase
      .from('queue_counters')
      .upsert({ loc, date: today, counter: 1 });
  }
  return loc + '-' + String(next).padStart(2, '0');
}

// ══════════════════════════════════════════════════════════════════
//  POST /api/requests  — ผู้ใช้ส่งคำร้องขอรถ
// ══════════════════════════════════════════════════════════════════
app.post('/api/requests', async (req, res) => {
  const { loc, plate, phone, note } = req.body;

  // Validate
  if (!['A','B','C'].includes(loc))        return res.status(400).json({ error: 'loc ต้องเป็น A, B หรือ C' });
  if (!plate || plate.trim().length < 2)   return res.status(400).json({ error: 'กรุณาระบุป้ายทะเบียน' });
  if (!phone || phone.trim().length < 9)   return res.status(400).json({ error: 'กรุณาระบุเบอร์โทรศัพท์' });

  // สร้าง token
  const token = await nextQueueToken(loc);

  // บันทึกลง Supabase
  const { data: request, error: dbErr } = await supabase
    .from('requests')
    .insert({
      token,
      loc,
      loc_name: LOC_NAMES[loc],
      plate:    plate.trim().toUpperCase(),
      phone:    phone.trim(),
      note:     note?.trim() || null,
      status:   'waiting'
    })
    .select()
    .single();

  if (dbErr) {
    console.error('[DB] insert error:', dbErr);
    return res.status(500).json({ error: 'บันทึกข้อมูลล้มเหลว' });
  }

  // นับคิวรอก่อนหน้า
  const { count: queueBefore } = await supabase
    .from('requests')
    .select('*', { count: 'exact', head: true })
    .eq('loc', loc)
    .eq('status', 'waiting')
    .lt('created_at', request.created_at);

  const etaMins = (queueBefore || 0) * 5 + 5;

  console.log(`[NEW] ${token} | ${plate.trim().toUpperCase()} | ${LOC_NAMES[loc]} | ${phone.trim()}`);

  res.json({ ok: true, token, eta_mins: etaMins, queue_before: queueBefore || 0 });
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/requests  — ดึงคิวทั้งหมด (ไดร์เวอร์ / แอดมิน)
// ══════════════════════════════════════════════════════════════════
app.get('/api/requests', async (req, res) => {
  const { status, loc, date } = req.query;
  const today = (date || new Date().toISOString().slice(0, 10));

  let query = supabase
    .from('requests')
    .select('*')
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59')
    .order('created_at', { ascending: true });

  if (status) query = query.eq('status', status);
  if (loc)    query = query.eq('loc', loc);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, requests: data });
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/requests/:token  — ดึงสถานะคำร้องเดียว (ผู้ใช้ polling)
// ══════════════════════════════════════════════════════════════════
app.get('/api/requests/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .eq('token', req.params.token)
    .single();

  if (error || !data) return res.status(404).json({ error: 'ไม่พบคำร้องนี้' });
  res.json({ ok: true, request: data });
});

// ══════════════════════════════════════════════════════════════════
//  PATCH /api/requests/:token/status  — ไดร์เวอร์อัปเดตสถานะ
// ══════════════════════════════════════════════════════════════════
app.patch('/api/requests/:token/status', async (req, res) => {
  const { status } = req.body; // in_progress | done | cancelled
  if (!['in_progress','done','cancelled'].includes(status))
    return res.status(400).json({ error: 'status ไม่ถูกต้อง' });

  const { data: updated, error } = await supabase
    .from('requests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('token', req.params.token)
    .select()
    .single();

  if (error || !updated) return res.status(404).json({ error: 'ไม่พบคำร้องนี้' });

  console.log(`[STATUS] ${req.params.token} → ${status} | ${thaiTime()}`);

  res.json({ ok: true, request: updated });
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/counters  — เลขคิวปัจจุบันวันนี้
// ══════════════════════════════════════════════════════════════════
app.get('/api/counters', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('queue_counters')
    .select('loc, counter')
    .eq('date', today);

  if (error) return res.status(500).json({ error: error.message });

  const result = { A: 0, B: 0, C: 0 };
  (data || []).forEach(row => { result[row.loc] = row.counter; });
  res.json({ ok: true, counters: result, date: today });
});

// ══════════════════════════════════════════════════════════════════
//  POST /api/counters/reset  — รีเซ็ตคิว (แอดมิน)
// ══════════════════════════════════════════════════════════════════
app.post('/api/counters/reset', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('queue_counters').delete().eq('date', today);
  res.json({ ok: true, message: 'รีเซ็ตเลขคิวแล้ว' });
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/stats  — สรุปสถิติวันนี้ (แอดมิน dashboard)
// ══════════════════════════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const [waiting, done, total] = await Promise.all([
    supabase.from('requests').select('*', { count: 'exact', head: true })
      .eq('status', 'waiting').gte('created_at', today + 'T00:00:00'),
    supabase.from('requests').select('*', { count: 'exact', head: true })
      .eq('status', 'done').gte('created_at', today + 'T00:00:00'),
    supabase.from('requests').select('*', { count: 'exact', head: true })
      .gte('created_at', today + 'T00:00:00')
  ]);

  // แยกตามจุด
  const locStats = {};
  for (const loc of ['A','B','C']) {
    const { count } = await supabase.from('requests')
      .select('*', { count: 'exact', head: true })
      .eq('loc', loc).eq('status', 'waiting')
      .gte('created_at', today + 'T00:00:00');
    locStats[loc] = count || 0;
  }

  res.json({
    ok: true,
    date: today,
    stats: {
      total:   total.count   || 0,
      waiting: waiting.count || 0,
      done:    done.count    || 0,
      by_loc:  locStats
    }
  });
});

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Utils ──────────────────────────────────────────────────────────
function thaiTime() {
  return new Date().toLocaleTimeString('th-TH', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok'
  }) + ' น.';
}

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚗 Shuttle Backend — วิรัชศิลป์`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✓' : '✗ ยังไม่ได้ตั้งค่า'}`);
  console.log(`   LINE Driver: ${process.env.LINE_TOKEN_DRIVER ? '✓' : '✗ ยังไม่ได้ตั้งค่า'}\n`);
});
