// ==UserScript==
// @name         Knock.tw Auto Clicker
// @namespace    http://tampermonkey.net/
// @version      1.4.7
// @description  Automatically click the "Re-match" and "Confirm Exit" buttons on Knock.tw, with conversation blacklist, avatar matching, and conversation saving features
// @author       Antigravity
// @match        https://knock.tw/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=knock.tw
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
    const NTFY_TOPIC_KEY = 'knockNtfyTopic';
    const NTFY_SERVER = 'https://ntfy.sh';
    const TYPING_RE = /對方正在輸入|正在輸入|typing/i;
    const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    const FLOAT_STYLE = `
        position: fixed; right: 20px; z-index: 10000;
        background: rgba(0, 0, 0, 0.8); border-radius: 8px; padding: 12px 16px;
        display: flex; align-items: center; gap: 8px;
        font-family: ${FONT}; font-size: 14px; color: #fff;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); cursor: pointer; user-select: none;
    `;

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
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            messages: [],
            startTime: new Date().toISOString(),
            endTime: null,
            saved: false,
            promptShown: false,
            pinned: false
        };
        pendingForcedLeave = false;
        lastExitClickAt = 0;
        skipFirstFilterFor = null;
        rematchScheduled = false;
        startChatScheduled = false;
        hideCooldown();
        console.log('初始化新對話:', currentConversation.id);
    }

    function getFirstMessageFilters() {
        return storageGet(FIRST_MSG_FILTER_KEY, []);
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
        return getFirstMessageFilters().map(normalizeFilter).filter(Boolean);
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
        const badge = document.getElementById('knock-filter-count');
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

    function collectMessage(messageLi) {
        const messageDiv = messageLi.querySelector('div[data-test="message"]');
        if (!messageDiv) return;

        const isMyMessage = isMyMessageLi(messageLi);
        const timeElement = messageDiv.querySelector('span[data-test="date"]');
        const timestamp = timeElement ? timeElement.textContent.trim() : null;
        const messageText = getMessageText(messageDiv);
        const imageUrls = getMessageImages(messageDiv);
        if (TYPING_RE.test(messageText)) return;
        if (!messageText && !imageUrls.length) return;

        const messageHash = hashString(`${messageText}|${imageUrls.join(',')}|${isMyMessage}|${timestamp || ''}`);
        if (currentConversation.messages.some(m => m.id === messageHash)) return;

        currentConversation.messages.push({
            id: messageHash,
            text: messageText,
            imageUrls,
            isMyMessage,
            avatarUrl: getAvatarUrl(messageLi),
            timestamp,
            seq: currentConversation.messages.length,
            collectedAt: new Date().toISOString()
        });
        console.log('收集訊息:', messageText || '[圖片]', imageUrls);
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
            messages: sortMessages(conversation.messages.slice()),
            endTime: conversation.endTime || new Date().toISOString()
        };
        const i = list.findIndex(c => c.id === conversation.id);
        if (i >= 0) list[i] = snap;
        else list.unshift(snap);
        if (list.length > limit) list.length = limit;
        return storageSet(key, list);
    }

    function persistLiveConversation() {
        if (!currentConversation.id || !currentConversation.messages.length) return;
        if (currentConversation.pinned) {
            upsertConversationList(SAVED_CONV_KEY, currentConversation, 100);
            storageSet(AUTO_CONV_KEY, getAutoConversations().filter(c => c.id !== currentConversation.id));
            return;
        }
        upsertConversationList(AUTO_CONV_KEY, currentConversation, 200);
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

    function deleteConversation(conversationId) {
        return deleteConversations([conversationId]);
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
        const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
        for (const type of ['mousedown', 'mouseup', 'click']) {
            element.dispatchEvent(new MouseEvent(type, opts));
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
        document.getElementById('knock-cooldown')?.remove();
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
            let el = document.getElementById('knock-cooldown');
            if (!el && document.body) {
                el = document.createElement('div');
                el.id = 'knock-cooldown';
                el.style.cssText = `
                    position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
                    z-index:10006;background:rgba(0,0,0,0.78);color:#fff;
                    font-family:${FONT};font-size:13px;padding:6px 14px;border-radius:16px;
                    pointer-events:none;letter-spacing:0.04em;white-space:nowrap;
                    box-shadow:0 2px 10px rgba(0,0,0,0.35);
                `;
                document.body.appendChild(el);
            }
            if (el) el.textContent = `${cooldownLabel} ${Math.ceil(left / 1000)}`;
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

    function sendNtfy(body, title) {
        return new Promise((resolve) => {
            const topic = getNtfyTopic();
            if (!topic) {
                resolve({ ok: false, detail: '尚未設定主題' });
                return;
            }
            const data = JSON.stringify({
                topic,
                title: title || 'Knock 新訊息',
                message: body || '你有一則新訊息'
            });
            const finish = (ok, detail) => resolve({ ok, detail });
            const xhr = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
                || (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest);
            if (xhr) {
                xhr({
                    method: 'POST',
                    url: `${NTFY_SERVER}/`,
                    headers: { 'Content-Type': 'application/json' },
                    data,
                    onload: (r) => finish(r.status >= 200 && r.status < 300, `HTTP ${r.status}`),
                    onerror: () => finish(false, '連線失敗：請允許腳本存取 ntfy.sh')
                });
                return;
            }
            fetch(`${NTFY_SERVER}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: data
            }).then((r) => finish(r.ok, `HTTP ${r.status}`))
                .catch((e) => finish(false, e.message || 'fetch 被網頁擋住'));
        });
    }

    function notifyNewMessage(text) {
        if (!notificationsArmed || (document.hasFocus() && !document.hidden)) return;
        const body = (text || '你有一則新訊息').replace(/\s+/g, ' ').trim().slice(0, 80) || '你有一則新訊息';
        sendNtfy(body);
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

        const messageElements = messagesList.querySelectorAll('li.message-li');
        if (!currentConversation.id || (currentConversation.saved && currentConversation.messages.length === 0)) {
            if (messageElements.length === 0) return;
            console.log('Initializing new conversation...');
            initNewConversation();
        }

        if (maybeLeaveOnFirstMessageFilter() || tryForcedLeave()) return;

        for (const messageLi of messageElements) {
            const messageId = messageLi.className;
            collectMessage(messageLi);
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

    function createFloatButton(id, top, html, onClick) {
        if (document.getElementById(id)) return;
        const el = document.createElement('div');
        el.id = id;
        el.style.cssText = FLOAT_STYLE + `top:${top}px;`;
        el.innerHTML = html;
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        document.body.appendChild(el);
    }

    function createToggleSwitch() {
        if (document.getElementById('knock-auto-click-toggle')) return;

        const toggleContainer = document.createElement('div');
        toggleContainer.id = 'knock-auto-click-toggle';
        toggleContainer.style.cssText = FLOAT_STYLE + 'top:20px; gap:10px;';

        const label = document.createElement('span');
        label.textContent = '自動開啟新對話';
        label.style.whiteSpace = 'nowrap';

        const toggleSwitch = document.createElement('div');
        toggleSwitch.style.cssText = `
            width: 50px; height: 26px; border-radius: 13px; position: relative;
            background: ${autoClickEnabled ? '#4CAF50' : '#ccc'}; transition: background 0.3s ease;
        `;
        const toggleSlider = document.createElement('div');
        toggleSlider.style.cssText = `
            width: 22px; height: 22px; background: #fff; border-radius: 50%;
            position: absolute; top: 2px; left: ${autoClickEnabled ? '26px' : '2px'};
            transition: left 0.3s ease; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        `;
        toggleSwitch.append(toggleSlider);
        toggleContainer.append(label, toggleSwitch);

        toggleContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            autoClickEnabled = !autoClickEnabled;
            localStorage.setItem('knockAutoClickEnabled', String(autoClickEnabled));
            toggleSwitch.style.background = autoClickEnabled ? '#4CAF50' : '#ccc';
            toggleSlider.style.left = autoClickEnabled ? '26px' : '2px';
            requestNotifyPermission();
        });

        document.body.appendChild(toggleContainer);
    }

    function dismissSavePrompt(prompt, save) {
        prompt.remove();
        isSavePromptVisible = false;
        if (save) return;
        markProcessed(currentConversation);
        console.log('對話已標記為不儲存:', currentConversation.id);
    }

    function showSavePrompt() {
        if (document.getElementById('knock-save-prompt') || currentConversation.saved) return;
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
                <button id="knock-save-cancel" style="padding: 8px 16px; background: #444; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">不儲存</button>
                <button id="knock-save-confirm" style="padding: 8px 16px; background: #4CAF50; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;">儲存對話</button>
            </div>
        `;
        document.body.appendChild(prompt);

        document.getElementById('knock-save-cancel').onclick = () => dismissSavePrompt(prompt, false);
        prompt.addEventListener('click', (e) => {
            if (e.target === prompt) dismissSavePrompt(prompt, false);
        });
        document.getElementById('knock-save-confirm').onclick = () => {
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

    // 支援「15:52」「昨天 15:52」「前天 15:52」；沒時間回傳 null（開頭訊息）
    function parseClockMinutes(timeStr) {
        if (!timeStr) return null;
        const m = /(\d{1,2}):(\d{2})/.exec(timeStr);
        if (!m) return null;
        let minutes = Number(m[1]) * 60 + Number(m[2]);
        if (timeStr.includes('前天')) minutes -= 2880;
        else if (timeStr.includes('昨天')) minutes -= 1440;
        return minutes;
    }

    function timestampToDate(timeStr, baseDate) {
        const minutes = parseClockMinutes(timeStr);
        if (minutes == null) return null;
        const date = new Date(baseDate);
        date.setHours(0, 0, 0, 0);
        date.setMinutes(minutes);
        return date;
    }

    function getMessageTime(conversation, isOldest = true) {
        const start = conversation.startTime ? new Date(conversation.startTime) : new Date();
        const end = conversation.endTime ? new Date(conversation.endTime) : null;
        const base = isOldest ? start : (end || start);
        const dates = (conversation.messages || [])
            .map(m => timestampToDate(m.timestamp, base))
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

    // 沒時間的是開頭，放最前；其餘依「昨天／今天」+ 鐘點
    function sortMessages(messages) {
        return messages
            .map((msg, index) => ({ msg, index }))
            .sort((a, b) => {
                const ta = parseClockMinutes(a.msg.timestamp);
                const tb = parseClockMinutes(b.msg.timestamp);
                if (ta == null && tb == null) return a.index - b.index;
                if (ta == null) return -1;
                if (tb == null) return 1;
                if (ta !== tb) return ta - tb;
                return a.index - b.index;
            })
            .map(x => x.msg);
    }

    function formatConversationForCopy(conversation) {
        return sortMessages(conversation.messages).map(msg => {
            const speaker = msg.isMyMessage ? '我  ' : '對方';
            const content = [msg.text, ...(msg.imageUrls || [])].filter(Boolean).join(' ') || '[圖片]';
            return `${speaker}(${msg.timestamp || '未知時間'}):${content}`;
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
        const preview = sortMessages(conversation.messages).slice(0, 3).map(msg => {
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
                                ${conversationManagerTab === 'auto' ? `<button class="knock-pin-btn" data-conv-id="${conversation.id}" style="padding:6px 12px;background:#4CAF50;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">儲存</button>` : ''}
                                <button class="knock-copy-btn" data-conv-id="${conversation.id}" style="padding:6px 12px;background:#2196F3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">複製</button>
                            </div>
                        </div>
                        <div style="background:#1a1a1a;border-radius:6px;padding:12px;font-size:13px;color:#ccc;line-height:1.6;max-height:150px;overflow-y:auto;">${preview}</div>
                        <button class="knock-view-btn" data-conv-id="${conversation.id}" style="margin-top:12px;padding:8px 16px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;width:100%;">查看完整對話</button>
                    </div>
                </div>
            </div>`;
    }

    function createNtfySettings() {
        const existing = document.getElementById('knock-ntfy-settings');
        if (existing) {
            existing.remove();
            return;
        }
        const current = getNtfyTopic();
        const panel = document.createElement('div');
        panel.id = 'knock-ntfy-settings';
        panel.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;z-index:10002;
            background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow-y:auto;
        `;
        panel.innerHTML = `
            <div style="max-width:520px;margin:0 auto;padding:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;">
                    <h2 style="margin:0;font-size:24px;">手機通知（ntfy）</h2>
                    <button id="knock-ntfy-close" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉</button>
                </div>
                <div style="font-size:13px;color:#888;margin-bottom:16px;line-height:1.6;">
                    分頁沒在看時，新訊息會推到手機。請安裝
                    <a href="https://ntfy.sh/app" target="_blank" rel="noreferrer" style="color:#8ab4f8;">ntfy App</a>
                    ，伺服器選 <b style="color:#ccc;">ntfy.sh</b>，訂閱下方同一個主題。
                    <br><br>
                    跨域權限：按「傳送測試」時若 Tampermonkey 跳出「允許存取 ntfy.sh」，請選<strong style="color:#ccc;">永遠允許</strong>。
                    沒跳出或曾按錯過：Tampermonkey 圖示 → 管理面板 → 這支腳本 → <strong style="color:#ccc;">設定</strong> → 往下找 <strong style="color:#ccc;">XHR Security</strong>，把 ntfy.sh 從黑名單移除，或加到白名單。
                </div>
                <input type="text" id="knock-ntfy-topic" placeholder="例如 knock-x7k2m9" value="${escapeHtml(current)}" style="width:100%;padding:12px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;margin-bottom:12px;">
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button id="knock-ntfy-save" style="padding:8px 16px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">儲存</button>
                    <button id="knock-ntfy-test" style="padding:8px 16px;background:#2d4a6d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">傳送測試</button>
                    <button id="knock-ntfy-clear" style="padding:8px 16px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉推播</button>
                </div>
                <div id="knock-ntfy-status" style="margin-top:14px;font-size:13px;color:#aaa;line-height:1.6;"></div>
            </div>`;
        document.body.appendChild(panel);
        if (!current) {
            document.getElementById('knock-ntfy-topic').value = `knock-${Math.random().toString(36).slice(2, 10)}`;
        }
        const close = () => panel.remove();
        document.getElementById('knock-ntfy-close').onclick = close;
        panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
        const status = document.getElementById('knock-ntfy-status');
        const paintStatus = (topic) => {
            if (!topic) {
                status.innerHTML = '尚未儲存主題。';
                return;
            }
            const href = `${NTFY_SERVER}/${encodeURIComponent(topic)}`;
            status.innerHTML = `手機請訂閱：<a href="${href}" target="_blank" rel="noreferrer" style="color:#8ab4f8;">${escapeHtml(topic)}</a>`;
        };
        paintStatus(current);
        document.getElementById('knock-ntfy-save').onclick = () => {
            const saved = setNtfyTopic(document.getElementById('knock-ntfy-topic').value);
            if (saved === null) {
                alert('主題只能用英數、底線、連字號，最多 64 字');
                return;
            }
            paintStatus(saved);
            showToast(saved ? `已設定，請在手機訂閱 ${saved}` : '已關閉手機推播');
        };
        document.getElementById('knock-ntfy-test').onclick = async () => {
            if (!getNtfyTopic()) {
                const saved = setNtfyTopic(document.getElementById('knock-ntfy-topic').value);
                if (!saved) {
                    alert('請先填主題並儲存');
                    return;
                }
                paintStatus(saved);
            }
            status.textContent = '傳送中…';
            const result = await sendNtfy('這是測試通知', 'Knock 測試');
            if (result.ok) {
                status.textContent = `已送到 ntfy（${result.detail}）。手機沒響的話，確認 App 訂閱的主題與伺服器是 ntfy.sh。`;
                showToast('測試已送到 ntfy');
            } else {
                status.textContent = `沒送出：${result.detail}。請依上方步驟允許 ntfy.sh。`;
                showToast('測試失敗，看設定頁說明');
            }
        };
        document.getElementById('knock-ntfy-clear').onclick = () => {
            setNtfyTopic('');
            document.getElementById('knock-ntfy-topic').value = '';
            paintStatus('');
            showToast('已關閉手機推播');
        };
    }

    function refreshFirstFilterManager() {
        if (!document.getElementById('knock-first-filter-manager')) return;
        document.getElementById('knock-first-filter-manager').remove();
        createFirstFilterManager();
    }

    function createFirstFilterManager() {
        const existing = document.getElementById('knock-first-filter-manager');
        if (existing) {
            existing.remove();
            return;
        }

        const filters = getNormalizedFilters();
        const panel = document.createElement('div');
        panel.id = 'knock-first-filter-manager';
        panel.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;z-index:10002;
            background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow-y:auto;
        `;
        panel.innerHTML = `
            <div style="max-width:720px;margin:0 auto;padding:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
                    <h2 style="margin:0;font-size:24px;">發語詞過濾（${filters.length}）</h2>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button id="knock-export-first-filters" style="padding:8px 16px;background:#2d5a3d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;" ${filters.length ? '' : 'disabled'}>匯出</button>
                        <button id="knock-import-first-filters" style="padding:8px 16px;background:#2d4a6d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">匯入</button>
                        <button id="knock-clear-first-filters" style="padding:8px 16px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;" ${filters.length ? '' : 'disabled'}>全部清空</button>
                        <button id="knock-filter-manager-close" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉</button>
                    </div>
                    <input type="file" id="knock-import-first-filters-file" accept="application/json,.json" hidden>
                </div>
                <div style="font-size:13px;color:#888;margin-bottom:16px;">發語詞與對方頭像都相同才會自動離開。舊名單若沒有頭像，請重新勾選一次。</div>
                <input type="text" id="knock-filter-search" placeholder="搜尋已記住的訊息..." style="width:100%;padding:12px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;margin-bottom:16px;">
                <div id="knock-filter-list" style="display:flex;flex-direction:column;gap:8px;">
                    ${filters.length === 0
                        ? '<div style="text-align:center;padding:40px;color:#888;">尚未封鎖任何發語詞</div>'
                        : filters.map(f => `
                            <div class="knock-filter-card" style="display:flex;gap:8px;align-items:flex-start;background:#222;border:1px solid #444;border-radius:8px;padding:12px;">
                                <div style="flex:1;min-width:0;">
                                    <div style="font-size:14px;color:#ccc;white-space:pre-wrap;word-break:break-word;">${escapeHtml(f.t)}</div>
                                    <div style="font-size:12px;color:#666;margin-top:4px;">${f.a ? `頭像 ${escapeHtml(f.a)}` : '僅發語詞（舊，需重新勾選）'}</div>
                                </div>
                                <button class="knock-remove-first-filter" data-filter-text="${encodeURIComponent(f.t)}" data-filter-avatar="${encodeURIComponent(f.a)}" style="padding:6px 10px;background:#d32f2f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;">刪除</button>
                            </div>`).join('')}
                </div>
            </div>`;
        document.body.appendChild(panel);

        const close = () => panel.remove();
        document.getElementById('knock-filter-manager-close').onclick = close;
        panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
        document.getElementById('knock-export-first-filters').onclick = () => {
            const n = exportFirstMessageFilters();
            showToast(n ? `已匯出 ${n} 則` : '沒有可匯出的發語詞');
        };
        document.getElementById('knock-import-first-filters').onclick = () => {
            document.getElementById('knock-import-first-filters-file').click();
        };
        document.getElementById('knock-import-first-filters-file').addEventListener('change', async (e) => {
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
        document.getElementById('knock-filter-search').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            panel.querySelectorAll('.knock-filter-card').forEach(card => {
                card.style.display = card.textContent.toLowerCase().includes(term) ? 'flex' : 'none';
            });
        });
    }

    function paintConvTabs() {
        const savedBtn = document.getElementById('knock-tab-saved');
        const autoBtn = document.getElementById('knock-tab-auto');
        if (!savedBtn || !autoBtn) return;
        const on = 'padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:14px;background:#4CAF50;color:#fff;';
        const off = 'padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:14px;background:#333;color:#ccc;';
        savedBtn.style.cssText = conversationManagerTab === 'saved' ? on : off;
        autoBtn.style.cssText = conversationManagerTab === 'auto' ? on : off;
        savedBtn.textContent = `已儲存（${getSavedConversations().length}）`;
        autoBtn.textContent = `自動儲存（${getAutoConversations().length}）`;
    }

    function renderConversationList() {
        const el = document.getElementById('knock-conversations-list');
        if (!el) return;
        const list = conversationManagerTab === 'saved' ? getSavedConversations() : getAutoConversations();
        const empty = conversationManagerTab === 'saved' ? '尚無已儲存的對話' : '尚無自動儲存的對話';
        el.innerHTML = list.length === 0
            ? `<div style="text-align:center;padding:40px;color:#888;">${empty}</div>`
            : list.map(createConversationCard).join('');
        paintConvTabs();
        const all = document.getElementById('knock-conv-select-all');
        if (all) all.checked = false;
    }

    function selectedConversationIds() {
        return Array.from(document.querySelectorAll('#knock-conversations-list .knock-conv-check:checked'))
            .map(el => el.dataset.convId)
            .filter(Boolean);
    }

    function createConversationManager() {
        const existing = document.getElementById('knock-conversation-manager');
        if (existing) {
            existing.remove();
            return;
        }

        persistLiveConversation();
        const manager = document.createElement('div');
        manager.id = 'knock-conversation-manager';
        manager.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;z-index:10002;
            background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow-y:auto;
        `;
        manager.innerHTML = `
            <div style="max-width:900px;margin:0 auto;padding:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
                    <h2 style="margin:0;font-size:24px;">對話記錄</h2>
                    <button id="knock-manager-close" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉</button>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:16px;">
                    <button type="button" id="knock-tab-saved"></button>
                    <button type="button" id="knock-tab-auto"></button>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
                    <label style="display:flex;align-items:center;gap:6px;font-size:14px;color:#ccc;cursor:pointer;">
                        <input type="checkbox" id="knock-conv-select-all" style="width:16px;height:16px;">全選
                    </label>
                    <button id="knock-conv-delete-selected" style="padding:6px 12px;background:#d32f2f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">刪除所選</button>
                </div>
                <div style="margin-bottom:20px;">
                    <input type="text" id="knock-search-input" placeholder="搜尋對話內容..." style="width:100%;padding:12px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;">
                </div>
                <div id="knock-conversations-list" style="display:flex;flex-direction:column;gap:12px;"></div>
            </div>`;
        document.body.appendChild(manager);
        renderConversationList();

        const close = () => manager.remove();
        document.getElementById('knock-manager-close').onclick = close;
        manager.addEventListener('click', (e) => { if (e.target === manager) close(); });
        document.getElementById('knock-tab-saved').onclick = () => {
            conversationManagerTab = 'saved';
            renderConversationList();
        };
        document.getElementById('knock-tab-auto').onclick = () => {
            conversationManagerTab = 'auto';
            renderConversationList();
        };
        document.getElementById('knock-conv-select-all').onchange = (e) => {
            document.querySelectorAll('#knock-conversations-list .knock-conv-card').forEach(card => {
                if (card.style.display === 'none') return;
                const box = card.querySelector('.knock-conv-check');
                if (box) box.checked = e.target.checked;
            });
        };
        document.getElementById('knock-conv-delete-selected').onclick = () => {
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
        document.getElementById('knock-search-input').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('#knock-conversations-list .knock-conv-card').forEach(card => {
                card.style.display = card.textContent.toLowerCase().includes(term) ? 'block' : 'none';
            });
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
        const sorted = sortMessages(conversation.messages);
        const firstOther = sorted.find(m => !m.isMyMessage);
        const detail = document.createElement('div');
        detail.id = 'knock-conversation-detail';
        detail.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;z-index:10003;
            background:rgba(0,0,0,0.95);font-family:${FONT};color:#fff;overflow-y:auto;
        `;
        detail.innerHTML = `
            <div style="max-width:800px;margin:0 auto;padding:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;gap:12px;flex-wrap:wrap;">
                    <h2 style="margin:0;font-size:20px;">${isAuto ? '自動儲存' : '已儲存'}對話</h2>
                    <div style="display:flex;gap:8px;">
                        ${isAuto ? '<button id="knock-detail-pin" style="padding:8px 16px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">移到已儲存</button>' : ''}
                        <button id="knock-detail-close" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉</button>
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
                        <div style="display:flex;align-items:flex-start;gap:8px;flex-direction:${msg.isMyMessage ? 'row-reverse' : 'row'};margin-bottom:12px;">
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
                                ${msg.timestamp ? `<div style="font-size:11px;color:rgba(255,255,255,0.5);flex-shrink:0;white-space:nowrap;">${msg.timestamp}</div>` : ''}
                                ${showRemember ? `<button type="button" class="knock-remember-first-saved" data-filter-text="${encodeURIComponent(filterKey)}" data-filter-avatar="${encodeURIComponent(avatarHashOf(msg.avatarUrl))}"></button>` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
        document.body.appendChild(detail);
        syncRememberButtons();
        const close = () => detail.remove();
        document.getElementById('knock-detail-close').onclick = close;
        document.getElementById('knock-detail-pin')?.addEventListener('click', () => {
            if (pinConversation(conversationId)) {
                showToast('已移到已儲存');
                close();
                conversationManagerTab = 'saved';
                renderConversationList();
            }
        });
        detail.addEventListener('click', (e) => { if (e.target === detail) close(); });
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
            if (getFirstMessageFilters().length && confirm('確定清空全部發語詞過濾？')) {
                clearFirstMessageFilters();
                syncRememberButtons();
                refreshFirstFilterManager();
            }
            return;
        }

        const convId = e.target.getAttribute?.('data-conv-id');
        if (!convId) return;
        if (e.target.classList.contains('knock-delete-btn')) {
            if (confirm('確定要刪除這個對話嗎？') && deleteConversation(convId)) {
                renderConversationList();
            }
        } else if (e.target.classList.contains('knock-pin-btn')) {
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
        createToggleSwitch();
        document.getElementById('knock-manual-save-button')?.remove();
        createFloatButton('knock-manager-button', 70, '<span>📚</span><span>對話記錄</span>', createConversationManager);
        const filterBtn = document.getElementById('knock-filter-manager-button');
        if (filterBtn) filterBtn.style.top = '120px';
        createFloatButton(
            'knock-filter-manager-button',
            120,
            `<span>🚫</span><span>發語詞過濾</span><span id="knock-filter-count" style="background:#ff9800;border-radius:10px;padding:0 6px;font-size:12px;min-width:1.2em;text-align:center;">${getNormalizedFilters().length}</span>`,
            createFirstFilterManager
        );
        createFloatButton(
            'knock-ntfy-button',
            170,
            `<span>📱</span><span>手機通知</span>`,
            createNtfySettings
        );
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
        checkForButtonAndClick();
        checkConversationEnd();
    }, 200);

    if (isPendingStartChat()) console.log('重整後繼續：等待「開始聊天」按鈕...');
    requestNotifyPermission();
    checkForButtonAndClick();
    checkNewMessages();
    notificationsArmed = true;
    checkConversationEnd();
})();
