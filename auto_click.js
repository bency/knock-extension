// ==UserScript==
// @name         Knock.tw Auto Clicker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automatically click the "Re-match" and "Confirm Exit" buttons on Knock.tw
// @author       Antigravity
// @match        https://knock.tw/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=knock.tw
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log('Knock.tw Auto-clicker started.');

    function checkForButtonAndClick() {
        // Find all buttons
        const buttons = document.querySelectorAll('button');

        for (const button of buttons) {
            // Check if the button contains the specific text for re-matching
            if (button.textContent.includes('對方已離開聊天，點我重新配對')) {
                console.log('Re-match button found! Clicking...');
                button.click();
                return;
            }

            // Check for the "Confirm" button when exiting
            // It searches for "確定" and ensures the data-test attribute is "ok"
            if (button.textContent.includes('確定') && button.getAttribute('data-test') === 'ok') {
                console.log('Confirm exit button found! Clicking...');
                button.click();
                return;
            }
        }
    }

    // Create a MutationObserver to watch for changes in the DOM
    const observer = new MutationObserver((mutations) => {
        // We observe the body for any child list changes
        checkForButtonAndClick();
    });

    // Start observing the body for added nodes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Initial check in case the button is already there
    checkForButtonAndClick();

})();
