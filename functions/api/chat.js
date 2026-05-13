/**
 * Cloudflare Pages Function → /api/chat
 *
 * ENV ตั้งใน Cloudflare Pages → Settings → Environment variables:
 *   GROQ_API_KEY     gsk_...     (สมัครฟรี console.groq.com)
 *
 * ทางเลือก (ถ้าไม่ให้ user ใส่ key ใน browser):
 *   OPENAI_API_KEY   sk-...      (OpenAI)
 *   GEMINI_API_KEY   AIza...     (Google AI Studio)
 *
 * Turso #1 — ตารางแพทย์ / OPD / ward (เช่น hemato_elective)
 *   TURSO_URL        libsql://...
 *   TURSO_TOKEN      eyJhbGci...
 *
 * Turso #2 — elective FAQ (ตาราง items + config) แยก DB ได้
 *   TURSO_FAQ_URL    libsql://...
 *   TURSO_FAQ_TOKEN  eyJhbGci...
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  try {
    const { messages, provider = 'groq', apiKey } = await request.json();
    if (!Array.isArray(messages)) throw new Error('messages required');

    const [schedule, faq] = await Promise.all([
      queryScheduleTurso(env),
      queryFaqTurso(env),
    ]);
    const system = buildSystem({ schedule, faq });

    let reply;
    if (provider === 'openai') {
      const key = apiKey || env.OPENAI_API_KEY;
      reply = await callOpenAI(messages, system, key);
    } else if (provider === 'gemini') {
      const key = apiKey || env.GEMINI_API_KEY;
      reply = await callGemini(messages, system, key);
    } else {
      reply = await callGroq(messages, system, env.GROQ_API_KEY);
    }

    return new Response(JSON.stringify({ reply }), { headers: CORS });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
}

/* ── Turso (read-only) ─────────────────────────────────────── */
function makeTursoExec(libsqlUrl, token) {
  const base = libsqlUrl.replace('libsql://', 'https://');
  const hdr  = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return async (sql) => {
    try {
      const r = await fetch(`${base}/v2/pipeline`, {
        method: 'POST', headers: hdr,
        body: JSON.stringify({
          requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
        }),
      });
      const j  = await r.json();
      const rs = j?.results?.[0]?.response?.result;
      if (!rs) return [];
      const cols = rs.cols.map(c => c.name);
      return rs.rows.map(row =>
        Object.fromEntries(cols.map((c, i) => [c, row[i]?.value ?? null]))
      );
    } catch { return []; }
  };
}

/** DB แรก: doctors / OPD / ward */
async function queryScheduleTurso(env) {
  const { TURSO_URL, TURSO_TOKEN } = env;
  if (!TURSO_URL || !TURSO_TOKEN) return { ok: false };

  const exec  = makeTursoExec(TURSO_URL, TURSO_TOKEN);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

  const tables = (await exec(
    "SELECT name FROM sqlite_master WHERE type='table'"
  )).map(t => t.name);

  const has = (t) => tables.includes(t);
  const res = { ok: true, today, tables };

  for (const t of ['doctors', 'electives', 'doctor', 'elective']) {
    if (has(t)) {
      res.doctors = await exec(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 80`);
      break;
    }
  }

  for (const t of ['opd_schedule', 'opd_schedules', 'opd', 'schedule']) {
    if (has(t)) {
      const month = today.slice(0, 7);
      res.opdMonth = await exec(
        `SELECT * FROM ${t} WHERE date LIKE '${month}%' ORDER BY date LIMIT 120`
      );
      res.opdToday = res.opdMonth.filter(r => r.date === today);
      break;
    }
  }

  for (const t of ['ward_schedule', 'wards', 'ward', 'ward_chief']) {
    if (has(t)) {
      res.ward = await exec(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 40`);
      break;
    }
  }

  return res;
}

