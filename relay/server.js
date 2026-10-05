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
const TALK_FILE = path.join(path.dirname(DATA), 'talks.json');
const IMG_DIR = path.join(path.dirname(DATA), 'images');
const TALK_KEEP = 800;

function tokenOk(header) {
    const got = String(header || '').startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!TOKEN || !got) return false;
    const a = crypto.createHash('sha256').update(TOKEN).digest();
    const b = crypto.createHash('sha256').update(got).digest();
    return crypto.timingSafeEqual(a, b);
}

function cleanUid(raw) {
    const s = String(raw || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(s)) return '';
    return s;
}

function archiveMessage(m) {
    const id = String(m && m.id || '').slice(0, 80);
    const text = String(m && m.text || '').slice(0, 500);
    const quote = String(m && m.quote || '').slice(0, 200);
    const image = /^[a-z0-9]{8,40}$/.test(m && m.image) ? m.image : '';
    const time = String(m && m.time || '').slice(0, 32);
    if (!id || !(text || quote || image)) return null;
    return { id, text, quote, image, mine: !!(m && m.mine), time };
}

// ponytail: 一人最多 800 則、最多 300 人，超過留最新的。要完整更久再改檔案。
function rememberTalk(talks, body, now) {
    const archive = body && body.archive;
    if (!archive || typeof archive !== 'object') return false;
    const uid = cleanUid(archive.uid);
    if (!uid) return false;
    const incoming = (Array.isArray(archive.messages) ? archive.messages : []).map(archiveMessage).filter(Boolean).slice(0, 40);
    const prev = talks.get(uid);
    if (!incoming.length && (!prev || prev.title === String(archive.title || '').trim().slice(0, 40))) return false;
    const map = new Map();
    for (const m of (prev && prev.messages) || []) if (m && m.id) map.set(m.id, m);
    let changed = !prev || prev.title !== String(archive.title || '').trim().slice(0, 40);
    for (const m of incoming) {
        const old = map.get(m.id);
        if (old && !m.time) m.time = old.time;
        if (old && !m.quote) m.quote = old.quote;
        if (!old || old.text !== m.text || old.quote !== m.quote || old.image !== m.image || old.mine !== m.mine || old.time !== m.time) changed = true;
        map.set(m.id, m);
    }
    if (!changed) return false;
    let messages = [...map.values()];
    if (messages.length > TALK_KEEP) messages = messages.slice(messages.length - TALK_KEEP);
    const title = String(archive.title || (prev && prev.title) || '').trim().slice(0, 40) || '未命名';
    if (!messages.length) return false;
    talks.set(uid, { uid, title, messages, updated: now });
    if (talks.size > 300) {
        let oldest = null;
        for (const t of talks.values()) {
            if (t.uid === uid) continue;
            if (!oldest || t.updated < oldest.updated) oldest = t;
        }
        if (oldest) talks.delete(oldest.uid);
    }
    return true;
}

function visibleTalks(talks) {
    return [...talks.values()]
        .map(t => ({ uid: t.uid, title: t.title, updated: t.updated, count: t.messages.length }))
        .sort((a, b) => b.updated - a.updated || (a.uid < b.uid ? -1 : 1));
}

function loadTalks() {
    try {
        const raw = JSON.parse(fs.readFileSync(TALK_FILE, 'utf8'));
        const map = new Map();
        for (const t of raw || []) {
            const uid = cleanUid(t && t.uid);
            if (!uid) continue;
            const messages = (Array.isArray(t.messages) ? t.messages : []).map(archiveMessage).filter(Boolean).slice(-TALK_KEEP);
            if (!messages.length) continue;
            map.set(uid, {
                uid,
                title: String(t.title || '未命名').slice(0, 40) || '未命名',
                messages,
                updated: Number(t.updated) || 0
            });
        }
        return map;
    } catch (e) {
        return new Map();
    }
}

