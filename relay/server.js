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
const DROP_FILE = path.join(path.dirname(DATA), 'dropped.json');
const FILTER_FILE = path.join(path.dirname(DATA), 'filters.json');
const FILTER_KEEP = 2000;
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

function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

function taipeiNow() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

// 沒有年份的月日補上今年。昨天、前天寫成那天的日期，之後就不再跟著今天移動。
function withYear(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    let rest = raw;
    let dayShift = 0;
    if (rest.indexOf('前天') === 0) { dayShift = -2; rest = rest.slice(2).trim(); }
    else if (rest.indexOf('昨天') === 0) { dayShift = -1; rest = rest.slice(2).trim(); }
    const space = rest.lastIndexOf(' ');
    const datePart = space > 0 ? rest.slice(0, space) : '';
    const clockPart = space > 0 ? rest.slice(space + 1) : rest;
    const colon = clockPart.indexOf(':');
    if (colon < 1) {
        const only = (datePart || raw).split('/').filter(s => s !== '');
        if (only.length >= 2 && only.length <= 3 && !clockPart.includes(':')) {
            const y = only.length >= 3 ? parseInt(only[0], 10) : taipeiNow().getUTCFullYear();
            const month = parseInt(only[only.length - 2], 10);
            const day = parseInt(only[only.length - 1], 10);
            if (y === y && y > 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return y + '/' + pad2(month) + '/' + pad2(day);
            }
        }
        return raw.slice(0, 32);
    }
    const hh = parseInt(clockPart.slice(0, colon), 10);
    const mm = parseInt(clockPart.slice(colon + 1), 10);
    if (hh !== hh || mm !== mm || hh > 23 || mm > 59) return raw.slice(0, 32);
    const bits = datePart.split('/').filter(s => s !== '');
    const today = taipeiNow();
    let y = today.getUTCFullYear();
    let month = 0;
    let day = 0;
    let known = false;
    if (bits.length >= 3) {
        y = parseInt(bits[0], 10);
        month = parseInt(bits[1], 10);
        day = parseInt(bits[2], 10);
        known = y === y && month === month && day === day;
    } else if (bits.length === 2) {
        month = parseInt(bits[0], 10);
        day = parseInt(bits[1], 10);
        known = month === month && day === day;
    } else if (dayShift) {
        const base = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()) + dayShift * 86400000);
        y = base.getUTCFullYear();
        month = base.getUTCMonth() + 1;
        day = base.getUTCDate();
        known = true;
    }
    if (!known || month < 1 || month > 12 || day < 1 || day > 31) return raw.slice(0, 32);
    return y + '/' + pad2(month) + '/' + pad2(day) + ' ' + pad2(hh) + ':' + pad2(mm);
}

function archiveMessage(m) {
    const id = String(m && m.id || '').slice(0, 80);
    const text = String(m && m.text || '').slice(0, 500);
    const quote = String(m && m.quote || '').slice(0, 200);
    const image = /^[a-z0-9]{8,40}$/.test(m && m.image) ? m.image : '';
    const time = withYear(m && m.time);
    if (!id || !(text || quote || image)) return null;
    return { id, text, quote, image, mine: !!(m && m.mine), time };
}

