// 遠端對話中繼。沒回報的對話留在列表，重開程序也還在。
// ponytail: 整包寫進一個 json。對話變多、檔案變大再改 sqlite。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.KNOCK_TOKEN || '';
const PORT = Number(process.env.PORT || 8787);
const WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 2000;
const DATA = process.env.KNOCK_DATA || '/app/sessions.json';
const IMG_DIR = path.join(path.dirname(DATA), 'images');

function tokenOk(header) {
    const got = String(header || '').startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!TOKEN || !got) return false;
    const a = crypto.createHash('sha256').update(TOKEN).digest();
    const b = crypto.createHash('sha256').update(got).digest();
    return crypto.timingSafeEqual(a, b);
}

function cleanMessages(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(-40).map(m => ({
        id: String(m && m.id || '').slice(0, 80),
        text: String(m && m.text || '').slice(0, 500),
        quote: String(m && m.quote || '').slice(0, 200),
        image: /^[a-z0-9]{8,40}$/.test(m && m.image) ? m.image : '',
        mine: !!(m && m.mine),
        time: String(m && m.time || '').slice(0, 32)
    })).filter(m => m.id && (m.text || m.quote || m.image));
}

function applyHeartbeat(sessions, body, now) {
    const tabId = String(body && body.tabId || '').trim();
    if (!/^[a-z0-9]{8,40}$/.test(tabId)) return null;
    const prev = sessions.get(tabId);
    const title = String(body.title || '').trim().slice(0, 40) || '未命名';
    const session = {
        tabId,
        channelId: String(body.channelId || '').slice(0, 80),
        title,
        canType: !!body.canType,
        status: body.status === 'left' ? 'left' : 'live',
        messages: cleanMessages(body.messages),
        seen: now,
        outbox: prev ? prev.outbox : []
    };
    sessions.set(tabId, session);
    return session;
}

function visibleSessions(sessions, now, waitMs) {
    const out = [];
    for (const s of sessions.values()) {
        out.push({
            tabId: s.tabId,
            channelId: s.channelId,
            title: s.title,
            canType: s.canType,
            status: s.status,
            seen: s.seen,
            waiting: now - s.seen > waitMs,
            messages: s.messages,
            pending: s.outbox.length
        });
    }
    out.sort((a, b) => b.seen - a.seen);
    return out;
}

function loadSessions() {
    try {
        const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
        const map = new Map();
        for (const s of raw || []) {
            if (!s || !/^[a-z0-9]{8,40}$/.test(s.tabId)) continue;
            map.set(s.tabId, {
                tabId: s.tabId,
                channelId: String(s.channelId || '').slice(0, 80),
                title: String(s.title || '未命名').slice(0, 40),
                canType: !!s.canType,
                status: s.status === 'left' ? 'left' : 'live',
                messages: cleanMessages(s.messages),
                seen: Number(s.seen) || 0,
                outbox: keptOutbox(s.outbox)
            });
        }
        return map;
    } catch (e) {
        return new Map();
    }
}

function saveSessions(sessions) {
    fs.writeFileSync(DATA, JSON.stringify([...sessions.values()]));
}

// ponytail: 重開時還沒交出去的圖片直接丟掉，避免舊腳本把同一張再送進聊天室。
function keptOutbox(list) {
    return (Array.isArray(list) ? list : []).filter(item => item && !item.image).slice(-20);
}

function pendingOutbox(session) {
    const pending = [];
    let dirty = false;
    for (const item of session.outbox) {
        if (!item) continue;
        if (item.image) {
            if (item.handed) continue;
            item.handed = true;
            dirty = true;
        }
        pending.push(item);
    }
    return { pending, dirty };
}

function enqueue(session, text, now, image) {
    const item = {
        id: crypto.randomBytes(8).toString('hex'),
        text: String(text || '').trim().slice(0, 2000),
        image: /^[a-z0-9]{8,40}$/.test(image || '') ? image : '',
        at: now
    };
    if (!item.text && !item.image) return null;
    const last = session.outbox[session.outbox.length - 1];
    if (!item.image && last && !last.image && last.text === item.text && now - Number(last.at) < 2000) return last;
    if (session.outbox.length >= 20) session.outbox.shift();
    session.outbox.push(item);
    return item;
}

