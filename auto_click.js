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

        const messageData = {
            id: messageLi.className,
            text: messageText,
            isMyMessage: isMyMessage,
            avatarUrl: avatarUrl,
            timestamp: timestamp,
            collectedAt: new Date().toISOString()
        };

        // 檢查是否已經收集過這條訊息
        const existingIndex = currentConversation.messages.findIndex(m => m.id === messageData.id);
        if (existingIndex === -1) {
            currentConversation.messages.push(messageData);
            console.log('收集訊息:', messageData);
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
        // 如果已經顯示過提示或已儲存，不再檢查
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

        // 如果對話結束且尚未顯示儲存提示
        if (conversationEnded && currentConversation.messages.length > 0) {
            currentConversation.promptShown = true; // 標記已顯示提示
            // 延遲一下，確保對話已完全結束
            setTimeout(() => {
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

    function checkForButtonAndClick() {
        // 檢查開關狀態，如果關閉則不執行
        if (!autoClickEnabled) {
            return;
        }

        // Find all buttons
        const buttons = document.querySelectorAll('button');

        for (const button of buttons) {
            // Check if the button contains the specific text for re-matching
            if (button.textContent.includes('對方已離開聊天，點我重新配對')) {
                console.log('Re-match button found! Waiting 3 seconds before clicking to avoid slow pairing...');
                // 在重新配對前，檢查是否需要儲存對話
                checkConversationEnd();
                setTimeout(() => {
                    simulateMouseClick(button);
                    // 重新配對後初始化新對話
                    setTimeout(() => {
                        initNewConversation();
                    }, 1000);
                }, 3000);
                return;
            }

            // Check for the "Confirm" button when exiting
            // It searches for "確定" and ensures the data-test attribute is "ok"
            if (button.textContent.includes('確定') && button.getAttribute('data-test') === 'ok') {
                console.log('Confirm exit button found! Clicking...');
                // 在退出前，檢查是否需要儲存對話
                checkConversationEnd();
                simulateMouseClick(button);
                // 退出後初始化新對話
                setTimeout(() => {
                        console.log('Initializing new conversation...');
                    initNewConversation();
                }, 1000);
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
            checkForButtonAndClick();

            // 等待退出完成後，自動點擊「開始聊天」按鈕
            setTimeout(() => {
                console.log('尋找「開始聊天」按鈕...');
                const buttons = document.querySelectorAll('button');
                for (const button of buttons) {
                    if (button.textContent.includes('開始聊天')) {
                        console.log('找到「開始聊天」按鈕，點擊中...');
                        simulateMouseClick(button);
                        return;
                    }
                }
                console.warn('未找到「開始聊天」按鈕');
            }, 2000); // 等待 2 秒讓退出流程完成
        } else {
            console.warn('未找到退出按鈕');
        }
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
                }, 1500);
            } else {
                alert('儲存失敗，請重試');
            }
        });

        // 點擊背景關閉
        prompt.addEventListener('click', (e) => {
            if (e.target === prompt) {
                prompt.remove();
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

    function createConversationCard(conversation) {
        const startDate = new Date(conversation.startTime);
        const endDate = conversation.endTime ? new Date(conversation.endTime) : null;
        const duration = endDate ? Math.round((endDate - startDate) / 1000 / 60) : 0;

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
                            ${duration > 0 ? ` · 持續 ${duration} 分鐘` : ''}
                        </div>
                        <div style="font-size: 12px; color: #666;">
                            ${conversation.messages.length} 條訊息
                        </div>
                    </div>
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

        const startDate = new Date(conversation.startTime);
        const endDate = conversation.endTime ? new Date(conversation.endTime) : null;

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
                    <div>訊息數量: ${conversation.messages.length} 條</div>
                </div>

                <div id="knock-messages-container" style="display: flex; flex-direction: column; gap: 12px;">
                    ${conversation.messages.map(msg => `
                        <div style="
                            background: ${msg.isMyMessage ? '#2d5a3d' : '#2d2d3d'};
                            border-radius: 8px;
                            padding: 12px;
                            margin-left: ${msg.isMyMessage ? 'auto' : '0'};
                            margin-right: ${msg.isMyMessage ? '0' : 'auto'};
                            max-width: 70%;
                        ">
                            <div style="font-size: 12px; color: #888; margin-bottom: 4px;">
                                ${msg.isMyMessage ? '我' : '對方'} ${msg.timestamp || ''}
                            </div>
                            <div style="font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word;">
                                ${msg.text}
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

    // 等待 DOM 載入完成後創建管理按鈕
    if (document.body) {
        createManagerButton();
    } else {
        window.addEventListener('DOMContentLoaded', createManagerButton);
    }
    // ====================

    // Create a MutationObserver to watch for changes in the DOM
    const observer = new MutationObserver((mutations) => {
        // 檢查新訊息（黑名單功能）
        checkNewMessages();
        // 檢查按鈕（原有的重新配對和確認退出功能）
        checkForButtonAndClick();
    });

    // Start observing the body for added nodes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Initial check in case the button is already there
    checkForButtonAndClick();
    checkNewMessages();

})();
