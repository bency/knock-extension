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

    console.log('Knock.tw Auto-clicker started.');

    // ===== 自動點擊開關設定 =====
    // 從 localStorage 讀取開關狀態，預設為開啟
    function getAutoClickEnabled() {
        const saved = localStorage.getItem('knockAutoClickEnabled');
        return saved === null ? true : saved === 'true';
    }

    // 儲存開關狀態到 localStorage
    function setAutoClickEnabled(enabled) {
        localStorage.setItem('knockAutoClickEnabled', enabled.toString());
    }

    // 初始化開關狀態
    let autoClickEnabled = getAutoClickEnabled();
    // ====================

    // ===== 黑名單設定 =====
    // 在此處設定要過濾的 regexp 規則，符合任一規則的訊息將觸發自動退出
    const BLACKLIST_PATTERNS = [
        // 如果需要封鎖所有 is.gd 短網址，可以取消下面這行的註解
        /is\.gd\/[a-zA-Z0-9]+/i,
        // 範例：過濾包含特定關鍵字的訊息
        // /廣告|spam|垃圾/i,
        // /特定詞彙/i,
    ];
    // ====================

    // 追蹤已檢查過的訊息，避免重複檢查
    const checkedMessages = new Set();
    // 快取自己的頭像 URL
    let myAvatarUrl = null;

    // ===== 對話儲存功能 =====
    // 當前對話的訊息記錄
    let currentConversation = {
        id: null,
        messages: [],
        startTime: null,
        endTime: null,
        saved: false,
        promptShown: false  // 標記是否已顯示儲存提示
    };

    // 標記是否有儲存提示正在顯示（用於阻止自動退出）
    let isSavePromptVisible = false;

    // 追蹤已處理過的對話 ID（包括儲存和不儲存的）
    let processedConversationIds = new Set();

    // 從 localStorage 載入已處理的對話 ID
    function loadProcessedConversationIds() {
        try {
            const saved = localStorage.getItem('knockProcessedConversationIds');
            if (saved) {
                processedConversationIds = new Set(JSON.parse(saved));
            }
        } catch (e) {
            console.error('載入已處理對話 ID 失敗:', e);
            processedConversationIds = new Set();
        }
    }

    // 儲存已處理的對話 ID 到 localStorage
    function saveProcessedConversationIds() {
        try {
            localStorage.setItem('knockProcessedConversationIds', JSON.stringify(Array.from(processedConversationIds)));
        } catch (e) {
            console.error('儲存已處理對話 ID 失敗:', e);
        }
    }

    // 檢查對話是否已經被處理過（已儲存或已選擇不儲存）
    function isConversationProcessed(conversationId) {
        // 檢查是否在已處理列表中
        if (processedConversationIds.has(conversationId)) {
            return true;
        }

        // 檢查是否已經儲存到 localStorage
        const savedConversations = getSavedConversations();
        const isSaved = savedConversations.some(conv => conv.id === conversationId);

        if (isSaved) {
            // 如果已儲存，也加入已處理列表，避免重複檢查
            processedConversationIds.add(conversationId);
            saveProcessedConversationIds();
        }

        return isSaved;
    }

    // 初始化時載入已處理的對話 ID
    loadProcessedConversationIds();

    // 簡單的字串 hash 函數
    function hashString(str) {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36);
    }

    // 初始化新對話
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

    // 收集訊息到當前對話
    function collectMessage(messageLi) {
        const messageDiv = messageLi.querySelector('div[data-test="message"]');
        if (!messageDiv) return;

        const messageContainer = messageLi.querySelector('div[class*="jss"]');
        let isMyMessage = false;

        if (messageContainer) {
            const computedStyle = window.getComputedStyle(messageContainer);
            isMyMessage = computedStyle.flexDirection === 'row-reverse' ||
                messageContainer.classList.toString().includes('jss630') ||
                messageContainer.classList.toString().includes('jss94');
        }

        // 獲取頭像
        const avatarImg = messageLi.querySelector('div[data-test="user-avatar"] img, img.MuiAvatar-img');
        const avatarUrl = avatarImg ? avatarImg.src : null;

        // 獲取時間戳（如果有的話）- 先獲取時間，因為 textContent 會包含時間
        const timeElement = messageDiv.querySelector('span[data-test="date"]');
        const timestamp = timeElement ? timeElement.textContent.trim() : null;

        // 獲取訊息文字內容 - 需要排除時間元素
        let messageText = '';
        if (timeElement && timeElement.parentElement) {
            // 如果找到時間元素，克隆整個 messageDiv 並移除時間部分
            const clone = messageDiv.cloneNode(true);
            const timeElementInClone = clone.querySelector('span[data-test="date"]');
            if (timeElementInClone && timeElementInClone.parentElement) {
                // 移除包含時間的整個 div
                const timeContainer = timeElementInClone.closest('div[style*="grid-area: date"]');
                if (timeContainer) {
                    timeContainer.remove();
                }
            }
            messageText = clone.textContent.trim();
        } else {
            // 如果沒有時間元素，直接使用 textContent
            messageText = messageDiv.textContent.trim();
        }

        // 過濾掉系統提示訊息（如「對方正在輸入...」）
        const systemMessages = [
            '對方正在輸入',
            '正在輸入',
            'typing',
            'Typing'
        ];

        const isSystemMessage = systemMessages.some(systemMsg =>
            messageText.includes(systemMsg)
        );

        // 如果是系統提示訊息，跳過不收集
        if (isSystemMessage) {
            console.log('跳過系統提示訊息:', messageText);
            return;
        }

        // 使用訊息內容生成 hash 作為唯一標識
        // 組合：文字內容 + 是否為自己的訊息 + 時間戳
        const messageKey = `${messageText}|${isMyMessage}|${timestamp || ''}`;
        const messageHash = hashString(messageKey);

        const messageData = {
            id: messageHash,  // 使用 hash 作為 ID
            text: messageText,
            isMyMessage: isMyMessage,
            avatarUrl: avatarUrl,
            timestamp: timestamp,
            collectedAt: new Date().toISOString()
        };

        // 檢查是否已經收集過這條訊息（使用 hash 來判斷）
        const existingIndex = currentConversation.messages.findIndex(m => m.id === messageHash);
        if (existingIndex === -1) {
            currentConversation.messages.push(messageData);
            console.log('收集訊息:', messageData);
        } else {
            console.log('訊息已存在，跳過:', messageText);
        }
    }

    // 從 localStorage 獲取所有已儲存的對話
    function getSavedConversations() {
        try {
            const saved = localStorage.getItem('knockSavedConversations');
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            console.error('讀取已儲存對話失敗:', e);
            return [];
        }
    }

    // 儲存對話到 localStorage
    function saveConversation(conversation) {
        if (conversation.saved) {
            console.log('對話已儲存，跳過');
            return;
        }

        conversation.endTime = new Date().toISOString();
        conversation.saved = true;

        const savedConversations = getSavedConversations();
        savedConversations.unshift(conversation); // 最新的放在最前面

        // 限制最多儲存 100 個對話
        if (savedConversations.length > 100) {
            savedConversations.splice(100);
        }

        try {
            localStorage.setItem('knockSavedConversations', JSON.stringify(savedConversations));
            // 將對話 ID 加入已處理列表
            if (conversation.id) {
                processedConversationIds.add(conversation.id);
                saveProcessedConversationIds();
            }
            console.log('對話已儲存:', conversation.id);
            return true;
        } catch (e) {
            console.error('儲存對話失敗:', e);
            return false;
        }
    }

    // 刪除已儲存的對話
    function deleteConversation(conversationId) {
        const savedConversations = getSavedConversations();
        const filtered = savedConversations.filter(conv => conv.id !== conversationId);
        try {
            localStorage.setItem('knockSavedConversations', JSON.stringify(filtered));
            console.log('對話已刪除:', conversationId);
            return true;
        } catch (e) {
            console.error('刪除對話失敗:', e);
            return false;
        }
    }

    // 檢測對話是否結束（當出現退出按鈕或重新配對按鈕時）
    function checkConversationEnd() {
        // 如果已經顯示過提示或已處理，不再檢查
        if (currentConversation.promptShown || currentConversation.saved) {
            return;
        }

        // 檢查當前對話是否已經被處理過（已儲存或已選擇不儲存）
        if (currentConversation.id && isConversationProcessed(currentConversation.id)) {
            console.log('對話已處理過，跳過儲存提示:', currentConversation.id);
            currentConversation.saved = true; // 標記為已處理
            return;
        }

        const buttons = document.querySelectorAll('button');
        let conversationEnded = false;

        for (const button of buttons) {
            if (button.textContent.includes('對方已離開聊天，點我重新配對') ||
                (button.textContent.includes('確定') && button.getAttribute('data-test') === 'ok')) {
                conversationEnded = true;
                break;
            }
        }

        // 如果對話結束
        if (conversationEnded && currentConversation.messages.length > 0) {
            // 若「自動開啟新對話」為開啟：不儲存、不跳提示，直接標記為已處理（視為不儲存）
            if (autoClickEnabled) {
                currentConversation.promptShown = true;
                currentConversation.saved = true;
                if (currentConversation.id) {
                    processedConversationIds.add(currentConversation.id);
                    saveProcessedConversationIds();
                }
                console.log('自動開啟新對話啟用中，略過儲存提示並標記為不儲存:', currentConversation.id);
                return;
            }

            // 若「自動開啟新對話」為關閉：才顯示儲存提示
            currentConversation.promptShown = true; // 標記已顯示提示
            // 延遲一下，確保對話已完全結束
            setTimeout(() => {
                // 若在延遲期間開啟自動開啟新對話，就同樣略過提示並標記為不儲存
                if (autoClickEnabled) {
                    currentConversation.saved = true;
                    if (currentConversation.id) {
                        processedConversationIds.add(currentConversation.id);
                        saveProcessedConversationIds();
                    }
                    console.log('延遲期間啟用自動開啟新對話，略過儲存提示並標記為不儲存:', currentConversation.id);
                    return;
                }

                // 再次檢查是否已被處理（防止在延遲期間被處理）
                if (!isConversationProcessed(currentConversation.id)) {
                    showSavePrompt();
                } else {
                    console.log('對話在延遲期間已被處理，跳過顯示提示');
                    currentConversation.saved = true;
                }
            }, 1000);
        }
    }
    // ====================

    // 獲取自己的頭像 URL
    function getMyAvatarUrl() {
        if (myAvatarUrl) return myAvatarUrl;

        const messagesList = document.querySelector('ul[data-test="messages"]');
        if (!messagesList) return null;

        // 找到所有訊息元素
        const messageElements = messagesList.querySelectorAll('li.message-li');

        for (const messageLi of messageElements) {
            // 找到訊息容器，檢查是否為自己的訊息
            // 自己的訊息通常有特定的 class（如 jss630 或 jss94）或 flex-direction: row-reverse
            const messageContainer = messageLi.querySelector('div[class*="jss"]');
            if (!messageContainer) continue;

            // 檢查是否為自己的訊息
            // 方法1：檢查 flex-direction 是否為 row-reverse
            const computedStyle = window.getComputedStyle(messageContainer);
            // 方法2：檢查是否有特定的 class（jss630 或 jss94 等）
            const containerClasses = messageContainer.classList.toString();
            const hasReverseClass = containerClasses.includes('jss630') || containerClasses.includes('jss94');
            const isMyMessage = computedStyle.flexDirection === 'row-reverse' || hasReverseClass;

            if (isMyMessage) {
                // 找到自己的訊息，獲取頭像
                const avatarImg = messageLi.querySelector('div[data-test="user-avatar"] img, img.MuiAvatar-img');
                if (avatarImg && avatarImg.src) {
                    myAvatarUrl = avatarImg.src;
                    console.log('找到自己的頭像:', myAvatarUrl);
                    return myAvatarUrl;
                }
            }
        }

        return null;
    }

    // 檢查對方頭像是否與自己相同
    function checkAvatarMatch(otherMessageLi) {
        // 獲取自己的頭像 URL
        const myAvatar = getMyAvatarUrl();
        if (!myAvatar) {
            // 如果還沒找到自己的頭像，先不檢查
            return false;
        }

        // 獲取對方的頭像
        const otherAvatarImg = otherMessageLi.querySelector('div[data-test="user-avatar"] img, img.MuiAvatar-img');
        if (!otherAvatarImg || !otherAvatarImg.src) return false;

        const otherAvatar = otherAvatarImg.src;

        // 比較頭像 URL
        if (myAvatar === otherAvatar) {
            console.log('檢測到對方頭像與自己相同:', otherAvatar);
            return true;
        }

        return false;
    }

    // 模擬真實的滑鼠點擊事件（適用於 React 組件）
    function simulateMouseClick(element) {
        if (!element) return false;

        // 確保元素可見且可點擊
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 觸發一系列滑鼠事件來模擬真實點擊
        const mouseEvents = ['mousedown', 'mouseup', 'click'];
        const eventOptions = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0
        };

        for (const eventType of mouseEvents) {
            const event = new MouseEvent(eventType, eventOptions);
            element.dispatchEvent(event);
        }

        // 也嘗試直接調用 click 方法
        try {
            element.click();
        } catch (e) {
            console.warn('直接點擊失敗:', e);
        }

        return true;
    }

    // ponytail: sessionStorage 跨重整傳遞意圖；逾時 30s 避免殘留旗標誤點
    const PENDING_START_CHAT_KEY = 'knockPendingStartChat';
    const PENDING_START_CHAT_TTL_MS = 30000;

    function markPendingStartChat() {
        sessionStorage.setItem(PENDING_START_CHAT_KEY, Date.now().toString());
    }

    function isPendingStartChat() {
        const raw = sessionStorage.getItem(PENDING_START_CHAT_KEY);
        if (!raw) return false;
        const ts = Number(raw);
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
        // 檢查開關狀態，如果關閉則不執行
        if (!autoClickEnabled) {
            return;
        }

        // 如果儲存提示正在顯示，不要自動點擊退出/重新配對按鈕
        if (isSavePromptVisible) {
            return;
        }

        // Find all buttons
        const buttons = document.querySelectorAll('button');

        for (const button of buttons) {
            // 退出重整後：有旗標才自動點「開始聊天」，避免一般首頁誤點
            if (isPendingStartChat() && button.textContent.includes('開始聊天')) {
                console.log('重整後找到「開始聊天」按鈕，點擊中...');
                clearPendingStartChat();
                simulateMouseClick(button);
                console.log('已點「開始聊天」，等待配對...');
                return;
            }

            // Check if the button contains the specific text for re-matching
            if (button.textContent.includes('對方已離開聊天，點我重新配對')) {
                console.log('Re-match button found! Waiting 3 seconds before clicking to avoid slow pairing...');
                // 在重新配對前，檢查是否需要儲存對話
                checkConversationEnd();
                // 只有在沒有儲存提示顯示時才自動點擊
                if (!isSavePromptVisible) {
                    setTimeout(() => {
                        if (!isSavePromptVisible) {  // 再次檢查，確保提示沒有在延遲期間顯示
                            simulateMouseClick(button);
                            // 重新配對後初始化新對話
                            setTimeout(() => {
                                initNewConversation();
                            }, 1000);
                        }
                    }, 3000);
                }
                return;
            }

            // Check for the "Confirm" button when exiting
            // It searches for "確定" and ensures the data-test attribute is "ok"
            if (button.textContent.includes('確定') && button.getAttribute('data-test') === 'ok') {
                console.log('Confirm exit button found!');
                // 在退出前，檢查是否需要儲存對話
                checkConversationEnd();
                // 只有在沒有儲存提示顯示時才自動點擊
                if (!isSavePromptVisible) {
                    console.log('Clicking confirm exit button...');
                    simulateMouseClick(button);
                    // 主動退出會重整，對話物件會一起消失，這裡不必先 init
                    if (isPendingStartChat()) {
                        console.log('已記下「開始聊天」，等待頁面重整...');
                    }
                } else {
                    console.log('儲存提示顯示中，等待用戶決定...');
                }
                return;
            }
        }
    }

    // 檢查訊息是否符合黑名單規則
    function checkMessageAgainstBlacklist(messageElement) {
        // 獲取訊息的文字內容
        const messageText = messageElement.textContent || '';

        // 檢查是否符合任一黑名單規則
        for (const pattern of BLACKLIST_PATTERNS) {
            if (pattern.test(messageText)) {
                console.log('黑名單規則觸發:', pattern, '訊息內容:', messageText);
                return true;
            }
        }
        return false;
    }

    // 主動離開對話並重新開始聊天
    function activelyLeaveConversation(messageId) {
        console.log('主動離開對話，準備退出...');
        // 點擊退出按鈕
        const exitButton = document.querySelector('button[data-test="chat-exit-button"]');
        if (exitButton) {
            console.log('找到退出按鈕，點擊中...');
            simulateMouseClick(exitButton);
            // 標記為已檢查，避免重複觸發
            checkedMessages.add(messageId);
            // 重整後 setTimeout 會失效，改用 sessionStorage 記住要點「開始聊天」
            markPendingStartChat();
            checkForButtonAndClick();
        } else {
            console.warn('未找到退出按鈕');
        }
    }

    // 失焦時對方新訊息才通知；第一次掃描不發，避免舊訊息洗版
    let notificationsArmed = false;

    function isPageUnfocused() {
        return document.hidden || !document.hasFocus();
    }

    function requestNotifyPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') return;
        Notification.requestPermission().catch(() => {});
    }

    function notifyNewMessage(text) {
        if (!notificationsArmed || !isPageUnfocused()) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        const body = (text || '你有一則新訊息').replace(/\s+/g, ' ').trim().slice(0, 80) || '你有一則新訊息';
        const notification = new Notification('Knock 新訊息', {
            body,
            tag: 'knock-new-message'
        });
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    }

    // 檢查新訊息並處理黑名單
    function checkNewMessages() {
        // 找到訊息列表
        const messagesList = document.querySelector('ul[data-test="messages"]');
        if (!messagesList) {
            return;
        }

        // 如果當前沒有對話 ID 或對話已標記為已處理但訊息列表已清空，初始化新對話
        if (!currentConversation.id || (currentConversation.saved && currentConversation.messages.length === 0)) {
            // 檢查是否真的有訊息（可能是新對話）
            const messageElements = messagesList.querySelectorAll('li.message-li');
            if (messageElements.length > 0) {
                        console.log('Initializing new conversation...');
                initNewConversation();
            } else {
                return;
            }
        }

        // 找到所有訊息元素
        const messageElements = messagesList.querySelectorAll('li.message-li');

        for (const messageLi of messageElements) {
            // 使用 message-li 的 class 作為唯一標識
            const messageId = messageLi.className;

            // 收集訊息（無論是否已檢查過）
            collectMessage(messageLi);

            if (checkedMessages.has(messageId)) continue;

            // 標記為已檢查
            checkedMessages.add(messageId);

            // 找到訊息內容元素
            const messageDiv = messageLi.querySelector('div[data-test="message"]');
            if (!messageDiv) continue;

            // 判斷是否為對方發送的訊息
            // 方法1：檢查是否有特定的 class（適用於 normal-conversation.html）
            const messageContainer = messageLi.querySelector('div[class*="jss"]');
            let isMyMessage = false;
            let isOtherUserMessage = false;

            if (messageContainer) {
                // 檢查 flex-direction 來判斷是否為自己的訊息
                const computedStyle = window.getComputedStyle(messageContainer);
                isMyMessage = computedStyle.flexDirection === 'row-reverse' ||
                    messageContainer.classList.toString().includes('jss630') ||
                    messageContainer.classList.toString().includes('jss94');
                isOtherUserMessage = !isMyMessage;
            }

            if (isMyMessage) {
                console.log('自己的訊息，不進行檢查');
                continue;
            }

            const notifyText = (messageDiv.textContent || '').trim();
            if (notifyText && !/對方正在輸入|正在輸入/i.test(notifyText)) {
                notifyNewMessage(notifyText);
            }

            // 檢查頭像是否與自己相同
            if (checkAvatarMatch(messageLi)) {
                console.log('觸發頭像相同規則');
                activelyLeaveConversation(messageId);
                return;
            }

            // 檢查是否符合黑名單規則
            if (checkMessageAgainstBlacklist(messageDiv)) {
                console.log('觸發黑名單規則');
                activelyLeaveConversation(messageId);
                return;
            }
        }

        // 檢查對話是否結束
        checkConversationEnd();
    }

    // ===== 創建開關 UI =====
    function createToggleSwitch() {
        // 檢查是否已經存在開關
        if (document.getElementById('knock-auto-click-toggle')) {
            return;
        }

        // 創建開關容器
        const toggleContainer = document.createElement('div');
        toggleContainer.id = 'knock-auto-click-toggle';
        toggleContainer.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            background: rgba(0, 0, 0, 0.8);
            border-radius: 8px;
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            color: #fff;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            cursor: pointer;
            user-select: none;
            transition: all 0.3s ease;
        `;

        // 創建開關標籤
        const label = document.createElement('span');
        label.textContent = '自動開啟新對話';
        label.style.cssText = 'white-space: nowrap;';

        // 創建開關按鈕
        const toggleSwitch = document.createElement('div');
        toggleSwitch.style.cssText = `
            width: 50px;
            height: 26px;
            background: ${autoClickEnabled ? '#4CAF50' : '#ccc'};
            border-radius: 13px;
            position: relative;
            transition: background 0.3s ease;
        `;

        // 創建開關滑塊
        const toggleSlider = document.createElement('div');
        toggleSlider.style.cssText = `
            width: 22px;
            height: 22px;
            background: #fff;
            border-radius: 50%;
            position: absolute;
            top: 2px;
            left: ${autoClickEnabled ? '26px' : '2px'};
            transition: left 0.3s ease;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        `;

        toggleSwitch.appendChild(toggleSlider);
        toggleContainer.appendChild(label);
        toggleContainer.appendChild(toggleSwitch);

        // 點擊切換功能
        toggleContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            autoClickEnabled = !autoClickEnabled;
            setAutoClickEnabled(autoClickEnabled);

            // 更新 UI
            toggleSwitch.style.background = autoClickEnabled ? '#4CAF50' : '#ccc';
            toggleSlider.style.left = autoClickEnabled ? '26px' : '2px';

            console.log('自動點擊功能已', autoClickEnabled ? '開啟' : '關閉');
            requestNotifyPermission();
        });

        // 添加到頁面
        document.body.appendChild(toggleContainer);

        // 確保開關在頁面重新載入時也能顯示
        const ensureToggleVisible = () => {
            if (!document.getElementById('knock-auto-click-toggle')) {
                createToggleSwitch();
            }
        };

        // 監聽 DOM 變化，確保開關始終存在
        const toggleObserver = new MutationObserver(() => {
            ensureToggleVisible();
        });

        toggleObserver.observe(document.body, {
            childList: true,
            subtree: false
        });
    }

    // 等待 DOM 載入完成後創建開關
    if (document.body) {
        createToggleSwitch();
    } else {
        window.addEventListener('DOMContentLoaded', createToggleSwitch);
    }
    // ====================

    // ===== 儲存提示 UI =====
    function showSavePrompt() {
        // 如果已經顯示過提示，不再顯示
        if (document.getElementById('knock-save-prompt') || currentConversation.saved) {
            return;
        }

        // 再次檢查對話是否已經被處理過（雙重保險）
        if (currentConversation.id && isConversationProcessed(currentConversation.id)) {
            console.log('對話已處理過，不顯示儲存提示:', currentConversation.id);
            currentConversation.saved = true;
            return;
        }

        // 標記儲存提示正在顯示
        isSavePromptVisible = true;

        const prompt = document.createElement('div');
        prompt.id = 'knock-save-prompt';
        prompt.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10001;
            background: rgba(0, 0, 0, 0.95);
            border-radius: 12px;
            padding: 24px;
            min-width: 320px;
            max-width: 90%;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
        `;

        prompt.innerHTML = `
            <div style="margin-bottom: 16px; font-size: 18px; font-weight: 600;">
                對話已結束
            </div>
            <div style="margin-bottom: 20px; font-size: 14px; color: #ccc;">
                本次對話共有 ${currentConversation.messages.length} 條訊息，是否要儲存？
            </div>
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button id="knock-save-cancel" style="
                    padding: 8px 16px;
                    background: #444;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                ">不儲存</button>
                <button id="knock-save-confirm" style="
                    padding: 8px 16px;
                    background: #4CAF50;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                ">儲存對話</button>
            </div>
        `;

        document.body.appendChild(prompt);

        // 不儲存按鈕
        document.getElementById('knock-save-cancel').addEventListener('click', () => {
            prompt.remove();
            isSavePromptVisible = false; // 清除標記，允許繼續自動操作
            // 將對話 ID 加入已處理列表，避免重複詢問
            if (currentConversation.id) {
                processedConversationIds.add(currentConversation.id);
                saveProcessedConversationIds();
                console.log('對話已標記為不儲存:', currentConversation.id);
            }
            currentConversation.saved = true; // 標記為已處理，避免重複提示
            // 清空訊息和開始時間，但保留 ID（這樣下次檢查時會看到已處理）
            // 當檢測到新對話開始時（在 checkNewMessages 中），會初始化新對話
        });

        // 儲存按鈕
        document.getElementById('knock-save-confirm').addEventListener('click', () => {
            if (saveConversation(currentConversation)) {
                // 將對話 ID 加入已處理列表
                if (currentConversation.id) {
                    processedConversationIds.add(currentConversation.id);
                    saveProcessedConversationIds();
                }
                prompt.innerHTML = `
                    <div style="text-align: center; padding: 20px;">
                        <div style="font-size: 18px; margin-bottom: 12px;">✓ 已儲存</div>
                        <div style="font-size: 14px; color: #ccc;">對話已成功儲存</div>
                    </div>
                `;
                setTimeout(() => {
                    prompt.remove();
                    isSavePromptVisible = false; // 清除標記，允許繼續自動操作
                }, 1500);
            } else {
                alert('儲存失敗，請重試');
            }
        });

        // 點擊背景關閉（視為不儲存）
        prompt.addEventListener('click', (e) => {
            if (e.target === prompt) {
                prompt.remove();
                isSavePromptVisible = false; // 清除標記，允許繼續自動操作
                // 將對話 ID 加入已處理列表（視為不儲存）
                if (currentConversation.id) {
                    processedConversationIds.add(currentConversation.id);
                    saveProcessedConversationIds();
                }
                currentConversation.saved = true;
            }
        });
    }
    // ====================

    // ===== 對話管理介面 =====
    function createConversationManager() {
        // 如果已經存在，先移除
        const existing = document.getElementById('knock-conversation-manager');
        if (existing) {
            existing.remove();
            return;
        }

        const manager = document.createElement('div');
        manager.id = 'knock-conversation-manager';
        manager.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 10002;
            background: rgba(0, 0, 0, 0.9);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
            overflow-y: auto;
        `;

        const savedConversations = getSavedConversations();

        manager.innerHTML = `
            <div style="max-width: 900px; margin: 0 auto; padding: 24px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                    <h2 style="margin: 0; font-size: 24px;">對話記錄管理</h2>
                    <button id="knock-manager-close" style="
                        padding: 8px 16px;
                        background: #444;
                        color: #fff;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                    ">關閉</button>
                </div>

                <div style="margin-bottom: 20px;">
                    <input type="text" id="knock-search-input" placeholder="搜尋對話內容..." style="
                        width: 100%;
                        padding: 12px;
                        background: #333;
                        border: 1px solid #555;
                        border-radius: 6px;
                        color: #fff;
                        font-size: 14px;
                        box-sizing: border-box;
                    ">
                </div>

                <div id="knock-conversations-list" style="display: flex; flex-direction: column; gap: 12px;">
                    ${savedConversations.length === 0 ?
                        '<div style="text-align: center; padding: 40px; color: #888;">尚無已儲存的對話</div>' :
                        savedConversations.map(conv => createConversationCard(conv)).join('')
                    }
                </div>
            </div>
        `;

        document.body.appendChild(manager);

        // 關閉按鈕
        document.getElementById('knock-manager-close').addEventListener('click', () => {
            manager.remove();
        });

        // 點擊背景關閉
        manager.addEventListener('click', (e) => {
            if (e.target === manager) {
                manager.remove();
            }
        });

        // 搜尋功能
        const searchInput = document.getElementById('knock-search-input');
        searchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            const list = document.getElementById('knock-conversations-list');
            const allCards = list.querySelectorAll('.knock-conv-card');

            allCards.forEach(card => {
                const cardText = card.textContent.toLowerCase();
                card.style.display = cardText.includes(searchTerm) ? 'block' : 'none';
            });
        });
    }

    // 解析 timestamp (HH:MM) 為分鐘數
    function parseTime(timeStr) {
        if (!timeStr) return Infinity;
        const parts = timeStr.split(':');
        if (parts.length !== 2) return Infinity;
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes)) return Infinity;
        return hours * 60 + minutes; // 轉換為分鐘數
    }

    // 將時間值（分鐘數）轉換為完整的 Date 物件
    function timeToDate(timeMinutes, baseDate) {
        if (timeMinutes === Infinity) return null;
        const hours = Math.floor(timeMinutes / 60);
        const minutes = timeMinutes % 60;
        const date = new Date(baseDate);
        date.setHours(hours, minutes, 0, 0);
        return date;
    }

    // 獲取對話中訊息時間（最舊或最晚）
    function getMessageTime(conversation, isOldest = true) {
        if (!conversation.messages || conversation.messages.length === 0) {
            if (isOldest) {
                return conversation.startTime ? new Date(conversation.startTime) : new Date();
            } else {
                return conversation.endTime ? new Date(conversation.endTime) : null;
            }
        }

        // 找到所有有 timestamp 的訊息
        const messagesWithTimestamp = conversation.messages.filter(msg => msg.timestamp);
        if (messagesWithTimestamp.length > 0) {
            // 根據 isOldest 決定找最舊（最小值）還是最晚（最大值）
            const targetTime = messagesWithTimestamp.reduce((target, msg) => {
                const msgTime = parseTime(msg.timestamp);
                return isOldest ? (msgTime < target ? msgTime : target) : (msgTime > target ? msgTime : target);
            }, parseTime(messagesWithTimestamp[0].timestamp));

            if (targetTime !== Infinity) {
                // 決定 baseDate：最舊用 startTime，最晚優先 endTime 其次 startTime
                const baseDate = isOldest
                    ? (conversation.startTime ? new Date(conversation.startTime) : new Date())
                    : (conversation.endTime ? new Date(conversation.endTime) :
                       (conversation.startTime ? new Date(conversation.startTime) : new Date()));
                return timeToDate(targetTime, baseDate);
            }
        }

        // 如果沒有 timestamp，使用 fallback 時間
        if (isOldest) {
            return conversation.startTime ? new Date(conversation.startTime) : new Date();
        } else {
            return conversation.endTime ? new Date(conversation.endTime) : null;
        }
    }

    // 格式化對話內容為可複製的文字格式
    function formatConversationForCopy(conversation) {
        // 對訊息按時間排序（使用 timestamp）
        const sortedMessages = [...conversation.messages].sort((a, b) => {
            // 將 timestamp (如 "01:59") 轉換為可比較的格式
            const parseTime = (timeStr) => {
                if (!timeStr) return 0; // 沒有時間戳的訊息放在前面
                const parts = timeStr.split(':');
                if (parts.length !== 2) return Infinity;
                const hours = parseInt(parts[0], 10);
                const minutes = parseInt(parts[1], 10);
                if (isNaN(hours) || isNaN(minutes)) return Infinity;
                return hours * 60 + minutes; // 轉換為分鐘數
            };

            const timeA = parseTime(a.timestamp);
            const timeB = parseTime(b.timestamp);

            if (timeA === Infinity && timeB === Infinity) return 0;
            if (timeA === Infinity) return 1;
            if (timeB === Infinity) return -1;

            return timeA - timeB;
        });

        // 格式化每條訊息為「發話者、時間、內容」的格式
        const formattedLines = sortedMessages.map(msg => {
            const speaker = msg.isMyMessage ? '我  ' : '對方';
            const time = msg.timestamp || '未知時間';
            const content = msg.text || '';
            return `${speaker}(${time}):${content}`;
        });

        return formattedLines.join('\n');
    }

    // 複製對話內容到剪貼板
    async function copyConversation(conversationId) {
        const savedConversations = getSavedConversations();
        const conversation = savedConversations.find(conv => conv.id === conversationId);

        if (!conversation) {
            alert('找不到此對話');
            return;
        }

        const formattedText = formatConversationForCopy(conversation);

        try {
            // 使用 Clipboard API 複製
            await navigator.clipboard.writeText(formattedText);

            // 顯示成功提示
            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                z-index: 10005;
                background: rgba(0, 0, 0, 0.9);
                border-radius: 12px;
                padding: 20px 32px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 16px;
                color: #fff;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                gap: 12px;
            `;
            toast.innerHTML = `
                <span style="font-size: 24px;">✓</span>
                <span>對話內容已複製到剪貼板</span>
            `;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.remove();
            }, 2000);
        } catch (err) {
            console.error('複製失敗:', err);
            // 降級方案：使用傳統方法
            const textArea = document.createElement('textarea');
            textArea.value = formattedText;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                alert('對話內容已複製到剪貼板');
            } catch (e) {
                alert('複製失敗，請手動複製');
            }
            document.body.removeChild(textArea);
        }
    }

    function createConversationCard(conversation) {
        const startDate = getMessageTime(conversation, true);
        const endDate = getMessageTime(conversation, false);
        let durationText = '';
        if (endDate) {
            const durationSeconds = Math.round((endDate - startDate) / 1000);
            const durationMinutes = Math.floor(durationSeconds / 60);
            if (durationMinutes > 0) {
                durationText = `${durationMinutes} 分鐘`;
                const remainingSeconds = durationSeconds % 60;
                if (remainingSeconds > 0) {
                    durationText += ` ${remainingSeconds} 秒`;
                }
            } else {
                durationText = `${durationSeconds} 秒`;
            }
        }

        // 獲取對話預覽（前幾條訊息）
        const preview = conversation.messages.slice(0, 3).map(msg => {
            const prefix = msg.isMyMessage ? '我: ' : '對方: ';
            const text = msg.text.substring(0, 50);
            return prefix + text + (msg.text.length > 50 ? '...' : '');
        }).join('<br>');

        return `
            <div class="knock-conv-card" style="
                background: #222;
                border-radius: 8px;
                padding: 16px;
                border: 1px solid #444;
            ">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                    <div>
                        <div style="font-size: 14px; color: #888; margin-bottom: 4px;">
                            ${startDate.toLocaleString('zh-TW')}
                            ${durationText ? ` · 持續 ${durationText}` : ''}
                        </div>
                        <div style="font-size: 12px; color: #666;">
                            ${conversation.messages.length} 條訊息
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="knock-copy-btn" data-conv-id="${conversation.id}" style="
                            padding: 6px 12px;
                            background: #2196F3;
                            color: #fff;
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                        ">複製</button>
                        <button class="knock-delete-btn" data-conv-id="${conversation.id}" style="
                            padding: 6px 12px;
                            background: #d32f2f;
                            color: #fff;
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                        ">刪除</button>
                    </div>
                </div>
                <div style="
                    background: #1a1a1a;
                    border-radius: 6px;
                    padding: 12px;
                    font-size: 13px;
                    color: #ccc;
                    line-height: 1.6;
                    max-height: 150px;
                    overflow-y: auto;
                ">${preview}</div>
                <button class="knock-view-btn" data-conv-id="${conversation.id}" style="
                    margin-top: 12px;
                    padding: 8px 16px;
                    background: #4CAF50;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    width: 100%;
                ">查看完整對話</button>
            </div>
        `;
    }

    // 處理刪除按鈕點擊
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('knock-delete-btn')) {
            const convId = e.target.getAttribute('data-conv-id');
            if (confirm('確定要刪除這個對話嗎？')) {
                if (deleteConversation(convId)) {
                    createConversationManager(); // 重新載入管理介面
                }
            }
        }

        if (e.target.classList.contains('knock-copy-btn')) {
            const convId = e.target.getAttribute('data-conv-id');
            copyConversation(convId);
        }

        if (e.target.classList.contains('knock-view-btn')) {
            const convId = e.target.getAttribute('data-conv-id');
            showConversationDetail(convId);
        }
    });

    function showConversationDetail(conversationId) {
        const savedConversations = getSavedConversations();
        const conversation = savedConversations.find(conv => conv.id === conversationId);

        if (!conversation) {
            alert('找不到此對話');
            return;
        }

        // 對訊息按時間排序（使用 timestamp）
        const sortedMessages = [...conversation.messages].sort((a, b) => {
            // 將 timestamp (如 "01:59") 轉換為可比較的格式
            const parseTime = (timeStr) => {
                if (!timeStr) return 0; // 沒有時間戳的訊息放在前面
                const parts = timeStr.split(':');
                if (parts.length !== 2) return Infinity;
                const hours = parseInt(parts[0], 10);
                const minutes = parseInt(parts[1], 10);
                if (isNaN(hours) || isNaN(minutes)) return Infinity;
                return hours * 60 + minutes; // 轉換為分鐘數
            };

            const timeA = parseTime(a.timestamp);
            const timeB = parseTime(b.timestamp);

            if (timeA === Infinity && timeB === Infinity) return 0;
            if (timeA === Infinity) return 1;
            if (timeB === Infinity) return -1;

            return timeA - timeB;
        });

        const detail = document.createElement('div');
        detail.id = 'knock-conversation-detail';
        detail.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 10003;
            background: rgba(0, 0, 0, 0.95);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
            overflow-y: auto;
        `;

        const startDate = getMessageTime(conversation, true);
        const endDate = getMessageTime(conversation, false);
        let durationText = '';
        if (endDate) {
            const durationSeconds = Math.round((endDate - startDate) / 1000);
            const durationMinutes = Math.floor(durationSeconds / 60);
            if (durationMinutes > 0) {
                durationText = `${durationMinutes} 分鐘`;
                const remainingSeconds = durationSeconds % 60;
                if (remainingSeconds > 0) {
                    durationText += ` ${remainingSeconds} 秒`;
                }
            } else {
                durationText = `${durationSeconds} 秒`;
            }
        }

        detail.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 24px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                    <h2 style="margin: 0; font-size: 20px;">對話詳情</h2>
                    <button id="knock-detail-close" style="
                        padding: 8px 16px;
                        background: #444;
                        color: #fff;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                    ">關閉</button>
                </div>

                <div style="background: #222; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 13px; color: #888;">
                    <div>開始時間: ${startDate.toLocaleString('zh-TW')}</div>
                    ${endDate ? `<div>結束時間: ${endDate.toLocaleString('zh-TW')}</div>` : ''}
                    ${durationText ? `<div>持續時間: ${durationText}</div>` : ''}
                    <div>訊息數量: ${conversation.messages.length} 條</div>
                </div>

                <div id="knock-messages-container" style="display: flex; flex-direction: column; gap: 12px;">
                    ${sortedMessages.map(msg => `
                        <div style="
                            display: flex;
                            align-items: flex-start;
                            gap: 8px;
                            flex-direction: ${msg.isMyMessage ? 'row-reverse' : 'row'};
                            margin-bottom: 12px;
                        ">
                            <div style="
                                width: 40px;
                                height: 40px;
                                border-radius: 50%;
                                flex-shrink: 0;
                                background: #333;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                overflow: hidden;
                            ">
                                ${msg.avatarUrl ?
                                    `<img src="${msg.avatarUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="avatar">` :
                                    `<div style="color: #888; font-size: 18px;">${msg.isMyMessage ? '我' : '對'}</div>`
                                }
                            </div>
                            <div style="
                                background: ${msg.isMyMessage ? '#2d5a3d' : '#2d2d3d'};
                                border-radius: 8px;
                                padding: 8px 10px;
                                max-width: 70%;
                                position: relative;
                                display: flex;
                                flex-direction: row;
                                align-items: center;
                                gap: 8px;
                            ">
                                <div style="
                                    font-size: 14px;
                                    line-height: 1.4;
                                    word-wrap: break-word;
                                    flex: 1;
                                    overflow: hidden;
                                    text-overflow: ellipsis;
                                    display: -webkit-box;
                                    -webkit-line-clamp: 2;
                                    -webkit-box-orient: vertical;
                                    max-height: 2.8em;
                                ">
                                    ${msg.text}
                                </div>
                                ${msg.timestamp ? `
                                    <div style="
                                        font-size: 11px;
                                        color: rgba(255, 255, 255, 0.5);
                                        flex-shrink: 0;
                                        white-space: nowrap;
                                    ">
                                        ${msg.timestamp}
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        document.body.appendChild(detail);

        document.getElementById('knock-detail-close').addEventListener('click', () => {
            detail.remove();
        });

        detail.addEventListener('click', (e) => {
            if (e.target === detail) {
                detail.remove();
            }
        });
    }
    // ====================

    // ===== 手動儲存對話功能 =====
    function manualSaveConversation() {
        // 檢查是否有當前對話
        if (!currentConversation.id || currentConversation.messages.length === 0) {
            alert('目前沒有可儲存的對話');
            return;
        }

        // 檢查對話是否已經儲存
        if (currentConversation.saved) {
            alert('此對話已經儲存過了');
            return;
        }

        // 檢查對話是否已經被處理過
        if (isConversationProcessed(currentConversation.id)) {
            alert('此對話已經儲存過了');
            return;
        }

        // 儲存對話
        if (saveConversation(currentConversation)) {
            // 顯示成功提示
            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                z-index: 10004;
                background: rgba(0, 0, 0, 0.9);
                border-radius: 12px;
                padding: 20px 32px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 16px;
                color: #fff;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                gap: 12px;
            `;
            toast.innerHTML = `
                <span style="font-size: 24px;">✓</span>
                <span>對話已成功儲存</span>
            `;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.remove();
            }, 2000);
        } else {
            alert('儲存失敗，請重試');
        }
    }
    // ====================

    // ===== 管理介面入口按鈕 =====
    function createManagerButton() {
        if (document.getElementById('knock-manager-button')) {
            return;
        }

        const button = document.createElement('div');
        button.id = 'knock-manager-button';
        button.style.cssText = `
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 10000;
            background: rgba(0, 0, 0, 0.8);
            border-radius: 8px;
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            color: #fff;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            cursor: pointer;
            user-select: none;
            transition: all 0.3s ease;
        `;

        button.innerHTML = `
            <span>📚</span>
            <span>對話記錄</span>
        `;

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            createConversationManager();
        });

        document.body.appendChild(button);

        // 確保按鈕始終存在
        const ensureButtonVisible = () => {
            if (!document.getElementById('knock-manager-button')) {
                createManagerButton();
            }
        };

        const buttonObserver = new MutationObserver(() => {
            ensureButtonVisible();
        });

        buttonObserver.observe(document.body, {
            childList: true,
            subtree: false
        });
    }

    // ===== 手動儲存按鈕 =====
    function createManualSaveButton() {
        if (document.getElementById('knock-manual-save-button')) {
            return;
        }

        const button = document.createElement('div');
        button.id = 'knock-manual-save-button';
        button.style.cssText = `
            position: fixed;
            top: 120px;
            right: 20px;
            z-index: 10000;
            background: rgba(0, 0, 0, 0.8);
            border-radius: 8px;
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            color: #fff;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            cursor: pointer;
            user-select: none;
            transition: all 0.3s ease;
        `;

        button.innerHTML = `
            <span>💾</span>
            <span>儲存對話</span>
        `;

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            manualSaveConversation();
        });

        document.body.appendChild(button);

        // 確保按鈕始終存在
        const ensureButtonVisible = () => {
            if (!document.getElementById('knock-manual-save-button')) {
                createManualSaveButton();
            }
        };

        const buttonObserver = new MutationObserver(() => {
            ensureButtonVisible();
        });

        buttonObserver.observe(document.body, {
            childList: true,
            subtree: false
        });
    }

    // 等待 DOM 載入完成後創建按鈕
    if (document.body) {
        createManagerButton();
        createManualSaveButton();
    } else {
        window.addEventListener('DOMContentLoaded', () => {
            createManagerButton();
            createManualSaveButton();
        });
    }
    // ====================

    // Create a MutationObserver to watch for changes in the DOM
    const observer = new MutationObserver((mutations) => {
        // 檢查新訊息（黑名單功能）
        checkNewMessages();
        // 檢查按鈕（原有的重新配對和確認退出功能）
        checkForButtonAndClick();
        // 獨立檢測對話是否結束（不依賴自動點擊功能）
        checkConversationEnd();
    });

    // Start observing the body for added nodes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 定期檢查對話是否結束（確保即使自動點擊關閉也能檢測到）
    setInterval(() => {
        checkConversationEnd();
    }, 2000); // 每2秒檢查一次

    // Initial check in case the button is already there
    if (isPendingStartChat()) {
        console.log('重整後繼續：等待「開始聊天」按鈕...');
    }
    requestNotifyPermission();
    checkForButtonAndClick();
    checkNewMessages();
    notificationsArmed = true;
    checkConversationEnd();

})();
