/* ระบบสแกนหน้าเข้า-ออกงาน : ส่วนหน้า (ทำงานในเบราว์เซอร์ของโทรศัพท์) */
'use strict';

const $ = s => document.querySelector(s);
const MODEL_URL = 'models';
const SCAN_TIMEOUT = 20000;     // ให้เวลาสแกนต่อครั้ง (มิลลิวินาที)
const REG_MAX = 10;             // จำนวนรูปสูงสุดต่อคนตอนลงทะเบียน
const ADMIN_IDLE = 3 * 60000;   // ไม่ได้แตะหน้าผู้ดูแลเกิน 3 นาที กลับหน้าสแกนเอง
const REPEAT_BLOCK = 60000;     // กันสแกนซ้ำประเภทเดิมภายใน 1 นาที

// ประเภทการสแกน (ต้องตรงกับ TYPES ใน Apps Script)
const TYPES = {
  in:        { label: 'เข้าเช้า',  color: '#16a34a' },
  break_out: { label: 'ออกเที่ยง', color: '#d97706' },
  break_in:  { label: 'เข้าบ่าย',  color: '#0284c7' },
  out:       { label: 'ออกเย็น',  color: '#ea580c' },
  ot_out:    { label: 'ออก OT',    color: '#7c3aed' },
  ot_noon:   { label: 'OT เที่ยง (ไม่พัก)', color: '#be185d' }
};
const TYPE_KEY = { 'OT เที่ยง': 'ot_noon', 'เข้างาน': 'in', 'พักเที่ยง': 'break_out', 'กลับจากพัก': 'break_in', 'ออกงาน': 'out' }; // ชื่อเดิม
Object.keys(TYPES).forEach(k => TYPE_KEY[TYPES[k].label] = k);

