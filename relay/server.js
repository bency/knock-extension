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
const PEOPLE_FILE = path.join(path.dirname(DATA), 'people.json');
const FILTER_KEEP = 2000;
const IMG_DIR = path.join(path.dirname(DATA), 'images');
const ALERT_FILE = path.join(path.dirname(DATA), 'phone-alerts.json');

function tokenOk(header) {
    const got = String(header || '').startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!TOKEN || !got) return false;
    const a = crypto.createHash('sha256').update(TOKEN).digest();
    const b = crypto.createHash('sha256').update(got).digest();
    return crypto.timingSafeEqual(a, b);
}

function cleanUid(raw) {
    const s = String(raw || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(s) || s.startsWith('conv_')) return '';
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

// 沒有明確改名時，空白或「未命名」不能蓋掉已經存過的名稱。
function chosenTitle(archive, prev) {
    const sent = String(archive && archive.title || '').trim().slice(0, 40);
    if (archive && archive.named) return sent || '未命名';
    if (prev && prev.title && prev.title !== '未命名') return prev.title;
    if (sent && sent !== '未命名') return sent;
    return (prev && prev.title) || sent || '未命名';
}

function setTalkTitle(talks, uid, title) {
    const talk = uid ? talks.get(uid) : null;
    if (!talk || talk.title === title) return false;
    talk.title = title;
    return true;
}

function archiveMessage(m) {
    const id = String(m && m.id || '').slice(0, 80);
    const text = String(m && m.text || '').slice(0, 500);
    const quote = String(m && m.quote || '').slice(0, 200);
    const image = /^[a-z0-9]{8,40}$/.test(m && m.image) ? m.image : '';
    const end = m && (m.end === 'idle' || m.end === 'them' || m.end === 'mine') ? m.end : '';
    if (unsentStamp(m && m.time)) return null;
    const time = withYear(m && m.time);
    if (!id || !(text || quote || image || end)) return null;
    const row = { id, text, quote, image, mine: !!(m && m.mine), time };
    if (end) row.end = end;
    return row;
}

function taipeiClock(now) {
    const d = new Date((Number(now) || Date.now()) + 8 * 60 * 60 * 1000);
    return d.getUTCFullYear() + '/' + pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

// 同一人的訊息全部保留。人超過 300 個時，刪掉最久沒更新的。
function rememberTalk(talks, body, now) {
    const archive = body && body.archive;
    if (!archive || typeof archive !== 'object') return false;
    const uid = cleanUid(archive.uid);
    if (!uid) return false;
    const incoming = (Array.isArray(archive.messages) ? archive.messages : []).map(archiveMessage).filter(Boolean).filter(m => !dropped.has(uid + ':' + m.id)).slice(0, 40);
    const prev = talks.get(uid);
    const avatar = cleanAvatar(body && body.openings && body.openings.avatar) || (prev && prev.avatar) || '';
    const person = people.get(uid);
    const title = (person && person.named && !(archive && archive.named))
        ? (person.title || '未命名')
        : chosenTitle(archive, prev);
    if (!incoming.length && prev && prev.title === title && avatar === (prev.avatar || '')) return false;
    const map = new Map();
    for (const m of (prev && prev.messages) || []) if (m && m.id) map.set(m.id, m);
    let changed = !prev || prev.title !== title || (avatar && avatar !== (prev.avatar || ''));
    for (const m of incoming) {
        const old = map.get(m.id);
        if (m.end && !m.time && !(old && old.time)) m.time = taipeiClock(now);
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
    const messages = [...map.values()];
    if (!messages.length) return false;
    const lastAt = talkLastAt(messages) || (prev && prev.lastAt) || 0;
    talks.set(uid, { uid, title, messages, updated: now, lastAt, avatar });
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
        .map(t => ({ uid: t.uid, title: t.title, avatar: t.avatar || '', updated: t.updated, lastAt: t.lastAt || t.updated || 0, count: (t.messages && t.messages.length) || 0 }))
        .sort((a, b) => b.lastAt - a.lastAt || b.updated - a.updated || (a.uid < b.uid ? -1 : 1));
}

function searchTalks(talks, raw) {
    const q = String(raw || '').trim().slice(0, 80).toLowerCase();
    if (!q) return [];
    const out = [];
    for (const t of talks.values()) {
        let matches = 0;
        let sample = '';
        for (const m of t.messages || []) {
            const text = String(m.text || '');
            const quote = String(m.quote || '');
            if ((text + ' ' + quote).toLowerCase().indexOf(q) < 0) continue;
            matches += 1;
            if (!sample) sample = (text || quote).slice(0, 80);
            if (matches >= 99) break;
        }
        const title = String(t.title || '');
        if (!matches && title.toLowerCase().indexOf(q) < 0) continue;
        out.push({
            uid: t.uid,
            title: t.title,
            avatar: t.avatar || '',
            lastAt: t.lastAt || t.updated || 0,
            count: (t.messages && t.messages.length) || 0,
            matches: matches || 1,
            sample: sample || title
        });
    }
    out.sort((a, b) => b.lastAt - a.lastAt || (a.uid < b.uid ? -1 : 1));
    return out.slice(0, 200);
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
            const messages = src.map(archiveMessage).filter(Boolean);
            if (!messages.length) continue;
            const updated = Number(t.updated) || 0;
            map.set(uid, {
                uid,
                title: String(t.title || '未命名').slice(0, 40) || '未命名',
                messages,
                updated,
                lastAt: talkLastAt(messages) || Number(t.lastAt) || updated,
                avatar: cleanAvatar(t.avatar) || ''
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

// 對話刪掉也留這個人。ponytail: 一人一筆、不含訊息，檔案變大再拆。
let people = new Map();
let peopleRev = Date.now();

function earliestAt(messages) {
    let at = 0;
    for (const m of messages || []) {
        const t = messageTimeMs(m && m.time);
        if (t && (!at || t < at)) at = t;
    }
    return at;
}

function personStats(prev, spec) {
    const channels = prev && Array.isArray(prev.channels) ? prev.channels.slice() : [];
    let meets = prev && prev.meets || 0;
    let pendingTalk = !!(prev && prev.pendingTalk);
    let filterMeet = prev ? prev.filterMeet === true : !(spec && (spec.seedFilter || spec.seedTalk));
    let talkSeeded = !!(prev && prev.talkSeeded);
    let count = prev && prev.count || 0;
    if (spec && spec.seedTalk && !talkSeeded) {
        talkSeeded = true;
        if (!meets && !channels.length) {
            meets = 1;
            pendingTalk = true;
        }
    }
    if (spec && spec.seedFilter && !filterMeet) {
        filterMeet = true;
        meets += 1;
    }
    const channelId = String(spec && spec.channelId || '').trim().slice(0, 80);
    if (channelId && channels.indexOf(channelId) < 0) {
        channels.push(channelId);
        if (!(pendingTalk && channels.length === 1)) meets += 1;
        pendingTalk = false;
    }
    if (spec && typeof spec.count === 'number' && spec.count > count) count = spec.count;
    return { meets, channels, pendingTalk, filterMeet, talkSeeded, count };
}

function notePerson(box, spec, now) {
    const uid = cleanUid(spec && spec.uid);
    if (!uid) return false;
    const prev = box.get(uid);
    const explicit = !!(spec && spec.named);
    const sent = String(spec && spec.title || '').trim().slice(0, 40);
    const named = explicit || !!(prev && prev.named);
    let title = '未命名';
    if (explicit) title = sent || '未命名';
    else if (prev && prev.named) title = prev.title || '未命名';
    else if (prev && prev.title && prev.title !== '未命名') title = prev.title;
    else if (sent && sent !== '未命名') title = sent;
    else title = (prev && prev.title) || '未命名';
    const avatar = cleanAvatar(spec && spec.avatar) || (prev && prev.avatar) || '';
    const seen = earliestAt(spec && spec.messages);
    let firstAt = (prev && prev.firstAt) || 0;
    if (seen && (!firstAt || seen < firstAt)) firstAt = seen;
    if (!firstAt) firstAt = now || 0;
    const stats = personStats(prev, spec);
    if (prev && prev.title === title && (prev.avatar || '') === avatar && prev.firstAt === firstAt && !!prev.named === named
        && prev.meets === stats.meets && prev.count === stats.count && !!prev.pendingTalk === stats.pendingTalk
        && !!prev.filterMeet === stats.filterMeet && !!prev.talkSeeded === stats.talkSeeded
        && (prev.channels || []).join() === stats.channels.join()) return false;
    box.set(uid, {
        uid, title, avatar, firstAt, named,
        meets: stats.meets,
        count: stats.count,
        channels: stats.channels,
        pendingTalk: stats.pendingTalk,
        filterMeet: stats.filterMeet,
        talkSeeded: stats.talkSeeded
    });
    if (!prev || (prev.title || '未命名') !== title) peopleRev += 1;
    return true;
}

function heartPeople(box, seen) {
    const rev = peopleRev;
    const out = { peopleRev: rev };
    if (typeof seen === 'number' && seen === rev) return out;
    out.people = visiblePeople(box).map(p => ({ uid: p.uid, title: p.title || '未命名' }));
    return out;
}

function faceRows(list) {
    const map = new Map();
    for (const p of list || []) {
        const id = String(p && p.avatar || '');
        if (!id) continue;
        let row = map.get(id);
        if (!row) {
            row = { id, count: 0, filtered: false };
            map.set(id, row);
        }
        row.count += 1;
        if (p.avatarFiltered) row.filtered = true;
    }
    return [...map.values()].sort((a, b) => (b.count - a.count) || (a.id < b.id ? -1 : 1));
}

function visiblePeople(box) {
    const on = new Set((filters.users || []).map(x => x && x.u).filter(Boolean));
    const faces = new Set(filters.avatars || []);
    return [...box.values()]
        .map(p => ({
            uid: p.uid,
            title: p.title || '未命名',
            avatar: p.avatar || '',
            firstAt: p.firstAt || 0,
            meets: p.meets || 0,
            count: p.count || 0,
            filtered: on.has(p.uid),
            avatarFiltered: !!(p.avatar && faces.has(p.avatar))
        }))
        .sort((a, b) => (b.firstAt - a.firstAt) || (a.uid < b.uid ? -1 : 1));
}

function loadPeople() {
    try {
        const raw = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
        const map = new Map();
        for (const p of raw || []) {
            const uid = cleanUid(p && p.uid);
            if (!uid) continue;
            map.set(uid, {
                uid,
                title: String(p.title || '未命名').slice(0, 40) || '未命名',
                avatar: cleanAvatar(p.avatar) || '',
                firstAt: Number(p.firstAt) || 0,
                named: !!p.named,
                meets: Number(p.meets) || 0,
                count: Number(p.count) || 0,
                channels: Array.isArray(p.channels) ? p.channels.map(c => String(c).slice(0, 80)).filter(Boolean) : [],
                pendingTalk: p.pendingTalk === true,
                filterMeet: p.filterMeet === true,
                talkSeeded: p.talkSeeded === true
            });
        }
        return map;
    } catch (e) {
        return new Map();
    }
}

function savePeople(box) {
    fs.writeFileSync(PEOPLE_FILE, JSON.stringify([...box.values()]));
}

function seedPeople(box, talks) {
    let changed = false;
    for (const t of talks.values()) {
        if (notePerson(box, {
            uid: t.uid,
            title: t.title,
            avatar: t.avatar,
            messages: t.messages,
            count: (t.messages || []).length,
            seedTalk: true
        }, t.updated || t.lastAt || 0)) changed = true;
    }
    for (const f of filters.users || []) {
        const uid = cleanUid(f && f.u);
        if (uid && notePerson(box, { uid, seedFilter: true, messages: [] }, 0)) changed = true;
    }
    for (const p of box.values()) {
        if (p.filterMeet) continue;
        p.filterMeet = true;
        changed = true;
    }
    return changed;
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
        const kept = filters.users.filter(x => !String(x && x.u || '').startsWith('conv_'));
        if (kept.length !== filters.users.length) {
            filters.users = kept;
            saveFilters();
        }
    } catch (e) {}
}

function saveFilters() {
    fs.writeFileSync(FILTER_FILE, JSON.stringify(filters));
}

function unsentStamp(time) {
    return String(time || '').trim() === '未傳送';
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
    })).filter(m => m.id && (m.text || m.quote || m.image) && !unsentStamp(m.time));
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

function cleanScriptVersion(raw) {
    const s = String(raw || '').trim();
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(s) ? s : '';
}

// ponytail: 配對頁沒有訊息列就清空這一輪畫面。舊對話留在記錄裡。
function pairingSurface(body) {
    return !!(body && (body.lobby || body.phase || body.status === 'left') && !(body.messages && body.messages.length));
}

// ponytail: 等待連線排最上面。有舊訊息的離開中排第二，進行中的對話依最後一則時間。
function liveRank(s) {
    const connect = !!(s && (s.lobby || s.status === 'left' || s.phase));
    if (!connect) return 0;
    return (s.messages && s.messages.length) ? 1 : 2;
}

function quoteKey(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

// ponytail: 引用只存文字。全文對上最近的前一則；對不上才往前掃前綴，最壞每則引用都掃過整段。同樣文字有多則時跳到最近的前一則。圖片引用找最近一張沒有文字的圖。
function quoteTargets(messages) {
    const list = messages || [];
    const seen = new Map();
    const keys = [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const m = list[i] || {};
        const q = quoteKey(m.quote);
        let target = q && seen.has(q) ? seen.get(q) : '';
        if (q && !target && q !== '圖片' && q.length >= 8) {
            for (let j = i - 1; j >= 0; j--) {
                const text = keys[j];
                if (!text || text.length < 8) continue;
                if (text.indexOf(q) === 0 || q.indexOf(text) === 0) {
                    target = (list[j] && list[j].id) || '';
                    break;
                }
            }
        }
        out.push(target || '');
        const text = m.end ? '' : quoteKey(m.text);
        keys.push(text);
        if (m.end) continue;
        if (text) {
            seen.set(text, m.id || '');
            if (text.length > 200) seen.set(text.slice(0, 200), m.id || '');
        } else if (m.image) seen.set('圖片', m.id || '');
    }
    return out;
}

function applyHeartbeat(sessions, body, now) {
    const tabId = String(body && body.tabId || '').trim();
    if (!/^[a-z0-9]{8,40}$/.test(tabId)) return null;
    const prev = sessions.get(tabId);
    const channelId = String(body.channelId || '').slice(0, 80);
    const sameChannel = !!(prev && prev.channelId === channelId);
    const sentTitle = String(body.title || '').trim().slice(0, 40) || '未命名';
    let titleWanted = sameChannel && prev && typeof prev.titleWanted === 'string' ? prev.titleWanted : null;
    if (titleWanted != null && sentTitle === titleWanted) titleWanted = null;
    const title = titleWanted != null ? titleWanted : sentTitle;
    const session = {
        tabId,
        channelId,
        title,
        titleWanted,
        partnerUid: cleanUid(body.archive && body.archive.uid) || (sameChannel && prev && prev.partnerUid) || '',
        canType: !!body.canType,
        lobby: !!body.lobby,
        greeting: body.lobby ? String(body.greeting || '').trim().slice(0, 200) : (prev && prev.greeting) || '',
        greetingWanted: prev && typeof prev.greetingWanted === 'string' ? prev.greetingWanted : null,
        phase: String(body.phase || '').trim().slice(0, 80),
        canStart: typeof body.canStart === 'boolean' ? body.canStart : null,
        startWanted: !!(prev && prev.startWanted),
        leaveWanted: !!(prev && prev.leaveWanted),
        reloadWanted: !!(prev && prev.reloadWanted),
        status: body.status === 'left' ? 'left' : 'live',
        messages: pairingSurface(body) ? [] : keepRecalled(cleanMessages(body.messages), prev && prev.messages),
        seen: now,
        openings: pairingSurface(body) ? null : (body.openings
            ? cleanOpenings(body.openings, sameChannel ? prev.openings : null, now)
            : (sameChannel && prev && prev.openings) || null),
        avatarWanted: sameChannel && prev && typeof prev.avatarWanted === 'boolean' ? prev.avatarWanted : null,
        userWanted: sameChannel && prev && typeof prev.userWanted === 'boolean' ? prev.userWanted : null,
        controls: keepControls(cleanControls(body.controls), body.controls, prev),
        script: cleanScriptVersion(body.script) || (prev && prev.script) || '',
        typing: !!body.typing,
        controlWanted: prev ? prev.controlWanted : null,
        notifyWanted: prev && typeof prev.notifyWanted === 'string' ? prev.notifyWanted : null,
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
            partnerUid: s.partnerUid || '',
            canType: s.canType,
            lobby: !!s.lobby,
            greeting: s.greeting || '',
            phase: s.phase || '',
            canStart: s.canStart === true ? true : s.canStart === false ? false : null,
            status: s.status,
            seen: s.seen,
            waiting: now - s.seen > waitMs,
            messages: s.messages,
            openings: s.openings || null,
            controls: s.controls || null,
            script: s.script || '',
            typing: !!s.typing,
            pending: s.outbox.length,
            queued: queuedLines(s.outbox)
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
                lobby: !!s.lobby,
                greeting: String(s.greeting || '').slice(0, 200),
                greetingWanted: typeof s.greetingWanted === 'string' ? String(s.greetingWanted).slice(0, 200) : null,
                phase: String(s.phase || '').slice(0, 80),
                canStart: s.canStart === true ? true : s.canStart === false ? false : null,
                startWanted: !!s.startWanted,
                leaveWanted: !!s.leaveWanted,
                reloadWanted: !!s.reloadWanted,
                status: s.status === 'left' ? 'left' : 'live',
                messages: cleanMessages(s.messages),
                seen: Number(s.seen) || 0,
                openings: cleanOpenings(s.openings, s.openings, Number(s.seen) || 0),
                avatarWanted: s.avatarWanted === true ? true : s.avatarWanted === false ? false : null,
                userWanted: s.userWanted === true ? true : s.userWanted === false ? false : null,
                controls: cleanControls(s.controls),
                script: cleanScriptVersion(s.script),
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
function queuedLines(outbox) {
    return (Array.isArray(outbox) ? outbox : []).filter(item => item && item.id).map(item => ({
        id: String(item.id).slice(0, 40),
        text: (item.image && !String(item.text || '').trim() ? '圖片' : String(item.text || '').trim().slice(0, 200)) || '圖片'
    }));
}

function keptOutbox(list) {
    return (Array.isArray(list) ? list : []).filter(item => item && !item.image).slice(-20);
}

function pendingOutbox(session) {
    const pending = [];
    const keep = [];
    let dirty = false;
    for (const item of session.outbox) {
        if (!item) continue;
        if (item.image) {
            dirty = true;
            if (!item.handed) {
                item.handed = true;
                pending.push(item);
            }
            continue;
        }
        keep.push(item);
        pending.push(item);
    }
    if (dirty) session.outbox = keep;
    return { pending, dirty };
}

// 頁面上的 packControls 要跟這份欄位一致。
function controlHours(raw, fallback) {
    let n = Number(raw);
    if (!(n >= 0.1)) n = fallback;
    if (n > 48) n = 48;
    return Math.round(n * 10) / 10;
}

function cleanControls(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const phoneTopic = String(raw.phoneTopic || '').trim();
    if (phoneTopic && !/^[A-Za-z0-9_-]{1,64}$/.test(phoneTopic)) return null;
    let keepMin = controlHours(raw.keepMin, 1.5);
    let keepMax = controlHours(raw.keepMax, 2.5);
    if (keepMax < keepMin) { const t = keepMin; keepMin = keepMax; keepMax = t; }
    return {
        auto: !!raw.auto,
        userFilter: !!raw.userFilter,
        avatarFilter: !!raw.avatarFilter,
        browser: !!raw.browser,
        phone: !!raw.phone,
        phoneTopic,
        phoneTitle: String(raw.phoneTitle || '').trim().slice(0, 80) || 'Knock 新訊息',
        keep: !!raw.keep,
        keepText: String(raw.keepText || '').trim().slice(0, 200) || '🎶',
        keepMin,
        keepMax,
        opener: !!raw.opener,
        openerText: String(raw.openerText || '').trim().slice(0, 200),
        openerWhen: openerMode(raw.openerWhen)
    };
}

function openerMode(when) {
    return when === 'id' || when === 'off' ? when : 'now';
}

function keepControls(next, raw, prev) {
    if (!next) return (prev && prev.controls) || null;
    const old = prev && prev.controls;
    if (!old) return next;
    const kept = Object.assign({}, next);
    if (!(raw && Object.prototype.hasOwnProperty.call(raw, 'keep'))) {
        kept.keep = !!old.keep;
        kept.keepText = String(old.keepText || '').trim().slice(0, 200) || '🎶';
        kept.keepMin = old.keepMin;
        kept.keepMax = old.keepMax;
    }
    if (!(raw && Object.prototype.hasOwnProperty.call(raw, 'openerWhen'))) {
        kept.opener = !!old.opener;
        kept.openerText = String(old.openerText || '').trim().slice(0, 200);
        kept.openerWhen = openerMode(old.openerWhen);
    }
    return kept;
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

function markSessionUser(session, on) {
    const uid = cleanUid(session && session.partnerUid);
    if (!uid) return false;
    session.userWanted = !!on;
    applyFilterPatch(filters, on
        ? { addUsers: [{ u: uid, t: '', a: '' }] }
        : { removeUsers: [{ u: uid, t: '', a: '' }] });
    return true;
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

function takeGreetingPatch(session) {
    if (typeof session.greetingWanted !== 'string') return { greeting: null, dirty: false };
    if (session.greeting === session.greetingWanted) {
        session.greetingWanted = null;
        return { greeting: null, dirty: true };
    }
    if (!session.lobby) return { greeting: null, dirty: false };
    return { greeting: session.greetingWanted, dirty: false };
}

function takeStartPatch(session) {
    if (!session.startWanted) return { start: false, dirty: false };
    session.startWanted = false;
    return { start: true, dirty: true };
}

function takeLeavePatch(session) {
    if (!session.leaveWanted) return { leave: false, dirty: false };
    session.leaveWanted = false;
    return { leave: true, dirty: true };
}

function takeReloadPatch(session) {
    if (!session.reloadWanted) return { reload: false, dirty: false };
    session.reloadWanted = false;
    return { reload: true, dirty: true };
}

function requestReload(session) {
    session.reloadWanted = true;
    session.outbox = [];
}

function latestThemText(session) {
    const list = session && session.messages || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || m.mine) continue;
        const text = String(m.text || '').trim();
        if (text) return text.slice(0, 80);
        if (m.image) return '圖片';
        const quote = String(m.quote || '').trim();
        if (quote) return quote.slice(0, 80);
    }
    const opening = session && session.openings && session.openings.them && session.openings.them.text;
    return String(opening || '').trim().slice(0, 80);
}

function takeNotifyPatch(session) {
    if (typeof session.notifyWanted !== 'string' || !session.notifyWanted) return { notify: null, dirty: false };
    const notify = session.notifyWanted;
    session.notifyWanted = null;
    return { notify, dirty: true };
}

let phoneAlerts = [];

function cleanPhoneReason(raw) {
    return String(raw || '').trim().slice(0, 200);
}

function addPhoneAlert(list, reason) {
    const text = cleanPhoneReason(reason);
    if (!text) return list;
    if (list.some(a => a.reason === text)) return list;
    const next = list.concat([{ id: crypto.randomBytes(4).toString('hex'), reason: text }]);
    return next.length > 20 ? next.slice(-20) : next;
}

function dismissPhoneAlerts(list, ids) {
    const drop = new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '')).filter(id => /^[a-f0-9]{8}$/.test(id)));
    if (!drop.size) return list;
    return list.filter(a => !drop.has(a.id));
}

function loadPhoneAlerts() {
    try {
        const raw = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8'));
        phoneAlerts = (Array.isArray(raw) ? raw : []).map(a => ({
            id: /^[a-f0-9]{8}$/.test(a && a.id) ? a.id : '',
            reason: cleanPhoneReason(a && a.reason)
        })).filter(a => a.id && a.reason).slice(-20);
    } catch (e) {
        phoneAlerts = [];
    }
}

function savePhoneAlerts() {
    fs.writeFileSync(ALERT_FILE, JSON.stringify(phoneAlerts));
}

function notePhoneAlert(reason) {
    const next = addPhoneAlert(phoneAlerts, reason);
    if (next === phoneAlerts) return;
    phoneAlerts = next;
    savePhoneAlerts();
    touch();
}

function clearPhoneAlerts(ids) {
    const next = dismissPhoneAlerts(phoneAlerts, ids);
    if (next.length === phoneAlerts.length) return;
    phoneAlerts = next;
    savePhoneAlerts();
    touch();
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
        || heartbeatReady(quiet) || !heartbeatReady(sessions.get('abc12345'))
        || cleanScriptVersion('1.4.108') !== '1.4.108'
        || cleanScriptVersion('1.4')
        || cleanScriptVersion('abc')
        || applyHeartbeat(sessions, { tabId: 'quiettab1', title: '空', canType: true, script: '1.4.108', messages: [] }, 1500).script !== '1.4.108') {
        throw new Error('knock relay 檢查失敗');
    }
    const typingOn = applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, typing: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 21000);
    const shownOn = visibleSessions(sessions, 21000, 15000).find(s => s.tabId === 'abc12345');
    const typingOff = applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 22000);
    const shownOff = visibleSessions(sessions, 22000, 15000).find(s => s.tabId === 'abc12345');
    if (!typingOn.typing || !shownOn || !shownOn.typing || typingOff.typing || !shownOff || shownOff.typing) {
        throw new Error('knock relay 檢查失敗');
    }
    const endTalks = new Map();
    const endBody = { archive: { uid: 'user_endnote1', title: '甲', messages: [{ id: 'end-c1', text: '閒置時間過久', end: 'idle' }] } };
    const endAt = Date.parse('2020-01-02T00:00:00Z');
    if (!rememberTalk(endTalks, endBody, endAt)) throw new Error('knock relay 檢查失敗');
    const endMsg = endTalks.get('user_endnote1').messages[0];
    if (!endMsg || endMsg.end !== 'idle' || endMsg.text !== '閒置時間過久' || endMsg.time !== '2020/01/02 08:00') throw new Error('knock relay 檢查失敗');
    const quoteHits = quoteTargets([
        { id: 'a', text: '你好啊今天' },
        { id: 'b', text: '嗯', quote: '你好啊今天' },
        { id: 'c', text: '', image: 'abcd1234' },
        { id: 'd', text: '看', quote: '圖片' },
        { id: 'e', text: '重複一句' },
        { id: 'f', text: '重複一句' },
        { id: 'g', text: '再', quote: '重複一句' },
        { id: 'h', text: '這是一段比較長的句子用來當引用' },
        { id: 'i', text: '回', quote: '這是一段比較長的' },
        { id: 'j', text: '孤立', quote: '沒有這句' }
    ]);
    if (quoteHits.join() !== ',a,,c,,,f,,h,') throw new Error('knock relay 檢查失敗');
    if (rememberTalk(endTalks, endBody, endAt + 3600000) || endTalks.get('user_endnote1').messages.length !== 1) throw new Error('knock relay 檢查失敗');
    const revBox = new Map();
    const revBefore = peopleRev;
    if (!notePerson(revBox, { uid: 'user_revA', title: '甲', messages: [] }, 1) || peopleRev === revBefore) throw new Error('knock relay 檢查失敗');
    const listed = heartPeople(revBox, 0);
    if (!listed.people || listed.people[0].uid !== 'user_revA' || listed.people[0].title !== '甲' || listed.peopleRev !== peopleRev) throw new Error('knock relay 檢查失敗');
    const quietList = heartPeople(revBox, listed.peopleRev);
    if (quietList.people || quietList.peopleRev !== listed.peopleRev) throw new Error('knock relay 檢查失敗');
    const revHeld = peopleRev;
    notePerson(revBox, { uid: 'user_revA', title: '甲', messages: [{ time: '2020/01/02 08:00' }] }, 2);
    if (peopleRev !== revHeld) throw new Error('knock relay 檢查失敗');
    notePerson(revBox, { uid: 'user_revA', title: '乙', named: true, messages: [] }, 3);
    const renamed = heartPeople(revBox, quietList.peopleRev);
    if (!renamed.people || renamed.people[0].title !== '乙' || renamed.peopleRev === quietList.peopleRev) throw new Error('knock relay 檢查失敗');
    notePageActive('1', 1000);
    if (!pageOn(5000) || pageOn(9000)) throw new Error('knock relay 檢查失敗');
    notePageActive('0', 5000);
    if (pageOn(5000)) throw new Error('knock relay 檢查失敗');
    if (applyHeartbeat(sessions, { tabId: '../x', title: 'x' }, 2000)) throw new Error('knock relay 檢查失敗');
    const imgItem = enqueue(sessions.get('abc12345'), '', 30000, 'abcd1234');
    const withImg = cleanMessages([{ id: 'imgmsg01', text: '', quote: '原文', image: 'abcd1234' }]);
    const droppedUnsent = cleanMessages([{ id: 'u1', text: '不會耶', mine: true, time: '未傳送' }, { id: 'u2', text: '嗨', mine: true, time: '10:01' }]);
    const beforeQueue = queuedLines(sessions.get('abc12345').outbox);
    const handed = pendingOutbox(sessions.get('abc12345'));
    const again = pendingOutbox(sessions.get('abc12345'));
    const kept = keptOutbox([{ text: 'a' }, { image: 'abcd1234' }, { text: 'b' }]);
    const shownQueue = queuedLines(sessions.get('abc12345').outbox);
    if (!imgItem || !imgItem.image || withImg.length !== 1 || withImg[0].quote !== '原文' || withImg[0].image !== 'abcd1234'
        || droppedUnsent.length !== 1 || droppedUnsent[0].id !== 'u2'
        || archiveMessage({ id: 'u1', text: '不會耶', mine: true, time: '未傳送' })
        || beforeQueue.length !== 2 || beforeQueue[1].text !== '圖片'
        || handed.pending.filter(item => item.image).length !== 1
        || again.pending.some(item => item.image)
        || sessions.get('abc12345').outbox.some(item => item && item.image)
        || shownQueue.length !== 1 || shownQueue[0].text !== '回你'
        || kept.length !== 2) {
        throw new Error('knock relay 檢查失敗');
    }
    const wanted = cleanControls({ auto: 1, userFilter: 1, avatarFilter: 0, browser: 1, keep: 1, keepText: ' 在嗎 ', keepMin: 2, keepMax: 1, phone: 1, phoneTopic: 'knock-room', phoneTitle: '' });
    sessions.get('abc12345').controlWanted = wanted;
    applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 11000);
    const keptWanted = sessions.get('abc12345').controlWanted;
    if (!wanted || !wanted.auto || !wanted.userFilter || wanted.avatarFilter || !wanted.browser
        || !wanted.keep || wanted.keepText !== '在嗎' || wanted.keepMin !== 1 || wanted.keepMax !== 2
        || !wanted.phone || wanted.phoneTopic !== 'knock-room' || wanted.phoneTitle !== 'Knock 新訊息'
        || !keptWanted || !sameControls(wanted, keptWanted)
        || cleanControls({ phoneTopic: 'bad topic' })
        || cleanControls(null)) {
        throw new Error('knock relay 檢查失敗');
    }
    const keptAlive = keepControls(cleanControls({ auto: 1, phoneTopic: 'knock-room' }), { auto: 1, phoneTopic: 'knock-room' }, { controls: wanted });
    if (!keptAlive || !keptAlive.keep || keptAlive.keepText !== '在嗎' || keptAlive.keepMin !== 1 || keptAlive.keepMax !== 2
        || cleanControls({ keepText: '  ' }).keepText !== '🎶'
        || cleanControls({ openerWhen: 'id', openerText: ' 早 ' }).openerWhen !== 'id'
        || cleanControls({ openerText: ' 早 ' }).openerText !== '早'
        || cleanControls({ openerWhen: 'later' }).openerWhen !== 'now'
        || cleanControls({ openerWhen: 'off' }).openerWhen !== 'off') {
        throw new Error('knock relay 檢查失敗');
    }
    const prevOpener = cleanControls({ opener: 1, openerText: '早', openerWhen: 'id', keep: 1, keepText: '在嗎', keepMin: 1, keepMax: 2, phoneTopic: 'ok' });
    const keptOpener = keepControls(cleanControls({ auto: 1, phoneTopic: 'ok' }), { auto: 1, phoneTopic: 'ok' }, { controls: prevOpener });
    const replacedOpener = keepControls(cleanControls({ opener: 0, openerText: '', openerWhen: 'now', phoneTopic: 'ok' }), { openerWhen: 'now', phoneTopic: 'ok' }, { controls: prevOpener });
    const keptOff = keepControls(cleanControls({ auto: 1, phoneTopic: 'ok' }), { auto: 1, phoneTopic: 'ok' }, { controls: cleanControls({ opener: 1, openerText: '早', openerWhen: 'off', phoneTopic: 'ok' }) });
    if (!keptOpener || !keptOpener.opener || keptOpener.openerText !== '早' || keptOpener.openerWhen !== 'id'
        || !keptOpener.keep || replacedOpener.opener || replacedOpener.openerWhen !== 'now' || replacedOpener.openerText
        || !keptOff || keptOff.openerWhen !== 'off') {
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
    sessions.get('abc12345').avatarWanted = true;
    sessions.get('abc12345').userWanted = true;
    const keptMark = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '阿明', canType: true, channelId: 'c2',
        messages: [{ id: 'm1', text: '嗨', mine: false }],
        openings: { them: '嗨', avatarOn: false, userOn: false }
    }, 15000);
    const droppedMark = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '阿明', canType: true, channelId: 'c3',
        messages: [{ id: 'm1', text: '嗨', mine: false }],
        openings: { them: '嗨', avatarOn: false, userOn: false }
    }, 16000);
    if (!keptMark || keptMark.avatarWanted !== true || keptMark.userWanted !== true
        || !droppedMark || droppedMark.avatarWanted !== null || droppedMark.userWanted !== null) {
        throw new Error('knock relay 檢查失敗');
    }
    const lobby = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '大廳', canType: false, lobby: true, greeting: '你好', phase: '開始聊天', canStart: true
    }, 17000);
    lobby.greetingWanted = '在嗎';
    lobby.startWanted = true;
    const greet = takeGreetingPatch(lobby);
    const started = takeStartPatch(lobby);
    lobby.greeting = '在嗎';
    const greetDone = takeGreetingPatch(lobby);
    const leftLobby = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '大廳', canType: false, lobby: false
    }, 18000);
    if (!heartbeatReady({ startWanted: true, greeting: '你好', greetingWanted: '在嗎', outbox: [] })
        || greet.greeting !== '在嗎' || !started.start || lobby.startWanted
        || greetDone.greeting !== null || lobby.greetingWanted !== null
        || !leftLobby || leftLobby.startWanted || leftLobby.greeting !== '在嗎'
        || lobby.phase !== '開始聊天' || lobby.canStart !== true) {
        throw new Error('knock relay 檢查失敗');
    }
    sessions.get('abc12345').startWanted = true;
    const heldStart = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '離開', canType: false, status: 'left', lobby: false,
        messages: [{ id: 'm1', text: '嗨', mine: false }]
    }, 18500);
    if (!heldStart || !heldStart.startWanted || heldStart.messages.length !== 1) throw new Error('knock relay 檢查失敗');
    heldStart.startWanted = false;
    heldStart.leaveWanted = true;
    const keptLeave = applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 16000);
    if (!keptLeave || !keptLeave.leaveWanted) throw new Error('knock relay 檢查失敗');
    const leaving = takeLeavePatch(keptLeave);
    if (!heartbeatReady({ leaveWanted: true, outbox: [] }) || !leaving.leave || keptLeave.leaveWanted || takeLeavePatch(keptLeave).leave) {
        throw new Error('knock relay 檢查失敗');
    }
    keptLeave.reloadWanted = true;
    const keptReload = applyHeartbeat(sessions, { tabId: 'abc12345', title: '阿明', canType: true, messages: [{ id: 'm1', text: '嗨', mine: false }] }, 17000);
    const reloading = takeReloadPatch(keptReload);
    if (!keptReload || !heartbeatReady({ reloadWanted: true, outbox: [] }) || !reloading.reload || keptReload.reloadWanted || takeReloadPatch(keptReload).reload) {
        throw new Error('knock relay 檢查失敗');
    }
    const abandon = { reloadWanted: false, outbox: [{ id: 'pending1', text: '還沒送' }] };
    requestReload(abandon);
    if (!abandon.reloadWanted || abandon.outbox.length) throw new Error('knock relay 檢查失敗');
    const keptLobby = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '大廳', canType: false, lobby: true, greeting: '你好', messages: []
    }, 18600);
    const paired = applyHeartbeat(sessions, {
        tabId: 'pairtab01', title: '甲', canType: true, channelId: 'c9',
        messages: [{ id: 'm1', text: '嗨', mine: false }],
        openings: { them: '嗨', mine: '早', avatar: 'abcd1234' }
    }, 18650);
    const clearedPair = applyHeartbeat(sessions, {
        tabId: 'pairtab01', title: '甲', canType: false, channelId: 'c9', phase: '配對中', messages: []
    }, 18700);
    if (!keptLobby || !keptLobby.lobby || keptLobby.messages.length
        || !paired || paired.messages.length !== 1 || !paired.openings
        || !clearedPair || clearedPair.messages.length || clearedPair.openings
        || liveRank(clearedPair) <= liveRank(paired)
        || liveRank({ status: 'left', messages: [{ id: 'm1' }] }) <= liveRank({ canType: true, messages: [{ id: 'm1' }] })
        || liveRank({ phase: '配對中', messages: [] }) <= liveRank({ status: 'left', messages: [{ id: 'm1' }] })) {
        throw new Error('knock relay 檢查失敗');
    }
    const noted = applyHeartbeat(sessions, {
        tabId: 'abc12345', title: '阿明', canType: true,
        messages: [{ id: 'mine1', text: '我的', mine: true }, { id: 'them1', text: '對方這句', mine: false }]
    }, 19000);
    noted.notifyWanted = latestThemText(noted);
    const once = takeNotifyPatch(noted);
    if (latestThemText(noted) !== '對方這句' || !heartbeatReady({ notifyWanted: '對方這句', outbox: [] })
        || once.notify !== '對方這句' || takeNotifyPatch(noted).notify) {
        throw new Error('knock relay 檢查失敗');
    }
    const alertOnce = addPhoneAlert(addPhoneAlert([], 'HTTP 429：ntfy.sh 公開伺服器限流，請隔一分鐘再試'), 'HTTP 429：ntfy.sh 公開伺服器限流，請隔一分鐘再試');
    if (alertOnce.length !== 1 || alertOnce[0].reason.indexOf('429') < 0 || dismissPhoneAlerts(alertOnce, [alertOnce[0].id]).length
        || addPhoneAlert([], '').length) {
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
        || searchTalks(talks, '在嗎').length !== 1
        || searchTalks(talks, '在嗎')[0].sample !== '在嗎'
        || searchTalks(talks, '沒有這句').length
        || !dropTalk(talks, 'user_one')
        || talks.has('user_one')
        || rememberTalk(talks, { archive: { uid: 'user_one', title: '阿明', messages: [{ id: 'a', text: '嗨', mine: false }] } }, 5)
        || talks.has('user_one')
        || dropTalk(talks, 'user_one')) {
        throw new Error('knock relay 檢查失敗');
    }
    const longTalk = new Map();
    for (let n = 0; n < 801; n += 40) {
        const batch = [];
        for (let i = n; i < n + 40 && i < 801; i++) batch.push({ id: 'long' + i, text: 'x', time: '1/2 08:00' });
        rememberTalk(longTalk, { archive: { uid: 'user_long1', title: '長', messages: batch } }, n + 1);
    }
    if (!longTalk.get('user_long1') || longTalk.get('user_long1').messages.length !== 801) {
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
    const faced = new Map();
    if (!rememberTalk(faced, { archive: { uid: 'user_face1', title: '臉', messages: [{ id: 'f1', text: '嗨', mine: false, time: '1/2 08:00' }] }, openings: { avatar: 'abcd1234' } }, 4)
        || faced.get('user_face1').avatar !== 'abcd1234'
        || visibleTalks(faced)[0].avatar !== 'abcd1234') throw new Error('knock relay 檢查失敗');
    const folks = new Map();
    const firstAt = messageTimeMs('2020/01/02 08:00');
    if (!notePerson(folks, { uid: 'user_one', title: '未命名', messages: [{ time: '2020/01/02 08:00' }] }, 5000)
        || folks.get('user_one').title !== '未命名'
        || folks.get('user_one').firstAt !== firstAt
        || !notePerson(folks, { uid: 'user_bare', title: '' }, 1000)
        || folks.get('user_bare').title !== '未命名'
        || folks.get('user_bare').firstAt !== 1000) throw new Error('knock relay 檢查失敗');
    notePerson(folks, { uid: 'user_one', title: '小美', named: true }, 9000);
    notePerson(folks, { uid: 'user_one', title: '別人', messages: [{ time: '2020/01/03 09:00' }] }, 9000);
    notePerson(folks, { uid: 'user_one', messages: [{ time: '2019/12/01 01:00' }] }, 9000);
    const keptTalk = new Map();
    rememberTalk(keptTalk, { archive: { uid: 'user_keep', title: '甲', messages: [{ id: 'a', text: '嗨', time: '2020/01/02 08:00' }] } }, 10);
    dropTalk(keptTalk, 'user_keep');
    if (folks.get('user_one').title !== '小美'
        || folks.get('user_one').firstAt !== messageTimeMs('2019/12/01 01:00')
        || keptTalk.has('user_keep')
        || !folks.has('user_one')) throw new Error('knock relay 檢查失敗');
    filters.users.push({ u: 'user_one', t: '', a: '' });
    const shownPeople = visiblePeople(folks);
    filters.users = filters.users.filter(x => x.u !== 'user_one');
    const marked = { partnerUid: 'user_one' };
    if (!markSessionUser(marked, true) || marked.userWanted !== true || !filters.users.some(x => x.u === 'user_one')
        || !markSessionUser(marked, false) || filters.users.some(x => x.u === 'user_one')
        || markSessionUser({ partnerUid: '' }, true)) throw new Error('knock relay 檢查失敗');
    filters.avatars.push('faceaaa1');
    notePerson(folks, { uid: 'user_face1', avatar: 'faceaaa1', title: '甲' }, 1);
    notePerson(folks, { uid: 'user_face2', avatar: 'faceaaa1', title: '乙' }, 1);
    notePerson(folks, { uid: 'user_face3', avatar: 'facebbb2', title: '丙' }, 1);
    const facePeople = visiblePeople(folks);
    const faceList = faceRows(facePeople);
    filters.avatars = filters.avatars.filter(x => x !== 'faceaaa1');
    if (!facePeople.find(p => p.uid === 'user_face1' && p.avatarFiltered)
        || facePeople.find(p => p.uid === 'user_face3' && p.avatarFiltered)
        || faceList[0].id !== 'faceaaa1' || faceList[0].count !== 2 || !faceList[0].filtered
        || !faceList.find(row => row.id === 'facebbb2' && row.count === 1 && !row.filtered)
        || faceRows([{ avatar: '' }]).length) throw new Error('knock relay 檢查失敗');
    if (!shownPeople.find(p => p.uid === 'user_one' && p.filtered && p.title === '小美')
        || shownPeople.find(p => p.uid === 'user_bare').firstAt !== 1000
        || cleanUid('conv_1791645213224_0dsgt5sxq')
        || rememberTalk(new Map(), { archive: { uid: 'conv_1791645213224_0dsgt5sxq', messages: [{ id: 'a', text: '嗨', time: '2020/01/02 08:00' }] } }, 1)
        || notePerson(new Map(), { uid: 'conv_1791645213224_0dsgt5sxq', title: 'x' }, 1)) throw new Error('knock relay 檢查失敗');
    const meetBox = new Map();
    if (!notePerson(meetBox, { uid: 'user_meet', channelId: 'chan0001' }, 1)
        || notePerson(meetBox, { uid: 'user_meet', channelId: 'chan0001' }, 2)
        || meetBox.get('user_meet').meets !== 1
        || !notePerson(meetBox, { uid: 'user_meet', channelId: 'chan0002' }, 3)
        || meetBox.get('user_meet').meets !== 2) throw new Error('knock relay 檢查失敗');
    const oldTalk = new Map();
    if (!notePerson(oldTalk, { uid: 'user_hist', seedTalk: true, count: 4, messages: [{ time: '2020/01/02 08:00' }] }, 1)
        || oldTalk.get('user_hist').meets !== 1
        || oldTalk.get('user_hist').count !== 4
        || !notePerson(oldTalk, { uid: 'user_hist', channelId: 'chanhist1' }, 2)
        || oldTalk.get('user_hist').meets !== 1) throw new Error('knock relay 檢查失敗');
    const both = new Map();
    if (!notePerson(both, { uid: 'user_both', seedTalk: true, count: 2 }, 1)
        || !notePerson(both, { uid: 'user_both', seedFilter: true }, 1)
        || both.get('user_both').meets !== 2
        || both.get('user_both').count !== 2
        || notePerson(both, { uid: 'user_both', seedFilter: true }, 1)) throw new Error('knock relay 檢查失敗');
    const onlyF = new Map();
    if (!notePerson(onlyF, { uid: 'user_filt', seedFilter: true }, 1)
        || onlyF.get('user_filt').meets !== 1
        || onlyF.get('user_filt').count !== 0
        || !notePerson(onlyF, { uid: 'user_filt', title: '仍在' }, 2)
        || onlyF.get('user_filt').meets !== 1
        || onlyF.get('user_filt').count !== 0) throw new Error('knock relay 檢查失敗');
    const named = new Map();
    if (!rememberTalk(named, { archive: { uid: 'user_name', title: '小美', messages: [{ id: 'n1', text: '嗨', time: '1/2 08:00' }] } }, 1)
        || !rememberTalk(named, { archive: { uid: 'user_name', title: '未命名', messages: [{ id: 'n2', text: '新', time: '1/3 09:00' }] } }, 2)
        || named.get('user_name').title !== '小美'
        || named.get('user_name').messages.length !== 2
        || !rememberTalk(named, { archive: { uid: 'user_name', title: '嗨', messages: [{ id: 'n4', text: '嘿', time: '1/4 10:00' }] } }, 4)
        || named.get('user_name').title !== '小美'
        || !rememberTalk(named, { archive: { uid: 'user_name', title: '未命名', named: true, messages: [{ id: 'n2', text: '新', time: '1/3 09:00' }] } }, 3)
        || named.get('user_name').title !== '未命名') throw new Error('knock relay 檢查失敗');
    const freshName = new Map();
    if (!rememberTalk(freshName, { archive: { uid: 'user_newn', title: '未命名', messages: [{ id: 'n1', text: '嗨', time: '1/2 08:00' }] } }, 1)
        || !rememberTalk(freshName, { archive: { uid: 'user_newn', title: '嗨', messages: [{ id: 'n2', text: '新', time: '1/3 09:00' }] } }, 2)
        || freshName.get('user_newn').title !== '嗨') throw new Error('knock relay 檢查失敗');
    applyHeartbeat(sessions, { tabId: 'titletab1', title: '未命名', channelId: 'c1', messages: [{ id: 'm1', text: '嗨', mine: false }] }, 20000);
    sessions.get('titletab1').titleWanted = '小美';
    const heldTitle = applyHeartbeat(sessions, { tabId: 'titletab1', title: '未命名', channelId: 'c1', messages: [{ id: 'm1', text: '嗨', mine: false }] }, 21000);
    const echoedTitle = applyHeartbeat(sessions, { tabId: 'titletab1', title: '小美', channelId: 'c1', messages: [{ id: 'm1', text: '嗨', mine: false }] }, 22000);
    const nextTitle = applyHeartbeat(sessions, { tabId: 'titletab1', title: '未命名', channelId: 'c2', messages: [{ id: 'm1', text: '嗨', mine: false }] }, 23000);
    if (!heldTitle || heldTitle.title !== '小美' || heldTitle.titleWanted !== '小美'
        || !echoedTitle || echoedTitle.titleWanted != null || echoedTitle.title !== '小美'
        || !nextTitle || nextTitle.titleWanted != null || nextTitle.title !== '未命名'
        || !heartbeatReady({ titleWanted: '小美', outbox: [] })) throw new Error('knock relay 檢查失敗');
    const thisYear = String(taipeiNow().getUTCFullYear());
    if (withYear('10/6 11:51') !== thisYear + '/10/06 11:51'
        || withYear(thisYear + '/10/06 11:51') !== thisYear + '/10/06 11:51'
        || withYear('2024/3/4 5:06') !== '2024/03/04 05:06'
        || withYear('9/25') !== thisYear + '/09/25'
        || withYear('2024/9/25') !== '2024/09/25'
        || messageTimeMs('2024/03/04 05:06') !== Date.UTC(2024, 2, 4, 5, 6) - 8 * 60 * 60 * 1000) {
        throw new Error('knock relay 檢查失敗');
    }
    const echo = ownEchoPlan(
        [{ id: 'a', text: '嗨', mine: false }],
        [{ id: 'a', text: '嗨', mine: false }, { id: 'b', text: '在嗎', mine: true, time: '10:01' }],
        ['在嗎']
    );
    const themOnly = ownEchoPlan(
        [{ id: 'a', text: '嗨', mine: false }],
        [{ id: 'a', text: '嗨', mine: false }, { id: 'c', text: '喂', mine: false }],
        []
    );
    const timed = ownEchoPlan(
        [{ id: 'a', text: '嗨', mine: false, time: '' }],
        [{ id: 'a', text: '嗨', mine: false, time: '10:02' }],
        []
    );
    if (themTailId([{ id: 'a', mine: true }, { id: 'b', mine: false }, { id: 'c', mine: true }]) !== 'b'
        || themTailId([{ id: 'c', mine: true }])
        || composerAlert('b', 'a', 'm1', undefined, false)
        || composerAlert('a', 'a', 'm2', 'm1', true)
        || composerAlert('b', 'a', '', 'm1', true)
        || composerAlert('b', 'a', 'm1', 'm1', true)
        || !composerAlert('b', 'a', 'm2', 'm1', true)
        || !composerAlert('b', 'a', 'm1', undefined, true)
        || !echo || echo.redraw || echo.added.length !== 1 || echo.added[0].id !== 'b' || echo.rest.length
        || !themOnly || !themOnly.redraw
        || !timed || timed.redraw || timed.times.length !== 1 || timed.times[0].id !== 'a') {
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
let pageActiveAt = 0;
const PAGE_ON_MS = 8000;
const wakes = new Set();

function pageOn(now) {
    return pageActiveAt > 0 && now - pageActiveAt < PAGE_ON_MS;
}

function notePageActive(flag, now) {
    if (flag === '1') pageActiveAt = now;
    else if (flag === '0') pageActiveAt = 0;
}

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
    if (session.startWanted) return true;
    if (session.leaveWanted) return true;
    if (session.reloadWanted) return true;
    if (typeof session.greetingWanted === 'string' && session.greetingWanted !== session.greeting) return true;
    if (typeof session.notifyWanted === 'string' && session.notifyWanted) return true;
    if (typeof session.titleWanted === 'string') return true;
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

function composerAlert(tabId, currentId, tail, prevTail, ready) {
    if (!ready || !tail || !tabId || tabId === currentId) return false;
    return prevTail === undefined || tail !== prevTail;
}

function themTailId(messages) {
    const ms = messages || [];
    for (let i = ms.length - 1; i >= 0; i--) {
        if (ms[i] && !ms[i].mine && ms[i].id) return String(ms[i].id);
    }
    return '';
}

function ownEchoPlan(prev, next, pending) {
    function same(a, b) {
        return !!(a && b && a.id && a.id === b.id
            && String(a.text || '') === String(b.text || '')
            && !!a.mine === !!b.mine
            && String(a.image || '') === String(b.image || '')
            && String(a.quote || '') === String(b.quote || ''));
    }
    function leftover(list) {
        const prevIds = {};
        (prev || []).forEach(m => { if (m && m.id) prevIds[m.id] = true; });
        const fresh = [];
        (next || []).forEach(m => {
            if (m && m.mine && !m.image && m.id && !prevIds[m.id]) fresh.push(m);
        });
        const rest = [];
        let j = 0;
        (list || []).forEach(text => {
            if (fresh[j] && fresh[j].text === text) j += 1;
            else rest.push(text);
        });
        return rest;
    }
    const q = (pending || []).slice();
    const added = [];
    const times = [];
    let i = 0;
    const prevMs = prev || [];
    for (const m of next || []) {
        const old = prevMs[i];
        if (same(old, m)) {
            if (String(old.time || '') !== String(m.time || '') && m.time) times.push(m);
            i += 1;
            continue;
        }
        if (m && m.mine && !m.image && q.length && m.text === q[0]) {
            added.push(m);
            q.shift();
            continue;
        }
        return { redraw: true, added: [], rest: leftover(pending), times: [] };
    }
    if (i !== prevMs.length) return { redraw: true, added: [], rest: leftover(pending), times: [] };
    return { redraw: false, added, rest: q, times };
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
  .shell { --menu-item:calc(16px * 1.35 * 3); display:flex; height:100%; }
  #nav { width:208px; flex:none; display:flex; flex-direction:column; align-items:stretch; border-right:1px solid #333; background:#0e0e0e; }
  #nav button { position:relative; flex:none; box-sizing:border-box; height:var(--menu-item); display:flex; align-items:center; justify-content:center; border:none; border-bottom:1px solid #333; background:transparent; color:#888; font-size:16px; font-weight:700; line-height:1.35; cursor:pointer; padding:0 12px; }
  #nav button.on { color:#eee; background:#1c1c1c; box-shadow:inset 4px 0 #4CAF50; }
  #nav .dot { top:8px; right:12px; }
  #rail { width:220px; flex:none; overflow:auto; border-right:1px solid #333; background:#111; padding-top:8px; }
  body.users #rail, body.faces #rail { display:none; }
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
  @media (min-width:761px) {
    body.people-list .topbar, body.face-list .topbar { display:none; }
  }
  @media (max-width:760px) {
    #nav, #rail { position:fixed; left:0; width:min(280px, 86vw); transform:translateX(-110%); transition:transform .18s ease; }
    #nav { z-index:21; top:0; height:auto; }
    #rail { z-index:20; top:calc(var(--menu-item) * 4); bottom:0; }
    body.rail-open #nav, body.rail-open #rail { transform:none; }
    body.rail-open #shade { display:block; }
    .topbar .rail-btn { display:flex; }
    #rail { display:none; }
  }
  .pick-list { display:flex; flex-direction:column; gap:4px; }
  .pick-list .card { position:relative; box-sizing:border-box; margin:0; padding:8px 10px; }
  .pick-list .card.on { background:#1e3326; border-color:#2d5a3d; }
  .pick-list .card.has-face { display:flex; align-items:center; gap:8px; }
  .pick-list .card.has-face .face-box { flex:none; width:calc(2lh + 2px); height:calc(2lh + 2px); }
  .pick-list .card.has-face .face { width:100%; height:100%; }
  .pick-list .card.has-face .card-body { flex:1; min-width:0; }
  .pick-list .card small { margin-top:2px; }
  .pick-list .card .dot { top:6px; right:8px; }
  .pick-list .talk { position:relative; }
  .pick-list .talk .card { width:100%; }
  .pick-list .talk .who { min-height:22px; padding-right:26px; }
  .pick-list .talk .who span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pick-list .bin { position:absolute; top:4px; right:8px; z-index:2; width:22px; height:22px; padding:0; border:none; background:transparent; color:#e53935; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .pick-list .muted { margin:8px 4px; }
  .board .pager { display:flex; align-items:center; justify-content:center; gap:12px; padding:4px 0 12px; }
  .board .pager button { padding:6px 12px; border:1px solid #444; border-radius:8px; background:#1c1c1c; color:#eee; cursor:pointer; }
  .board .pager button:disabled { opacity:0.4; }
  .board .pager span { color:#aaa; font-size:13px; }
  body.locked { overflow:auto; }
  body.locked .shell, body.locked #shade { display:none; }
  .topbar { position:relative; flex:none; z-index:6; display:flex; justify-content:space-between; height:48px; background:#111; border-bottom:1px solid #333; }
  .topbar .card { margin:0; border-radius:0; flex:1; border-left:none; border-right:none; }
  .topbar .gear { position:relative; z-index:1; flex:none; width:auto; height:48px; padding:0 12px; border-radius:0; border:1px solid #333; background:#1c1c1c; cursor:pointer; }
  .topbar .gear.menu { width:48px; padding:0; }
  .topbar .end { margin-left:auto; }
  .topbar .ver { position:relative; z-index:2; margin-left:auto; align-self:center; padding:0 12px 0 8px; color:#888; font-size:12px; white-space:nowrap; }
  .topbar .end + .ver { margin-left:0; }
  .topbar:has(.ver) .who { padding-right:96px; }
  .topbar:has(.del):has(.ver) .who { padding-right:156px; }
  .topbar .who { position:absolute; left:0; right:0; top:0; height:48px; display:flex; align-items:center; justify-content:center; gap:8px; padding:0 72px; pointer-events:none; overflow:hidden; }
  .topbar .back { position:relative; z-index:2; display:flex; align-items:center; height:48px; padding:0 14px; border:none; border-right:1px solid #333; background:#1c1c1c; color:#eee; font-weight:700; cursor:pointer; }
  .topbar:has(.back) .who { padding-left:108px; }
  .topbar:has(.back) .who { padding-left:108px; }
  .topbar .who span { min-width:0; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .topbar .who .face { width:1em; height:1em; }
  .topbar .del { background:#e53935; border-color:#e53935; color:#fff; }
  main { flex:1; min-height:0; overflow:auto; padding:12px; }
  main.thread { display:flex; flex-direction:column; }
  main.thread::before { content:""; flex:1 0 auto; }
  main.thread > * { flex:none; }
  button, input { font:inherit; color:#eee; }
  .card, .msg { background:#1c1c1c; border:1px solid #333; border-radius:10px; }
  .card { display:block; width:100%; text-align:left; padding:12px; margin:0 0 8px; cursor:pointer; }
  #rail .card { position:relative; width:calc(100% - 16px); box-sizing:border-box; margin:0 8px 4px; padding:4px 8px; }
  #rail .card.has-face { display:flex; align-items:center; gap:8px; }
  #rail .card.has-face .face-box { flex:none; width:calc(2lh + 2px); height:calc(2lh + 2px); }
  #rail .card.has-face .face { width:100%; height:100%; }
  #rail .card.has-face .card-body { flex:1; min-width:0; }
  #rail .card small { margin-top:2px; }
  .rail-btn { position:relative; }
  .dot { position:absolute; width:8px; height:8px; border-radius:50%; background:#e53935; }
  .rail-btn .dot { top:8px; right:8px; }
  #rail .card .dot { top:6px; right:8px; }
  .card small { display:block; color:#aaa; margin-top:4px; }
  .card small.preview { display:flex; gap:8px; align-items:baseline; color:#ffb74d; }
  .card small.preview .preview-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .card small.preview .preview-time { flex:none; color:#888; white-space:nowrap; }
  .card small.preview.mine { color:#9ccc65; }
  .new-msg { position:absolute; left:50%; bottom:72px; transform:translateX(-50%); z-index:7; padding:6px 14px; border:none; border-radius:16px; background:#ffb74d; color:#111; font-size:13px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35); }
  .jump-room { position:absolute; left:16px; bottom:72px; z-index:7; max-width:calc(100% - 32px); height:40px; padding:0 14px 0 8px; border:none; border-radius:20px; background:#ffb74d; color:#111; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35); display:flex; align-items:center; gap:2px; }
  .jump-room span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
  .toast { position:fixed; left:50%; bottom:88px; transform:translateX(-50%); z-index:50; max-width:min(420px, calc(100% - 32px)); padding:10px 14px; border-radius:10px; background:#333; color:#eee; font-size:14px; text-align:center; box-shadow:0 2px 10px rgba(0,0,0,.45); pointer-events:none; }
  .bubble { display:flex; margin:0 0 8px; }
  .bubble.mine { justify-content:flex-end; }
  .bubble.them { justify-content:flex-start; }
  .talk-find { position:sticky; top:0; z-index:2; width:100%; box-sizing:border-box; margin:0 0 8px; padding:10px 12px; border:1px solid #444; border-radius:8px; background:#1a1a1a; color:#eee; font-size:16px; }
  #rail .talk-find { width:calc(100% - 16px); margin:0 8px 8px; }
  .hit-strip { flex:none; display:flex; gap:6px; overflow:auto; padding:8px 10px; background:#161616; border-bottom:1px solid #333; }
  .hit-strip button { flex:none; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:6px 10px; border:1px solid #444; border-radius:8px; background:#1c1c1c; color:#eee; cursor:pointer; }
  .bubble.find .msg, .end-note.find { box-shadow:inset 3px 0 #ffb74d; }
  .bubble.mark .msg, .end-note.mark { box-shadow:0 0 0 2px #ffb74d; }
  .bubble .msg { max-width:78%; margin:0; }
  .bubble.mine .msg { background:#2d5a3d; border-color:#2d5a3d; }
  .bubble.them .msg { background:#2d2d3d; }
  .msg { padding:8px 10px; white-space:pre-wrap; word-break:break-word; }
  .quote { font-size:12px; color:rgba(255,255,255,.7); border-left:2px solid rgba(255,255,255,.35); padding-left:6px; margin-bottom:6px; }
  .quote.jump { cursor:pointer; }
  .msg img.pic { display:block; max-width:100%; max-height:240px; border-radius:6px; margin-top:6px; cursor:pointer; }
  #zoom.pic { padding:0; }
  #zoom.pic img { width:auto; height:auto; max-width:100%; max-height:100%; object-fit:contain; min-width:0; min-height:0; }
  .time { display:block; margin-top:4px; font-size:11px; color:rgba(255,255,255,.55); }
  form { position:relative; flex:none; display:flex; gap:8px; padding:10px; background:#111; border-top:1px solid #333; }
  form input { flex:1; padding:10px; border-radius:8px; border:1px solid #444; background:#1a1a1a; }
  form input.glow { animation:composer-glow 2s ease-out; }
  @keyframes composer-glow { 0% { box-shadow:0 0 0 0 rgba(255,183,77,0); } 40% { box-shadow:0 0 12px 3px rgba(255,183,77,.9); } 100% { box-shadow:0 0 0 0 rgba(255,183,77,0); } }
  form input[type=file] { display:none; }
  form button { padding:10px 14px; border:none; border-radius:8px; background:#4CAF50; cursor:pointer; }
  form button:disabled { opacity:0.45; }
  .queued { flex:none; margin:0; padding:8px 12px; border-top:1px solid #6a5420; background:#2a2416; color:#ffb74d; font-size:13px; }
  .queued div { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .queued button { margin-top:8px; padding:6px 12px; border:none; border-radius:8px; background:#333; color:#eee; cursor:pointer; }
  .filter-toggle { display:flex; align-items:center; color:#888; }
  .open .filter-toggle { flex-direction:row; gap:8px; margin-top:8px; }
  main:has(.people-pane) { display:flex; flex-direction:column; padding:0; overflow:hidden; }
  .people-pane { flex:1; min-height:0; display:flex; flex-direction:column; }
  .people-pane .find { flex:0 0 auto; max-height:25%; box-sizing:border-box; overflow:auto; display:flex; flex-direction:column; gap:12px; padding:16px 20px; border-bottom:1px solid #333; background:#141414; }
  .people-pane .find-title { font-size:13px; font-weight:700; color:#888; }
  .people-pane .find input, .people-pane .find select { width:100%; box-sizing:border-box; padding:12px; border:1px solid #444; border-radius:8px; background:#1a1a1a; color:#eee; font-size:16px; }
  .people-pane .find-row { display:flex; align-items:center; gap:8px; }
  .people-pane .find-row select { flex:1; }
  .people-pane .find-row span { flex:none; color:#888; font-size:13px; }
  .people-pane .pager { flex:none; display:flex; align-items:center; justify-content:center; gap:12px; padding:8px 12px; border-bottom:1px solid #333; background:#141414; }
  .people-pane .pager button { padding:6px 12px; border:1px solid #444; border-radius:8px; background:#1c1c1c; color:#eee; cursor:pointer; }
  .people-pane .pager button:disabled { opacity:0.4; }
  .people-pane .pager span { color:#aaa; font-size:13px; }
  .people-pane .sheet { flex:1; min-height:0; overflow:auto; }
  .people-pane table { width:100%; min-width:720px; border-collapse:collapse; }
  .people-pane th, .people-pane td { text-align:left; padding:8px 10px; border-bottom:1px solid #2a2a2a; vertical-align:middle; }
  .people-pane th { position:sticky; top:0; background:#161616; color:#aaa; font-weight:600; }
  .people-pane tr { cursor:pointer; }
  .people-pane tr.on td { background:#1e3326; }
  .people-pane .face { width:32px; height:32px; }
  .people-pane button.link { border:none; background:transparent; padding:0; color:#eee; cursor:pointer; text-align:left; }
  .people-pane td.uid { font-size:12px; color:#aaa; word-break:break-all; }
  .people-pane .muted { margin:16px; }
  .face-pane table { min-width:0; }
  .face-pane tr { cursor:default; }
  .gate { display:flex; flex-direction:column; gap:8px; }
  .muted { color:#888; }
  .end-note { margin:14px 0; color:#888; font-size:13px; text-align:center; }
  .who { display:flex; gap:10px; align-items:center; }
  .face { width:40px; height:40px; border-radius:50%; object-fit:cover; background:#333; flex:none; }
  svg.face { display:block; fill:#9a9a9a; }
  .open { display:flex; gap:12px; align-items:center; margin:0 0 12px; }
  .open .meta { min-width:0; }
  .open .name { cursor:pointer; }
  .open .uid { word-break:break-all; font-size:12px; color:#888; }
  .open .face { width:64px; height:64px; }
  .face.zoomable { cursor:pointer; }
  #zoom { position:fixed; inset:0; z-index:40; border:none; padding:24px; background:rgba(0,0,0,.86); display:flex; align-items:center; justify-content:center; }
  #zoom .face { width:min(86vw, 420px); height:min(86vw, 420px); border-radius:16px; object-fit:contain; background:transparent; }
  .group { margin-left:auto; flex:none; display:flex; }
  .group button { width:36px; height:36px; padding:0; border:1px solid #666; background:transparent; color:#eee; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .group button svg { width:18px; height:18px; display:block; }
  .group button.on { background:#e53935; color:#fff; border-color:#e53935; }
  .group button:first-child { border-radius:8px 0 0 8px; }
  .group button:last-child { border-radius:0 8px 8px 0; }
  .group button:only-child { border-radius:8px; }
  .group button + button { border-left:1px solid rgba(0,0,0,.2); }
  .ctrl { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; box-sizing:border-box; text-align:left; padding:10px 12px; margin:0 0 8px; background:#1c1c1c; border:1px solid #333; border-radius:10px; cursor:pointer; }
  .extra { display:flex; flex-direction:column; gap:8px; margin:-2px 0 8px; }
  .extra input { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #444; border-radius:8px; background:#1a1a1a; color:#eee; }
  .extra button { padding:8px 12px; border:none; border-radius:8px; background:#2d4a6d; color:#eee; cursor:pointer; }
  .pick { display:flex; align-items:center; gap:8px; color:#eee; cursor:pointer; }
  .pick input { width:18px; height:18px; margin:0; accent-color:#eee; }
  .hours { display:flex; align-items:center; gap:6px; color:#aaa; }
  .hours input { width:72px; }
  .sw { width:40px; height:22px; border:none; padding:0; border-radius:11px; background:#555; position:relative; flex:none; cursor:pointer; }
  .sw.on { background:#4CAF50; }
  .sw i { width:18px; height:18px; border-radius:50%; background:#fff; position:absolute; top:2px; left:2px; pointer-events:none; }
  .sw.on i { left:20px; }
  .menu-dock { position:absolute; left:8px; bottom:8px; z-index:8; display:flex; flex-direction:column-reverse; align-items:flex-start; max-height:calc(100% - 16px); pointer-events:none; }
  .menu-dock > * { pointer-events:auto; }
  .menu-dock > .gear { width:48px; height:48px; padding:0; border-radius:10px; border:1px solid #333; background:#1c1c1c; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .menu-dock > .gear.on { background:#2a2a2a; border-color:#666; }
  .menu-dock .ctrl.on { border-color:#666; }
  .menu-dock .sheet { display:flex; flex-direction:column-reverse; align-items:stretch; gap:8px; width:min(300px, calc(100vw - 24px)); max-height:calc(100vh - 120px); overflow:auto; margin-bottom:8px; padding:8px; box-sizing:border-box; background:#161616; border:1px solid #333; border-radius:12px; }
  .menu-dock .ctrl, .menu-dock .extra { margin:0; }
  .stage:has(.menu-dock) form { padding-left:64px; }
  .phone-alert { position:absolute; left:8px; right:8px; top:56px; z-index:12; display:flex; flex-direction:column; gap:6px; padding:10px 12px; background:#3a2416; border:1px solid #e53935; border-radius:10px; color:#eee; }
  .phone-alert strong { font-size:14px; }
  .phone-alert p { margin:0; color:#ffccbc; font-size:13px; white-space:pre-wrap; word-break:break-word; }
  .phone-alert button { align-self:flex-end; padding:6px 12px; border:none; border-radius:8px; background:#e53935; color:#fff; cursor:pointer; }
</style>
</head>
<body>
<div class="shell">
<nav id="nav"></nav>
<aside id="rail"></aside>
<div class="stage" id="stage">
<main id="app"></main>
</div>
</div>
<button type="button" id="shade" aria-label="關閉列表"></button>
<script>
` + themTailId.toString() + '\n' + ownEchoPlan.toString() + '\n' + composerAlert.toString() + '\n' + faceRows.toString() + '\n' + liveRank.toString() + '\n' + quoteKey.toString() + '\n' + quoteTargets.toString() + `
const TOKEN_KEY = 'knockRelayPageToken';
const app = document.getElementById('app');
const nav = document.getElementById('nav');
const rail = document.getElementById('rail');
const stage = document.getElementById('stage');
app.addEventListener('click', () => { if (jumpTab) hideJump(); });
document.addEventListener('click', (e) => {
  if (!showControls) return;
  if (e.target.closest('.menu-dock, .phone-alert')) return;
  showControls = false;
  paint();
});
let token = localStorage.getItem(TOKEN_KEY) || '';
let current = '';
let menu = 'chats';
let archiveUid = '';
let archiveTalk = null;
let archiveUpdated = 0;
let archiveLoading = '';
let sessions = [];
let talks = [];
let people = [];
let peopleQuery = '';
let peopleSort = 'first';
let peopleFilter = 'all';
let peopleFindFocus = false;
let peopleFindAt = 0;
let peopleScroll = 0;
let peopleScrollX = 0;
let peoplePage = 0;
const PEOPLE_PAGE = 50;
let talksPage = 0;
const TALKS_PAGE = 50;
let keepBoardScroll = false;
let talkQuery = '';
let talkHits = null;
let talkFindFocus = false;
let talkFindAt = 0;
let talkSearchTimer = 0;
let talkJumpKey = '';
let faceScroll = 0;
let userOpen = false;
let archiveMissing = '';
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
let controlHost = null;
let phoneAlerts = [];
let keepOpen = false;
let notifyOpen = false;
let filterOpen = false;
let openerOpen = false;
let controlDraft = null;
let avatarDraft = null;
let userDraft = null;
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
  if (s.lobby) return '';
  if (s.status === 'left') return '對方已離開對話';
  if (!s.canType) return '現在不能回';
  return '';
}

let toastTimer = 0;
function toast(text) {
  const msg = String(text || '失敗').trim() || '失敗';
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (el.isConnected) el.remove(); }, 2800);
}

function paintPhoneAlert() {
  const sig = phoneAlerts.map(a => a.id + ' ' + a.reason).join(' | ');
  const existing = document.querySelector('.phone-alert');
  if (existing && existing.dataset.sig === sig) return;
  document.querySelectorAll('.phone-alert').forEach(el => el.remove());
  if (!token || !phoneAlerts.length) return;
  const box = document.createElement('div');
  box.className = 'phone-alert';
  box.dataset.sig = sig;
  const title = document.createElement('strong');
  title.textContent = '手機通知沒送出';
  box.append(title);
  phoneAlerts.forEach(a => {
    const line = document.createElement('p');
    line.textContent = a.reason || '送出失敗';
    box.append(line);
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '知道了';
  const ids = phoneAlerts.map(a => a.id);
  btn.onclick = () => {
    api('/api/phone-alerts/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids })
    }).then(() => {
      phoneAlerts = phoneAlerts.filter(a => ids.indexOf(a.id) < 0);
      paintPhoneAlert();
    }).catch(err => toast(err.message || '沒關掉'));
  };
  box.append(btn);
  stage.append(box);
}

function paintQueued() {
  document.querySelectorAll('.queued').forEach(el => el.remove());
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
    toast('刪除失敗');
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
  archiveMissing = '';
  api('/api/talks/' + encodeURIComponent(uid)).then(data => {
    if (archiveUid !== uid) return;
    archiveTalk = data.talk || null;
    archiveUpdated = archiveTalk ? archiveTalk.updated : 0;
    archiveMissing = archiveTalk ? '' : uid;
    paint();
  }).catch(() => {
    if (archiveUid !== uid) return;
    archiveTalk = null;
    archiveMissing = uid;
    paint();
  }).finally(() => {
    if (archiveLoading === uid) archiveLoading = '';
  });
}

function glyph(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
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

function leftIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M15.4 7.4L14 6l-6 6 6 6 1.4-1.4L10.8 12z');
  svg.append(path);
  return svg;
}

function closeRail() { document.body.classList.remove('rail-open'); }

const roomUnread = {};
const roomTail = {};
const pendingMine = {};
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
  let alertId = '';
  for (const s of list) {
    alive[s.tabId] = true;
    const tail = themTailId(s.messages);
    const prev = roomTail[s.tabId];
    if (s.waiting) {
      if (prev === undefined) roomTail[s.tabId] = tail;
      delete roomUnread[s.tabId];
      continue;
    }
    if (composerAlert(s.tabId, current, tail, prev, roomTailReady)) alertId = s.tabId;
    if (!roomTailReady || prev === undefined) {
      roomTail[s.tabId] = tail;
      if (roomTailReady && tail && s.tabId !== current) roomUnread[s.tabId] = true;
      continue;
    }
    if (tail === prev) continue;
    roomTail[s.tabId] = tail;
    if (s.tabId === current || !tail) delete roomUnread[s.tabId];
    else roomUnread[s.tabId] = true;
  }
  roomTailReady = true;
  for (const id in roomUnread) if (!alive[id]) delete roomUnread[id];
  return alertId;
}

let jumpTab = '';

function hideJump() {
  jumpTab = '';
  const btn = document.querySelector('.jump-room');
  if (btn) btn.remove();
}

function glowInput() {
  const input = document.querySelector('form input:not([type=file])');
  if (!input || input.dataset.kind === 'phase') return;
  input.classList.remove('glow');
  void input.offsetWidth;
  input.classList.add('glow');
}

function jumpLine(tabId) {
  const s = sessions.find(x => x.tabId === tabId);
  const last = s && s.messages && s.messages[s.messages.length - 1];
  if (!last) return '';
  return String(last.text || (last.image ? '圖片' : last.quote || '')).trim();
}

function showJump(tabId) {
  const input = document.querySelector('form input:not([type=file])');
  if (!tabId || !input || input.dataset.kind === 'phase') return;
  jumpTab = tabId;
  const line = jumpLine(tabId);
  let btn = document.querySelector('.jump-room');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jump-room';
    btn.append(leftIcon(), document.createElement('span'));
    btn.onclick = () => {
      const id = jumpTab;
      const s = sessions.find(x => x.tabId === id);
      hideJump();
      if (!s) return;
      showControls = false;
      archiveUid = '';
      archiveTalk = null;
      if (current !== s.tabId) dropPending(current);
      current = s.tabId;
      delete roomUnread[s.tabId];
      stickBottom = true;
      closeRail();
      paint();
    };
    stage.append(btn);
  }
  btn.querySelector('span').textContent = line;
  btn.setAttribute('aria-label', line ? '前往新訊息：' + line : '前往新訊息');
}

function paintBar(title, end, avatar, onRename) {
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
  if (avatar) who.append(faceNode(avatar, true));
  const whoText = document.createElement('span');
  whoText.textContent = title || 'Knock 遠端';
  if (onRename) {
    whoText.title = '修改命名';
    whoText.style.pointerEvents = 'auto';
    whoText.style.cursor = 'pointer';
    whoText.onclick = (e) => {
      e.stopPropagation();
      const shown = whoText.textContent === '未命名' ? '' : whoText.textContent;
      const next = prompt('替這位命名。空白表示清除。', shown);
      if (next == null) return;
      onRename(next.trim().slice(0, 40));
    };
  }
  who.append(whoText);
  const back = phoneBack();
  if (back) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'back';
    btn.textContent = '返回';
    btn.onclick = back;
    bar.append(btn, who);
  } else bar.append(railBtn, who);
  if (end && end.dataset.side === '1') who.style.paddingRight = '120px';
  if (end) bar.append(end);
  const mark = scriptMark();
  if (mark) bar.append(mark);
  stage.insertBefore(bar, app);
}

function scriptMark() {
  let best = '';
  let bestSeen = -1;
  sessions.forEach(s => {
    if (!s || !s.script) return;
    if (current && s.tabId === current) {
      best = s.script;
      bestSeen = Infinity;
      return;
    }
    const seen = Number(s.seen) || 0;
    if (seen < bestSeen) return;
    best = s.script;
    bestSeen = seen;
  });
  if (!best) return null;
  const el = document.createElement('span');
  el.className = 'ver';
  el.textContent = best;
  return el;
}

function controlsGear() {
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'gear menu';
  gear.setAttribute('aria-label', '控制');
  gear.append(barsIcon());
  gear.onclick = () => { showControls = !showControls; paint(); };
  return gear;
}

function paintDock() {
  document.querySelectorAll('.menu-dock').forEach(el => el.remove());
  if (menu !== 'chats' || !current || archiveUid) return;
  const dock = document.createElement('div');
  dock.className = 'menu-dock';
  const gear = controlsGear();
  if (showControls) gear.classList.add('on');
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  if (showControls) {
    controlHost = sheet;
    paintControls();
    controlHost = null;
  }
  dock.append(gear);
  if (showControls) dock.append(sheet);
  stage.append(dock);
}

function byRecent(a, b) {
  const rank = liveRank(b) - liveRank(a);
  if (rank) return rank;
  return lastMessageAt(b) - lastMessageAt(a) || (b.seen || 0) - (a.seen || 0) || (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0);
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
  const body = document.createElement('div');
  body.className = 'card-body';
  body.append(name, sub);
  if (s.openings && s.openings.avatar) {
    btn.classList.add('has-face');
    const box = document.createElement('span');
    box.className = 'face-box';
    box.append(faceNode(s.openings.avatar));
    btn.append(box);
  }
  btn.append(body);
  if (roomUnread[s.tabId]) {
    name.style.paddingRight = '14px';
    btn.append(redDot());
  }
  const extra = statusText(s);
  if (extra) {
    const st = document.createElement('small');
    st.textContent = extra;
    body.append(st);
  }
  btn.onclick = () => {
    showControls = false;
    archiveUid = '';
    archiveTalk = null;
    if (current !== s.tabId) dropPending(current);
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
  label.textContent = t.sample || ((t.count || 0) + ' 則');
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
    dropPending(current);
    current = '';
    stickBottom = !String(talkQuery || '').trim();
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

function phoneLayout() {
  return window.matchMedia('(max-width:760px)').matches;
}

function phoneBack() {
  if (!phoneLayout()) return null;
  if (menu === 'chats' && showControls && current) return () => { showControls = false; paint(); };
  if (menu === 'chats' && current) return () => { leavePhoneChat(); };
  if (menu === 'talks' && archiveUid) return () => {
    archiveUid = '';
    archiveTalk = null;
    archiveMissing = '';
    app.scrollTop = 0;
    paint();
  };
  return null;
}

function leavePhoneChat() {
  dropPending(current);
  current = '';
  showControls = false;
  app.scrollTop = 0;
  paint();
}

function menuBtn(key, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  if (menu === key) btn.className = 'on';
  if (key === 'chats' && unreadLeft()) btn.append(redDot());
  btn.onclick = () => {
    const phoneList = phoneLayout() && (key === 'chats' || key === 'talks');
    if (menu === key && !phoneList) return;
    if (menu === 'chats' && (key !== 'chats' || phoneList)) dropPending(current);
    if (phoneList && key === 'chats') current = '';
    const entered = menu !== key;
    menu = key;
    showControls = false;
    userOpen = false;
    if (key === 'chats') {
      archiveUid = '';
      archiveTalk = null;
      archiveMissing = '';
    }
    if (key === 'talks') {
      if (entered) talksPage = 0;
      if (phoneLayout()) {
        archiveUid = '';
        archiveTalk = null;
        archiveMissing = '';
      }
    }
    if (phoneList) app.scrollTop = 0;
    closeRail();
    paint();
  };
  return btn;
}

function renameTalk(uid, title) {
  api('/api/talks/' + encodeURIComponent(uid) + '/title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title })
  }).then(data => {
    const shown = data.title || '未命名';
    if (archiveTalk && archiveTalk.uid === uid) archiveTalk.title = shown;
    const row = talks.find(t => t.uid === uid);
    if (row) row.title = shown;
    const person = people.find(x => x.uid === uid);
    if (person) person.title = shown;
    sessions.forEach(s => { if (s.partnerUid === uid) s.title = shown; });
    paint();
  }).catch(err => toast(err.message || '命名失敗'));
}

function askRename(uid, shown) {
  const next = prompt('替這位命名。空白表示清除。', shown === '未命名' ? '' : shown);
  if (next == null || !uid) return;
  renameTalk(uid, next.trim().slice(0, 40));
}

let filterToggleUid = '';
let filterToggleAt = 0;

function paintUserSwitch(sw, on) {
  sw.className = 'sw' + (on ? ' on' : '');
  sw.title = on ? '已在過濾名單，再點移除' : '把這個 id 列入過濾';
}

function setUserFilter(p, on, sw) {
  if (!p || !p.uid) return;
  const now = Date.now();
  if (filterToggleUid === p.uid && now - filterToggleAt < 500) return;
  filterToggleUid = p.uid;
  filterToggleAt = now;
  const prev = !!p.filtered;
  p.filtered = !!on;
  if (sw) paintUserSwitch(sw, p.filtered);
  api('/api/filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(on ? { addUsers: [{ u: p.uid, t: '', a: '' }] } : { removeUsers: [{ u: p.uid, t: '', a: '' }] })
  }).catch(err => {
    p.filtered = prev;
    filterToggleAt = 0;
    filterToggleUid = '';
    if (sw && sw.isConnected) paintUserSwitch(sw, prev);
    toast(err.message || '設定失敗');
  });
}

function filterSwitch(p, bare) {
  const wrap = document.createElement('span');
  wrap.className = 'filter-toggle';
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'sw' + (p.filtered ? ' on' : '');
  sw.title = p.filtered ? '已在過濾名單，再點移除' : '把這個 id 列入過濾';
  sw.append(document.createElement('i'));
  sw.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setUserFilter(p, !p.filtered, sw);
  };
  wrap.onclick = (e) => e.stopPropagation();
  if (!bare) {
    const cap = document.createElement('span');
    cap.textContent = '過濾使用者';
    wrap.append(cap);
  }
  wrap.append(sw);
  return wrap;
}

function openPerson(p) {
  const prev = document.querySelector('.people-pane .sheet');
  if (prev) peopleScroll = prev.scrollTop;
  showControls = false;
  dropPending(current);
  current = '';
  userOpen = true;
  archiveUid = p.uid;
  archiveTalk = null;
  archiveUpdated = 0;
  archiveMissing = talks.some(t => t.uid === p.uid) ? '' : p.uid;
  stickBottom = true;
  closeRail();
  paint();
  if (!archiveMissing) loadArchive(p.uid);
}

function peopleRank(list) {
  const q = peopleQuery.trim().toLowerCase();
  const rows = [];
  (list || []).forEach(p => {
    if (peopleFilter === 'on' && !p.filtered) return;
    if (peopleFilter === 'off' && p.filtered) return;
    const name = String(p.title || '').toLowerCase();
    const uid = String(p.uid || '').toLowerCase();
    if (q && name.indexOf(q) < 0 && uid.indexOf(q) < 0) return;
    rows.push(p);
  });
  rows.sort((a, b) => {
    if (peopleSort === 'meets') return (b.meets || 0) - (a.meets || 0) || (b.firstAt || 0) - (a.firstAt || 0);
    if (peopleSort === 'count') return (b.count || 0) - (a.count || 0) || (b.firstAt || 0) - (a.firstAt || 0);
    return (b.firstAt || 0) - (a.firstAt || 0) || (a.uid < b.uid ? -1 : 1);
  });
  return rows;
}

function peopleWindow(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / PEOPLE_PAGE));
  if (peoplePage > pages - 1) peoplePage = pages - 1;
  if (peoplePage < 0) peoplePage = 0;
  const start = peoplePage * PEOPLE_PAGE;
  return { rows: rows.slice(start, start + PEOPLE_PAGE), page: peoplePage, pages: pages, total: rows.length };
}

function peoplePager(view) {
  const bar = document.createElement('div');
  bar.className = 'pager';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.textContent = '上一頁';
  prev.disabled = view.page <= 0;
  prev.onclick = () => { peoplePage = view.page - 1; peopleScroll = 0; paint(); };
  const label = document.createElement('span');
  label.textContent = (view.page + 1) + ' / ' + view.pages;
  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = '下一頁';
  next.disabled = view.page + 1 >= view.pages;
  next.onclick = () => { peoplePage = view.page + 1; peopleScroll = 0; paint(); };
  bar.append(prev, label, next);
  return bar;
}

function peopleFind(picked) {
  const box = document.createElement('div');
  box.className = 'find';
  const title = document.createElement('div');
  title.className = 'find-title';
  title.textContent = '篩選';
  const input = document.createElement('input');
  input.id = 'people-find';
  input.placeholder = '名稱或 id';
  input.value = peopleQuery;
  input.addEventListener('compositionstart', () => { input.dataset.composing = '1'; });
  input.addEventListener('compositionend', () => {
    delete input.dataset.composing;
    peopleQuery = input.value;
    peoplePage = 0;
    peopleScroll = 0;
    paint();
  });
  input.oninput = () => {
    peopleQuery = input.value;
    peopleFindFocus = true;
    if (input.dataset.composing) return;
    peoplePage = 0;
    peopleScroll = 0;
    paint();
  };
  input.onfocus = () => { peopleFindFocus = true; };
  input.onblur = () => { peopleFindFocus = false; };
  const row = document.createElement('div');
  row.className = 'find-row';
  const count = document.createElement('span');
  count.textContent = picked.length + ' 人';
  const sort = document.createElement('select');
  [['first', '第一次'], ['meets', '遇到次數'], ['count', '對話量']].forEach(pair => {
    const opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    if (peopleSort === pair[0]) opt.selected = true;
    sort.append(opt);
  });
  sort.onchange = () => { peopleSort = sort.value; peoplePage = 0; peopleScroll = 0; paint(); };
  const filt = document.createElement('select');
  [['all', '全部'], ['on', '已過濾'], ['off', '未過濾']].forEach(pair => {
    const opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    if (peopleFilter === pair[0]) opt.selected = true;
    filt.append(opt);
  });
  filt.onchange = () => { peopleFilter = filt.value; peoplePage = 0; peopleScroll = 0; paint(); };
  row.append(count, sort, filt);
  box.append(title, input, row);
  return box;
}

function peopleRow(p) {
  const tr = document.createElement('tr');
  if (p.uid === archiveUid && userOpen) tr.className = 'on';
  const face = document.createElement('td');
  if (p.avatar) face.append(faceNode(p.avatar));
  const name = document.createElement('td');
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'link';
  nameBtn.textContent = p.title || '未命名';
  nameBtn.onclick = (e) => {
    e.stopPropagation();
    askRename(p.uid, p.title || '未命名');
  };
  name.append(nameBtn);
  const id = document.createElement('td');
  id.className = 'uid';
  id.textContent = p.uid;
  const when = document.createElement('td');
  when.textContent = talkClock(p.firstAt) || '沒有時間';
  const meets = document.createElement('td');
  meets.textContent = String(p.meets || 0);
  const count = document.createElement('td');
  count.textContent = String(p.count || 0);
  const flag = document.createElement('td');
  flag.append(filterSwitch(p, true));
  flag.onclick = (e) => e.stopPropagation();
  tr.append(face, flag, count, name, id, when, meets);
  tr.onclick = () => openPerson(p);
  return tr;
}

function peopleTable(rows) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  if (!people.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '還沒有使用者';
    sheet.append(p);
    return sheet;
  }
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '沒有符合的使用者';
    sheet.append(p);
    return sheet;
  }
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  ['', '過濾使用者', '對話量', '名稱', '使用者 id', '第一次', '遇到'].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    hr.append(th);
  });
  head.append(hr);
  const body = document.createElement('tbody');
  rows.forEach(p => body.append(peopleRow(p)));
  table.append(head, body);
  sheet.append(table);
  return sheet;
}

function setFaceFilter(id, on) {
  const touched = [];
  people.forEach(p => {
    if (p.avatar !== id) return;
    touched.push(p);
    p.avatarFiltered = on;
  });
  paint();
  api('/api/filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(on ? { addAvatars: [id] } : { removeAvatars: [id] })
  }).catch(err => {
    touched.forEach(p => { p.avatarFiltered = !on; });
    toast(err.message || '設定失敗');
    paint();
  });
}

function paintFaces() {
  const prev = document.querySelector('.face-pane .sheet');
  if (prev) faceScroll = prev.scrollTop;
  clearForm();
  paintBar('大頭貼過濾');
  const rows = faceRows(people);
  app.replaceChildren();
  const pane = document.createElement('div');
  pane.className = 'people-pane face-pane';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '還沒有記錄到大頭照';
    sheet.append(p);
  } else {
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    ['', '多少人共用', '過濾'].forEach(text => {
      const th = document.createElement('th');
      th.textContent = text;
      hr.append(th);
    });
    head.append(hr);
    const body = document.createElement('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const face = document.createElement('td');
      face.append(faceNode(row.id, true));
      const count = document.createElement('td');
      count.textContent = String(row.count);
      const flag = document.createElement('td');
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'sw' + (row.filtered ? ' on' : '');
      sw.title = row.filtered ? '已在過濾名單，再點移除' : '把這張圖列入過濾';
      sw.append(document.createElement('i'));
      sw.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setFaceFilter(row.id, !row.filtered);
      };
      flag.append(sw);
      tr.append(face, count, flag);
      body.append(tr);
    });
    table.append(head, body);
    sheet.append(table);
  }
  pane.append(sheet);
  app.append(pane);
  sheet.scrollTop = faceScroll;
}

function paintPeople() {
  const prev = document.querySelector('.people-pane .sheet');
  if (prev) {
    peopleScroll = prev.scrollTop;
    peopleScrollX = prev.scrollLeft;
  }
  const keep = document.getElementById('people-find');
  if (peopleFindFocus && keep && document.activeElement === keep) {
    peopleQuery = keep.value;
    const ranked = peopleRank(people);
    const view = peopleWindow(ranked);
    const pane = keep.closest('.people-pane');
    const next = peopleTable(view.rows);
    if (prev && prev.parentNode) prev.replaceWith(next);
    else if (pane) pane.append(next);
    const count = pane && pane.querySelector('.find-row span');
    if (count) count.textContent = view.total + ' 人';
    const oldPager = pane && pane.querySelector('.pager');
    const pager = peoplePager(view);
    if (oldPager) oldPager.replaceWith(pager);
    else if (next.parentNode) next.before(pager);
    next.scrollTop = peopleScroll;
    next.scrollLeft = peopleScrollX;
    return;
  }
  clearForm();
  paintBar('使用者管理');
  const ranked = peopleRank(people);
  const view = peopleWindow(ranked);
  app.replaceChildren();
  const pane = document.createElement('div');
  pane.className = 'people-pane';
  pane.append(peopleFind(ranked), peoplePager(view), peopleTable(view.rows));
  app.append(pane);
  const sheet = pane.querySelector('.sheet');
  if (sheet) {
    sheet.scrollTop = peopleScroll;
    sheet.scrollLeft = peopleScrollX;
  }
  if (!peopleFindFocus) return;
  const el = document.getElementById('people-find');
  if (!el) return;
  el.focus();
  const at = peopleFindAt || 0;
  el.setSelectionRange(at, at);
}

function paintNav() {
  nav.replaceChildren(menuBtn('chats', '對話'), menuBtn('talks', '記錄'), menuBtn('users', '使用者管理'), menuBtn('faces', '大頭貼過濾'));
}

function queueTalkSearch() {
  clearTimeout(talkSearchTimer);
  const q = String(talkQuery || '').trim();
  if (!q) {
    talkHits = null;
    talkJumpKey = '';
    return;
  }
  talkSearchTimer = setTimeout(() => {
    api('/api/talks-search?q=' + encodeURIComponent(q)).then(data => {
      if (String(talkQuery || '').trim() !== q) return;
      talkHits = data.talks || [];
      talksPage = 0;
      app.scrollTop = 0;
      paint();
    }).catch(err => toast(err.message || '搜尋失敗'));
  }, 250);
}

function talkFind() {
  const input = document.createElement('input');
  input.className = 'talk-find';
  input.placeholder = '搜尋對話記錄';
  input.value = talkQuery;
  input.addEventListener('compositionstart', () => { input.dataset.composing = '1'; });
  input.addEventListener('compositionend', () => {
    delete input.dataset.composing;
    talkQuery = input.value;
    talkFindAt = input.selectionStart || talkQuery.length;
    talksPage = 0;
    queueTalkSearch();
    if (!String(talkQuery || '').trim()) paint();
  });
  input.addEventListener('input', () => {
    talkQuery = input.value;
    talkFindAt = input.selectionStart || talkQuery.length;
    if (input.dataset.composing) return;
    talksPage = 0;
    queueTalkSearch();
    if (!String(talkQuery || '').trim()) paint();
  });
  input.addEventListener('focus', () => { talkFindFocus = true; });
  input.addEventListener('blur', () => { talkFindFocus = false; });
  return input;
}

function restoreTalkFind() {
  if (!talkFindFocus) return;
  const el = document.querySelector('.talk-find');
  if (!el) return;
  el.focus();
  const at = talkFindAt || 0;
  el.setSelectionRange(at, at);
}

function shownTalks() {
  if (String(talkQuery || '').trim()) return talkHits || [];
  return talks;
}

function paintRail() {
  const top = rail.scrollTop;
  rail.replaceChildren();
  if (menu === 'talks') {
    rail.append(talkFind());
    const q = String(talkQuery || '').trim();
    const rows = shownTalks();
    if (q && !talkHits) rail.append(railEmpty('搜尋中'));
    else if (!rows.length) rail.append(railEmpty(q ? '沒有符合的記錄' : '還沒有對話記錄'));
    else rows.forEach(t => rail.append(talkCard(t)));
    restoreTalkFind();
    if (q && !talkHits) queueTalkSearch();
  } else {
    const live = sessions.filter(s => !s.waiting).sort(byRecent);
    if (!live.length) rail.append(railEmpty('沒有正在回報的對話'));
    else live.forEach(s => rail.append(liveCard(s)));
  }
  rail.scrollTop = top;
}

function talkWindow(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / TALKS_PAGE));
  if (talksPage > pages - 1) talksPage = pages - 1;
  if (talksPage < 0) talksPage = 0;
  const start = talksPage * TALKS_PAGE;
  return { rows: rows.slice(start, start + TALKS_PAGE), page: talksPage, pages: pages, total: rows.length };
}

function talkPager(view) {
  const bar = document.createElement('div');
  bar.className = 'pager';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.textContent = '上一頁';
  prev.disabled = view.page <= 0;
  prev.onclick = () => { talksPage = view.page - 1; app.scrollTop = 0; paint(); };
  const label = document.createElement('span');
  label.textContent = (view.page + 1) + ' / ' + view.pages + ' · ' + view.total + ' 筆';
  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = '下一頁';
  next.disabled = view.page + 1 >= view.pages;
  next.onclick = () => { talksPage = view.page + 1; app.scrollTop = 0; paint(); };
  bar.append(prev, label, next);
  return bar;
}

function paintLiveBoard() {
  const y = keepBoardScroll ? app.scrollTop : 0;
  keepBoardScroll = false;
  clearForm();
  paintBar('對話');
  app.replaceChildren();
  const list = document.createElement('div');
  list.className = 'pick-list';
  const live = sessions.filter(s => !s.waiting).sort(byRecent);
  if (!live.length) list.append(railEmpty('沒有正在回報的對話'));
  else live.forEach(s => list.append(liveCard(s)));
  app.append(list);
  app.scrollTop = y;
}

function paintTalkBoard() {
  const y = keepBoardScroll ? app.scrollTop : 0;
  keepBoardScroll = false;
  clearForm();
  paintBar('記錄');
  app.replaceChildren();
  const board = document.createElement('div');
  board.className = 'board';
  board.append(talkFind());
  const q = String(talkQuery || '').trim();
  const rows = shownTalks();
  const view = talkWindow(rows);
  if (view.pages > 1) board.append(talkPager(view));
  const list = document.createElement('div');
  list.className = 'pick-list';
  if (q && !talkHits) list.append(railEmpty('搜尋中'));
  else if (!rows.length) list.append(railEmpty(q ? '沒有符合的記錄' : '還沒有對話記錄'));
  else view.rows.forEach(t => list.append(talkCard(t)));
  board.append(list);
  app.append(board);
  app.scrollTop = y;
  restoreTalkFind();
  if (q && !talkHits) queueTalkSearch();
}

function paintArchive(talk, follow, y) {
  clearForm();
  const uid = archiveUid;
  const del = document.createElement('button');
  del.className = 'gear del end';
  del.type = 'button';
  del.textContent = '刪除';
  del.onclick = () => { if (uid) deleteTalk(uid); };
  paintBar((talk && talk.title) || '對話記錄', del, talk && talk.avatar, talk && uid ? (title) => renameTalk(uid, title) : null);
  app.replaceChildren();
  if (!talk) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = archiveMissing === uid ? '對話記錄已刪除' : '正在讀取對話記錄';
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
  app.classList.add('thread');
  paintMessages(messages);
  const hits = talkHitsIn(talk, talkQuery);
  paintHitStrip(hits);
  placeThread({ tabId: 'talk:' + archiveUid, messages }, follow && !hits.length, y);
  const key = archiveUid + ' ' + String(talkQuery || '').trim();
  if (hits.length && talkJumpKey !== key) {
    talkJumpKey = key;
    jumpToMessage(hits[0].id);
  }
}

function talkHitsIn(talk, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle || !talk) return [];
  const hits = [];
  (talk.messages || []).forEach(m => {
    const text = String(m.text || '');
    const quote = String(m.quote || '');
    if ((text + ' ' + quote).toLowerCase().indexOf(needle) < 0) return;
    hits.push({ id: m.id, label: (text || quote || '這則').slice(0, 40) });
  });
  return hits;
}

function messageNode(id) {
  const nodes = app.querySelectorAll('[data-id]');
  for (let i = 0; i < nodes.length; i++) if (nodes[i].dataset.id === id) return nodes[i];
  return null;
}

function jumpToMessage(id) {
  const node = messageNode(id);
  if (!node) return;
  app.querySelectorAll('.mark').forEach(el => el.classList.remove('mark'));
  node.classList.add('mark');
  const appRect = app.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  app.scrollTop += nodeRect.top - appRect.top - (app.clientHeight - nodeRect.height) / 2;
}

function paintHitStrip(hits) {
  document.querySelectorAll('.hit-strip').forEach(el => el.remove());
  if (!hits.length) return;
  hits.forEach(h => {
    const node = messageNode(h.id);
    if (node) node.classList.add('find');
  });
  const strip = document.createElement('div');
  strip.className = 'hit-strip';
  hits.forEach(h => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = h.label;
    btn.onclick = () => jumpToMessage(h.id);
    strip.append(btn);
  });
  stage.insertBefore(strip, app);
}

function paintUser(talk, follow, y) {
  clearForm();
  const uid = archiveUid;
  if (!uid) {
    paintPeople();
    return;
  }
  const person = people.find(p => p.uid === uid) || { uid: uid, title: '未命名', avatar: '', firstAt: 0, filtered: false };
  const title = (talk && talk.title) || person.title || '未命名';
  const avatar = (talk && talk.avatar) || person.avatar;
  paintBar(title, null, avatar, (next) => renameTalk(uid, next));
  const bar = document.querySelector('.topbar');
  const railBtn = bar && bar.querySelector('.rail-btn');
  if (railBtn) railBtn.remove();
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'back';
  back.textContent = '上一頁';
  back.onclick = () => {
    userOpen = false;
    archiveUid = '';
    archiveTalk = null;
    archiveMissing = '';
    paint();
  };
  if (bar) bar.insertBefore(back, bar.firstChild);
  app.replaceChildren();
  const head = document.createElement('div');
  head.className = 'open';
  if (avatar) head.append(faceNode(avatar, true));
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = title;
  name.onclick = () => askRename(uid, name.textContent);
  const idLine = document.createElement('div');
  idLine.className = 'uid';
  idLine.textContent = uid;
  const when = document.createElement('div');
  when.className = 'uid';
  when.textContent = '第一次 ' + (talkClock(person.firstAt) || '沒有時間');
  const stats = document.createElement('div');
  stats.className = 'uid';
  stats.textContent = '遇到 ' + (person.meets || 0) + ' · ' + (person.count || 0) + ' 則';
  meta.append(name, idLine, when, stats, filterSwitch(person));
  head.append(meta);
  app.append(head);
  if (!talk) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = archiveMissing === uid ? '對話記錄已刪除' : '正在讀取';
    app.append(p);
    return;
  }
  const messages = talk.messages || [];
  if (!messages.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '還沒有過去對話';
    app.append(p);
    return;
  }
  paintMessages(messages);
  placeThread({ tabId: 'talk:' + uid, messages }, follow, y);
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
function clearChrome() { document.querySelectorAll('.tabs,.back,.topbar,.new-msg,.hit-strip').forEach(el => el.remove()); }

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
    userFilter: !!c.userFilter,
    avatarFilter: !!c.avatarFilter,
    browser: !!c.browser,
    phone: !!c.phone,
    phoneTopic: String(c.phoneTopic || '').trim(),
    phoneTitle: String(c.phoneTitle || '').trim().slice(0, 80) || 'Knock 新訊息',
    keep: !!c.keep,
    keepText: String(c.keepText || '').trim().slice(0, 200) || '🎶',
    keepMin: min,
    keepMax: max,
    opener: !!c.opener,
    openerText: String(c.openerText || '').trim().slice(0, 200),
    openerWhen: c.openerWhen === 'id' || c.openerWhen === 'off' ? c.openerWhen : 'now'
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
  if (!topicOk(packed.phoneTopic)) { toast('主題只接受英文、數字、底線和減號'); return; }
  const tabId = current;
  controlDraft = { tabId: tabId, controls: packed };
  paint();
  api('/api/sessions/' + encodeURIComponent(tabId) + '/controls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(packed)
  }).catch(err => { controlDraft = null; toast(err.message || '設定失敗'); paint(); });
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

function folderRow(label, open) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ctrl' + (open ? ' on' : '');
  const name = document.createElement('span');
  name.textContent = label;
  const mark = document.createElement('span');
  mark.textContent = open ? '收合' : '展開';
  mark.style.color = '#888';
  row.append(name, mark);
  return row;
}

function controlBox() {
  return controlHost || app;
}

function paintControls() {
  const host = controlBox();
  host.replaceChildren();
  appendSendImage();
  appendReload();
  const src = shownControls();
  if (!src) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '這個聊天室還沒回報設定。先讓那一頁開著。';
    host.append(p);
    appendLeave();
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
  phoneRow.onclick = () => flip('phone');
  host.append(autoRow, keepRow);
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
    host.append(extra);
  }
  const openerRow = folderRow('發語詞', openerOpen);
  openerRow.onclick = () => { openerOpen = !openerOpen; paint(); };
  host.append(openerRow);
  if (openerOpen) {
    const extra = document.createElement('div');
    extra.className = 'extra';
    const onRow = controlRow('開啟', c.opener, () => flip('opener'));
    onRow.onclick = () => flip('opener');
    const sentence = fieldInput(c.openerText, '連線後送出這句');
    sentence.onchange = () => postControls(Object.assign({}, c, { openerText: sentence.value }));
    const modePick = (label, on, when) => {
      const row = document.createElement('label');
      row.className = 'pick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!on;
      row.append(box, document.createTextNode(label));
      row.onclick = (ev) => {
        ev.preventDefault();
        postControls(Object.assign({}, c, { openerWhen: on ? 'off' : when }));
      };
      return row;
    };
    const sendNow = document.createElement('button');
    sendNow.type = 'button';
    sendNow.textContent = '現在送出';
    sendNow.onclick = () => {
      const room = sessions.find(x => x.tabId === current);
      const text = sentence.value.trim();
      if (!text) { toast('請先寫發語詞'); return; }
      if (!room || !canSend(room)) { toast('現在不能送'); return; }
      showLocalMine(room.tabId, text);
      if (text !== c.openerText) postControls(Object.assign({}, c, { openerText: text }));
      else paint();
      api('/api/sessions/' + encodeURIComponent(room.tabId) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      }).catch(err => {
        undoLocalMine(room.tabId);
        toast(err.message || '送出失敗');
      });
    };
    extra.append(onRow, sentence, modePick('連線成功就送', c.openerWhen === 'now', 'now'), modePick('確認對方後再送', c.openerWhen === 'id', 'id'), sendNow);
    host.append(extra);
  }
  const filterRow = folderRow('過濾', filterOpen);
  filterRow.onclick = () => { filterOpen = !filterOpen; paint(); };
  host.append(filterRow);
  if (filterOpen) {
    const extra = document.createElement('div');
    extra.className = 'extra';
    extra.append(userRow, avatarRow);
    host.append(extra);
  }
  const notifyRow = folderRow('通知', notifyOpen);
  notifyRow.onclick = () => { notifyOpen = !notifyOpen; paint(); };
  host.append(notifyRow);
  if (notifyOpen) {
    const extra = document.createElement('div');
    extra.className = 'extra';
    const topic = fieldInput(c.phoneTopic, 'ntfy 主題');
    topic.onchange = () => postControls(Object.assign({}, c, { phoneTopic: topic.value }));
    const title = fieldInput(c.phoneTitle, 'Knock 新訊息');
    title.onchange = () => postControls(Object.assign({}, c, { phoneTitle: title.value }));
    const test = document.createElement('button');
    test.type = 'button';
    test.textContent = '測試';
    test.onclick = () => {
      const room = sessions.find(x => x.tabId === current);
      if (!room) return;
      const topicText = topic.value.trim();
      if (!topicOk(topicText)) { toast('主題只接受英文、數字、底線和減號'); return; }
      if (!topicText) { toast('請先設定主題'); return; }
      const packed = packControls(Object.assign({}, c, { phoneTopic: topicText, phoneTitle: title.value }));
      const sendTest = () => api('/api/sessions/' + encodeURIComponent(room.tabId) + '/notify-test', { method: 'POST' }).then(data => {
        if (data && data.error) toast(data.error);
      });
      if (JSON.stringify(packed) === JSON.stringify(packControls(c))) {
        sendTest().catch(err => toast(err.message || '測試失敗'));
        return;
      }
      controlDraft = { tabId: room.tabId, controls: packed };
      api('/api/sessions/' + encodeURIComponent(room.tabId) + '/controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packed)
      }).then(sendTest).catch(err => { controlDraft = null; toast(err.message || '測試失敗'); paint(); });
    };
    extra.append(browserRow, phoneRow, topic, title, test);
    host.append(extra);
  }
  appendLeave();
}

function openingClock(ms) {
  const d = new Date(Number(ms) || 0);
  if (!ms || Number.isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' : '') + n;
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function postAvatar(s, on) {
  if (!s || !s.openings) return;
  avatarDraft = { tabId: s.tabId, channelId: s.channelId, on: !!on };
  paint();
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: !!on })
  }).catch(err => { avatarDraft = null; toast(err.message || '設定失敗'); paint(); });
}

function postUser(s, on) {
  if (!s || !s.openings) return;
  if (!s.partnerUid) { toast('還沒讀到對方 id'); return; }
  const person = people.find(p => p.uid === s.partnerUid);
  const prev = person ? !!person.filtered : false;
  if (person) person.filtered = !!on;
  userDraft = { tabId: s.tabId, channelId: s.channelId, on: !!on };
  paint();
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: !!on })
  }).catch(err => {
    userDraft = null;
    if (person) person.filtered = prev;
    toast(err.message || '設定失敗');
    paint();
  });
}

function shownOpenings(s) {
  let o = s && s.openings;
  if (!o) return null;
  if (avatarDraft && avatarDraft.tabId === s.tabId && avatarDraft.channelId === s.channelId) o = Object.assign({}, o, { avatarOn: avatarDraft.on });
  if (userDraft && userDraft.tabId === s.tabId && userDraft.channelId === s.channelId) o = Object.assign({}, o, { userOn: userDraft.on });
  return o;
}

function paintMessages(list) {
  const targets = quoteTargets(list || []);
  (list || []).forEach((m, i) => paintBubble(m, targets[i]));
}

function paintBubble(m, quoteId) {
  if (m && m.end) {
    const note = document.createElement('p');
    note.className = 'end-note';
    note.textContent = m.text || (m.end === 'idle' ? '閒置時間過久' : m.end === 'them' ? '對方離開' : '我主動離開');
    if (m.time) {
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = m.time;
      note.append(time);
    }
    if (m.id) note.dataset.id = m.id;
    app.append(note);
    return note;
  }
  const wrap = document.createElement('div');
  wrap.className = 'bubble ' + (m.mine ? 'mine' : 'them');
  const row = document.createElement('div');
  row.className = 'msg';
  if (m.quote) {
    const quote = document.createElement('div');
    quote.className = 'quote' + (quoteId ? ' jump' : '');
    quote.textContent = m.quote;
    if (quoteId) quote.onclick = () => jumpToMessage(quoteId);
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
    img.alt = '';
    img.onclick = () => zoomPic(m.image);
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
  if (m.id) wrap.dataset.id = m.id;
  if (m.pending) wrap.dataset.pending = '1';
  app.append(wrap);
  return wrap;
}

function replayPending(tabId) {
  (pendingMine[tabId] || []).forEach(text => paintBubble({ text: text, mine: true, pending: true }));
}

function dropPending(tabId) {
  if (tabId) delete pendingMine[tabId];
}

function showLocalMine(tabId, text) {
  if (!pendingMine[tabId]) pendingMine[tabId] = [];
  pendingMine[tabId].push(text);
  if (tabId !== current || archiveUid || showControls) return;
  const follow = stickBottom || nearBottom();
  paintBubble({ text: text, mine: true, pending: true });
  if (follow) scrollBottom();
}

function undoLocalMine(tabId) {
  const q = pendingMine[tabId];
  if (q && q.length) q.pop();
  if (tabId !== current) return;
  const nodes = app.querySelectorAll('.bubble[data-pending]');
  const last = nodes[nodes.length - 1];
  if (last) last.remove();
}

function ensureTime(node, time) {
  if (!node || !time) return;
  let el = node.querySelector('.time');
  if (!el) {
    el = document.createElement('div');
    el.className = 'time';
    const msg = node.querySelector('.msg');
    if (msg) msg.append(el);
  }
  if (el) el.textContent = time;
}

function stampEcho(added) {
  const nodes = app.querySelectorAll('.bubble[data-pending]');
  (added || []).forEach((m, i) => {
    const node = nodes[i];
    if (!node) return;
    node.removeAttribute('data-pending');
    if (m.id) node.dataset.id = m.id;
    ensureTime(node, m.time);
  });
}

function patchTimes(times) {
  (times || []).forEach(m => {
    const all = app.querySelectorAll('.bubble');
    for (const node of all) {
      if (node.dataset.id === m.id) ensureTime(node, m.time);
    }
  });
}

function syncMenuDot() {
  const btn = document.querySelector('.topbar .rail-btn');
  if (!btn) return;
  const dot = btn.querySelector('.dot');
  if (unreadLeft()) { if (!dot) btn.append(redDot()); }
  else if (dot) dot.remove();
}

function refreshList() {
  paintNav();
  if (phoneLayout() && menu === 'chats' && !current && !showControls && !archiveUid) {
    keepBoardScroll = true;
    paintLiveBoard();
    syncMenuDot();
    return;
  }
  if (phoneLayout() && menu === 'talks' && !archiveUid) {
    keepBoardScroll = true;
    paintTalkBoard();
    syncMenuDot();
    return;
  }
  paintRail();
  syncMenuDot();
  paintQueued();
}

function openingSig(s) {
  const o = s && s.openings;
  if (!o) return '';
  const them = o.them && o.them.text || '';
  const mine = o.mine && o.mine.text || '';
  return (o.avatar || '') + '|' + them + '|' + mine + '|' + (o.avatarOn ? '1' : '0') + '|' + (o.userOn ? '1' : '0');
}

function paintOpening(s) {
  const o = shownOpenings(s);
  if (!o) return;
  const box = document.createElement('div');
  box.className = 'open';
  if (o.avatar) {
    const face = faceNode(o.avatar, true);
    face.alt = '大頭貼';
    box.append(face);
  }
  const toggles = document.createElement('div');
  toggles.className = 'group';
  if (o.avatar) {
    const row = document.createElement('button');
    row.type = 'button';
    row.title = '記錄這張大頭貼';
    row.setAttribute('aria-label', '記錄這張大頭貼');
    row.append(glyph('M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'));
    if (o.avatarOn) row.className = 'on';
    row.onclick = () => postAvatar(s, !o.avatarOn);
    toggles.append(row);
  }
  const userRow = document.createElement('button');
  userRow.type = 'button';
  userRow.title = '記錄這位使用者';
  userRow.setAttribute('aria-label', '記錄這位使用者');
  userRow.append(glyph('M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'));
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

function reloadPage(s) {
  if (!s) return;
  showControls = false;
  dropPending(s.tabId);
  paint();
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/reload', { method: 'POST' })
    .catch(err => toast(err.message || '重新整理失敗'));
}

function appendSendImage() {
  const s = sessions.find(x => x.tabId === current);
  if (!s || !canSend(s)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctrl';
  btn.textContent = '傳送圖片';
  btn.style.justifyContent = 'flex-start';
  btn.onclick = () => {
    showControls = false;
    paint();
    relayFile.click();
  };
  (controlHost || app).append(btn);
}

function appendReload() {
  const s = sessions.find(x => x.tabId === current);
  if (!s) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctrl';
  btn.textContent = '重新整理';
  btn.style.justifyContent = 'flex-start';
  btn.onclick = () => reloadPage(s);
  (controlHost || app).append(btn);
}

function leaveChat(s) {
  if (!s || !confirm('離開這個聊天？')) return;
  showControls = false;
  paint();
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/leave', { method: 'POST' })
    .catch(err => toast(err.message || '離開失敗'));
}

function appendLeave() {
  const s = sessions.find(x => x.tabId === current);
  if (!s || s.lobby || s.status === 'left') return;
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.className = 'ctrl';
  leave.textContent = '離開';
  leave.style.color = '#e53935';
  leave.style.justifyContent = 'flex-start';
  leave.onclick = () => leaveChat(s);
  (controlHost || app).append(leave);
}

function startChat(s) {
  if (!s) return;
  api('/api/sessions/' + encodeURIComponent(s.tabId) + '/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).catch(err => toast(err.message || '開始失敗'));
}

function beforeConnect(s) {
  return !!(s && (s.lobby || s.status === 'left' || s.phase));
}

function showStart(s) {
  if (!s) return false;
  if (s.canStart === true || s.canStart === false) return s.canStart;
  return !!(s.lobby || s.status === 'left');
}

function phaseText(s) {
  if (!s) return '';
  if (s.phase) return s.phase;
  if (s.status === 'left') return '對方已離開對話';
  if (s.lobby) return '開始聊天';
  return '';
}

function startButton(s) {
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'start';
  start.textContent = '開始';
  start.onclick = () => startChat(s);
  return start;
}

function syncPhaseForm(s) {
  const input = document.querySelector('form input[data-kind="phase"]');
  if (!beforeConnect(s)) return !input;
  if (!input) return false;
  const text = phaseText(s);
  if (input.value !== text) input.value = text;
  const start = document.querySelector('form button.start');
  if (showStart(s) && !start) input.before(startButton(s));
  else if (!showStart(s) && start) start.remove();
  return true;
}

function threadActions() {
  return null;
}

function paintTyping(on) {
  const old = document.querySelector('.typing');
  if (!on) {
    if (old) old.remove();
    return;
  }
  if (old) return;
  const follow = stickBottom || nearBottom();
  const note = document.createElement('p');
  note.className = 'muted typing';
  note.style.textAlign = 'center';
  note.textContent = '對方正在輸入...';
  app.append(note);
  if (follow) scrollBottom();
}

function paintThread(s, follow, y) {
  paintBar((s && s.title) || '未命名', threadActions(s), s && s.openings && s.openings.avatar, s && s.tabId ? (title) => {
    api('/api/sessions/' + encodeURIComponent(s.tabId) + '/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title })
    }).then(data => {
      s.title = data.title || '未命名';
      const row = data.uid && talks.find(t => t.uid === data.uid);
      if (row) row.title = s.title;
      const person = data.uid && people.find(p => p.uid === data.uid);
      if (person) person.title = s.title;
      paint();
    }).catch(err => toast(err.message || '命名失敗'));
  } : null);
  app.replaceChildren();
  if (!s) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '這個視窗已經不在';
    app.append(p);
    return;
  }
  app.classList.add('thread');
  paintOpening(s);
  paintMessages(s.messages || []);
  replayPending(s.tabId);
  if (s.status === 'left') {
    const note = document.createElement('p');
    note.className = 'muted';
    note.style.textAlign = 'center';
    note.textContent = statusText(s);
    app.append(note);
  }
  paintTyping(!!s.typing);
  placeThread(s, follow, y);
}

function paint() {
  const keepDock = showControls && document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest && document.activeElement.closest('.menu-dock');
  try {
  app.classList.remove('thread');
  if (!token) { clearForm(); return gate(); }
  document.body.classList.remove('locked');
  document.body.classList.toggle('users', menu === 'users');
  document.body.classList.toggle('faces', menu === 'faces');
  document.body.classList.toggle('people-list', menu === 'users' && !(userOpen && archiveUid));
  document.body.classList.toggle('face-list', menu === 'faces');
  document.querySelectorAll('.gate').forEach(el => el.remove());
  paintNav();
  if (menu === 'faces') {
    hideJump();
    paintFaces();
    return;
  }
  if (menu === 'users') {
    hideJump();
    if (userOpen && archiveUid) {
      const userY = app.scrollTop;
      const userFollow = stickBottom || nearBottom();
      paintUser(archiveTalk, userFollow, userY);
    } else paintPeople();
    return;
  }
  if (menu === 'talks') {
    hideJump();
    if (!phoneLayout()) paintRail();
    if (archiveUid) {
      const y = app.scrollTop;
      const follow = stickBottom || nearBottom();
      paintArchive(archiveTalk, follow, y);
      return;
    }
    if (phoneLayout()) {
      paintTalkBoard();
      return;
    }
    clearForm();
    paintBar('記錄');
    app.replaceChildren();
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '選一筆記錄';
    app.append(p);
    return;
  }
  if (!phoneLayout()) paintRail();
  if (phoneLayout() && !showControls && !archiveUid && !current) {
    hideJump();
    paintLiveBoard();
    return;
  }
  if (archiveUid) {
    hideJump();
    const y = app.scrollTop;
    const follow = stickBottom || nearBottom();
    paintArchive(archiveTalk, follow, y);
    return;
  }
  const y = app.scrollTop;
  const follow = stickBottom || (!!current && nearBottom());
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('form')
    && !(document.activeElement.dataset && document.activeElement.dataset.kind === 'phase');
  if (focused && current) {
    const s = sessions.find(x => x.tabId === current);
    paintThread(s, follow, y);
    paintQueued(s);
    if (s && beforeConnect(s)) { hideJump(); return; }
    const input = document.querySelector('form input');
    if (input) input.disabled = !canSend(s);
    document.querySelectorAll('form button').forEach(btn => { btn.disabled = sending || !canSend(s); });
    return;
  }
  const keepInput = document.querySelector('form input:not([type=file])');
  if (keepInput && formTab && keepInput.dataset.kind !== 'phase') composeDrafts[formTab] = keepInput.value;
  const draft = composeDrafts[current] || '';
  if (!current) {
    hideJump();
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
  if (beforeConnect(s)) {
    hideJump();
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.readOnly = true;
    input.dataset.kind = 'phase';
    input.value = phaseText(s);
    if (showStart(s)) form.append(startButton(s));
    form.append(input);
    form.onsubmit = (e) => e.preventDefault();
    stage.append(form);
    formTab = s.tabId;
    if (follow) scrollBottom();
    paintQueued(s);
    return;
  }
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.maxLength = 2000;
  input.placeholder = canSend(s) ? '輸入訊息' : statusText(s);
  input.disabled = !canSend(s);
  input.value = draft;
  const sendBtn = document.createElement('button');
  sendBtn.textContent = '送出';
  sendBtn.disabled = sending || !canSend(s);
  form.append(input, sendBtn);
  const sendText = () => {
    const text = input.value.trim();
    if (!text || !canSend(s) || sending) return;
    if (text === lastSentText && Date.now() - lastSentAt < 2000) {
      input.value = '';
      composeDrafts[s.tabId] = '';
      input.focus();
      return;
    }
    sending = true;
    sendBtn.disabled = true;
    showLocalMine(s.tabId, text);
    input.value = '';
    composeDrafts[s.tabId] = '';
    lastSentText = text;
    lastSentAt = Date.now();
    input.focus();
    api('/api/sessions/' + encodeURIComponent(s.tabId) + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).catch(err => {
      undoLocalMine(s.tabId);
      if (lastSentText === text) lastSentText = '';
      input.value = text;
      composeDrafts[s.tabId] = text;
      toast(err.message);
    }).finally(() => {
      sending = false;
      document.querySelectorAll('form button').forEach(btn => { btn.disabled = !canSend(s); });
      input.focus();
    });
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    sendText();
  };
  sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
  sendBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    input.focus();
  }, { passive: false });
  sendBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    input.focus();
    sendText();
  });
  stage.append(form);
  formTab = s.tabId;
  paintQueued(s);
  if (keepInput && document.activeElement === keepInput) input.focus();
  if (follow) scrollBottom();
  } finally {
    if (!keepDock) paintDock();
    paintPhoneAlert();
  }
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

function zoomPic(id) {
  const old = document.getElementById('zoom');
  if (old) old.remove();
  const shade = document.createElement('button');
  shade.type = 'button';
  shade.id = 'zoom';
  shade.className = 'pic';
  shade.setAttribute('aria-label', '關閉圖片');
  const img = document.createElement('img');
  img.alt = '';
  img.onclick = (e) => e.stopPropagation();
  showPic(id, img);
  shade.append(img);
  shade.onclick = () => shade.remove();
  document.body.append(shade);
}

function zoomFace(avatar) {
  const old = document.getElementById('zoom');
  if (old) old.remove();
  const shade = document.createElement('button');
  shade.type = 'button';
  shade.id = 'zoom';
  shade.setAttribute('aria-label', '關閉大頭貼');
  shade.append(faceNode(avatar));
  shade.onclick = () => shade.remove();
  document.body.append(shade);
}

function faceNode(avatar, zoom) {
  const node = avatar === 'plain' ? plainFace() : document.createElement('img');
  if (avatar !== 'plain') {
    node.className = 'face';
    node.alt = '';
    showPic(avatar, node);
  }
  if (!zoom || !avatar) return node;
  node.classList.add('zoomable');
  node.style.pointerEvents = 'auto';
  node.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    zoomFace(avatar);
  };
  return node;
}

function showPic(id, img) {
  if (!id || !img) return;
  img.dataset.pic = id;
  if (picUrls[id]) { img.src = picUrls[id]; return; }
  if (img.dataset.loading === '1') return;
  img.dataset.loading = '1';
  fetch('/api/images/' + id, { headers: { Authorization: 'Bearer ' + token } })
    .then(r => { if (!r.ok) throw new Error('no'); return r.blob(); })
    .then(blob => {
      picUrls[id] = URL.createObjectURL(blob);
      img.dataset.loading = '';
      if (img.isConnected) img.src = picUrls[id];
    })
    .catch(() => { img.dataset.loading = ''; });
}

function retryPics() {
  document.querySelectorAll('img[data-pic]').forEach(img => {
    if (img.getAttribute('src')) return;
    showPic(img.dataset.pic, img);
  });
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
  })).catch(err => toast(err.message || '圖片送出失敗')).finally(() => {
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
    const prevCurrent = sessions.find(s => s.tabId === current);
    const ask = [];
    if (pollWait) ask.push('wait=1');
    ask.push(document.hidden ? 'active=0' : 'active=1');
    if (menu === 'users' || menu === 'faces') ask.push('people=1');
    const data = await api('/api/sessions?' + ask.join('&'));
    sessions = data.sessions || [];
    phoneAlerts = Array.isArray(data.phoneAlerts) ? data.phoneAlerts : [];
    paintPhoneAlert();
    const otherPing = noteRooms(sessions);
    const freshTalks = data.talks || [];
    for (const uid of [...droppedTalks]) {
      if (!freshTalks.some(t => t.uid === uid)) droppedTalks.delete(uid);
    }
    talks = freshTalks.filter(t => !droppedTalks.has(t.uid));
    if (Array.isArray(data.people)) people = data.people;
    if (controlDraft) {
      const hit = sessions.find(s => s.tabId === controlDraft.tabId);
      if (hit && hit.controls && JSON.stringify(packControls(hit.controls)) === JSON.stringify(controlDraft.controls)) controlDraft = null;
    }
    if (avatarDraft) {
      const hit = sessions.find(s => s.tabId === avatarDraft.tabId);
      if (!hit || hit.channelId !== avatarDraft.channelId) avatarDraft = null;
      else if (hit.openings && !!hit.openings.avatarOn === avatarDraft.on) avatarDraft = null;
    }
    if (userDraft) {
      const hit = sessions.find(s => s.tabId === userDraft.tabId);
      if (!hit || hit.channelId !== userDraft.channelId) userDraft = null;
      else if (hit.openings && !!hit.openings.userOn === userDraft.on) userDraft = null;
    }
    const nextCurrent = sessions.find(s => s.tabId === current);
    if (nextCurrent && nextCurrent.waiting) {
      dropPending(current);
      current = '';
    }
    const openLive = menu === 'chats' && current && !archiveUid;
    if (!openLive) {
      hideJump();
      const leftOpen = menu === 'chats' && !showControls && !archiveUid && prevCurrent && !current;
      const showPeople = (menu === 'users' || menu === 'faces') && Array.isArray(data.people) && !(userOpen && archiveUid);
      if (showPeople || leftOpen || (!app.childNodes.length && menu === 'chats')) paint();
      else refreshList();
      return;
    }
    let quiet = false;
    if (prevCurrent && nextCurrent && prevCurrent.channelId === nextCurrent.channelId) {
      const plan = ownEchoPlan(prevCurrent.messages, nextCurrent.messages, pendingMine[current] || []);
      pendingMine[current] = plan.rest;
      quiet = !plan.redraw
        && prevCurrent.title === nextCurrent.title
        && !!prevCurrent.canType === !!nextCurrent.canType
        && prevCurrent.status === nextCurrent.status
        && !!prevCurrent.lobby === !!nextCurrent.lobby
        && !!prevCurrent.waiting === !!nextCurrent.waiting
        && openingSig(prevCurrent) === openingSig(nextCurrent);
      if (quiet) {
        stampEcho(plan.added);
        patchTimes(plan.times);
        retryPics();
        if (!syncPhaseForm(nextCurrent)) quiet = false;
      }
    } else if (prevCurrent && nextCurrent && prevCurrent.channelId !== nextCurrent.channelId) {
      pendingMine[current] = [];
    }
    if (quiet) refreshList();
    else paint();
    paintTyping(!!(nextCurrent && nextCurrent.typing));
    if (otherPing) {
      glowInput();
      showJump(otherPing);
    }
    const composer = document.querySelector('form input:not([type=file])');
    if (!composer || composer.dataset.kind === 'phase') hideJump();
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
document.addEventListener('visibilitychange', () => { tick(); });
window.matchMedia('(max-width:760px)').addEventListener('change', () => { if (token) paint(); });
window.addEventListener('pageshow', () => {
  const ids = Object.keys(pendingMine);
  if (!ids.length) return;
  ids.forEach(dropPending);
  paint();
});
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
  if (dx < 48 || dx <= Math.abs(dy)) return;
  if (phoneLayout() && menu === 'chats' && current) {
    leavePhoneChat();
    return;
  }
  document.body.classList.add('rail-open');
});
document.addEventListener('pointercancel', () => { edgeSwipe = null; });
loop();
</script>
</body>
</html>`;

function storedHasConv(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return (raw || []).some(row => String(row && row.uid || '').startsWith('conv_'));
    } catch (e) {
        return false;
    }
}

function main() {
    loadDropped();
    loadFilters();
    loadPhoneAlerts();
    const sessions = loadSessions();
    const talks = loadTalks();
    if (talksNeedYear || storedHasConv(TALK_FILE)) saveTalks(talks);
    people = loadPeople();
    if (seedPeople(people, talks) || storedHasConv(PEOPLE_FILE)) savePeople(people);
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
                notePageActive(url.searchParams.get('active'), Date.now());
                if (url.searchParams.get('wait') === '1') {
                    const seen = revision;
                    await waitUntil(POLL_MS, req, () => revision !== seen);
                }
                if (clientGone(req, res)) return;
                const view = { sessions: visibleSessions(sessions, Date.now(), WAIT_MS), talks: visibleTalks(talks), phoneAlerts };
                if (url.searchParams.get('people') === '1') view.people = visiblePeople(people);
                return send(res, 200, view);
            }
            if (req.method === 'GET' && url.pathname === '/api/talks-search') {
                return send(res, 200, { talks: searchTalks(talks, url.searchParams.get('q')) });
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
                const archive = body && body.archive;
                const seenUid = cleanUid(archive && archive.uid);
                let noted = false;
                if (seenUid) {
                    const talk = talks.get(seenUid);
                    noted = notePerson(people, {
                        uid: seenUid,
                        title: archive.named ? archive.title : ((talk && talk.title) || archive.title),
                        named: !!archive.named,
                        avatar: (talk && talk.avatar) || (body.openings && body.openings.avatar),
                        messages: archive.messages,
                        channelId: body.channelId,
                        count: talk ? talk.messages.length : undefined
                    }, Date.now());
                }
                saveSessions(sessions);
                if (archived) saveTalks(talks);
                if (noted) savePeople(people);
                if (url.searchParams.get('wait') === '1') {
                    const seenFilters = filterRev;
                    await waitUntil(POLL_MS, req, () => heartbeatReady(session) || filterRev !== seenFilters);
                }
                if (clientGone(req, res)) return;
                const outbox = pendingOutbox(session);
                const patch = takeControlPatch(session);
                const avatarPatch = takeAvatarPatch(session);
                const userPatch = takeUserPatch(session);
                const greetingPatch = takeGreetingPatch(session);
                const startPatch = takeStartPatch(session);
                const leavePatch = takeLeavePatch(session);
                const reloadPatch = takeReloadPatch(session);
                const notifyPatch = takeNotifyPatch(session);
                if (outbox.dirty || patch.dirty || avatarPatch.dirty || userPatch.dirty || greetingPatch.dirty || startPatch.dirty || leavePatch.dirty || reloadPatch.dirty || notifyPatch.dirty) saveSessions(sessions);
                const talkUid = cleanUid(body && body.archive && body.archive.uid);
                const savedTalk = talkUid ? talks.get(talkUid) : null;
                const listed = heartPeople(people, body && body.peopleRev);
                const reply = { ok: true, outbox: outbox.pending, controls: patch.controls, avatarOn: avatarPatch.avatarOn, userOn: userPatch.userOn, greeting: greetingPatch.greeting, start: startPatch.start, leave: leavePatch.leave, reload: reloadPatch.reload, notify: notifyPatch.notify, pageOn: pageOn(Date.now()), filters, peopleRev: listed.peopleRev, talkTitle: savedTalk ? savedTalk.title : '', rename: session.titleWanted || '' };
                if (listed.people) reply.people = listed.people;
                return send(res, 200, reply);
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
                // 檔案已在就用同一份，不再寫一次。寫好就叫醒正在看的頁面。
                if (!imagePath(imgMatch[1])) {
                    const buf = await readRaw(req, 1500000);
                    if (!writeImage(imgMatch[1], buf, req.headers['content-type'])) return send(res, 400, { error: 'bad image' });
                }
                touch();
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
            const titlePost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/title$/);
            if (req.method === 'POST' && titlePost) {
                const session = sessions.get(titlePost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                const title = String(body && body.title || '').trim().slice(0, 40) || '未命名';
                session.title = title;
                session.titleWanted = title;
                if (setTalkTitle(talks, session.partnerUid, title)) saveTalks(talks);
                if (session.partnerUid && notePerson(people, {
                    uid: session.partnerUid,
                    title,
                    named: true,
                    avatar: session.openings && session.openings.avatar,
                    messages: []
                }, Date.now())) savePeople(people);
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true, title, uid: session.partnerUid || '' });
            }
            const talkTitlePost = url.pathname.match(/^\/api\/talks\/([A-Za-z0-9_-]{6,128})\/title$/);
            if (req.method === 'POST' && talkTitlePost) {
                const uid = talkTitlePost[1];
                const talk = talks.get(uid);
                const prevPerson = people.get(uid);
                if (!talk && !prevPerson) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                const title = String(body && body.title || '').trim().slice(0, 40) || '未命名';
                if (talk) setTalkTitle(talks, uid, title);
                notePerson(people, {
                    uid,
                    title,
                    named: true,
                    avatar: (talk && talk.avatar) || (prevPerson && prevPerson.avatar),
                    messages: (talk && talk.messages) || []
                }, (prevPerson && prevPerson.firstAt) || (talk && talk.updated) || Date.now());
                if (talk) saveTalks(talks);
                savePeople(people);
                for (const session of sessions.values()) {
                    if (session.partnerUid !== uid) continue;
                    session.title = title;
                    session.titleWanted = title;
                }
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true, title, uid });
            }
            const greetPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/greeting$/);
            if (req.method === 'POST' && greetPost) {
                const session = sessions.get(greetPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const body = await readBody(req);
                const text = String(body && body.text || '').trim().slice(0, 200);
                if (!text) return send(res, 400, { error: 'empty' });
                session.greetingWanted = text;
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            const startPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/start$/);
            if (req.method === 'POST' && startPost) {
                const session = sessions.get(startPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                if (!session.lobby && session.status !== 'left') return send(res, 409, { error: 'cannot start' });
                session.startWanted = true;
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            const leavePost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/leave$/);
            if (req.method === 'POST' && leavePost) {
                const session = sessions.get(leavePost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                if (session.lobby || session.status === 'left') return send(res, 409, { error: 'cannot leave' });
                session.leaveWanted = true;
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            const reloadPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/reload$/);
            if (req.method === 'POST' && reloadPost) {
                const session = sessions.get(reloadPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                requestReload(session);
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/phone-alerts') {
                const body = await readBody(req);
                notePhoneAlert(body && body.reason);
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/phone-alerts/dismiss') {
                const body = await readBody(req);
                clearPhoneAlerts(body && body.ids);
                return send(res, 200, { ok: true });
            }
            const notifyPost = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/notify-test$/);
            if (req.method === 'POST' && notifyPost) {
                const session = sessions.get(notifyPost[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                const text = latestThemText(session);
                if (!text) return send(res, 200, { ok: false, error: '對方還沒有訊息' });
                session.notifyWanted = text;
                touch();
                saveSessions(sessions);
                return send(res, 200, { ok: true });
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
                if (!markSessionUser(session, !!body.on)) return send(res, 409, { error: 'no user' });
                saveFilters();
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
            const clearOut = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{8,40})\/outbox$/);
            if (req.method === 'DELETE' && clearOut) {
                const session = sessions.get(clearOut[1]);
                if (!session) return send(res, 404, { error: 'gone' });
                session.outbox = [];
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
