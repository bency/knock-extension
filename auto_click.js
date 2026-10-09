// ==UserScript==
// @name         Knock.tw Auto Clicker
// @namespace    http://tampermonkey.net/
// @version      1.4.91
// @description  Automatically click the "Re-match" and "Confirm Exit" buttons on Knock.tw, with conversation blacklist, avatar matching, and conversation saving features
// @author       Antigravity
// @match        https://knock.tw/*
// @run-at       document-start
// @icon         https://www.google.com/s2/favicons?sz=64&domain=knock.tw
// @updateURL    https://raw.githubusercontent.com/bency/knock-extension/main/auto_click.js
// @downloadURL  https://raw.githubusercontent.com/bency/knock-extension/main/auto_click.js
// @grant        unsafeWindow
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      knock.keeping.work
// @connect      ntfy.sh
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    // --- 常數 ---
    const PENDING_START_CHAT_KEY = 'knockPendingStartChat';
    const PENDING_START_CHAT_REASON_KEY = 'knockPendingStartChatReason';
    const PENDING_FILTER_NAME_KEY = 'knockPendingFilterName';
    const PENDING_START_CHAT_TTL_MS = 30000;
    const START_CHAT_REASON_LABEL = {
        otherLeft: '對方主動斷線',
        selfLeft: '我主動斷線',
        firstFilter: '使用者過濾而重連'
    };
    const AUTO_CLICK_ENABLED_KEY = 'knockAutoClickEnabled';
    const FIRST_MSG_FILTER_KEY = 'knockFirstMessageFilters';
    const FIRST_FILTER_ENABLED_KEY = 'knockFirstFilterEnabled';
    const AVATAR_FILTER_KEY = 'knockAvatarFilters';
    const AVATAR_FILTER_ENABLED_KEY = 'knockAvatarFilterEnabled';
    const BROWSER_NOTIFY_ENABLED_KEY = 'knockBrowserNotifyEnabled';
    const NTFY_ENABLED_KEY = 'knockNtfyEnabled';
    const NTFY_TOPIC_KEY = 'knockNtfyTopic';
    const NTFY_TITLE_KEY = 'knockNtfyTitle';
    const NTFY_TITLE_DEFAULT = 'Knock 新訊息';
    const NTFY_SERVER = 'https://ntfy.sh';
    const RELAY_URL = 'https://knock.keeping.work';
    const RELAY_TOKEN_KEY = 'knockRelayToken';
    const RELAY_TAB_KEY = 'knockRelayTabId';
    const TYPING_RE = /對方正在輸入|正在輸入|typing/i;
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.4.91';
    const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    const DOCK_OPEN_KEY = 'knockDockOpen';
    const OLD_FLOAT_IDS = [
        'knock-auto-click-toggle', 'knock-manager-button', 'knock-filter-manager-button',
        'knock-ntfy-button', 'knock-keepalive-toggle', 'knock-manual-save-button'
    ];
    const DOCK_PANEL = 'background:rgba(0,0,0,0.82);border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    const DOCK_ROW = 'display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;border:none;border-radius:8px;background:#222;color:#fff;font:inherit;font-size:13px;text-align:left;cursor:pointer;';
    const CSS_INP = 'width:100%;padding:12px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;';
    const cssBtn = (bg, extra = '') => `padding:8px 16px;background:${bg};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;${extra}`;

    // --- 共用 ---
    function el(id) {
        return document.getElementById(id);
    }

    function makeOverlay(id, maxWidth, html, z, pinChrome) {
        const node = document.createElement('div');
        node.id = id;
        node.style.cssText = pinChrome
            ? `position:fixed;inset:0;z-index:${z || 10002};background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow:hidden;display:flex;`
            : `position:fixed;inset:0;z-index:${z || 10002};background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow-y:auto;`;
        const inner = pinChrome
            ? `max-width:${maxWidth}px;width:100%;margin:0 auto;padding:24px;box-sizing:border-box;height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden;`
            : `max-width:${maxWidth}px;margin:0 auto;padding:24px;`;
        node.innerHTML = `<div style="${inner}">${html}</div>`;
        document.body.appendChild(node);
        node.addEventListener('click', (e) => { if (e.target === node) node.remove(); });
        return node;
    }

    function toggleOverlay(id, build) {
        const existing = el(id);
        if (existing) {
            existing.remove();
            return null;
        }
        return build();
    }

    function filterCardsByTerm(selector, term, displayOn) {
        document.querySelectorAll(selector).forEach(card => {
            card.style.display = card.textContent.toLowerCase().includes(term) ? displayOn : 'none';
        });
    }

    function storageGet(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('localStorage 寫入失敗:', key, e);
            return false;
        }
    }

    function storedOn(key, fallback) {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v === 'true';
    }

    function emptyConversation() {
        return { id: null, messages: [], startTime: null, endTime: null, ended: false, partnerUid: null, label: '' };
    }

    // --- 狀態 ---
    let autoClickEnabled = storedOn(AUTO_CLICK_ENABLED_KEY, true);
    let firstFilterEnabled = storedOn(FIRST_FILTER_ENABLED_KEY, true);
    let avatarFilterEnabled = storedOn(AVATAR_FILTER_ENABLED_KEY, true);
    let browserNotifyEnabled = storedOn(BROWSER_NOTIFY_ENABLED_KEY, true);
    let ntfyEnabled = storedOn(NTFY_ENABLED_KEY, true);
    let keepAliveEnabled = false;
    let keepAliveText = '';
    let keepMin = 1.5;
    let keepMax = 2.5;
    let keepAliveWaitMs = 0;
    let lastKeepAliveTryAt = 0;
    let lastKeepAliveSentAt = 0;

    const checkedMessages = new Set();
    let myAvatarUrl = null;
    let currentConversation = emptyConversation();
    let nameSet = false;
    let relayRecordUser = false;
    let relayRecordAvatar = false;
    let pendingRemoteStart = false;
    let greetingSaveAt = 0;
    let notificationsArmed = false;
    let pendingForcedLeave = false;
    let forceAutoUntilIdle = false;
    let lastExitClickAt = 0;
    let skipFirstFilterFor = null;
    let rematchScheduled = false;
    let startChatScheduled = false;
    let cooldownUntil = 0;
    let cooldownLabel = '';
    let cooldownTick = null;
    let lastBoundAt = 0;
    let otherPartySeen = false;

    // --- 對話生命週期 ---
    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    function newConvId() {
        return 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    function isChannelId(id) {
        return !!id && !String(id).startsWith('conv_');
    }

    // ponytail: 只從頁面自己的 Listen 偷看 parent，用來當對話 id；不另開連線、不撈歷史
    function extractChannelId(text) {
        if (text == null) return null;
        let raw = String(text);
        try { raw = decodeURIComponent(raw); } catch (e) { /* 原文繼續掃 */ }
        const re = /documents\/channels\/([A-Za-z0-9]+)/g;
        let id = null, m;
        while ((m = re.exec(raw))) id = m[1];
        return id;
    }

    function clearRelayRecord() {
        relayRecordUser = false;
        relayRecordAvatar = false;
    }

    function bindChannel(id) {
        if (!id || currentConversation.id === id) return;
        clearRelayRecord();
        if (isChannelId(currentConversation.id)) initNewConversation();
        currentConversation.id = id;
        if (!currentConversation.startTime) currentConversation.startTime = new Date().toISOString();
        lastBoundAt = Date.now();
        console.log('對話 channel:', id);
    }

    function hookFirestoreChannel() {
        const xhr = (typeof unsafeWindow !== 'undefined' && unsafeWindow.XMLHttpRequest) || XMLHttpRequest;
        const proto = xhr.prototype;
        if (proto.__knockChannelHook) return;
        proto.__knockChannelHook = true;
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = function (method, url) {
            try { this.__knockUrl = String(url || ''); } catch (e) { /* 略 */ }
            return origOpen.apply(this, arguments);
        };
        proto.send = function (body) {
            try {
                if (/firestore\.googleapis\.com/.test(this.__knockUrl || '')) {
                    const id = extractChannelId(body);
                    if (id) bindChannel(id);
                }
            } catch (e) { /* 略 */ }
            return origSend.apply(this, arguments);
        };
    }

    function initNewConversation() {
        if (Date.now() - lastBoundAt < 3000 && isChannelId(currentConversation.id)) {
            console.log('沿用剛綁定的 channel:', currentConversation.id);
            return;
        }
        currentConversation = {
            ...emptyConversation(),
            id: newConvId(),
            startTime: new Date().toISOString()
        };
        clearRelayRecord();
        nameSet = false;
        keepAliveWaitMs = 0;
        lastKeepAliveSentAt = 0;
        pendingForcedLeave = false;
        forceAutoUntilIdle = false;
        lastExitClickAt = 0;
        skipFirstFilterFor = null;
        rematchScheduled = false;
        startChatScheduled = false;
        hideCooldown();
        otherPartySeen = false;
        syncUnnamedChip();
        console.log('初始化新對話:', currentConversation.id);
    }

    // --- 使用者過濾：比對使用者 id。勾選時用發語詞當顯示名稱。沒有 id 的舊項目仍比對文字與頭像 ---
    function avatarHashOf(url) {
        return url ? hashString(url) : '';
    }

    function normalizeFilter(item) {
        if (item && typeof item === 'object') {
            const u = String(item.u ?? item.uid ?? '').trim();
            const t = String(item.t ?? item.text ?? '').trim();
            const a = String(item.a ?? item.avatarHash ?? '');
            return (u || t) ? { u, t, a } : null;
        }
        const t = String(item ?? '').trim();
        return t ? { u: '', t, a: '' } : null;
    }

    function getNormalizedFilters() {
        return storageGet(FIRST_MSG_FILTER_KEY, []).map(normalizeFilter).filter(Boolean);
    }

    function firstFilterHit(filters, uid, text, avatarHash) {
        const u = (uid || '').trim();
        const t = (text || '').trim();
        const a = avatarHash || '';
        return (filters || []).some(f => (u && f.u === u) || (!f.u && t && f.t === t && f.a === a));
    }

    function isFirstMessageFiltered(uid, text, avatarHash) {
        return firstFilterHit(getNormalizedFilters(), uid, text, avatarHash);
    }

    function addFirstMessageFilter(uid, text, avatarHash) {
        const u = (uid || '').trim();
        const t = (text || '').trim();
        const a = avatarHash || '';
        if (!u || TYPING_RE.test(t)) return false;
        const list = getNormalizedFilters();
        if (list.some(f => f.u === u)) return false;
        const legacy = list.find(f => !f.u && t && f.t === t && f.a === a);
        if (legacy) legacy.u = u;
        else list.push({ u, t, a });
        const ok = storageSet(FIRST_MSG_FILTER_KEY, list);
        if (ok) pushFilters({ addUsers: [{ u, t, a }] });
        return ok;
    }

    function removeFirstMessageFilter(uid, text, avatarHash) {
        const u = (uid || '').trim();
        const t = (text || '').trim();
        const a = avatarHash || '';
        const next = getNormalizedFilters().filter(f => {
            if (u && f.u === u) return false;
            if (!u && t && !f.u && f.t === t && f.a === a) return false;
            return true;
        });
        const ok = storageSet(FIRST_MSG_FILTER_KEY, next);
        if (ok) pushFilters({ removeUsers: [{ u, t, a }] });
        return ok;
    }

    function forgetFirstMessageFilter(uid, text, avatarHash) {
        const u = (uid || '').trim();
        const t = (text || '').trim();
        const a = avatarHash || '';
        const next = getNormalizedFilters().filter(f => {
            if (u && f.u === u) return false;
            if (t && !f.u && f.t === t && f.a === a) return false;
            return true;
        });
        const ok = storageSet(FIRST_MSG_FILTER_KEY, next);
        if (ok) pushFilters({ removeUsers: [{ u, t, a, forget: true }] });
        return ok;
    }

    function stampFilterUid(text, avatarHash, uid) {
        const u = (uid || '').trim();
        if (!u || firstFilterHit(getNormalizedFilters(), u, '', '')) return;
        const list = getNormalizedFilters();
        const legacy = list.find(f => firstFilterHit([f], '', text, avatarHash));
        if (!legacy || legacy.u) return;
        legacy.u = u;
        storageSet(FIRST_MSG_FILTER_KEY, list);
        pushFilters({ addUsers: [{ u, t: legacy.t, a: legacy.a }] });
    }

    function clearFirstMessageFilters() {
        const ok = storageSet(FIRST_MSG_FILTER_KEY, []);
        if (ok) pushFilters({ clearUsers: true });
        return ok;
    }

    function mergeStoredUsers(incoming) {
        const list = getNormalizedFilters();
        const seen = new Set(list.map(f => f.u ? `u\0${f.u}` : `t\0${f.t}\0${f.a}`));
        let added = 0;
        for (const item of incoming) {
            const f = normalizeFilter(item);
            if (!f || (!f.u && TYPING_RE.test(f.t))) continue;
            if (f.u && TYPING_RE.test(f.t)) f.t = '';
            const key = f.u ? `u\0${f.u}` : `t\0${f.t}\0${f.a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push(f);
            added++;
        }
        if (added) storageSet(FIRST_MSG_FILTER_KEY, list);
        return added;
    }

    function paintRememberButton(btn, on) {
        btn.style.cssText = `
            flex-shrink:0;align-self:center;margin:0 6px;padding:0;
            width:18px;height:18px;box-sizing:border-box;
            border:1.5px solid ${on ? '#4CAF50' : 'rgba(255,255,255,0.5)'};
            border-radius:4px;background:${on ? '#4CAF50' : 'transparent'};
            cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
        `;
        btn.innerHTML = on
            ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '';
        btn.setAttribute('role', 'checkbox');
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.title = on ? '已過濾這個人，再點取消' : '過濾這個人';
    }

    function syncRememberButtons() {
        document.querySelectorAll('.knock-remember-first, .knock-remember-first-saved').forEach(btn => {
            const uid = decodeURIComponent(btn.dataset.filterUid || '');
            const text = decodeURIComponent(btn.dataset.filterText || '');
            const avatarHash = decodeURIComponent(btn.dataset.filterAvatar || '');
            paintRememberButton(btn, isFirstMessageFiltered(uid, text, avatarHash));
        });
        const badge = el('knock-filter-count');
        if (badge) badge.textContent = String(getNormalizedFilters().length);
    }

    function toggleFirstMessageFilter(uid, text, avatarHash) {
        const u = (uid || '').trim();
        const t = (text || '').trim();
        const a = avatarHash || '';
        if (!u) {
            showToast('讀不到對方 id，無法記住');
            return false;
        }
        if (isFirstMessageFiltered(u, t, a)) {
            forgetFirstMessageFilter(u, t, a);
            syncRememberButtons();
            showToast('已從過濾移除');
            return false;
        }
        if (addFirstMessageFilter(u, t, a)) {
            skipFirstFilterFor = u;
            pendingForcedLeave = false;
            namePartnerFromOpening(u, t);
            syncRememberButtons();
            if (el('knock-first-filter-manager')) refreshFirstFilterManager();
            showToast('已加入使用者過濾');
            return true;
        }
        return false;
    }

    function openingLineName(text, existing) {
        const name = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!name || existing || /^https?:\/\//.test(name)) return '';
        return name;
    }

    function namePartnerFromOpening(uid, text) {
        const name = openingLineName(text, currentConversation.label);
        if (!uid || !name) return;
        if (!currentConversation.partnerUid) {
            const first = findFirstOtherMessage();
            if (first && first.uid === uid) currentConversation.partnerUid = uid;
        }
        if (!currentConversation.partnerUid || currentConversation.partnerUid === uid) {
            currentConversation.partnerUid = currentConversation.partnerUid || uid;
            currentConversation.label = name;
            paintPartnerCaption();
        }
    }

    function partnerNameFromLines(opening, firstLine, existing) {
        if (String(existing || '').trim()) return '';
        return openingLineName(opening, '') || openingLineName(firstLine, '');
    }

    function autoNamePartner() {
        if (nameSet || currentPartnerName()) return;
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return;
        const opening = findFirstOtherMessage();
        let firstLine = '';
        for (const li of list.querySelectorAll('li.message-li')) {
            if (isMyMessageLi(li) || (opening && li === opening.li)) continue;
            const messageDiv = li.querySelector('div[data-test="message"]');
            if (!messageDiv) continue;
            const text = getMessageText(messageDiv);
            if (!text || TYPING_RE.test(text)) continue;
            firstLine = text;
            break;
        }
        const name = partnerNameFromLines(opening && opening.filterKey, firstLine, currentConversation.label);
        if (!name) return;
        currentConversation.label = name;
        paintPartnerCaption();
    }

    // --- 大頭貼過濾（只記網址；勾選疊在頭像上，不包頭像） ---
    function normalizeAvatarFilter(item) {
        const u = String(item && typeof item === 'object' ? (item.u ?? item.url ?? '') : item || '').trim();
        return u || null;
    }

    function getAvatarFilters() {
        return storageGet(AVATAR_FILTER_KEY, []).map(normalizeAvatarFilter).filter(Boolean);
    }

    function isAvatarFiltered(url) {
        const u = (url || '').trim();
        return !!u && getAvatarFilters().includes(u);
    }

    function addAvatarFilter(url) {
        const u = (url || '').trim();
        if (!u) return false;
        const list = getAvatarFilters();
        if (list.includes(u)) return false;
        list.push(u);
        const ok = storageSet(AVATAR_FILTER_KEY, list);
        if (ok) pushFilters({ addAvatars: [u] });
        return ok;
    }

    function removeAvatarFilter(url) {
        const u = (url || '').trim();
        const ok = storageSet(AVATAR_FILTER_KEY, getAvatarFilters().filter(x => x !== u));
        if (ok) pushFilters({ removeAvatars: [u] });
        return ok;
    }

    function clearAvatarFilters() {
        const ok = storageSet(AVATAR_FILTER_KEY, []);
        if (ok) pushFilters({ clearAvatars: true });
        return ok;
    }

    function mergeStoredAvatars(incoming) {
        const list = getAvatarFilters();
        const seen = new Set(list);
        let added = 0;
        for (const item of incoming) {
            const u = normalizeAvatarFilter(item);
            if (!u || seen.has(u)) continue;
            seen.add(u);
            list.push(u);
            added++;
        }
        if (added) storageSet(AVATAR_FILTER_KEY, list);
        return added;
    }

    function paintAvatarFilterButton(btn, on) {
        const left = btn.style.left;
        const top = btn.style.top;
        const onAvatar = !btn.classList.contains('knock-remember-avatar-saved') && left && top;
        btn.style.cssText = `
            position:absolute;z-index:2;margin:0;padding:0;
            width:16px;height:16px;box-sizing:border-box;
            border:1.5px solid ${on ? '#4CAF50' : 'rgba(255,255,255,0.85)'};
            border-radius:4px;background:${on ? '#4CAF50' : 'rgba(0,0,0,0.45)'};
            cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
            ${onAvatar ? `left:${left};top:${top};right:auto;bottom:auto;` : 'right:0;bottom:0;'}
        `;
        btn.innerHTML = on
            ? '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '';
        btn.setAttribute('role', 'checkbox');
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.title = on ? '已記住大頭貼，再點取消' : '記住大頭貼';
    }

    function syncAvatarFilterButtons() {
        document.querySelectorAll('.knock-remember-avatar, .knock-remember-avatar-saved').forEach(btn => {
            const url = decodeURIComponent(btn.dataset.avatarUrl || '');
            paintAvatarFilterButton(btn, !!(url && isAvatarFiltered(url)));
        });
        const badge = el('knock-avatar-filter-count');
        if (badge) badge.textContent = String(getAvatarFilters().length);
    }

    function toggleAvatarFilter(url) {
        const u = (url || '').trim();
        if (!u) return false;
        if (isAvatarFiltered(u)) {
            removeAvatarFilter(u);
            syncAvatarFilterButtons();
            showToast('已從大頭貼過濾移除');
            return false;
        }
        if (addAvatarFilter(u)) {
            const first = findFirstOtherMessage();
            skipFirstFilterFor = first ? pairingIdOf(first) : u;
            pendingForcedLeave = false;
            syncAvatarFilterButtons();
            showToast('已加入大頭貼過濾');
            return true;
        }
        return false;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // --- 訊息與日期 ---
    function isMyMessageLi(messageLi) {
        const container = messageLi.querySelector('div[class*="jss"]');
        if (!container) return false;
        const cls = container.classList.toString();
        return window.getComputedStyle(container).flexDirection === 'row-reverse' ||
            cls.includes('jss630') || cls.includes('jss94');
    }

    function getAvatarUrl(messageLi) {
        const img = messageLi.querySelector('div[data-test="user-avatar"] img, img.MuiAvatar-img');
        return img ? img.src : null;
    }

    // ponytail: 只讀頁面 MessageList 已帶的 sentBy。舊對話沒記過 uid 的對不到，要這次之後再遇到才會出現按鈕
    function messageSentBy(messageLi) {
        const key = Object.keys(messageLi).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        const id = (String(messageLi.className || '').match(/message-li-(\S+)/) || [])[1];
        let fiber = key ? messageLi[key] : null;
        for (let n = 0; fiber && n < 16; n++, fiber = fiber.return) {
            const msgs = fiber.memoizedProps && fiber.memoizedProps.messages;
            if (!Array.isArray(msgs)) continue;
            const msg = id ? msgs.find(m => m && m.id === id) : null;
            if (msg && msg.sentBy) return String(msg.sentBy);
        }
        return '';
    }

    function typingSentBy(messageLi) {
        const key = Object.keys(messageLi).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        let fiber = key ? messageLi[key] : null;
        for (let n = 0; fiber && n < 12; n++, fiber = fiber.return) {
            const props = fiber.memoizedProps;
            if (!props) continue;
            if (props.sentBy) return String(props.sentBy);
            const msgs = props.messages;
            if (!Array.isArray(msgs)) continue;
            const hit = msgs.find(m => m && m.sentBy && (m.type === 'typing' || TYPING_RE.test(m.text || '')));
            if (hit) return String(hit.sentBy);
        }
        return '';
    }

    function notePartnerFromList() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) {
            syncUnnamedChip();
            return;
        }
        for (const li of list.querySelectorAll('li.message-li')) {
            if (isMyMessageLi(li)) continue;
            otherPartySeen = true;
            if (currentConversation.partnerUid) break;
            const messageDiv = li.querySelector('div[data-test="message"]');
            const text = messageDiv ? getMessageText(messageDiv) : '';
            const uid = TYPING_RE.test(text) ? (typingSentBy(li) || messageSentBy(li)) : messageSentBy(li);
            if (!uid) continue;
            currentConversation.partnerUid = uid;
            break;
        }
        autoNamePartner();
        syncUnnamedChip();
    }

    function syncUnnamedChip() {
        const show = otherPartySeen && !currentPartnerName() && document.querySelector('ul[data-test="messages"]');
        let chip = el('knock-unnamed-chip');
        if (!show) {
            chip?.remove();
            return;
        }
        if (chip) return;
        chip = document.createElement('button');
        chip.id = 'knock-unnamed-chip';
        chip.type = 'button';
        chip.textContent = '未命名';
        chip.style.cssText = `position:fixed;bottom:120px;left:50%;transform:translateX(-50%);z-index:10001;font-family:${FONT};font-size:14px;color:#ffb74d;background:rgba(0,0,0,0.82);border:none;border-radius:16px;padding:8px 16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.35);`;
        chip.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!currentConversation.id) return;
            nameCurrentPartner();
        });
        document.body.appendChild(chip);
    }

    function currentPartnerName() {
        return String(currentConversation.label || '').trim();
    }

    function nameCurrentPartner() {
        if (!currentConversation.id) return;
        const next = prompt('替這位命名。空白表示清除。', currentConversation.label || '');
        if (next == null) return;
        nameSet = true;
        currentConversation.label = next.trim().slice(0, 40);
        paintPartnerCaption();
        showToast(currentConversation.label ? `已命名為 ${currentConversation.label}` : '已清除命名');
    }

    function senderAvatar(li) {
        const message = li.querySelector('div[data-test="message"]');
        for (const avatar of li.querySelectorAll('[data-test="user-avatar"]')) {
            if (message && message.contains(avatar)) continue;
            return avatar;
        }
        return null;
    }

    function clearPartnerCaption(li) {
        li.querySelectorAll('.knock-partner-name').forEach(tag => tag.remove());
        for (const host of li.querySelectorAll('.knock-avatar-col')) {
            const avatar = host.querySelector('[data-test="user-avatar"]');
            if (avatar) host.replaceWith(avatar);
            else host.remove();
        }
    }

    // 同一人連續發話時頭像高度會被收成 0。那種不要掛名稱，否則名稱會浮在訊息前面。
    function avatarShown(avatar) {
        const style = getComputedStyle(avatar);
        const height = parseFloat(style.height);
        const maxHeight = parseFloat(style.maxHeight);
        return style.display !== 'none' && style.visibility !== 'hidden' && height > 0 && maxHeight !== 0;
    }

    function paintPartnerCaption() {
        const name = currentPartnerName();
        const shown = name || '未命名';
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return;
        for (const li of list.querySelectorAll('li.message-li')) {
            const avatar = isMyMessageLi(li) ? null : senderAvatar(li);
            if (!avatar || !avatarShown(avatar)) {
                clearPartnerCaption(li);
                continue;
            }
            let host = avatar.parentElement;
            if (!host || !host.classList.contains('knock-avatar-col')) {
                host = document.createElement('div');
                host.className = 'knock-avatar-col';
                host.style.cssText = 'display:flex;flex-direction:column;align-items:center;flex:0 0 auto;width:3em;max-width:4.2em;';
                avatar.before(host);
                host.appendChild(avatar);
            }
            let tag = host.querySelector('.knock-partner-name');
            if (!tag) {
                tag = document.createElement('div');
                tag.className = 'knock-partner-name';
                tag.style.cssText = 'margin-top:2px;font-size:10px;line-height:1.2;color:#ffb74d;text-align:center;word-break:break-all;max-width:4.2em;cursor:pointer;';
                tag.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!currentConversation.id) return;
                    nameCurrentPartner();
                });
                host.appendChild(tag);
            }
            if (tag.textContent !== shown) tag.textContent = shown;
        }
        syncUnnamedChip();
    }

    // 引用區裡才有另一個頭像。往上找到同時有「不含頭像的正文」的那一層。
    function replySplit(messageDiv) {
        const avatar = messageDiv.querySelector('[data-test="user-avatar"]');
        if (!avatar) return null;
        let node = avatar;
        while (node.parentElement && messageDiv.contains(node.parentElement)) {
            const parent = node.parentElement;
            const body = Array.from(parent.children).find(el =>
                el !== node && !el.contains(avatar) && el.textContent.trim() && !el.querySelector('[data-test="date"]')
            );
            if (body && node !== avatar) return { quote: node, body };
            node = parent;
        }
        return null;
    }

    function getMessageQuote(messageDiv) {
        const split = replySplit(messageDiv);
        if (!split) return '';
        const clone = split.quote.cloneNode(true);
        clone.querySelectorAll('[data-test="user-avatar"]').forEach(el => el.remove());
        const text = clone.textContent.replace(/\[unknown\]/g, '').replace(/\(未知對象\)/g, '').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 200);
        const img = Array.from(split.quote.querySelectorAll('img')).find(el => !el.closest('[data-test="user-avatar"]'));
        return img ? '圖片' : '';
    }

    function getMessageText(messageDiv) {
        const split = replySplit(messageDiv);
        const root = split ? split.body : messageDiv;
        if (!split) {
            const timeEl = messageDiv.querySelector('span[data-test="date"]');
            if (!timeEl) return messageDiv.textContent.trim();
        }
        const clone = root.cloneNode(true);
        clone.querySelector('div[style*="grid-area: date"]')?.remove();
        clone.querySelectorAll('[data-test="message-image"]').forEach(el => el.remove());
        return clone.textContent.trim();
    }

    function getMessageImages(messageDiv) {
        const split = replySplit(messageDiv);
        const root = split ? split.body : messageDiv;
        return Array.from(root.querySelectorAll('[data-test="message-image"] img'))
            .map(img => img.currentSrc || img.src)
            .filter(src => src && /^https?:\/\//.test(src));
    }

    function ymd(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function shiftYmd(days, from = new Date()) {
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + days);
        return ymd(d);
    }

    function clockMinutesOnly(timeStr) {
        if (!timeStr) return null;
        const m = /(\d{1,2}):(\d{2})/.exec(timeStr);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    }

    function formatMessageStamp(msg) {
        if (!msg || !msg.timestamp) return '';
        if (clockMinutesOnly(msg.timestamp) == null) return String(msg.timestamp).slice(0, 32);
        const day = msg.date ? String(msg.date).slice(0, 10).replace(/-/g, '/') + ' ' : '';
        return (day + msg.timestamp).slice(0, 32);
    }

    function parseKnockDateLabel(timeStr, now = new Date()) {
        if (!timeStr) return '';
        if (timeStr.includes('前天')) return shiftYmd(-2, now);
        if (timeStr.includes('昨天')) return shiftYmd(-1, now);
        let m = /(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/.exec(timeStr);
        if (m) return ymd(new Date(+m[1], +m[2] - 1, +m[3]));
        m = /(\d{1,2})月(\d{1,2})日/.exec(timeStr);
        if (m) {
            const d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
            if (d > now) d.setFullYear(d.getFullYear() - 1);
            return ymd(d);
        }
        m = /(\d{1,2})\/(\d{1,2})/.exec(timeStr);
        if (m && clockMinutesOnly(timeStr) == null) {
            const d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
            if (d > now) d.setFullYear(d.getFullYear() - 1);
            return ymd(d);
        }
        return '';
    }

    function labelDayOffset(timeStr) {
        if (!timeStr) return null;
        if (timeStr.includes('前天')) return 2;
        if (timeStr.includes('昨天')) return 1;
        return null;
    }

    // 由新到舊：最新一則鐘點比現在還晚（23:20 vs 00:20）先當昨天；再遇到往回跳過 12 小時再跨一日
    function dayOffsetsFromNewest(rows, now = new Date()) {
        const nowClock = now.getHours() * 60 + now.getMinutes();
        const newest = rows[rows.length - 1];
        let dayOffset = newest && newest.labeled == null && newest.clock > nowClock ? 1 : 0;
        let lastClock = null;
        const out = new Array(rows.length);
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (row.labeled != null) dayOffset = row.labeled;
            else if (lastClock != null && row.clock > lastClock + 12 * 60) dayOffset += 1;
            out[i] = dayOffset;
            lastClock = row.clock;
        }
        return out;
    }

    function listMessageDates(list) {
        const rows = [];
        for (const li of list.querySelectorAll('li.message-li')) {
            const timeEl = li.querySelector('span[data-test="date"]');
            const timeStr = timeEl ? timeEl.textContent.trim() : '';
            if (!timeStr) continue;
            rows.push({
                li,
                clock: clockMinutesOnly(timeStr),
                labeled: labelDayOffset(timeStr),
                parsedDate: parseKnockDateLabel(timeStr)
            });
        }
        const clocked = rows.filter(r => r.clock != null);
        const offsets = dayOffsetsFromNewest(clocked.map(r => ({ clock: r.clock, labeled: r.labeled })));
        const dates = new Map();
        let i = 0;
        for (const row of rows) {
            if (row.clock != null) dates.set(row.li, shiftYmd(-offsets[i++]));
            else if (row.parsedDate) dates.set(row.li, row.parsedDate);
        }
        return dates;
    }

    function hashMessage(text, imageUrls, isMyMessage, clockOrDate) {
        return hashString(`${text || ''}|${(imageUrls || []).join(',')}|${!!isMyMessage}|${clockOrDate ?? ''}`);
    }

    function stableImageKey(url) {
        const s = String(url || '');
        if (!s || s.startsWith('data:')) return '';
        return s.split('#')[0].split('?')[0];
    }

    function imageMessageSig(msg) {
        const keys = (msg.imageKeys && msg.imageKeys.length)
            ? msg.imageKeys
            : (msg.imageUrls || []).map(stableImageKey).filter(Boolean);
        if (!keys.length) return '';
        return `${msg.text || ''}|${keys.join(',')}|${!!msg.isMyMessage}|${clockMinutesOnly(msg.timestamp) ?? ''}`;
    }

    function dropDuplicateImages(messages) {
        const best = new Map();
        const out = [];
        for (const m of messages || []) {
            const sig = imageMessageSig(m);
            if (!sig) {
                out.push(m);
                continue;
            }
            const prev = best.get(sig);
            if (!prev) {
                best.set(sig, m);
                out.push(m);
                continue;
            }
            const prevData = (prev.imageUrls || []).some(u => String(u).startsWith('data:'));
            const nextData = (m.imageUrls || []).some(u => String(u).startsWith('data:'));
            if (!prevData && nextData) {
                out[out.indexOf(prev)] = m;
                best.set(sig, m);
            }
        }
        return out;
    }

    function gmRequest(details) {
        const xhr = typeof GM_xmlhttpRequest === 'function'
            ? GM_xmlhttpRequest
            : (typeof GM !== 'undefined' && GM.xmlHttpRequest);
        if (!xhr) return Promise.reject(new Error('no gm xhr'));
        return new Promise((resolve, reject) => {
            xhr({
                ...details,
                onload: resolve,
                onerror: () => reject(new Error('gm xhr')),
                ontimeout: () => reject(new Error('gm xhr timeout'))
            });
        });
    }

    async function fetchImageBlob(url) {
        try {
            const res = await fetch(url, { credentials: 'omit' });
            if (res.ok) {
                const blob = await res.blob();
                if (blob && blob.size) return blob;
            }
        } catch (e) { /* 改走 GM，避開圖片 CDN 的 CORS */ }
        const res = await gmRequest({ method: 'GET', url, responseType: 'blob' });
        if (!res || res.status !== 200 || !res.response) throw new Error('image');
        return res.response;
    }

    async function blobToDataUrl(blob) {
        // ponytail: 超過約 400KB 才縮成寬 960 的 jpeg，遠端才收得下
        if (blob.size > 400 * 1024 && typeof createImageBitmap === 'function') {
            try {
                const bitmap = await createImageBitmap(blob);
                const scale = Math.min(1, 960 / bitmap.width);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                if (bitmap.close) bitmap.close();
                return canvas.toDataURL('image/jpeg', 0.8);
            } catch (e) { /* 改存原圖 */ }
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    function dataUrlToBlob(dataUrl) {
        const parts = String(dataUrl || '').split(',');
        const mime = ((parts[0] || '').match(/:(.*?);/) || [])[1] || 'image/jpeg';
        const bin = atob(parts[1] || '');
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }

    function collectMessage(messageLi, date) {
        const messageDiv = messageLi.querySelector('div[data-test="message"]');
        if (!messageDiv) return;

        const isMyMessage = isMyMessageLi(messageLi);
        const timeElement = messageDiv.querySelector('span[data-test="date"]');
        const timestamp = timeElement ? timeElement.textContent.trim() : null;
        date = date || parseKnockDateLabel(timestamp) || '';
        const messageText = getMessageText(messageDiv);
        const quote = getMessageQuote(messageDiv);
        const imageUrls = getMessageImages(messageDiv);
        if (TYPING_RE.test(messageText)) return;
        if (!messageText && !imageUrls.length && !quote) return;

        const clock = clockMinutesOnly(timestamp);
        const domId = (String(messageLi.className || '').match(/message-li-(\S+)/) || [])[1] || '';
        if (messageText === '已收回一則訊息' && !imageUrls.length && noteRecalledLocal(domId, quote, date)) return;
        const imageKeys = imageUrls.map(stableImageKey).filter(Boolean);
        const imageSig = imageKeys.length
            ? `${messageText}|${imageKeys.join(',')}|${isMyMessage}|${clock ?? ''}`
            : '';
        if (imageSig) {
            const existingImg = currentConversation.messages.find(m =>
                (domId && (m.domId === domId || m.id === domId)) || imageMessageSig(m) === imageSig
            );
            if (existingImg) {
                if (quote) existingImg.quote = quote;
                if (domId) existingImg.domId = domId;
                existingImg.imageKeys = imageKeys;
                if (date && existingImg.date !== date) existingImg.date = date;
                currentConversation.messages = dropDuplicateImages(currentConversation.messages);
                return;
            }
        }
        const content = `${messageText}|${imageKeys.join(',')}|${isMyMessage}`;
        if (clock == null && timestamp) {
            const existingByContent = currentConversation.messages.find(m =>
                m.timestamp && `${m.text || ''}|${(m.imageUrls || []).join(',')}|${!!m.isMyMessage}` === content
            );
            if (existingByContent) {
                if (quote) existingByContent.quote = quote;
                if (date && existingByContent.date !== date) existingByContent.date = date;
                return;
            }
        }
        const messageHash = imageKeys.length
            ? (domId || hashMessage(messageText, imageKeys, isMyMessage, clock ?? date))
            : hashMessage(messageText, [], isMyMessage, clock ?? date);
        const existing = currentConversation.messages.find(m => m.id === messageHash);
        if (existing) {
            if (quote) existing.quote = quote;
            if (domId) existing.domId = domId;
            if (imageKeys.length) existing.imageKeys = imageKeys;
            if (date && existing.date !== date) existing.date = date;
            return;
        }

        const message = {
            id: messageHash,
            text: messageText,
            quote,
            imageUrls,
            imageKeys,
            domId,
            isMyMessage,
            avatarUrl: getAvatarUrl(messageLi),
            timestamp,
            date,
            seq: currentConversation.messages.length,
            collectedAt: new Date().toISOString()
        };
        currentConversation.messages.push(message);
        console.log('收集訊息:', messageText || '[圖片]', imageKeys.length);
    }

    // --- 離開與重連 ---
    function findButtons() {
        return Array.from(document.querySelectorAll('button'));
    }

    function isRematchButton(button) {
        return button.textContent.includes('對方已離開聊天，點我重新配對');
    }

    function isConfirmExitButton(button) {
        return button.textContent.includes('確定') && button.getAttribute('data-test') === 'ok';
    }

    function isStartChatButton(button) {
        return button.textContent.includes('開始聊天');
    }

    function checkConversationEnd() {
        if (currentConversation.ended) return;
        const conversationEnded = findButtons().some(b => isRematchButton(b) || isConfirmExitButton(b));
        if (!conversationEnded || currentConversation.messages.length === 0) return;
        currentConversation.ended = true;
        currentConversation.endTime = currentConversation.endTime || new Date().toISOString();
        if (isAutoClicking()) {
            markPendingStartChat(findButtons().some(isRematchButton) ? 'otherLeft' : pendingForcedLeave ? undefined : 'selfLeft');
        }
    }

    function getMyAvatarUrl() {
        if (myAvatarUrl) return myAvatarUrl;
        const messagesList = document.querySelector('ul[data-test="messages"]');
        if (!messagesList) return null;
        for (const messageLi of messagesList.querySelectorAll('li.message-li')) {
            if (!isMyMessageLi(messageLi)) continue;
            const src = getAvatarUrl(messageLi);
            if (src) {
                myAvatarUrl = src;
                return myAvatarUrl;
            }
        }
        return null;
    }

    function isStockAvatar(url) {
        return /\/users-common(%2F|\/)avatars(%2F|\/)/i.test(url || '');
    }

    // 預設圖只認檔名。男女與其他預設圖各存一份，不把對方網址送到遠端頁。
    function stockAvatarFile(url) {
        if (!isStockAvatar(url)) return '';
        const key = stableImageKey(url);
        const encoded = 'avatars%2F';
        const plain = 'avatars/';
        let file = '';
        const at = key.indexOf(encoded);
        if (at !== -1) file = key.slice(at + encoded.length);
        else {
            const slash = key.toLowerCase().indexOf(plain);
            if (slash !== -1) file = key.slice(slash + plain.length);
        }
        if (!file) return '';
        try { file = decodeURIComponent(file); } catch (e) { return ''; }
        file = file.toLowerCase();
        if (!/^[a-z0-9-]{1,40}\.(svg|png|jpe?g)$/.test(file)) return '';
        return file;
    }

    function stockAvatarId(url) {
        const file = stockAvatarFile(url);
        return file ? relayImageId('stock:' + file) : '';
    }

    function openingAvatar(li, url) {
        const stock = stockAvatarId(url);
        if (stock) return stock;
        if (!url && li && li.querySelector('[data-test="fallback-avatar"]')) return 'plain';
        return url ? relayImageId(url) : '';
    }

    function checkAvatarMatch(otherMessageLi) {
        const myAvatar = getMyAvatarUrl();
        const otherAvatar = getAvatarUrl(otherMessageLi);
        // ponytail: 預設男女頭像很多人同一張，共同話題配對一回覆就會被當成自己
        return !!(myAvatar && otherAvatar && myAvatar === otherAvatar && !isStockAvatar(myAvatar));
    }

    function simulateMouseClick(element) {
        if (!element) return false;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // ponytail: 不傳 view。TM 沙箱的 window 是 Proxy，new MouseEvent({view:window}) 會丟，後面的 click() 就不會跑
        const opts = { bubbles: true, cancelable: true, button: 0 };
        for (const type of ['mousedown', 'mouseup', 'click']) {
            try { element.dispatchEvent(new MouseEvent(type, opts)); } catch (e) {}
        }
        try { element.click(); } catch (e) { console.warn('直接點擊失敗:', e); }
        return true;
    }

    function markPendingStartChat(reason) {
        sessionStorage.setItem(PENDING_START_CHAT_KEY, Date.now().toString());
        if (reason && !sessionStorage.getItem(PENDING_START_CHAT_REASON_KEY)) {
            sessionStorage.setItem(PENDING_START_CHAT_REASON_KEY, reason);
        }
    }

    function isPendingStartChat() {
        const ts = Number(sessionStorage.getItem(PENDING_START_CHAT_KEY));
        if (!ts || Date.now() - ts > PENDING_START_CHAT_TTL_MS) {
            clearPendingStartChat();
            return false;
        }
        return true;
    }

    function clearPendingStartChat() {
        sessionStorage.removeItem(PENDING_START_CHAT_KEY);
        sessionStorage.removeItem(PENDING_START_CHAT_REASON_KEY);
        sessionStorage.removeItem(PENDING_FILTER_NAME_KEY);
    }

    function cooldownReasonText(reasonKey, name) {
        const reason = START_CHAT_REASON_LABEL[reasonKey];
        if (!reason) return '開始聊天';
        const n = String(name || '').trim();
        if (reasonKey === 'firstFilter' && n) return `開始聊天 · 過濾了 ${n}`;
        return `開始聊天 · ${reason}`;
    }

    function startChatCooldownLabel() {
        return cooldownReasonText(
            sessionStorage.getItem(PENDING_START_CHAT_REASON_KEY),
            sessionStorage.getItem(PENDING_FILTER_NAME_KEY)
        );
    }

    function filterPromptName(uid, text) {
        const note = uid ? String((getNormalizedFilters().find(f => f.u === uid) || {}).t || '') : '';
        const raw = (note || text || '').trim().replace(/\s+/g, ' ');
        if (!raw || /^https?:\/\//.test(raw)) return '';
        return raw.slice(0, 40);
    }

    function hideCooldown() {
        cooldownUntil = 0;
        cooldownLabel = '';
        if (cooldownTick) {
            clearInterval(cooldownTick);
            cooldownTick = null;
        }
        el('knock-cooldown')?.remove();
    }

    function showCooldown(label, ms) {
        cooldownLabel = label;
        cooldownUntil = Date.now() + ms;
        const paint = () => {
            const left = cooldownUntil - Date.now();
            if (left <= 0) {
                hideCooldown();
                return;
            }
            let node = el('knock-cooldown');
            if (!node && document.body) {
                node = document.createElement('div');
                node.id = 'knock-cooldown';
                node.style.cssText = `position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:10006;background:rgba(0,0,0,0.78);color:#fff;font-family:${FONT};font-size:13px;padding:6px 14px;border-radius:16px;pointer-events:none;letter-spacing:0.04em;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,0.35);`;
                document.body.appendChild(node);
            }
            if (node) node.textContent = `${cooldownLabel} ${Math.ceil(left / 1000)}`;
        };
        paint();
        if (!cooldownTick) cooldownTick = setInterval(paint, 100);
    }

    function checkForButtonAndClick() {
        if (!isAutoClicking()) return;

        for (const button of findButtons()) {
            if (isStartChatButton(button) && isPendingStartChat()) {
                if (!startChatScheduled) {
                    startChatScheduled = true;
                    showCooldown(startChatCooldownLabel(), 2000);
                    setTimeout(() => {
                        startChatScheduled = false;
                        hideCooldown();
                        if (!isAutoClicking() || !isPendingStartChat()) return;
                        const btn = findButtons().find(isStartChatButton);
                        if (btn) {
                            console.log('倒數結束，點擊「開始聊天」...');
                            clearPendingStartChat();
                            skipFirstFilterFor = null;
                            simulateMouseClick(btn);
                            initNewConversation();
                        }
                    }, 2000);
                }
                return;
            }

            if (isRematchButton(button)) {
                markPendingStartChat('otherLeft');
                checkConversationEnd();
                if (!rematchScheduled) {
                    rematchScheduled = true;
                    showCooldown('重新配對', 3000);
                    setTimeout(() => {
                        rematchScheduled = false;
                        hideCooldown();
                        if (!isAutoClicking()) return;
                        const btn = findButtons().find(isRematchButton);
                        if (btn) {
                            simulateMouseClick(btn);
                            setTimeout(initNewConversation, 1000);
                        }
                    }, 3000);
                }
                return;
            }

            if (isConfirmExitButton(button)) {
                checkConversationEnd();
                markPendingStartChat(pendingForcedLeave ? undefined : 'selfLeft');
                simulateMouseClick(button);
                console.log('已記下「開始聊天」，等待頁面重整...');
                return;
            }
        }
    }

    function isAutoClicking() {
        // ponytail: 重整／重新配對會清掉記憶體旗標；session 裡的 firstFilter 撐到開始聊天
        return autoClickEnabled || forceAutoUntilIdle
            || sessionStorage.getItem(PENDING_START_CHAT_REASON_KEY) === 'firstFilter';
    }

    function requestForcedLeave(reason, filterName) {
        if (!autoClickEnabled && reason !== 'firstFilter') return;
        if (reason === 'firstFilter') forceAutoUntilIdle = true;
        if (!pendingForcedLeave) {
            pendingForcedLeave = true;
            const firstMark = reason && !sessionStorage.getItem(PENDING_START_CHAT_REASON_KEY);
            if (firstMark && reason === 'firstFilter') {
                const n = String(filterName || '').trim();
                if (n) sessionStorage.setItem(PENDING_FILTER_NAME_KEY, n);
                else sessionStorage.removeItem(PENDING_FILTER_NAME_KEY);
            }
            markPendingStartChat(reason);
            console.log('已記下要離開，等待退出按鈕:', reason, filterName || '');
        }
        tryForcedLeave();
    }

    function tryForcedLeave() {
        if (!pendingForcedLeave || !isAutoClicking()) return false;
        if (findButtons().some(isConfirmExitButton)) {
            checkForButtonAndClick();
            return true;
        }
        const exitButton = document.querySelector('button[data-test="chat-exit-button"]');
        if (!exitButton) return false;
        if (Date.now() - lastExitClickAt < 400) return true;
        lastExitClickAt = Date.now();
        console.log('找到退出按鈕，點擊中...');
        simulateMouseClick(exitButton);
        checkForButtonAndClick();
        return true;
    }

    function activelyLeaveConversation(messageId) {
        if (messageId) checkedMessages.add(messageId);
        requestForcedLeave('selfLeft');
        return pendingForcedLeave;
    }

    function pairingIdOf(first) {
        const unique = String(first.li.className || '').match(/message-li-(\S+)/);
        return unique ? unique[1] : `${first.filterKey}|${first.messageId}`;
    }

    function findFirstOtherMessage() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return null;
        for (const li of list.querySelectorAll('li.message-li')) {
            if (isMyMessageLi(li)) continue;
            const messageDiv = li.querySelector('div[data-test="message"]');
            if (!messageDiv || messageDiv.querySelector('span[data-test="date"]')) continue;
            const text = getMessageText(messageDiv);
            const imageUrls = getMessageImages(messageDiv);
            const filterKey = text || stableImageKey(imageUrls[0]) || '';
            if (!filterKey || TYPING_RE.test(text)) continue;
            const avatarUrl = getAvatarUrl(li);
            return {
                li, messageId: li.className, filterKey, imageUrls, messageDiv, avatarUrl,
                avatarHash: avatarHashOf(avatarUrl),
                uid: messageSentBy(li)
            };
        }
        return null;
    }

    function screenPartnerUid() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return '';
        for (const li of list.querySelectorAll('li.message-li')) {
            if (isMyMessageLi(li)) continue;
            const messageDiv = li.querySelector('div[data-test="message"]');
            const text = messageDiv ? getMessageText(messageDiv) : '';
            const uid = TYPING_RE.test(text) ? (typingSentBy(li) || messageSentBy(li)) : messageSentBy(li);
            if (uid) return uid;
        }
        return '';
    }

    function maybeLeaveOnFirstMessageFilter() {
        if (!firstFilterEnabled) return false;
        const first = findFirstOtherMessage();
        const uid = (first && first.uid) || screenPartnerUid();
        if (skipFirstFilterFor && (skipFirstFilterFor === uid || (first && skipFirstFilterFor === pairingIdOf(first)))) return false;
        const filters = getNormalizedFilters();
        if (uid && firstFilterHit(filters, uid, '', '')) {
            const name = filterPromptName(uid, first && first.filterKey);
            console.log('對方 id 命中過濾，準備重連:', name);
            requestForcedLeave('firstFilter', name);
            return pendingForcedLeave;
        }
        if (!first) return false;
        const legacyText = [first.filterKey, ...first.imageUrls].find(text => firstFilterHit(filters, '', text, first.avatarHash));
        if (!legacyText) return false;
        if (uid) stampFilterUid(legacyText, first.avatarHash, uid);
        const name = filterPromptName(uid, legacyText);
        console.log('舊發語詞命中過濾，準備重連:', name || legacyText);
        requestForcedLeave('firstFilter', name);
        return pendingForcedLeave;
    }

    function maybeLeaveOnAvatarFilter() {
        if (!avatarFilterEnabled) return false;
        const first = findFirstOtherMessage();
        if (!first || !first.avatarUrl) return false;
        if (skipFirstFilterFor && skipFirstFilterFor === pairingIdOf(first)) return false;
        if (!isAvatarFiltered(first.avatarUrl)) return false;
        console.log('大頭貼命中過濾，準備重連:', first.avatarUrl);
        requestForcedLeave('firstFilter');
        return pendingForcedLeave;
    }

    // --- 通知 ---
    function requestNotifyPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') return;
        Notification.requestPermission().catch(() => {});
    }

    function showBrowserNotification(body) {
        const title = 'Knock 新訊息';
        const text = (body || '你有一則新訊息').replace(/\s+/g, ' ').trim().slice(0, 80) || '你有一則新訊息';
        const details = {
            title,
            text,
            timeout: 8000,
            onclick: () => { try { window.focus(); } catch (e) {} }
        };
        // ponytail: TM 沙箱的 new Notification() 常沒畫面；GM_notification 走擴充功能權限
        try {
            if (typeof GM_notification === 'function') {
                GM_notification(details);
                return true;
            }
            if (typeof GM !== 'undefined' && typeof GM.notification === 'function') {
                GM.notification(details);
                return true;
            }
        } catch (e) {}
        if (!('Notification' in window) || Notification.permission !== 'granted') return false;
        try {
            const notification = new Notification(title, { body: text, tag: 'knock-new-message' });
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
            return true;
        } catch (e) {
            return false;
        }
    }

    async function testBrowserNotification() {
        if (showBrowserNotification('這是測試通知')) {
            showToast('已送出。沒看到的話，檢查系統通知裡的 Chrome／Tampermonkey');
            return;
        }
        if ('Notification' in window && Notification.permission === 'default') {
            try { await Notification.requestPermission(); } catch (e) {}
            if (showBrowserNotification('這是測試通知')) {
                showToast('已送出瀏覽器通知');
                return;
            }
        }
        const perm = ('Notification' in window) ? Notification.permission : '無 API';
        showToast(`送不出通知（${perm}）。請允許 Tampermonkey 與 Chrome 的通知權限`);
    }

    function getNtfyTopic() {
        return (localStorage.getItem(NTFY_TOPIC_KEY) || '').trim();
    }

    function setNtfyTopic(topic) {
        const t = (topic || '').trim();
        if (!t) {
            localStorage.removeItem(NTFY_TOPIC_KEY);
            return '';
        }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(t)) return null;
        localStorage.setItem(NTFY_TOPIC_KEY, t);
        return t;
    }

    function getNtfyTitle() {
        return (localStorage.getItem(NTFY_TITLE_KEY) || '').trim() || NTFY_TITLE_DEFAULT;
    }

    function setNtfyTitle(title) {
        const t = (title || '').trim().slice(0, 80);
        if (!t) {
            localStorage.removeItem(NTFY_TITLE_KEY);
            return NTFY_TITLE_DEFAULT;
        }
        localStorage.setItem(NTFY_TITLE_KEY, t);
        return t;
    }

    let lastNtfyAt = 0;
    let ntfyBackoffUntil = 0;

    function ntfyStatusDetail(status) {
        if (status === 429) return 'HTTP 429：ntfy.sh 公開伺服器限流，請隔一分鐘再試';
        return `HTTP ${status}`;
    }

    function sendNtfy(body, title) {
        return new Promise((resolve) => {
            const topic = getNtfyTopic();
            if (!topic) {
                resolve({ ok: false, detail: '尚未設定主題' });
                return;
            }
            if (Date.now() < ntfyBackoffUntil) {
                resolve({ ok: false, detail: 'HTTP 429：還在冷卻，請稍候再送' });
                return;
            }
            const data = JSON.stringify({
                topic,
                title: title || getNtfyTitle(),
                message: body || '你有一則新訊息'
            });
            const finish = (ok, detail, status) => {
                if (status === 429) ntfyBackoffUntil = Date.now() + 60000;
                if (ok) lastNtfyAt = Date.now();
                resolve({ ok, detail });
            };
            const xhr = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
                || (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest);
            if (xhr) {
                xhr({
                    method: 'POST',
                    url: `${NTFY_SERVER}/`,
                    headers: { 'Content-Type': 'application/json' },
                    data,
                    onload: (r) => finish(r.status >= 200 && r.status < 300, ntfyStatusDetail(r.status), r.status),
                    onerror: () => finish(false, '連線失敗：請允許腳本存取 ntfy.sh')
                });
                return;
            }
            fetch(`${NTFY_SERVER}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: data
            }).then((r) => finish(r.ok, ntfyStatusDetail(r.status), r.status))
                .catch((e) => finish(false, e.message || 'fetch 被網頁擋住'));
        });
    }

    function notifyNewMessage(text) {
        if (!notificationsArmed || (document.hasFocus() && !document.hidden)) return;
        const body = (text || '你有一則新訊息').replace(/\s+/g, ' ').trim().slice(0, 80) || '你有一則新訊息';
        if (ntfyEnabled && Date.now() - lastNtfyAt > 15000) sendNtfy(body);
        if (browserNotifyEnabled) showBrowserNotification(body);
    }

    function checkNewMessages() {
        const messagesList = document.querySelector('ul[data-test="messages"]');
        if (!messagesList) {
            syncUnnamedChip();
            return;
        }

        const dateByLi = listMessageDates(messagesList);
        const messageElements = messagesList.querySelectorAll('li.message-li');
        if (!currentConversation.id) {
            if (messageElements.length === 0) return;
            console.log('Initializing new conversation...');
            initNewConversation();
        }

        if (maybeLeaveOnFirstMessageFilter() || maybeLeaveOnAvatarFilter() || tryForcedLeave()) return;

        // ponytail: 重整／往上捲時 DOM 會一次塞進舊訊息；第一次看到列表先標已讀，之後只推最新一則
        const catchUp = !notificationsArmed;
        const lastLi = messageElements[messageElements.length - 1];
        for (const messageLi of messageElements) {
            const unique = String(messageLi.className || '').match(/message-li-(\S+)/);
            const messageId = unique ? unique[1] : messageLi.className;
            collectMessage(messageLi, dateByLi.get(messageLi) || '');
            if (checkedMessages.has(messageId)) continue;
            checkedMessages.add(messageId);

            const messageDiv = messageLi.querySelector('div[data-test="message"]');
            if (!messageDiv || isMyMessageLi(messageLi)) continue;

            const messageText = getMessageText(messageDiv);
            const imageUrls = getMessageImages(messageDiv);
            if (TYPING_RE.test(messageText)) continue;

            const notifyText = messageText || (imageUrls.length ? '[圖片]' : '');
            if (notifyText && !catchUp && messageLi === lastLi) notifyNewMessage(notifyText);

            if (checkAvatarMatch(messageLi)) {
                activelyLeaveConversation(messageId);
                return;
            }
        }
        if (messageElements.length) notificationsArmed = true;

        notePartnerFromList();
        paintPartnerCaption();
        decorateOtherMessages();
        checkConversationEnd();
    }

    function onRememberRowClick(e) {
        if (e.target.closest('a, [data-test="user-avatar"], .knock-remember-avatar, .knock-partner-name')) return;
        const first = findFirstOtherMessage();
        if (!first || first.li !== e.currentTarget) return;
        toggleFirstMessageFilter(first.uid, first.filterKey, first.avatarHash);
    }

    function decorateOtherMessages() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return;

        const first = findFirstOtherMessage();
        list.querySelectorAll('.knock-remember-first, .knock-remember-avatar').forEach(btn => {
            if (!first || !first.li.contains(btn)) btn.remove();
        });
        if (!first) return;

        const row = first.li.firstElementChild || first.li;
        let rememberBtn = first.li.querySelector('.knock-remember-first');
        if (!rememberBtn) {
            rememberBtn = document.createElement('button');
            rememberBtn.type = 'button';
            rememberBtn.className = 'knock-remember-first';
            row.appendChild(rememberBtn);
        }
        const rememberSig = `${first.uid || ''}\0${first.filterKey}\0${first.avatarHash}`;
        if (rememberBtn.dataset.knockSig !== rememberSig) {
            rememberBtn.dataset.knockSig = rememberSig;
            rememberBtn.dataset.filterUid = encodeURIComponent(first.uid || '');
            rememberBtn.dataset.filterText = encodeURIComponent(first.filterKey);
            rememberBtn.dataset.filterAvatar = encodeURIComponent(first.avatarHash);
            paintRememberButton(rememberBtn, isFirstMessageFiltered(first.uid, first.filterKey, first.avatarHash));
        }
        if (first.avatarUrl && !first.li.querySelector('.knock-remember-avatar')) {
            const avatarEl = first.li.querySelector('div[data-test="user-avatar"]');
            if (avatarEl) {
                // ponytail: 掛在列上用座標疊到頭像，不包頭像、不每輪改 DOM
                if (!row.dataset.knockRowPos) {
                    if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
                    row.dataset.knockRowPos = '1';
                }
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'knock-remember-avatar';
                btn.dataset.avatarUrl = encodeURIComponent(first.avatarUrl);
                btn.style.left = `${Math.max(0, avatarEl.offsetLeft + avatarEl.offsetWidth - 14)}px`;
                btn.style.top = `${Math.max(0, avatarEl.offsetTop + avatarEl.offsetHeight - 14)}px`;
                paintAvatarFilterButton(btn, isAvatarFiltered(first.avatarUrl));
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleAvatarFilter(decodeURIComponent(btn.dataset.avatarUrl || ''));
                });
                row.appendChild(btn);
            }
        }

        if (!first.li.dataset.knockRememberRow) {
            first.li.dataset.knockRememberRow = '1';
            first.li.style.cursor = 'pointer';
            first.li.addEventListener('click', onRememberRowClick);
        }
    }

    // --- 選單 ---
    function showToast(message) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 10005; background: rgba(0, 0, 0, 0.9); border-radius: 12px;
            padding: 20px 32px; font-family: ${FONT}; font-size: 16px; color: #fff;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); display: flex; align-items: center; gap: 12px;
        `;
        toast.innerHTML = `<span style="font-size: 24px;">✓</span><span>${message}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    function dockSwitch(on) {
        const el = document.createElement('div');
        el.style.cssText = `width:40px;height:22px;border-radius:11px;position:relative;flex-shrink:0;background:${on ? '#4CAF50' : '#555'};`;
        const knob = document.createElement('div');
        knob.style.cssText = `width:18px;height:18px;background:#fff;border-radius:50%;position:absolute;top:2px;left:${on ? '20px' : '2px'};transition:left .2s;`;
        el.append(knob);
        el.paint = (v) => {
            el.style.background = v ? '#4CAF50' : '#555';
            knob.style.left = v ? '20px' : '2px';
        };
        return el;
    }

    function dockRow(labelHtml, extra) {
        const row = document.createElement(extra && extra.button ? 'button' : 'div');
        if (extra && extra.button) row.type = 'button';
        row.style.cssText = DOCK_ROW;
        row.innerHTML = labelHtml;
        return row;
    }

    function attachDockSwitch(row, isOn, onChange, onlyKnob) {
        const sw = dockSwitch(isOn);
        sw.style.cursor = 'pointer';
        row.append(sw);
        const toggle = (e) => {
            e.stopPropagation();
            isOn = !isOn;
            onChange(isOn);
            sw.paint(isOn);
        };
        if (onlyKnob) sw.addEventListener('click', toggle);
        else row.addEventListener('click', toggle);
        return sw;
    }

    function createDock() {
        if (el('knock-dock')) return;
        OLD_FLOAT_IDS.forEach(id => el(id)?.remove());

        let open = localStorage.getItem(DOCK_OPEN_KEY) === 'true';
        const dock = document.createElement('div');
        dock.id = 'knock-dock';
        dock.style.cssText = `position:fixed;right:16px;top:16px;z-index:10000;font-family:${FONT};color:#fff;user-select:none;`;

        const header = document.createElement('button');
        header.type = 'button';
        header.id = 'knock-dock-header';
        header.style.cssText = DOCK_PANEL + 'display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;padding:10px 12px;border:none;color:#fff;font:inherit;font-size:14px;cursor:pointer;';
        header.innerHTML = '<span>Knock</span><span id="knock-dock-chevron"></span>';

        const body = document.createElement('div');
        body.id = 'knock-dock-body';
        body.style.cssText = DOCK_PANEL + 'margin-top:8px;padding:8px;display:none;flex-direction:column;gap:6px;width:220px;box-sizing:border-box;';

        const autoRow = dockRow('<span>自動開啟新對話</span>');
        attachDockSwitch(autoRow, autoClickEnabled, (v) => {
            autoClickEnabled = v;
            localStorage.setItem(AUTO_CLICK_ENABLED_KEY, String(v));
            saveRoomControls();
            requestNotifyPermission();
        });

        const relayBtn = dockRow('<span>遠端對話</span>', { button: true });
        relayBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = prompt('貼上遠端頁面的權杖。空白表示關閉。頁面是 https://knock.keeping.work', relayToken());
            if (next == null) return;
            const token = next.trim();
            if (token) localStorage.setItem(RELAY_TOKEN_KEY, token);
            else localStorage.removeItem(RELAY_TOKEN_KEY);
            showToast(token ? '已開啟遠端對話' : '已關閉遠端對話');
        });

        const filterRow = dockRow(
            `<span>使用者過濾</span><span id="knock-filter-count" style="background:#ff9800;border-radius:10px;padding:0 6px;font-size:12px;min-width:1.2em;text-align:center;">${getNormalizedFilters().length}</span>`
        );
        attachDockSwitch(filterRow, firstFilterEnabled, (v) => {
            firstFilterEnabled = v;
            localStorage.setItem(FIRST_FILTER_ENABLED_KEY, String(v));
            saveRoomControls();
        }, true);
        filterRow.addEventListener('click', (e) => { e.stopPropagation(); createFirstFilterManager(); });

        const avatarRow = dockRow(
            `<span>大頭貼過濾</span><span id="knock-avatar-filter-count" style="background:#ff9800;border-radius:10px;padding:0 6px;font-size:12px;min-width:1.2em;text-align:center;">${getAvatarFilters().length}</span>`
        );
        attachDockSwitch(avatarRow, avatarFilterEnabled, (v) => {
            avatarFilterEnabled = v;
            localStorage.setItem(AVATAR_FILTER_ENABLED_KEY, String(v));
            saveRoomControls();
        }, true);
        avatarRow.addEventListener('click', (e) => { e.stopPropagation(); createAvatarFilterManager(); });

        const browserRow = dockRow('<span>瀏覽器通知</span>');
        attachDockSwitch(browserRow, browserNotifyEnabled, (v) => {
            browserNotifyEnabled = v;
            localStorage.setItem(BROWSER_NOTIFY_ENABLED_KEY, String(v));
            saveRoomControls();
            if (v) requestNotifyPermission();
        }, true);
        browserRow.addEventListener('click', (e) => { e.stopPropagation(); testBrowserNotification(); });

        body.append(autoRow, filterRow, avatarRow, browserRow, relayBtn);

        const paintOpen = () => {
            body.style.display = open ? 'flex' : 'none';
            dock.style.width = open ? '220px' : 'auto';
            header.style.width = open ? '220px' : 'auto';
            const chevron = el('knock-dock-chevron');
            chevron.textContent = open ? '收合' : SCRIPT_VERSION;
            chevron.style.cssText = open ? '' : 'font-size:12px;opacity:.7;';
        };
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            open = !open;
            localStorage.setItem(DOCK_OPEN_KEY, String(open));
            paintOpen();
        });

        dock.append(header, body);
        document.body.appendChild(dock);
        paintOpen();
    }

    function fillReactInput(el, value) {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function pressEnter(el) {
        const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
        for (const type of ['keydown', 'keypress', 'keyup']) {
            try { el.dispatchEvent(new KeyboardEvent(type, opts)); } catch (e) {}
        }
    }

    function sendChatMessage(text, onSent) {
        const wrap = document.querySelector('[data-test="input-message"]');
        if (!wrap) return false;
        const box = Array.from(wrap.querySelectorAll('textarea')).find(t =>
            t.getAttribute('aria-hidden') !== 'true' && t.style.visibility !== 'hidden'
        );
        if (!box) return false;
        fillReactInput(box, text);
        const trySend = () => {
            if (!box.value.trim()) return true;
            if (box.value !== text) fillReactInput(box, text);
            const send = document.querySelector('button[data-test="send"]');
            if (send && !send.disabled) {
                send.click();
                simulateMouseClick(send);
            } else {
                pressEnter(box);
            }
            return !box.value.trim();
        };
        if (trySend()) {
            if (onSent) onSent();
            return true;
        }
        let tries = 0;
        const tick = () => {
            if (trySend()) {
                if (onSent) onSent();
                return;
            }
            if (++tries < 15) setTimeout(tick, 80);
        };
        setTimeout(tick, 50);
        return true;
    }

    function keepRange(minVal, maxVal) {
        let min = Number(minVal);
        let max = Number(maxVal);
        if (!(min >= 0.1)) min = 1.5;
        if (!(max >= 0.1)) max = 2.5;
        if (min > 48) min = 48;
        if (max > 48) max = 48;
        min = Math.round(min * 10) / 10;
        max = Math.round(max * 10) / 10;
        if (max < min) { const t = min; min = max; max = t; }
        return { min, max };
    }

    function messageAtMs(date, timestamp, now = new Date()) {
        const clock = clockMinutesOnly(timestamp);
        if (clock == null) return 0;
        const labeled = date && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : parseKnockDateLabel(timestamp, now);
        const d = labeled
            ? new Date(+labeled.slice(0, 4), +labeled.slice(5, 7) - 1, +labeled.slice(8, 10))
            : new Date(now);
        d.setHours(0, 0, 0, 0);
        d.setMinutes(clock);
        if (!labeled && d.getTime() > now.getTime() + 60000) d.setDate(d.getDate() - 1);
        return d.getTime();
    }

    function lastChatAt() {
        let latest = lastKeepAliveSentAt || 0;
        for (const m of currentConversation.messages) latest = Math.max(latest, messageAtMs(m.date, m.timestamp));
        const list = document.querySelector('ul[data-test="messages"]');
        if (list) {
            const dates = listMessageDates(list);
            for (const li of list.querySelectorAll('li.message-li')) {
                const timeEl = li.querySelector('span[data-test="date"]');
                if (!timeEl) continue;
                latest = Math.max(latest, messageAtMs(dates.get(li) || '', timeEl.textContent.trim()));
            }
        }
        if (!latest && currentConversation.startTime) {
            const start = Date.parse(currentConversation.startTime);
            if (Number.isFinite(start)) latest = start;
        }
        return latest;
    }

    function rollKeepAliveWaitMs() {
        const range = keepRange(keepMin, keepMax);
        keepAliveWaitMs = (range.min + Math.random() * (range.max - range.min)) * 3600000;
        return keepAliveWaitMs;
    }

    function tryKeepAlive() {
        if (!keepAliveEnabled || !keepAliveText) return;
        if (pendingForcedLeave) return;
        if (!document.querySelector('ul[data-test="messages"]')) return;
        if (findButtons().some(b => isRematchButton(b) || isConfirmExitButton(b))) return;
        const at = lastChatAt();
        if (!keepAliveWaitMs) rollKeepAliveWaitMs();
        if (!at || Date.now() - at < keepAliveWaitMs) return;
        if (Date.now() - lastKeepAliveTryAt < 60000) return;
        lastKeepAliveTryAt = Date.now();
        sendChatMessage(keepAliveText, () => {
            lastKeepAliveSentAt = Date.now();
            rollKeepAliveWaitMs();
        });
    }

    function relayToken() {
        return (localStorage.getItem(RELAY_TOKEN_KEY) || '').trim();
    }

    function relayTabId() {
        let id = sessionStorage.getItem(RELAY_TAB_KEY) || '';
        if (!/^[a-z0-9]{8,40}$/.test(id)) {
            id = (Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 40);
            if (id.length < 8) id = (id + 'relaytab1').slice(0, 16);
            sessionStorage.setItem(RELAY_TAB_KEY, id);
        }
        return id;
    }

    // 發語詞那則常常沒有頭像。名稱左邊的圖改看畫面上實際露出的對方頭像。
    function shownPartnerFace() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return null;
        for (const li of list.querySelectorAll('li.message-li')) {
            if (isMyMessageLi(li)) continue;
            const el = senderAvatar(li);
            if (!el || !avatarShown(el)) continue;
            const img = el.querySelector('img');
            return { el, url: img && img.src ? img.src : '' };
        }
        return null;
    }

    function relayOpenings() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return null;
        let them = '';
        let mine = '';
        let themLi = null;
        let avatarUrl = '';
        let uid = '';
        let filterKey = '';
        let avatarHash = '';
        for (const li of list.querySelectorAll('li.message-li')) {
            const messageDiv = li.querySelector('div[data-test="message"]');
            if (!messageDiv || messageDiv.querySelector('span[data-test="date"]')) continue;
            const text = getMessageText(messageDiv);
            if (TYPING_RE.test(text)) continue;
            const images = getMessageImages(messageDiv);
            const body = (text || (images[0] ? '圖片' : '')).trim().slice(0, 200);
            if (!body) continue;
            if (isMyMessageLi(li)) {
                if (!mine) mine = body;
            } else if (!them) {
                them = body;
                themLi = li;
                avatarUrl = getAvatarUrl(li) || '';
                uid = messageSentBy(li) || '';
                filterKey = (text || stableImageKey(images[0]) || '').trim();
                avatarHash = avatarHashOf(avatarUrl);
            }
        }
        const shown = shownPartnerFace();
        const avatar = shown
            ? openingAvatar(shown.el, shown.url)
            : (themLi ? openingAvatar(themLi, avatarUrl) : '');
        if (!them && !mine && !avatar) return null;
        return {
            them,
            mine,
            avatar,
            avatarOn: relayRecordAvatar,
            userOn: relayRecordUser
        };
    }

    function lobbyGreeting() {
        for (const el of document.querySelectorAll('[data-test="message"]')) {
            if (el.closest('ul[data-test="messages"]')) continue;
            const text = (el.textContent || '').trim();
            if (text) return text.slice(0, 200);
        }
        return '';
    }

    function openProfileCard() {
        for (const el of document.querySelectorAll('span')) {
            if (el.textContent.trim() !== '你的匿名身分') continue;
            let node = el;
            for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
                if (node.querySelector('[data-test="message"]')) {
                    node.click();
                    return true;
                }
            }
        }
        return false;
    }

    // 發語詞是個人簡介。點身分卡、再點簡介的編輯、填進「變更簡介」後按確定。一次只走一步。
    function stepGreeting(want) {
        const text = String(want || '').trim().slice(0, 200);
        if (!text || lobbyGreeting() === text) return;
        if (Date.now() - greetingSaveAt < 2500 && !document.querySelector('[role="dialog"]')) return;
        const title = document.getElementById('form-dialog-title');
        if (title && title.textContent.trim() === '變更簡介') {
            const dialog = title.closest('[role="dialog"]');
            const box = dialog && dialog.querySelector('textarea, input');
            if (box && box.value.trim() !== text) fillReactInput(box, text);
            const ok = dialog && Array.from(dialog.querySelectorAll('button')).find(b => b.textContent.trim() === '確定' && !b.disabled);
            if (ok) {
                ok.click();
                greetingSaveAt = Date.now();
            }
            return;
        }
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog && dialog.textContent.includes('大頭貼照')) {
            const edits = Array.from(dialog.querySelectorAll('button[aria-label="edit"]'));
            const edit = edits[edits.length - 1];
            if (edit) edit.click();
            return;
        }
        if (dialog) return;
        openProfileCard();
    }

    function applyRemoteLobby(data) {
        if (typeof data.greeting === 'string') stepGreeting(data.greeting);
        if (data.start) pendingRemoteStart = true;
        if (!pendingRemoteStart || document.querySelector('[role="dialog"]')) return;
        const rematch = findButtons().find(isRematchButton);
        if (rematch && !rematch.disabled) {
            simulateMouseClick(rematch);
            return;
        }
        if (typeof data.greeting === 'string' && lobbyGreeting() !== data.greeting.trim()) return;
        const btn = findButtons().find(isStartChatButton);
        if (!btn || btn.disabled) return;
        pendingRemoteStart = false;
        simulateMouseClick(btn);
        initNewConversation();
    }

    function relaySnapshot() {
        const list = document.querySelector('ul[data-test="messages"]');
        const lobby = findButtons().some(isStartChatButton);
        const left = findButtons().some(isRematchButton);
        if (!list && !lobby && !left) return null;
        autoNamePartner();
        const base = {
            tabId: relayTabId(),
            channelId: currentConversation.id || '',
            title: currentPartnerName() || '未命名',
            canType: false,
            lobby,
            greeting: lobby ? lobbyGreeting() : '',
            status: left ? 'left' : 'live',
            messages: [],
            openings: null,
            controls: relayControls(),
            archive: relayArchive()
        };
        if (!list) return base;
        const canType = !left && !!document.querySelector('[data-test="input-message"] textarea');
        const dateByLi = listMessageDates(list);
        const messages = [];
        for (const li of list.querySelectorAll('li.message-li')) {
            const messageDiv = li.querySelector('div[data-test="message"]');
            if (!messageDiv) continue;
            const text = getMessageText(messageDiv);
            if (TYPING_RE.test(text)) continue;
            const images = getMessageImages(messageDiv);
            const image = images[0] ? relayImageId(images[0]) : '';
            const quote = getMessageQuote(messageDiv);
            if (!text && !image && !quote) continue;
            const id = (String(li.className || '').match(/message-li-(\S+)/) || [])[1] || '';
            if (!id) continue;
            const timeEl = messageDiv.querySelector('span[data-test="date"]');
            if (!timeEl) continue;
            const time = formatMessageStamp({
                timestamp: timeEl ? timeEl.textContent.trim() : '',
                date: dateByLi.get(li) || ''
            });
            // ponytail: 一則只帶第一張圖。多圖再改成陣列。
            messages.push({ id, text: text.slice(0, 500), quote, image, mine: isMyMessageLi(li), time });
        }
        return {
            ...base,
            canType,
            messages: messages.slice(-40),
            openings: relayOpenings()
        };
    }

    function relayArchiveRow(m) {
        const key = (m.imageKeys && m.imageKeys[0]) || '';
        const url = (m.imageUrls && m.imageUrls[0]) || '';
        const image = key ? relayImageId(key) : (url && !String(url).startsWith('data:') ? relayImageId(url) : '');
        const text = String(m.text || '').slice(0, 500) || (!m.quote && !image && url ? '圖片' : '');
        const quote = String(m.quote || '').slice(0, 200);
        if (!m.id || (!text && !quote && !image)) return null;
        return {
            id: String(m.id).slice(0, 80),
            text,
            quote,
            image,
            mine: !!m.isMyMessage,
            time: formatMessageStamp(m)
        };
    }

    function archiveUidOf(conv) {
        const uid = String((conv && conv.partnerUid) || '').trim();
        if (/^[A-Za-z0-9_-]{6,128}$/.test(uid)) return uid;
        const id = String((conv && conv.id) || '').trim();
        if (/^[A-Za-z0-9_-]{6,128}$/.test(id)) return id;
        return '';
    }

    function archiveTitleOf(conv) {
        return String((conv && conv.label) || '').trim().slice(0, 40) || '未命名';
    }

    function archiveSources(live, liveTitle) {
        const uid = archiveUidOf(live);
        if (!uid || !(live && live.messages || []).length) return [];
        return [{ uid, title: liveTitle || archiveTitleOf(live), messages: live.messages.slice() }];
    }

    function nextArchive(sources, done) {
        for (const src of sources || []) {
            const messages = [];
            const seen = new Set();
            for (const m of src.messages) {
                if (!m || !m.id || seen.has(m.id) || done.has(src.uid + ':' + m.id)) continue;
                seen.add(m.id);
                messages.push(m);
                if (messages.length >= 30) break;
            }
            if (messages.length) return { uid: src.uid, title: src.title, messages };
        }
        return null;
    }

    // 只送目前這場。舊的本地紀錄已同步過，不再每輪重讀。
    function relayArchive() {
        notePartnerFromList();
        const uid = archiveUidOf(currentConversation);
        if (!uid) return null;
        const title = currentPartnerName() || '未命名';
        const next = nextArchive(archiveSources(currentConversation, title), relayArchived);
        if (!next) return { uid, title, named: nameSet, messages: [] };
        const messages = [];
        const skip = [];
        for (const m of next.messages) {
            const row = relayArchiveRow(m);
            if (row) messages.push(row);
            else skip.push(m);
        }
        if (skip.length) rememberArchived(next.uid, skip);
        return { uid: next.uid, title: next.title, named: nameSet, messages };
    }

    const relaySending = new Map();
    const relayUploaded = new Set();
    const relayImageDone = new Set();
    const relayArchived = new Set();
    let relayImagePendingId = '';
    let relayImageArmedAt = 0;
    let relayImageBooted = false;
    let relayBusy = false;

    function rememberRelayImage(id) {
        if (!id || relayImageDone.has(id)) return;
        relayImageDone.add(id);
        try {
            sessionStorage.setItem('knockRelayImageDone', JSON.stringify([...relayImageDone].slice(-40)));
        } catch (e) {}
    }

    try {
        const savedDone = JSON.parse(sessionStorage.getItem('knockRelayImageDone') || '[]');
        if (Array.isArray(savedDone)) savedDone.forEach(id => { if (id) relayImageDone.add(id); });
        const savedArchive = JSON.parse(sessionStorage.getItem('knockRelayArchived') || '[]');
        if (Array.isArray(savedArchive)) savedArchive.forEach(id => { if (id) relayArchived.add(id); });
    } catch (e) {}

    function rememberArchived(uid, messages) {
        if (!uid) return;
        for (const m of messages || []) {
            if (m && m.id) relayArchived.add(uid + ':' + m.id);
        }
        try {
            sessionStorage.setItem('knockRelayArchived', JSON.stringify([...relayArchived].slice(-3000)));
        } catch (e) {}
    }

    function forgetArchivedMessage(id) {
        if (!id) return;
        let changed = false;
        for (const key of [...relayArchived]) {
            const cut = key.lastIndexOf(':');
            if (cut > 0 && key.slice(cut + 1) === id) {
                relayArchived.delete(key);
                changed = true;
            }
        }
        if (!changed) return;
        try {
            sessionStorage.setItem('knockRelayArchived', JSON.stringify([...relayArchived].slice(-3000)));
        } catch (e) {}
    }

    function noteRecalledLocal(domId, quote, date) {
        if (!domId) return false;
        const prev = currentConversation.messages.find(m => m && (m.domId === domId || m.id === domId));
        if (!prev) return false;
        if ((prev.imageKeys && prev.imageKeys.length) || (prev.imageUrls && prev.imageUrls.length)) return true;
        const base = String(prev.text || '');
        if (!base || base === '已收回一則訊息') return true;
        const next = base.endsWith('（已收回）') ? base : base + '（已收回）';
        if (prev.text !== next) {
            prev.text = next;
            if (quote) prev.quote = quote;
            if (date) prev.date = date;
            forgetArchivedMessage(prev.id);
        }
        return true;
    }

    function relayControls() {
        return {
            auto: autoClickEnabled,
            userFilter: firstFilterEnabled,
            avatarFilter: avatarFilterEnabled,
            browser: browserNotifyEnabled,
            phone: ntfyEnabled,
            phoneTopic: getNtfyTopic(),
            phoneTitle: getNtfyTitle(),
            keep: keepAliveEnabled,
            keepText: keepAliveText,
            keepMin,
            keepMax
        };
    }

    function relayControlsMatch(cur, next) {
        if (!cur || !next) return false;
        const title = String(next.phoneTitle || '').trim() || 'Knock 新訊息';
        const hours = keepRange(next.keepMin, next.keepMax);
        const curHours = keepRange(cur.keepMin, cur.keepMax);
        return !!next.auto === !!cur.auto
            && !!next.userFilter === !!cur.userFilter
            && !!next.avatarFilter === !!cur.avatarFilter
            && !!next.browser === !!cur.browser
            && !!next.phone === !!cur.phone
            && String(next.phoneTopic || '').trim() === String(cur.phoneTopic || '')
            && title === (String(cur.phoneTitle || '').trim() || 'Knock 新訊息')
            && !!next.keep === !!cur.keep
            && String(next.keepText || '').trim() === String(cur.keepText || '').trim()
            && hours.min === curHours.min
            && hours.max === curHours.max;
    }

    function applyRelayControls(c) {
        if (!c || relayControlsMatch(relayControls(), c)) return;
        autoClickEnabled = !!c.auto;
        localStorage.setItem(AUTO_CLICK_ENABLED_KEY, String(autoClickEnabled));
        firstFilterEnabled = !!c.userFilter;
        localStorage.setItem(FIRST_FILTER_ENABLED_KEY, String(firstFilterEnabled));
        avatarFilterEnabled = !!c.avatarFilter;
        localStorage.setItem(AVATAR_FILTER_ENABLED_KEY, String(avatarFilterEnabled));
        browserNotifyEnabled = !!c.browser;
        localStorage.setItem(BROWSER_NOTIFY_ENABLED_KEY, String(browserNotifyEnabled));
        if (browserNotifyEnabled) requestNotifyPermission();
        ntfyEnabled = !!c.phone;
        localStorage.setItem(NTFY_ENABLED_KEY, String(ntfyEnabled));
        if (typeof c.phoneTopic === 'string') setNtfyTopic(c.phoneTopic);
        if (typeof c.phoneTitle === 'string') setNtfyTitle(c.phoneTitle);
        const nextKeep = keepRange(c.keepMin, c.keepMax);
        const hoursChanged = nextKeep.min !== keepMin || nextKeep.max !== keepMax;
        keepAliveEnabled = !!c.keep;
        keepAliveText = String(c.keepText || '').trim().slice(0, 200);
        keepMin = nextKeep.min;
        keepMax = nextKeep.max;
        if (hoursChanged) keepAliveWaitMs = 0;
        saveRoomControls();
        const dock = el('knock-dock');
        if (dock) {
            dock.remove();
            createDock();
        }
    }

    function saveRoomControls() {
        try { sessionStorage.setItem('knockRoomControls', JSON.stringify(relayControls())); } catch (e) {}
    }

    function storedRoomControls() {
        try {
            const raw = JSON.parse(sessionStorage.getItem('knockRoomControls') || 'null');
            if (raw && typeof raw === 'object') return raw;
        } catch (e) {}
        return null;
    }

    function relayImageId(url) {
        const key = stableImageKey(url) || url;
        let id = hashString(key).replace(/[^a-z0-9]/g, '');
        if (id.length < 8) id = (id + 'knockimg').slice(0, 12);
        return id.slice(0, 40);
    }

    function svgToJpeg(blob) {
        const read = blob && typeof blob.text === 'function'
            ? blob.text()
            : new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error);
                reader.readAsText(blob);
            });
        return read.then(text => {
            let svg = String(text || '');
            if (svg.indexOf('<svg') === -1) throw new Error('svg');
            if (svg.indexOf('width=') === -1) svg = svg.replace('<svg', '<svg width="128" height="128"');
            const fixed = new Blob([svg], { type: 'image/svg+xml' });
            return new Promise((resolve, reject) => {
                const img = new Image();
                const u = URL.createObjectURL(fixed);
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 128;
                    canvas.height = 128;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, 0, 128, 128);
                    ctx.drawImage(img, 0, 0, 128, 128);
                    URL.revokeObjectURL(u);
                    resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.85)));
                };
                img.onerror = () => {
                    URL.revokeObjectURL(u);
                    reject(new Error('svg'));
                };
                img.src = u;
            });
        });
    }

    async function relayUploadImages(snap) {
        const avatarId = snap.openings && /^[a-z0-9]{8,40}$/.test(snap.openings.avatar || '') ? snap.openings.avatar : '';
        const queue = [];
        if (avatarId && !relayUploaded.has(avatarId)) {
            const first = findFirstOtherMessage();
            if (first && first.avatarUrl) queue.push({ id: avatarId, url: first.avatarUrl, stock: isStockAvatar(first.avatarUrl) });
        }
        for (const m of snap.messages || []) {
            if (!m.image || relayUploaded.has(m.image)) continue;
            const li = Array.from(document.querySelectorAll('li.message-li')).find(el => el.classList.contains('message-li-' + m.id));
            const messageDiv = li && li.querySelector('[data-test="message"]');
            const url = messageDiv && getMessageImages(messageDiv)[0];
            if (url) queue.push({ id: m.image, url });
        }
        const item = queue[0];
        if (!item) return;
        try {
            if (item.stock) {
                const have = await gmRequest({
                    method: 'GET',
                    url: `${RELAY_URL}/api/images/${item.id}`,
                    headers: { Authorization: `Bearer ${relayToken()}` },
                    timeout: 8000
                });
                if (have && have.status === 200) {
                    relayUploaded.add(item.id);
                    return;
                }
            }
            let blob = await fetchImageBlob(item.url);
            if (item.stock && (!blob.type || blob.type.indexOf('svg') !== -1)) blob = await svgToJpeg(blob);
            if (blob.size > 400 * 1024 && blob.type !== 'image/gif') {
                const dataUrl = await blobToDataUrl(blob);
                if (String(dataUrl).startsWith('data:')) blob = dataUrlToBlob(dataUrl);
            }
            const res = await gmRequest({
                method: 'POST',
                url: `${RELAY_URL}/api/images/${item.id}`,
                headers: { Authorization: `Bearer ${relayToken()}`, 'Content-Type': blob.type || 'image/jpeg' },
                data: blob,
                timeout: 20000
            });
            if (res && (res.status === 200 || res.status === 409)) relayUploaded.add(item.id);
        } catch (e) {}
    }

    function relayParkedFile() {
        const item = document.querySelector('#filepond-image-uploader .filepond--item, #filepond-video-gif-uploader .filepond--item');
        if (!item) return null;
        const nameEl = item.querySelector('.filepond--file-info-main');
        const name = nameEl ? nameEl.textContent.trim() : '';
        if (name !== 'relay.jpg' && name !== 'relay.gif') return null;
        return item;
    }

    function chatDraft() {
        const box = Array.from(document.querySelectorAll('[data-test="input-message"] textarea')).find(t =>
            t.getAttribute('aria-hidden') !== 'true' && t.style.visibility !== 'hidden'
        );
        return box ? box.value : '';
    }

    // 輸入框有草稿就不要按送出，避免把正在打的字一起送出去。
    function relayShouldPushImage(fileName, draft) {
        if (fileName !== 'relay.jpg' && fileName !== 'relay.gif') return false;
        return !String(draft || '').trim();
    }

    // 同一張只送一次。腳本剛載入時佇列裡已有的圖片只回報、不再塞進聊天室。
    function relayImagePlan(id, done, booted) {
        if (!id || !booted || done.has(id)) return 'ack';
        return 'send';
    }

    function ackRelayItem(token, tabId, id) {
        return gmRequest({
            method: 'POST',
            url: `${RELAY_URL}/api/sessions/${tabId}/ack`,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            data: JSON.stringify({ id }),
            timeout: 8000
        }).catch(() => {});
    }

    function waitFor(pred, ms) {
        const end = Date.now() + ms;
        const step = () => pred() || Date.now() >= end
            ? Promise.resolve(!!pred())
            : new Promise(r => setTimeout(r, 80)).then(step);
        return step();
    }

    function removeParkedFile() {
        const parked = relayParkedFile();
        if (!parked) return;
        const remove = parked.querySelector('button.filepond--action-remove-item');
        if (remove) remove.click();
    }

    async function relayDropImage(item) {
        const res = await gmRequest({
            method: 'GET',
            url: `${RELAY_URL}/api/images/${item.image}`,
            headers: { Authorization: `Bearer ${relayToken()}` },
            responseType: 'blob',
            timeout: 20000
        });
        const blob = res && res.response;
        if (!res || res.status !== 200 || !blob) return false;
        const type = blob.type && blob.type.indexOf('image/') === 0 ? blob.type : 'image/jpeg';
        const gif = type.indexOf('gif') !== -1;
        const file = new File([blob], gif ? 'relay.gif' : 'relay.jpg', { type: gif ? 'image/gif' : type });
        const input = document.querySelector(gif
            ? '#filepond-video-gif-uploader input.filepond--browser'
            : '#filepond-image-uploader input.filepond--browser');
        if (!input || typeof DataTransfer === 'undefined') return false;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return waitFor(() => !!relayParkedFile(), 2000);
    }

    // 送出鈕亮了才點一次。點完先留著縮圖，Knock 才讀得到檔案。
    async function relayPushParkedImage() {
        if (relayImageArmedAt) return false;
        const ready = await waitFor(() => {
            const parked = relayParkedFile();
            if (!parked) return false;
            const nameEl = parked.querySelector('.filepond--file-info-main');
            const name = nameEl ? nameEl.textContent.trim() : '';
            const send = document.querySelector('button[data-test="send"]');
            return relayShouldPushImage(name, chatDraft()) && !!(send && !send.disabled);
        }, 5000);
        if (!ready || !relayParkedFile()) return false;
        const send = document.querySelector('button[data-test="send"]');
        if (!send || send.disabled) return false;
        send.click();
        relayImageArmedAt = Date.now();
        return true;
    }

    let filtersUploaded = false;
    let filterUploadBusy = false;

    function pushFilters(patch) {
        const token = relayToken();
        if (!token || !patch) return;
        gmRequest({
            method: 'POST',
            url: `${RELAY_URL}/api/filters`,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            data: JSON.stringify(patch),
            timeout: 8000
        }).then(res => {
            if (!res || res.status !== 200) return;
            try { applyServerFilters(JSON.parse(res.responseText || '{}')); } catch (e) {}
        }).catch(() => {});
    }

    function applyServerFilters(data) {
        if (!data || typeof data !== 'object') return;
        const users = Array.isArray(data.users) ? data.users.map(normalizeFilter).filter(Boolean) : null;
        const avatars = Array.isArray(data.avatars) ? data.avatars.map(normalizeAvatarFilter).filter(Boolean) : null;
        if (!filtersUploaded) {
            const addedUsers = users && users.length ? mergeStoredUsers(users) : 0;
            const addedAvatars = avatars && avatars.length ? mergeStoredAvatars(avatars) : 0;
            if (addedUsers || addedAvatars) {
                syncRememberButtons();
                syncAvatarFilterButtons();
                maybeLeaveOnFirstMessageFilter();
                maybeLeaveOnAvatarFilter();
            }
            return;
        }
        let changed = false;
        if (users && JSON.stringify(users) !== JSON.stringify(getNormalizedFilters())) {
            storageSet(FIRST_MSG_FILTER_KEY, users);
            changed = true;
            syncRememberButtons();
            if (el('knock-first-filter-manager')) refreshFirstFilterManager();
        }
        if (avatars && JSON.stringify(avatars) !== JSON.stringify(getAvatarFilters())) {
            storageSet(AVATAR_FILTER_KEY, avatars);
            changed = true;
            syncAvatarFilterButtons();
            if (el('knock-avatar-filter-manager')) refreshAvatarFilterManager();
        }
        if (changed) {
            maybeLeaveOnFirstMessageFilter();
            maybeLeaveOnAvatarFilter();
        }
    }

    function uploadLocalFilters() {
        if (filtersUploaded || filterUploadBusy) return;
        const token = relayToken();
        if (!token) return;
        const addUsers = getNormalizedFilters();
        const addAvatars = getAvatarFilters();
        if (!addUsers.length && !addAvatars.length) { filtersUploaded = true; return; }
        filterUploadBusy = true;
        const steps = [];
        for (let i = 0; i < addUsers.length || i < addAvatars.length; i += 200) {
            steps.push({ addUsers: addUsers.slice(i, i + 200), addAvatars: addAvatars.slice(i, i + 200) });
        }
        let chain = Promise.resolve(null);
        for (const patch of steps) {
            chain = chain.then(() => gmRequest({
                method: 'POST',
                url: `${RELAY_URL}/api/filters`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                data: JSON.stringify(patch),
                timeout: 8000
            }).then(res => {
                if (!res || res.status !== 200) throw new Error('filters');
                return res;
            }));
        }
        chain.then(res => {
            filterUploadBusy = false;
            filtersUploaded = true;
            try { applyServerFilters(JSON.parse(res.responseText || '{}')); } catch (e) {}
        }).catch(() => { filterUploadBusy = false; });
    }

    async function relayTick() {
        const token = relayToken();
        if (!token || relayBusy) return;
        uploadLocalFilters();
        saveRoomControls();
        let snap = null;
        try { snap = relaySnapshot(); } catch (e) {}
        if (!snap) return;
        relayBusy = true;
        try {
            await relayUploadImages(snap);
            const res = await gmRequest({
                method: 'POST',
                url: `${RELAY_URL}/api/heartbeat?wait=1`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                data: JSON.stringify(snap),
                timeout: 8000
            });
            if (res && res.status === 200) {
            if (snap.archive) rememberArchived(snap.archive.uid, snap.archive.messages);
            const data = JSON.parse(res.responseText || '{}');
            if (typeof data.rename === 'string' && data.rename) {
                nameSet = true;
                currentConversation.label = data.rename === '未命名' ? '' : String(data.rename).slice(0, 40);
                paintPartnerCaption();
            } else if (!nameSet && data.talkTitle && data.talkTitle !== '未命名' && currentConversation.label !== data.talkTitle) {
                currentConversation.label = String(data.talkTitle).slice(0, 40);
                paintPartnerCaption();
            }
            applyRemoteLobby(data);
            if (data.filters) applyServerFilters(data.filters);
            if (data.controls) applyRelayControls(data.controls);
            if (typeof data.notify === 'string' && data.notify) sendNtfy(data.notify);
            if (typeof data.avatarOn === 'boolean') {
                relayRecordAvatar = data.avatarOn;
                const first = findFirstOtherMessage();
                const url = first && first.avatarUrl;
                if (url && isAvatarFiltered(url) !== data.avatarOn) toggleAvatarFilter(url);
            }
            if (typeof data.userOn === 'boolean') {
                relayRecordUser = data.userOn;
                const first = findFirstOtherMessage();
                if (first && first.uid && isFirstMessageFiltered(first.uid, first.filterKey, first.avatarHash) !== data.userOn) {
                    toggleFirstMessageFilter(first.uid, first.filterKey, first.avatarHash);
                }
            }
            if (!relayImageBooted) {
                relayImageBooted = true;
                for (const queued of data.outbox || []) {
                    if (queued && queued.image && queued.id) rememberRelayImage(queued.id);
                }
            }
            // 點過送出的縮圖先留著。超過 4 秒還在，才清掉殘留。
            if (relayParkedFile() && relayImageArmedAt && Date.now() - relayImageArmedAt > 4000) {
                removeParkedFile();
                relayImageArmedAt = 0;
            } else if (relayParkedFile() && relayImagePendingId && !relayImageArmedAt) {
                const pushed = await relayPushParkedImage();
                if (pushed) {
                    rememberRelayImage(relayImagePendingId);
                    await ackRelayItem(token, snap.tabId, relayImagePendingId);
                    relayImagePendingId = '';
                }
            }
            for (const item of data.outbox || []) {
                if (!item || !item.id || !snap.canType || (!item.text && !item.image)) continue;
                if (item.image) {
                    if (relayImagePlan(item.id, relayImageDone, relayImageBooted) === 'ack') {
                        await ackRelayItem(token, snap.tabId, item.id);
                        continue;
                    }
                    if (relayParkedFile() && relayImageArmedAt && Date.now() - relayImageArmedAt <= 4000) continue;
                    if (relayImagePendingId === item.id && relayParkedFile()) continue;
                    if (relayParkedFile()) removeParkedFile();
                    relayImagePendingId = item.id;
                    relayImageArmedAt = 0;
                    const dropped = await relayDropImage(item);
                    if (!dropped) {
                        relayImagePendingId = '';
                        continue;
                    }
                    const pushed = await relayPushParkedImage();
                    if (!pushed) continue;
                    rememberRelayImage(item.id);
                    relayImagePendingId = '';
                    await ackRelayItem(token, snap.tabId, item.id);
                    continue;
                }
                const started = relaySending.get(item.id) || 0;
                if (Date.now() - started < 8000) continue;
                relaySending.set(item.id, Date.now());
                const sent = sendChatMessage(item.text, () => {
                    gmRequest({
                        method: 'POST',
                        url: `${RELAY_URL}/api/sessions/${snap.tabId}/ack`,
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        data: JSON.stringify({ id: item.id }),
                        timeout: 8000
                    }).catch(() => {}).finally(() => relaySending.delete(item.id));
                });
                if (!sent) relaySending.delete(item.id);
            }
            }
        } catch (e) {}
        relayBusy = false;
        return true;
    }

    // 縮小視窗後 setInterval 會被瀏覽器放慢。由伺服器把這次回報留住約兩秒，回來就立刻送下一次。
    async function relayLoop() {
        for (;;) {
            const started = Date.now();
            const paced = await relayTick();
            if (!paced || Date.now() - started < 1000) await new Promise(r => setTimeout(r, 2000));
        }
    }

    function keepRelayAwake() {
        try {
            if (!navigator.locks) return;
            navigator.locks.request('knock-relay-awake', { mode: 'shared' }, () => new Promise(() => {}));
        } catch (e) {}
    }

    function refreshFirstFilterManager() {
        const panel = el('knock-first-filter-manager');
        if (!panel) return;
        panel.remove();
        createFirstFilterManager();
    }

    function createFirstFilterManager() {
        const filters = getNormalizedFilters();
        const panel = toggleOverlay('knock-first-filter-manager', () => makeOverlay('knock-first-filter-manager', 720, `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
                <h2 style="margin:0;font-size:24px;">使用者過濾（${filters.length}）</h2>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button id="knock-clear-first-filters" style="${cssBtn('#d32f2f')}" ${filters.length ? '' : 'disabled'}>全部清空</button>
                    <button id="knock-filter-manager-close" style="${cssBtn('#444')}">關閉</button>
                </div>
            </div>
            <div style="font-size:13px;color:#888;margin-bottom:16px;">依使用者 id 自動離開。沒有 id 的舊項目，要發語詞與頭像都相同才會離開。</div>
            <input type="text" id="knock-filter-search" placeholder="搜尋已記住的人..." style="${CSS_INP}margin-bottom:16px;">
            <div id="knock-filter-list" style="display:flex;flex-direction:column;gap:8px;">
                ${filters.length === 0
                    ? '<div style="text-align:center;padding:40px;color:#888;">尚未過濾任何人</div>'
                    : filters.map(f => `
                        <div class="knock-filter-card" style="display:flex;gap:8px;align-items:flex-start;background:#222;border:1px solid #444;border-radius:8px;padding:12px;">
                            <div style="flex:1;min-width:0;">
                                <div style="font-size:14px;color:#ccc;white-space:pre-wrap;word-break:break-word;">${escapeHtml(f.t || '（沒有發語詞）')}</div>
                                <div style="font-size:12px;color:#666;margin-top:4px;">${f.u
                                    ? `id ${escapeHtml(f.u)}`
                                    : '舊資料沒有 id，發語詞與頭像都相同才會離開'}</div>
                            </div>
                            <button type="button" class="knock-remove-first-filter" data-filter-uid="${encodeURIComponent(f.u)}" data-filter-text="${encodeURIComponent(f.t)}" data-filter-avatar="${encodeURIComponent(f.a)}" style="${cssBtn('#d32f2f', 'padding:6px 10px;border-radius:4px;font-size:12px;flex-shrink:0;')}">刪除</button>
                        </div>`).join('')}
            </div>`));
        if (!panel) return;
        el('knock-filter-manager-close').onclick = () => panel.remove();
        el('knock-filter-search').addEventListener('input', (e) => {
            filterCardsByTerm('.knock-filter-card', e.target.value.toLowerCase(), 'flex');
        });
    }

    function refreshAvatarFilterManager() {
        const panel = el('knock-avatar-filter-manager');
        if (!panel) return;
        panel.remove();
        createAvatarFilterManager();
    }

    function createAvatarFilterManager() {
        const filters = getAvatarFilters();
        const panel = toggleOverlay('knock-avatar-filter-manager', () => makeOverlay('knock-avatar-filter-manager', 720, `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
                <h2 style="margin:0;font-size:24px;">大頭貼過濾（${filters.length}）</h2>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button id="knock-clear-avatar-filters" style="${cssBtn('#d32f2f')}" ${filters.length ? '' : 'disabled'}>全部清空</button>
                    <button id="knock-avatar-filter-manager-close" style="${cssBtn('#444')}">關閉</button>
                </div>
            </div>
            <div style="font-size:13px;color:#888;margin-bottom:16px;">對方第一則訊息的大頭貼網址相同就會自動離開。預設頭像也可以勾，用來略過沒換頭像的人。</div>
            <input type="text" id="knock-avatar-filter-search" placeholder="搜尋大頭貼網址..." style="${CSS_INP}margin-bottom:16px;">
            <div id="knock-avatar-filter-list" style="display:flex;flex-direction:column;gap:8px;">
                ${filters.length === 0
                    ? '<div style="text-align:center;padding:40px;color:#888;">尚未封鎖任何大頭貼</div>'
                    : filters.map(url => `
                        <div class="knock-avatar-filter-card" data-search="${escapeHtml(url.toLowerCase())}" style="display:flex;gap:12px;align-items:center;background:#222;border:1px solid #444;border-radius:8px;padding:12px;">
                            <div style="width:48px;height:48px;border-radius:50%;flex-shrink:0;background:#333;overflow:hidden;">
                                <img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;" referrerpolicy="no-referrer">
                            </div>
                            <div style="flex:1;min-width:0;font-size:12px;color:#aaa;word-break:break-all;">${escapeHtml(url)}</div>
                            <button class="knock-remove-avatar-filter" data-avatar-url="${encodeURIComponent(url)}" style="${cssBtn('#d32f2f', 'padding:6px 10px;border-radius:4px;font-size:12px;flex-shrink:0;')}">刪除</button>
                        </div>`).join('')}
            </div>`));
        if (!panel) return;
        el('knock-avatar-filter-manager-close').onclick = () => panel.remove();
        el('knock-avatar-filter-search').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('.knock-avatar-filter-card').forEach(card => {
                const hay = card.getAttribute('data-search') || '';
                card.style.display = !term || hay.includes(term) ? 'flex' : 'none';
            });
        });
    }

    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('knock-remove-first-filter')) {
            const uid = decodeURIComponent(e.target.dataset.filterUid || '');
            const text = decodeURIComponent(e.target.dataset.filterText || '');
            const avatarHash = decodeURIComponent(e.target.dataset.filterAvatar || '');
            if (uid || text) {
                removeFirstMessageFilter(uid, text, avatarHash);
                syncRememberButtons();
                refreshFirstFilterManager();
            }
            return;
        }
        const rememberBtn = e.target.closest?.('.knock-remember-first-saved');
        if (rememberBtn) {
            toggleFirstMessageFilter(
                decodeURIComponent(rememberBtn.dataset.filterUid || ''),
                decodeURIComponent(rememberBtn.dataset.filterText || ''),
                decodeURIComponent(rememberBtn.dataset.filterAvatar || '')
            );
            return;
        }
        if (e.target.classList.contains('knock-remove-avatar-filter')) {
            const url = decodeURIComponent(e.target.dataset.avatarUrl || '');
            if (url) {
                removeAvatarFilter(url);
                syncAvatarFilterButtons();
                refreshAvatarFilterManager();
            }
            return;
        }
        const avatarRememberBtn = e.target.closest?.('.knock-remember-avatar-saved');
        if (avatarRememberBtn) {
            toggleAvatarFilter(decodeURIComponent(avatarRememberBtn.dataset.avatarUrl || ''));
            return;
        }
        if (e.target.id === 'knock-clear-avatar-filters') {
            if (getAvatarFilters().length && confirm('確定清空全部大頭貼過濾？')) {
                clearAvatarFilters();
                syncAvatarFilterButtons();
                refreshAvatarFilterManager();
            }
            return;
        }
        if (e.target.id === 'knock-clear-first-filters') {
            if (getNormalizedFilters().length && confirm('確定清空全部使用者過濾？')) {
                clearFirstMessageFilters();
                syncRememberButtons();
                refreshFirstFilterManager();
            }
            return;
        }
    });

    // --- 啟動 ---
    hookFirestoreChannel();

    function mountChrome() {
        if (!document.body) return;
        OLD_FLOAT_IDS.forEach(id => el(id)?.remove());
        if (el('knock-dock')) return;
        const room = storedRoomControls();
        if (room) applyRelayControls(room);
        createDock();
    }

    if (document.body) mountChrome();
    else window.addEventListener('DOMContentLoaded', mountChrome);

    new MutationObserver(() => {
        mountChrome();
        checkNewMessages();
        decorateOtherMessages();
        checkForButtonAndClick();
        checkConversationEnd();
    }).observe(document.documentElement, { childList: true, subtree: true });

    setInterval(() => {
        maybeLeaveOnFirstMessageFilter();
        maybeLeaveOnAvatarFilter();
        tryForcedLeave();
        checkForButtonAndClick();
        checkConversationEnd();
        tryKeepAlive();
    }, 200);

    keepRelayAwake();
    relayLoop();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) relayTick(); });

    {
        const times = ['23:59', '00:00'];
        const offsets = dayOffsetsFromNewest(times.map(t => ({
            clock: clockMinutesOnly(t),
            labeled: labelDayOffset(t)
        })));
        const dates = offsets.map(o => shiftYmd(-o));
        const afterMidnight = new Date();
        afterMidnight.setHours(0, 20, 0, 0);
        const onlyNight = dayOffsetsFromNewest([{ clock: 23 * 60 + 20, labeled: null }], afterMidnight);
        if (offsets[0] !== 1 || offsets[1] !== 0 || dates[0] !== shiftYmd(-1) || dates[1] !== shiftYmd(0) || onlyNight[0] !== 1) {
            console.error('knock: 由最新往回推日期檢查失敗', offsets, dates, onlyNight);
        }
        const stock = 'https://firebasestorage.googleapis.com/v0/b/knocktalk-prod.appspot.com/o/users-common%2Favatars%2Fmale-user.svg?alt=media&token=abc';
        const female = 'https://firebasestorage.googleapis.com/v0/b/knocktalk-prod.appspot.com/o/users-common/avatars/female-user.svg?alt=media';
        const maleId = stockAvatarId(stock);
        if (!isStockAvatar(stock) || isStockAvatar('https://example.com/custom.png')
            || !maleId || maleId.indexOf('http') !== -1
            || maleId !== stockAvatarId('https://firebasestorage.googleapis.com/v0/b/knocktalk-prod.appspot.com/o/users-common%2Favatars%2Fmale-user.svg?alt=media')
            || maleId === stockAvatarId(female)
            || stockAvatarId('https://example.com/custom.png')) {
            console.error('knock: 預設頭像判斷失敗');
        }
        if (normalizeAvatarFilter(' https://a/b.png ') !== 'https://a/b.png'
            || normalizeAvatarFilter({ url: 'https://a/b.png' }) !== 'https://a/b.png'
            || normalizeAvatarFilter('')) {
            console.error('knock: 大頭貼過濾判斷失敗');
        }
        const dayNow = new Date(2026, 8, 20, 12, 0, 0);
        if (parseKnockDateLabel('9/19', dayNow) !== '2026-09-19'
            || parseKnockDateLabel('昨天', dayNow) !== '2026-09-19'
            || parseKnockDateLabel('9月19日', dayNow) !== '2026-09-19'
            || clockMinutesOnly('9/19') != null) {
            console.error('knock: 日期標籤解析失敗');
        }
        const encodedParent = 'req0___data__=%7B%22parent%22%3A%22projects%2Fknocktalk-prod%2Fdatabases%2F(default)%2Fdocuments%2Fchannels%2FekVlFOyWwL9KlwjaDgj6%22%7D';
        if (extractChannelId(encodedParent) !== 'ekVlFOyWwL9KlwjaDgj6' || isChannelId('conv_1') || !isChannelId('ekVlFOyWwL9KlwjaDgj6')) {
            console.error('knock: channel id 解析失敗');
        }
        const src = archiveSources({ id: 'live1', partnerUid: 'user_one', label: '阿明', messages: [{ id: 'm3' }, { id: 'm2' }] }, '');
        const batch = nextArchive(src, new Set(['user_one:m2']));
        const later = nextArchive(src, new Set(['user_one:m2', 'user_one:m3']));
        if (src.length !== 1 || src[0].uid !== 'user_one' || src[0].title !== '阿明'
            || src[0].messages.map(m => m.id).join() !== 'm3,m2'
            || !batch || batch.messages.map(m => m.id).join() !== 'm3'
            || later) {
            console.error('knock: 目前對話上傳失敗');
        }
        const dupImages = dropDuplicateImages([
            { text: '', imageUrls: ['https://x/a.jpg?token=1'], isMyMessage: false, timestamp: '01:02' },
            { text: '', imageUrls: ['https://x/a.jpg?token=2'], isMyMessage: false, timestamp: '01:02' },
            { text: 'hi', imageUrls: [], isMyMessage: true, timestamp: '01:03' },
            { text: '', imageUrls: ['data:image/jpeg;base64,qq'], imageKeys: ['https://x/a.jpg'], isMyMessage: false, timestamp: '01:02' }
        ]);
        if (stableImageKey('https://x/a.jpg?token=1') !== 'https://x/a.jpg'
            || stableImageKey('data:image/jpeg;base64,qq')
            || dupImages.length !== 2
            || !String(dupImages[0].imageUrls[0]).startsWith('data:')
            || dupImages[1].text !== 'hi') {
            console.error('knock: 圖片重複紀錄判斷失敗');
        }
        const uidFilters = [
            normalizeFilter({ u: ' uid1 ', t: ' 早安 ' }),
            normalizeFilter({ text: '在嗎', avatarHash: 'h2' }),
            normalizeFilter('舊句')
        ];
        if (uidFilters[0].u !== 'uid1' || uidFilters[0].t !== '早安' || uidFilters[1].u || uidFilters[2].t !== '舊句'
            || !firstFilterHit(uidFilters, 'uid1', '換一句', '')
            || firstFilterHit(uidFilters, 'uid9', '換一句', '')
            || !firstFilterHit(uidFilters, '', '在嗎', 'h2')
            || firstFilterHit(uidFilters, 'uid9', '在嗎', '別的頭像')) {
            console.error('knock: 發語詞改以使用者 id 過濾失敗');
        }
        if (openingLineName('  嗨  ', '') !== '嗨'
            || openingLineName('https://x/a.jpg', '')
            || openingLineName('新句子', '已命名')
            || openingLineName('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多餘', '').length !== 40
            || partnerNameFromLines('  嗨  ', '第二句', '') !== '嗨'
            || partnerNameFromLines('https://x/a.jpg', '第二句', '') !== '第二句'
            || partnerNameFromLines('', '第二句', '') !== '第二句'
            || partnerNameFromLines('嗨', '第二句', '已命名')) {
            console.error('knock: 發語詞當顯示名稱失敗');
        }
        const replyHost = document.createElement('div');
        replyHost.innerHTML = '<div data-test="message"><span><div><div><div></div><div><div data-test="user-avatar"></div><div>[unknown]</div><div>原文</div></div></div><div>回覆</div></div></span></div>';
        const replyDiv = replyHost.querySelector('[data-test="message"]');
        if (getMessageQuote(replyDiv) !== '原文' || getMessageText(replyDiv) !== '回覆') {
            console.error('knock: 回覆拆分失敗', getMessageQuote(replyDiv), getMessageText(replyDiv));
        }
        if (!relayShouldPushImage('relay.jpg', '') || !relayShouldPushImage('relay.gif', '')
            || relayShouldPushImage('relay.jpg', '草稿') || relayShouldPushImage('photo.jpg', '')) {
            console.error('knock: 遠端圖片送出判斷失敗');
        }
        const imageDone = new Set(['old']);
        if (relayImagePlan('old', imageDone, false) !== 'ack'
            || relayImagePlan('old', imageDone, true) !== 'ack'
            || relayImagePlan('new', imageDone, true) !== 'send') {
            console.error('knock: 遠端圖片只送一次失敗');
        }
        const ctrl = { auto: true, userFilter: true, avatarFilter: false, browser: true, phone: true, phoneTopic: 'abc', phoneTitle: 'Knock 新訊息', keep: false, keepText: '在嗎', keepMin: 1.5, keepMax: 2.5 };
        const quietNight = new Date(2026, 9, 6, 0, 20);
        if (!relayControlsMatch(ctrl, ctrl)
            || relayControlsMatch(ctrl, Object.assign({}, ctrl, { browser: false }))
            || relayControlsMatch(ctrl, Object.assign({}, ctrl, { phone: false }))
            || relayControlsMatch(ctrl, Object.assign({}, ctrl, { phoneTopic: 'other' }))
            || relayControlsMatch(ctrl, Object.assign({}, ctrl, { keep: true }))
            || keepRange(2.5, 1.5).min !== 1.5
            || keepRange(2.5, 1.5).max !== 2.5
            || messageAtMs('2026-10-06', '11:51', quietNight) !== new Date(2026, 9, 6, 11, 51).getTime()
            || messageAtMs('', '23:59', quietNight) !== new Date(2026, 9, 5, 23, 59).getTime()) {
            console.error('knock: 遠端控制比對失敗');
        }
        if (cooldownReasonText('firstFilter', '阿明') !== '開始聊天 · 過濾了 阿明'
            || cooldownReasonText('firstFilter', '') !== '開始聊天 · 使用者過濾而重連'
            || cooldownReasonText('selfLeft', '阿明') !== '開始聊天 · 我主動斷線') {
            console.error('knock: 過濾名稱提示失敗');
        }
    }

    if (isPendingStartChat()) console.log('重整後繼續：等待「開始聊天」按鈕...');
    requestNotifyPermission();
    checkForButtonAndClick();
    checkNewMessages();
    checkConversationEnd();
})();