// ponytail: 一人最多 800 則、最多 300 人，超過留最新的。要完整更久再改檔案。
function rememberTalk(talks, body, now) {
    const archive = body && body.archive;
    if (!archive || typeof archive !== 'object') return false;
    const uid = cleanUid(archive.uid);
    if (!uid) return false;
    const incoming = (Array.isArray(archive.messages) ? archive.messages : []).map(archiveMessage).filter(Boolean).filter(m => !dropped.has(uid + ':' + m.id)).slice(0, 40);
    const prev = talks.get(uid);
    if (!incoming.length && (!prev || prev.title === String(archive.title || '').trim().slice(0, 40))) return false;
    const map = new Map();
    for (const m of (prev && prev.messages) || []) if (m && m.id) map.set(m.id, m);
    let changed = !prev || prev.title !== String(archive.title || '').trim().slice(0, 40);
    for (const m of incoming) {
        const old = map.get(m.id);
        if (old && m.text === '已收回一則訊息' && !m.image) {
            if (old.image) {
                m.text = old.text || '';
                m.image = old.image;
            } else if (old.text && old.text !== '已收回一則訊息') {
                m.text = withRecall(old.text);
            }
        }
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
    const lastAt = talkLastAt(messages) || (prev && prev.lastAt) || 0;
    talks.set(uid, { uid, title, messages, updated: now, lastAt });
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

function messageTimeMs(text) {
    const stamped = withYear(text);
    const space = stamped.lastIndexOf(' ');
    if (space < 1) return 0;
    const bits = stamped.slice(0, space).split('/');
    const clock = stamped.slice(space + 1);
    const colon = clock.indexOf(':');
    if (bits.length < 3 || colon < 1) return 0;
    const y = parseInt(bits[0], 10);
    const month = parseInt(bits[1], 10);
    const day = parseInt(bits[2], 10);
    const hh = parseInt(clock.slice(0, colon), 10);
    const mm = parseInt(clock.slice(colon + 1), 10);
    if (y !== y || month !== month || day !== day) return 0;
    return Date.UTC(y, month - 1, day, hh, mm) - 8 * 60 * 60 * 1000;
}

function talkLastAt(messages) {
    let dated = 0;
    let any = 0;
    for (const m of messages || []) {
        const raw = String(m && m.time || '');
        const at = messageTimeMs(raw);
        if (!at) continue;
        if (at > any) any = at;
        if ((raw.indexOf('/') > 0 || raw.indexOf('昨天') === 0 || raw.indexOf('前天') === 0) && at > dated) dated = at;
    }
    return dated || any;
}

function visibleTalks(talks) {
    return [...talks.values()]
        .map(t => ({ uid: t.uid, title: t.title, updated: t.updated, lastAt: talkLastAt(t.messages) || t.lastAt || t.updated || 0, count: t.messages.length }))
        .sort((a, b) => b.lastAt - a.lastAt || b.updated - a.updated || (a.uid < b.uid ? -1 : 1));
}

function loadTalks() {
    talksNeedYear = false;
    try {
        const raw = JSON.parse(fs.readFileSync(TALK_FILE, 'utf8'));
        const map = new Map();
        for (const t of raw || []) {
            const uid = cleanUid(t && t.uid);
            if (!uid) continue;
            const src = Array.isArray(t.messages) ? t.messages : [];
            if (src.some(m => m && withYear(m.time) !== String(m.time || '').trim())) talksNeedYear = true;
            const messages = src.map(archiveMessage).filter(Boolean).slice(-TALK_KEEP);
            if (!messages.length) continue;
            const updated = Number(t.updated) || 0;
            map.set(uid, {
                uid,
                title: String(t.title || '未命名').slice(0, 40) || '未命名',
                messages,
                updated,
                lastAt: talkLastAt(messages) || Number(t.lastAt) || updated
            });
        }
        return map;
    } catch (e) {
        return new Map();
    }
}

const dropped = new Set();
let talksNeedYear = false;

function loadDropped() {
    try {
        const raw = JSON.parse(fs.readFileSync(DROP_FILE, 'utf8'));
        if (!Array.isArray(raw)) return;
        dropped.clear();
        raw.slice(-20000).forEach(id => { if (id) dropped.add(String(id)); });
    } catch (e) {}
}

function saveDropped() {
    fs.writeFileSync(DROP_FILE, JSON.stringify([...dropped].slice(-20000)));
}

function dropTalk(talks, uid) {
    const prev = talks.get(uid);
    if (!prev) return false;
    for (const m of prev.messages || []) if (m && m.id) dropped.add(uid + ':' + m.id);
    talks.delete(uid);
    touch();
    return true;
}

function saveTalks(talks) {
    fs.writeFileSync(TALK_FILE, JSON.stringify([...talks.values()]));
}

// ponytail: 使用者與大頭貼各最多 2000 筆，超過不再加。要再多就改分檔。
const filters = { users: [], avatars: [] };

function cleanUserFilter(item) {
    if (item == null) return null;
    if (typeof item !== 'object') {
        const t = String(item).trim().slice(0, 200);
        return t ? { u: '', t, a: '' } : null;
    }
    const u = String(item.u || item.uid || '').trim().slice(0, 128);
    const t = String(item.t || item.text || '').trim().slice(0, 200);
    const a = String(item.a || item.avatarHash || '').trim().slice(0, 80);
    if (!u && !t) return null;
    return { u, t, a };
}

function cleanAvatarFilter(item) {
    return String(item && typeof item === 'object' ? (item.url || item.u || '') : (item || '')).trim().slice(0, 800);
}

function applyFilterPatch(box, patch) {
    if (!patch || typeof patch !== 'object') return false;
    let changed = false;
    if (patch.clearUsers && box.users.length) { box.users = []; changed = true; }
    if (patch.clearAvatars && box.avatars.length) { box.avatars = []; changed = true; }
    for (const raw of Array.isArray(patch.addUsers) ? patch.addUsers : []) {
        const f = cleanUserFilter(raw);
        if (!f) continue;
        if (f.u && box.users.some(x => x.u === f.u)) continue;
        const legacy = f.u ? box.users.find(x => !x.u && f.t && x.t === f.t && x.a === f.a) : null;
        if (legacy) { legacy.u = f.u; changed = true; continue; }
        if (!f.u && box.users.some(x => !x.u && x.t === f.t && x.a === f.a)) continue;
        if (box.users.length >= FILTER_KEEP) continue;
        box.users.push(f);
        changed = true;
    }
    for (const raw of Array.isArray(patch.removeUsers) ? patch.removeUsers : []) {
        const f = cleanUserFilter(raw);
        if (!f) continue;
        const forget = !!(raw && raw.forget);
        const next = box.users.filter(x => {
            if (f.u && x.u === f.u) return false;
            if (f.t && !x.u && x.t === f.t && x.a === f.a && (!f.u || forget)) return false;
            return true;
        });
        if (next.length !== box.users.length) { box.users = next; changed = true; }
    }
    for (const raw of Array.isArray(patch.addAvatars) ? patch.addAvatars : []) {
        const u = cleanAvatarFilter(raw);
        if (!u || box.avatars.includes(u)) continue;
        if (box.avatars.length >= FILTER_KEEP) continue;
        box.avatars.push(u);
        changed = true;
    }
    for (const raw of Array.isArray(patch.removeAvatars) ? patch.removeAvatars : []) {
        const u = cleanAvatarFilter(raw);
        if (!u) continue;
        const next = box.avatars.filter(x => x !== u);
        if (next.length !== box.avatars.length) { box.avatars = next; changed = true; }
    }
    return changed;
}

function loadFilters() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILTER_FILE, 'utf8'));
        applyFilterPatch(filters, { addUsers: raw.users, addAvatars: raw.avatars });
    } catch (e) {}
}

