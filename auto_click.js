// ==UserScript==
// @name         Knock.tw Auto Clicker
// @namespace    http://tampermonkey.net/
// @version      1.4.24
// @description  Automatically click the "Re-match" and "Confirm Exit" buttons on Knock.tw, with conversation blacklist, avatar matching, and conversation saving features
// @author       Antigravity
// @match        https://knock.tw/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=knock.tw
// @updateURL    https://raw.githubusercontent.com/bency/knock-extension/main/auto_click.js
// @downloadURL  https://raw.githubusercontent.com/bency/knock-extension/main/auto_click.js
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// ==/UserScript==

(function() {
    'use strict';

    const BLACKLIST_PATTERNS = [
        /is\.gd\/[a-zA-Z0-9]+/i,
    ];
    const PENDING_START_CHAT_KEY = 'knockPendingStartChat';
    const PENDING_START_CHAT_REASON_KEY = 'knockPendingStartChatReason';
    const PENDING_START_CHAT_TTL_MS = 30000;
    const START_CHAT_REASON_LABEL = {
        otherLeft: '對方主動斷線',
        selfLeft: '我主動斷線',
        firstFilter: '發語詞略過而重連'
    };
    const FIRST_MSG_FILTER_KEY = 'knockFirstMessageFilters';
    const SAVED_CONV_KEY = 'knockSavedConversations';
    const AUTO_CONV_KEY = 'knockAutoConversations';
    const AUTO_CONV_MIN_MS = 50 * 1000;
    const NTFY_TOPIC_KEY = 'knockNtfyTopic';
    const NTFY_TITLE_KEY = 'knockNtfyTitle';
    const NTFY_TITLE_DEFAULT = 'Knock 新訊息';
    const NTFY_SERVER = 'https://ntfy.sh';
    const KEEP_ALIVE_ENABLED_KEY = 'knockKeepAliveEnabled';
    const KEEP_ALIVE_TEXT_KEY = 'knockKeepAliveText';
    const KEEP_ALIVE_AT_KEY = 'knockKeepAliveAt';
    const KEEP_ALIVE_MIN_H_KEY = 'knockKeepAliveMinHours';
    const KEEP_ALIVE_MAX_H_KEY = 'knockKeepAliveMaxHours';
    const KEEP_ALIVE_WAIT_KEY = 'knockKeepAliveWait';
    const KEEP_ALIVE_MIN_H_DEFAULT = 1.5;
    const KEEP_ALIVE_MAX_H_DEFAULT = 2.5;
    const TYPING_RE = /對方正在輸入|正在輸入|typing/i;
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.4.23';
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

    function el(id) {
        return document.getElementById(id);
    }

    function makeOverlay(id, maxWidth, html, z) {
        const node = document.createElement('div');
        node.id = id;
        node.style.cssText = `position:fixed;inset:0;z-index:${z || 10002};background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow-y:auto;`;
        node.innerHTML = `<div style="max-width:${maxWidth}px;margin:0 auto;padding:24px;">${html}</div>`;
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

    const savedAutoClick = localStorage.getItem('knockAutoClickEnabled');
    let autoClickEnabled = savedAutoClick === null ? true : savedAutoClick === 'true';
    let keepAliveEnabled = localStorage.getItem(KEEP_ALIVE_ENABLED_KEY) === 'true';
    let lastActivityAt = 0;
    let lastKeepAliveTryAt = 0;
    let lastKeepAliveSentAt = 0;
    let keepAliveWaitMs = 0;

    const checkedMessages = new Set();
    let myAvatarUrl = null;
    let currentConversation = emptyConversation();
    let isSavePromptVisible = false;
    let processedConversationIds = new Set(storageGet('knockProcessedConversationIds', []));
    let notificationsArmed = false;
    let pendingForcedLeave = false;
    let lastExitClickAt = 0;
    let skipFirstFilterFor = null;
    let rematchScheduled = false;
    let startChatScheduled = false;
    let cooldownUntil = 0;
    let cooldownLabel = '';
    let cooldownTick = null;
    let persistLiveTimer = null;
    let conversationManagerTab = 'auto';

    function emptyConversation() {
        return { id: null, messages: [], startTime: null, endTime: null, saved: false, promptShown: false, pinned: false };
    }

    function saveProcessedIds() {
        storageSet('knockProcessedConversationIds', Array.from(processedConversationIds));
    }

    function markProcessed(conversation) {
        conversation.promptShown = true;
        conversation.saved = true;
        if (conversation.id) {
            processedConversationIds.add(conversation.id);
            saveProcessedIds();
        }
    }

    function isConversationProcessed(conversationId) {
        if (!conversationId) return false;
        if (processedConversationIds.has(conversationId)) return true;
        const isSaved = getSavedConversations().some(conv => conv.id === conversationId);
        if (isSaved) {
            processedConversationIds.add(conversationId);
            saveProcessedIds();
        }
        return isSaved;
    }

    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    function initNewConversation() {
        if (currentConversation.id && currentConversation.messages.length) {
            currentConversation.endTime = currentConversation.endTime || new Date().toISOString();
            persistLiveConversation();
        }
        currentConversation = {
            ...emptyConversation(),
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            startTime: new Date().toISOString()
        };
        pendingForcedLeave = false;
        lastExitClickAt = 0;
        skipFirstFilterFor = null;
        rematchScheduled = false;
        startChatScheduled = false;
        hideCooldown();
        lastActivityAt = 0;
        lastKeepAliveTryAt = 0;
        lastKeepAliveSentAt = 0;
        keepAliveWaitMs = 0;
        sessionStorage.removeItem(KEEP_ALIVE_AT_KEY);
        sessionStorage.removeItem(KEEP_ALIVE_WAIT_KEY);
        console.log('初始化新對話:', currentConversation.id);
    }

    function avatarHashOf(url) {
        return url ? hashString(url) : '';
    }

    function normalizeFilter(item) {
        if (item && typeof item === 'object') {
            const t = String(item.t ?? item.text ?? '').trim();
            const a = String(item.a ?? item.avatarHash ?? '');
            return t ? { t, a } : null;
        }
        const t = String(item ?? '').trim();
        return t ? { t, a: '' } : null;
    }

    function getNormalizedFilters() {
        return storageGet(FIRST_MSG_FILTER_KEY, []).map(normalizeFilter).filter(Boolean);
    }

    function isFirstMessageFiltered(text, avatarHash) {
        const t = (text || '').trim();
        const a = avatarHash || '';
        if (!t) return false;
        return getNormalizedFilters().some(f => f.t === t && f.a === a);
    }

    function addFirstMessageFilter(text, avatarHash) {
        const t = (text || '').trim();
        const a = avatarHash || '';
        if (!t || TYPING_RE.test(t)) return false;
        const list = getNormalizedFilters();
        if (list.some(f => f.t === t && f.a === a)) return false;
        list.push({ t, a });
        return storageSet(FIRST_MSG_FILTER_KEY, list);
    }

    function removeFirstMessageFilter(text, avatarHash) {
        const t = (text || '').trim();
        const a = avatarHash || '';
        return storageSet(FIRST_MSG_FILTER_KEY, getNormalizedFilters().filter(f => !(f.t === t && f.a === a)));
    }

    function clearFirstMessageFilters() {
        return storageSet(FIRST_MSG_FILTER_KEY, []);
    }

    function exportFirstMessageFilters() {
        const list = getNormalizedFilters();
        const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `knock-發語詞過濾-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        return list.length;
    }

    function parseImportedFilters(raw) {
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : data && data.filters;
        if (!Array.isArray(list)) throw new Error('格式不對');
        return list.map(normalizeFilter).filter(Boolean);
    }

    function importFirstMessageFilters(incoming) {
        const list = getNormalizedFilters();
        const seen = new Set(list.map(f => `${f.t}\0${f.a}`));
        let added = 0;
        for (const item of incoming) {
            const f = normalizeFilter(item);
            if (!f || TYPING_RE.test(f.t)) continue;
            const key = `${f.t}\0${f.a}`;
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
        btn.title = on ? '已記住發語詞，再點取消' : '記住發語詞';
    }

    function syncRememberButtons() {
        document.querySelectorAll('.knock-remember-first, .knock-remember-first-saved').forEach(btn => {
            const text = decodeURIComponent(btn.dataset.filterText || '');
            const avatarHash = decodeURIComponent(btn.dataset.filterAvatar || '');
            paintRememberButton(btn, !!(text && isFirstMessageFiltered(text, avatarHash)));
        });
        const badge = el('knock-filter-count');
        if (badge) badge.textContent = String(getNormalizedFilters().length);
    }

    function toggleFirstMessageFilter(text, avatarHash) {
        const t = (text || '').trim();
        const a = avatarHash || '';
        if (!t) return false;
        if (isFirstMessageFiltered(t, a)) {
            removeFirstMessageFilter(t, a);
            syncRememberButtons();
            showToast('已從發語詞過濾移除');
            return false;
        }
        if (addFirstMessageFilter(t, a)) {
            const first = findFirstOtherMessage();
            skipFirstFilterFor = first ? pairingIdOf(first) : t;
            pendingForcedLeave = false;
            syncRememberButtons();
            showToast('已記住發語詞與頭像，同一人相同開頭才會離開');
            return true;
        }
        return false;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

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

    function getMessageText(messageDiv) {
        const timeEl = messageDiv.querySelector('span[data-test="date"]');
        if (!timeEl) return messageDiv.textContent.trim();
        const clone = messageDiv.cloneNode(true);
        clone.querySelector('div[style*="grid-area: date"]')?.remove();
        clone.querySelectorAll('[data-test="message-image"]').forEach(el => el.remove());
        return clone.textContent.trim();
    }

    function getMessageImages(messageDiv) {
        return Array.from(messageDiv.querySelectorAll('[data-test="message-image"] img'))
            .map(img => img.currentSrc || img.src)
            .filter(src => src && /^https?:\/\//.test(src));
    }

    function messagePreviewText(msg) {
        if (msg.text) return msg.text;
        if (msg.imageUrls && msg.imageUrls.length) return '[圖片]';
        return '';
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

    function dateFromKnockLabel(timeStr, now = new Date()) {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        if (timeStr && timeStr.includes('前天')) d.setDate(d.getDate() - 2);
        else if (timeStr && timeStr.includes('昨天')) d.setDate(d.getDate() - 1);
        return ymd(d);
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
            const clock = clockMinutesOnly(timeStr);
            if (clock == null) continue;
            rows.push({ li, clock, labeled: labelDayOffset(timeStr) });
        }
        const offsets = dayOffsetsFromNewest(rows);
        const dates = new Map();
        rows.forEach((row, i) => dates.set(row.li, shiftYmd(-offsets[i])));
        return dates;
    }

    function messageDate(msg, startTime) {
        if (msg.date) return msg.date;
        if (/昨天|前天/.test(msg.timestamp || '')) return dateFromKnockLabel(msg.timestamp);
        if (startTime) return ymd(new Date(startTime));
        return dateFromKnockLabel(msg.timestamp);
    }

    function collectMessage(messageLi, date) {
        const messageDiv = messageLi.querySelector('div[data-test="message"]');
        if (!messageDiv) return;

        const isMyMessage = isMyMessageLi(messageLi);
        const timeElement = messageDiv.querySelector('span[data-test="date"]');
        const timestamp = timeElement ? timeElement.textContent.trim() : null;
        date = date || '';
        const messageText = getMessageText(messageDiv);
        const imageUrls = getMessageImages(messageDiv);
        if (TYPING_RE.test(messageText)) return;
        if (!messageText && !imageUrls.length) return;

        const clock = clockMinutesOnly(timestamp);
        const messageHash = hashString(`${messageText}|${imageUrls.join(',')}|${isMyMessage}|${clock ?? ''}`);
        const existing = currentConversation.messages.find(m => m.id === messageHash);
        if (existing) {
            if (date && existing.date !== date) {
                existing.date = date;
                persistLiveConversationSoon();
            }
            return;
        }

        currentConversation.messages.push({
            id: messageHash,
            text: messageText,
            imageUrls,
            isMyMessage,
            avatarUrl: getAvatarUrl(messageLi),
            timestamp,
            date,
            seq: currentConversation.messages.length,
            collectedAt: new Date().toISOString()
        });
        console.log('收集訊息:', messageText || '[圖片]', imageUrls);
        noteActivity();
        persistLiveConversationSoon();
    }

    function getSavedConversations() {
        return storageGet(SAVED_CONV_KEY, []);
    }

    function getAutoConversations() {
        return storageGet(AUTO_CONV_KEY, []);
    }

    function findStoredConversation(conversationId) {
        return getSavedConversations().find(conv => conv.id === conversationId)
            || getAutoConversations().find(conv => conv.id === conversationId)
            || null;
    }

    function upsertConversationList(key, conversation, limit) {
        if (!conversation.id || !conversation.messages.length) return false;
        const list = storageGet(key, []);
        const snap = {
            ...conversation,
            messages: sortMessages(conversation.messages.slice(), conversation.startTime),
            endTime: conversation.endTime || new Date().toISOString()
        };
        const i = list.findIndex(c => c.id === conversation.id);
        if (i >= 0) list[i] = snap;
        else list.unshift(snap);
        if (list.length > limit) list.length = limit;
        return storageSet(key, list);
    }

    function conversationDurationMs(conversation) {
        const start = conversation.startTime ? Date.parse(conversation.startTime) : NaN;
        if (!Number.isFinite(start)) return 0;
        const end = conversation.endTime ? Date.parse(conversation.endTime) : Date.now();
        return Math.max(0, end - start);
    }

    function messageIdSet(messages) {
        return new Set((messages || []).map(m => m.id).filter(Boolean));
    }

    function hashOverlapCount(conv, ids) {
        let n = 0;
        for (const m of conv.messages || []) {
            if (ids.has(m.id)) n++;
        }
        return n;
    }

    function findConversationByHashes(messages) {
        const ids = messageIdSet(messages);
        if (!ids.size) return null;
        let best = null;
        let bestN = 0;
        for (const conv of [...getSavedConversations(), ...getAutoConversations()]) {
            const n = hashOverlapCount(conv, ids);
            if (n > bestN) {
                bestN = n;
                best = conv;
            }
        }
        return bestN > 0 ? best : null;
    }

    function mergeMessagesByHash(a, b) {
        const map = new Map();
        for (const m of [...(a || []), ...(b || [])]) {
            if (m && m.id && !map.has(m.id)) map.set(m.id, m);
        }
        return Array.from(map.values());
    }

    function adoptOverlappingConversation() {
        const found = findConversationByHashes(currentConversation.messages);
        if (!found || found.id === currentConversation.id) return;
        const inSaved = getSavedConversations().some(c => c.id === found.id);
        currentConversation.id = found.id;
        currentConversation.pinned = currentConversation.pinned || found.pinned || inSaved;
        if (found.startTime && (!currentConversation.startTime || found.startTime < currentConversation.startTime)) {
            currentConversation.startTime = found.startTime;
        }
        currentConversation.messages = mergeMessagesByHash(found.messages, currentConversation.messages);
        console.log('同一對話（訊息 hash 重疊），合併到', found.id);
    }

    function dropOverlappingAutoDuplicates() {
        const ids = messageIdSet(currentConversation.messages);
        const keep = currentConversation.id;
        storageSet(AUTO_CONV_KEY, getAutoConversations().filter(c => c.id === keep || hashOverlapCount(c, ids) === 0));
    }

    function persistLiveConversation() {
        if (!currentConversation.id || !currentConversation.messages.length) return;
        adoptOverlappingConversation();
        if (currentConversation.pinned) {
            upsertConversationList(SAVED_CONV_KEY, currentConversation, 100);
            dropOverlappingAutoDuplicates();
            return;
        }
        if (conversationDurationMs(currentConversation) < AUTO_CONV_MIN_MS) return;
        upsertConversationList(AUTO_CONV_KEY, currentConversation, 200);
        dropOverlappingAutoDuplicates();
    }

    function persistLiveConversationSoon() {
        clearTimeout(persistLiveTimer);
        persistLiveTimer = setTimeout(persistLiveConversation, 400);
    }

    function pinConversation(conversationId) {
        const conv = findStoredConversation(conversationId)
            || (currentConversation.id === conversationId ? currentConversation : null);
        if (!conv) return false;
        conv.pinned = true;
        if (currentConversation.id === conversationId) currentConversation.pinned = true;
        storageSet(AUTO_CONV_KEY, getAutoConversations().filter(c => c.id !== conversationId));
        return upsertConversationList(SAVED_CONV_KEY, conv, 100);
    }

    function saveConversation(conversation) {
        if (!conversation.id || !conversation.messages.length) return false;
        conversation.pinned = true;
        conversation.saved = true;
        conversation.endTime = conversation.endTime || new Date().toISOString();
        if (currentConversation.id === conversation.id) currentConversation.pinned = true;
        storageSet(AUTO_CONV_KEY, getAutoConversations().filter(c => c.id !== conversation.id));
        if (!upsertConversationList(SAVED_CONV_KEY, conversation, 100)) return false;
        markProcessed(conversation);
        console.log('對話已儲存:', conversation.id);
        return true;
    }

    function deleteConversations(ids) {
        const set = new Set(ids);
        return storageSet(SAVED_CONV_KEY, getSavedConversations().filter(c => !set.has(c.id)))
            && storageSet(AUTO_CONV_KEY, getAutoConversations().filter(c => !set.has(c.id)));
    }

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
        if (currentConversation.promptShown || currentConversation.saved) return;
        if (currentConversation.id && isConversationProcessed(currentConversation.id)) {
            currentConversation.saved = true;
            return;
        }

        const conversationEnded = findButtons().some(b => isRematchButton(b) || isConfirmExitButton(b));
        if (!conversationEnded || currentConversation.messages.length === 0) return;

        currentConversation.endTime = currentConversation.endTime || new Date().toISOString();
        persistLiveConversation();

        if (autoClickEnabled) {
            markProcessed(currentConversation);
            markPendingStartChat(findButtons().some(isRematchButton) ? 'otherLeft' : pendingForcedLeave ? undefined : 'selfLeft');
            console.log('自動開啟新對話啟用中，略過儲存提示:', currentConversation.id);
            return;
        }

        currentConversation.promptShown = true;
        setTimeout(() => {
            if (autoClickEnabled) {
                markProcessed(currentConversation);
                return;
            }
            if (!isConversationProcessed(currentConversation.id)) showSavePrompt();
            else currentConversation.saved = true;
        }, 1000);
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

    function checkAvatarMatch(otherMessageLi) {
        const myAvatar = getMyAvatarUrl();
        const otherAvatar = getAvatarUrl(otherMessageLi);
        return !!(myAvatar && otherAvatar && myAvatar === otherAvatar);
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
    }

    function startChatCooldownLabel() {
        const reason = START_CHAT_REASON_LABEL[sessionStorage.getItem(PENDING_START_CHAT_REASON_KEY)];
        return reason ? `開始聊天 · ${reason}` : '開始聊天';
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
        if (!autoClickEnabled || isSavePromptVisible) return;

        for (const button of findButtons()) {
            if (isPendingStartChat() && isStartChatButton(button)) {
                if (!startChatScheduled) {
                    startChatScheduled = true;
                    showCooldown(startChatCooldownLabel(), 2000);
                    setTimeout(() => {
                        startChatScheduled = false;
                        hideCooldown();
                        if (!autoClickEnabled || !isPendingStartChat()) return;
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
                if (!isSavePromptVisible && !rematchScheduled) {
                    rematchScheduled = true;
                    showCooldown('重新配對', 3000);
                    setTimeout(() => {
                        rematchScheduled = false;
                        hideCooldown();
                        if (isSavePromptVisible) return;
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
                if (!isSavePromptVisible) {
                    markPendingStartChat(pendingForcedLeave ? undefined : 'selfLeft');
                    simulateMouseClick(button);
                    console.log('已記下「開始聊天」，等待頁面重整...');
                }
                return;
            }
        }
    }

    function checkMessageAgainstBlacklist(messageElement) {
        const messageText = messageElement.textContent || '';
        return BLACKLIST_PATTERNS.some(pattern => pattern.test(messageText));
    }

    function requestForcedLeave(reason) {
        if (!autoClickEnabled) return;
        if (!pendingForcedLeave) {
            pendingForcedLeave = true;
            markPendingStartChat(reason);
            console.log('已記下要離開，等待退出按鈕:', reason);
        }
        tryForcedLeave();
    }

    function tryForcedLeave() {
        if (!pendingForcedLeave || !autoClickEnabled || isSavePromptVisible) return false;
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
            if (!messageDiv) continue;
            const text = getMessageText(messageDiv);
            const imageUrls = getMessageImages(messageDiv);
            const filterKey = text || imageUrls[0] || '';
            if (!filterKey || TYPING_RE.test(text)) continue;
            const avatarUrl = getAvatarUrl(li);
            return { li, messageId: li.className, filterKey, imageUrls, messageDiv, avatarUrl, avatarHash: avatarHashOf(avatarUrl) };
        }
        return null;
    }

    function maybeLeaveOnFirstMessageFilter() {
        if (!autoClickEnabled || isSavePromptVisible) return false;
        const first = findFirstOtherMessage();
        if (!first) return false;
        if (skipFirstFilterFor && skipFirstFilterFor === pairingIdOf(first)) return false;
        const hit = isFirstMessageFiltered(first.filterKey, first.avatarHash)
            || first.imageUrls.some(url => isFirstMessageFiltered(url, first.avatarHash));
        if (!hit) return false;
        console.log('發語詞與頭像命中過濾，準備重連:', first.filterKey, first.avatarHash);
        requestForcedLeave('firstFilter');
        return pendingForcedLeave;
    }

    function requestNotifyPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') return;
        Notification.requestPermission().catch(() => {});
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
        if (Date.now() - lastNtfyAt > 15000) sendNtfy(body);
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const notification = new Notification('Knock 新訊息', { body, tag: 'knock-new-message' });
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    }

    function checkNewMessages() {
        const messagesList = document.querySelector('ul[data-test="messages"]');
        if (!messagesList) return;

        const dateByLi = listMessageDates(messagesList);
        const messageElements = messagesList.querySelectorAll('li.message-li');
        if (!currentConversation.id || (currentConversation.saved && currentConversation.messages.length === 0)) {
            if (messageElements.length === 0) return;
            console.log('Initializing new conversation...');
            initNewConversation();
        }

        if (maybeLeaveOnFirstMessageFilter() || tryForcedLeave()) return;

        for (const messageLi of messageElements) {
            const messageId = messageLi.className;
            collectMessage(messageLi, dateByLi.get(messageLi) || '');
            if (checkedMessages.has(messageId)) continue;
            checkedMessages.add(messageId);

            const messageDiv = messageLi.querySelector('div[data-test="message"]');
            if (!messageDiv || isMyMessageLi(messageLi)) continue;

            const messageText = getMessageText(messageDiv);
            const imageUrls = getMessageImages(messageDiv);
            if (TYPING_RE.test(messageText)) continue;

            const notifyText = messageText || (imageUrls.length ? '[圖片]' : '');
            if (notifyText) notifyNewMessage(notifyText);

            if (checkAvatarMatch(messageLi) || checkMessageAgainstBlacklist(messageDiv)) {
                activelyLeaveConversation(messageId);
                return;
            }
        }

        decorateOtherMessages();
        checkConversationEnd();
    }

    function onRememberRowClick(e) {
        if (e.target.closest('a, [data-test="user-avatar"]')) return;
        const first = findFirstOtherMessage();
        if (!first || first.li !== e.currentTarget) return;
        toggleFirstMessageFilter(first.filterKey, first.avatarHash);
    }

    function decorateOtherMessages() {
        const list = document.querySelector('ul[data-test="messages"]');
        if (!list) return;

        const first = findFirstOtherMessage();
        list.querySelectorAll('.knock-remember-first').forEach(btn => {
            if (!first || !first.li.contains(btn)) btn.remove();
        });
        if (!first) return;
        if (first.li.querySelector('.knock-remember-first')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'knock-remember-first';
        btn.dataset.filterText = encodeURIComponent(first.filterKey);
        btn.dataset.filterAvatar = encodeURIComponent(first.avatarHash);
        paintRememberButton(btn, isFirstMessageFiltered(first.filterKey, first.avatarHash));
        const row = first.li.firstElementChild;
        (row || first.li).appendChild(btn);

        if (!first.li.dataset.knockRememberRow) {
            first.li.dataset.knockRememberRow = '1';
            first.li.style.cursor = 'pointer';
            first.li.addEventListener('click', onRememberRowClick);
        }
    }

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
        const autoSw = dockSwitch(autoClickEnabled);
        autoRow.append(autoSw);
        autoRow.addEventListener('click', (e) => {
            e.stopPropagation();
            autoClickEnabled = !autoClickEnabled;
            localStorage.setItem('knockAutoClickEnabled', String(autoClickEnabled));
            autoSw.paint(autoClickEnabled);
            requestNotifyPermission();
        });

        const keepRow = dockRow('<span>持續連線</span>');
        const keepSw = dockSwitch(keepAliveEnabled);
        keepRow.append(keepSw);
        keepRow.addEventListener('click', (e) => {
            e.stopPropagation();
            keepAliveEnabled = !keepAliveEnabled;
            localStorage.setItem(KEEP_ALIVE_ENABLED_KEY, String(keepAliveEnabled));
            keepSw.paint(keepAliveEnabled);
            if (keepAliveEnabled && !getKeepAliveText()) showToast('請先輸入避免斷線的句子');
        });

        const keepInput = document.createElement('input');
        keepInput.type = 'text';
        keepInput.placeholder = '沒說話就送這句';
        keepInput.value = getKeepAliveText();
        keepInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #444;border-radius:8px;background:#1a1a1a;color:#fff;font:inherit;font-size:13px;';
        keepInput.addEventListener('click', (e) => e.stopPropagation());
        keepInput.addEventListener('input', () => localStorage.setItem(KEEP_ALIVE_TEXT_KEY, keepInput.value));

        const hoursInp = (value) => {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.min = '0.1';
            inp.step = '0.1';
            inp.value = String(value);
            inp.style.cssText = 'width:52px;box-sizing:border-box;padding:6px 4px;border:1px solid #444;border-radius:6px;background:#1a1a1a;color:#fff;font:inherit;font-size:12px;';
            inp.addEventListener('click', (e) => e.stopPropagation());
            return inp;
        };
        const range = keepAliveHoursRange();
        const minInp = hoursInp(range.min);
        const maxInp = hoursInp(range.max);
        const saveRange = () => {
            setKeepAliveHoursRange(minInp.value, maxInp.value);
            const next = keepAliveHoursRange();
            minInp.value = String(next.min);
            maxInp.value = String(next.max);
            rollKeepAliveWaitMs();
        };
        minInp.addEventListener('change', saveRange);
        maxInp.addEventListener('change', saveRange);
        const rangeRow = document.createElement('div');
        rangeRow.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:#aaa;';
        const tilde = document.createElement('span');
        tilde.textContent = '～';
        const unit = document.createElement('span');
        unit.textContent = '小時';
        rangeRow.append(minInp, tilde, maxInp, unit);

        const convBtn = dockRow('<span>對話記錄</span>', { button: true });
        convBtn.addEventListener('click', (e) => { e.stopPropagation(); createConversationManager(); });

        const filterBtn = dockRow(
            `<span>發語詞過濾</span><span id="knock-filter-count" style="background:#ff9800;border-radius:10px;padding:0 6px;font-size:12px;min-width:1.2em;text-align:center;">${getNormalizedFilters().length}</span>`,
            { button: true }
        );
        filterBtn.addEventListener('click', (e) => { e.stopPropagation(); createFirstFilterManager(); });

        const ntfyBtn = dockRow('<span>手機通知</span>', { button: true });
        ntfyBtn.addEventListener('click', (e) => { e.stopPropagation(); createNtfySettings(); });

        body.append(autoRow, keepRow, keepInput, rangeRow, convBtn, filterBtn, ntfyBtn);

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

    function getKeepAliveText() {
        return (localStorage.getItem(KEEP_ALIVE_TEXT_KEY) || '').trim();
    }

    function keepAliveHoursRange() {
        let min = Number(localStorage.getItem(KEEP_ALIVE_MIN_H_KEY));
        let max = Number(localStorage.getItem(KEEP_ALIVE_MAX_H_KEY));
        if (!Number.isFinite(min) || min < 0.1) min = KEEP_ALIVE_MIN_H_DEFAULT;
        if (!Number.isFinite(max) || max < 0.1) max = KEEP_ALIVE_MAX_H_DEFAULT;
        if (max < min) [min, max] = [max, min];
        return { min, max };
    }

    function setKeepAliveHoursRange(minVal, maxVal) {
        let min = Number(minVal);
        let max = Number(maxVal);
        if (!Number.isFinite(min) || min < 0.1) min = KEEP_ALIVE_MIN_H_DEFAULT;
        if (!Number.isFinite(max) || max < 0.1) max = KEEP_ALIVE_MAX_H_DEFAULT;
        if (max < min) [min, max] = [max, min];
        localStorage.setItem(KEEP_ALIVE_MIN_H_KEY, String(min));
        localStorage.setItem(KEEP_ALIVE_MAX_H_KEY, String(max));
        return { min, max };
    }

    function rollKeepAliveWaitMs() {
        const { min, max } = keepAliveHoursRange();
        keepAliveWaitMs = (min + Math.random() * (max - min)) * 3600000;
        if (currentConversation.id) {
            sessionStorage.setItem(KEEP_ALIVE_WAIT_KEY, JSON.stringify({
                id: currentConversation.id,
                ms: keepAliveWaitMs
            }));
        }
        return keepAliveWaitMs;
    }

    function currentKeepAliveWaitMs() {
        try {
            const raw = JSON.parse(sessionStorage.getItem(KEEP_ALIVE_WAIT_KEY) || 'null');
            if (raw && raw.id === currentConversation.id && raw.ms > 0) {
                keepAliveWaitMs = raw.ms;
                return keepAliveWaitMs;
            }
        } catch (e) {}
        if (keepAliveWaitMs > 0) return keepAliveWaitMs;
        return rollKeepAliveWaitMs();
    }

    function noteActivity() {
        lastActivityAt = Date.now();
        if (!currentConversation.id) return;
        sessionStorage.setItem(KEEP_ALIVE_AT_KEY, JSON.stringify({
            id: currentConversation.id,
            at: lastActivityAt
        }));
    }

    function lastChatAt() {
        let latest = lastKeepAliveSentAt;
        const consider = (msg) => {
            const d = timestampToDate(msg, currentConversation.startTime);
            if (d) latest = Math.max(latest, d.getTime());
        };
        currentConversation.messages.forEach(consider);
        const list = document.querySelector('ul[data-test="messages"]');
        if (list) {
            const dates = listMessageDates(list);
            for (const li of list.querySelectorAll('li.message-li')) {
                const timeEl = li.querySelector('span[data-test="date"]');
                if (!timeEl) continue;
                consider({ timestamp: timeEl.textContent.trim(), date: dates.get(li) });
            }
        }
        return latest;
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
        pressEnter(box);
        let tries = 0;
        const cleared = () => !box.value.trim();
        const tick = () => {
            if (cleared()) {
                if (onSent) onSent();
                return;
            }
            if (box.value !== text) fillReactInput(box, text);
            const send = document.querySelector('button[data-test="send"]');
            if (send && !send.disabled) {
                send.click();
                simulateMouseClick(send);
            } else {
                pressEnter(box);
            }
            if (++tries < 15) setTimeout(tick, 80);
        };
        setTimeout(tick, 50);
        return true;
    }

    function tryKeepAlive() {
        if (!keepAliveEnabled) return;
        const text = getKeepAliveText();
        if (!text) return;
        if (!currentConversation.id || !currentConversation.messages.length) return;
        if (pendingForcedLeave || isSavePromptVisible) return;
        if (findButtons().some(b => isRematchButton(b) || isConfirmExitButton(b))) return;
        const at = lastChatAt();
        const wait = currentKeepAliveWaitMs();
        if (!at || Date.now() - at < wait) return;
        if (Date.now() - lastKeepAliveTryAt < 60000) return;
        lastKeepAliveTryAt = Date.now();
        sendChatMessage(text, () => {
            lastKeepAliveSentAt = Date.now();
            noteActivity();
            rollKeepAliveWaitMs();
            console.log('持續連線：已送出，下次約', (keepAliveWaitMs / 3600000).toFixed(2), '小時後');
        });
    }

    function dismissSavePrompt(prompt, save) {
        prompt.remove();
        isSavePromptVisible = false;
        if (save) return;
        markProcessed(currentConversation);
        console.log('對話已標記為不儲存:', currentConversation.id);
    }

    function showSavePrompt() {
        if (el('knock-save-prompt') || currentConversation.saved) return;
        if (currentConversation.id && isConversationProcessed(currentConversation.id)) {
            currentConversation.saved = true;
            return;
        }

        isSavePromptVisible = true;
        const prompt = document.createElement('div');
        prompt.id = 'knock-save-prompt';
        prompt.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 10001; background: rgba(0, 0, 0, 0.95); border-radius: 12px;
            padding: 24px; min-width: 320px; max-width: 90%;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); font-family: ${FONT}; color: #fff;
        `;
        prompt.innerHTML = `
            <div style="margin-bottom: 16px; font-size: 18px; font-weight: 600;">對話已結束</div>
            <div style="margin-bottom: 20px; font-size: 14px; color: #ccc;">
                本次對話共有 ${currentConversation.messages.length} 條訊息，是否要儲存？
            </div>
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button id="knock-save-cancel" style="${cssBtn('#444')}">不儲存</button>
                <button id="knock-save-confirm" style="${cssBtn('#4CAF50', 'font-weight:600;')}">儲存對話</button>
            </div>
        `;
        document.body.appendChild(prompt);

        el('knock-save-cancel').onclick = () => dismissSavePrompt(prompt, false);
        prompt.addEventListener('click', (e) => {
            if (e.target === prompt) dismissSavePrompt(prompt, false);
        });
        el('knock-save-confirm').onclick = () => {
            if (!saveConversation(currentConversation)) {
                alert('儲存失敗，請重試');
                return;
            }
            prompt.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <div style="font-size: 18px; margin-bottom: 12px;">✓ 已儲存</div>
                    <div style="font-size: 14px; color: #ccc;">對話已成功儲存</div>
                </div>`;
            setTimeout(() => dismissSavePrompt(prompt, true), 1500);
        };
    }

    function timestampToDate(msg, startTime, now = new Date()) {
        const minutes = clockMinutesOnly(msg.timestamp);
        if (minutes == null) return null;
        const [y, mo, d] = messageDate(msg, startTime).split('-').map(Number);
        const date = new Date(y, mo - 1, d);
        date.setHours(0, 0, 0, 0);
        date.setMinutes(minutes);
        if (date.getTime() > now.getTime() + 60000) date.setDate(date.getDate() - 1);
        return date;
    }

    function getMessageTime(conversation, isOldest = true) {
        const start = conversation.startTime ? new Date(conversation.startTime) : new Date();
        const end = conversation.endTime ? new Date(conversation.endTime) : null;
        const dates = (conversation.messages || [])
            .map(m => timestampToDate(m, conversation.startTime))
            .filter(Boolean);
        if (dates.length === 0) return isOldest ? start : end;
        return new Date(isOldest ? Math.min(...dates) : Math.max(...dates));
    }

    function formatDuration(startDate, endDate) {
        if (!endDate) return '';
        const sec = Math.round((endDate - startDate) / 1000);
        const min = Math.floor(sec / 60);
        if (min <= 0) return `${sec} 秒`;
        const rem = sec % 60;
        return rem > 0 ? `${min} 分鐘 ${rem} 秒` : `${min} 分鐘`;
    }

    // 沒時間的是開頭；其餘依收集時寫入的日期 + 鐘點
    function sortMessages(messages, startTime) {
        return messages
            .map((msg, index) => ({ msg, index }))
            .sort((a, b) => {
                const ca = clockMinutesOnly(a.msg.timestamp);
                const cb = clockMinutesOnly(b.msg.timestamp);
                if (ca == null && cb == null) return a.index - b.index;
                if (ca == null) return -1;
                if (cb == null) return 1;
                const da = messageDate(a.msg, startTime);
                const db = messageDate(b.msg, startTime);
                if (da !== db) return da < db ? -1 : 1;
                if (ca !== cb) return ca - cb;
                return a.index - b.index;
            })
            .map(x => x.msg);
    }

    function formatConversationForCopy(conversation) {
        return sortMessages(conversation.messages, conversation.startTime).map(msg => {
            const speaker = msg.isMyMessage ? '我　' : '對方';
            const content = [msg.text, ...(msg.imageUrls || [])].filter(Boolean).join(' ') || '[圖片]';
            return `${speaker}：${content} （${msg.timestamp || '未知時間'}）`;
        }).join('\n');
    }

    async function copyConversation(conversationId) {
        const conversation = findStoredConversation(conversationId);
        if (!conversation) {
            alert('找不到此對話');
            return;
        }
        const text = formatConversationForCopy(conversation);
        try {
            await navigator.clipboard.writeText(text);
            showToast('對話內容已複製到剪貼板');
        } catch (err) {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.cssText = 'position:fixed;left:-999999px';
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                alert('對話內容已複製到剪貼板');
            } catch (e) {
                alert('複製失敗，請手動複製');
            }
            textArea.remove();
        }
    }

    function createConversationCard(conversation) {
        const startDate = getMessageTime(conversation, true);
        const endDate = getMessageTime(conversation, false);
        const durationText = formatDuration(startDate, endDate);
        const preview = sortMessages(conversation.messages, conversation.startTime).slice(0, 3).map(msg => {
            const text = messagePreviewText(msg);
            return (msg.isMyMessage ? '我: ' : '對方: ') + text.substring(0, 50) + (text.length > 50 ? '...' : '');
        }).join('<br>');

        return `
            <div class="knock-conv-card" style="background:#222;border-radius:8px;padding:16px;border:1px solid #444;">
                <div style="display:flex;gap:12px;align-items:flex-start;">
                    <input type="checkbox" class="knock-conv-check" data-conv-id="${conversation.id}" style="margin-top:4px;width:18px;height:18px;flex-shrink:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">
                            <div>
                                <div style="font-size:14px;color:#888;margin-bottom:4px;">
                                    ${startDate.toLocaleString('zh-TW')}${durationText ? ` · 持續 ${durationText}` : ''}
                                </div>
                                <div style="font-size:12px;color:#666;">${conversation.messages.length} 條訊息</div>
                            </div>
                            <div style="display:flex;gap:8px;">
                                ${conversationManagerTab === 'auto' ? `<button class="knock-pin-btn" data-conv-id="${conversation.id}" style="${cssBtn('#4CAF50', 'padding:6px 12px;border-radius:4px;font-size:12px;')}">儲存</button>` : ''}
                                <button class="knock-copy-btn" data-conv-id="${conversation.id}" style="${cssBtn('#2196F3', 'padding:6px 12px;border-radius:4px;font-size:12px;')}">複製</button>
                            </div>
                        </div>
                        <div style="background:#1a1a1a;border-radius:6px;padding:12px;font-size:13px;color:#ccc;line-height:1.6;max-height:150px;overflow-y:auto;">${preview}</div>
                        <button class="knock-view-btn" data-conv-id="${conversation.id}" style="${cssBtn('#4CAF50', 'margin-top:12px;font-size:13px;width:100%;')}">查看完整對話</button>
                    </div>
                </div>
            </div>`;
    }

    function createNtfySettings() {
        const current = getNtfyTopic();
        const panel = toggleOverlay('knock-ntfy-settings', () => makeOverlay('knock-ntfy-settings', 520, `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;">
                <h2 style="margin:0;font-size:24px;">手機通知（ntfy）</h2>
                <button id="knock-ntfy-close" style="${cssBtn('#444')}">關閉</button>
            </div>
            <div style="font-size:13px;color:#888;margin-bottom:16px;line-height:1.6;">
                分頁沒在看時，新訊息會推到手機。請安裝
                <a href="https://ntfy.sh/app" target="_blank" rel="noreferrer" style="color:#8ab4f8;">ntfy App</a>
                ，伺服器選 <b style="color:#ccc;">ntfy.sh</b>，訂閱下方同一個主題。
                <br><br>
                跨域權限：按「傳送測試」時若 Tampermonkey 跳出「允許存取 ntfy.sh」，請選<strong style="color:#ccc;">永遠允許</strong>。
                沒跳出或曾按錯過：Tampermonkey 圖示 → 管理面板 → 這支腳本 → <strong style="color:#ccc;">設定</strong> → 往下找 <strong style="color:#ccc;">XHR Security</strong>，把 ntfy.sh 從黑名單移除，或加到白名單。
            </div>
            <div style="font-size:12px;color:#888;margin-bottom:6px;">主題</div>
            <input type="text" id="knock-ntfy-topic" placeholder="例如 knock-x7k2m9" value="${escapeHtml(current)}" style="${CSS_INP}margin-bottom:12px;">
            <div style="font-size:12px;color:#888;margin-bottom:6px;">通知標題</div>
            <input type="text" id="knock-ntfy-title" placeholder="${escapeHtml(NTFY_TITLE_DEFAULT)}" value="${escapeHtml(getNtfyTitle())}" style="${CSS_INP}margin-bottom:12px;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="knock-ntfy-save" style="${cssBtn('#4CAF50')}">儲存</button>
                <button id="knock-ntfy-test" style="${cssBtn('#2d4a6d')}">傳送測試</button>
                <button id="knock-ntfy-clear" style="${cssBtn('#d32f2f')}">關閉推播</button>
            </div>
            <div id="knock-ntfy-status" style="margin-top:14px;font-size:13px;color:#aaa;line-height:1.6;"></div>`));
        if (!panel) return;
        if (!current) el('knock-ntfy-topic').value = `knock-${Math.random().toString(36).slice(2, 10)}`;
        el('knock-ntfy-close').onclick = () => panel.remove();
        const status = el('knock-ntfy-status');
        const paintStatus = (topic) => {
            if (!topic) {
                status.innerHTML = '尚未儲存主題。';
                return;
            }
            const href = `${NTFY_SERVER}/${encodeURIComponent(topic)}`;
            status.innerHTML = `手機請訂閱：<a href="${href}" target="_blank" rel="noreferrer" style="color:#8ab4f8;">${escapeHtml(topic)}</a>`;
        };
        paintStatus(current);
        el('knock-ntfy-save').onclick = () => {
            const saved = setNtfyTopic(el('knock-ntfy-topic').value);
            if (saved === null) {
                alert('主題只能用英數、底線、連字號，最多 64 字');
                return;
            }
            setNtfyTitle(el('knock-ntfy-title').value);
            paintStatus(saved);
            showToast(saved ? `已設定，請在手機訂閱 ${saved}` : '已關閉手機推播');
        };
        el('knock-ntfy-test').onclick = async () => {
            setNtfyTitle(el('knock-ntfy-title').value);
            if (!getNtfyTopic()) {
                const saved = setNtfyTopic(el('knock-ntfy-topic').value);
                if (!saved) {
                    alert('請先填主題並儲存');
                    return;
                }
                paintStatus(saved);
            }
            status.textContent = '傳送中…';
            const result = await sendNtfy('這是測試通知');
            if (result.ok) {
                status.textContent = `已送到 ntfy（${result.detail}）。手機沒響的話，確認 App 訂閱的主題與伺服器是 ntfy.sh。`;
            } else if (/429/.test(result.detail)) {
                status.textContent = `沒送出：${result.detail}`;
            } else {
                status.textContent = `沒送出：${result.detail}。若是連線被擋，請依上方步驟允許 ntfy.sh。`;
            }
            showToast(result.ok ? '測試已送到 ntfy' : (/429/.test(result.detail) ? 'ntfy 限流，稍後再試' : '測試失敗，看設定頁說明'));
        };
        el('knock-ntfy-clear').onclick = () => {
            setNtfyTopic('');
            el('knock-ntfy-topic').value = '';
            paintStatus('');
            showToast('已關閉手機推播');
        };
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
                <h2 style="margin:0;font-size:24px;">發語詞過濾（${filters.length}）</h2>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button id="knock-export-first-filters" style="${cssBtn('#2d5a3d')}" ${filters.length ? '' : 'disabled'}>匯出</button>
                    <button id="knock-import-first-filters" style="${cssBtn('#2d4a6d')}">匯入</button>
                    <button id="knock-clear-first-filters" style="${cssBtn('#d32f2f')}" ${filters.length ? '' : 'disabled'}>全部清空</button>
                    <button id="knock-filter-manager-close" style="${cssBtn('#444')}">關閉</button>
                </div>
                <input type="file" id="knock-import-first-filters-file" accept="application/json,.json" hidden>
            </div>
            <div style="font-size:13px;color:#888;margin-bottom:16px;">發語詞與對方頭像都相同才會自動離開。舊名單若沒有頭像，請重新勾選一次。</div>
            <input type="text" id="knock-filter-search" placeholder="搜尋已記住的訊息..." style="${CSS_INP}margin-bottom:16px;">
            <div id="knock-filter-list" style="display:flex;flex-direction:column;gap:8px;">
                ${filters.length === 0
                    ? '<div style="text-align:center;padding:40px;color:#888;">尚未封鎖任何發語詞</div>'
                    : filters.map(f => `
                        <div class="knock-filter-card" style="display:flex;gap:8px;align-items:flex-start;background:#222;border:1px solid #444;border-radius:8px;padding:12px;">
                            <div style="flex:1;min-width:0;">
                                <div style="font-size:14px;color:#ccc;white-space:pre-wrap;word-break:break-word;">${escapeHtml(f.t)}</div>
                                <div style="font-size:12px;color:#666;margin-top:4px;">${f.a ? `頭像 ${escapeHtml(f.a)}` : '僅發語詞（舊，需重新勾選）'}</div>
                            </div>
                            <button class="knock-remove-first-filter" data-filter-text="${encodeURIComponent(f.t)}" data-filter-avatar="${encodeURIComponent(f.a)}" style="${cssBtn('#d32f2f', 'padding:6px 10px;border-radius:4px;font-size:12px;flex-shrink:0;')}">刪除</button>
                        </div>`).join('')}
            </div>`));
        if (!panel) return;
        el('knock-filter-manager-close').onclick = () => panel.remove();
        el('knock-export-first-filters').onclick = () => {
            const n = exportFirstMessageFilters();
            showToast(n ? `已匯出 ${n} 則` : '沒有可匯出的發語詞');
        };
        el('knock-import-first-filters').onclick = () => el('knock-import-first-filters-file').click();
        el('knock-import-first-filters-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            try {
                const added = importFirstMessageFilters(parseImportedFilters(await file.text()));
                syncRememberButtons();
                refreshFirstFilterManager();
                showToast(added ? `已匯入 ${added} 則` : '沒有新增（皆已存在或檔案為空）');
            } catch (err) {
                alert('匯入失敗：請使用本功能匯出的 JSON');
            }
        });
        el('knock-filter-search').addEventListener('input', (e) => {
            filterCardsByTerm('.knock-filter-card', e.target.value.toLowerCase(), 'flex');
        });
    }

    function paintConvTabs() {
        const savedBtn = el('knock-tab-saved');
        const autoBtn = el('knock-tab-auto');
        if (!savedBtn || !autoBtn) return;
        savedBtn.style.cssText = cssBtn(conversationManagerTab === 'saved' ? '#4CAF50' : '#333', conversationManagerTab === 'saved' ? '' : 'color:#ccc;');
        autoBtn.style.cssText = cssBtn(conversationManagerTab === 'auto' ? '#4CAF50' : '#333', conversationManagerTab === 'auto' ? '' : 'color:#ccc;');
        savedBtn.textContent = `已儲存（${getSavedConversations().length}）`;
        autoBtn.textContent = `自動儲存（${getAutoConversations().length}）`;
    }

    function renderConversationList() {
        const listEl = el('knock-conversations-list');
        if (!listEl) return;
        const list = conversationManagerTab === 'saved' ? getSavedConversations() : getAutoConversations();
        const empty = conversationManagerTab === 'saved' ? '尚無已儲存的對話' : '尚無自動儲存的對話';
        listEl.innerHTML = list.length === 0
            ? `<div style="text-align:center;padding:40px;color:#888;">${empty}</div>`
            : list.map(createConversationCard).join('');
        paintConvTabs();
        const all = el('knock-conv-select-all');
        if (all) all.checked = false;
    }

    function selectedConversationIds() {
        return Array.from(document.querySelectorAll('#knock-conversations-list .knock-conv-check:checked'))
            .map(el => el.dataset.convId)
            .filter(Boolean);
    }

    function createConversationManager() {
        const manager = toggleOverlay('knock-conversation-manager', () => {
            persistLiveConversation();
            return makeOverlay('knock-conversation-manager', 900, `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
                <h2 style="margin:0;font-size:24px;">對話記錄</h2>
                <button id="knock-manager-close" style="${cssBtn('#444')}">關閉</button>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:16px;">
                <button type="button" id="knock-tab-saved"></button>
                <button type="button" id="knock-tab-auto"></button>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:6px;font-size:14px;color:#ccc;cursor:pointer;">
                    <input type="checkbox" id="knock-conv-select-all" style="width:16px;height:16px;">全選
                </label>
                <button id="knock-conv-delete-selected" style="${cssBtn('#d32f2f', 'padding:6px 12px;border-radius:4px;font-size:13px;')}">刪除所選</button>
            </div>
            <div style="margin-bottom:20px;">
                <input type="text" id="knock-search-input" placeholder="搜尋對話內容..." style="${CSS_INP}">
            </div>
            <div id="knock-conversations-list" style="display:flex;flex-direction:column;gap:12px;"></div>`);
        });
        if (!manager) return;
        renderConversationList();
        el('knock-manager-close').onclick = () => manager.remove();
        el('knock-tab-saved').onclick = () => {
            conversationManagerTab = 'saved';
            renderConversationList();
        };
        el('knock-tab-auto').onclick = () => {
            conversationManagerTab = 'auto';
            renderConversationList();
        };
        el('knock-conv-select-all').onchange = (e) => {
            document.querySelectorAll('#knock-conversations-list .knock-conv-card').forEach(card => {
                if (card.style.display === 'none') return;
                const box = card.querySelector('.knock-conv-check');
                if (box) box.checked = e.target.checked;
            });
        };
        el('knock-conv-delete-selected').onclick = () => {
            const ids = selectedConversationIds();
            if (!ids.length) {
                showToast('請先勾選要刪除的對話');
                return;
            }
            if (confirm(`確定刪除 ${ids.length} 則對話？`) && deleteConversations(ids)) {
                renderConversationList();
                showToast(`已刪除 ${ids.length} 則`);
            }
        };
        el('knock-search-input').addEventListener('input', (e) => {
            filterCardsByTerm('#knock-conversations-list .knock-conv-card', e.target.value.toLowerCase(), 'block');
        });
    }

    function showConversationDetail(conversationId) {
        const conversation = findStoredConversation(conversationId);
        if (!conversation) {
            alert('找不到此對話');
            return;
        }
        const isAuto = !getSavedConversations().some(conv => conv.id === conversationId);

        const startDate = getMessageTime(conversation, true);
        const endDate = getMessageTime(conversation, false);
        const durationText = formatDuration(startDate, endDate);
        const sorted = sortMessages(conversation.messages, conversation.startTime);
        const firstOther = sorted.find(m => !m.isMyMessage);
        el('knock-conversation-detail')?.remove();
        const detail = makeOverlay('knock-conversation-detail', 800, `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;gap:12px;flex-wrap:wrap;">
                <h2 style="margin:0;font-size:20px;">${isAuto ? '自動儲存' : '已儲存'}對話</h2>
                <div style="display:flex;gap:8px;">
                    ${isAuto ? `<button id="knock-detail-pin" style="${cssBtn('#4CAF50')}">移到已儲存</button>` : ''}
                    <button id="knock-detail-close" style="${cssBtn('#444')}">關閉</button>
                </div>
            </div>
            <div style="background:#222;border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px;color:#888;">
                <div>開始時間: ${startDate.toLocaleString('zh-TW')}</div>
                ${endDate ? `<div>結束時間: ${endDate.toLocaleString('zh-TW')}</div>` : ''}
                ${durationText ? `<div>持續時間: ${durationText}</div>` : ''}
                <div>訊息數量: ${conversation.messages.length} 條</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:12px;">
                ${sorted.map(msg => {
                    const filterKey = msg.text || (msg.imageUrls && msg.imageUrls[0]) || '';
                    const showRemember = msg === firstOther && filterKey;
                    return `
                    <div data-knock-date="${escapeHtml(msg.date || messageDate(msg, conversation.startTime))}" style="display:flex;align-items:flex-start;gap:8px;flex-direction:${msg.isMyMessage ? 'row-reverse' : 'row'};margin-bottom:12px;">
                        <div style="width:40px;height:40px;border-radius:50%;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;overflow:hidden;">
                            ${msg.avatarUrl
                                ? `<img src="${msg.avatarUrl}" style="width:100%;height:100%;object-fit:cover;" alt="avatar">`
                                : `<div style="color:#888;font-size:18px;">${msg.isMyMessage ? '我' : '對'}</div>`}
                        </div>
                        <div style="background:${msg.isMyMessage ? '#2d5a3d' : '#2d2d3d'};border-radius:8px;padding:8px 10px;max-width:70%;display:flex;align-items:flex-start;gap:8px;">
                            <div style="flex:1;min-width:0;">
                                ${msg.text ? `<div style="font-size:14px;line-height:1.4;word-wrap:break-word;">${escapeHtml(msg.text)}</div>` : ''}
                                ${(msg.imageUrls || []).map(src => `
                                    <a href="${escapeHtml(src)}" target="_blank" rel="noreferrer">
                                        <img src="${escapeHtml(src)}" alt="圖片" style="max-width:180px;max-height:240px;border-radius:6px;display:block;margin-top:6px;">
                                    </a>`).join('')}
                                ${!msg.text && !(msg.imageUrls || []).length ? `<div style="color:#888;font-size:13px;">（空訊息）</div>` : ''}
                            </div>
                            ${msg.timestamp ? `<div style="font-size:11px;color:rgba(255,255,255,0.5);flex-shrink:0;white-space:nowrap;">${msg.date ? `${msg.date.slice(5).replace('-', '/')} ` : ''}${msg.timestamp}</div>` : ''}
                            ${showRemember ? `<button type="button" class="knock-remember-first-saved" data-filter-text="${encodeURIComponent(filterKey)}" data-filter-avatar="${encodeURIComponent(avatarHashOf(msg.avatarUrl))}"></button>` : ''}
                        </div>
                    </div>`;
                }).join('')}
            </div>`, 10003);
        syncRememberButtons();
        el('knock-detail-close').onclick = () => detail.remove();
        el('knock-detail-pin')?.addEventListener('click', () => {
            if (pinConversation(conversationId)) {
                showToast('已移到已儲存');
                detail.remove();
                conversationManagerTab = 'saved';
                renderConversationList();
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('knock-remove-first-filter')) {
            const text = decodeURIComponent(e.target.dataset.filterText || '');
            const avatarHash = decodeURIComponent(e.target.dataset.filterAvatar || '');
            if (text) {
                removeFirstMessageFilter(text, avatarHash);
                syncRememberButtons();
                refreshFirstFilterManager();
            }
            return;
        }
        const rememberBtn = e.target.closest?.('.knock-remember-first-saved');
        if (rememberBtn) {
            toggleFirstMessageFilter(
                decodeURIComponent(rememberBtn.dataset.filterText || ''),
                decodeURIComponent(rememberBtn.dataset.filterAvatar || '')
            );
            return;
        }
        if (e.target.id === 'knock-clear-first-filters') {
            if (getNormalizedFilters().length && confirm('確定清空全部發語詞過濾？')) {
                clearFirstMessageFilters();
                syncRememberButtons();
                refreshFirstFilterManager();
            }
            return;
        }

        const convId = e.target.getAttribute?.('data-conv-id');
        if (!convId) return;
        if (e.target.classList.contains('knock-pin-btn')) {
            if (pinConversation(convId)) {
                showToast('已移到已儲存');
                renderConversationList();
            }
        } else if (e.target.classList.contains('knock-copy-btn')) {
            copyConversation(convId);
        } else if (e.target.classList.contains('knock-view-btn')) {
            showConversationDetail(convId);
        }
    });

    function mountChrome() {
        if (!document.body) return;
        OLD_FLOAT_IDS.forEach(id => el(id)?.remove());
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
        tryForcedLeave();
        tryKeepAlive();
        checkForButtonAndClick();
        checkConversationEnd();
    }, 200);

    {
        const times = ['23:59', '00:00'];
        const offsets = dayOffsetsFromNewest(times.map(t => ({
            clock: clockMinutesOnly(t),
            labeled: labelDayOffset(t)
        })));
        const dates = offsets.map(o => shiftYmd(-o));
        const out = sortMessages(times.map((timestamp, i) => ({ timestamp, date: dates[i] }))).map(m => m.timestamp);
        const afterMidnight = new Date();
        afterMidnight.setHours(0, 20, 0, 0);
        const onlyNight = dayOffsetsFromNewest([{ clock: 23 * 60 + 20, labeled: null }], afterMidnight);
        if (offsets[0] !== 1 || offsets[1] !== 0 || dates[0] !== shiftYmd(-1) || dates[1] !== shiftYmd(0) || out.join() !== '23:59,00:00' || onlyNight[0] !== 1) {
            console.error('knock: 由最新往回推日期檢查失敗', offsets, dates, out, onlyNight);
        }
    }

    if (isPendingStartChat()) console.log('重整後繼續：等待「開始聊天」按鈕...');
    requestNotifyPermission();
    checkForButtonAndClick();
    checkNewMessages();
    notificationsArmed = true;
    checkConversationEnd();
})();
