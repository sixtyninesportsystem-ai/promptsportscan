/* ระบบสแกนหน้าเข้า-ออกงาน : ส่วนหน้า (ทำงานในเบราว์เซอร์ของโทรศัพท์) */
'use strict';

const $ = s => document.querySelector(s);
const MODEL_URL = 'models';
const SCAN_TIMEOUT = 20000;     // ให้เวลาสแกนต่อครั้ง (มิลลิวินาที)
const REG_SAMPLES = 5;          // จำนวนภาพตอนลงทะเบียน
const ADMIN_IDLE = 3 * 60000;   // ไม่ได้แตะหน้าผู้ดูแลเกิน 3 นาที กลับหน้าสแกนเอง
const REPEAT_BLOCK = 60000;     // กันสแกนซ้ำประเภทเดิมภายใน 1 นาที

/* ---------- เก็บข้อมูลในเครื่อง ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
let cfg = Object.assign({ url: '', key: '', pinHash: '', voice: true, photo: true, blink: true, thr: 0.45 }, store.get('cfg', {}));
let staff = store.get('staff', []);
let queue = store.get('queue', []);

let matcher = null, modelsReady = false, camReady = false;
let view = 'scan', adminPin = null, adminTouched = 0;
let scan = null, reg = null, busy = false;
const lastClock = {};

const video = $('#video'), overlay = $('#overlay');

/* ---------- เริ่มต้น ---------- */
init();
async function init() {
  tick(); setInterval(tick, 1000);
  bindUi();
  renderStaff();
  updateQueueBadge();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!cfg.url) { setCamMsg('ยังไม่ได้ตั้งค่า ไปที่แท็บ “ตั้งค่า” ก่อน'); }

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    modelsReady = true;
    buildMatcher();
  } catch (e) {
    setCamMsg('โหลดระบบจดจำใบหน้าไม่สำเร็จ ลองรีเฟรชหน้า'); console.error(e); return;
  }
  await startCamera();
  syncStaff();
  setInterval(syncStaff, 10 * 60000);
  setInterval(flushQueue, 60000);
  window.addEventListener('online', () => { flushQueue(); setNet(true); });
  window.addEventListener('offline', () => setNet(false));
  setNet(navigator.onLine);
  keepAwake();
  loop();
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
    });
    video.srcObject = stream;
    await new Promise(r => video.readyState >= 2 ? r() : (video.onloadeddata = r));
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    camReady = true;
    setCamMsg(cfg.url ? '' : 'ยังไม่ได้ตั้งค่า ไปที่แท็บ “ตั้งค่า” ก่อน');
  } catch (e) {
    setCamMsg('เปิดกล้องไม่ได้ กรุณาอนุญาตให้ใช้กล้อง แล้วรีเฟรชหน้า'); console.error(e);
  }
}

function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  const req = () => navigator.wakeLock.request('screen').catch(() => {});
  req();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') req(); });
}

/* ---------- วนตรวจจับใบหน้า ---------- */
async function loop() {
  if (camReady && modelsReady && !busy && (scan || reg)) {
    busy = true;
    try {
      const r = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks().withFaceDescriptor();
      draw(r);
      if (scan) handleScan(r); else if (reg) handleReg(r);
    } catch (e) { console.error(e); }
    busy = false;
  } else if (!scan && !reg) {
    clearOverlay();
  }
  if (adminPin && view !== 'scan' && Date.now() - adminTouched > ADMIN_IDLE && !reg) { lockAdmin(); show('scan'); }
  setTimeout(loop, 60);
}

function draw(r) {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!r) return;
  const b = r.detection.box;
  ctx.lineWidth = 4;
  ctx.strokeStyle = scan && (scan.blinked || !cfg.blink) ? '#22c55e' : '#facc15';
  ctx.strokeRect(b.x, b.y, b.width, b.height);
}
function clearOverlay() { overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); }

