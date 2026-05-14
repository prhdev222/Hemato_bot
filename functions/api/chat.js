/**
 * Cloudflare Pages Function → /api/chat
 *
 * ENV ตั้งใน Cloudflare Pages → Settings → Environment variables:
 *   GROQ_API_KEY     gsk_...     (สมัครฟรี console.groq.com)
 *
 * SambaNova Cloud (OpenAI-compatible — key ตั้งที่ Cloudflare เท่านั้น ไม่รับจากหน้าเว็บ)
 *   SAMBANOVA_API_KEY (แนะนำ) หรือ SAMBANOVA_KEY หรือ API_KEY (ชื่อเดียวกับตัวอย่าง $API_KEY ในแดชบอร์ด SambaNova)
 *   SAMBANOVA_MODEL  (ทางเลือก เช่น Meta-Llama-3.3-70B-Instruct)
 *
 * ทางเลือก (ถ้าไม่ให้ user ใส่ key ใน browser):
 *   OPENAI_API_KEY   sk-...      (OpenAI)
 *   GEMINI_API_KEY   AIza...     (Google AI Studio)
 *
 * OpenRouter (OpenAI-compatible — openrouter.ai)
 *   OPENROUTER_API_KEY   sk-or-v1-...
 *   OPENROUTER_MODEL     (ทางเลือก เช่น openai/gpt-4o-mini, meta-llama/llama-3.3-70b-instruct)
 *   OPENROUTER_HTTP_REFERER  (ทางเลือก — สำหรับอันดับบน OpenRouter)
 *   OPENROUTER_X_TITLE       (ทางเลือก — ชื่อแอป)
 *
 * Turso #1 — ตารางแพทย์ / OPD / ward (รองรับ schema: electives, doctors, opd_calendar+supervisors, chiefs, …)
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

const HEMATO_QUOTES_TH = [
  'ทุก smear มีเรื่องจะเล่า ถ้าเรายอมมองนานอีกนิด',
  'CBC บางใบดูเรียบ ๆ แต่ชอบซ่อน clue สำคัญไว้เสมอ',
  'ในโลหิตวิทยา ความสงสัยที่ดี มีค่าพอ ๆ กับคำตอบที่ถูก',
  'แยก cell วันนี้ยังไม่คล่อง ไม่เป็นไร พรุ่งนี้ตาจะคมขึ้นอีก',
  'ผู้ป่วยหนึ่งคน อาจสอนเราได้มากกว่าหนึ่งบทในตำรา',
  'ค่อย ๆ ดู ค่อย ๆ คิด แล้ว hematology จะสนุกขึ้นมาก',
];

const HEMATO_QUOTES_EN = [
  'Every smear has a story. Stay long enough to read it.',
  'A quiet CBC can still hide the most important clue.',
  'In hematology, a good question is often as valuable as the right answer.',
  'If cell recognition feels hard today, your eyes are still training.',
  'One patient can teach more than a full chapter of notes.',
  'Take it step by step. Hematology becomes clearer the more thoughtfully you observe.',
];

/** ใช้ key จากเบราว์เซอร์ถ้ามีค่าจริงหลัง trim — ถ้าเป็นช่องว่าง/ไม่ส่ง จะใช้ค่าจาก env เซิร์ฟเวอร์ */
function effectiveApiKey(clientKey, envKey) {
  const c = clientKey == null ? '' : String(clientKey).trim();
  if (c) return c;
  const e = envKey == null ? '' : String(envKey).trim();
  return e;
}

/** ตัด BOM / ช่องว่างมองไม่เห็น ปลายข้อความ (มักเกิดตอนวาง key จาก clipboard ใน Cloudflare) */
function stripSecret(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/^[\s\u200B-\u200D]+|[\s\u200B-\u200D]+$/g, '')
    .trim();
}

/**
 * อ่านค่าจาก env ตามชื่อที่ระบุ + เทียบแบบไม่สนตัวพิมพ์ของชื่อ key
 * (กันพิมพ์ชื่อผิดเช่น sambanova_api_key ในแดชบอร์ด)
 */
function readEnvSecretFlexible(env, ...canonicalKeys) {
  if (!env || typeof env !== 'object') return '';
  for (const key of canonicalKeys) {
    const s = stripSecret(env[key]);
    if (s) return s;
  }
  const want = new Set(canonicalKeys.map((k) => k.toUpperCase()));
  for (const name of Object.keys(env)) {
    if (want.has(String(name).toUpperCase())) {
      const s = stripSecret(env[name]);
      if (s) return s;
    }
  }
  return '';
}

const SYSTEM_HIDDEN_KEYS = new Set([
  'id', 'key', 'pin', 'line_user_id', 'created_by', 'created_at', 'updated_at',
  'supervisor_id', 'elective_ids', 'chief_line_id', 'active',
]);

