// ==UserScript==
// @name         Knock.tw Auto Clicker
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Automatically click the "Re-match" and "Confirm Exit" buttons on Knock.tw, with conversation blacklist and avatar matching features
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
                setTimeout(() => {
                    console.log('Clicking re-match button after delay...');
                    simulateMouseClick(button);
                }, 3000);
                return;
            }

            // Check for the "Confirm" button when exiting
            // It searches for "確定" and ensures the data-test attribute is "ok"
            if (button.textContent.includes('確定') && button.getAttribute('data-test') === 'ok') {
                console.log('Confirm exit button found! Clicking...');
                simulateMouseClick(button);
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
        if (!messagesList) return;

        // 找到所有訊息元素
        const messageElements = messagesList.querySelectorAll('li.message-li');

        for (const messageLi of messageElements) {
            // 使用 message-li 的 class 作為唯一標識
            const messageId = messageLi.className;
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