/* ---------- เช็กกระพริบตา (Eye Aspect Ratio) ---------- */
function ear(lm) {
  const e = pts => {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return (d(pts[1], pts[5]) + d(pts[2], pts[4])) / (2 * d(pts[0], pts[3]));
  };
  return (e(lm.getLeftEye()) + e(lm.getRightEye())) / 2;
}

/* ---------- สแกนเข้า-ออก ---------- */
function startScan(type) {
  if (!cfg.url) return toast(false, 'ยังไม่ได้ตั้งค่า', 'ให้ผู้ดูแลไปที่แท็บ “ตั้งค่า”');
  if (!matcher) return toast(false, 'ยังไม่มีพนักงาน', 'ให้ผู้ดูแลลงทะเบียนใบหน้าก่อน');
  if (!camReady) return toast(false, 'กล้องยังไม่พร้อม', 'รอสักครู่ หรือรีเฟรชหน้า');
  scan = { type, start: Date.now(), votes: [], base: 0, closed: false, blinked: false, frames: 0 };
  $('#btnIn').disabled = $('#btnOut').disabled = true;
  $('#btnCancel').classList.remove('hidden');
  setStatus('#scanStatus', type === 'in' ? 'เข้างาน: มองกล้อง' + (cfg.blink ? ' แล้วกระพริบตา 1 ครั้ง' : '') : 'ออกงาน: มองกล้อง' + (cfg.blink ? ' แล้วกระพริบตา 1 ครั้ง' : ''));
}

function stopScan() {
  scan = null;
  $('#btnIn').disabled = $('#btnOut').disabled = false;
  $('#btnCancel').classList.add('hidden');
  setStatus('#scanStatus', 'แตะปุ่มด้านล่าง แล้วมองกล้อง');
}

function handleScan(r) {
  if (Date.now() - scan.start > SCAN_TIMEOUT) {
    stopScan(); return toast(false, 'หมดเวลา', 'สแกนไม่สำเร็จ ลองใหม่อีกครั้ง (ไม่ต้องใส่แว่นดำ/หน้ากาก)');
  }
  if (!r) { scan.votes.push(null); trim(scan.votes); return setStatus('#scanStatus', 'ไม่พบใบหน้า กรุณามองกล้อง'); }

  const best = matcher.findBestMatch(r.descriptor);
  const label = best.label === 'unknown' ? null : best.label;
  scan.votes.push(label ? { id: label, d: best.distance } : null); trim(scan.votes);

  // ตรวจกระพริบตา: ตาปิดลงชัดเจน แล้วเปิดกลับ
  const e = ear(r.landmarks);
  scan.frames++;
  if (!scan.closed) scan.base = Math.max(e, scan.base * 0.97);
  if (scan.frames > 3 && !scan.closed && e < scan.base * 0.8) scan.closed = true;
  else if (scan.closed && e > scan.base * 0.9) { scan.blinked = true; scan.closed = false; }

  if (!label) return setStatus('#scanStatus', 'ไม่รู้จักใบหน้านี้ ขยับให้หน้าอยู่กลางจอ');
  if (cfg.blink && !scan.blinked) return setStatus('#scanStatus', 'พบใบหน้าแล้ว กรุณากระพริบตาช้าๆ 1 ครั้ง');

  // ต้องเจอคนเดิมอย่างน้อย 4 ใน 6 ภาพล่าสุด
  const recent = scan.votes.slice(-6).filter(v => v && v.id === label);
  if (recent.length < 4) return setStatus('#scanStatus', 'กำลังยืนยันตัวตน…');

  const dist = recent.reduce((a, v) => a + v.d, 0) / recent.length;
  const person = staff.find(s => s.id === label);
  const type = scan.type;
  const photo = cfg.photo ? snap(320) : '';
  stopScan();
  submitClock(person, type, dist, photo);
}
function trim(a) { while (a.length > 10) a.shift(); }

