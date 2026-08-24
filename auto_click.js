// ==UserScript==
// @name         Knock.tw Auto Clicker
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Automatically click the "Re-match" and "Confirm Exit" buttons on Knock.tw, with conversation blacklist, avatar matching, and conversation saving features
// @author       Antigravity
// @match        https://knock.tw/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=knock.tw
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const BLACKLIST_PATTERNS = [
        /is\.gd\/[a-zA-Z0-9]+/i,
    ];
    const PENDING_START_CHAT_KEY = 'knockPendingStartChat';
    const PENDING_START_CHAT_TTL_MS = 30000;
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

    function emptyConversation() {
        return { id: null, messages: [], startTime: null, endTime: null, saved: false, promptShown: false };
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
        currentConversation = {
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            messages: [],
            startTime: new Date().toISOString(),
            endTime: null,
            saved: false,
            promptShown: false
        };
        console.log('初始化新對話:', currentConversation.id);
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
        return clone.textContent.trim();
    }

    function collectMessage(messageLi) {
        const messageDiv = messageLi.querySelector('div[data-test="message"]');
        if (!messageDiv) return;

        const isMyMessage = isMyMessageLi(messageLi);
        const timeElement = messageDiv.querySelector('span[data-test="date"]');
        const timestamp = timeElement ? timeElement.textContent.trim() : null;
        const messageText = getMessageText(messageDiv);
        if (TYPING_RE.test(messageText)) return;

        const messageHash = hashString(`${messageText}|${isMyMessage}|${timestamp || ''}`);
        if (currentConversation.messages.some(m => m.id === messageHash)) return;

        currentConversation.messages.push({
            id: messageHash,
            text: messageText,
            isMyMessage,
            avatarUrl: getAvatarUrl(messageLi),
            timestamp,
            collectedAt: new Date().toISOString()
        });
        console.log('收集訊息:', messageText);
    }

    function getSavedConversations() {
        return storageGet('knockSavedConversations', []);
    }

    function saveConversation(conversation) {
        if (conversation.saved) return;
        conversation.endTime = new Date().toISOString();
        conversation.saved = true;
        const saved = getSavedConversations();
        saved.unshift(conversation);
        if (saved.length > 100) saved.length = 100;
        if (!storageSet('knockSavedConversations', saved)) return false;
        markProcessed(conversation);
        console.log('對話已儲存:', conversation.id);
        return true;
    }

    function deleteConversation(conversationId) {
        const filtered = getSavedConversations().filter(conv => conv.id !== conversationId);
        return storageSet('knockSavedConversations', filtered);
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

    function checkConversationEnd() {
        if (currentConversation.promptShown || currentConversation.saved) return;
        if (currentConversation.id && isConversationProcessed(currentConversation.id)) {
            currentConversation.saved = true;
            return;
        }

        const conversationEnded = findButtons().some(b => isRematchButton(b) || isConfirmExitButton(b));
        if (!conversationEnded || currentConversation.messages.length === 0) return;

        if (autoClickEnabled) {
            markProcessed(currentConversation);
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

    function markPendingStartChat() {
        sessionStorage.setItem(PENDING_START_CHAT_KEY, Date.now().toString());
    }

    function isPendingStartChat() {
        const ts = Number(sessionStorage.getItem(PENDING_START_CHAT_KEY));
        if (!ts || Date.now() - ts > PENDING_START_CHAT_TTL_MS) {
            sessionStorage.removeItem(PENDING_START_CHAT_KEY);
            return false;
        }
        return true;
    }

    function clearPendingStartChat() {
        sessionStorage.removeItem(PENDING_START_CHAT_KEY);
    }

    function checkForButtonAndClick() {
        if (!autoClickEnabled || isSavePromptVisible) return;

        for (const button of findButtons()) {
            if (isPendingStartChat() && button.textContent.includes('開始聊天')) {
                console.log('重整後找到「開始聊天」按鈕，點擊中...');
                clearPendingStartChat();
                simulateMouseClick(button);
                return;
            }

            if (isRematchButton(button)) {
                checkConversationEnd();
                if (!isSavePromptVisible) {
                    setTimeout(() => {
                        if (!isSavePromptVisible) {
                            simulateMouseClick(button);
                            setTimeout(initNewConversation, 1000);
                        }
                    }, 3000);
                }
                return;
            }

            if (isConfirmExitButton(button)) {
                checkConversationEnd();
                if (!isSavePromptVisible) {
                    simulateMouseClick(button);
                    if (isPendingStartChat()) {
                        console.log('已記下「開始聊天」，等待頁面重整...');
                    }
                }
                return;
            }
        }
    }

    function checkMessageAgainstBlacklist(messageElement) {
        const messageText = messageElement.textContent || '';
        return BLACKLIST_PATTERNS.some(pattern => pattern.test(messageText));
    }

    function activelyLeaveConversation(messageId) {
        const exitButton = document.querySelector('button[data-test="chat-exit-button"]');
        if (!exitButton) {
            console.warn('未找到退出按鈕');
            return;
        }
        console.log('主動離開對話，準備退出...');
        simulateMouseClick(exitButton);
        checkedMessages.add(messageId);
        markPendingStartChat();
        checkForButtonAndClick();
    }

    function requestNotifyPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') return;
        Notification.requestPermission().catch(() => {});
    }

    function notifyNewMessage(text) {
        if (!notificationsArmed || (document.hasFocus() && !document.hidden)) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const body = (text || '你有一則新訊息').replace(/\s+/g, ' ').trim().slice(0, 80) || '你有一則新訊息';
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

        for (const messageLi of messageElements) {
            const messageId = messageLi.className;
            collectMessage(messageLi);
            if (checkedMessages.has(messageId)) continue;
            checkedMessages.add(messageId);

            const messageDiv = messageLi.querySelector('div[data-test="message"]');
            if (!messageDiv || isMyMessageLi(messageLi)) continue;

            const notifyText = (messageDiv.textContent || '').trim();
            if (notifyText && !TYPING_RE.test(notifyText)) notifyNewMessage(notifyText);

            if (checkAvatarMatch(messageLi) || checkMessageAgainstBlacklist(messageDiv)) {
                activelyLeaveConversation(messageId);
                return;
            }
        }

        checkConversationEnd();
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

    function parseTime(timeStr) {
        if (!timeStr) return Infinity;
        const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
        return m ? Number(m[1]) * 60 + Number(m[2]) : Infinity;
    }

    function timeToDate(timeMinutes, baseDate) {
        if (timeMinutes === Infinity) return null;
        const date = new Date(baseDate);
        date.setHours(Math.floor(timeMinutes / 60), timeMinutes % 60, 0, 0);
        return date;
    }

    function getMessageTime(conversation, isOldest = true) {
        const start = conversation.startTime ? new Date(conversation.startTime) : new Date();
        const end = conversation.endTime ? new Date(conversation.endTime) : null;
        const times = (conversation.messages || []).map(m => parseTime(m.timestamp)).filter(t => t !== Infinity);
        if (times.length === 0) return isOldest ? start : end;
        const base = isOldest ? start : (end || start);
        return timeToDate(isOldest ? Math.min(...times) : Math.max(...times), base);
    }

    function formatDuration(startDate, endDate) {
        if (!endDate) return '';
        const sec = Math.round((endDate - startDate) / 1000);
        const min = Math.floor(sec / 60);
        if (min <= 0) return `${sec} 秒`;
        const rem = sec % 60;
        return rem > 0 ? `${min} 分鐘 ${rem} 秒` : `${min} 分鐘`;
    }

    function sortMessages(messages) {
        return [...messages].sort((a, b) => {
            const ta = parseTime(a.timestamp);
            const tb = parseTime(b.timestamp);
            if (ta === Infinity && tb === Infinity) return 0;
            if (ta === Infinity) return 1;
            if (tb === Infinity) return -1;
            return ta - tb;
        });
    }

    function formatConversationForCopy(conversation) {
        return sortMessages(conversation.messages).map(msg => {
            const speaker = msg.isMyMessage ? '我  ' : '對方';
            return `${speaker}(${msg.timestamp || '未知時間'}):${msg.text || ''}`;
        }).join('\n');
    }

    async function copyConversation(conversationId) {
        const conversation = getSavedConversations().find(conv => conv.id === conversationId);
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
        const preview = conversation.messages.slice(0, 3).map(msg => {
            const text = msg.text.substring(0, 50);
            return (msg.isMyMessage ? '我: ' : '對方: ') + text + (msg.text.length > 50 ? '...' : '');
        }).join('<br>');

        return `
            <div class="knock-conv-card" style="background:#222;border-radius:8px;padding:16px;border:1px solid #444;">
                <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">
                    <div>
                        <div style="font-size:14px;color:#888;margin-bottom:4px;">
                            ${startDate.toLocaleString('zh-TW')}${durationText ? ` · 持續 ${durationText}` : ''}
                        </div>
                        <div style="font-size:12px;color:#666;">${conversation.messages.length} 條訊息</div>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="knock-copy-btn" data-conv-id="${conversation.id}" style="padding:6px 12px;background:#2196F3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">複製</button>
                        <button class="knock-delete-btn" data-conv-id="${conversation.id}" style="padding:6px 12px;background:#d32f2f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">刪除</button>
                    </div>
                </div>
                <div style="background:#1a1a1a;border-radius:6px;padding:12px;font-size:13px;color:#ccc;line-height:1.6;max-height:150px;overflow-y:auto;">${preview}</div>
                <button class="knock-view-btn" data-conv-id="${conversation.id}" style="margin-top:12px;padding:8px 16px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;width:100%;">查看完整對話</button>
            </div>`;
    }

    function createConversationManager() {
        const existing = document.getElementById('knock-conversation-manager');
        if (existing) {
            existing.remove();
            return;
        }

        const savedConversations = getSavedConversations();
        const manager = document.createElement('div');
        manager.id = 'knock-conversation-manager';
        manager.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;z-index:10002;
            background:rgba(0,0,0,0.9);font-family:${FONT};color:#fff;overflow-y:auto;
        `;
        manager.innerHTML = `
            <div style="max-width:900px;margin:0 auto;padding:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
                    <h2 style="margin:0;font-size:24px;">對話記錄管理</h2>
                    <button id="knock-manager-close" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉</button>
                </div>
                <div style="margin-bottom:20px;">
                    <input type="text" id="knock-search-input" placeholder="搜尋對話內容..." style="width:100%;padding:12px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;font-size:14px;box-sizing:border-box;">
                </div>
                <div id="knock-conversations-list" style="display:flex;flex-direction:column;gap:12px;">
                    ${savedConversations.length === 0
                        ? '<div style="text-align:center;padding:40px;color:#888;">尚無已儲存的對話</div>'
                        : savedConversations.map(createConversationCard).join('')}
                </div>
            </div>`;
        document.body.appendChild(manager);

        const close = () => manager.remove();
        document.getElementById('knock-manager-close').onclick = close;
        manager.addEventListener('click', (e) => { if (e.target === manager) close(); });
        document.getElementById('knock-search-input').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('#knock-conversations-list .knock-conv-card').forEach(card => {
                card.style.display = card.textContent.toLowerCase().includes(term) ? 'block' : 'none';
            });
        });
    }

    function showConversationDetail(conversationId) {
        const conversation = getSavedConversations().find(conv => conv.id === conversationId);
        if (!conversation) {
            alert('找不到此對話');
            return;
        }

        const startDate = getMessageTime(conversation, true);
        const endDate = getMessageTime(conversation, false);
        const durationText = formatDuration(startDate, endDate);
        const detail = document.createElement('div');
        detail.id = 'knock-conversation-detail';
        detail.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;z-index:10003;
            background:rgba(0,0,0,0.95);font-family:${FONT};color:#fff;overflow-y:auto;
        `;
        detail.innerHTML = `
            <div style="max-width:800px;margin:0 auto;padding:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
                    <h2 style="margin:0;font-size:20px;">對話詳情</h2>
                    <button id="knock-detail-close" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">關閉</button>
                </div>
                <div style="background:#222;border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px;color:#888;">
                    <div>開始時間: ${startDate.toLocaleString('zh-TW')}</div>
                    ${endDate ? `<div>結束時間: ${endDate.toLocaleString('zh-TW')}</div>` : ''}
                    ${durationText ? `<div>持續時間: ${durationText}</div>` : ''}
                    <div>訊息數量: ${conversation.messages.length} 條</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:12px;">
                    ${sortMessages(conversation.messages).map(msg => `
                        <div style="display:flex;align-items:flex-start;gap:8px;flex-direction:${msg.isMyMessage ? 'row-reverse' : 'row'};margin-bottom:12px;">
                            <div style="width:40px;height:40px;border-radius:50%;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;overflow:hidden;">
                                ${msg.avatarUrl
                                    ? `<img src="${msg.avatarUrl}" style="width:100%;height:100%;object-fit:cover;" alt="avatar">`
                                    : `<div style="color:#888;font-size:18px;">${msg.isMyMessage ? '我' : '對'}</div>`}
                            </div>
                            <div style="background:${msg.isMyMessage ? '#2d5a3d' : '#2d2d3d'};border-radius:8px;padding:8px 10px;max-width:70%;display:flex;align-items:center;gap:8px;">
                                <div style="font-size:14px;line-height:1.4;word-wrap:break-word;flex:1;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;max-height:2.8em;">${msg.text}</div>
                                ${msg.timestamp ? `<div style="font-size:11px;color:rgba(255,255,255,0.5);flex-shrink:0;white-space:nowrap;">${msg.timestamp}</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        document.body.appendChild(detail);
        const close = () => detail.remove();
        document.getElementById('knock-detail-close').onclick = close;
        detail.addEventListener('click', (e) => { if (e.target === detail) close(); });
    }

    function manualSaveConversation() {
        if (!currentConversation.id || currentConversation.messages.length === 0) {
            alert('目前沒有可儲存的對話');
            return;
        }
        if (currentConversation.saved || isConversationProcessed(currentConversation.id)) {
            alert('此對話已經儲存過了');
            return;
        }
        if (saveConversation(currentConversation)) showToast('對話已成功儲存');
        else alert('儲存失敗，請重試');
    }

    document.addEventListener('click', (e) => {
        const convId = e.target.getAttribute?.('data-conv-id');
        if (!convId) return;
        if (e.target.classList.contains('knock-delete-btn')) {
            if (confirm('確定要刪除這個對話嗎？') && deleteConversation(convId)) {
                document.getElementById('knock-conversation-manager')?.remove();
                createConversationManager();
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
        createFloatButton('knock-manager-button', 70, '<span>📚</span><span>對話記錄</span>', createConversationManager);
        createFloatButton('knock-manual-save-button', 120, '<span>💾</span><span>儲存對話</span>', manualSaveConversation);
    }

    if (document.body) mountChrome();
    else window.addEventListener('DOMContentLoaded', mountChrome);

    new MutationObserver(() => {
        mountChrome();
        checkNewMessages();
        checkForButtonAndClick();
        checkConversationEnd();
    }).observe(document.documentElement, { childList: true, subtree: true });

    setInterval(checkConversationEnd, 2000);

    if (isPendingStartChat()) console.log('重整後繼續：等待「開始聊天」按鈕...');
    requestNotifyPermission();
    checkForButtonAndClick();
    checkNewMessages();
    notificationsArmed = true;
    checkConversationEnd();
})();