/** DB ที่สอง: items + config (elective-activity / FAQ) */
async function queryFaqTurso(env) {
  const { TURSO_FAQ_URL, TURSO_FAQ_TOKEN } = env;
  if (!TURSO_FAQ_URL || !TURSO_FAQ_TOKEN) return { ok: false };

  const exec = makeTursoExec(TURSO_FAQ_URL, TURSO_FAQ_TOKEN);

  const tables = (await exec(
    "SELECT name FROM sqlite_master WHERE type='table'"
  )).map(t => t.name);

  if (!tables.includes('items') && !tables.includes('config')) {
    return { ok: false, hint: 'no items/config tables' };
  }

  let items = [];
  let config = [];

  if (tables.includes('items')) {
    items = await exec(
      `SELECT sort_order, tag_th, tag_en, keywords_th, keywords_en, answer_th, answer_en
       FROM items WHERE visible = 1 ORDER BY sort_order ASC, id ASC LIMIT 250`
    );
  }
  if (tables.includes('config')) {
    config = await exec(
      'SELECT key, value_th, value_en FROM config ORDER BY key ASC LIMIT 50'
    );
  }

  return { ok: true, items, config };
}

/* ── System prompt ─────────────────────────────────────────── */
function buildSystem({ schedule, faq }) {
  const rows = (arr) => {
    if (!arr || arr.length === 0) return '  (ไม่มีข้อมูล)';
    return arr.map(r =>
      '  • ' + Object.entries(r)
        .filter(([, v]) => v !== null && v !== '')
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ')
    ).join('\n');
  };

  const formatFaqItems = (list) => {
    if (!list || list.length === 0) return '  (ไม่มีรายการ)';
    return list.map((it, i) => {
      const th = String(it.answer_th ?? '').trim();
      const en = String(it.answer_en ?? '').trim();
      return [
        `  [${i + 1}] ${it.tag_th ?? ''} / ${it.tag_en ?? ''}`,
        `      keywords TH: ${it.keywords_th ?? ''}`,
        `      keywords EN: ${it.keywords_en ?? ''}`,
        `      ตอบ (TH):\n${th.split('\n').map(l => '        ' + l).join('\n')}`,
        `      Answer (EN):\n${en.split('\n').map(l => '        ' + l).join('\n')}`,
      ].join('\n');
    }).join('\n\n');
  };

  const scheduleSection = schedule.ok ? `
=== ข้อมูลตารางจริง — Turso DB #1 (วันที่: ${schedule.today}) ===

[แพทย์ Elective / Doctors ทั้งหมด]
${rows(schedule.doctors)}

[Ward / Chief Resident]
${rows(schedule.ward)}

[OPD วันนี้ (${schedule.today})]
${rows(schedule.opdToday)}

[OPD เดือนนี้ทั้งหมด]
${rows(schedule.opdMonth)}
` : '\n[Turso #1 ตาราง/แพทย์/OPD: ไม่ได้เชื่อมต่อ]\n';

  const faqSection = faq.ok ? `
=== คำถาม–คำตอบ Elective — Turso DB #2 (ตาราง config + items) ===
- ใช้บล็อกนี้เป็นหลักเมื่อถามเรื่องกิจกรรม elective / รอบวอร์ด / conference / OPD ทั่วไป / SelecX / หลังจบงาน
- เลือกข้อความตอบจาก answer_th หรือ answer_en ให้ตรงกับภาษาที่ผู้ใช้ใช้
- ถ้าคำถามเกี่ยวกับชื่อแพทย์ วันที่นัด OPD เฉพาะราย หรือตาราง ward รายวัน — ให้ยึดข้อมูลจาก Turso DB #1 ด้านบนเป็นหลัก (ไม่สมมติ)

[config / ประกาศ — value อาจมี HTML]
${rows(faq.config)}

[รายการ FAQ — จับคู่จาก keywords + tag แล้วตอบจาก answer]
${formatFaqItems(faq.items)}
` : '\n[Turso #2 FAQ (items/config): ไม่ได้เชื่อมต่อ]\n';

  return `You are Hemato Bot — a helpful assistant for the Hematology Division, Siriraj Hospital (โรงพยาบาลศิริราช), Thailand.

RULES:
- Always reply in the SAME language as the user's message (Thai → Thai, English → English).
- Be concise, friendly, and accurate.
- NEVER invent names, dates, or schedules that are not in the data below.
- If you don't know something, say so honestly.
- For specific schedules (who is on OPD which day, ward roster), use Turso DB #1 only.
- For general elective activity content, prefer Turso DB #2 when it is connected; otherwise use the static outline at the bottom.

${scheduleSection}
${faqSection}
=== เนื้อหากิจกรรม Elective โลหิตวิทยา (สรุป — ใช้เมื่อ DB #2 ไม่มีหรือไม่ครอบคลุม) ===

[ก่อนมาดูงาน]
• Add เข้ากลุ่ม LINE elective ก่อนวันมา แนะนำตัวกับทีม
• ดูตารางราวด์วอร์ด + ตาราง OPD ใน note LINE group
• นัดเวลาและสถานที่ราวด์กับ chief resident

[วอร์ด — ชั้น 23 อาคารนวมินทรบพิตร 84 พรรษา]
• ปีกใต้ = ผู้ป่วยชาย (Acute leukemia, Lymphoma, เคมีบำบัด)
• ปีกเหนือ = ผู้ป่วยหญิง
• รับ consult โลหิตวิทยาจากทุกวอร์ด

[ราวด์วอร์ด]
• เช้า 7:30 น. (นัด chief ก่อน เวลาอาจเปลี่ยน)
• บ่าย: ราวด์ consult, ดู blood smear / bone marrow กับ attending

[Grand Round — จันทร์ 13:00–15:00]
• Resident นำเสนอ 2 เคสน่าสนใจ • นศพ.อาจทำ problem list + ร่วม discussion

[Hematology Conference — พฤหัส 13:15–14:15]
หมุนเวียน: (1) Interesting case (2) Journal club
(3) HPC – Hematology Pathology Conference
(4) Coagulation round (5) M&M Conference

[OPD — ห้อง 700 ชั้น 7 อาคาร OPD]
• ถึง 9:00–9:30 น. / ตรวจ 9:00–12:00 น.
• อาหารเที่ยงหลัง OPD (ห้องด้านหลัง)
• ดูตาราง OPD ใน note LINE group

[Lectures Online — SelecX]
SelecX → การศึกษาหลังปริญญา → Hematology for Internist 2022
หัวข้อ: Thrombocytopenia, Acute anemia, Hematologic emergencies,
Coagulogram, Anticoagulants, ITP, AIHA, MPN, Acute leukemia,
Blood products, Thalassemia, Bleeding/Thrombosis, Lymphoma

[Lectures สาขา — ศุกร์ที่ 1 และ 3 ของเดือน (ช่วงเที่ยง)]
• ถามทีมวอร์ดสำหรับสถานที่/link • Lecture = priority แรก

[เสร็จสิ้น]
1. กรอก Google Form reflection/feedback
2. Leave LINE group ได้เลย
Link: https://docs.google.com/forms/d/e/1FAIpQLSeHPePaS04OyV44_Uh3Hw1ifGKNaO5nK6tMqtXP_b-trJMffw/viewform
`.trim();
}