/* ---------- เก็บข้อมูลในเครื่อง ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
let cfg = Object.assign({ url: '', key: '', pinHash: '', voice: true, photo: true, blink: false, thr: 0.5,
  schedule: { start: '08:00', breakStart: '12:00', breakEnd: '13:00', end: '17:00' } }, store.get('cfg', {}));
// เวอร์ชัน 2: ค่าเริ่มต้นแบบเร็ว ไม่ต้องกระพริบตา จำง่ายขึ้น
if (!cfg.v || cfg.v < 2) { cfg.blink = false; cfg.thr = 0.5; cfg.v = 2; store.set('cfg', cfg); }
let staff = store.get('staff', []);
let queue = store.get('queue', []);

let matcher = null, modelsReady = false, camReady = false;
let view = 'scan', adminPin = null, adminTouched = 0;
let scan = null, busy = false, regFaces = [], regCamOn = false;
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
  setCamMsg(cfg.url ? 'กล้องจะเปิดเมื่อกดปุ่มสแกนด้านล่าง' : 'ยังไม่ได้ตั้งค่า ไปที่แท็บ “ตั้งค่า” ก่อน');
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
    setCamMsg('');
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function stopCamera() {
  const st = video.srcObject;
  if (st) st.getTracks().forEach(t => t.stop());
  video.srcObject = null; camReady = false;
  clearOverlay();
  setCamMsg('กล้องจะเปิดเมื่อกดปุ่มสแกนด้านล่าง');
}

function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  const req = () => navigator.wakeLock.request('screen').catch(() => {});
  req();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') req(); });
}

/* ---------- วนตรวจจับใบหน้า ---------- */
async function loop() {
  if (camReady && modelsReady && !busy && scan) {
    busy = true;
    try {
      const r = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks().withFaceDescriptor();
      draw(r);
      if (scan) handleScan(r);
    } catch (e) { console.error(e); }
    busy = false;
  }
  if (adminPin && view !== 'scan' && Date.now() - adminTouched > ADMIN_IDLE) { lockAdmin(); show('scan'); }
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
async function startScan(type) {
  if (!cfg.url) return toast(false, 'ยังไม่ได้ตั้งค่า', 'ให้ผู้ดูแลไปที่แท็บ “ตั้งค่า”');
  if (!modelsReady) return toast(false, 'ระบบยังโหลดไม่เสร็จ', 'รอสักครู่ แล้วลองใหม่');
  if (!matcher) return toast(false, 'ยังไม่มีพนักงาน', 'ให้ผู้ดูแลลงทะเบียนใบหน้าก่อน');
  unlockSpeech();
  setTypeBtns(true);
  setStatus('#scanStatus', 'กำลังเปิดกล้อง…');
  if (!camReady && !(await startCamera())) {
    setTypeBtns(false);
    setStatus('#scanStatus', 'แตะปุ่มด้านล่าง แล้วมองกล้อง');
    return toast(false, 'เปิดกล้องไม่ได้', 'กรุณาอนุญาตให้เว็บนี้ใช้กล้อง (แตะ 🔒 ข้างช่องลิงก์ > สิทธิ์ > กล้อง)');
  }
  scan = { type, start: Date.now(), votes: [], base: 0, closed: false, blinked: false, frames: 0 };
  $('#btnCancel').classList.remove('hidden');
  setStatus('#scanStatus', TYPES[type].label + ': มองกล้อง' + (cfg.blink ? ' แล้วกระพริบตา 1 ครั้ง' : ''));
}

function stopScan() {
  scan = null;
  stopCamera();
  setTypeBtns(false);
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

  // ต้องเจอคนเดิมอย่างน้อย 2 ใน 3 ภาพล่าสุด
  const recent = scan.votes.slice(-3).filter(v => v && v.id === label);
  if (recent.length < 2) return setStatus('#scanStatus', 'กำลังยืนยันตัวตน…');

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
  const label = TYPES[type].label;
  const time = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  toast(true, person.name, label + ' ' + time + ' น.', 'กำลังส่งข้อมูล…', photo, type);
  speak(person.name + ' สแกนสำเร็จ');
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

/* ---------- ลงทะเบียนใบหน้า (อัปโหลดรูป) ---------- */
async function onRegFiles(files) {
  adminTouched = Date.now();
  if (!modelsReady) return setStatus('#regStatus', 'ระบบยังโหลดไม่เสร็จ รอสักครู่', 'bad');
  const list = Array.from(files || []);
  let bad = 0, multi = 0;
  for (let i = 0; i < list.length; i++) {
    if (regFaces.length >= REG_MAX) break;
    setStatus('#regStatus', 'กำลังตรวจหาใบหน้า ' + (i + 1) + '/' + list.length + '…');
    try {
      const n = await addFaceFromCanvas(await fileToCanvas(list[i], 1024));
      if (!n) bad++; else if (n > 1) multi++;
    } catch (e) { console.error(e); bad++; }
    adminTouched = Date.now();
  }
  $('#regFile').value = '';
  renderRegFaces();
  let msg = 'ได้ใบหน้า ' + regFaces.length + ' รูป';
  if (bad) msg += ' · ไม่พบใบหน้า ' + bad + ' รูป';
  if (multi) msg += ' · มีหลายคนในรูป ' + multi + ' รูป (ใช้หน้าที่ใหญ่ที่สุด)';
  if (regFaces.length && regFaces.length < 3) msg += ' · แนะนำ 3-5 รูป';
  setStatus('#regStatus', msg, regFaces.length ? 'ok' : 'bad');
}

// หาใบหน้าในรูป แล้วเพิ่มเข้ารายการ คืนค่าจำนวนหน้าที่พบ (0 = ไม่พบ)
async function addFaceFromCanvas(cv) {
  const found = await faceapi
    .detectAllFaces(cv, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.4 }))
    .withFaceLandmarks().withFaceDescriptors();
  if (!found.length) return 0;
  const f = found.sort((x, y) => y.detection.box.area - x.detection.box.area)[0]; // ใช้หน้าที่ใหญ่ที่สุด
  regFaces.push({ desc: Array.from(f.descriptor, v => +v.toFixed(5)), thumb: cropFace(cv, f.detection.box, 200) });
  return found.length;
}

/* ---------- ถ่ายรูปนิ่งจากกล้องในหน้าลงทะเบียน ---------- */