async function submitClock(person, type, dist, photo) {
  const key = person.id + type;
  if (lastClock[key] && Date.now() - lastClock[key] < REPEAT_BLOCK) {
    return toast(true, person.name, 'บันทึกไปแล้วเมื่อสักครู่', '', photo);
  }
  lastClock[key] = Date.now();
  const rec = { action: 'clock', staffId: person.id, name: person.name, type, distance: +dist.toFixed(3), ts: Date.now(), photo };
  const label = type === 'in' ? 'เข้างาน' : 'ออกงาน';
  const time = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  toast(true, person.name, label + ' ' + time + ' น.', 'กำลังส่งข้อมูล…', photo, type);
  speak((type === 'in' ? 'สวัสดีค่ะ คุณ' : 'ขอบคุณค่ะ คุณ') + person.name + ' ' + label + ' เวลา ' + time + ' นาฬิกา');
  try {
    await api(rec);
    $('#resNote').textContent = 'บันทึกเรียบร้อย';
  } catch (e) {
    if (e.network) {
      enqueue(rec);
      $('#resNote').textContent = 'เน็ตไม่เสถียร เก็บไว้ในเครื่องแล้ว จะส่งให้อัตโนมัติ';
    } else {
      $('#resNote').textContent = 'ส่งไม่สำเร็จ: ' + e.message;
      $('#resIcon').className = 'res-icon bad';
    }
  }
}

/* ---------- ลงทะเบียนใบหน้า ---------- */
const REG_HINTS = ['มองตรงกล้อง', 'หันซ้ายเล็กน้อย', 'หันขวาเล็กน้อย', 'เงยหน้าเล็กน้อย', 'ก้มหน้าเล็กน้อย'];

function startReg() {
  const id = $('#regId').value.trim(), name = $('#regName').value.trim();
  if (!id || !name) return setStatus('#regStatus', 'กรุณากรอกรหัสและชื่อ', 'bad');
  if (!camReady || !modelsReady) return setStatus('#regStatus', 'กล้องยังไม่พร้อม', 'bad');
  const exists = staff.find(s => s.id === id);
  if (exists && !confirm('รหัส ' + id + ' มีอยู่แล้ว (' + exists.name + ') ต้องการถ่ายหน้าใหม่ทับหรือไม่?')) return;
  reg = { id, name, samples: [], last: 0, photo: '' };
  $('#btnReg').disabled = true;
  setStatus('#regStatus', '1/' + REG_SAMPLES + ' ' + REG_HINTS[0]);
}

async function handleReg(r) {
  adminTouched = Date.now();
  if (!r || r.detection.score < 0.7) return setStatus('#regStatus', 'ไม่พบใบหน้าชัดเจน ขยับเข้าใกล้และหาที่สว่าง');
  if (Date.now() - reg.last < 900) return;
  reg.last = Date.now();
  reg.samples.push(Array.from(r.descriptor, v => +v.toFixed(5)));
  if (reg.samples.length === 1) reg.photo = snap(240);
  if (reg.samples.length < REG_SAMPLES) {
    return setStatus('#regStatus', (reg.samples.length + 1) + '/' + REG_SAMPLES + ' ' + REG_HINTS[reg.samples.length]);
  }
  // ครบแล้ว ตรวจว่าหน้าซ้ำกับคนอื่นไหม
  const r0 = reg; reg = null;
  if (matcher) {
    const m = matcher.findBestMatch(new Float32Array(r0.samples[0]));
    const other = m.label !== 'unknown' && m.label !== r0.id && m.distance < 0.4 && staff.find(s => s.id === m.label);
    if (other && !confirm('ใบหน้านี้คล้ายกับ “' + other.name + '” ที่ลงทะเบียนไว้แล้ว ยังต้องการบันทึกหรือไม่?')) {
      $('#btnReg').disabled = false; return setStatus('#regStatus', 'ยกเลิกแล้ว');
    }
  }
  setStatus('#regStatus', 'กำลังบันทึก…');
  try {
    const res = await api({ action: 'register', adminPin, id: r0.id, name: r0.name, descriptors: r0.samples, photo: cfg.photo ? r0.photo : '' });
    setStaff(res.staff);
    setStatus('#regStatus', 'ลงทะเบียน ' + r0.name + ' เรียบร้อย', 'ok');
    $('#regId').value = ''; $('#regName').value = '';
  } catch (e) {
    setStatus('#regStatus', 'บันทึกไม่สำเร็จ: ' + e.message, 'bad');
  }
  $('#btnReg').disabled = false;
}

