// ==UserScript==
// @name         Twitch Auto Check and Claim Drops
// @namespace    https://github.com/ZeroStalker3/twitch-autodrops
// @version      1.0.0
// @description  Автоматический сбор drops на Twitch с GUI
// @author       ZeroYz
// @match        *://*.twitch.tv/*
// @run-at       document-idle
// @license      MIT
// @grant        GM_info
// @supportURL   https://github.com/ZeroStalker3/twitch-autodrops/issues
// @updateURL    https://github.com/ZeroStalker3/twitch-autodrops/releases/latest/download/twitch-autodrops.min.user.js
// @downloadURL  https://github.com/ZeroStalker3/twitch-autodrops/releases/latest/download/twitch-autodrops.min.user.js
// @icon         https://assets.twitch.tv/assets/favicon-32-e29e246c157142c94346.png
// ==/UserScript==


(function(){
    'use strict';

    // ===== НАСТРОЙКИ =====
    // Список интересующих игр или компаний (case-insensitive). Оставь пустым для сбора всего.
    // Примеры: ['Rust', 'Facepunch', 'Marvel Rivals', 'Wargaming', 'Ubisoft']
    const WHITELIST = [
        'Rust',
        'Marvel Rivals',
        'Zenless Zone Zero',
        'Genshin Impact',
        'Escape from Tarkov'
    ];

    const DELAY_BETWEEN_ACTIONS_MS = 1500; // Задержка между кликами (для защиты от rate-limit)
    const MAX_ATTEMPTS = 50;               // Макс. попыток в одном проходе
    
    // =====================

    const log = (...args) => console.log('%c[TwitchDrops]', 'color: #9146FF; font-weight: bold;', ...args);
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    const normalize = (str) => (str || '').toLowerCase().trim();

    const isWhitelisted = (gameName, companyName) => {
        if (WHITELIST.length === 0) return true;
        const targets = WHITELIST.map(normalize);
        return targets.includes(normalize(gameName)) || targets.includes(normalize(companyName));
    };

    const getDropInfo = (headerBtn) => {
        const texts = headerBtn.querySelectorAll('p[class*="CoreText"]');
        return {
            game: texts[0]?.textContent || '',
            company: texts[1]?.textContent || '',
            button: headerBtn
        };
    };

    const processPage = async () => {
        log('Запуск обработки страницы...');
        let attempts = 0;

        const headers = document.querySelectorAll('div.accordion-header button[aria-expanded="false"]');
        for (const header of headers) {
            if (attempts++ > MAX_ATTEMPTS) break;
            const info = getDropInfo(header);

            if (isWhitelisted(info.game, info.company)) {
                log(`Раскрытие: ${info.game} (${info.company})`);
                header.click();
                await sleep(DELAY_BETWEEN_ACTIONS_MS);
            }
        }

        // Twitch использует data-a-target для интерактивных элементов
        const claimButtons = document.querySelectorAll('button[data-a-target="claim-drop-button"], button[data-a-target="DropsClaimButton"]');
        for (const btn of claimButtons) {
            if (attempts++ > MAX_ATTEMPTS) break;
            const closestAccordion = btn.closest('[role="region"]') || btn.closest('article');
            const info = closestAccordion ? getDropInfo(closestAccordion) : { game: 'Unknown', company: '' };

            if (isWhitelisted(info.game, info.company)) {
                log(`Кликаю "Получить": ${info.game}`);
                btn.click();
                await sleep(DELAY_BETWEEN_ACTIONS_MS);
            }
        }

        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
            if (attempts++ > MAX_ATTEMPTS) break;
            const txt = normalize(btn.textContent);
            if (txt === 'получить' || txt === 'claim') {
                log(`Кликаю "Получить" (по тексту): ${btn.textContent}`);
                btn.click();
                await sleep(DELAY_BETWEEN_ACTIONS_MS);
            }
        }

        log(`Проход завершён. Сделано действий: ${attempts}`);
    };

    setTimeout(async () => {
        await processPage();

        // MutationObserver для отслеживания подгрузки новых элементов (бесконечный скролл)
        const observer = new MutationObserver((mutations) => {
            const hasNewContent = mutations.some(m =>
                Array.from(m.addedNodes).some(n =>
                    n.nodeType === Node.ELEMENT_NODE &&
                    (n.matches?.('div.accordion-header, [role="region"]') || n.querySelector?.('div.accordion-header, [role="region"]'))
                )
            );
            if (hasNewContent) {
                clearTimeout(window.__twitchDropsDebounce);
                window.__twitchDropsDebounce = setTimeout(processPage, 2000);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('Observer активирован. Скрипт будет реагировать на новые дропы.');
    }, 3000);
})();