async function openRegCam() {
  adminTouched = Date.now();
  if (!modelsReady) return setStatus('#regStatus', 'ระบบยังโหลดไม่เสร็จ รอสักครู่', 'bad');
  $('#regCamBox').classList.remove('hidden'); $('#btnCam').classList.add('hidden');
  setCamMsg('กำลังเปิดกล้อง…');
  if (!camReady && !(await startCamera())) {
    closeRegCam();
    return setStatus('#regStatus', 'เปิดกล้องไม่ได้ กรุณาอนุญาตให้เว็บนี้ใช้กล้อง (แตะ 🔒 ข้างช่องลิงก์ > สิทธิ์ > กล้อง)', 'bad');
  }
  regCamOn = true;
  setCamMsg('ให้หน้าอยู่กลางจอ แล้วกด “ถ่ายรูป”');
}

function closeRegCam() {
  regCamOn = false;
  stopCamera();
  $('#regCamBox').classList.add('hidden'); $('#btnCam').classList.remove('hidden');
}

async function takeShot() {
  adminTouched = Date.now();
  if (!camReady) return;
  if (regFaces.length >= REG_MAX) return setStatus('#regStatus', 'ครบ ' + REG_MAX + ' รูปแล้ว', 'bad');
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  $('#btnShot').disabled = true;
  setStatus('#regStatus', 'กำลังตรวจหาใบหน้า…');
  const n = await addFaceFromCanvas(c);
  $('#btnShot').disabled = false;
  renderRegFaces();
  if (!n) return setStatus('#regStatus', 'ไม่พบใบหน้าในรูปนี้ ขยับเข้าใกล้และหาที่สว่าง แล้วถ่ายใหม่', 'bad');
  const left = Math.max(0, 3 - regFaces.length);
  setStatus('#regStatus', 'ได้ใบหน้า ' + regFaces.length + ' รูป' + (left ? ' · ถ่ายอีก ' + left + ' รูป (หันซ้าย/ขวาเล็กน้อย)' : ' · พอแล้ว กด “บันทึกพนักงาน” ได้เลย'), 'ok');
}

function fileToCanvas(file, max) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดรูปไม่ได้')); };
    img.src = url;
  });
}