function selfCheck() {
    const sessions = new Map();
    const live = applyHeartbeat(sessions, {
        tabId: 'abc12345',
        title: ' 阿明 ',
        canType: true,
        messages: [{ id: 'm1', text: '嗨', mine: false }]
    }, 1000);
    enqueue(live, '回你', 1001);
    enqueue(live, '回你', 2000);
    applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 10000);
    applyHeartbeat(sessions, { tabId: 'zzzzzzzz', title: '舊', canType: false, status: 'left', messages: [] }, 1000);
    const vis = visibleSessions(sessions, 20000, 15000);
    const fresh = vis.find(s => s.tabId === 'abc12345');
    const old = vis.find(s => s.tabId === 'zzzzzzzz');
    if (!live || sessions.get('abc12345').outbox.length !== 1 || vis.length !== 2
        || !fresh || fresh.waiting || fresh.title !== '阿明' || !old || !old.waiting) {
        throw new Error('knock relay 檢查失敗');
    }
    if (applyHeartbeat(sessions, { tabId: '../x', title: 'x' }, 2000)) throw new Error('knock relay 檢查失敗');
    const imgItem = enqueue(sessions.get('abc12345'), '', 30000, 'abcd1234');
    const withImg = cleanMessages([{ id: 'imgmsg01', text: '', quote: '原文', image: 'abcd1234' }]);
    const handed = pendingOutbox(sessions.get('abc12345'));
    const again = pendingOutbox(sessions.get('abc12345'));
    const kept = keptOutbox([{ text: 'a' }, { image: 'abcd1234' }, { text: 'b' }]);
    if (!imgItem || !imgItem.image || withImg.length !== 1 || withImg[0].quote !== '原文' || withImg[0].image !== 'abcd1234'
        || handed.pending.filter(item => item.image).length !== 1
        || again.pending.some(item => item.image)
        || kept.length !== 2) {
        throw new Error('knock relay 檢查失敗');
    }
}