/* ── AI providers ──────────────────────────────────────────── */
async function callGroq(messages, system, key) {
  if (!key) throw new Error(
    'ยังไม่ได้ตั้งค่า GROQ_API_KEY ใน Cloudflare Pages → Settings → Environment variables'
  );
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!r.ok) throw new Error(`Groq: ${await r.text()}`);
  return (await r.json()).choices?.[0]?.message?.content ?? '(ไม่ได้รับคำตอบ)';
}

async function callOpenAI(messages, system, key) {
  if (!key) {
    throw new Error(
      'ต้องใส่ OpenAI API key ในหน้าเว็บ (บันทึก) หรือตั้ง OPENAI_API_KEY บนเซิร์ฟเวอร์'
    );
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI: ${await r.text()}`);
  return (await r.json()).choices?.[0]?.message?.content ?? '(ไม่ได้รับคำตอบ)';
}

async function callGemini(messages, system, key) {
  if (!key) {
    throw new Error(
      'ต้องใส่ Gemini API key ในหน้าเว็บ (บันทึก) หรือตั้ง GEMINI_API_KEY บนเซิร์ฟเวอร์'
    );
  }
  const model = 'gemini-2.0-flash';
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(key)}`;

  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: String(m.content ?? '') }] });
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini: ${await r.text()}`);
  const j = await r.json();
  const parts = j.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map(p => p.text).filter(Boolean).join('')
    : '';
  return text || '(ไม่ได้รับคำตอบ)';
}