function cropFace(cv, box, size) {
  const pad = box.width * 0.35;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const w = Math.min(cv.width - x, box.width + pad * 2), h = Math.min(cv.height - y, box.height + pad * 2);
  const c = document.createElement('canvas'); c.width = size; c.height = Math.round(size * h / w);
  c.getContext('2d').drawImage(cv, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function renderRegFaces() {
  $('#regFaces').innerHTML = regFaces.map((f, i) =>
    '<div class="thumb"><img src="' + f.thumb + '" alt=""><button data-rm="' + i + '">✕</button></div>').join('');
  $('#btnReg').disabled = !regFaces.length;
}

async function saveReg() {
  adminTouched = Date.now();
  const id = $('#regId').value.trim(), name = $('#regName').value.trim();
  if (!id || !name) return setStatus('#regStatus', 'กรุณากรอกรหัสและชื่อ', 'bad');
  if (!regFaces.length) return setStatus('#regStatus', 'กรุณาเลือกรูปหน้าพนักงานก่อน', 'bad');
  const exists = staff.find(s => s.id === id);
  if (exists && !confirm('รหัส ' + id + ' มีอยู่แล้ว (' + exists.name + ') ต้องการใช้รูปชุดใหม่แทนหรือไม่?')) return;
  if (matcher) {
    const m = matcher.findBestMatch(new Float32Array(regFaces[0].desc));
    const other = m.label !== 'unknown' && m.label !== id && m.distance < 0.4 && staff.find(s => s.id === m.label);
    if (other && !confirm('ใบหน้านี้คล้ายกับ “' + other.name + '” ที่ลงทะเบียนไว้แล้ว ยังต้องการบันทึกหรือไม่?')) return;
  }
  $('#btnReg').disabled = true;
  setStatus('#regStatus', 'กำลังบันทึก…');
  try {
    const res = await api({ action: 'register', adminPin, id, name, descriptors: regFaces.map(f => f.desc), photo: cfg.photo ? regFaces[0].thumb : '' });
    setStaff(res.staff);
    setStatus('#regStatus', 'ลงทะเบียน ' + name + ' เรียบร้อย (' + regFaces.length + ' รูป)', 'ok');
    $('#regId').value = ''; $('#regName').value = ''; regFaces = []; renderRegFaces();
  } catch (e) {
    setStatus('#regStatus', 'บันทึกไม่สำเร็จ: ' + e.message, 'bad');
    $('#btnReg').disabled = false;
  }
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
    '<li><span><b>' + esc(s.id) + '</b> ' + esc(s.name) + (s.hasPin ? ' <small>· มี PIN</small>' : '') + '</span>' +
    '<span><button class="pin" data-pin="' + esc(s.id) + '">' + (s.hasPin ? 'รีเซ็ต PIN' : 'ตั้ง PIN') + '</button> ' +
    '<button data-del="' + esc(s.id) + '">ลบ</button></span></li>'
  ).join('') || '<li>ยังไม่มีพนักงาน</li>';
}

async function setStaffPin(id) {
  adminTouched = Date.now();
  const s = staff.find(x => x.id === id);
  const pin = prompt('ตั้ง PIN 4-6 หลัก ให้ ' + (s ? s.name : id) + '\n(พนักงานใช้ดูประวัติเวลาของตัวเอง)');
  if (pin == null) return;
  if (!/^\d{4,6}$/.test(pin.trim())) return alert('PIN ต้องเป็นตัวเลข 4-6 หลัก');
  try {
    const res = await api({ action: 'setPin', adminPin, id, pin: pin.trim() });
    setStaff(res.staff);
    alert('ตั้ง PIN ให้ ' + (s ? s.name : id) + ' แล้ว\nแจ้งพนักงาน: รหัส ' + id + ' / PIN ' + pin.trim());
  } catch (e) { alert('ตั้ง PIN ไม่สำเร็จ: ' + e.message); }
}

function staffLink() { return new URL('me.html', location.href).href.split('?')[0] + '?u=' + encodeURIComponent(cfg.url); }
async function copyStaffLink() {
  if (!cfg.url) return alert('ยังไม่ได้ตั้งค่าลิงก์ Apps Script');
  const link = staffLink();
  try { await navigator.clipboard.writeText(link); alert('คัดลอกลิงก์แล้ว ส่งให้พนักงานทาง LINE ได้เลย\n\n' + link); }
  catch (e) { prompt('คัดลอกลิงก์นี้ส่งให้พนักงาน', link); }
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
  try {
    const res = await api({ action: 'staff' }); setStaff(res.staff); setNet(true);
    if (res.schedule) { cfg.schedule = res.schedule; store.set('cfg', cfg); renderTypeBtns(); }
  }
  catch (e) { if (e.network) setNet(false); }
}

/* ---------- รายงาน ---------- */
async function loadReport() {
  const date = $('#repDate').value;
  $('#sumTable').innerHTML = '<tr><td>กำลังโหลด…</td></tr>'; $('#logTable').innerHTML = '';
  try {
    const res = await api({ action: 'records', adminPin, date });
    if (res.sheetUrl) { $('#sheetLink').href = res.sheetUrl; $('#sheetLink').hidden = false; }
    if (res.schedule) { cfg.schedule = res.schedule; store.set('cfg', cfg); }
    const rows = res.records || [];
    const sum = {};
    rows.forEach(r => {
      const key = TYPE_KEY[r.type]; if (!key) return;
      const m = sum[r.id] || (sum[r.id] = { id: r.id, name: r.name });
      const latest = key === 'out' || key === 'ot_out';
      if (!m[key] || (latest ? r.time > m[key] : r.time < m[key])) m[key] = r.time;
    });
    const hm = x => x ? x.slice(0, 5) : '-';
    $('#sumTable').innerHTML = '<tr><th>รหัส</th><th>ชื่อ</th><th>เข้า</th><th>พัก</th><th>กลับ</th><th>ออก</th><th>ออก OT</th><th>OT เที่ยง</th><th>ชม.ทำงาน</th><th>สาย(นาที)</th><th>OT ชม.</th></tr>' +
      (Object.values(sum).map(m => {
        const c = calcDay(m);
        return '<tr><td>' + esc(m.id) + '</td><td>' + esc(m.name) + '</td>' +
          ['in', 'break_out', 'break_in', 'out', 'ot_out', 'ot_noon'].map(k => '<td style="color:' + TYPES[k].color + '">' + hm(m[k]) + '</td>').join('') +
          '<td>' + (c.work === '' ? '-' : c.work.toFixed(2)) + '</td><td>' + (c.late || '-') + '</td><td>' + (c.ot ? c.ot.toFixed(2) : '-') + '</td></tr>';
      }).join('') || '<tr><td colspan="11">ไม่มีข้อมูลวันนี้</td></tr>');
    $('#logTable').innerHTML = '<tr><th>เวลา</th><th>ชื่อ</th><th>ประเภท</th><th>ความเหมือน</th><th>รูป</th></tr>' +
      rows.map(r => '<tr><td>' + esc(r.time) + '</td><td>' + esc(r.name) + '</td><td style="font-weight:600;color:' + ((TYPES[TYPE_KEY[r.type]] || {}).color || '') + '">' + esc(r.type) +
        '</td><td>' + esc(r.score) + '</td><td>' + (r.photo.startsWith('http') ? '<a href="' + esc(r.photo) + '" target="_blank" rel="noopener">ดู</a>' : '') + '</td></tr>').join('');
  } catch (e) {
    $('#sumTable').innerHTML = '<tr><td>โหลดไม่สำเร็จ: ' + esc(e.message) + '</td></tr>';
  }
}

/** คิดชั่วโมงทำงาน (หักพักเที่ยง), นาทีที่สาย, ชั่วโมง OT (สูตรเดียวกับใน Apps Script) */
function calcDay(m) {
  const toMin = x => { const p = String(x).split(':'); return +p[0] * 60 + +(p[1] || 0); };
  const t = x => x ? toMin(x) : null, sc = cfg.schedule;
  const a = t(m.in), b = t(m.break_out), c = t(m.break_in), d = t(m.out), o = t(m.ot_out);
  const S = toMin(sc.start), BS = toMin(sc.breakStart), BE = toMin(sc.breakEnd), E = toMin(sc.end);
  const end = d != null ? d : (o != null ? Math.min(o, E) : null);
  let work = null;
  if (b != null || c != null) {
    work = 0;
    if (a != null && b != null) work += Math.max(0, b - a);
    if (c != null && end != null) work += Math.max(0, end - c);
  } else if (a != null && end != null) {
    work = end - a;
    if (a < BE && end > BS) work -= (BE - BS);
    work = Math.max(0, work);
  }
  const late = (a != null ? Math.max(0, a - S) : 0) + (c != null ? Math.max(0, c - BE) : 0);
  // OT เที่ยง: ไม่พักกลางวัน ได้ OT เท่าช่วงพัก (เช่น 12:00-13:00 = 1 ชม.)
  const ot = (o != null ? Math.max(0, o - E) : 0) + (m.ot_noon ? BE - BS : 0);
  return { work: work == null ? '' : work / 60, late, ot: ot / 60 };
}

/* ---------- ปุ่มสแกน 5 แบบ (ปุ่มที่ตรงกับช่วงเวลาตอนนี้จะใหญ่และอยู่บนสุด) ---------- */
function suggestedType() {
  const toMin = x => { const p = String(x).split(':'); return +p[0] * 60 + +(p[1] || 0); };
  const sc = cfg.schedule, d = new Date(), now = d.getHours() * 60 + d.getMinutes();
  const at = (v, d) => toMin(v || d);
  if (now < at(sc.btnBreakOut, '11:30')) return 'in';
  if (now < at(sc.btnBreakIn, '12:30')) return 'break_out';
  if (now < at(sc.btnOut, '15:00')) return 'break_in';
  if (now < at(sc.btnOt, '18:00')) return 'out';
  return 'ot_out';
}
var lastSuggest = '';
function renderTypeBtns(force) {
  const sug = suggestedType();
  if (!force && sug === lastSuggest) return;
  lastSuggest = sug;
  // ปุ่มเดียวตามช่วงเวลา (ปุ่มอื่นซ่อนไว้ แตะ "สแกนรอบอื่น" เมื่อจำเป็น เช่น ลากลับก่อน)
  // ช่วงเที่ยง มีปุ่มใหญ่ 2 ปุ่ม: ออกเที่ยง (พักตามปกติ) และ OT เที่ยง (ไม่พักกลางวัน)
  const mains = sug === 'break_out' ? ['break_out', 'ot_noon'] : [sug];
  const others = Object.keys(TYPES).filter(k => mains.indexOf(k) < 0);
  $('#typeBtns').innerHTML = mains.map(k =>
    '<button data-type="' + k + '" class="big main" style="background:' + TYPES[k].color + '"' + (scan ? ' disabled' : '') + '>สแกน' + TYPES[k].label + '</button>').join('') +
    '<button id="btnMore" class="link more">สแกนรอบอื่น ▾</button>' +
    '<div id="moreBtns" class="more-btns hidden">' + others.map(k =>
      '<button data-type="' + k + '" class="big" style="background:' + TYPES[k].color + '">' + TYPES[k].label + '</button>').join('') + '</div>';
}
function setTypeBtns(disabled) { document.querySelectorAll('#typeBtns button').forEach(b => b.disabled = disabled); }

/* ---------- ติดต่อหลังบ้าน ---------- */
async function api(payload, conf) {
  const c = conf || cfg;
  if (!c.url) throw Object.assign(new Error('ยังไม่ได้ตั้งค่าลิงก์ Apps Script'), { network: false });
  let res;
  try {
    // ส่งแบบ text/plain เพื่อไม่ให้ติดปัญหา CORS ของ Google Apps Script
    res = await fetch(c.url, { method: 'POST', body: JSON.stringify(Object.assign({}, payload, { key: c.key })) });
  } catch (e) {
    const msg = navigator.onLine
      ? 'ติดต่อ Apps Script ไม่ได้ ตรวจว่าลิงก์ลงท้าย /exec และตอน Deploy ตั้ง “ผู้มีสิทธิ์เข้าถึง” เป็น “ทุกคน”'
      : 'เชื่อมต่ออินเทอร์เน็ตไม่ได้';
    throw Object.assign(new Error(msg), { network: true });
  }
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
function lockAdmin() { adminPin = null; regFaces = []; renderRegFaces(); if (regCamOn) closeRegCam(); }

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
    buildMatcher(); if (!scan) setCamMsg('กล้องจะเปิดเมื่อกดปุ่มสแกนด้านล่าง');
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
  if (regCamOn) closeRegCam();
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
  $('#typeBtns').onclick = e => {
    if (e.target.id === 'btnMore') { $('#moreBtns').classList.toggle('hidden'); return; }
    const t = e.target.dataset && e.target.dataset.type;
    if (t && !scan) { $('#moreBtns').classList.add('hidden'); startScan(t); }
  };
  renderTypeBtns(true); setInterval(() => renderTypeBtns(), 30000);
  $('#btnCancel').onclick = stopScan;
  $('#btnReg').onclick = saveReg;
  $('#btnPick').onclick = () => $('#regFile').click();
  $('#btnCam').onclick = openRegCam;
  $('#btnCamClose').onclick = closeRegCam;
  $('#btnShot').onclick = takeShot;
  $('#regFile').onchange = e => onRegFiles(e.target.files);
  $('#regFaces').onclick = e => { const i = e.target.dataset.rm; if (i != null) { regFaces.splice(+i, 1); renderRegFaces(); } };
  $('#staffList').onclick = e => { const d = e.target.dataset; if (d.del) deleteStaff(d.del); else if (d.pin) setStaffPin(d.pin); };
  $('#btnStaffLink').onclick = copyStaffLink;
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
  $('#resIcon').style.color = ok && type ? TYPES[type].color : '';
  $('#resName').textContent = name || '';
  $('#resText').textContent = text || '';
  $('#resNote').textContent = note || '';
  $('#resPhoto').src = photo || '';
  $('#result').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 2500);
}
function hideToast() { $('#result').classList.add('hidden'); }

// บางเครื่อง (โดยเฉพาะ iPhone) ต้องเริ่มเสียงจากการแตะปุ่มก่อน ถึงจะพูดเองภายหลังได้
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !cfg.voice || !('speechSynthesis' in window)) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); speechUnlocked = true; } catch (e) {}
}
function speak(text) {
  if (!cfg.voice || !('speechSynthesis' in window)) return;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'th-TH'; const th = speechSynthesis.getVoices().find(x => /^th/i.test(x.lang)); if (th) u.voice = th; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
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