function isPublicDataKey(k) {
  return (
    !SYSTEM_HIDDEN_KEYS.has(k) &&
    !/_id$/.test(k) &&
    !/_ids$/.test(k) &&
    !/token|secret|password/i.test(k)
  );
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  try {
    const { messages, provider = 'groq', apiKey } = await request.json();
    if (!Array.isArray(messages)) throw new Error('messages required');
    const rawQ = lastUserText(messages);

    if (intentQuoteRequest(rawQ)) {
      const reply = buildQuoteReply(rawQ);
      return new Response(JSON.stringify({ reply, fallback: true }), { headers: CORS });
    }

    const [schedule, faq] = await Promise.all([
      queryScheduleTurso(env),
      queryFaqTurso(env),
    ]);
    const system = buildSystem({ schedule, faq });

    let reply;
    let fallback = false;

    /* ── โหมดไม่ใช้ AI: ดึง DB ตรงๆ ──────────────────────────── */
    if (provider === 'noai') {
      reply = fallbackReplyFromData(messages, schedule, faq, true);
      fallback = true;
      return new Response(JSON.stringify({ reply, fallback }), { headers: CORS });
    }

    try {
      if (provider === 'openai') {
        const key = effectiveApiKey(apiKey, env.OPENAI_API_KEY);
        reply = await callOpenAI(messages, system, key);
      } else if (provider === 'gemini') {
        const key = effectiveApiKey(apiKey, env.GEMINI_API_KEY);
        reply = await callGemini(messages, system, key);
      } else if (provider === 'sambanova') {
        const k = readEnvSecretFlexible(env, 'SAMBANOVA_API_KEY', 'SAMBANOVA_KEY', 'API_KEY');
        reply = await callSambaNova(messages, system, k, env);
      } else if (provider === 'openrouter') {
        const key = effectiveApiKey(apiKey, env.OPENROUTER_API_KEY);
        reply = await callOpenRouter(messages, system, key, env);
      } else {
        reply = await callGroq(messages, system, env.GROQ_API_KEY);
      }
    } catch (aiErr) {
      const fb = fallbackReplyFromData(messages, schedule, faq);
      if (fb) {
        reply = fb;
        fallback = true;
      } else {
        throw aiErr;
      }
    }

    return new Response(JSON.stringify({ reply, fallback }), { headers: CORS });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
}

/* ── Turso (read-only) ─────────────────────────────────────── */
function makeTursoExec(libsqlUrl, token) {
  const base = libsqlUrl.startsWith('libsql://')
    ? libsqlUrl.replace('libsql://', 'https://')
    : libsqlUrl;
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

/** แปลงค่าวันที่ในแถวเป็น YYYY-MM-DD (เขต Asia/Bangkok ถ้าเป็น unix ms) */
function cellToYmd(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'number') {
    const ms = val < 1e12 ? val * 1000 : val;
    try {
      return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
    } catch {
      return '';
    }
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return '';
}

/** ชื่อตาราง/คอลัมน์ ASCII เท่านั้น (กันฉีด SQL) */
function sqlIdent(id) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id : null;
}

/** หาคอลัมน์วันที่สำหรับตาราง OPD จาก PRAGMA */
async function pickOpdDateColumn(exec, table) {
  const t = sqlIdent(table);
  if (!t) return 'date';
  const rows = await exec(`PRAGMA table_info(${t})`);
  const names = rows.map(r => String(r.name ?? ''));
  for (const pref of ['date', 'opd_date', 'clinic_date', 'schedule_date', 'slot_date', 'day']) {
    if (names.includes(pref)) return pref;
  }
  const hit = names.find(n => /date|day|schedule|opd/i.test(n));
  return sqlIdent(hit || '') || 'date';
}

function buildElectiveNameMap(electiveRows) {
  const m = new Map();
  for (const r of electiveRows || []) {
    const id = String(r.id ?? '');
    if (!id) continue;
    const label = [r.name, r.name_en].filter(Boolean).join(' / ');
    m.set(id, label || id);
  }
  return m;
}

/** แปลง elective_ids (JSON array) เป็นชื่อจากตาราง electives */
function enrichOpdRows(rows, electiveMap) {
  return (rows || []).map(r => {
    let elective_names = '';
    try {
      const raw = r.elective_ids;
      const ids = typeof raw === 'string' ? JSON.parse(raw || '[]') : Array.isArray(raw) ? raw : [];
      if (Array.isArray(ids)) {
        elective_names = ids.map(id => electiveMap.get(String(id)) || String(id)).join(', ');
      }
    } catch {
      elective_names = String(r.elective_ids ?? '');
    }
    return elective_names ? { ...r, elective_names } : { ...r };
  });
}

/** DB แรก: electives, doctors, opd_calendar (+supervisors), chiefs, ward */
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

  let electiveMap = new Map();
  if (has('electives')) {
    res.electives = await exec(
      `SELECT id, name, name_en, from_hospital, level, date_range, ward, status, date_range2, ward2
       FROM electives ORDER BY rowid DESC LIMIT 150`
    );
    electiveMap = buildElectiveNameMap(res.electives);
  }

  if (has('doctors')) {
    res.doctors = await exec(
      `SELECT * FROM doctors ORDER BY rowid DESC LIMIT 80`
    );
  }

  const opdTableCandidates = [
    'opd_calendar',
    'opd_schedule', 'opd_schedules', 'elective_opd', 'opd_assignment', 'opd', 'schedule',
  ];
  for (const t of opdTableCandidates) {
    if (!has(t)) continue;
    const tn = sqlIdent(t);
    if (!tn) continue;

    const dateCol = await pickOpdDateColumn(exec, tn);
    const dc = sqlIdent(dateCol) || 'date';
    const month = today.slice(0, 7);

    let opdMonth;
    if (tn === 'opd_calendar' && has('supervisors')) {
      opdMonth = await exec(
        `SELECT o.id, o.date, o.opd_type, o.supervisor_id, o.elective_ids, o.participant_label,
                o.notes, o.opd_mode, s.name AS supervisor_name, s.name_en AS supervisor_name_en
         FROM opd_calendar o
         LEFT JOIN supervisors s ON o.supervisor_id = s.id
         WHERE o.${dc} LIKE '${month}%'
         ORDER BY o.${dc}
         LIMIT 120`
      );
    } else {
      opdMonth = await exec(
        `SELECT * FROM ${tn} WHERE ${dc} LIKE '${month}%' ORDER BY ${dc} LIMIT 120`
      );
    }

    if (!opdMonth.length) {
      const wide = await exec(`SELECT * FROM ${tn} ORDER BY rowid DESC LIMIT 200`);
      opdMonth = wide.filter(r => cellToYmd(r[dc]).startsWith(month));
    }

    opdMonth = enrichOpdRows(opdMonth, electiveMap);
    res.opdMonth = opdMonth;
    res.opdToday = opdMonth.filter(r => cellToYmd(r[dc] ?? r.date) === today);
    break;
  }

  if (has('chiefs')) {
    const month = today.slice(0, 7);
    let ch = await exec(
      `SELECT * FROM chiefs WHERE month = '${month}' ORDER BY ward_code LIMIT 40`
    );
    if (!ch.length) {
      ch = await exec(
        `SELECT * FROM chiefs ORDER BY month DESC, ward_code LIMIT 40`
      );
    }
    res.chiefs = ch;
  }

  for (const t of ['ward_schedule', 'wards', 'ward', 'ward_chief']) {
    if (has(t)) {
      const wn = sqlIdent(t);
      if (wn) res.ward = await exec(`SELECT * FROM ${wn} ORDER BY rowid DESC LIMIT 40`);
      break;
    }
  }

  if (has('chief_residents')) {
    res.chief_residents = await exec(
      `SELECT * FROM chief_residents WHERE active = 1 ORDER BY name LIMIT 40`
    );
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

/* ── System prompt (ย่อ token ต่อรอบ = คุยต่อได้นานขึ้น / ลดโควตา) ── */
const SYS_MAX_CELL = 200;
const SYS_MAX_FAQ_ANSWER = 420;

function truncSys(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

function buildSystem({ schedule, faq }) {
  const rows = (arr) => {
    if (!arr || arr.length === 0) return '  (ไม่มีข้อมูล)';
    return arr.map(r =>
      '  • ' + Object.entries(r)
        .filter(([k, v]) => isPublicDataKey(k) && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? truncSys(v, SYS_MAX_CELL) : v}`)
        .join(' | ')
    ).join('\n');
  };

  const formatFaqItems = (list) => {
    if (!list || list.length === 0) return '  (ไม่มีรายการ)';
    return list.map((it, i) => {
      const th = truncSys(String(it.answer_th ?? '').trim(), SYS_MAX_FAQ_ANSWER);
      const en = truncSys(String(it.answer_en ?? '').trim(), SYS_MAX_FAQ_ANSWER);
      return [
        `  [${i + 1}] ${it.tag_th ?? ''} / ${it.tag_en ?? ''}`,
        `      ตอบ (TH):\n${th.split('\n').map(l => '        ' + l).join('\n')}`,
        `      Answer (EN):\n${en.split('\n').map(l => '        ' + l).join('\n')}`,
      ].join('\n');
    }).join('\n\n');
  };

  const scheduleSection = schedule.ok ? `
=== ข้อมูลตารางเวรและผู้มา elective (วันที่: ${schedule.today}) ===

[ผู้มา elective]
${rows(schedule.electives)}

[แพทย์ / ทีมงาน]
${rows(schedule.doctors)}

[Chief / ward รายเดือน]
${rows(schedule.chiefs)}

[Chief residents]
${rows(schedule.chief_residents)}

[Ward]
${rows(schedule.ward)}

[OPD วันนี้ (${schedule.today})]
${rows(schedule.opdToday)}

[OPD เดือนนี้ทั้งหมด]
${rows(schedule.opdMonth)}
` : '\n[ยังไม่มีข้อมูลตารางเวร / OPD / ward]\n';

  const faqSection = faq.ok ? `
=== คำถาม–คำตอบกิจกรรม Elective ===
- ใช้บล็อกนี้เป็นหลักเมื่อถามเรื่องกิจกรรม elective / รอบวอร์ด / conference / OPD ทั่วไป / SelecX / หลังจบงาน
- เลือกข้อความตอบจาก answer_th หรือ answer_en ให้ตรงกับภาษาที่ผู้ใช้ใช้
- ถ้าคำถามเกี่ยวกับชื่อแพทย์ วันที่นัด OPD เฉพาะราย หรือตาราง ward รายวัน — ให้ยึดข้อมูลตารางเวรด้านบนเป็นหลัก (ไม่สมมติ)

[ประกาศ]
${rows(faq.config)}

[รายการคำตอบ]
${formatFaqItems(faq.items)}
` : '\n[ยังไม่มีข้อมูลคำถาม–คำตอบกิจกรรม Elective]\n';

  return `You are Hemato Bot — a helpful assistant for the Hematology Division, Siriraj Hospital (โรงพยาบาลศิริราช), Thailand.

RULES:
- Reply in the user's language. If the user's message is entirely English, reply entirely in English.
- For person names in English replies: use the English name only when a name_en / supervisor_name_en field is provided. If no English name is available, keep the Thai name exactly as written; do not transliterate or invent an English version.
- For Thai replies, use Thai names normally.
- Audience is elective students. Answer only what they need to know.
- Be concise, friendly, and accurate. Prefer 1 short paragraph or 1-5 bullets.
- NEVER invent names, dates, or schedules that are not in the data below.
- Never mention internal sources or technical details, including Turso, database, DB, API, token, key, schema, table names, IDs, or "ตามข้อมูลจาก...".
- Do not include raw IDs such as elective_ids, supervisor_id, or any code-like values in the answer.
- For specific schedules (who is on OPD which day, ward roster), use the schedule data only. Use supervisor_name and elective_names when present.
- For general elective activity content, prefer the Q&A content when it is available; otherwise use the static outline at the bottom.
- If the needed information is not available, say briefly: "ยังไม่มีข้อมูลนี้ในระบบครับ/ค่ะ" and do not suggest checking technical sources.

${scheduleSection}
${faqSection}
${faq.ok ? `
=== สรุป elective (ใช้เมื่อคำถาม–คำตอบด้านบนยังไม่ครอบคลุม) ===
• ตารางราวด์ / OPD ดูใน note กลุ่ม LINE elective
• OPD ห้อง 700 ชั้น 7 — ถึง ~9:00 น. ตรวจ ~9:00–12:00 น.
• Feedback: https://docs.google.com/forms/d/e/1FAIpQLSeHPePaS04OyV44_Uh3Hw1ifGKNaO5nK6tMqtXP_b-trJMffw/viewform
` : `
=== เนื้อหากิจกรรม Elective โลหิตวิทยา (สรุป — ใช้เมื่อไม่มีบล็อกคำถาม–คำตอบด้านบน) ===

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
`}
`.trim();
}

/* ── ตอบจากข้อมูลโดยไม่ใช้ AI (เมื่อเรียกโมเดลล้มเหลว) ─────────────── */
const FALLBACK_MAX = 5600;
const FALLBACK_CELL = 280;

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && m.content != null) {
      const t = String(m.content).trim();
      if (t) return t;
    }
  }
  return '';
}

function prefersThai(text) {
  const s = String(text || '');
  return /[\u0e00-\u0e7f]/.test(s);
}

function intentQuoteRequest(text) {
  const q = normQ(text);
  if (!q) return false;
  return /(^|[\s])quote([\s?!.,]|$)|คำคม|ข้อคิด|กำลังใจ|motivat|inspir|heme quote|hematology quote|hemato quote/.test(q);
}

function pickQuoteForText(text, wantTh) {
  const pool = wantTh ? HEMATO_QUOTES_TH : HEMATO_QUOTES_EN;
  if (!pool.length) return '';
  const seed = Array.from(String(text || '')).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return pool[seed % pool.length];
}

function buildQuoteReply(text) {
  const wantTh = prefersThai(text);
  const quote = pickQuoteForText(text, wantTh);
  if (wantTh) {
    return `🩸 Hemato quote:\n${quote}\n\nถ้าอยากได้อีก บอกได้เลยว่า "ขอ quote อีก"`;
  }
  return `🩸 Hemato quote:\n${quote}\n\nIf you want another one, just ask for another quote.`;
}

function pickLocalizedName(row, wantTh, thKeys = ['name'], enKeys = ['name_en']) {
  const pick = (keys) => {
    for (const key of keys) {
      const v = String(row?.[key] ?? '').trim();
      if (v) return v;
    }
    return '';
  };
  const th = pick(thKeys);
  const en = pick(enKeys);
  if (wantTh) return th || en || '—';
  return en || th || '—';
}

function normQ(s) {
  return String(s || '').trim().toLowerCase();
}

function formatPublicRows(arr, maxRows) {
  if (!arr || !arr.length) return '';
  const lines = [];
  const n = Math.min(maxRows, arr.length);
  for (let i = 0; i < n; i++) {
    const r = arr[i];
    const bits = Object.entries(r)
      .filter(([k, v]) => isPublicDataKey(k) && v !== null && v !== '')
      .map(([k, v]) => {
        const t = typeof v === 'string' ? truncSys(v, FALLBACK_CELL) : v;
        return `${k}: ${t}`;
      });
    if (bits.length) lines.push('• ' + bits.join(' · '));
  }
  return lines.join('\n');
}

function scoreFaqItem(qNorm, item) {
  let score = 0;
  const blobs = [item.tag_th, item.tag_en, item.keywords_th, item.keywords_en];
  for (const b of blobs) {
    const s = normQ(b);
    if (s.length >= 3 && qNorm.includes(s)) score += Math.min(70, s.length * 2);
  }
  const splitKw = (s) =>
    String(s || '')
      .split(/[,，、]/)
      .map((x) => normQ(x))
      .filter((k) => k.length >= 2);
  for (const k of splitKw(item.keywords_th)) {
    if (qNorm.includes(k)) score += 14;
  }
  for (const k of splitKw(item.keywords_en)) {
    if (qNorm.includes(k)) score += 14;
  }
  const ath = normQ(item.answer_th);
  const aen = normQ(item.answer_en);
  for (const t of qNorm.split(/\s+/)) {
    if (t.length < 4) continue;
    if (ath.includes(t) || aen.includes(t)) score += 3;
  }
  return score;
}

function intentOpdToday(qNorm, raw) {
  const r = String(raw || '').toLowerCase();
  const opd = qNorm.includes('opd') || r.includes('opd');
  if (!opd) return false;
  return (
    qNorm.includes('วันนี้') ||
    qNorm.includes('today') ||
    (qNorm.includes('ใคร') && opd) ||
    /\bwho\b.*\bopd\b|\bopd\b.*\b(today|who)\b/i.test(r)
  );
}

function intentOpdMonth(qNorm) {
  return (
    qNorm.includes('opd') &&
    (qNorm.includes('เดือน') || qNorm.includes('month') || qNorm.includes('ตาราง'))
  );
}

function intentElectiveRoster(qNorm) {
  return (
    (qNorm.includes('elective') && (qNorm.includes('ใคร') || qNorm.includes('who') || qNorm.includes('มี'))) ||
    qNorm.includes('มีใคร') ||
    (qNorm.includes('นศพ') && qNorm.includes('ใคร'))
  );
}

function intentWardOrRound(qNorm) {
  return (
    qNorm.includes('ward') ||
    qNorm.includes('วอร์ด') ||
    qNorm.includes('ราวด์') ||
    qNorm.includes('round')
  );
}

/** ถามเวลาราวด์/วอร์ด — ห้ามตอบแค่รายชื่อ chief (ตาราง chiefs ไม่มีฟิลด์เวลา) */
function intentWardRoundTimeQuestion(qNorm) {
  if (!intentWardOrRound(qNorm)) return false;
  return /กี่โมง|几点|เวลาไหน|เวลาอะไร|เมื่อไร|what\s*time|what\s*hour|\bwhen\b.*\b(round|ward)|\b(round|ward)\b.*\bwhen\b/i.test(
    qNorm
  );
}

function wardRoundTimeFaqBonus(qNorm, item) {
  if (!intentWardRoundTimeQuestion(qNorm)) return 0;
  const blob = normQ(
    [item.tag_th, item.tag_en, item.keywords_th, item.keywords_en, item.answer_th, item.answer_en].join(' | ')
  );
  let b = 0;
  if (/ราวด์|ward\s*round|\bround\b|วอร์ด/.test(blob)) b += 28;
  if (/7:30|7\.30|เช้า|morning|บ่าย|afternoon|กี่โมง|เวลา/.test(blob)) b += 22;
  return b;
}

function staticWardRoundTimeBlock(wantTh, isDirectMode) {
  if (wantTh) {
    const lines = [
      'ราวด์วอร์ด — เวลาโดยสรุป (มาตรฐาน elective โลหิตวิทยา ศิริราช)',
      '',
      '• ราวด์เช้า: โดยทั่วไปประมาณ 7:30 น. — นัดยืนยันเวลาและจุดนัดกับ chief resident ล่วงหน้า (ทีมอาจเลื่อนเวลาได้)',
      '• บ่าย: ราวด์ consult / ดู blood smear หรือ bone marrow กับ attending ตามที่ทีมนัด',
      '',
      '• รายชื่อ Chief รายเดือนในฐานข้อมูลไม่ได้เก็บเวลาราวด์ — ถ้าต้องการชื่อ chief แยกถามว่า "chief วอร์ดชาย/หญิง เดือนนี้"',
      '• เวลาที่แน่นอนดูใน note กลุ่ม LINE elective หรือสอบถาม chief โดยตรง',
    ];
    if (!isDirectMode) lines.push('• เมื่อใช้ AI ได้ จะช่วยสรุปจาก FAQ/คำถามเดิมในระบบให้ละเอียดขึ้น');
    return lines.join('\n');
  }
  const lines = [
    'Ward rounds — typical timing (Hematology elective at Siriraj)',
    '',
    '• Morning round: usually around 7:30 — confirm time & meeting point with the chief resident in advance (may change).',
    '• Afternoon: consult rounds / smears / marrow with attending as arranged by the team.',
    '',
    '• The monthly chief roster in the database does not store round clock-times — ask separately for “chief male/female ward this month” if you need names.',
    '• For exact times, check the elective LINE group notes or ask the chief directly.',
  ];
  if (!isDirectMode) lines.push('• With AI enabled, answers can combine FAQ content more naturally.');
  return lines.join('\n');
}

function wantsScheduleKeywords(qNorm) {
  return /opd|ward|round|chief|schedule|ตาราง|ราวด์|วอร์ด|เมื่อไร|ช่วง|period|line|ไลน์|attending|นัด|กี่โมง|เวลา|slot|calendar|ดูงาน/.test(qNorm);
}

/** ถามวันแรก / ก่อนมา / first day — ห้ามตอบด้วยดัมป์ OPD+รายชื่อ */
function intentFirstDayQuestion(qNorm) {
  if (qNorm.includes('วันแรก')) return true;
  if (/\bfirst\s*day\b/.test(qNorm)) return true;
  if (qNorm.includes('ก่อนมาดูงาน') || qNorm.includes('ก่อนวันมา') || qNorm.includes('ก่อนมาวอร์ด')) return true;
  if (qNorm.includes('แรก') && (qNorm.includes('ต้อง') || qNorm.includes('ทำอะไร') || qNorm.includes('เตรียม') || qNorm.includes('ทำยังไง'))) return true;
  if (/\bwhat\b.*\b(do|bring)\b.*\bfirst\b/.test(qNorm)) return true;
  return false;
}

function firstDayFaqBonus(qNorm, item) {
  if (!intentFirstDayQuestion(qNorm)) return 0;
  const blob = normQ(
    [item.tag_th, item.tag_en, item.keywords_th, item.keywords_en, item.answer_th, item.answer_en].join(' | ')
  );
  let b = 0;
  if (/วันแรก|ก่อนมา|first\s*day|before\s*you|line|ไลน์|add\s*line|elective\s*line/.test(blob)) b += 42;
  if (/ราวด์|ward|opd|chief|resident|note/.test(blob)) b += 14;
  return b;
}

function staticFirstDayBlock(wantTh, isDirectMode = false) {
  if (wantTh) {
    const lines = [
      'วันแรก / ก่อนเริ่มดูงาน (สรุปมาตรฐาน elective โลหิตวิทยา ศิริราช)',
      '',
      '• Add เข้ากลุ่ม LINE elective ก่อนวันมา และแนะนำตัวกับทีม',
      '• ดูตารางราวด์วอร์ด + ตาราง OPD ใน note ของกลุ่ม LINE',
      '• นัดเวลาและสถานที่ราวด์กับ chief resident',
      '• OPD ห้อง 700 ชั้น 7 — โดยทั่วไป ถึง ~9:00 น. ช่วงตรวจ ~9:00–12:00 น.',
    ];
    if (!isDirectMode) lines.push('• เมื่อระบบ AI กลับมา สามารถถามตารางรายวัน/รายคนได้ละเอียดขึ้นจากข้อมูลในฐานข้อมูล');
    return lines.join('\n');
  }
  const lines = [
    'Before your first day (typical Hematology elective flow at Siriraj)',
    '',
    '• Join the elective LINE group before day one and introduce yourself to the team',
    '• Read ward round times and the OPD schedule in the LINE group notes',
    '• Confirm ward round time and place with the chief resident',
    '• OPD is usually room 700, 7th floor, OPD building (~arrive ~9:00; clinic ~9:00–12:00)',
  ];
  if (!isDirectMode) lines.push('• When the AI is back, ask again for person\u2011specific dates from the roster data');
  return lines.join('\n');
}

function intentLikelyGeneralActivity(qNorm) {
  return /conference|journal|lecture|selecx|feedback|กิจกรรม|อบรม|mm\b|grand/.test(qNorm);
}

function parseElectiveIdsFromRow(row) {
  try {
    const raw = row?.elective_ids;
    const ids = typeof raw === 'string' ? JSON.parse(raw || '[]') : Array.isArray(raw) ? raw : [];
    return ids.map(String);
  } catch {
    return [];
  }
}

function scoreElectiveAgainstQuery(qNorm, e) {
  let s = 0;
  const parts = [e.name, e.name_en, e.from_hospital].filter(Boolean);
  for (const p of parts) {
    const pn = normQ(p);
    if (!pn || pn.length < 2) continue;
    if (qNorm === pn) s += 220;
    else if (qNorm.includes(pn)) s += 95 + Math.min(50, pn.length);
    else if (pn.length >= 4 && pn.includes(qNorm)) s += 70;
    for (const t of qNorm.split(/[^a-z0-9\u0e00-\u0e7f]+/)) {
      if (t.length < 3) continue;
      if (pn.includes(t)) s += 18;
    }
  }
  return s;
}

function bestElectiveMatchFromQuery(rawQ, electives) {
  if (!electives || !electives.length) return null;
  const qNorm = normQ(rawQ);
  const qName = normalizeElectiveQueryName(rawQ);

  if (qName) {
    for (const e of electives) {
      for (const v of electiveNameVariants(e)) {
        if (qName === v) {
          return { elective: e, score: 260 };
        }
      }
    }

    let closeNameBest = null;
    let closeNameScore = 0;
    for (const e of electives) {
      for (const v of electiveNameVariants(e)) {
        if (!v) continue;
        if (v.includes(qName) || qName.includes(v)) {
          const sc = Math.min(180, 110 + v.length);
          if (sc > closeNameScore) {
            closeNameScore = sc;
            closeNameBest = e;
          }
        }
      }
    }
    if (closeNameBest) {
      return { elective: closeNameBest, score: closeNameScore };
    }
  }

  let best = null;
  let bestScore = 0;
  for (const e of electives) {
    const sc = scoreElectiveAgainstQuery(qNorm, e);
    if (sc > bestScore) {
      bestScore = sc;
      best = e;
    }
  }
  if (!best || bestScore < 22) return null;
  return { elective: best, score: bestScore };
}

function isLikelyElectiveNameQuery(rawQ, qNorm) {
  const raw = String(rawQ || '').trim();
  if (!raw) return false;
  if (wantsScheduleKeywords(qNorm) || intentLikelyGeneralActivity(qNorm)) return false;
  const compact = raw.replace(/\s+/g, ' ').trim();
  const tokenCount = compact.split(' ').filter(Boolean).length;
  if (tokenCount > 4) return false;
  return /^[A-Za-z\u0e00-\u0e7f.' -]+$/.test(compact);
}

function shouldShowPersonalElectiveCard(rawQ, qNorm, score) {
  if (intentLikelyGeneralActivity(qNorm) && !wantsScheduleKeywords(qNorm)) {
    return score >= 200;
  }
  if (score >= 95) return true;
  if (score >= 40 && wantsScheduleKeywords(qNorm)) return true;
  if (score >= 60 && isLikelyElectiveNameQuery(rawQ, qNorm)) return true;
  return false;
}

function parseDateRangeToYmds(s) {
  const text = String(s || '');
  const hits = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (hits.length >= 2) return [hits[0], hits[hits.length - 1]];
  if (hits.length === 1) return [hits[0], hits[0]];
  return [null, null];
}

function rangeOverlapDays(a1, a2, b1, b2) {
  if (!a1 || !a2 || !b1 || !b2) return 0;
  const toMs = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const A1 = toMs(a1);
  const A2 = toMs(a2);
  const B1 = toMs(b1);
  const B2 = toMs(b2);
  const start = Math.max(Math.min(A1, A2), Math.min(B1, B2));
  const end = Math.min(Math.max(A1, A2), Math.max(B1, B2));
  if (end < start) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

function wardGender(val) {
  const s = normQ(val);
  if (!s) return null;
  if (/(male|ชาย|men|man)/.test(s)) return 'male';
  if (/(female|หญิง|women|woman)/.test(s)) return 'female';
  return null;
}

function scoreDoctorRowForElective(e, d) {
  let score = 0;
  const eWard1 = normQ(e?.ward);
  const eWard2 = normQ(e?.ward2);
  const dWard1 = normQ(d?.ward1);
  const dWard2 = normQ(d?.ward2);
  if (eWard1 && dWard1 && eWard1 === dWard1) score += 35;
  if (eWard1 && dWard2 && eWard1 === dWard2) score += 18;
  if (eWard2 && dWard2 && eWard2 === dWard2) score += 22;
  if (eWard2 && dWard1 && eWard2 === dWard1) score += 10;

  // If ward labels differ (Thai/English), fall back to gender match.
  const eg1 = wardGender(e?.ward);
  const eg2 = wardGender(e?.ward2);
  const dg1 = wardGender(d?.ward1);
  const dg2 = wardGender(d?.ward2);
  if (eg1 && dg1 && eg1 === dg1) score += 18;
  if (eg1 && dg2 && eg1 === dg2) score += 10;
  if (eg2 && dg2 && eg2 === dg2) score += 12;
  if (eg2 && dg1 && eg2 === dg1) score += 6;

  const [e1s, e1e] = parseDateRangeToYmds(e?.date_range);
  const [e2s, e2e] = parseDateRangeToYmds(e?.date_range2);
  const [d1s, d1e] = parseDateRangeToYmds(d?.period1_dates);
  const [d2s, d2e] = parseDateRangeToYmds(d?.period2_dates);
  const ov1 = rangeOverlapDays(e1s, e1e, d1s, d1e);
  const ov2 = rangeOverlapDays(e2s, e2e, d2s, d2e);
  if (ov1) score += Math.min(50, ov1 * 4);
  if (ov2) score += Math.min(35, ov2 * 3);

  // Bonus: row actually has chief/link info
  if (String(d?.chief1_name || '').trim()) score += 8;
  if (String(d?.chief1_link || '').trim()) score += 8;
  if (String(d?.chief2_name || '').trim()) score += 4;
  if (String(d?.chief2_link || '').trim()) score += 4;
  return score;
}

function findDoctorForElective(e, doctors) {
  if (!doctors || !e) return null;
  // 1) Exact-ish name match (fast path)
  const targets = [normQ(e.name), normQ(e.name_en)].filter((t) => t && t.length >= 2);
  for (const d of doctors) {
    const dn = normQ(d.name);
    if (!dn) continue;
    for (const t of targets) {
      if (t && (dn.includes(t) || t.includes(dn))) return d;
    }
  }
  // 2) Ward + date-range overlap match (more reliable for chief roster tables)
  let best = null;
  let bestScore = 0;
  for (const d of doctors) {
    const sc = scoreDoctorRowForElective(e, d);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  return bestScore >= 35 ? best : null;
}

function opdDateSortKey(r) {
  return cellToYmd(r.date ?? r.opd_date ?? r.clinic_date ?? r.schedule_date ?? '');
}

function opdRowsForElectiveId(schedule, electiveId) {
  const id = String(electiveId);
  const pool = schedule.opdMonth || [];
  return pool
    .filter((r) => parseElectiveIdsFromRow(r).includes(id))
    .slice()
    .sort((a, b) => opdDateSortKey(a).localeCompare(opdDateSortKey(b)));
}

function lineIdDisplay(link) {
  const s = String(link ?? '').trim();
  if (!s) return '—';
  const at = s.match(/@[A-Za-z0-9._-]+/);
  if (at) return at[0];
  return truncSys(s, 80);
}

function firstNonEmptyFromKeys(row, keys) {
  for (const key of keys) {
    const v = String(row?.[key] ?? '').trim();
    if (v) return v;
  }
  return '';
}

function chiefLinkFromRow(row, prefix = '') {
  const base = prefix
    ? [
        `${prefix}_link`,
        `${prefix}_line_id`,
        `${prefix}_line`,
        `${prefix}_contact`,
        `${prefix}_line_url`,
      ]
    : ['chief_link', 'line_id', 'line', 'contact', 'chief_line_id', 'line_url', 'line_link'];
  return firstNonEmptyFromKeys(row, base);
}

function normalizePersonName(s) {
  return normQ(s).replace(/\s+/g, ' ').trim();
}

function chiefNameMatches(a, b) {
  const x = normalizePersonName(a);
  const y = normalizePersonName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function normalizeElectiveQueryName(s) {
  return normalizePersonName(s)
    .replace(/\b(นศพ|นพ|พญ)\.?\b/g, '')
    .replace(/[^a-z0-9\u0e00-\u0e7f ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function electiveNameVariants(e) {
  return [e?.name, e?.name_en]
    .map((v) => normalizeElectiveQueryName(v))
    .filter((v, i, arr) => v && arr.indexOf(v) === i);
}

function formatCardDateFromRow(r, wantTh) {
  const raw = r.date ?? r.opd_date ?? r.clinic_date ?? r.schedule_date;
  const ymd = cellToYmd(raw);
  if (!ymd || ymd.length < 10) return '—';
  const [y, mo, d] = ymd.split('-').map(Number);
  const local = new Date(y, mo - 1, d, 12, 0, 0);
  try {
    return local.toLocaleDateString(wantTh ? 'th-TH' : 'en-GB', {
      timeZone: 'Asia/Bangkok',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return ymd;
  }
}

function pickAttendingHint(d) {
  if (!d) return '—';
  const os = String(d.opd_schedule || '').trim();
  if (os) return truncSys(os.split('\n')[0], 140);
  const n = String(d.notes || '').trim();
  if (n) return truncSys(n, 140);
  return '—';
}

function pickChiefFromChiefsTable(chiefsRows, wardLabel) {
  if (!chiefsRows || !chiefsRows.length) return null;
  const g = wardGender(wardLabel);
  const want =
    g === 'male' ? ['male', 'm', 'men', 'ชาย'] :
    g === 'female' ? ['female', 'f', 'women', 'หญิง'] :
    [];

  for (const r of chiefsRows) {
    const name = String(r.chief_name || r.name || '').trim();
    if (!name) continue;
    if (!want.length) {
      return r;
    }
    const code = normQ(r.ward_code || r.ward || r.section || '');
    if (want.some(w => code.includes(w))) {
      return r;
    }
  }
  return null;
}

function findChiefResidentByName(chiefResidentsRows, name) {
  if (!chiefResidentsRows || !chiefResidentsRows.length || !name) return null;
  return chiefResidentsRows.find((r) =>
    chiefNameMatches(name, r?.name) || chiefNameMatches(name, r?.name_en)
  ) || null;
}

function buildChiefInfo({ doctor, chiefsRows, chiefResidentsRows, wardLabel, index, wantTh }) {
  const chiefPrefix = index === 2 ? 'chief2' : 'chief1';
  const nameTh = firstNonEmptyFromKeys(doctor, [`${chiefPrefix}_name`, `${chiefPrefix}_name_th`]);
  const nameEn = firstNonEmptyFromKeys(doctor, [`${chiefPrefix}_name_en`]);
  const rowLink = chiefLinkFromRow(doctor, chiefPrefix);

  const wardFallbackRow = pickChiefFromChiefsTable(chiefsRows, wardLabel);
  const wardFallbackName = pickLocalizedName(
    wardFallbackRow,
    wantTh,
    ['chief_name', 'name', 'chief_name_th'],
    ['chief_name_en', 'name_en', 'chief_name', 'name']
  );
  const wardFallbackLink = chiefLinkFromRow(wardFallbackRow);

  const residentMatch = findChiefResidentByName(
    chiefResidentsRows,
    nameTh || nameEn || wardFallbackName
  );
  const residentName = pickLocalizedName(residentMatch, wantTh);
  const residentLink = chiefLinkFromRow(residentMatch);

  const name = wantTh
    ? (nameTh || wardFallbackName || residentName || '—')
    : (nameEn || residentName || nameTh || wardFallbackName || '—');
  const link = lineIdDisplay(rowLink || residentLink || wardFallbackLink);
  return { name, link };
}

/** แสดงรอบ 2 เฉพาะเมื่อมีช่วงวันที่รอบ 2 ใน DB — ไม่พิมพ์แค่ ward2 โดยไม่มีวันที่ */
function hasSecondPeriodBlock(e, d) {
  const p2dates =
    String(e?.date_range2 ?? '').trim() || String(d?.period2_dates ?? '').trim();
  return p2dates.length > 0 && p2dates !== '—';
}

function formatElectiveScheduleCard(e, doctor, chiefsRows, chiefResidentsRows, opdRows, wantTh) {
  const display = pickLocalizedName(e, wantTh);
  const level = String(e.level || doctor?.type || '').trim() || '—';
  const p1Dates = String(e.date_range || doctor?.period1_dates || '').trim() || '—';
  const p1Ward = String(e.ward || doctor?.ward1 || '').trim() || '—';
  const chief1 = buildChiefInfo({
    doctor,
    chiefsRows,
    chiefResidentsRows,
    wardLabel: p1Ward,
    index: 1,
    wantTh,
  });
  const attend = pickAttendingHint(doctor);

  const lines = [];
  if (wantTh) {
    lines.push('สวัสดีค่ะ/ครับ 🧑‍⚕️');
    lines.push(`${display} (${level}) หน้าที่ดูงานและตารางโดยสรุปจากข้อมูลในระบบมีดังนี้:`);
    lines.push('');
    lines.push(`🟦 ช่วงที่ 1 (${p1Dates})`);
    lines.push(`🏥 วอร์ดที่ดูงาน: ${p1Ward}`);
    lines.push(`👑 Chief: ${chief1.name}`);
    lines.push(`📱 LINE: ${chief1.link}`);
    lines.push('(แนะนำให้ add LINE เพื่อนัดเวลา/สถานที่ราวด์วอร์ดกับ chief)');
    lines.push(`👨‍⚕️ อาจารย์/ทีมร่วมราวด์ (จากข้อมูล field): ${attend}`);
  } else {
    lines.push('Hello Dr. 🧑‍⚕️');
    lines.push(`${display} (${level}), your elective schedule is as follows:`);
    lines.push('');
    lines.push(`🟦 Period 1 (${p1Dates})`);
    lines.push(`🏥 Ward: ${p1Ward}`);
    lines.push(`👑 Chief: ${chief1.name}`);
    lines.push(`📱 LINE ID: ${chief1.link}`);
    lines.push('(Please add LINE to coordinate the ward round time and location.)');
    lines.push(`👨‍⚕️ Attending / notes from roster: ${attend}`);
  }

  if (hasSecondPeriodBlock(e, doctor)) {
    const p2d = String(e.date_range2 || doctor?.period2_dates || '').trim();
    const p2w = String(e.ward2 || doctor?.ward2 || '').trim() || '—';
    const chief2 = buildChiefInfo({
      doctor,
      chiefsRows,
      chiefResidentsRows,
      wardLabel: p2w,
      index: 2,
      wantTh,
    });
    lines.push('');
    lines.push(wantTh ? `🟪 ช่วงที่ 2 (${p2d})` : `🟪 Period 2 (${p2d})`);
    lines.push(wantTh ? `🏥 วอร์ดที่ดูงาน: ${p2w}` : `🏥 Ward duty: ${p2w}`);
    lines.push(`👑 Chief: ${chief2.name}`);
    if (chief2.link !== '—') lines.push(`${wantTh ? '📱 LINE' : '📱 LINE ID'}: ${chief2.link}`);
  }

  lines.push('');
  lines.push(wantTh ? '🏥 วันออก OPD (เดือนนี้จากฐานข้อมูล)' : '🏥 OPD Days');
  if (opdRows && opdRows.length) {
    for (const r of opdRows) {
      const when = formatCardDateFromRow(r, wantTh);
      const sup = pickLocalizedName(
        r,
        wantTh,
        ['supervisor_name', 'supervisor_name_th'],
        ['supervisor_name_en', 'supervisor_name']
      );
      lines.push(`• ${when} — ${wantTh ? 'กับ' : 'With'} ${sup}`);
    }
  } else {
    lines.push(wantTh ? '• (ยังไม่มีแถว OPD ที่ผูก elective_id นี้ในเดือนนี้)' : '• (No OPD rows linked to this elective for the current month.)');
  }

  lines.push('');
  lines.push(
    wantTh
      ? 'ขอให้ช่วง elective ที่ศิริราชมีความสุขและได้ความรู้เพิ่มขึ้นเยอะๆ นะครับ/ค่ะ 🩷'
      : 'Wishing you a joyful and rewarding elective at Siriraj Hospital and a wonderful time in Thailand 🩷'
  );
  return lines.join('\n');
}

function tryPersonalElectiveScheduleBlock(rawQ, qNorm, schedule, wantTh) {
  if (!schedule?.ok || !schedule.electives?.length) return null;
  const hit = bestElectiveMatchFromQuery(rawQ, schedule.electives);
  if (!hit || !shouldShowPersonalElectiveCard(rawQ, qNorm, hit.score)) return null;
  const doctor = findDoctorForElective(hit.elective, schedule.doctors || []);
  const opdRows = opdRowsForElectiveId(schedule, hit.elective.id);
  return formatElectiveScheduleCard(
    hit.elective,
    doctor,
    schedule.chiefs || [],
    schedule.chief_residents || [],
    opdRows,
    wantTh
  );
}

/* ── Human-readable schedule formatters ──────────────────────── */

/** แปลง YYYY-MM-DD เป็น "14 May 2026" หรือ "14 พ.ค. 2569" */
function ymdToHuman(ymd, wantTh) {
  if (!ymd || ymd.length < 10) return ymd || '—';
  const [y, mo, d] = ymd.split('-').map(Number);
  const dt = new Date(y, mo - 1, d, 12);
  try {
    return dt.toLocaleDateString(wantTh ? 'th-TH' : 'en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok',
    });
  } catch { return ymd; }
}

/** Format OPD rows เป็นประโยคอ่านได้ */
function formatOpdBlock(rows, todayLabel, wantTh, isMonth = false) {
  if (!rows || !rows.length) return '';
  const title = isMonth
    ? (wantTh ? '📅 ตาราง OPD เดือนนี้' : '📅 OPD Schedule this month')
    : (wantTh ? `📅 OPD วันนี้ (${todayLabel || ''})` : `📅 OPD today (${todayLabel || ''})`);

  const lines = [title];
  for (const r of rows.slice(0, 30)) {
    const dateRaw = r.date ?? r.opd_date ?? r.clinic_date ?? '';
    const dateStr = ymdToHuman(cellToYmd(dateRaw), wantTh);
    const sup = pickLocalizedName(
      r,
      wantTh,
      ['supervisor_name', 'supervisor_name_th'],
      ['supervisor_name_en', 'supervisor_name']
    );
    const elName = String(r.elective_names || '').trim();
    const mode = String(r.opd_mode || '').trim();
    const type = String(r.opd_type || '').trim();

    let line = `• ${dateStr}`;
    if (sup) line += wantTh ? ` — อาจารย์ ${sup}` : ` — with ${sup}`;
    if (elName) line += wantTh ? ` (${elName})` : ` (${elName})`;
    if (mode === 'solo') line += wantTh ? ' 🔵 solo' : ' 🔵 solo';
    lines.push(line);
  }
  return lines.join('\n');
}

/** Format elective roster เป็นภาษาคน */
function formatElectiveRosterBlock(electives, wantTh) {
  if (!electives || !electives.length) return '';
  const title = wantTh ? '👥 ผู้มาดูงาน elective ขณะนี้' : '👥 Current elective students';
  const lines = [title, ''];
  for (const e of electives.slice(0, 15)) {
    const name = pickLocalizedName(e, wantTh);
    const hosp = String(e.from_hospital || '').trim();
    const level = String(e.level || '').trim();
    const ward = String(e.ward || '').trim();
    const dateRange = String(e.date_range || '').trim();
    if (!name) continue;
    let line = `• ${name}`;
    if (level) line += ` (${level})`;
    if (hosp) line += wantTh ? ` จาก ${hosp}` : ` from ${hosp}`;
    if (dateRange) line += ` — ${dateRange}`;
    if (ward) line += wantTh ? ` | วอร์ด: ${ward}` : ` | Ward: ${ward}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** คืนข้อความหรือ null ถ้าไม่มีอะไรจะตอบได้เลย */
function fallbackReplyFromData(messages, schedule, faq, isDirectMode = false) {
  const rawQ = lastUserText(messages);
  const qNorm = normQ(rawQ);
  const wantTh = rawQ === '' ? true : prefersThai(rawQ);

  const head = isDirectMode
    ? ''  // โหมด DB โดยตรง: ไม่แสดงข้อความ error AI
    : (wantTh
        ? 'ตอนนี้เชื่อมต่อ AI ไม่ได้ จึงสรุปจากข้อมูลในระบบให้แบบย่อครับ:\n\n'
        : 'The AI service is unavailable. Here is a short summary from our records:\n\n');

  const hasSch = schedule && schedule.ok;
  const hasFaq = faq && faq.ok;
  if (!hasSch && !hasFaq) {
    return wantTh
      ? head + 'ยังโหลดข้อมูลตาราง/FAQ จากระบบไม่ได้ครับ ลองใหม่ภายหลังนะครับ'
      : head + 'We could not load schedule or FAQ data. Please try again later.';
  }

  if (hasSch) {
    const card = tryPersonalElectiveScheduleBlock(rawQ, qNorm, schedule, wantTh);
    if (card) {
      const out = head + card;
      return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
    }
  }

  if (intentFirstDayQuestion(qNorm)) {
    if (hasFaq && faq.items && faq.items.length) {
      const ranked = faq.items
        .map((it) => ({ it, s: scoreFaqItem(qNorm, it) + firstDayFaqBonus(qNorm, it) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (ranked.length && ranked[0].s >= 10) {
        const it = ranked[0].it;
        const ans = wantTh
          ? String(it.answer_th ?? '').trim() || String(it.answer_en ?? '').trim()
          : String(it.answer_en ?? '').trim() || String(it.answer_th ?? '').trim();
        if (ans) {
          const out = head + ans;
          return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
        }
      }
      if (ranked.length && ranked[0].s >= 4) {
        const top = ranked.slice(0, 2);
        const parts = [];
        for (let i = 0; i < top.length; i++) {
          const it = top[i].it;
          const tag = wantTh ? (it.tag_th || it.tag_en) : (it.tag_en || it.tag_th);
          const ans = wantTh
            ? String(it.answer_th ?? '').trim() || String(it.answer_en ?? '').trim()
            : String(it.answer_en ?? '').trim() || String(it.answer_th ?? '').trim();
          if (ans) parts.push(`${i + 1}) ${tag ? `[${tag}] ` : ''}${ans}`);
        }
        if (parts.length) {
          const out = head + parts.join('\n\n');
          return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
        }
      }
    }
    const out = head + staticFirstDayBlock(wantTh, isDirectMode);
    return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
  }

  // ── 1. ตารางจาก DB ก่อน (กัน FAQ ทั่วไปมาทับคำถาม OPD/วอร์ด) ───
  // ── 1a. OPD วันนี้ / เดือนนี้ ─────────────────────────────────
  if (hasSch && intentOpdToday(qNorm, rawQ)) {
    if (schedule.opdToday && schedule.opdToday.length) {
      const out = head + formatOpdBlock(schedule.opdToday, schedule.today, wantTh);
      return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
    }
    const emptyMsg = wantTh
      ? `📅 OPD วันนี้ (${schedule.today})\n\nยังไม่มีรายการ OPD สำหรับวันนี้ในฐานข้อมูลครับ (หรือวันที่ในระบบไม่ตรงกับวันนี้)`
      : `📅 OPD today (${schedule.today})\n\nNo OPD rows for today in the database (or dates may not match).`;
    const out = head + emptyMsg;
    return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
  }
  if (hasSch && intentOpdMonth(qNorm)) {
    if (schedule.opdMonth && schedule.opdMonth.length) {
      const out = head + formatOpdBlock(schedule.opdMonth, null, wantTh, true);
      return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
    }
    const emptyMsg = wantTh
      ? '📅 ตาราง OPD เดือนนี้\n\nยังไม่มีรายการในฐานข้อมูลสำหรับเดือนนี้ครับ'
      : '📅 OPD this month\n\nNo rows in the database for this month.';
    const out = head + emptyMsg;
    return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
  }

  // ── 1b. "ใครมา elective บ้าง" ───────────────────────────────
  if (hasSch && intentElectiveRoster(qNorm) && schedule.electives && schedule.electives.length) {
    const out = head + formatElectiveRosterBlock(schedule.electives, wantTh);
    return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
  }

  // ── 1c. เวลาราวด์วอร์ด (แยกจากรายชื่อ chief — DB ไม่มีฟิลด์เวลา) ──
  if (intentWardRoundTimeQuestion(qNorm)) {
    if (hasFaq && faq.items && faq.items.length) {
      const ranked = faq.items
        .map((it) => ({ it, s: scoreFaqItem(qNorm, it) + wardRoundTimeFaqBonus(qNorm, it) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (ranked.length && ranked[0].s >= 8) {
        const it = ranked[0].it;
        const ans = wantTh
          ? String(it.answer_th ?? '').trim() || String(it.answer_en ?? '').trim()
          : String(it.answer_en ?? '').trim() || String(it.answer_th ?? '').trim();
        if (ans) {
          const out = head + ans;
          return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
        }
      }
    }
    const out = head + staticWardRoundTimeBlock(wantTh, isDirectMode);
    return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
  }

  // ── 1d. ward / chief (เมื่อไม่ได้ถามแค่เวลาราวด์) ─────────────
  if (hasSch && intentWardOrRound(qNorm)) {
    const parts = [];
    if (schedule.ward && schedule.ward.length) {
      parts.push(formatPublicRows(schedule.ward, 20));
    }
    if (schedule.chiefs && schedule.chiefs.length) {
      const ch = schedule.chiefs.map(r =>
        `• ${r.ward_code || r.ward || ''} — Chief: ${r.chief_name || r.name || '—'}${r.month ? ' (' + r.month + ')' : ''}`
      ).join('\n');
      parts.push((wantTh ? 'Chief รายเดือน:\n' : 'Chiefs:\n') + ch);
    }
    if (parts.length) {
      const out = head + parts.join('\n\n');
      return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
    }
  }

  // ── 2. FAQ ทั่วไป (หลังจัดการคำถามตารางแล้ว — ไม่ให้ทับ OPD วันนี้) ──
  if (hasFaq && faq.items && faq.items.length) {
    const ranked = faq.items
      .map((it) => ({ it, s: scoreFaqItem(qNorm, it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (ranked.length && ranked[0].s >= 12) {
      const it = ranked[0].it;
      const ans = wantTh
        ? String(it.answer_th ?? '').trim() || String(it.answer_en ?? '').trim()
        : String(it.answer_en ?? '').trim() || String(it.answer_th ?? '').trim();
      if (ans) {
        const out = head + ans;
        return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
      }
    }
  }

  // ── 3. ไม่ match ตาราง/FAQ ชัดเจน: แนะนำให้ถามชื่อคน ────────────
  // ไม่ dump ข้อมูลทั้งหมด — ให้ถามชื่อที่ต้องการ
  const nameList = hasSch
    ? (schedule.electives || []).slice(0, 10)
        .map(e => String(e.name || e.name_en || '').trim())
        .filter(Boolean)
    : [];

  let helpMsg;
  if (nameList.length) {
    const listStr = nameList.map(n => `• ${n}`).join('\n');
    helpMsg = wantTh
      ? `ถามชื่อผู้มาดูงานได้เลยครับ เช่น "ไมตรี" หรือ "John" เพื่อดูตารางเฉพาะของเขา\n\nรายชื่อที่มีในระบบ:\n${listStr}\n\nหรือถามว่า "วันนี้ใครออก OPD?" / "ใครมา elective บ้าง?"`
      : `Ask me a name to see that person's schedule, e.g. "John" or "Maytree".\n\nNames currently in the system:\n${listStr}\n\nOr ask "Who is on OPD today?" or "Who is on elective now?"`;
  } else {
    helpMsg = wantTh
      ? 'ถามเรื่องตาราง elective ได้เลยครับ เช่น "วันนี้ใครออก OPD?" หรือ "ใครมา elective บ้าง?"'
      : 'Ask "Who is on OPD today?" or "Who is on elective now?" to see the schedule.';
  }

  const out = head + helpMsg;
  return out.length > FALLBACK_MAX ? out.slice(0, FALLBACK_MAX) + '…' : out;
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

async function callSambaNova(messages, system, key, env) {
  if (!key) {
    throw new Error(
      'ไม่พบ SambaNova API key ใน env ของฟังก์ชันนี้\n\n' +
      '• ต้องตั้งที่ Pages project เดียวกับเว็บ (Workers & Pages → เลือกโปรเจกต์ → Settings → Variables and secrets)\n' +
      '• ใช้ชื่อ SAMBANOVA_API_KEY, SAMBANOVA_KEY หรือ API_KEY (ตามตัวอย่าง $API_KEY ในแดชบอร์ด SambaNova — ต้องเป็น key ของ SambaNova ไม่ใช่ Groq)\n' +
      '• ถ้าใช้หน้า *.pages.dev จาก branch ลอง: ใส่ตัวแปรในแท็บ Preview ด้วย หรือ merge ไป main (Production)\n' +
      '• ถ้า deploy ด้วย wrangler โดยไม่ผูก secret กับ Pages ให้ใช้: wrangler pages secret put SAMBANOVA_API_KEY\n' +
      '• หลังเพิ่ม/แก้ค่าให้ Retry deployment หนึ่งครั้ง\n\n' +
      'ผู้ดูแลโปรเจกต์สมัคร key: https://cloud.sambanova.ai/'
    );
  }
  const model = stripSecret(env.SAMBANOVA_MODEL) || 'Meta-Llama-3.3-70B-Instruct';
  const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!r.ok) throw new Error(`SambaNova: ${await r.text()}`);
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

async function callOpenRouter(messages, system, key, env) {
  if (!key) {
    throw new Error(
      'ต้องใส่ OpenRouter API key ในหน้าเว็บ (บันทึก) หรือตั้ง OPENROUTER_API_KEY บนเซิร์ฟเวอร์ — https://openrouter.ai/keys'
    );
  }
  const model = env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (env.OPENROUTER_HTTP_REFERER) headers['HTTP-Referer'] = env.OPENROUTER_HTTP_REFERER;
  if (env.OPENROUTER_X_TITLE) headers['X-Title'] = env.OPENROUTER_X_TITLE;
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter: ${await r.text()}`);
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