async function deleteStaff(id) {
  const s = staff.find(x => x.id === id);
  if (!confirm('ลบ ' + (s ? s.name : id) + ' ออกจากระบบ?')) return;
  try { const res = await api({ action: 'deleteStaff', adminPin, id }); setStaff(res.staff); }
  catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
}

function renderStaff() {
  $('#staffCount').textContent = '(' + staff.length + ' คน)';
  $('#staffList').innerHTML = staff.map(s =>
    '<li><span><b>' + esc(s.id) + '</b> ' + esc(s.name) + '</span><button data-del="' + esc(s.id) + '">ลบ</button></li>'
  ).join('') || '<li>ยังไม่มีพนักงาน</li>';
}

function setStaff(list) {
  staff = list || [];
  store.set('staff', staff);
  buildMatcher(); renderStaff();
}

function buildMatcher() {
  if (!modelsReady) return;
  const labeled = staff.filter(s => s.descriptors && s.descriptors.length)
    .map(s => new faceapi.LabeledFaceDescriptors(s.id, s.descriptors.map(d => new Float32Array(d))));
  matcher = labeled.length ? new faceapi.FaceMatcher(labeled, cfg.thr) : null;
}

async function syncStaff() {
  if (!cfg.url) return;
  try { const res = await api({ action: 'staff' }); setStaff(res.staff); setNet(true); }
  catch (e) { if (e.network) setNet(false); }
}

/* ---------- รายงาน ---------- */
async function loadReport() {
  const date = $('#repDate').value;
  $('#sumTable').innerHTML = '<tr><td>กำลังโหลด…</td></tr>'; $('#logTable').innerHTML = '';
  try {
    const res = await api({ action: 'records', adminPin, date });
    if (res.sheetUrl) { $('#sheetLink').href = res.sheetUrl; $('#sheetLink').hidden = false; }
    const rows = res.records || [];
    const sum = {};
    rows.forEach(r => {
      const m = sum[r.id] || (sum[r.id] = { id: r.id, name: r.name, inT: '', outT: '' });
      if (r.type === 'เข้างาน' && (!m.inT || r.time < m.inT)) m.inT = r.time;
      if (r.type === 'ออกงาน' && (!m.outT || r.time > m.outT)) m.outT = r.time;
    });
    const hrs = (a, b) => { if (!a || !b) return '-'; const t = s => { const p = s.split(':'); return +p[0] * 60 + +p[1]; }; const h = (t(b) - t(a)) / 60; return h > 0 ? h.toFixed(2) : '-'; };
    $('#sumTable').innerHTML = '<tr><th>รหัส</th><th>ชื่อ</th><th>เข้า</th><th>ออก</th><th>ชม.</th></tr>' +
      (Object.values(sum).map(m => '<tr><td>' + esc(m.id) + '</td><td>' + esc(m.name) + '</td><td class="in">' + (m.inT.slice(0, 5) || '-') +
        '</td><td class="out">' + (m.outT.slice(0, 5) || '-') + '</td><td>' + hrs(m.inT, m.outT) + '</td></tr>').join('') || '<tr><td colspan="5">ไม่มีข้อมูลวันนี้</td></tr>');
    $('#logTable').innerHTML = '<tr><th>เวลา</th><th>ชื่อ</th><th>ประเภท</th><th>ความเหมือน</th><th>รูป</th></tr>' +
      rows.map(r => '<tr><td>' + esc(r.time) + '</td><td>' + esc(r.name) + '</td><td class="' + (r.type === 'เข้างาน' ? 'in' : 'out') + '">' + esc(r.type) +
        '</td><td>' + esc(r.score) + '</td><td>' + (r.photo.startsWith('http') ? '<a href="' + esc(r.photo) + '" target="_blank" rel="noopener">ดู</a>' : '') + '</td></tr>').join('');
  } catch (e) {
    $('#sumTable').innerHTML = '<tr><td>โหลดไม่สำเร็จ: ' + esc(e.message) + '</td></tr>';
  }
}

