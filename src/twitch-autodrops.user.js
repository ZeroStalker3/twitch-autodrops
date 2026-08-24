// ==UserScript==
// @name         Twitch Auto Farm Drops
// @namespace    https://github.com/ZeroStalker3/twitch-autodrops
// @version      2.5.0
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
        minimized: false,
        position: null,
        connectMode: 'notify',
        connectCooldownMin: 30,
        muted: true,
        autoStart: false
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

    // ===== GUI (переименованный в TAF) =====
    const style = document.createElement('style');
    style.textContent = `
        #TAF-panel{position:fixed;top:20px;left:20px;width:420px;background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);border:1px solid #2d4059;border-radius:12px;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#fff;z-index:999998;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
        #TAF-header{background:linear-gradient(90deg,#e94560 0%,#c73e54 100%);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
        #TAF-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
        #TAF-logo{width:20px;height:20px;background:linear-gradient(135deg,#e94560 0%,#f27121 100%);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px}
        #TAF-controls{display:flex;gap:8px}
        .TAF-btn{padding:6px 16px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .3s;text-transform:uppercase;letter-spacing:.5px}
        #TAF-toggle{background:#27ae60;color:#fff}
        #TAF-toggle:hover{background:#229954}
        #TAF-toggle.running{background:#e74c3c}
        #TAF-toggle.running:hover{background:#c0392b}
        #TAF-hide,#TAF-minimize,#TAF-settings{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);padding:6px 12px}
        #TAF-settings{padding:6px 10px;font-size:14px;line-height:1}
        #TAF-hide:hover,#TAF-minimize:hover,#TAF-settings:hover{background:rgba(255,255,255,.1)}
        #TAF-minimize{padding:6px 10px;font-size:16px;line-height:1}
        #TAF-content{padding:16px}
        #TAF-panel.minimized #TAF-content,#TAF-panel.minimized #TAF-footer{display:none}
        #TAF-status{background:rgba(255,255,255,.05);border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;text-align:center}
        #TAF-status-text{color:#95a5a6}
        #TAF-status-text.active{color:#2ecc71;font-weight:600}
        #TAF-uptime{font-size:11px;color:#95a5a6;margin-top:4px}
        #TAF-farm-status{background:rgba(233,69,96,.1);border:1px solid rgba(233,69,96,.3);border-radius:8px;padding:12px;margin-bottom:12px}
        #TAF-farm-status[hidden]{display:none}
        .TAF-farm-game{font-size:14px;font-weight:700;color:#e94560;margin-bottom:6px}
        .TAF-farm-stream{font-size:11px;color:#95a5a6;margin-bottom:8px;word-break:break-all}
        .TAF-farm-progress{background:rgba(0,0,0,.3);border-radius:4px;height:20px;overflow:hidden;margin-bottom:6px}
        .TAF-farm-progress-bar{background:linear-gradient(90deg,#e94560 0%,#f27121 100%);height:100%;transition:width .5s ease;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff}
        .TAF-farm-time{font-size:11px;color:#95a5a6;text-align:center}
        #TAF-queue{background:rgba(0,0,0,.2);border-radius:8px;padding:10px;margin-bottom:12px}
        #TAF-queue[hidden]{display:none}
        .TAF-queue-title{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
        .TAF-queue-item{font-size:11px;color:#95a5a6;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)}
        .TAF-queue-item:last-child{border-bottom:none}
        #TAF-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
        .TAF-stat{background:rgba(255,255,255,.05);border-radius:8px;padding:10px;text-align:center}
        .TAF-stat-label{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
        .TAF-stat-value{font-size:20px;font-weight:700;color:#fff}
        #TAF-connect{background:rgba(243,156,18,.08);border:1px solid rgba(243,156,18,.4);border-radius:8px;padding:10px 12px;margin-bottom:12px}
        #TAF-connect[hidden]{display:none}
        .TAF-connect-title{font-size:10px;color:#f39c12;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
        .TAF-connect-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;color:#f39c12}
        .TAF-connect-row a{color:#e94560;font-weight:600;text-decoration:none}
        #TAF-settings-panel{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;margin-bottom:12px}
        #TAF-settings-panel[hidden]{display:none}
        .TAF-field-label{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px;display:block}
        .TAF-field-label:first-child{margin-top:0}
        .TAF-input,.TAF-textarea{width:100%;box-sizing:border-box;background:rgba(0,0,0,.4);border:1px solid rgba(233,69,96,.3);border-radius:6px;color:#fff;padding:8px 10px;font:12px/1.4 'Consolas','Monaco',monospace}
        .TAF-textarea{resize:vertical;min-height:64px}
        .TAF-input:focus,.TAF-textarea:focus{outline:none;border-color:#e94560}
        #TAF-save{width:100%;margin-top:10px;background:#e94560;color:#fff}
        #TAF-save:hover{background:#c73e54}
        #TAF-log{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;height:180px;overflow-y:auto;font-size:11px;font-family:'Consolas','Monaco',monospace}
        .TAF-log-entry{padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)}
        .TAF-log-entry:last-child{border-bottom:none}
        .TAF-log-time{color:#95a5a6;margin-right:8px}
        .TAF-log-success{color:#2ecc71}
        .TAF-log-info{color:#3498db}
        .TAF-log-warning{color:#f39c12}
        .TAF-log-system{color:#e94560}
        .TAF-log-farm{color:#e67e22}
        #TAF-footer{padding:12px 16px;background:rgba(0,0,0,.2);text-align:center;font-size:10px;color:#95a5a6}
        #TAF-footer a{color:#e94560;text-decoration:none}
        #TAF-log::-webkit-scrollbar{width:6px}
        #TAF-log::-webkit-scrollbar-thumb{background:rgba(233,69,96,.5);border-radius:3px}
        #TAF-fab{position:fixed;left:20px;bottom:20px;width:52px;height:52px;border:none;border-radius:50%;cursor:pointer;font-size:24px;background:linear-gradient(135deg,#e94560 0%,#f27121 100%);box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:999998}
        #TAF-fab[hidden]{display:none}
        .TAF-toast{position:fixed;top:80px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);border:1px solid #e94560;border-radius:8px;padding:10px 16px;color:#fff;font:12px 'Consolas','Monaco',monospace;box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:9999999}
    `;

    const gui = document.createElement('div');
    gui.id = 'TAF-panel';
    if (CONFIG.minimized) gui.classList.add('minimized');
    gui.innerHTML = `
        <div id="TAF-header">
            <div id="TAF-title"><div id="TAF-logo">🎁</div><span>Twitch Drops Farm</span></div>
            <div id="TAF-controls">
                <button id="TAF-toggle" class="TAF-btn">START</button>
                <button id="TAF-settings" class="TAF-btn" title="Settings">⚙</button>
                <button id="TAF-hide" class="TAF-btn">HIDE</button>
                <button id="TAF-minimize" class="TAF-btn">${CONFIG.minimized ? '+' : '−'}</button>
            </div>
        </div>
        <div id="TAF-content">
            <div id="TAF-status">
                <div id="TAF-status-text">Ready to start...</div>
                <div id="TAF-uptime">Uptime: 00:00:00</div>
            </div>
            <div id="TAF-farm-status" hidden>
                <div class="TAF-farm-game" id="TAF-farm-game">-</div>
                <div class="TAF-farm-stream" id="TAF-farm-stream">-</div>
                <div class="TAF-farm-progress"><div class="TAF-farm-progress-bar" id="TAF-farm-progress" style="width:0%">0%</div></div>
                <div class="TAF-farm-time" id="TAF-farm-time">Осталось: --:--:--</div>
            </div>
            <div id="TAF-queue" hidden><div class="TAF-queue-title">Очередь фарма</div><div id="TAF-queue-list"></div></div>
            <div id="TAF-stats">
                <div class="TAF-stat"><div class="TAF-stat-label">Drops Claimed</div><div class="TAF-stat-value" id="TAF-claimed">0</div></div>
                <div class="TAF-stat"><div class="TAF-stat-label">Streams Watched</div><div class="TAF-stat-value" id="TAF-streams">0</div></div>
            </div>
            <div id="TAF-connect" hidden></div>
            <div id="TAF-settings-panel" hidden>
                <label class="TAF-field-label">Whitelist (по одной на строку, пусто = все)</label>
                <textarea class="TAF-textarea" id="TAF-whitelist"></textarea>
                <label class="TAF-field-label">Ротация стримов (мин, 0 = выкл)</label>
                <input class="TAF-input" id="TAF-rotation" type="number" min="0" max="60" step="5">
                <label class="TAF-field-label">Проверка прогресса (сек)</label>
                <input class="TAF-input" id="TAF-check" type="number" min="10" max="120" step="10">
                <label class="TAF-field-label">Мин зрителей</label>
                <input class="TAF-input" id="TAF-viewers" type="number" min="0" max="10000" step="10">
                <label class="TAF-field-label">Режим подключения аккаунтов</label>
                <select class="TAF-input" id="TAF-connect-mode">
                    <option value="notify">Только уведомлять</option>
                    <option value="open">Открывать вкладку</option>
                    <option value="redirect">Перенаправлять</option>
                </select>
                <label class="TAF-field-label">Автостарт при загрузке (после первой настройки)</label>
                <select class="TAF-input" id="TAF-autostart">
                    <option value="0">Выкл — запуск только кнопкой START</option>
                    <option value="1">Вкл — стартовать сам после настройки</option>
                </select>
                <button id="TAF-save" class="TAF-btn">SAVE</button>
            </div>
            <div id="TAF-log"></div>
        </div>
        <div id="TAF-footer">Developed by <a href="https://github.com/ZeroStalker3" target="_blank" rel="noopener">ZeroYz</a></div>
    `;
    
    const fab = document.createElement('button');
    fab.id = 'TAF-fab';
    fab.textContent = '🎁';
    fab.hidden = true;
    
    document.head.appendChild(style);
    document.body.appendChild(gui);
    document.body.appendChild(fab);
    
    if (CONFIG.position) {
        gui.style.top = CONFIG.position.top;
        gui.style.left = CONFIG.position.left;
    }

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const logBox = $('TAF-log');
    
    const LOG_TYPES = { system: 'system', info: 'info', claim: 'success', warn: 'warning', error: 'warning', farm: 'farm' };
    
    const log = (msg, type = 'info') => {
        const row = document.createElement('div');
        row.className = 'TAF-log-entry';
        row.innerHTML = `<span class="TAF-log-time">${new Date().toLocaleTimeString('ru-RU', { hour12: false })}</span><span class="TAF-log-${LOG_TYPES[type] || 'info'}">${esc(msg)}</span>`;
        logBox.appendChild(row);
        logBox.scrollTop = logBox.scrollHeight;
        while (logBox.children.length > 100) logBox.firstChild.remove();
        console.log('%c[TAF]', 'color:#e94560;font-weight:bold', msg);
    };
    
    const toast = (msg) => {
        const t = document.createElement('div');
        t.className = 'TAF-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    };
    
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (s) => (s || '').toLowerCase().trim();
    const fmtUptime = (s) => [s / 3600, s / 60 % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');

    const updateStats = () => {
        $('TAF-claimed').textContent = stats.claimed;
        $('TAF-streams').textContent = stats.streams;
    };
    
    const updateQueue = () => {
        $('TAF-queue').hidden = !farm.queue.length;
        $('TAF-queue-list').innerHTML = farm.queue.map(g => `<div class="TAF-queue-item">${esc(g.game)}</div>`).join('');
    };

    const updateFarmStatus = () => {
        const cur = farm.current;
        $('TAF-farm-status').hidden = !cur;
        if (!cur) return;
        
        $('TAF-farm-game').textContent = cur.game;
        $('TAF-farm-stream').textContent = cur.streamUrl || 'Поиск стрима...';
        
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
        
        $('TAF-farm-progress').style.width = pct + '%';
        $('TAF-farm-progress').textContent = Math.floor(pct) + '%';
        $('TAF-farm-time').textContent = 'Осталось: ' + fmtUptime(Math.floor(remain));
    };

    const setRunning = (on) => {
        sessionStorage.setItem(SS_RUN, on ? '1' : '0');
        $('TAF-toggle').textContent = on ? 'STOP' : 'START';
        $('TAF-toggle').classList.toggle('running', on);
        $('TAF-status-text').textContent = on ? 'Running — farming drops' : 'Stopped';
        $('TAF-status-text').classList.toggle('active', on);
        log(on ? 'Started farming' : 'Stopped farming', 'system');
        if (on) setTimeout(tick, 500);
    };

    $('TAF-toggle').onclick = () => setRunning(!isRunning());
    
    $('TAF-minimize').onclick = () => {
        CONFIG.minimized = gui.classList.toggle('minimized');
        $('TAF-minimize').textContent = CONFIG.minimized ? '+' : '−';
        saveConfig();
    };
    
    $('TAF-hide').onclick = () => {
        gui.style.display = 'none';
        fab.hidden = false;
    };
    
    fab.onclick = () => {
        gui.style.display = '';
        fab.hidden = true;
    };
    
    $('TAF-settings').onclick = () => {
        const p = $('TAF-settings-panel');
        p.hidden = !p.hidden;
        if (!p.hidden) {
            $('TAF-whitelist').value = CONFIG.whitelist.join('\n');
            $('TAF-rotation').value = CONFIG.streamRotationMin;
            $('TAF-check').value = CONFIG.checkIntervalSec;
            $('TAF-viewers').value = CONFIG.minViewers;
            $('TAF-connect-mode').value = CONFIG.connectMode;
            $('TAF-autostart').value = CONFIG.autoStart ? '1' : '0';
        }
    };
    
    $('TAF-save').onclick = () => {
        CONFIG.whitelist = $('TAF-whitelist').value.split('\n').map(s => s.trim()).filter(Boolean);
        CONFIG.streamRotationMin = Math.min(60, Math.max(0, parseInt($('TAF-rotation').value, 10) || 0));
        CONFIG.checkIntervalSec = Math.min(120, Math.max(10, parseInt($('TAF-check').value, 10) || 30));
        CONFIG.minViewers = Math.min(10000, Math.max(0, parseInt($('TAF-viewers').value, 10) || 0));
        CONFIG.connectMode = $('TAF-connect-mode').value;
        CONFIG.autoStart = $('TAF-autostart').value === '1';
        localStorage.setItem('taf_configured', '1'); 
        saveConfig();
        log('Settings saved', 'system');
        toast('💾 Настройки сохранены — можно жать START');
    };
    
    let drag = null;
    $('TAF-header').addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = gui.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        gui.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
        gui.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
    });
    
    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        CONFIG.position = { top: gui.style.top, left: gui.style.left };
        saveConfig();
    });
    
    let uptime = 0;
    setInterval(() => {
        if (isRunning()) {
            $('TAF-uptime').textContent = 'Uptime: ' + fmtUptime(++uptime);
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
            
            let categoryLink = block.querySelector('a[href*="/directory/category/"]');
            const hintText = block.querySelector('[data-test-selector="DropsCampaignInProgressDescription-hint-text-parent"]');
            
            const specificChannels = [];
            if (hintText) {
                const allLinks = hintText.querySelectorAll('a[href]');
                for (const link of allLinks) {
                    const href = link.getAttribute('href');
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
            
            if (!isWhitelisted(gameName, '') && !isWhitelisted(slugName, '')) {
                log(`Блок ${i}: ${gameName} (${slugName}) не в whitelist`, 'info');
                continue;
            }
            
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
                    channels: specificChannels,
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

    const checkActiveDrops = () => {
        const watchSection = [...document.querySelectorAll('p')].find(p => 
            /^(смотреть|watch) drops$/i.test((p.textContent || '').trim())
        );
        
        if (!watchSection) {
            return { hasWatchDrops: false, rem: null, pct: null, claimReady: false };
        }
        
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
            
            const drops = [], conns = [];
            for (const head of document.querySelectorAll('div.accordion-header')) {
                const btn = head.querySelector('button');
                if (btn?.getAttribute('aria-expanded') !== 'true') continue;
                
                const info = getDropInfo(btn);
                if (!isWhitelisted(info.game, info.company)) continue;
                if (farm.done.includes(info.game) || isDoneGlobal(info.game)) continue;
                
                const root = head.parentElement;
                
                const conn = [...root.querySelectorAll('a [data-a-target="tw-core-button-label-text"]')]
                    .find(l => ['подключить', 'connect'].includes(norm(l.textContent)));
                if (conn) {
                    conns.push({ game: info.game, url: conn.closest('a').href, el: conn.closest('a') });
                    continue;
                }
                
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
            
            handleConnections(conns);
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
        
        if (preferredChannels.length > 0) {
            for (const channel of preferredChannels) {
                if (seen.has(channel)) continue;
                
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
            if (streams.length > 0) {
                log(`Все стримы перепробованы для ${farm.current.game} — сброс`, 'warn');
                farm.tried[farm.current.game] = [];
                saveFarm();
                const retry = streams[0];
                farm.tried[farm.current.game].push(retry.url);
                farm.current.streamUrl = retry.url;
                farm.current.startedAt = Date.now();
                farm.phase = 'watch';
                saveFarm();
                log(`Переход на стрим (retry): ${retry.url}`, 'farm');
                go(retry.url);
                return;
            }
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
        
        if (farm.current?.streamUrl && farm.current?.game) {
            const game = farm.current.game;
            farm.tried[game] = farm.tried[game] || [];
            if (!farm.tried[game].includes(farm.current.streamUrl)) {
                farm.tried[game].push(farm.current.streamUrl);
            }
            log(`Ротация: ${reason} (исключён: ${farm.current.streamUrl.split('/').pop()})`, 'warn');
        } else {
            log(`Ротация: ${reason}`, 'warn');
        }
        
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
        
        const streamClaimBtn = [...document.querySelectorAll('[data-a-target="tw-core-button-label-text"]')]
            .find(el => /^получить$/i.test((el.textContent || '').trim()));
        
        if (streamClaimBtn) {
            const parentBtn = streamClaimBtn.closest('button, a');
            if (parentBtn) {
                parentBtn.click();
                stats.claimed++;
                saveStats();
                updateStats();
                log(`🎁 Дроп получен на стриме: ${farm.current?.game}`, 'success');
                toast(`🎁 Получен дроп: ${farm.current?.game || ''}`);
                
                if (farm.current && !farm.done.includes(farm.current.game)) {
                    farm.done.push(farm.current.game);
                }
                if (farm.current) doneSet(farm.current.game);
                saveFarm();
                
                setTimeout(() => nextFromQueue(), 2000);
                return;
            }
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
                
                video.addEventListener('pause', () => {
                    if (isRunning() && farm.phase === 'watch') {
                        setTimeout(() => {
                            if (video.paused) video.play().catch(() => {});
                        }, 1000);
                    }
                });
                
                video.addEventListener('ended', () => {
                    if (isRunning() && farm.phase === 'watch') {
                        log('Видео закончилось - перезапускаем', 'warn');
                        video.play().catch(() => {});
                    }
                });
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
        
        if (!rt.lastActivity || Date.now() - rt.lastActivity > 120000) {
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
                
                if (video.paused || video.ended) {
                    video.play().catch(() => {});
                }
                
                log('Активность эмулирована', 'info');
            }
        }
    };

    const onInventory = async () => {
        log('Проверка инвентаря...', 'farm');
        await sleep(2000);

        const campaigns = parseInventory();
        
        if (campaigns.length > 0) {
            log(`Найдено активных дропов: ${campaigns.length}`, 'farm');
            
            await tryClaimReadyDrops();
            
            farm.queue = campaigns;
            farm.tried = {};
            farm.phase = 'dir';
            saveFarm();
            updateQueue();
            nextFromQueue();
            return;
        }

        log('Нет активных дропов, проверяю награды...', 'info');
        await sleep(1000);
        
        await tryClaimReadyDrops();
        
        log('Перехожу на страницу кампаний...', 'info');
        setTimeout(() => go(CAMPAIGNS_URL), 2000);
    };
    
    const tryClaimReadyDrops = async () => {
        let claimed = 0;
        
        const claimNowBtns = [...document.querySelectorAll('button')]
            .filter(b => /получить сейчас|claim now/i.test(b.textContent || ''));
        
        for (const btn of claimNowBtns) {
            btn.click();
            claimed++;
            stats.claimed++;
            log(`🎁 Дроп получен (Получить сейчас)`, 'success');
            await sleep(1500);
        }
        
        const claimBtns = [
            ...document.querySelectorAll('button[data-a-target="claim-drop-button"], button[data-a-target="DropsClaimButton"]'),
            ...[...document.querySelectorAll('button')].filter(b => {
                const text = (b.textContent || '').trim();
                return /^(получить|claim)$/i.test(text);
            })
        ];
        
        for (const b of claimBtns) {
            b.click();
            claimed++;
            stats.claimed++;
            await sleep(1200);
        }
        
        if (claimed > 0) {
            saveStats();
            updateStats();
            log(`Получено наград: ${claimed}`, 'claim');
            toast(`🎁 Получено наград: ${claimed}`);
            await sleep(2000);
        }
        
        return claimed;
    };

    // ===== ПОДКЛЮЧЕНИЕ АККАУНТОВ =====
    const connKey = (url) => 'taf_conn_' + url;
    const isCooledDown = (url) => Date.now() - (+sessionStorage.getItem(connKey(url)) || 0) < CONFIG.connectCooldownMin * 60000;
    
    const renderConnectPanel = (pending) => {
        const box = $('TAF-connect');
        box.hidden = !pending.length;
        if (pending.length) {
            box.innerHTML = `<div class="TAF-connect-title">⚠ Требуется подключение</div>` +
                pending.map(p => `<div class="TAF-connect-row"><span>${esc(p.game)}</span>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Открыть</a>` : ''}</div>`).join('');
        }
    };
    
    const handleConnections = (pending) => {
        renderConnectPanel(pending);
        const fresh = pending.filter(p => !notifiedConnections.has(p.game));
        if (!fresh.length) return;
        fresh.forEach(p => { 
            notifiedConnections.add(p.game); 
            log(`⚠ Требуется подключение: ${p.game}`, 'warn'); 
        });
        toast(`⚠ Требуется подключение: ${fresh.map(p => p.game).join(', ')}`);
        const target = pending.find(p => p.url && !isCooledDown(p.url));
        if (!target) return;
        sessionStorage.setItem(connKey(target.url), String(Date.now()));
        if (CONFIG.connectMode === 'redirect') setTimeout(() => location.assign(target.url), 2000);
        else if (CONFIG.connectMode === 'open' && target.el) target.el.click();
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
            if (video) {
                log('Вкладка активна - проверяем видео', 'info');
                if (video.paused || video.ended) {
                    video.play().catch(() => {});
                }
                video.muted = CONFIG.muted;
            }
            rt.stuck = 0;
            rt.reloaded = false;
            updateFarmStatus();
        }
    });
    
    setInterval(() => {
        if (isRunning() && farm.phase === 'watch') {
            const video = document.querySelector('video');
            if (video) {
                if (video.paused || video.ended) {
                    log('Видео на паузе - возобновляем', 'info');
                    video.play().catch(() => {});
                }
                if (video.muted !== CONFIG.muted) {
                    video.muted = CONFIG.muted;
                }
            }
        }
    }, 30000);
    
    setInterval(tick, 15000);

    const isConfigured = () => localStorage.getItem('taf_configured') === '1';

    if (isRunning()) {
        $('TAF-toggle').textContent = 'STOP';
        $('TAF-toggle').classList.add('running');
        $('TAF-status-text').textContent = 'Running — farming drops';
        $('TAF-status-text').classList.add('active');
        log('♻️ Возобновляю работу после перезагрузки', 'system');
        setTimeout(tick, 2500);
    } else if (!isConfigured()) {
        log('⚙ Настрой скрипт (⚙ → SAVE) и нажми START', 'system');
        $('TAF-status-text').textContent = '⚙ Настрой и нажми START';
    } else if (CONFIG.autoStart && isConfigured()) {
        log('🚀 Автостарт после настройки', 'system');
        setRunning(true);
    } else {
        log('⏸ Остановлен — нажми START для запуска', 'system');
        $('TAF-status-text').textContent = 'Stopped — press START';
    }
})();