function pause(ms, req) {
    return new Promise(resolve => {
        let done = false;
        const socket = req.socket;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (socket) socket.removeListener('close', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        if (socket) socket.on('close', finish);
    });
}

function clientGone(req, res) {
    return res.writableEnded || res.destroyed || !req.socket || req.socket.destroyed;
}

function readRaw(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let n = 0;
        req.on('data', (c) => {
            n += c.length;
            if (n > max) {
                reject(new Error('too big'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function imageExt(type) {
    const t = String(type || '').toLowerCase();
    if (t.indexOf('image/png') === 0) return 'png';
    if (t.indexOf('image/gif') === 0) return 'gif';
    if (t.indexOf('image/jpeg') === 0 || t.indexOf('image/jpg') === 0) return 'jpg';
    return '';
}

function imagePath(id) {
    if (!/^[a-z0-9]{8,40}$/.test(id)) return '';
    for (const ext of ['jpg', 'png', 'gif']) {
        const file = path.join(IMG_DIR, id + '.' + ext);
        if (fs.existsSync(file)) return file;
    }
    return '';
}

function writeImage(id, buf, type) {
    const ext = imageExt(type);
    if (!ext || !/^[a-z0-9]{8,40}$/.test(id) || !buf || buf.length < 32 || buf.length > 1500000) return false;
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMG_DIR, id + '.' + ext), buf);
    return true;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let n = 0;
        req.on('data', (c) => {
            n += c.length;
            if (n > 200000) {
                reject(new Error('too big'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString() || '{}';
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function send(res, code, body, type) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, {
        'Content-Type': type || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(payload);
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Knock 遠端</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#111; color:#eee; }
  header { position:fixed; top:0; left:0; right:0; z-index:5; height:48px; box-sizing:border-box; padding:12px 16px; font-size:18px; border-bottom:1px solid #333; background:#111; }
  .tabs { position:fixed; top:48px; left:0; right:0; z-index:5; display:flex; gap:8px; padding:8px 12px; background:#111; border-bottom:1px solid #333; }
  .tabs button { flex:1; padding:8px; border:1px solid #444; border-radius:8px; background:#1c1c1c; cursor:pointer; }
  .tabs button.on { background:#2d5a3d; border-color:#2d5a3d; }
  .back { position:fixed; top:0; left:0; right:0; z-index:6; margin:0; border-radius:0; border-left:none; border-right:none; }
  main { max-width:640px; margin:0 auto; padding:108px 12px 88px; }
  body.in-thread header, body.in-thread .tabs { display:none; }
  body.in-thread main { padding-top:64px; }
  button, input { font:inherit; color:#eee; }
  .card, .msg { background:#1c1c1c; border:1px solid #333; border-radius:10px; }
  .card { display:block; width:100%; text-align:left; padding:12px; margin:0 0 8px; cursor:pointer; }
  .card small { display:block; color:#aaa; margin-top:4px; }
  .card small.preview { display:flex; gap:8px; align-items:baseline; color:#ffb74d; }
  .card small.preview .preview-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .card small.preview .preview-time { flex:none; color:#888; white-space:nowrap; }
  .card small.preview.mine { color:#9ccc65; }
  .new-msg { position:fixed; left:50%; bottom:72px; transform:translateX(-50%); z-index:7; padding:6px 14px; border:none; border-radius:16px; background:#ffb74d; color:#111; font-size:13px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35); }
  .bubble { display:flex; margin:0 0 8px; }
  .bubble.mine { justify-content:flex-end; }
  .bubble.them { justify-content:flex-start; }
  .bubble .msg { max-width:78%; margin:0; }
  .bubble.mine .msg { background:#2d5a3d; border-color:#2d5a3d; }
  .bubble.them .msg { background:#2d2d3d; }
  .msg { padding:8px 10px; white-space:pre-wrap; word-break:break-word; }
  .quote { font-size:12px; color:rgba(255,255,255,.7); border-left:2px solid rgba(255,255,255,.35); padding-left:6px; margin-bottom:6px; }
  .msg img.pic { display:block; max-width:100%; max-height:240px; border-radius:6px; margin-top:6px; }
  .time { display:block; margin-top:4px; font-size:11px; color:rgba(255,255,255,.55); }
  form { position:fixed; left:0; right:0; bottom:0; display:flex; gap:8px; padding:10px; background:#111; border-top:1px solid #333; }
  form input { flex:1; padding:10px; border-radius:8px; border:1px solid #444; background:#1a1a1a; }
  form input[type=file] { display:none; }
  form button { padding:10px 14px; border:none; border-radius:8px; background:#4CAF50; cursor:pointer; }
  form button.pick { background:#333; }
  form button:disabled { opacity:0.45; }
  .gate { display:flex; flex-direction:column; gap:8px; }
  .muted { color:#888; }
</style>
</head>
<body>
<header>Knock 遠端</header>
<main id="app"></main>
<script>
const TOKEN_KEY = 'knockRelayPageToken';
const app = document.getElementById('app');
let token = localStorage.getItem(TOKEN_KEY) || '';
let current = '';
let listTab = 'live';
let sessions = [];
let sending = false;
let lastSentText = '';
let lastSentAt = 0;
const picUrls = {};
let stickBottom = false;
let resetListScroll = false;
const seenTail = {};

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
  return fetch(path, opts).then(r => {
    if (r.status === 401) { token = ''; localStorage.removeItem(TOKEN_KEY); throw new Error('權杖不對'); }
    if (!r.ok) throw new Error('送出失敗');
    return r.json();
  });
}

function gate() {
  if (document.querySelector('.gate')) return;
  document.body.classList.remove('in-thread');
  clearChrome();
  app.replaceChildren();
  const box = document.createElement('div');
  box.className = 'gate';
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = '貼上權杖。這台裝置會記住。';
  const input = document.createElement('input');
  input.placeholder = '權杖';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '進入';
  btn.onclick = () => {
    token = input.value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    tick();
  };
  box.append(p, input, btn);
  app.append(box);
}

function statusText(s) {
  if (s.status === 'left') return '對方已離開';
  if (s.waiting) return '等待連線';
  if (!s.canType) return '現在不能回';
  if (s.pending) return '有 ' + s.pending + ' 則待送出';
  return '';
}

function tailId(s) {
  const ms = s && s.messages || [];
  return ms.length ? ms[ms.length - 1].id : '';
}

function stampToMs(text) {
  const raw = String(text || '').trim();
  const space = raw.lastIndexOf(' ');
  const datePart = space > 0 ? raw.slice(0, space) : '';
  const clockPart = space > 0 ? raw.slice(space + 1) : raw;
  const colon = clockPart.indexOf(':');
  if (colon < 1) return 0;
  const hh = parseInt(clockPart.slice(0, colon), 10);
  const mm = parseInt(clockPart.slice(colon + 1), 10);
  if (hh !== hh || mm !== mm) return 0;
  const slash = datePart.indexOf('/');
  const now = new Date();
  let month = parseInt(slash > 0 ? datePart.slice(0, slash) : '', 10);
  let day = parseInt(slash > 0 ? datePart.slice(slash + 1) : '', 10);
  const dated = month === month && day === day;
  if (!dated) { month = now.getMonth() + 1; day = now.getDate(); }
  let at = new Date(now.getFullYear(), month - 1, day, hh, mm).getTime();
  if (at > Date.now() + 60000) {
    at = dated ? new Date(now.getFullYear() - 1, month - 1, day, hh, mm).getTime() : at - 86400000;
  }
  return at;
}

function lastMessageAt(s) {
  const ms = s && s.messages || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    const at = stampToMs(ms[i].time);
    if (at) return at;
  }
  return 0;
}

function nearBottom() {
  const el = document.documentElement;
  return el.scrollHeight - window.scrollY - window.innerHeight < 80;
}

function scrollBottom() {
  window.scrollTo(0, document.documentElement.scrollHeight);
}

function canSend(s) {
  return !!(s && s.status !== 'left' && s.canType);
}

function clearForm() { document.querySelectorAll('form').forEach(f => f.remove()); }
function clearChrome() { document.querySelectorAll('.tabs,.back,.new-msg').forEach(el => el.remove()); }

function placeThread(s, follow, y) {
  if (!s) return;
  const tail = tailId(s);
  if (follow) {
    seenTail[s.tabId] = tail;
    stickBottom = false;
    scrollBottom();
    return;
  }
  window.scrollTo(0, y || 0);
  if (seenTail[s.tabId] === undefined) seenTail[s.tabId] = tail;
  if (!tail || seenTail[s.tabId] === tail) return;
  const chip = document.createElement('button');
  chip.className = 'new-msg';
  chip.type = 'button';
  chip.textContent = '有新訊息';
  chip.onclick = () => {
    const cur = sessions.find(x => x.tabId === s.tabId) || s;
    seenTail[s.tabId] = tailId(cur);
    chip.remove();
    scrollBottom();
  };
  document.body.append(chip);
}

function paintThread(s, follow, y) {
  document.body.classList.add('in-thread');
  clearChrome();
  const back = document.createElement('button');
  back.className = 'card back';
  back.type = 'button';
  back.textContent = '回到列表';
  back.onclick = () => { current = ''; resetListScroll = true; paint(); };
  document.body.append(back);
  app.replaceChildren();
  if (!s) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '這個視窗已經不在';
    app.append(p);
    return;
  }
  (s.messages || []).forEach(m => {
    const wrap = document.createElement('div');
    wrap.className = 'bubble ' + (m.mine ? 'mine' : 'them');
    const row = document.createElement('div');
    row.className = 'msg';
    if (m.quote) {
      const quote = document.createElement('div');
      quote.className = 'quote';
      quote.textContent = m.quote;
      row.append(quote);
    }
    if (m.text) {
      const text = document.createElement('div');
      text.textContent = m.text;
      row.append(text);
    }
    if (m.image) {
      const img = document.createElement('img');
      img.className = 'pic';
      img.alt = '圖片';
      row.append(img);
      showPic(m.image, img);
    }
    if (m.time) {
      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = m.time;
      row.append(time);
    }
    wrap.append(row);
    app.append(wrap);
  });
  placeThread(s, follow, y);
}

function paint() {
  if (!token) { clearForm(); return gate(); }
  const y = window.scrollY;
  const follow = stickBottom || (!!current && nearBottom());
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('form');
  if (focused && current) {
    const s = sessions.find(x => x.tabId === current);
    paintThread(s, follow, y);
    const input = document.querySelector('form input');
    const sendBtn = document.querySelector('form button');
    if (input) input.disabled = !canSend(s);
    document.querySelectorAll('form button').forEach(btn => { btn.disabled = sending || !canSend(s); });
    return;
  }
  const keepInput = document.querySelector('form input');
  const draft = keepInput && document.activeElement === keepInput ? keepInput.value : '';
  document.body.classList.remove('in-thread');
  app.replaceChildren();
  clearForm();
  clearChrome();
  if (!current) {
    if (resetListScroll) { window.scrollTo(0, 0); resetListScroll = false; }
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    [['live', '連線中'], ['quiet', '沒回報']].forEach(([id, label]) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = label;
      tab.className = listTab === id ? 'on' : '';
      tab.onclick = () => { listTab = id; paint(); };
      tabs.append(tab);
    });
    document.body.append(tabs);
    const shown = sessions.filter(s => listTab === 'quiet' ? s.waiting : !s.waiting)
      .sort((a, b) => lastMessageAt(b) - lastMessageAt(a) || (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));
    if (!shown.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = listTab === 'quiet' ? '沒有未回報的對話' : '沒有正在回報的對話';
      app.append(p);
      return;
    }
    shown.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'card';
      btn.type = 'button';
      const name = document.createElement('div');
      name.textContent = s.title || '未命名';
      const ms = s.messages || [];
      const last = ms[ms.length - 1];
      const sub = document.createElement('small');
      sub.className = 'preview' + (last && last.mine ? ' mine' : '');
      const label = document.createElement('span');
      label.className = 'preview-text';
      label.textContent = last ? (last.text || (last.image ? '圖片' : (last.quote || '還沒有訊息'))) : '還沒有訊息';
      sub.append(label);
      if (last && last.time) {
        const when = document.createElement('span');
        when.className = 'preview-time';
        when.textContent = last.time;
        sub.append(when);
      }
      btn.append(name, sub);
      const extra = statusText(s);
      if (extra) {
        const st = document.createElement('small');
        st.textContent = extra;
        btn.append(st);
      }
      btn.onclick = () => { current = s.tabId; stickBottom = true; paint(); };
      app.append(btn);
    });
    return;
  }
  const s = sessions.find(x => x.tabId === current);
  paintThread(s, follow, y);
  if (!s) return;
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.maxLength = 2000;
  input.placeholder = canSend(s) ? (s.waiting ? '等待連線，送出後會代送' : '輸入訊息') : statusText(s);
  input.disabled = !canSend(s);
  input.value = draft;
  const sendBtn = document.createElement('button');
  sendBtn.textContent = '送出';
  sendBtn.disabled = sending || !canSend(s);
  form.append(input, sendBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !canSend(s) || sending) return;
    if (text === lastSentText && Date.now() - lastSentAt < 2000) {
      input.value = '';
      return;
    }
    sending = true;
    sendBtn.disabled = true;
    api('/api/sessions/' + encodeURIComponent(s.tabId) + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).then(() => {
      input.value = '';
      lastSentText = text;
      lastSentAt = Date.now();
    }).catch(err => { alert(err.message); }).finally(() => {
      sending = false;
      document.querySelectorAll('form button').forEach(btn => { btn.disabled = !canSend(s); });
    });
  };
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'pick';
  pick.textContent = '圖片';
  pick.disabled = sending || !canSend(s);
  pick.onclick = () => file.click();
  file.onchange = () => {
    const chosen = file.files && file.files[0];
    file.value = '';
    if (chosen) sendImage(s, chosen);
  };
  form.append(file, pick);
  document.body.append(form);
  if (draft) input.focus();
}

function showPic(id, img) {
  if (picUrls[id]) { img.src = picUrls[id]; return; }
  fetch('/api/images/' + id, { headers: { Authorization: 'Bearer ' + token } })
    .then(r => { if (!r.ok) throw new Error('no'); return r.blob(); })
    .then(blob => {
      picUrls[id] = URL.createObjectURL(blob);
      if (img.isConnected) img.src = picUrls[id];
    })
    .catch(() => {});
}

function shrinkFile(file) {
  if (file.type === 'image/gif') {
    if (file.size > 1200000) return Promise.reject(new Error('GIF 太大'));
    return Promise.resolve(file);
  }
  if (file.type !== 'image/jpeg' && file.type !== 'image/png' && file.type !== 'image/jpg') {
    return Promise.reject(new Error('只收 png、jpeg、gif'));
  }
  if (file.size <= 400000) return Promise.resolve(file);
  return createImageBitmap(file).then(bitmap => new Promise(resolve => {
    const scale = Math.min(1, 960 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    canvas.toBlob(blob => resolve(blob ? new File([blob], 'relay.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.8);
  }));
}

function sendImage(s, file) {
  if (!s || sending || !canSend(s)) return;
  sending = true;
  document.querySelectorAll('form button').forEach(btn => { btn.disabled = true; });
  shrinkFile(file).then(ready => api('/api/sessions/' + encodeURIComponent(s.tabId) + '/send-image', {
    method: 'POST',
    headers: { 'Content-Type': ready.type || 'image/jpeg' },
    body: ready
  })).catch(err => alert(err.message || '圖片送出失敗')).finally(() => {
    sending = false;
    document.querySelectorAll('form button').forEach(btn => { btn.disabled = !canSend(s); });
  });
}

let ticking = false;
let pollWait = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!token) return paint();
    const data = await api('/api/sessions' + (pollWait ? '?wait=1' : ''));
    sessions = data.sessions || [];
    paint();
  } catch (e) {
    if (!token) paint();
  } finally {
    ticking = false;
  }
}

async function loop() {
  for (;;) {
    const started = Date.now();
    await tick();
    pollWait = true;
    if (Date.now() - started < 1000) await new Promise(r => setTimeout(r, 2000));
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
loop();
</script>
</body>
</html>`;

function main() {
    const sessions = loadSessions();
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
            if (req.method === 'HEAD') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }
            return send(res, 200, PAGE, 'text/html; charset=utf-8');
        }
        if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
        try {
            if (req.method === 'GET' && url.pathname === '/api/sessions') {
                if (url.searchParams.get('wait') === '1') await pause(POLL_MS, req);
                if (clientGone(req, res)) return;
                return send(res, 200, { sessions: visibleSessions(sessions, Date.now(), WAIT_MS) });
            }
            if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
                const body = await readBody(req);
                const session = applyHeartbeat(sessions, body, Date.now());
                if (!session) return send(res, 400, { error: 'bad tab' });
                saveSessions(sessions);
                if (url.searchParams.get('wait') === '1') await pause(POLL_MS, req);
                if (clientGone(req, res)) return;
                const outbox = pendingOutbox(session);
                if (outbox.dirty) saveSessions(sessions);
                return send(res, 200, { ok: true, outbox: outbox.pending });
            }
            const imgMatch = url.pathname.match(/^\/api\/images\/([a-z0-9]{8,40})$/);
            if (imgMatch && req.method === 'GET') {
                const file = imagePath(imgMatch[1]);
                if (!file) return send(res, 404, { error: 'gone' });
                const ext = path.extname(file).slice(1);
                const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
                res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400' });
                fs.createReadStream(file).pipe(res);
                return;
            }
            if (imgMatch && req.method === 'POST') {
                if (imagePath(imgMatch[1])) return send(res, 200, { ok: true });
                const buf = await readRaw(req, 1500000);
                if (!writeImage(imgMatch[1], buf, req.headers['content-type'])) return send(res, 400, { error: 'bad image' });
                return send(res, 200, { ok: true });
            }
            const imgSend = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/send-image$/);
            if (req.method === 'POST' && imgSend) {
                const session = sessions.get(imgSend[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                if (!session.canType || session.status === 'left') return send(res, 409, { error: 'cannot send' });
                const buf = await readRaw(req, 1500000);
                const imageId = crypto.randomBytes(8).toString('hex');
                if (!writeImage(imageId, buf, req.headers['content-type'])) return send(res, 400, { error: 'bad image' });
                const item = enqueue(session, '', Date.now(), imageId);
                if (!item) return send(res, 400, { error: 'empty' });
                saveSessions(sessions);
                return send(res, 200, { ok: true, id: item.id });
            }
            const sendMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/send$/);
            if (req.method === 'POST' && sendMatch) {
                const session = sessions.get(sendMatch[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                if (!session.canType || session.status === 'left') return send(res, 409, { error: 'cannot send' });
                const body = await readBody(req);
                const item = enqueue(session, body.text, Date.now());
                if (!item) return send(res, 400, { error: 'empty' });
                saveSessions(sessions);
                return send(res, 200, { ok: true, id: item.id });
            }
            const ackMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/ack$/);
            if (req.method === 'POST' && ackMatch) {
                const session = sessions.get(ackMatch[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                const id = String(body.id || '');
                session.outbox = session.outbox.filter(item => item.id !== id);
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            return send(res, 404, { error: 'not found' });
        } catch (e) {
            return send(res, 400, { error: 'bad request' });
        }
    });
    server.listen(PORT, () => console.log('knock relay', PORT));
}

async function selfCheckWait() {
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await pause(200, req);
        if (clientGone(req, res)) return;
        send(res, 200, { ok: true, outbox: [{ id: '1', text: 'hi' }] });
    });
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const r = await fetch('http://127.0.0.1:' + port + '/api/heartbeat?wait=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    const data = await r.json();
    server.close();
    if (r.status !== 200 || !data.outbox || data.outbox.length !== 1) throw new Error('knock relay 檢查失敗');
}

selfCheck();
if (process.env.KNOCK_SELFTEST === '1') {
    selfCheckWait().then(() => process.exit(0)).catch(e => {
        console.error(e);
        process.exit(1);
    });
} else {
    main();
}