/* ---------- ติดต่อหลังบ้าน ---------- */
async function api(payload, conf) {
  const c = conf || cfg;
  if (!c.url) throw Object.assign(new Error('ยังไม่ได้ตั้งค่าลิงก์ Apps Script'), { network: false });
  let res;
  try {
    // ส่งแบบ text/plain เพื่อไม่ให้ติดปัญหา CORS ของ Google Apps Script
    res = await fetch(c.url, { method: 'POST', body: JSON.stringify(Object.assign({}, payload, { key: c.key })) });
  } catch (e) { throw Object.assign(new Error('เชื่อมต่ออินเทอร์เน็ตไม่ได้'), { network: true }); }
  let data;
  try { data = await res.json(); } catch (e) { throw Object.assign(new Error('ลิงก์ Apps Script ไม่ถูกต้อง หรือยังไม่ได้ตั้งสิทธิ์ให้ “ทุกคน”'), { network: false }); }
  if (!data.ok) throw Object.assign(new Error(data.error || 'เกิดข้อผิดพลาด'), { network: false });
  return data;
}

function enqueue(rec) {
  queue.push(rec);
  if (!store.set('queue', queue)) { rec.photo = ''; queue.forEach(q => q.photo = ''); store.set('queue', queue); }
  updateQueueBadge();
}

let flushing = false;
async function flushQueue() {
  if (flushing || !queue.length || !cfg.url) return;
  flushing = true;
  while (queue.length) {
    try { await api(queue[0]); queue.shift(); store.set('queue', queue); setNet(true); }
    catch (e) { if (e.network) { setNet(false); break; } queue.shift(); store.set('queue', queue); }
  }
  flushing = false;
  updateQueueBadge();
}

function updateQueueBadge() { $('#queueCount').textContent = queue.length; setNet(navigator.onLine); }