function saveFilters() {
    fs.writeFileSync(FILTER_FILE, JSON.stringify(filters));
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

function withRecall(text) {
    const t = String(text || '');
    if (!t || t === '已收回一則訊息') return t;
    return t.endsWith('（已收回）') ? t : (t + '（已收回）').slice(0, 500);
}

function keepRecalled(incoming, prev) {
    const oldById = new Map();
    for (const m of prev || []) if (m && m.id) oldById.set(m.id, m);
    return (incoming || []).map(m => {
        if (!m || m.image || m.text !== '已收回一則訊息') return m;
        const old = oldById.get(m.id);
        if (!old) return m;
        if (old.image) return { ...m, text: old.text || '', quote: m.quote || old.quote || '', image: old.image };
        if (!old.text || old.text === '已收回一則訊息') return m;
        return { ...m, text: withRecall(old.text) };
    });
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
        messages: keepRecalled(cleanMessages(body.messages), prev && prev.messages),
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
    touch();
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
    touch();
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
    const quiet = applyHeartbeat(sessions, { tabId: 'quiettab1', title: '空', canType: true, messages: [] }, 1000);
    if (!live || sessions.get('abc12345').outbox.length !== 1 || vis.length !== 2
        || !fresh || fresh.waiting || fresh.title !== '阿明' || !old || !old.waiting
        || heartbeatReady(quiet) || !heartbeatReady(sessions.get('abc12345'))) {
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
        || visibleTalks(talks)[0].count !== 2
        || !dropTalk(talks, 'user_one')
        || talks.has('user_one')
        || rememberTalk(talks, { archive: { uid: 'user_one', title: '阿明', messages: [{ id: 'a', text: '嗨', mine: false }] } }, 5)
        || talks.has('user_one')
        || dropTalk(talks, 'user_one')) {
        throw new Error('knock relay 檢查失敗');
    }
    const box = { users: [], avatars: [] };
    const legacy = applyFilterPatch(box, { addUsers: [{ t: '舊', a: 'h2' }] });
    const upgraded = applyFilterPatch(box, { addUsers: [{ u: 'user_two', t: '舊', a: 'h2' }] });
    if (!applyFilterPatch(box, { addUsers: [{ u: 'user_one', t: '嗨', a: 'h1' }] })
        || applyFilterPatch(box, { addUsers: [{ u: 'user_one', t: '嗨', a: 'h1' }] })
        || !legacy || !upgraded || box.users.find(x => x.t === '舊').u !== 'user_two'
        || !applyFilterPatch(box, { addAvatars: [' https://a/b.png '] })
        || applyFilterPatch(box, { addAvatars: ['https://a/b.png'] })
        || box.avatars.length !== 1
        || !applyFilterPatch(box, { removeUsers: [{ u: 'user_one', t: '嗨', a: 'h1', forget: true }] })
        || box.users.some(x => x.u === 'user_one')
        || !applyFilterPatch(box, { clearAvatars: true })
        || box.avatars.length) {
        throw new Error('knock relay 檢查失敗');
    }
    const recalled = applyHeartbeat(sessions, {
        tabId: 'recalltab1', title: '收回', canType: true,
        messages: [{ id: 'm9', text: '原本的話', mine: false }, { id: 'picmsg01', text: '', image: 'abcd1234', mine: false }]
    }, 15000);
    const second = applyHeartbeat(sessions, {
        tabId: 'recalltab1', title: '收回', canType: true,
        messages: [{ id: 'm9', text: '已收回一則訊息', mine: false }, { id: 'picmsg01', text: '已收回一則訊息', mine: false }]
    }, 15001);
    const recalledAgain = applyHeartbeat(sessions, {
        tabId: 'recalltab1', title: '收回', canType: true,
        messages: [{ id: 'm9', text: '已收回一則訊息', mine: false }]
    }, 15002);
    const words = second.messages.find(m => m.id === 'm9');
    const pic = second.messages.find(m => m.id === 'picmsg01');
    const recallTalks = new Map();
    if (!recalled || !words || words.text !== '原本的話（已收回）' || recalledAgain.messages.find(m => m.id === 'm9').text !== '原本的話（已收回）'
        || !pic || pic.image !== 'abcd1234' || pic.text
        || !rememberTalk(recallTalks, { archive: { uid: 'user_two', title: '阿明', messages: [{ id: 'c', text: '晚安', mine: true, time: '01:01' }] } }, 9)
        || !rememberTalk(recallTalks, { archive: { uid: 'user_two', title: '阿明', messages: [{ id: 'c', text: '已收回一則訊息', mine: true }] } }, 10)
        || recallTalks.get('user_two').messages[0].text !== '晚安（已收回）') {
        throw new Error('knock relay 檢查失敗');
    }
    const ordered = new Map();
    rememberTalk(ordered, { archive: { uid: 'user_two', title: '舊', messages: [{ id: 'oldmsg1', text: '早', time: '1/2 08:00' }] } }, 1);
    rememberTalk(ordered, { archive: { uid: 'user_new1', title: '新', messages: [{ id: 'newmsg1', text: '晚', time: '1/3 09:00' }] } }, 2);
    const order = visibleTalks(ordered);
    if (order[0].uid !== 'user_new1' || order[1].uid !== 'user_two' || !(order[0].lastAt > order[1].lastAt)) {
        throw new Error('knock relay 檢查失敗');
    }
    const wall = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const stamp = (wall.getUTCMonth() + 1) + '/' + wall.getUTCDate() + ' ' + wall.getUTCHours() + ':' + pad(wall.getUTCMinutes());
    if (Math.abs(messageTimeMs(stamp) - Date.now()) > 120000) throw new Error('knock relay 檢查失敗');
    if (Math.abs(messageTimeMs('昨天 ' + wall.getUTCHours() + ':' + pad(wall.getUTCMinutes())) - (Date.now() - 86400000)) > 120000) {
        throw new Error('knock relay 檢查失敗');
    }
    const datedOnly = new Map();
    rememberTalk(datedOnly, { archive: { uid: 'user_old9', title: '舊', messages: [{ id: 'd1', text: '一', time: '1/2 08:00' }, { id: 'd2', text: '二', time: '23:59' }] } }, 3);
    if (visibleTalks(datedOnly)[0].lastAt !== messageTimeMs('1/2 08:00')) throw new Error('knock relay 檢查失敗');
    const thisYear = String(taipeiNow().getUTCFullYear());
    if (withYear('10/6 11:51') !== thisYear + '/10/06 11:51'
        || withYear(thisYear + '/10/06 11:51') !== thisYear + '/10/06 11:51'
        || withYear('2024/3/4 5:06') !== '2024/03/04 05:06'
        || withYear('9/25') !== thisYear + '/09/25'
        || withYear('2024/9/25') !== '2024/09/25'
        || messageTimeMs('2024/03/04 05:06') !== Date.UTC(2024, 2, 4, 5, 6) - 8 * 60 * 60 * 1000) {
        throw new Error('knock relay 檢查失敗');
    }
    dropped.delete('user_one:a');
    dropped.delete('user_one:b');
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

let revision = 0;
let filterRev = 0;
const wakes = new Set();

function touchFilters() {
    filterRev += 1;
    touch();
}

function touch() {
    revision += 1;
    for (const wake of wakes) wake();
}

function waitUntil(ms, req, ready) {
    if (ready()) return Promise.resolve();
    return new Promise(resolve => {
        let done = false;
        const socket = req.socket;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            wakes.delete(check);
            if (socket) socket.removeListener('close', finish);
            resolve();
        };
        const check = () => { if (ready()) finish(); };
        const timer = setTimeout(finish, ms);
        wakes.add(check);
        if (socket) socket.on('close', finish);
        if (ready()) finish();
    });
}

function heartbeatReady(session) {
    if ((session.outbox || []).some(item => item && !(item.image && item.handed))) return true;
    if (session.controlWanted && !sameControls(session.controls, session.controlWanted)) return true;
    const avatarOn = !!(session.openings && session.openings.avatarOn);
    if (typeof session.avatarWanted === 'boolean' && session.avatarWanted !== avatarOn) return true;
    const userOn = !!(session.openings && session.openings.userOn);
    if (typeof session.userWanted === 'boolean' && session.userWanted !== userOn) return true;
    return false;
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
  html, body { height:100%; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#111; color:#eee; overflow:hidden; }
  .shell { display:flex; height:100%; }
  #rail { width:220px; flex:none; overflow:auto; border-right:1px solid #333; background:#111; }
  #rail .fold { display:flex; align-items:center; gap:6px; width:100%; margin:0; padding:10px 12px; border:none; background:transparent; color:#888; font-size:12px; font-weight:600; cursor:pointer; text-align:left; }
  #rail .card { width:calc(100% - 16px); box-sizing:border-box; margin:0 8px 4px; padding:4px 8px; }
  #rail .muted { margin:0 12px 8px; font-size:13px; }
  #rail .card.on { background:#1e3326; border-color:#2d5a3d; }
  #rail .talk { margin:0 8px 4px; }
  #rail .talk .card { position:relative; width:100%; margin:0; box-sizing:border-box; }
  #rail .talk .who { min-height:22px; padding-right:26px; }
  #rail .talk .who span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #rail .bin { position:absolute; top:4px; right:8px; z-index:2; width:22px; height:22px; padding:0; border:none; background:transparent; color:#e53935; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .stage { flex:1; min-width:0; height:100%; display:flex; flex-direction:column; position:relative; }
  #shade { display:none; position:fixed; inset:0; z-index:19; border:none; padding:0; background:rgba(0,0,0,.5); }
  .topbar .menu { width:48px; height:48px; padding:0; display:flex; align-items:center; justify-content:center; }
  .topbar .rail-btn { display:none; }
  @media (max-width:760px) {
    #rail { position:fixed; z-index:20; top:0; bottom:0; left:0; width:min(280px, 86vw); transform:translateX(-110%); transition:transform .18s ease; }
    body.rail-open #rail { transform:none; }
    body.rail-open #shade { display:block; }
    .topbar .rail-btn { display:flex; }
  }
  body.locked { overflow:auto; }
  body.locked .shell, body.locked #shade { display:none; }
  .topbar { position:relative; flex:none; z-index:6; display:flex; justify-content:space-between; height:48px; background:#111; border-bottom:1px solid #333; }
  .topbar .card { margin:0; border-radius:0; flex:1; border-left:none; border-right:none; }
  .topbar .gear { position:relative; z-index:1; flex:none; width:auto; height:48px; padding:0 12px; border-radius:0; border:1px solid #333; background:#1c1c1c; cursor:pointer; }
  .topbar .gear.menu { width:48px; padding:0; }
  .topbar .end { margin-left:auto; }
  .topbar .who { position:absolute; left:0; right:0; top:0; height:48px; display:flex; align-items:center; justify-content:center; padding:0 72px; pointer-events:none; overflow:hidden; }
  .topbar .who span { min-width:0; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .topbar .del { background:#e53935; border-color:#e53935; color:#fff; }
  main { flex:1; min-height:0; overflow:auto; padding:12px; }
  button, input { font:inherit; color:#eee; }
  .card, .msg { background:#1c1c1c; border:1px solid #333; border-radius:10px; }
  .card { display:block; width:100%; text-align:left; padding:12px; margin:0 0 8px; cursor:pointer; }
  #rail .card { position:relative; width:calc(100% - 16px); box-sizing:border-box; margin:0 8px 4px; padding:4px 8px; }
  #rail .card small { margin-top:2px; }
  #rail .fold { position:relative; }
  .rail-btn { position:relative; }
  .dot { position:absolute; width:8px; height:8px; border-radius:50%; background:#e53935; }
  .rail-btn .dot { top:8px; right:8px; }
  #rail .card .dot { top:6px; right:8px; }
  #rail .fold .dot { top:50%; right:12px; margin-top:-4px; }
  .card small { display:block; color:#aaa; margin-top:4px; }
  .card small.preview { display:flex; gap:8px; align-items:baseline; color:#ffb74d; }
  .card small.preview .preview-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .card small.preview .preview-time { flex:none; color:#888; white-space:nowrap; }
  .card small.preview.mine { color:#9ccc65; }
  .new-msg { position:absolute; left:50%; bottom:72px; transform:translateX(-50%); z-index:7; padding:6px 14px; border:none; border-radius:16px; background:#ffb74d; color:#111; font-size:13px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35); }
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
  form { position:relative; flex:none; display:flex; gap:8px; padding:10px; background:#111; border-top:1px solid #333; }
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
<div class="shell">
<aside id="rail"></aside>
<div class="stage" id="stage">
<main id="app"></main>
</div>
</div>
<button type="button" id="shade" aria-label="關閉列表"></button>
<script>
const TOKEN_KEY = 'knockRelayPageToken';
const app = document.getElementById('app');
const rail = document.getElementById('rail');
const stage = document.getElementById('stage');
let token = localStorage.getItem(TOKEN_KEY) || '';
let current = '';
let archiveUid = '';
let archiveTalk = null;
let archiveUpdated = 0;
let archiveLoading = '';
let sessions = [];
let talks = [];
const droppedTalks = new Set();
let sending = false;
let lastSentText = '';
let lastSentAt = 0;
const composeDrafts = {};
let formTab = '';
const relayFile = document.createElement('input');
relayFile.type = 'file';
relayFile.accept = 'image/png,image/jpeg,image/gif,image/heic,image/heif';
relayFile.hidden = true;
relayFile.onchange = () => {
  const chosen = relayFile.files && relayFile.files[0];
  relayFile.value = '';
  const room = sessions.find(x => x.tabId === current);
  if (chosen && room) sendImage(room, chosen);
};
document.body.append(relayFile);
const picUrls = {};
let stickBottom = false;
let showControls = false;
let controlDraft = null;
let avatarDraft = null;
let userDraft = null;
let keepOpen = false;
let phoneOpen = false;
const railFold = { live: false, quiet: true, talks: true };
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
  document.body.classList.add('locked');
  document.body.classList.remove('rail-open');
  clearChrome();
  clearForm();
  app.replaceChildren();
  rail.replaceChildren();
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
  document.body.append(box);
}

function statusText(s) {
  if (s.status === 'left') return '對方已離開';
  if (s.waiting) return '等待連線';
  if (!s.canType) return '現在不能回';
  if (s.pending) return '有 ' + s.pending + ' 則待送出';
  return '';
}

function deleteTalk(uid) {
  const viewing = archiveUid === uid;
  const at = talks.findIndex(t => t.uid === uid);
  const older = viewing && at >= 0 ? talks[at + 1] : null;
  droppedTalks.add(uid);
  talks = talks.filter(t => t.uid !== uid);
  if (older) {
    archiveUid = older.uid;
    archiveTalk = null;
    archiveUpdated = 0;
    railFold.talks = false;
    stickBottom = true;
    paint();
    loadArchive(older.uid);
  } else if (viewing) {
    archiveUid = '';
    archiveTalk = null;
    paint();
  } else {
    paint();
  }
  api('/api/talks/' + encodeURIComponent(uid), { method: 'DELETE' }).catch(() => {
    droppedTalks.delete(uid);
    alert('刪除失敗');
  });
}

function talkClock(ms) {
  const d = new Date(ms);
  if (!ms || isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
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

function barsIcon() {
  const bars = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  bars.setAttribute('viewBox', '0 0 24 24');
  bars.setAttribute('width', '22');
  bars.setAttribute('height', '22');
  bars.setAttribute('aria-hidden', 'true');
  const barPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  barPath.setAttribute('fill', 'currentColor');
  barPath.setAttribute('d', 'M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z');
  bars.append(barPath);
  return bars;
}

function closeRail() { document.body.classList.remove('rail-open'); }

const roomUnread = {};
const roomTail = {};
let roomTailReady = false;

function redDot() {
  const dot = document.createElement('span');
  dot.className = 'dot';
  return dot;
}

function unreadLeft() {
  for (const id in roomUnread) if (roomUnread[id]) return true;
  return false;
}

function noteRooms(list) {
  const alive = {};
  for (const s of list) {
    alive[s.tabId] = true;
    const tail = tailId(s);
    if (!roomTailReady || roomTail[s.tabId] === undefined) {
      const fresh = roomTailReady && tail && s.tabId !== current;
      roomTail[s.tabId] = tail;
      if (fresh) roomUnread[s.tabId] = true;
      continue;
    }
    if (tail === roomTail[s.tabId]) continue;
    roomTail[s.tabId] = tail;
    if (s.tabId === current || !tail) delete roomUnread[s.tabId];
    else roomUnread[s.tabId] = true;
  }
  roomTailReady = true;
  for (const id in roomUnread) if (!alive[id]) delete roomUnread[id];
}

function paintBar(title, end) {
  clearChrome();
  const bar = document.createElement('div');
  bar.className = 'topbar';
  const railBtn = document.createElement('button');
  railBtn.type = 'button';
  railBtn.className = 'gear menu rail-btn';
  railBtn.setAttribute('aria-label', '列表');
  railBtn.append(barsIcon());
  if (unreadLeft()) railBtn.append(redDot());
  railBtn.onclick = () => document.body.classList.toggle('rail-open');
  const who = document.createElement('span');
  who.className = 'who';
  const whoText = document.createElement('span');
  whoText.textContent = title || 'Knock 遠端';
  who.append(whoText);
  bar.append(railBtn, who);
  if (end) bar.append(end);
  stage.insertBefore(bar, app);
}

function controlsGear() {
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'gear menu end';
  gear.setAttribute('aria-label', '控制');
  gear.append(barsIcon());
  gear.onclick = () => { showControls = !showControls; paint(); };
  return gear;
}

function byRecent(a, b) {
  return lastMessageAt(b) - lastMessageAt(a) || (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0);
}

function trashIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z');
  svg.append(path);
  return svg;
}

function railSection(key, title, fill, alert) {
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'fold';
  const mark = document.createElement('span');
  mark.textContent = railFold[key] ? '▸' : '▾';
  const label = document.createElement('span');
  label.textContent = title;
  head.append(mark, label);
  if (alert && railFold[key]) head.append(redDot());
  head.onclick = () => { railFold[key] = !railFold[key]; paint(); };
  rail.append(head);
  if (!railFold[key]) fill();
}

function railEmpty(text) {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}

function liveCard(s) {
  const btn = document.createElement('button');
  btn.className = 'card' + (s.tabId === current ? ' on' : '');
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
  if (roomUnread[s.tabId]) {
    name.style.paddingRight = '14px';
    btn.append(redDot());
  }
  const extra = s.waiting ? '' : statusText(s);
  if (extra) {
    const st = document.createElement('small');
    st.textContent = extra;
    btn.append(st);
  }
  btn.onclick = () => {
    showControls = false;
    archiveUid = '';
    archiveTalk = null;
    current = s.tabId;
    delete roomUnread[s.tabId];
    stickBottom = true;
    closeRail();
    paint();
  };
  return btn;
}

function talkCard(t) {
  const row = document.createElement('div');
  row.className = 'talk';
  const btn = document.createElement('button');
  btn.className = 'card' + (t.uid === archiveUid ? ' on' : '');
  btn.type = 'button';
  const name = document.createElement('div');
  name.className = 'who';
  const title = document.createElement('span');
  title.textContent = t.title || '未命名';
  name.append(title);
  const sub = document.createElement('small');
  sub.className = 'preview';
  const label = document.createElement('span');
  label.className = 'preview-text';
  label.textContent = (t.count || 0) + ' 則';
  sub.append(label);
  const when = document.createElement('span');
  when.className = 'preview-time';
  when.textContent = talkClock(t.lastAt || t.updated);
  sub.append(when);
  btn.append(name, sub);
  btn.onclick = () => {
    showControls = false;
    archiveUid = t.uid;
    archiveTalk = null;
    archiveUpdated = 0;
    current = '';
    stickBottom = true;
    closeRail();
    paint();
    loadArchive(t.uid);
  };
  const bin = document.createElement('span');
  bin.className = 'bin';
  bin.setAttribute('role', 'button');
  bin.tabIndex = 0;
  bin.setAttribute('aria-label', '刪除');
  bin.append(trashIcon());
  bin.onclick = (e) => { e.preventDefault(); e.stopPropagation(); deleteTalk(t.uid); };
  bin.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    deleteTalk(t.uid);
  };
  btn.append(bin);
  row.append(btn);
  return row;
}

function paintRail() {
  const top = rail.scrollTop;
  rail.replaceChildren();
  const live = sessions.filter(s => !s.waiting).sort(byRecent);
  const quiet = sessions.filter(s => s.waiting).sort(byRecent);
  railSection('live', '連線中', () => {
    if (!live.length) rail.append(railEmpty('沒有正在回報的對話'));
    else live.forEach(s => rail.append(liveCard(s)));
  }, live.some(s => roomUnread[s.tabId]));
  railSection('quiet', '離線', () => {
    if (!quiet.length) rail.append(railEmpty('沒有離線的對話'));
    else quiet.forEach(s => rail.append(liveCard(s)));
  }, quiet.some(s => roomUnread[s.tabId]));
  railSection('talks', '紀錄', () => {
    if (!talks.length) rail.append(railEmpty('還沒有對話記錄'));
    else talks.forEach(t => rail.append(talkCard(t)));
  });
  rail.scrollTop = top;
}

function paintArchive(talk, follow, y) {
  clearForm();
  const uid = archiveUid;
  const del = document.createElement('button');
  del.className = 'gear del end';
  del.type = 'button';
  del.textContent = '刪除';
  del.onclick = () => { if (uid) deleteTalk(uid); };
  paintBar((talk && talk.title) || '對話記錄', del);
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
  const bits = datePart.split('/').filter(function (s) { return s !== ''; });
  const now = new Date();
  let year = now.getFullYear();
  let month = 0;
  let day = 0;
  let dated = false;
  if (bits.length >= 3) {
    year = parseInt(bits[0], 10);
    month = parseInt(bits[1], 10);
    day = parseInt(bits[2], 10);
    dated = year === year && month === month && day === day;
  } else if (bits.length === 2) {
    month = parseInt(bits[0], 10);
    day = parseInt(bits[1], 10);
    dated = month === month && day === day;
  }
  if (!dated) { month = now.getMonth() + 1; day = now.getDate(); }
  let at = new Date(year, month - 1, day, hh, mm).getTime();
  if (!dated && at > Date.now() + 60000) at -= 86400000;
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
  return app.scrollHeight - app.scrollTop - app.clientHeight < 80;
}

function scrollBottom() {
  app.scrollTop = app.scrollHeight;
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
  app.scrollTop = y || 0;
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
  stage.append(chip);
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
  const s = sessions.find(x => x.tabId === current);
  if (controlDraft && controlDraft.tabId === current) return controlDraft.controls;
  return s && s.controls;
}

function postControls(next) {
  if (!current) return;
  const packed = packControls(next);
  if (!topicOk(packed.phoneTopic)) { alert('主題只接受英文、數字、底線和減號'); return; }
  const tabId = current;
  controlDraft = { tabId: tabId, controls: packed };
  paint();
  api('/api/sessions/' + encodeURIComponent(tabId) + '/controls', {
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
  app.replaceChildren();
  clearForm();
  const src = shownControls();
  if (!src) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '這個聊天室還沒回報設定。先讓那一頁開著。';
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
  paintBar((s && s.title) || '未命名', controlsGear());
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
  if (!token) { clearForm(); return gate(); }
  document.body.classList.remove('locked');
  document.querySelectorAll('.gate').forEach(el => el.remove());
  paintRail();
  if (showControls) {
    const editing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest && document.activeElement.closest('#app');
    if (!editing) {
      const s = sessions.find(x => x.tabId === current);
      paintBar((s && s.title) || '控制', controlsGear());
      paintControls();
    }
    return;
  }
  if (archiveUid) {
    const y = app.scrollTop;
    const follow = stickBottom || nearBottom();
    paintArchive(archiveTalk, follow, y);
    return;
  }
  const y = app.scrollTop;
  const follow = stickBottom || (!!current && nearBottom());
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('form');
  if (focused && current) {
    const s = sessions.find(x => x.tabId === current);
    paintThread(s, follow, y);
    const input = document.querySelector('form input');
    if (input) input.disabled = !canSend(s);
    document.querySelectorAll('form button').forEach(btn => { btn.disabled = sending || !canSend(s); });
    return;
  }
  const keepInput = document.querySelector('form input:not([type=file])');
  if (keepInput && formTab) composeDrafts[formTab] = keepInput.value;
  const draft = composeDrafts[current] || '';
  if (!current) {
    paintBar('Knock 遠端');
    app.replaceChildren();
    clearForm();
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '選一個對話';
    app.append(p);
    return;
  }
  clearForm();
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
      composeDrafts[s.tabId] = '';
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
      composeDrafts[s.tabId] = '';
      lastSentText = text;
      lastSentAt = Date.now();
    }).catch(err => { alert(err.message); }).finally(() => {
      sending = false;
      document.querySelectorAll('form button').forEach(btn => { btn.disabled = !canSend(s); });
    });
  };
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'pick';
  pick.textContent = '圖片';
  pick.disabled = sending || !canSend(s);
  pick.onclick = () => relayFile.click();
  form.append(pick);
  stage.append(form);
  formTab = s.tabId;
  if (keepInput && document.activeElement === keepInput) input.focus();
  if (follow) scrollBottom();
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
  const type = file.type || '';
  if (type === 'image/gif') {
    if (file.size > 1200000) return Promise.reject(new Error('GIF 太大'));
    return Promise.resolve(file);
  }
  const plain = type === 'image/jpeg' || type === 'image/jpg' || type === 'image/png';
  if (plain && file.size <= 400000) return Promise.resolve(file);
  if (type && type.indexOf('image/') !== 0) return Promise.reject(new Error('只收圖片'));
  return createImageBitmap(file).then(bitmap => new Promise((resolve, reject) => {
    const scale = Math.min(1, 960 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    canvas.toBlob(blob => {
      if (!blob) reject(new Error('圖片無法讀取'));
      else resolve(new File([blob], 'relay.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.8);
  })).catch(() => Promise.reject(new Error('圖片無法讀取')));
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
    noteRooms(sessions);
    const freshTalks = data.talks || [];
    for (const uid of [...droppedTalks]) {
      if (!freshTalks.some(t => t.uid === uid)) droppedTalks.delete(uid);
    }
    talks = freshTalks.filter(t => !droppedTalks.has(t.uid));
    if (archiveUid) {
      const sum = talks.find(t => t.uid === archiveUid);
      if (!archiveTalk || (sum && sum.updated !== archiveUpdated)) loadArchive(archiveUid);
    }
    if (controlDraft) {
      const hit = sessions.find(s => s.tabId === controlDraft.tabId);
      if (hit && hit.controls && JSON.stringify(packControls(hit.controls)) === JSON.stringify(controlDraft.controls)) controlDraft = null;
    }
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
document.getElementById('shade').onclick = () => closeRail();
let edgeSwipe = null;
document.addEventListener('pointerdown', (e) => {
  if (e.button || document.body.classList.contains('rail-open') || e.clientX > 28) return;
  edgeSwipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
document.addEventListener('pointerup', (e) => {
  if (!edgeSwipe || e.pointerId !== edgeSwipe.id) return;
  const dx = e.clientX - edgeSwipe.x;
  const dy = e.clientY - edgeSwipe.y;
  edgeSwipe = null;
  if (dx >= 48 && dx > Math.abs(dy)) document.body.classList.add('rail-open');
});
document.addEventListener('pointercancel', () => { edgeSwipe = null; });
loop();
</script>
</body>
</html>`;

function main() {
    loadDropped();
    loadFilters();
    const sessions = loadSessions();
    const talks = loadTalks();
    if (talksNeedYear) saveTalks(talks);
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
                if (url.searchParams.get('wait') === '1') {
                    const seen = revision;
                    await waitUntil(POLL_MS, req, () => revision !== seen);
                }
                if (clientGone(req, res)) return;
                return send(res, 200, { sessions: visibleSessions(sessions, Date.now(), WAIT_MS), talks: visibleTalks(talks) });
            }
            const talkMatch = url.pathname.match(/^\/api\/talks\/([A-Za-z0-9_-]{6,128})$/);
            if (req.method === 'GET' && talkMatch) {
                const talk = talks.get(talkMatch[1]);
                if (!talk) return send(res, 404, { error: 'gone' });
                return send(res, 200, { talk });
            }
            if (req.method === 'DELETE' && talkMatch) {
                if (!dropTalk(talks, talkMatch[1])) return send(res, 404, { error: 'gone' });
                saveTalks(talks);
                saveDropped();
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/filters') {
                const body = await readBody(req);
                if (applyFilterPatch(filters, body)) {
                    saveFilters();
                    touchFilters();
                }
                return send(res, 200, filters);
            }
            if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
                const body = await readBody(req);
                const session = applyHeartbeat(sessions, body, Date.now());
                if (!session) return send(res, 400, { error: 'bad tab' });
                const archived = rememberTalk(talks, body, Date.now());
                saveSessions(sessions);
                if (archived) saveTalks(talks);
                if (url.searchParams.get('wait') === '1') {
                    const seenFilters = filterRev;
                    await waitUntil(POLL_MS, req, () => heartbeatReady(session) || filterRev !== seenFilters);
                }
                if (clientGone(req, res)) return;
                const outbox = pendingOutbox(session);
                const patch = takeControlPatch(session);
                const avatarPatch = takeAvatarPatch(session);
                const userPatch = takeUserPatch(session);
                if (outbox.dirty || patch.dirty || avatarPatch.dirty || userPatch.dirty) saveSessions(sessions);
                return send(res, 200, { ok: true, outbox: outbox.pending, controls: patch.controls, avatarOn: avatarPatch.avatarOn, userOn: userPatch.userOn, filters });
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
                touch();
                return send(res, 200, { ok: true });
            }
            const userPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/user$/);
            if (req.method === 'POST' && userPost) {
                const session = sessions.get(userPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                session.userWanted = !!body.on;
                saveSessions(sessions);
                touch();
                return send(res, 200, { ok: true });
            }
            const controlPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/controls$/);
            if (req.method === 'POST' && controlPost) {
                const session = sessions.get(controlPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const patch = cleanControls(await readBody(req));
                if (!patch) return send(res, 400, { error: 'bad controls' });
                session.controlWanted = patch;
                saveSessions(sessions);
                touch();
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
                touch();
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