function saveTalks(talks) {
    fs.writeFileSync(TALK_FILE, JSON.stringify([...talks.values()]));
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
    const channelId = String(body.channelId || '').slice(0, 80);
    const sameChannel = !!(prev && prev.channelId === channelId);
    const session = {
        tabId,
        channelId,
        title,
        canType: !!body.canType,
        status: body.status === 'left' ? 'left' : 'live',
        messages: cleanMessages(body.messages),
        seen: now,
        openings: body.openings
            ? cleanOpenings(body.openings, sameChannel ? prev.openings : null, now)
            : (sameChannel && prev && prev.openings) || null,
        avatarWanted: prev && typeof prev.avatarWanted === 'boolean' ? prev.avatarWanted : null,
        userWanted: prev && typeof prev.userWanted === 'boolean' ? prev.userWanted : null,
        controls: cleanControls(body.controls) || (prev && prev.controls) || null,
        controlWanted: prev ? prev.controlWanted : null,
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
            openings: s.openings || null,
            controls: s.controls || null,
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
                openings: cleanOpenings(s.openings, s.openings, Number(s.seen) || 0),
                avatarWanted: s.avatarWanted === true ? true : s.avatarWanted === false ? false : null,
                userWanted: s.userWanted === true ? true : s.userWanted === false ? false : null,
                controls: cleanControls(s.controls),
                controlWanted: cleanControls(s.controlWanted),
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

function controlHours(n, fallback) {
    let v = Number(n);
    if (!Number.isFinite(v) || v < 0.1) v = fallback;
    if (v > 48) v = 48;
    return Math.round(v * 10) / 10;
}

// 頁面上的 packControls 要跟這份欄位、順序一致。
function cleanControls(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const phoneTopic = String(raw.phoneTopic || '').trim();
    if (phoneTopic && !/^[A-Za-z0-9_-]{1,64}$/.test(phoneTopic)) return null;
    let keepMin = controlHours(raw.keepMin, 1.5);
    let keepMax = controlHours(raw.keepMax, 2.5);
    if (keepMax < keepMin) [keepMin, keepMax] = [keepMax, keepMin];
    return {
        auto: !!raw.auto,
        keep: !!raw.keep,
        keepText: String(raw.keepText || '').trim().slice(0, 200),
        keepMin,
        keepMax,
        userFilter: !!raw.userFilter,
        avatarFilter: !!raw.avatarFilter,
        browser: !!raw.browser,
        phone: !!raw.phone,
        phoneTopic,
        phoneTitle: String(raw.phoneTitle || '').trim().slice(0, 80) || 'Knock 新訊息'
    };
}

function sameControls(a, b) {
    const x = cleanControls(a);
    const y = cleanControls(b);
    if (!x || !y) return false;
    return JSON.stringify(x) === JSON.stringify(y);
}

function takeControlPatch(session) {
    if (!session.controlWanted) return { controls: null, dirty: false };
    if (sameControls(session.controls, session.controlWanted)) {
        session.controlWanted = null;
        return { controls: null, dirty: true };
    }
    return { controls: session.controlWanted, dirty: false };
}

function cleanAvatar(raw) {
    const s = String(raw || '').trim();
    if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return '';
    if (/^[a-z0-9]{8,40}$/.test(s)) return s;
    if (s === 'plain') return 'plain';
    return '';
}

function openingSide(text, old, now) {
    const t = String(text && text.text ? text.text : text || '').trim().slice(0, 200);
    if (!t) return null;
    const at = old && old.text === t && Number(old.at) ? Number(old.at) : now;
    return { text: t, at };
}

// ponytail: 發語詞沒有畫面上的時間，第一次收到就蓋上，同一句不再改。
function cleanOpenings(raw, prev, now) {
    if (!raw || typeof raw !== 'object') return null;
    const avatar = cleanAvatar(raw.avatar);
    const them = openingSide(raw.them, prev && prev.them, now);
    const mine = openingSide(raw.mine, prev && prev.mine, now);
    if (!them && !mine && !avatar) return null;
    return { them, mine, avatar, avatarOn: !!raw.avatarOn, userOn: !!raw.userOn };
}

function takeAvatarPatch(session) {
    if (typeof session.avatarWanted !== 'boolean') return { avatarOn: null, dirty: false };
    const current = !!(session.openings && session.openings.avatarOn);
    if (current === session.avatarWanted) {
        session.avatarWanted = null;
        return { avatarOn: null, dirty: true };
    }
    return { avatarOn: session.avatarWanted, dirty: false };
}

function takeUserPatch(session) {
    if (typeof session.userWanted !== 'boolean') return { userOn: null, dirty: false };
    const current = !!(session.openings && session.openings.userOn);
    if (current === session.userWanted) {
        session.userWanted = null;
        return { userOn: null, dirty: true };
    }
    return { userOn: session.userWanted, dirty: false };
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
    const wanted = cleanControls({ auto: 1, keep: 0, keepText: ' 嗨 ', keepMin: 2, keepMax: 1, phoneTopic: 'topic', phoneTitle: '' });
    sessions.get('abc12345').controlWanted = wanted;
    applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 11000);
    const keptWanted = sessions.get('abc12345').controlWanted;
    if (!wanted || wanted.keepMin !== 1 || wanted.keepMax !== 2 || wanted.keepText !== '嗨' || wanted.phoneTitle !== 'Knock 新訊息'
        || !keptWanted || keptWanted.phoneTopic !== 'topic'
        || cleanControls({ phoneTopic: 'a b' })
        || !sameControls(wanted, keptWanted)) {
        throw new Error('knock relay 檢查失敗');
    }
    const firstOpen = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '阿明', canType: true, channelId: 'c1',
        messages: [{ id: 'm1', text: '嗨', mine: false }],
        openings: { them: '嗨', mine: '你好', avatar: 'abcd1234', avatarOn: false }
    }, 12000);
    const againOpen = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '阿明', canType: true, channelId: 'c1',
        messages: [{ id: 'm1', text: '嗨', mine: false }],
        openings: { them: '嗨', mine: '你好', avatar: 'abcd1234', avatarOn: true }
    }, 13000);
    const nextOpen = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '阿明', canType: true, channelId: 'c2',
        messages: [{ id: 'm1', text: '嗨', mine: false }],
        openings: { them: '嗨', mine: '你好', avatar: 'abcd1234', avatarOn: false }
    }, 14000);
    if (!firstOpen.openings || firstOpen.openings.them.at !== 12000 || againOpen.openings.them.at !== 12000
        || !againOpen.openings.avatarOn || nextOpen.openings.them.at !== 14000
        || !cleanOpenings({ them: '嗨', userOn: true }, null, 1).userOn
        || cleanOpenings({ them: '嗨', avatar: 'https://firebasestorage.googleapis.com/v0/b/knocktalk-prod.appspot.com/o/users-common%2Favatars%2Fmale-user.svg?alt=media' }, null, 1).avatar
        || cleanOpenings({ them: '嗨', avatar: 'plain' }, null, 1).avatar !== 'plain'
        || cleanOpenings({ them: '' }, null, 1)) {
        throw new Error('knock relay 檢查失敗');
    }
    const talks = new Map();
    if (!rememberTalk(talks, { archive: { uid: 'user_one', title: '阿明', messages: [{ id: 'a', text: '嗨', mine: false, time: '10:01' }] } }, 1)
        || !rememberTalk(talks, { archive: { uid: 'user_one', title: '阿明', messages: [{ id: 'b', text: '在嗎', mine: true }] } }, 2)
        || rememberTalk(talks, { archive: { uid: 'user_one', title: '阿明', messages: [{ id: 'a', text: '嗨', mine: false }] } }, 3)
        || rememberTalk(talks, { archive: { uid: 'no', messages: [{ id: 'c', text: 'x' }] } }, 4)
        || talks.size !== 1
        || talks.get('user_one').messages.map(m => m.id).join() !== 'a,b'
        || visibleTalks(talks)[0].count !== 2) {
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
  header { position:fixed; top:0; left:0; right:0; z-index:5; height:48px; box-sizing:border-box; padding:8px 12px; font-size:18px; border-bottom:1px solid #333; background:#111; display:flex; align-items:center; justify-content:space-between; }
  header button { border:1px solid #444; background:#1c1c1c; border-radius:8px; padding:4px 10px; cursor:pointer; font-size:14px; }
  .tabs { position:fixed; top:48px; left:0; right:0; z-index:5; display:flex; gap:8px; padding:8px 12px; background:#111; border-bottom:1px solid #333; }
  .tabs button { flex:1; padding:8px; border:1px solid #444; border-radius:8px; background:#1c1c1c; cursor:pointer; }
  .tabs button.on { background:#2d5a3d; border-color:#2d5a3d; }
  .back { position:fixed; top:0; left:0; right:0; z-index:6; margin:0; border-radius:0; border-left:none; border-right:none; }
  .topbar { position:fixed; top:0; left:0; right:0; z-index:6; display:flex; }
  .topbar .card { margin:0; border-radius:0; flex:1; border-left:none; border-right:none; }
  .topbar .gear { flex:none; width:72px; border-radius:0; border:1px solid #333; background:#1c1c1c; cursor:pointer; }
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
  .who { display:flex; gap:10px; align-items:center; }
  .face { width:40px; height:40px; border-radius:50%; object-fit:cover; background:#333; flex:none; }
  svg.face { display:block; fill:#9a9a9a; }
  .open { display:flex; gap:12px; align-items:center; margin:0 0 12px; }
  .open .face { width:64px; height:64px; }
  .group { margin-left:auto; flex:none; display:flex; width:calc((100% - 76px) / 4); }
  .group button { flex:1; min-width:0; padding:6px 2px; border:1px solid #666; background:transparent; color:#eee; cursor:pointer; font-size:12px; white-space:nowrap; }
  .group button.on { background:#e53935; color:#fff; border-color:#e53935; }
  .group button:first-child { border-radius:8px 0 0 8px; }
  .group button:last-child { border-radius:0 8px 8px 0; }
  .group button:only-child { border-radius:8px; }
  .group button + button { border-left:1px solid rgba(0,0,0,.2); }
  .ctrl { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; box-sizing:border-box; text-align:left; padding:10px 12px; margin:0 0 8px; background:#1c1c1c; border:1px solid #333; border-radius:10px; cursor:pointer; }
  .sw { width:40px; height:22px; border-radius:11px; background:#555; position:relative; flex:none; }
  .sw.on { background:#4CAF50; }
  .sw i { width:18px; height:18px; border-radius:50%; background:#fff; position:absolute; top:2px; left:2px; }
  .sw.on i { left:20px; }
  .extra { display:flex; flex-direction:column; gap:8px; margin:-2px 0 8px; }
  .extra input { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #444; border-radius:8px; background:#1a1a1a; }
  .hours { display:flex; align-items:center; gap:6px; color:#aaa; font-size:13px; }
  .hours input { width:64px; }
</style>
</head>
<body>
<header><span>Knock 遠端</span><button type="button" id="controls-btn">控制</button></header>
<main id="app"></main>
<script>
const TOKEN_KEY = 'knockRelayPageToken';
const app = document.getElementById('app');
let token = localStorage.getItem(TOKEN_KEY) || '';
let current = '';
let archiveUid = '';
let archiveTalk = null;
let archiveUpdated = 0;
let archiveLoading = '';
let listTab = 'live';
let sessions = [];
let talks = [];
let sending = false;
let lastSentText = '';
let lastSentAt = 0;
const picUrls = {};
let stickBottom = false;
let resetListScroll = false;
let showControls = false;
let controlDraft = null;
let avatarDraft = null;
let userDraft = null;
let keepOpen = false;
let phoneOpen = false;
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

function talkClock(ms) {
  const d = new Date(ms);
  if (!ms || isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' : '') + n;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function loadArchive(uid) {
  if (!uid || archiveLoading === uid) return;
  archiveLoading = uid;
  api('/api/talks/' + encodeURIComponent(uid)).then(data => {
    if (archiveUid !== uid) return;
    archiveTalk = data.talk || null;
    archiveUpdated = archiveTalk ? archiveTalk.updated : 0;
    paint();
  }).catch(() => {}).finally(() => {
    if (archiveLoading === uid) archiveLoading = '';
  });
}

function paintArchive(talk, follow, y) {
  document.body.classList.add('in-thread');
  clearChrome();
  clearForm();
  const bar = document.createElement('div');
  bar.className = 'topbar';
  const back = document.createElement('button');
  back.className = 'card';
  back.type = 'button';
  back.textContent = '返回';
  back.style.flex = 'none';
  back.onclick = () => { archiveUid = ''; archiveTalk = null; resetListScroll = true; paint(); };
  const who = document.createElement('span');
  who.textContent = (talk && talk.title) || '對話記錄';
  who.style.cssText = 'flex:1;display:flex;align-items:center;padding:0 12px;background:#1c1c1c;border-bottom:1px solid #333;';
  bar.append(back, who);
  document.body.append(bar);
  app.replaceChildren();
  if (!talk) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '正在讀取對話記錄';
    app.append(p);
    return;
  }
  const messages = talk.messages || [];
  if (!messages.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '這份紀錄還沒有訊息';
    app.append(p);
    return;
  }
  messages.forEach(paintBubble);
  placeThread({ tabId: 'talk:' + archiveUid, messages }, follow, y);
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
function clearChrome() { document.querySelectorAll('.tabs,.back,.topbar,.new-msg').forEach(el => el.remove()); }

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

function topicOk(s) {
  if (!s) return true;
  if (s.length > 64) return false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-';
    if (!ok) return false;
  }
  return true;
}

function packControls(c) {
  c = c || {};
  let min = Number(c.keepMin);
  let max = Number(c.keepMax);
  if (!(min >= 0.1)) min = 1.5;
  if (!(max >= 0.1)) max = 2.5;
  if (min > 48) min = 48;
  if (max > 48) max = 48;
  min = Math.round(min * 10) / 10;
  max = Math.round(max * 10) / 10;
  if (max < min) { const t = min; min = max; max = t; }
  return {
    auto: !!c.auto,
    keep: !!c.keep,
    keepText: String(c.keepText || '').trim().slice(0, 200),
    keepMin: min,
    keepMax: max,
    userFilter: !!c.userFilter,
    avatarFilter: !!c.avatarFilter,
    browser: !!c.browser,
    phone: !!c.phone,
    phoneTopic: String(c.phoneTopic || '').trim(),
    phoneTitle: String(c.phoneTitle || '').trim().slice(0, 80) || 'Knock 新訊息'
  };
}

function shownControls() {
  if (controlDraft) return controlDraft;
  let found = null;
  sessions.forEach(s => {
    if (!s.controls) return;
    if (!found || s.seen > found.seen) found = s;
  });
  return found && found.controls;
}

function postControls(next) {
  const packed = packControls(next);
  if (!topicOk(packed.phoneTopic)) { alert('主題只接受英文、數字、底線和減號'); return; }
  controlDraft = packed;
  paint();
  api('/api/controls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(packed)
  }).catch(err => { controlDraft = null; alert(err.message || '設定失敗'); paint(); });
}

function switchBox(on) {
  const sw = document.createElement('div');
  sw.className = 'sw' + (on ? ' on' : '');
  sw.append(document.createElement('i'));
  return sw;
}

function controlRow(label, on, onToggle) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ctrl';
  const name = document.createElement('span');
  name.textContent = label;
  const sw = switchBox(on);
  sw.onclick = (e) => { e.stopPropagation(); onToggle(); };
  row.append(name, sw);
  return row;
}

function fieldInput(value, placeholder) {
  const input = document.createElement('input');
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.onkeydown = (e) => e.stopPropagation();
  return input;
}

function paintControls() {
  const btn = document.getElementById('controls-btn');
  if (btn) btn.textContent = '關閉';
  document.body.classList.remove('in-thread');
  app.replaceChildren();
  clearForm();
  clearChrome();
  const src = shownControls();
  if (!src) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '還沒有分頁回報設定。先讓敲敲看那一頁開著，並更新腳本。';
    app.append(p);
    return;
  }
  const c = packControls(src);
  const flip = (key) => { const next = packControls(c); next[key] = !c[key]; postControls(next); };
  const autoRow = controlRow('自動開啟新對話', c.auto, () => flip('auto'));
  autoRow.onclick = () => flip('auto');
  const keepRow = controlRow('持續連線', c.keep, () => flip('keep'));
  keepRow.onclick = () => { keepOpen = !keepOpen; paint(); };
  const userRow = controlRow('使用者過濾', c.userFilter, () => flip('userFilter'));
  userRow.onclick = () => flip('userFilter');
  const avatarRow = controlRow('大頭貼過濾', c.avatarFilter, () => flip('avatarFilter'));
  avatarRow.onclick = () => flip('avatarFilter');
  const browserRow = controlRow('瀏覽器通知', c.browser, () => flip('browser'));
  browserRow.onclick = () => flip('browser');
  const phoneRow = controlRow('手機通知', c.phone, () => flip('phone'));
  phoneRow.onclick = () => { phoneOpen = !phoneOpen; paint(); };
  app.append(autoRow, keepRow);
  if (keepOpen) {
    const extra = document.createElement('div');
    extra.className = 'extra';
    const sentence = fieldInput(c.keepText, '沒說話就送這句');
    sentence.onchange = () => postControls(Object.assign({}, c, { keepText: sentence.value }));
    const hours = document.createElement('div');
    hours.className = 'hours';
    const minInp = fieldInput(String(c.keepMin), '');
    minInp.type = 'number';
    minInp.min = '0.1';
    minInp.step = '0.1';
    const maxInp = fieldInput(String(c.keepMax), '');
    maxInp.type = 'number';
    maxInp.min = '0.1';
    maxInp.step = '0.1';
    const saveHours = () => postControls(Object.assign({}, c, { keepMin: minInp.value, keepMax: maxInp.value }));
    minInp.onchange = saveHours;
    maxInp.onchange = saveHours;
    const tilde = document.createElement('span');
    tilde.textContent = '～';
    const unit = document.createElement('span');
    unit.textContent = '小時';
    hours.append(minInp, tilde, maxInp, unit);
    extra.append(sentence, hours);
    app.append(extra);
  }
  app.append(userRow, avatarRow, browserRow, phoneRow);
  if (phoneOpen) {
    const extra = document.createElement('div');
    extra.className = 'extra';
    const topic = fieldInput(c.phoneTopic, 'ntfy 主題');
    topic.onchange = () => postControls(Object.assign({}, c, { phoneTopic: topic.value }));
    const title = fieldInput(c.phoneTitle, 'Knock 新訊息');
    title.onchange = () => postControls(Object.assign({}, c, { phoneTitle: title.value }));
    extra.append(topic, title);
    app.append(extra);
  }
}

function openingClock(ms) {
  const d = new Date(Number(ms) || 0);
  if (!ms || Number.isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' : '') + n;
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function postAvatar(s, on) {
  if (!s || !s.openings) return;
  avatarDraft = { tabId: s.tabId, on: !!on };
  paint();
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: !!on })
  }).catch(err => { avatarDraft = null; alert(err.message || '設定失敗'); paint(); });
}

function postUser(s, on) {
  if (!s || !s.openings) return;
  userDraft = { tabId: s.tabId, on: !!on };
  paint();
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: !!on })
  }).catch(err => { userDraft = null; alert(err.message || '設定失敗'); paint(); });
}

function shownOpenings(s) {
  let o = s && s.openings;
  if (!o) return null;
  if (avatarDraft && avatarDraft.tabId === s.tabId) o = Object.assign({}, o, { avatarOn: avatarDraft.on });
  if (userDraft && userDraft.tabId === s.tabId) o = Object.assign({}, o, { userOn: userDraft.on });
  return o;
}

function paintBubble(m) {
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
}

function paintOpening(s) {
  const o = shownOpenings(s);
  if (!o) return;
  const box = document.createElement('div');
  box.className = 'open';
  if (o.avatar) {
    const face = faceNode(o.avatar);
    face.alt = '大頭貼';
    box.append(face);
  }
  const toggles = document.createElement('div');
  toggles.className = 'group';
  if (o.avatar) {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = '過濾大頭貼';
    if (o.avatarOn) row.className = 'on';
    row.onclick = () => postAvatar(s, !o.avatarOn);
    toggles.append(row);
  }
  const userRow = document.createElement('button');
  userRow.type = 'button';
  userRow.textContent = '過濾使用者';
  if (o.userOn) userRow.className = 'on';
  userRow.onclick = () => postUser(s, !o.userOn);
  toggles.append(userRow);
  box.append(toggles);
  app.append(box);
  const them = o.them && o.them.text ? { mine: false, text: o.them.text, time: openingClock(o.them.at) } : null;
  const mine = o.mine && o.mine.text ? { mine: true, text: o.mine.text, time: openingClock(o.mine.at) } : null;
  if (them) paintBubble(them);
  if (mine) paintBubble(mine);
}

function paintThread(s, follow, y) {
  document.body.classList.add('in-thread');
  clearChrome();
  const bar = document.createElement('div');
  bar.className = 'topbar';
  const back = document.createElement('button');
  back.className = 'card';
  back.type = 'button';
  back.textContent = '回到列表';
  back.onclick = () => { current = ''; resetListScroll = true; paint(); };
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'gear';
  gear.textContent = '控制';
  gear.onclick = () => { showControls = true; current = ''; paint(); };
  bar.append(back, gear);
  document.body.append(bar);
  app.replaceChildren();
  if (!s) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '這個視窗已經不在';
    app.append(p);
    return;
  }
  paintOpening(s);
  (s.messages || []).forEach(paintBubble);
  placeThread(s, follow, y);
}

function paint() {
  const gear = document.getElementById('controls-btn');
  if (gear) gear.textContent = showControls ? '關閉' : '控制';
  if (!token) { clearForm(); return gate(); }
  if (showControls) {
    const editing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest && document.activeElement.closest('#app');
    if (!editing) paintControls();
    return;
  }
  if (archiveUid) {
    const y = window.scrollY;
    const follow = stickBottom || nearBottom();
    paintArchive(archiveTalk, follow, y);
    return;
  }
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
    [['live', '連線中'], ['quiet', '沒回報'], ['talks', '紀錄']].forEach(([id, label]) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = label;
      tab.className = listTab === id ? 'on' : '';
      tab.onclick = () => { listTab = id; archiveUid = ''; archiveTalk = null; paint(); };
      tabs.append(tab);
    });
    document.body.append(tabs);
    if (listTab === 'talks') {
      if (!talks.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = '還沒有對話記錄';
        app.append(p);
        return;
      }
      talks.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'card';
        btn.type = 'button';
        const name = document.createElement('div');
        name.className = 'who';
        name.textContent = t.title || '未命名';
        const sub = document.createElement('small');
        sub.className = 'preview';
        const label = document.createElement('span');
        label.className = 'preview-text';
        label.textContent = (t.count || 0) + ' 則';
        sub.append(label);
        const when = document.createElement('span');
        when.className = 'preview-time';
        when.textContent = talkClock(t.updated);
        sub.append(when);
        btn.append(name, sub);
        btn.onclick = () => {
          archiveUid = t.uid;
          archiveTalk = null;
          archiveUpdated = 0;
          current = '';
          stickBottom = true;
          paint();
          loadArchive(t.uid);
        };
        app.append(btn);
      });
      return;
    }
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
      name.className = 'who';
      if (s.openings && s.openings.avatar) name.append(faceNode(s.openings.avatar));
      const title = document.createElement('span');
      title.textContent = s.title || '未命名';
      name.append(title);
      const ms = s.messages || [];
      const last = ms[ms.length - 1];
      const openingText = s.openings && ((s.openings.them && s.openings.them.text) || (s.openings.mine && s.openings.mine.text));
      const sub = document.createElement('small');
      sub.className = 'preview' + (last && last.mine ? ' mine' : '');
      const label = document.createElement('span');
      label.className = 'preview-text';
      label.textContent = last ? (last.text || (last.image ? '圖片' : (last.quote || openingText || '還沒有訊息'))) : (openingText || '還沒有訊息');
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
      btn.onclick = () => { archiveUid = ''; archiveTalk = null; current = s.tabId; stickBottom = true; paint(); };
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

function plainFace() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'face');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z');
  svg.append(path);
  return svg;
}

function faceNode(avatar) {
  if (avatar === 'plain') return plainFace();
  const img = document.createElement('img');
  img.className = 'face';
  img.alt = '';
  showPic(avatar, img);
  return img;
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
    talks = data.talks || [];
    if (archiveUid) {
      const sum = talks.find(t => t.uid === archiveUid);
      if (!archiveTalk || (sum && sum.updated !== archiveUpdated)) loadArchive(archiveUid);
    }
    if (controlDraft && sessions.some(s => s.controls && JSON.stringify(packControls(s.controls)) === JSON.stringify(controlDraft))) controlDraft = null;
    if (avatarDraft) {
      const hit = sessions.find(s => s.tabId === avatarDraft.tabId);
      if (hit && hit.openings && !!hit.openings.avatarOn === avatarDraft.on) avatarDraft = null;
    }
    if (userDraft) {
      const hit = sessions.find(s => s.tabId === userDraft.tabId);
      if (hit && hit.openings && !!hit.openings.userOn === userDraft.on) userDraft = null;
    }
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
document.getElementById('controls-btn').onclick = () => { showControls = !showControls; if (showControls) current = ''; paint(); };
loop();
</script>
</body>
</html>`;

function main() {
    const sessions = loadSessions();
    const talks = loadTalks();
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
                return send(res, 200, { sessions: visibleSessions(sessions, Date.now(), WAIT_MS), talks: visibleTalks(talks) });
            }
            const talkMatch = url.pathname.match(/^\/api\/talks\/([A-Za-z0-9_-]{6,128})$/);
            if (req.method === 'GET' && talkMatch) {
                const talk = talks.get(talkMatch[1]);
                if (!talk) return send(res, 404, { error: 'gone' });
                return send(res, 200, { talk });
            }
            if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
                const body = await readBody(req);
                const session = applyHeartbeat(sessions, body, Date.now());
                if (!session) return send(res, 400, { error: 'bad tab' });
                const archived = rememberTalk(talks, body, Date.now());
                saveSessions(sessions);
                if (archived) saveTalks(talks);
                if (url.searchParams.get('wait') === '1') await pause(POLL_MS, req);
                if (clientGone(req, res)) return;
                const outbox = pendingOutbox(session);
                const patch = takeControlPatch(session);
                const avatarPatch = takeAvatarPatch(session);
                const userPatch = takeUserPatch(session);
                if (outbox.dirty || patch.dirty || avatarPatch.dirty || userPatch.dirty) saveSessions(sessions);
                return send(res, 200, { ok: true, outbox: outbox.pending, controls: patch.controls, avatarOn: avatarPatch.avatarOn, userOn: userPatch.userOn });
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
                // 檔案已在就用同一份，不再寫一次。
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
            const avatarPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/avatar$/);
            if (req.method === 'POST' && avatarPost) {
                const session = sessions.get(avatarPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                session.avatarWanted = !!body.on;
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            const userPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/user$/);
            if (req.method === 'POST' && userPost) {
                const session = sessions.get(userPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                session.userWanted = !!body.on;
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/controls') {
                const patch = cleanControls(await readBody(req));
                if (!patch) return send(res, 400, { error: 'bad controls' });
                if (!sessions.size) return send(res, 409, { error: 'no tab' });
                for (const session of sessions.values()) session.controlWanted = patch;
                saveSessions(sessions);
                return send(res, 200, { ok: true });
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