/* ---------- ผู้ดูแล ---------- */
async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('faceclock:' + s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function askPin() {
  return new Promise(resolve => {
    const box = $('#pinBox'), inp = $('#pinInput');
    inp.value = ''; $('#pinMsg').textContent = ''; box.classList.remove('hidden'); inp.focus();
    const done = v => { box.classList.add('hidden'); $('#pinOk').onclick = $('#pinCancel').onclick = inp.onkeydown = null; resolve(v); };
    $('#pinCancel').onclick = () => done(null);
    $('#pinOk').onclick = async () => {
      if ((await sha(inp.value)) === cfg.pinHash) done(inp.value);
      else { $('#pinMsg').textContent = 'รหัสไม่ถูกต้อง'; inp.value = ''; }
    };
    inp.onkeydown = e => { if (e.key === 'Enter') $('#pinOk').onclick(); };
  });
}

async function requireAdmin() {
  if (adminPin) return true;
  if (!cfg.pinHash) return true;            // ยังไม่เคยตั้งค่า (ครั้งแรก)
  const p = await askPin();
  if (p == null) return false;
  adminPin = p; adminTouched = Date.now();
  return true;
}
function lockAdmin() { adminPin = null; reg = null; $('#btnReg').disabled = false; }

async function saveSettings() {
  const next = Object.assign({}, cfg, {
    url: $('#setUrl').value.trim(), key: $('#setKey').value.trim(),
    voice: $('#setVoice').checked, blink: $('#setBlink').checked, photo: $('#setPhoto').checked, thr: +$('#setThr').value
  });
  const pin = $('#setPin').value.trim() || adminPin;
  if (!next.url || !next.key || !pin) return setStatus('#setStatus', 'กรุณากรอกให้ครบทั้ง 3 ช่อง', 'bad');
  setStatus('#setStatus', 'กำลังทดสอบ…');
  try {
    await api({ action: 'checkAdmin', adminPin: pin }, next);
    next.pinHash = await sha(pin);
    cfg = next; store.set('cfg', cfg); adminPin = pin;
    $('#setPin').value = '';
    buildMatcher(); setCamMsg('');
    setStatus('#setStatus', 'เชื่อมต่อสำเร็จ บันทึกแล้ว', 'ok');
    syncStaff(); flushQueue();
  } catch (e) {
    setStatus('#setStatus', 'ไม่สำเร็จ: ' + e.message, 'bad');
  }
}

function fillSettings() {
  $('#setUrl').value = cfg.url; $('#setKey').value = cfg.key; $('#setPin').value = '';
  $('#setPin').placeholder = cfg.pinHash ? 'เว้นว่างไว้ถ้าไม่เปลี่ยน' : '';
  $('#setVoice').checked = cfg.voice; $('#setBlink').checked = cfg.blink; $('#setPhoto').checked = cfg.photo;
  $('#setThr').value = cfg.thr; $('#thrVal').textContent = cfg.thr;
}

/* ---------- หน้าจอ ---------- */
async function show(v) {
  if (v !== 'scan' && !(await requireAdmin())) return;
  if (scan) stopScan();
  if (reg && v !== 'register') { reg = null; $('#btnReg').disabled = false; }
  view = v; adminTouched = Date.now();
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  const slot = document.querySelector('#view-' + v + ' .cam-slot');
  const cam = $('#cam');
  if (slot) { slot.appendChild(cam); cam.classList.remove('hidden'); } else cam.classList.add('hidden');
  if (v === 'settings') fillSettings();
  if (v === 'report') { if (!$('#repDate').value) $('#repDate').value = today(); loadReport(); }
}

function bindUi() {
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#btnIn').onclick = () => startScan('in');
  $('#btnOut').onclick = () => startScan('out');
  $('#btnCancel').onclick = stopScan;
  $('#btnReg').onclick = startReg;
  $('#staffList').onclick = e => { const id = e.target.dataset.del; if (id) deleteStaff(id); };
  $('#btnRep').onclick = loadReport;
  $('#btnSave').onclick = saveSettings;
  $('#btnFlush').onclick = flushQueue;
  $('#btnLock').onclick = () => { lockAdmin(); show('scan'); };
  $('#setThr').oninput = e => $('#thrVal').textContent = e.target.value;
  $('#result').onclick = hideToast;
  document.addEventListener('pointerdown', () => { adminTouched = Date.now(); });
  show('scan');
}

let toastTimer;
function toast(ok, name, text, note, photo, type) {
  $('#resIcon').className = 'res-icon' + (ok ? '' : ' bad');
  $('#resIcon').textContent = ok ? '✓' : '✕';
  if (ok && type) $('#resIcon').style.color = type === 'in' ? 'var(--in)' : 'var(--out)'; else $('#resIcon').style.color = '';
  $('#resName').textContent = name || '';
  $('#resText').textContent = text || '';
  $('#resNote').textContent = note || '';
  $('#resPhoto').src = photo || '';
  $('#result').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() { $('#result').classList.add('hidden'); }

function speak(text) {
  if (!cfg.voice || !('speechSynthesis' in window)) return;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'th-TH'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
}

function snap(w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = Math.round(w * video.videoHeight / video.videoWidth);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

function setStatus(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'status' + (sel === '#setStatus' ? ' small' : '') + (cls ? ' ' + cls : ''); }
function setCamMsg(t) { $('#camMsg').textContent = t; }
function setNet(on) {
  const b = $('#netBadge');
  b.textContent = (on ? 'ออนไลน์' : 'ออฟไลน์') + (queue.length ? ' · รอส่ง ' + queue.length : '');
  b.classList.toggle('off', !on);
}
function tick() {
  const d = new Date();
  $('#nowTime').textContent = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#nowDate').textContent = d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
