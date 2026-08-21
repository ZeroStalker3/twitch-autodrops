// ==UserScript==
// @name         Twitch Auto Farm Drops
// @namespace    https://github.com/ZeroStalker3/twitch-autodrops
// @version      2.3.0
// @description  Полная автоматизация фарма Twitch Drops: надежная логика, защита от ошибок, точный таймер
// @author       ZeroYz
// @match        *://*.twitch.tv/*
// @run-at       document-idle
// @license      MIT
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ===== КОНФИГ =====
    const LS_KEY = 'twitchAutoFarmConfig';
    const DEFAULT_CONFIG = {
        whitelist: ['Rust', 'Marvel Rivals', 'Zenless Zone Zero', 'Genshin Impact'],
        streamRotationMin: 0,
        checkIntervalSec: 30,
        minViewers: 50,
        autoStart: true,
        minimized: false,
        position: null,
        connectMode: 'notify',
        connectCooldownMin: 30,
        muted: true
    };
    
    const loadConfig = () => {
        try {
            return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    };
    
    
    let CONFIG = loadConfig();
    const saveConfig = () => localStorage.setItem(LS_KEY, JSON.stringify(CONFIG));

    const CAMPAIGNS_URL = 'https://www.twitch.tv/drops/campaigns';
    const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';

    const SS_STATE = 'taf_state_v3';
    const SS_RUN = 'taf_running';
    const LS_STATS = 'taf_stats';
    
    const freshFarm = () => ({
        phase: 'scan',
        queue: [],
        current: null,
        tried: {},
        done: [],
        lastScanTime: 0
    });
    
    let farm = (() => {
        try {
            const saved = JSON.parse(sessionStorage.getItem(SS_STATE) || '{}');
            return { ...freshFarm(), ...saved };
        } catch {
            return freshFarm();
        }
    })();
    
    if (!Array.isArray(farm.done)) farm.done = [];
    if (!Array.isArray(farm.queue)) farm.queue = [];
    
    const saveFarm = () => sessionStorage.setItem(SS_STATE, JSON.stringify(farm));
    
    let stats = (() => {
        try {
            return { claimed: 0, streams: 0, ...JSON.parse(localStorage.getItem(LS_STATS) || '{}') };
        } catch {
            return { claimed: 0, streams: 0 };
        }
    })();
    
    const saveStats = () => localStorage.setItem(LS_STATS, JSON.stringify(stats));
    
    const LS_DONE = 'taf_done_global';
    const DONE_TTL = 12 * 3600 * 1000;
    
    const doneGet = () => {
        try {
            return JSON.parse(localStorage.getItem(LS_DONE) || '{}');
        } catch {
            return {};
        }
    };
    
    const doneSet = (game) => {
        const d = doneGet();
        for (const k of Object.keys(d)) {
            if (Date.now() - d[k] > DONE_TTL) delete d[k];
        }
        d[game] = Date.now();
        localStorage.setItem(LS_DONE, JSON.stringify(d));
    };
    
    const isDoneGlobal = (game) => {
        const t = doneGet()[game];
        return !!t && Date.now() - t < DONE_TTL;
    };
    
    const isRunning = () => sessionStorage.getItem(SS_RUN) === '1';
    const go = (url) => { location.href = url; };

    const rt = {
        lastCheck: 0,
        setupDone: false,
        catChecked: false,
        stuck: 0,
        reloaded: false,
        domRemaining: null,
        domPct: null,
        prevSig: '',
        lastDec: 0,
        estRequired: 0,
        panelTried: false,
        loadAt: Date.now(),
        noDrop: 0,
        lastActivity: 0,
        countdownInterval: null,
        lastSync: 0,
        syncAttempts: 0
    };

    const notifiedConnections = new Set();

    // ===== GUI =====
    const style = document.createElement('style');
    style.textContent = `
        #Twitchy-autoclicker{position:fixed;top:20px;right:20px;width:420px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid #2d4059;border-radius:12px;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#fff;z-index:999999;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
        #Twitchy-header{background:linear-gradient(90deg,#5f3570 0%,#8e44ad 100%);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
        #Twitchy-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
        #Twitchy-logo{width:20px;height:20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px}
        #Twitchy-controls{display:flex;gap:8px}
        .Twitchy-btn{padding:6px 16px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .3s;text-transform:uppercase;letter-spacing:.5px}
        #Twitchy-toggle{background:#27ae60;color:#fff}
        #Twitchy-toggle:hover{background:#229954}
        #Twitchy-toggle.running{background:#e74c3c}
        #Twitchy-toggle.running:hover{background:#c0392b}
        #Twitchy-hide,#Twitchy-minimize,#Twitchy-settings{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);padding:6px 12px}
        #Twitchy-settings{padding:6px 10px;font-size:14px;line-height:1}
        #Twitchy-hide:hover,#Twitchy-minimize:hover,#Twitchy-settings:hover{background:rgba(255,255,255,.1)}
        #Twitchy-minimize{padding:6px 10px;font-size:16px;line-height:1}
        #Twitchy-content{padding:16px}
        #Twitchy-autoclicker.minimized #Twitchy-content,#Twitchy-autoclicker.minimized #Twitchy-footer{display:none}
        #Twitchy-status{background:rgba(255,255,255,.05);border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;text-align:center}
        #Twitchy-status-text{color:#95a5a6}
        #Twitchy-status-text.active{color:#2ecc71;font-weight:600}
        #Twitchy-uptime{font-size:11px;color:#95a5a6;margin-top:4px}
        #Twitchy-farm-status{background:rgba(155,89,182,.1);border:1px solid rgba(155,89,182,.3);border-radius:8px;padding:12px;margin-bottom:12px}
        #Twitchy-farm-status[hidden]{display:none}
        .Twitchy-farm-game{font-size:14px;font-weight:700;color:#9b59b6;margin-bottom:6px}
        .Twitchy-farm-stream{font-size:11px;color:#95a5a6;margin-bottom:8px;word-break:break-all}
        .Twitchy-farm-progress{background:rgba(0,0,0,.3);border-radius:4px;height:20px;overflow:hidden;margin-bottom:6px}
        .Twitchy-farm-progress-bar{background:linear-gradient(90deg,#9b59b6 0%,#8e44ad 100%);height:100%;transition:width .5s ease;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff}
        .Twitchy-farm-time{font-size:11px;color:#95a5a6;text-align:center}
        #Twitchy-queue{background:rgba(0,0,0,.2);border-radius:8px;padding:10px;margin-bottom:12px}
        #Twitchy-queue[hidden]{display:none}
        .Twitchy-queue-title{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
        .Twitchy-queue-item{font-size:11px;color:#95a5a6;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)}
        .Twitchy-queue-item:last-child{border-bottom:none}
        #Twitchy-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
        .Twitchy-stat{background:rgba(255,255,255,.05);border-radius:8px;padding:10px;text-align:center}
        .Twitchy-stat-label{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
        .Twitchy-stat-value{font-size:20px;font-weight:700;color:#fff}
        #Twitchy-connect{background:rgba(243,156,18,.08);border:1px solid rgba(243,156,18,.4);border-radius:8px;padding:10px 12px;margin-bottom:12px}
        #Twitchy-connect[hidden]{display:none}
        .Twitchy-connect-title{font-size:10px;color:#f39c12;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
        .Twitchy-connect-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;color:#f39c12}
        .Twitchy-connect-row a{color:#9b59b6;font-weight:600;text-decoration:none}
        #Twitchy-settings-panel{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;margin-bottom:12px}
        #Twitchy-settings-panel[hidden]{display:none}
        .Twitchy-field-label{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px;display:block}
        .Twitchy-field-label:first-child{margin-top:0}
        .Twitchy-input,.Twitchy-textarea{width:100%;box-sizing:border-box;background:rgba(0,0,0,.4);border:1px solid rgba(155,89,182,.3);border-radius:6px;color:#fff;padding:8px 10px;font:12px/1.4 'Consolas','Monaco',monospace}
        .Twitchy-textarea{resize:vertical;min-height:64px}
        .Twitchy-input:focus,.Twitchy-textarea:focus{outline:none;border-color:#9b59b6}
        #Twitchy-save{width:100%;margin-top:10px;background:#9b59b6;color:#fff}
        #Twitchy-save:hover{background:#8e44ad}
        #Twitchy-log{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;height:180px;overflow-y:auto;font-size:11px;font-family:'Consolas','Monaco',monospace}
        .Twitchy-log-entry{padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)}
        .Twitchy-log-entry:last-child{border-bottom:none}
        .Twitchy-log-time{color:#95a5a6;margin-right:8px}
        .Twitchy-log-success{color:#2ecc71}
        .Twitchy-log-info{color:#3498db}
        .Twitchy-log-warning{color:#f39c12}
        .Twitchy-log-system{color:#9b59b6}
        .Twitchy-log-farm{color:#e67e22}
        #Twitchy-footer{padding:12px 16px;background:rgba(0,0,0,.2);text-align:center;font-size:10px;color:#95a5a6}
        #Twitchy-footer a{color:#9b59b6;text-decoration:none}
        #Twitchy-log::-webkit-scrollbar{width:6px}
        #Twitchy-log::-webkit-scrollbar-thumb{background:rgba(155,89,182,.5);border-radius:3px}
        #Twitchy-fab{position:fixed;right:20px;bottom:20px;width:52px;height:52px;border:none;border-radius:50%;cursor:pointer;font-size:24px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:999999}
        #Twitchy-fab[hidden]{display:none}
        .Twitchy-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid #f39c12;border-radius:8px;padding:10px 16px;color:#fff;font:12px 'Consolas','Monaco',monospace;box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:9999999}
    `;

    const gui = document.createElement('div');
    gui.id = 'Twitchy-autoclicker';
    if (CONFIG.minimized) gui.classList.add('minimized');
    gui.innerHTML = `
        <div id="Twitchy-header">
            <div id="Twitchy-title"><div id="Twitchy-logo">🎁</div><span>Twitch AutoFarm</span></div>
            <div id="Twitchy-controls">
                <button id="Twitchy-toggle" class="Twitchy-btn">START</button>
                <button id="Twitchy-settings" class="Twitchy-btn" title="Settings">⚙</button>
                <button id="Twitchy-hide" class="Twitchy-btn">HIDE</button>
                <button id="Twitchy-minimize" class="Twitchy-btn">${CONFIG.minimized ? '+' : '−'}</button>
            </div>
        </div>
        <div id="Twitchy-content">
            <div id="Twitchy-status">
                <div id="Twitchy-status-text">Ready to start...</div>
                <div id="Twitchy-uptime">Uptime: 00:00:00</div>
            </div>
            <div id="Twitchy-farm-status" hidden>
                <div class="Twitchy-farm-game" id="Twitchy-farm-game">-</div>
                <div class="Twitchy-farm-stream" id="Twitchy-farm-stream">-</div>
                <div class="Twitchy-farm-progress"><div class="Twitchy-farm-progress-bar" id="Twitchy-farm-progress" style="width:0%">0%</div></div>
                <div class="Twitchy-farm-time" id="Twitchy-farm-time">Осталось: --:--:--</div>
            </div>
            <div id="Twitchy-queue" hidden><div class="Twitchy-queue-title">Очередь фарма</div><div id="Twitchy-queue-list"></div></div>
            <div id="Twitchy-stats">
                <div class="Twitchy-stat"><div class="Twitchy-stat-label">Drops Claimed</div><div class="Twitchy-stat-value" id="Twitchy-claimed">0</div></div>
                <div class="Twitchy-stat"><div class="Twitchy-stat-label">Streams Watched</div><div class="Twitchy-stat-value" id="Twitchy-streams">0</div></div>
            </div>
            <div id="Twitchy-connect" hidden></div>
            <div id="Twitchy-settings-panel" hidden>
                <label class="Twitchy-field-label">Whitelist (по одной на строку, пусто = все)</label>
                <textarea class="Twitchy-textarea" id="Twitchy-whitelist"></textarea>
                <label class="Twitchy-field-label">Ротация стримов (мин, 0 = выкл)</label>
                <input class="Twitchy-input" id="Twitchy-rotation" type="number" min="0" max="60" step="5">
                <label class="Twitchy-field-label">Проверка прогресса (сек)</label>
                <input class="Twitchy-input" id="Twitchy-check" type="number" min="10" max="120" step="10">
                <label class="Twitchy-field-label">Мин зрителей</label>
                <input class="Twitchy-input" id="Twitchy-viewers" type="number" min="0" max="10000" step="10">
                <label class="Twitchy-field-label">Режим подключения аккаунтов</label>
                <select class="Twitchy-input" id="Twitchy-connect-mode">
                    <option value="notify">Только уведомлять</option>
                    <option value="open">Открывать вкладку</option>
                    <option value="redirect">Перенаправлять</option>
                </select>
                <button id="Twitchy-save" class="Twitchy-btn">SAVE</button>
            </div>
            <div id="Twitchy-log"></div>
        </div>
        <div id="Twitchy-footer">Developed by <a href="https://github.com/ZeroStalker3" target="_blank" rel="noopener">ZeroYz</a></div>
    `;
    
    const fab = document.createElement('button');
    fab.id = 'Twitchy-fab';
    fab.textContent = '';
    fab.hidden = true;
    
    document.head.appendChild(style);
    document.body.appendChild(gui);
    document.body.appendChild(fab);
    
    if (CONFIG.position) {
        gui.style.top = CONFIG.position.top;
        gui.style.right = CONFIG.position.right;
    }

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const logBox = $('Twitchy-log');
    
    const LOG_TYPES = { system: 'system', info: 'info', claim: 'success', warn: 'warning', error: 'warning', farm: 'farm' };
    
    const log = (msg, type = 'info') => {
        const row = document.createElement('div');
        row.className = 'Twitchy-log-entry';
        row.innerHTML = `<span class="Twitchy-log-time">${new Date().toLocaleTimeString('ru-RU', { hour12: false })}</span><span class="Twitchy-log-${LOG_TYPES[type] || 'info'}">${esc(msg)}</span>`;
        logBox.appendChild(row);
        logBox.scrollTop = logBox.scrollHeight;
        while (logBox.children.length > 100) logBox.firstChild.remove();
        console.log('%c[TwitchFarm]', 'color:#9b59b6;font-weight:bold', msg);
    };
    
    const toast = (msg) => {
        const t = document.createElement('div');
        t.className = 'Twitchy-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    };
    
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (s) => (s || '').toLowerCase().trim();
    const fmtUptime = (s) => [s / 3600, s / 60 % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');

    const updateStats = () => {
        $('Twitchy-claimed').textContent = stats.claimed;
        $('Twitchy-streams').textContent = stats.streams;
    };
    
    const updateQueue = () => {
        $('Twitchy-queue').hidden = !farm.queue.length;
        $('Twitchy-queue-list').innerHTML = farm.queue.map(g => `<div class="Twitchy-queue-item">${esc(g.game)}</div>`).join('');
    };

    const updateFarmStatus = () => {
        const cur = farm.current;
        $('Twitchy-farm-status').hidden = !cur;
        if (!cur) return;
        
        $('Twitchy-farm-game').textContent = cur.game;
        $('Twitchy-farm-stream').textContent = cur.streamUrl || 'Поиск стрима...';
        
        let displayRem = rt.domRemaining;
        let displayPct = rt.domPct;

        if (rt.domRemaining != null && rt.lastSync > 0) {
            const elapsedMin = (Date.now() - rt.lastSync) / 60000;
            displayRem = Math.max(0, rt.domRemaining - elapsedMin);
            if (rt.estRequired > 0) {
                displayPct = Math.min(100, (1 - displayRem / rt.estRequired) * 100);
            }
        }

        let pct, remain;
        if (displayRem != null || displayPct != null) {
            const reqSec = (rt.estRequired || cur.watchTime / 60) * 60;
            remain = displayRem != null ? displayRem * 60 : Math.max(0, reqSec * (1 - (displayPct || 0) / 100));
            pct = displayPct != null ? displayPct : Math.max(0, Math.min(100, (1 - remain / reqSec) * 100));
        } else {
            const elapsed = cur.startedAt ? (Date.now() - cur.startedAt) / 1000 : 0;
            pct = Math.min(100, elapsed / cur.watchTime * 100);
            remain = Math.max(0, cur.watchTime - elapsed);
        }
        
        $('Twitchy-farm-progress').style.width = pct + '%';
        $('Twitchy-farm-progress').textContent = Math.floor(pct) + '%';
        $('Twitchy-farm-time').textContent = 'Осталось: ' + fmtUptime(Math.floor(remain));
    };

    const setRunning = (on) => {
        sessionStorage.setItem(SS_RUN, on ? '1' : '0');
        $('Twitchy-toggle').textContent = on ? 'STOP' : 'START';
        $('Twitchy-toggle').classList.toggle('running', on);
        $('Twitchy-status-text').textContent = on ? 'Running — farming drops' : 'Stopped';
        $('Twitchy-status-text').classList.toggle('active', on);
        log(on ? 'Started farming' : 'Stopped farming', 'system');
        if (on) setTimeout(tick, 500);
    };

    $('Twitchy-toggle').onclick = () => setRunning(!isRunning());
    
    $('Twitchy-minimize').onclick = () => {
        CONFIG.minimized = gui.classList.toggle('minimized');
        $('Twitchy-minimize').textContent = CONFIG.minimized ? '+' : '−';
        saveConfig();
    };
    
    $('Twitchy-hide').onclick = () => {
        gui.style.display = 'none';
        fab.hidden = false;
    };
    
    fab.onclick = () => {
        gui.style.display = '';
        fab.hidden = true;
    };
    
    $('Twitchy-settings').onclick = () => {
        const p = $('Twitchy-settings-panel');
        p.hidden = !p.hidden;
        if (!p.hidden) {
            $('Twitchy-whitelist').value = CONFIG.whitelist.join('\n');
            $('Twitchy-rotation').value = CONFIG.streamRotationMin;
            $('Twitchy-check').value = CONFIG.checkIntervalSec;
            $('Twitchy-viewers').value = CONFIG.minViewers;
            $('Twitchy-connect-mode').value = CONFIG.connectMode;
        }
    };
    
    $('Twitchy-save').onclick = () => {
        CONFIG.whitelist = $('Twitchy-whitelist').value.split('\n').map(s => s.trim()).filter(Boolean);
        CONFIG.streamRotationMin = Math.min(60, Math.max(0, parseInt($('Twitchy-rotation').value, 10) || 0));
        CONFIG.checkIntervalSec = Math.min(120, Math.max(10, parseInt($('Twitchy-check').value, 10) || 30));
        CONFIG.minViewers = Math.min(10000, Math.max(0, parseInt($('Twitchy-viewers').value, 10) || 0));
        CONFIG.connectMode = $('Twitchy-connect-mode').value;
        saveConfig();
        log('Settings saved', 'system');
        toast('💾 Настройки сохранены');
    };
    
    let drag = null;
    $('Twitchy-header').addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = gui.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        gui.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
        gui.style.right = Math.max(0, innerWidth - e.clientX - drag.dx) + 'px';
    });
    
    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        CONFIG.position = { top: gui.style.top, right: gui.style.right };
        saveConfig();
    });
    
    let uptime = 0;
    setInterval(() => {
        if (isRunning()) {
            $('Twitchy-uptime').textContent = 'Uptime: ' + fmtUptime(++uptime);
            updateFarmStatus();
        }
    }, 1000);

    const isWhitelisted = (game, company) => {
        if (!CONFIG.whitelist.length) return true;
        const g = norm(game);
        const c = norm(company);
        return CONFIG.whitelist.some((w) => {
            const nw = norm(w);
            if (!nw) return false;
            return (g && (g.includes(nw) || nw.includes(g))) || (c && (c.includes(nw) || nw.includes(c)));
        });
    };
    
    const getDropInfo = (btn) => {
        const t = btn.querySelectorAll('p[class*="CoreText"]');
        return { game: t[0]?.textContent || '', company: t[1]?.textContent || '' };
    };
    
    const RESERVED = ['directory', 'drops', 'videos', 'settings', 'downloads', 'prime', 'subscriptions', 'wallet', 'turbo', 'popout', 'p', 'jobs', 'store'];
    
    const isStreamPage = () => {
        const seg = location.pathname.split('/').filter(Boolean);
        return seg.length === 1 && !RESERVED.includes(seg[0]);
    };

    // ===== ПАРСИНГ ИНВЕНТАРЯ =====
    const parseInventory = () => {
        const campaigns = [];
        log('Парсинг инвентаря...', 'info');
        
        const campaignBlocks = document.querySelectorAll('.Layout-sc-1xcs6mc-0.hStHhY');
        log(`Найдено блоков кампаний: ${campaignBlocks.length}`, 'info');
        
        for (let i = 0; i < campaignBlocks.length; i++) {
            const block = campaignBlocks[i];
            
            const gameLink = block.querySelector('.CoreText-sc-1txzju1-0.jOVLCv a');
            const gameName = gameLink?.textContent?.trim() || '';
            
            if (!gameName) {
                log(`Блок ${i}: не найдено название`, 'warn');
                continue;
            }
            
            // Ищем категорию и конкретные каналы
            let categoryLink = block.querySelector('a[href*="/directory/category/"]');
            const hintText = block.querySelector('[data-test-selector="DropsCampaignInProgressDescription-hint-text-parent"]');
            
            // Извлекаем список конкретных каналов
            const specificChannels = [];
            if (hintText) {
                const allLinks = hintText.querySelectorAll('a[href]');
                for (const link of allLinks) {
                    const href = link.getAttribute('href');
                    // Ищем ссылки вида /channelname или https://www.twitch.tv/channelname
                    const match = href.match(/twitch\.tv\/([^?/]+)|\/([^?/]+)$/);
                    if (match) {
                        const channel = match[1] || match[2];
                        if (channel && !channel.includes('directory')) {
                            specificChannels.push(channel);
                        }
                    }
                }
            }
            
            if (!categoryLink) {
                log(`Блок ${i}: не найдена ссылка на категорию`, 'warn');
                continue;
            }
            
            const slugMatch = categoryLink.getAttribute('href').match(/category\/([^?/]+)/);
            if (!slugMatch) {
                log(`Блок ${i}: не найден slug`, 'warn');
                continue;
            }
            const slug = slugMatch[1];
            const slugName = slug.replace(/-/g, ' ');
            
            if (specificChannels.length > 0) {
                log(`Блок ${i}: найдено каналов: ${specificChannels.join(', ')}`, 'info');
            }
            
            // Whitelist
            if (!isWhitelisted(gameName, '') && !isWhitelisted(slugName, '')) {
                log(`Блок ${i}: ${gameName} (${slugName}) не в whitelist`, 'info');
                continue;
            }
            
            // Проверяем реальный прогресс вместо farm.done
            const progressBars = block.querySelectorAll('[role="progressbar"][aria-valuenow]');
            let targetRemMin = Infinity;
            let targetPct = 0;
            let foundActiveDrop = false;
            let allCompleted = true;
            
            log(`Блок ${i}: ${gameName} - прогресс-баров: ${progressBars.length}`, 'info');
            
            for (const bar of progressBars) {
                const pct = parseFloat(bar.getAttribute('aria-valuenow') || '0');
                const textEl = bar.parentElement?.querySelector('.CoreText-sc-1txzju1-0.hrFpku');
                const text = textEl?.textContent || '';
                
                log(`  Прогресс: ${pct}% - ${text}`, 'info');
                
                const timeMatch = text.match(/от\s+(\d+)\s*(часа|час|минут|мин)/i);
                if (timeMatch) {
                    const total = parseInt(timeMatch[1], 10);
                    const unit = timeMatch[2].toLowerCase();
                    const totalMin = unit.startsWith('час') ? total * 60 : total;
                    const remainingMin = totalMin * (1 - pct / 100);
                    
                    log(`    Время: ${totalMin} мин, осталось: ${remainingMin.toFixed(1)} мин`, 'info');
                    
                    if (pct < 100 && remainingMin > 0) {
                        foundActiveDrop = true;
                        allCompleted = false;
                        if (remainingMin < targetRemMin) {
                            targetRemMin = remainingMin;
                            targetPct = pct;
                        }
                    } else if (pct >= 100) {
                        // Этот дроп завершен, но могут быть другие
                    }
                }
            }
            
            if (allCompleted) {
                log(`Блок ${i}: ${gameName} - все дропы завершены`, 'info');
                continue;
            }
            
            if (foundActiveDrop && targetRemMin !== Infinity) {
                campaigns.push({
                    game: gameName,
                    slug,
                    channels: specificChannels, // Добавляем список каналов
                    watchTime: targetRemMin * 60,
                    currentPct: targetPct,
                    remainingMin: targetRemMin
                });
                const channelsInfo = specificChannels.length ? `, каналы: ${specificChannels.join(', ')}` : '';
                log(`  ✅ ДОБАВЛЕНО: ${gameName}, ${slug}, ${targetPct}%, осталось ${targetRemMin.toFixed(1)} мин${channelsInfo}`, 'success');
            } else if (!foundActiveDrop) {
                log(`Блок ${i}: не найдено активного времени`, 'warn');
            }
        }
        
        log(`Всего найдено активных кампаний: ${campaigns.length}`, 'info');
        return campaigns;
    };

    // ===== ФАЗА: INVENTORY (НОВАЯ) =====
    const onInventoryPhase = async () => {
        log('Проверка инвентаря...', 'farm');
        await sleep(2000);
        
        const campaigns = parseInventory();
        
        if (campaigns.length > 0) {
            log(`Найдено активных дропов в инвентаре: ${campaigns.length}`, 'farm');
            farm.queue = campaigns;
            farm.tried = {};
            farm.phase = 'dir';
            saveFarm();
            updateQueue();
            nextFromQueue();
        } else {
            log('Нет активных дропов в инвентаре, сканирую кампании...', 'info');
            go(CAMPAIGNS_URL);
        }
    };

    const checkActiveDrops = () => {
        const watchSection = [...document.querySelectorAll('p')].find(p => 
            /^(смотреть|watch) drops$/i.test((p.textContent || '').trim())
        );
        
        if (!watchSection) {
            return { hasWatchDrops: false, rem: null, pct: null, claimReady: false };
        }
        
        // Проверяем наличие кнопки "Получить"
        const claimBtn = [...document.querySelectorAll('[data-a-target="tw-core-button-label-text"]')]
            .find(el => /получить|claim/i.test(el.textContent || ''));
        
        if (claimBtn) {
            return { hasWatchDrops: true, rem: 0, pct: 100, claimReady: true };
        }
        
        const dropCard = [...document.querySelectorAll('p[title]')].find(p => {
            const title = p.title || '';
            return /чтобы получить|to earn|to receive/i.test(title) &&
                   /(?:ещё\s+)?смотрите\s+\d+|watch\s+\d+/i.test(title);
        });
        
        if (!dropCard) {
            return { hasWatchDrops: false, rem: null, pct: null, claimReady: false };
        }
        
        const title = dropCard.title || dropCard.textContent;
        let rem = null;
        let m = title.match(/(\d+)\s*(?:час|ч\.?)\s*(\d+)\s*мин/i);
        if (m) {
            rem = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        } else {
            m = title.match(/(?:ещё\s+)?(\d+)\s*(минут|мин|часов|часа|час|ч\.?)/i);
            if (m) {
                const v = parseInt(m[1], 10);
                rem = /час|hour|h/i.test(m[2]) && !/min|мин/i.test(m[2]) ? v * 60 : v;
            }
        }
        
        let pct = null;
        let el = dropCard;
        for (let i = 0; i < 6 && el; i++) {
            el = el.parentElement;
            const bar = el?.querySelector('[role="progressbar"][aria-valuenow]');
            if (bar) {
                pct = parseFloat(bar.getAttribute('aria-valuenow'));
                break;
            }
        }
        
        return { hasWatchDrops: true, rem, pct, claimReady: false };
    };

    const ensureDropsPanel = () => {
        const body = document.body.textContent || '';
        const isOpen = /drops и прочее|drops and more|drops для подписки/i.test(body);
        
        if (isOpen) return true; 
        
        const btn = document.querySelector('[data-a-target="drops-overlay-button"], button[aria-label*="drops" i], button[aria-label*="дроп" i]');
        if (btn) {
            btn.click();
            log('Панель Drops открыта', 'info');
            return true;
        }
        
        log('Кнопка Drops не найдена', 'warn');
        return false;
    };

    let scanBusy = false;
    const onCampaigns = async () => {
        if (scanBusy || Date.now() - farm.lastScanTime < 60000) return;
        farm.lastScanTime = Date.now();
        scanBusy = true;
        
        try {
            log('Сканирование кампаний...', 'farm');
            await sleep(3000);
            
            for (const btn of document.querySelectorAll('div.accordion-header button[aria-expanded="false"]')) {
                const info = getDropInfo(btn);
                if (!isWhitelisted(info.game, info.company)) continue;
                if (farm.done.includes(info.game) || isDoneGlobal(info.game)) continue;
                
                btn.click();
                await sleep(1500);
            }
            
            await sleep(2000);
            
            const drops = [];
            for (const head of document.querySelectorAll('div.accordion-header')) {
                const btn = head.querySelector('button');
                if (btn?.getAttribute('aria-expanded') !== 'true') continue;
                
                const info = getDropInfo(btn);
                if (!isWhitelisted(info.game, info.company)) continue;
                if (farm.done.includes(info.game) || isDoneGlobal(info.game)) continue;
                
                const root = head.parentElement;
                const link = root.querySelector('a[href*="/directory/category/"]');
                if (!link) continue;
                
                const tm = root.textContent.match(/(?:в течение|for)\s+(\d+)\s*(час|минут|hour|minute)/i);
                const watchTime = tm ? (+tm[1]) * (/мин|minute/i.test(tm[2]) ? 60 : 3600) : 3600;
                const slug = (link.getAttribute('href').match(/category\/([^?/]+)/) || [])[1];
                
                if (slug) {
                    drops.push({ game: info.game, slug, watchTime });
                }
            }
            
            if (!drops.length) {
                log('Нет активных дропов для фарма', 'info');
                setTimeout(() => {
                    if (isRunning()) go(INVENTORY_URL);
                }, 60000);
                return;
            }
            
            log(`Найдено дропов: ${drops.length} (${drops.map(d => d.game).join(', ')})`, 'farm');
            farm.queue = drops;
            farm.tried = {};
            farm.phase = 'dir';
            saveFarm();
            updateQueue();
            nextFromQueue();
        } finally {
            scanBusy = false;
        }
    };

    const nextFromQueue = () => {
        const next = farm.queue.shift();
        updateQueue();
        
        if (!next) {
            farm.phase = 'scan';
            farm.current = null;
            saveFarm();
            updateFarmStatus();
            log('Очередь пуста — проверка инвентаря', 'system');
            go(INVENTORY_URL);
            return;
        }
        
        farm.current = { ...next, streamUrl: null, startedAt: null };
        farm.phase = 'dir';
        saveFarm();
        updateFarmStatus();
        go(`https://www.twitch.tv/directory/category/${next.slug}?filter=drops`);
    };

    const parseViewers = (card) => {
        const el = [...card.querySelectorAll('span,div,p')].find(e => 
            /зрител|viewer/i.test(e.textContent) && e.textContent.length < 40
        );
        if (!el) return 0;
        
        const m = el.textContent.match(/([\d.,]+)\s*(тыс\.?|K|млн\.?|M)?/i);
        if (!m) return 0;
        
        let v = parseFloat(m[1].replace(',', '.'));
        const u = (m[2] || '').toLowerCase();
        if (u.startsWith('тыс') || u === 'k') v *= 1e3;
        if (u.startsWith('млн') || u === 'm') v *= 1e6;
        return v;
    };
    
    const parseStreams = (preferredChannels = []) => {
        const scope = document.querySelector('main') || document;
        const out = [];
        const seen = new Set();
        
        // Если есть предпочтительные каналы, ищем их в первую очередь
        if (preferredChannels.length > 0) {
            for (const channel of preferredChannels) {
                if (seen.has(channel)) continue;
                
                // Ищем карточку канала
                const channelLink = scope.querySelector(`a[href="/${channel}"]`);
                if (channelLink) {
                    const card = channelLink.closest('article') || channelLink.parentElement?.parentElement;
                    if (card && card.querySelector('img, video')) {
                        seen.add(channel);
                        const viewers = parseViewers(card);
                        out.push({ url: `https://www.twitch.tv/${channel}`, viewers, isPreferred: true });
                    }
                }
            }
        }
        
        // Ищем остальные стримы
        for (const a of scope.querySelectorAll('a[href]')) {
            if (a.closest('nav,aside,footer,[data-a-target="side-nav"]')) continue;
            
            const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{3,25})\/?$/);
            if (!m) continue;
            
            const slug = m[1];
            if (RESERVED.includes(slug) || seen.has(slug)) continue;
            
            const card = a.closest('article') || a.parentElement?.parentElement;
            if (!card || !card.querySelector('img, video')) continue;
            
            seen.add(slug);
            out.push({ url: 'https://www.twitch.tv/' + slug, viewers: parseViewers(card), isPreferred: false });
        }
        
        // Сортируем: сначала предпочтительные каналы, потом по зрителям
        return out.sort((a, b) => {
            if (a.isPreferred && !b.isPreferred) return -1;
            if (!a.isPreferred && b.isPreferred) return 1;
            return b.viewers - a.viewers;
        });
    };
    
    const onDirectory = async () => {
        if (!farm.current) {
            farm.phase = 'scan';
            saveFarm();
            go(INVENTORY_URL);
            return;
        }
        
        log(`Поиск стримов: ${farm.current.game}`, 'farm');
        
        const channels = farm.current.channels || [];
        
        for (let i = 0; i < 6 && !parseStreams(channels).length; i++) {
            await sleep(2000);
        }
        
        let streams = parseStreams(channels);
        const withV = streams.filter(s => s.viewers > 0);
        if (withV.length) streams = withV.filter(s => s.viewers >= CONFIG.minViewers);
        
        const tried = farm.tried[farm.current.game] || (farm.tried[farm.current.game] = []);
        const pick = streams.find(s => !tried.includes(s.url));
        
        if (!pick) {
            log(`Нет доступных стримов для ${farm.current.game}`, 'warn');
            nextFromQueue();
            return;
        }
        
        tried.push(pick.url);
        farm.current.streamUrl = pick.url;
        farm.current.startedAt = Date.now();
        farm.phase = 'watch';
        saveFarm();
        
        stats.streams++;
        saveStats();
        updateStats();
        
        log(`Переход на стрим: ${pick.url} (${pick.viewers} зрит.)`, 'farm');
        go(pick.url);
    };

    const rotate = (reason) => {
        if (rt.countdownInterval) {
            clearInterval(rt.countdownInterval);
            rt.countdownInterval = null;
        }
        log(`Ротация: ${reason}`, 'warn');
        farm.phase = 'dir';
        farm.current.streamUrl = null;
        farm.current.startedAt = null;
        saveFarm();
        updateFarmStatus();
        go(`https://www.twitch.tv/directory/category/${farm.current.slug}?filter=drops`);
    };

    const finishWatch = () => {
        if (rt.countdownInterval) {
            clearInterval(rt.countdownInterval);
            rt.countdownInterval = null;
        }
        
        if (farm.current && !farm.done.includes(farm.current.game)) {
            farm.done.push(farm.current.game);
        }
        if (farm.current) doneSet(farm.current.game);
        
        saveFarm();
        log('Дроп завершён — идём за наградой', 'claim');
        farm.phase = 'claim';
        saveFarm();
        go(INVENTORY_URL);
    };

    const onStream = async () => {
        const cur = farm.current;
        if (!cur || farm.phase !== 'watch') {
            farm.phase = 'scan';
            farm.current = null;
            saveFarm();
            go(INVENTORY_URL);
            return;
        }

        if (!rt.setupDone) {
            rt.setupDone = true;
            await sleep(2500);
            
            const video = document.querySelector('video');
            if (video) {
                video.muted = CONFIG.muted;
                video.play().catch(() => {});
            }
            
            const overlay = document.querySelector('button[aria-label*="Play" i], [data-a-target="player-overlay-click-handler"]');
            if (overlay && (!video || !video.currentTime)) overlay.click();
            
            log(`Просмотр: ${cur.game}`, 'farm');
            
            await sleep(1000);
            ensureDropsPanel();
            await sleep(1000);
            await sleep(1500); 
            
            const drops = checkActiveDrops();
            
            if (!drops.hasWatchDrops) {
                log(`Нет watch-дропов для ${cur.game} — проверяю...`, 'warn');
                rt.noDrop = 1;
                rt.syncAttempts = 0;
            } else {
                rt.domRemaining = drops.rem;
                rt.domPct = drops.pct;
                if (!rt.estRequired && cur.startedAt && drops.rem != null) {
                    rt.estRequired = drops.rem + (Date.now() - cur.startedAt) / 60000;
                }
                rt.lastSync = Date.now();
                log(`Начальный прогресс ${cur.game}: ${drops.pct != null ? Math.round(drops.pct) + '%, ' : ''}ещё ${drops.rem} мин`, 'farm');
            }
            
            if (!rt.countdownInterval) {
                rt.countdownInterval = setInterval(() => {
                    if (rt.domRemaining != null) updateFarmStatus();
                }, 1000);
            }
        }

        if (!rt.catChecked) {
            rt.catChecked = true;
            const scope = document.querySelector('main') || document;
            const cat = scope.querySelector('a[href^="/directory/"]');
            const catSlug = cat?.getAttribute('href')?.match(/\/directory\/(?:category|game)\/([^?/]+)/)?.[1];
            if (catSlug && cur.slug && catSlug !== cur.slug) {
                return rotate(`категория ${catSlug} != ${cur.slug}`);
            }
        }

        if (document.querySelector('[data-a-target="offline-screen-text"], .offline-recommendation-video')) {
            return rotate('стрим офлайн');
        }

        const video = document.querySelector('video');
        if (video && !document.hidden) {
            if (video.paused || video.ended) {
                video.play().catch(() => {});
            }
            if (video.readyState <= 2) {
                rt.stuck++;
                if (rt.stuck >= 20) {
                    rt.stuck = 0;
                    if (!rt.reloaded) {
                        rt.reloaded = true;
                        log('Плеер завис — перезагрузка страницы', 'warn');
                        location.reload();
                    } else {
                        return rotate('плеер не играет');
                    }
                }
            } else {
                rt.stuck = 0;
            }
        } else if (document.hidden) {
            rt.stuck = 0;
        }

        if (CONFIG.streamRotationMin > 0 && cur.startedAt && (Date.now() - cur.startedAt) / 60000 >= CONFIG.streamRotationMin) {
            return rotate('плановая ротация');
        }

        if (Date.now() - rt.lastCheck > 10000) {
            rt.lastCheck = Date.now();
            const now = Date.now();
            const needSync = now - rt.lastSync > 120000 || rt.domRemaining === null || rt.domRemaining <= 1;
            
            if (needSync) {
                rt.panelTried = false;
                ensureDropsPanel();
                await sleep(1000); 
                const drops = checkActiveDrops();
                rt.lastSync = now;
                
                if (!drops.hasWatchDrops) {
                    rt.syncAttempts = (rt.syncAttempts || 0) + 1;
                    log(`Нет watch-дропов (попытка ${rt.syncAttempts})`, 'warn');
                    
                    if (rt.syncAttempts >= 3) {
                        log(`Нет watch-дропов для ${cur.game} — пропускаю`, 'warn');
                        if (!farm.done.includes(cur.game)) {
                            farm.done.push(cur.game);
                            saveFarm();
                        }
                        doneSet(cur.game);
                        nextFromQueue();
                        return;
                    }
                } else {
                    rt.syncAttempts = 0;
                    rt.domRemaining = drops.rem;
                    rt.domPct = drops.pct;
                    
                    if (drops.pct != null && drops.pct > 0 && drops.rem != null) {
                        rt.estRequired = drops.rem / (1 - drops.pct / 100);
                    }
                    
                    const sig = `${Math.round(drops.pct || 0)}|${drops.rem}`;
                    if (sig !== rt.prevSig) {
                        rt.prevSig = sig;
                        rt.lastDec = Date.now();
                        log(`Синхронизация ${cur.game}: ${drops.pct != null ? Math.round(drops.pct) + '%, ' : ''}ещё ${drops.rem} мин`, 'farm');
                    }
                    
                    if ((drops.rem != null && drops.rem <= 0) || (drops.pct != null && drops.pct >= 100)) {
                        return finishWatch();
                    }
                }
            }
        }
        
        if (!rt.lastActivity || Date.now() - rt.lastActivity > 180000) {
            rt.lastActivity = Date.now();
            
            const video = document.querySelector('video');
            if (video) {
                const rect = video.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                
                video.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                }));
                
                video.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                video.focus({ preventScroll: true });
                
                if (!video.paused) {
                    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
                }
                
                log('Активность эмулирована', 'info');
            }
        }
    };

    const onInventory = async () => {
        log('Проверка инвентаря...', 'farm');
        await sleep(2000);

        // СНАЧАЛА проверяем активные дропы в инвентаре
        const campaigns = parseInventory();
        
        if (campaigns.length > 0) {
            log(`Найдено активных дропов: ${campaigns.length}`, 'farm');
            farm.queue = campaigns;
            farm.tried = {};
            farm.phase = 'dir';
            saveFarm();
            updateQueue();
            nextFromQueue();
            return;
        }

        // Если активных нет, проверяем наград для получения
        log('Нет активных дропов, проверяю награды...', 'info');
        await sleep(1000);

        const btns = [
            ...document.querySelectorAll('button[data-a-target="claim-drop-button"], button[data-a-target="DropsClaimButton"]'),
            ...[...document.querySelectorAll('button')].filter(b => ['получить', 'claim'].includes(norm(b.textContent)))
        ];
        
        let n = 0;
        for (const b of btns) {
            b.click();
            n++;
            stats.claimed++;
            await sleep(1200);
        }
        
        saveStats();
        updateStats();
        
        if (n) {
            log(`Получено наград: ${n}`, 'claim');
            toast(`🎁 Получено наград: ${n}`);
        }
        
        // После клейма идем на кампании
        log('Перехожу на страницу кампаний...', 'info');
        setTimeout(() => go(CAMPAIGNS_URL), 2000);
    };

    let tickBusy = false;
    const tick = async () => {
        if (!isRunning() || tickBusy) return;
        tickBusy = true;
        
        try {
            const p = location.pathname;
            
            if (p.startsWith('/drops/campaigns')) {
                await onCampaigns();
            } else if (p.startsWith('/drops/inventory')) {
                await onInventory();
            } else if (p.startsWith('/directory/')) {
                await onDirectory();
            } else if (isStreamPage()) {
                await onStream();
            } else if (farm.phase === 'watch' && farm.current?.streamUrl) {
                go(farm.current.streamUrl);
            } else if (farm.phase === 'claim') {
                go(INVENTORY_URL);
            } else {
                go(INVENTORY_URL);
            }
        } catch (e) {
            log('Error: ' + e.message, 'error');
        } finally {
            tickBusy = false;
        }
    };

    const hookHistory = () => {
        const wrap = (fn) => function (...args) {
            const r = fn.apply(this, args);
            setTimeout(tick, 500);
            return r;
        };
        try {
            history.pushState = wrap(history.pushState);
            history.replaceState = wrap(history.replaceState);
        } catch { }
        window.addEventListener('popstate', () => setTimeout(tick, 500));
    };

    updateStats();
    updateQueue();
    updateFarmStatus();
    log('System loaded', 'system');
    
    hookHistory();
    
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && isRunning() && farm.phase === 'watch') {
            const video = document.querySelector('video');
            if (video && (video.paused || video.ended)) {
                log('Вкладка активна - возобновляем воспроизведение', 'info');
                video.play().catch(() => {});
            }
            rt.stuck = 0;
            rt.reloaded = false;
            updateFarmStatus();
        }
    });
    
    setInterval(tick, 15000);

    if (isRunning()) {
        $('Twitchy-toggle').textContent = 'STOP';
        $('Twitchy-toggle').classList.add('running');
        $('Twitchy-status-text').textContent = 'Running — farming drops';
        $('Twitchy-status-text').classList.add('active');
        setTimeout(tick, 2500);
    } else if (CONFIG.autoStart) {
        setRunning(true);
    }
})();