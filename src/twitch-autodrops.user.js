// ==UserScript==
// @name         Twitch Auto Farm Drops (Autonomous)
// @namespace    https://github.com/ZeroStalker3/twitch-autodrops
// @version      3.0.0
// @description  Фарм Twitch Drops: проверенный DOM-парсинг + GQL fast-path, защита от циклов
// @author       ZeroYz
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @license      MIT
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const EventBus = (() => {
        const L = new Map();
        return {
            on: (e, cb) => { if (!L.has(e)) L.set(e, []); L.get(e).push(cb); },
            emit: (e, d) => { (L.get(e) || []).forEach(cb => { try { cb(d); } catch (err) { console.error(err); } }); }
        };
    })();

    const Logger = (() => {
        const COLORS = { system: '#e94560', info: '#3498db', warn: '#f39c12', error: '#e74c3c', success: '#2ecc71', gql: '#00d4ff', autonomous: '#9b59b6', farm: '#e67e22' };
        let guiFn = null;
        const log = (msg, type = 'info') => {
            console.log(`%c[TAF]%c [${type}] ${msg}`, 'color:#e94560;font-weight:bold', `color:${COLORS[type] || '#95a5a6'}`);
            if (guiFn) guiFn(msg, type);
        };
        return {
            info: m => log(m, 'info'), warn: m => log(m, 'warn'), error: m => log(m, 'error'),
            success: m => log(m, 'success'), farm: m => log(m, 'farm'), system: m => log(m, 'system'),
            gql: m => log(m, 'gql'), autonomous: m => log(m, 'autonomous'),
            setGui: fn => { guiFn = fn; }
        };
    })();

    const OPS = new Map(), MUTS = new Map();
    const INTERESTING = /inventory|dropscampaign|campaign|stream|directory|browsepage|claimdrop|uselive|userdrops|drop/i;

    const TokenManager = (() => {
        let token = null;
        const readCookie = () => {
            const m = document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/);
            if (m && m[1] !== token) { token = m[1]; Logger.autonomous('Токен из cookies'); }
        };
        return {
            getToken: () => { readCookie(); return token; },
            isValid: () => { readCookie(); return !!token; },
            setToken: t => { if (t && t !== token) { token = t; Logger.autonomous('Токен перехвачен из GQL-запроса'); } }
        };
    })();

    const installFetchInterceptor = () => {
        const orig = window.fetch;
        window.fetch = async function (...args) {
            try {
                const [url, opts] = args;
                const u = typeof url === 'string' ? url : url?.url;
                if (u && u.includes('gql.twitch.tv') && opts) {
                    const h = opts.headers;
                    const auth = h && (h.Authorization || h.authorization || (h.get && h.get('Authorization')));
                    if (auth && /OAuth/i.test(auth)) TokenManager.setToken(auth.replace(/^OAuth\s+/i, ''));

                    if (opts.method === 'POST' && opts.body) {
                        try {
                            const payload = JSON.parse(opts.body);
                            const arr = Array.isArray(payload) ? payload : [payload];
                            for (const p of arr) {
                                const name = p.operationName;
                                if (!name || !INTERESTING.test(name)) continue;
                                const isMut = /claim|mutation/i.test(name);
                                const store = isMut ? MUTS : OPS;
                                const prev = store.get(name);
                                store.set(name, {
                                    name, sha: p.extensions?.persistedQuery?.sha256Hash || null,
                                    variables: p.variables || {}, query: p.query || null,
                                    lastSeen: Date.now(), callCount: (prev?.callCount || 0) + 1
                                });
                                EventBus.emit('op:captured');
                            }
                        } catch { }
                    }
                }
            } catch { }
            return orig.apply(this, args);
        };
    };
    installFetchInterceptor();

    const OperationCollector = {
        find: pat => { for (const [n, e] of OPS) if (n.toLowerCase().includes(pat.toLowerCase())) return e; return null; },
        findMut: pat => { for (const [n, e] of MUTS) if (n.toLowerCase().includes(pat.toLowerCase())) return e; return null; },
        list: () => Array.from(OPS.values())
    };

    const LS_KEY = 'twitchAutoFarmConfig';
    const DEFAULT_CONFIG = {
        whitelist: ['Rust', 'Marvel Rivals', 'Zenless Zone Zero', 'Genshin Impact'],
        streamRotationMin: 0, checkIntervalSec: 30, minViewers: 50,
        minimized: false, position: null, connectMode: 'notify', connectCooldownMin: 30,
        muted: true, autoStart: false, useGraphQL: true
    };
    let CONFIG = (() => { try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; } catch { return { ...DEFAULT_CONFIG }; } })();
    const saveConfig = () => localStorage.setItem(LS_KEY, JSON.stringify(CONFIG));

    const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';
    const CAMPAIGNS_URL = 'https://www.twitch.tv/drops/campaigns';

    const Utils = {
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        norm: s => (s || '').toLowerCase().trim(),
        fmtUptime: s => [s / 3600, s / 60 % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':'),
        esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        parseTimeFromText: text => {
            if (!text) return null;
            const hm = text.match(/(?<![\w:])(\d+)\s*:\s*(\d{1,2})(?!\d)/);
            if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
            let total = 0, found = false;
            const h = text.match(/(\d+)\s*(час|часа|часов|ч|hour|hours|hr|h)\b/i);
            if (h) { total += parseInt(h[1], 10) * 60; found = true; }
            const m = text.match(/(\d+)\s*(мин|минут|минуты|м|minute|minutes|min|m)\b/i);
            if (m) { total += parseInt(m[1], 10); found = true; }
            return found ? total : null;
        }
    };
    const RESERVED = ['directory', 'drops', 'videos', 'settings', 'downloads', 'prime', 'subscriptions', 'wallet', 'turbo', 'popout', 'p', 'jobs', 'store'];
    const isStreamPage = () => { const seg = location.pathname.split('/').filter(Boolean); return seg.length === 1 && !RESERVED.includes(seg[0]); };

    const State = (() => {
        const SS_STATE = 'taf_state_v4', SS_RUN = 'taf_running', LS_STATS = 'taf_stats', LS_DONE = 'taf_done_global';
        const DONE_TTL = { completed: 12 * 3600 * 1000, nowatch: 60 * 60 * 1000 };
        const fresh = () => ({ phase: 'idle', queue: [], current: null, tried: {}, done: [], lastScanTime: 0, lastInventoryScan: 0, lastCampaignScan: 0, lastSync: 0 });
        let farm = (() => { try { return { ...fresh(), ...JSON.parse(sessionStorage.getItem(SS_STATE) || '{}') }; } catch { return fresh(); } })();
        if (!Array.isArray(farm.done)) farm.done = [];
        if (!Array.isArray(farm.queue)) farm.queue = [];
        const saveFarm = () => sessionStorage.setItem(SS_STATE, JSON.stringify(farm));

        let stats = (() => { try { return { claimed: 0, streams: 0, gqlCalls: 0, domFallbacks: 0, ...JSON.parse(localStorage.getItem(LS_STATS) || '{}') }; } catch { return { claimed: 0, streams: 0, gqlCalls: 0, domFallbacks: 0 }; } })();
        const saveStats = () => localStorage.setItem(LS_STATS, JSON.stringify(stats));
        const bumpStat = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; saveStats(); if (window.GUI) GUI.updateStats(); };

        const doneGet = () => {
            try {
                const raw = JSON.parse(localStorage.getItem(LS_DONE) || '{}'), out = {};
                for (const k of Object.keys(raw)) {
                    const e = raw[k], t = typeof e === 'number' ? e : e?.t;
                    const r = (typeof e === 'object' && e?.r) ? e.r : 'completed';
                    if (t && Date.now() - t < DONE_TTL[r]) out[k] = { t, r };
                }
                return out;
            } catch { return {}; }
        };
        const doneSet = (g, r = 'completed') => { const d = doneGet(); d[g] = { t: Date.now(), r }; localStorage.setItem(LS_DONE, JSON.stringify(d)); };
        const doneReason = g => doneGet()[g]?.r || null;
        const doneClear = g => { const d = doneGet(); delete d[g]; localStorage.setItem(LS_DONE, JSON.stringify(d)); };
        const isDoneGlobal = g => !!doneGet()[g];
        const isRunning = () => sessionStorage.getItem(SS_RUN) === '1';
        const setRunning = on => sessionStorage.setItem(SS_RUN, on ? '1' : '0');

        return { farm, saveFarm, stats, bumpStat, doneSet, doneReason, doneClear, isDoneGlobal, isRunning, setRunning };
    })();

    const Nav = (() => {
        const MIN_INTERVAL = 3000, SAME_URL_COOLDOWN = 25000;
        const go = (url, force = false) => {
            const now = Date.now(), since = now - (State.farm.lastNav || 0);
            if (since < MIN_INTERVAL) { Logger.warn(`[NAV] блок: слишком рано (${Math.floor(since / 1000)}с)`); return false; }
            if (!force && url === State.farm.lastNavUrl && since < SAME_URL_COOLDOWN) {
                Logger.warn('[NAV] блок: повторный переход на ту же страницу');
                return false;
            }
            State.farm.lastNav = now; State.farm.lastNavUrl = url; State.saveFarm();
            Logger.info(`[NAV] → ${url.replace('https://www.twitch.tv', '')}`);
            location.href = url;
            return true;
        };
        return { go };
    })();

    const ReplayEngine = (() => {
        const last = new Map();
        const execute = async (pattern, override = {}) => {
            const e = OperationCollector.find(pattern);
            if (!e) return { error: 'NOT_CAPTURED' };
            if (Date.now() - (last.get(e.name) || 0) < 15000) return { skipped: true };
            const token = TokenManager.getToken();
            if (!token) return { error: 'NO_TOKEN' };
            const payload = { operationName: e.name, variables: { ...e.variables, ...override } };
            if (e.sha) payload.extensions = { persistedQuery: { version: 1, sha256Hash: e.sha } };
            else if (e.query) payload.query = e.query;
            try {
                last.set(e.name, Date.now());
                const res = await fetch('https://gql.twitch.tv/gql', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8', 'Authorization': `OAuth ${token}` },
                    body: JSON.stringify(payload)
                });
                State.bumpStat('gqlCalls');
                const data = await res.json();
                if (data.errors) return { error: data.errors.map(x => x.message).join('; ') };
                return { ok: true, data: data.data };
            } catch (err) { return { error: err.message }; }
        };
        return { execute };
    })();

    const fetchStreamDropsProgress = async (channelLogin) => {
        const res = await ReplayEngine.execute('DropChannelCampaignsProgress', { channelLogin });
        if (!res.ok || !res.data) {
            Logger.gql(`DropChannelCampaignsProgress failed: ${res.error}`);
            return null;
        }
        
        try {
            Logger.gql(`GQL raw response: ${JSON.stringify(res.data).slice(0, 500)}`, 2);
            const channel = res.data.channel;
            if (!channel) {
                Logger.gql('GQL: no channel in response');
                return null;
            }
            
            const campaigns = channel.drops?.campaigns || [];
            if (!campaigns.length) {
                Logger.gql('GQL: no campaigns found');
                return null;
            }
            
            const cur = State.farm.current;
            const targetGame = cur?.game;
            
            let bestDrop = null;
            for (const campaign of campaigns) {
                const game = campaign.game?.displayName;
                if (targetGame && game !== targetGame) continue;
                
                const timeDrops = campaign.timeBasedDrops || [];
                for (const drop of timeDrops) {
                    if (drop.self?.isClaimed) continue;
                    const req = drop.requiredMinutesWatched || 0;
                    const curMin = drop.self?.currentMinutesWatched || 0;
                    if (req <= 0) continue;
                    
                    const rem = req - curMin;
                    const pct = (curMin / req) * 100;
                    
                    if (!bestDrop || rem < bestDrop.rem) {
                        bestDrop = { rem, pct, game };
                    }
                }
            }
            
            if (bestDrop) {
                Logger.gql(`GQL прогресс: ${bestDrop.game} — ${bestDrop.pct.toFixed(1)}%, осталось ${bestDrop.rem.toFixed(1)} мин`);
                return bestDrop;
            }
            Logger.gql('GQL: no active drops found');
        } catch (e) {
            Logger.warn(`Ошибка парсинга GQL: ${e.message}`);
        }
        return null;
    };

    const rt = {
        lastCheck: 0, setupDone: false, catChecked: false, stuck: 0, reloaded: false,
        domRemaining: null, domPct: null, prevSig: '', estRequired: 0, lastSync: 0,
        lastActivity: 0, countdownInterval: null, lastAttempt: 0, syncAttempts: 0
    };
    const notifiedConnections = new Set();

    let GUI = null;
    const createGUI = () => {
        const style = document.createElement('style');
        style.textContent = `
            #TAF-panel{position:fixed;top:20px;left:20px;width:420px;background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);border:1px solid #2d4059;border-radius:12px;font-family:'Segoe UI',sans-serif;color:#fff;z-index:999998;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
            #TAF-header{background:linear-gradient(90deg,#e94560 0%,#c73e54 100%);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
            #TAF-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
            #TAF-logo{width:20px;height:20px;background:linear-gradient(135deg,#e94560 0%,#f27121 100%);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px}
            #TAF-controls{display:flex;gap:8px}
            .TAF-btn{padding:6px 16px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .3s;text-transform:uppercase;letter-spacing:.5px}
            #TAF-toggle{background:#27ae60;color:#fff}#TAF-toggle.running{background:#e74c3c}
            #TAF-hide,#TAF-minimize,#TAF-settings{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);padding:6px 12px}
            #TAF-settings{padding:6px 10px;font-size:14px;line-height:1}#TAF-minimize{padding:6px 10px;font-size:16px;line-height:1}
            #TAF-content{padding:16px}
            #TAF-panel.minimized #TAF-content,#TAF-panel.minimized #TAF-footer{display:none}
            #TAF-status{background:rgba(255,255,255,.05);border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px;text-align:center}
            #TAF-status-text{color:#95a5a6}#TAF-status-text.active{color:#2ecc71;font-weight:600}
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
            #TAF-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px}
            .TAF-stat{background:rgba(255,255,255,.05);border-radius:8px;padding:8px;text-align:center}
            .TAF-stat-label{font-size:9px;color:#95a5a6;text-transform:uppercase;margin-bottom:3px}
            .TAF-stat-value{font-size:16px;font-weight:700;color:#fff}
            #TAF-ops-panel{background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.3);border-radius:8px;padding:10px;margin-bottom:12px;font-size:11px;color:#00d4ff}
            #TAF-ops-panel[hidden]{display:none}
            #TAF-settings-panel{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;margin-bottom:12px}
            #TAF-settings-panel[hidden]{display:none}
            .TAF-field-label{font-size:10px;color:#95a5a6;text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px;display:block}
            .TAF-input,.TAF-textarea{width:100%;box-sizing:border-box;background:rgba(0,0,0,.4);border:1px solid rgba(233,69,96,.3);border-radius:6px;color:#fff;padding:8px 10px;font:12px/1.4 'Consolas',monospace}
            .TAF-textarea{resize:vertical;min-height:64px}
            #TAF-save{width:100%;margin-top:10px;background:#e94560;color:#fff}
            #TAF-log{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;height:180px;overflow-y:auto;font-size:11px;font-family:'Consolas',monospace}
            .TAF-log-entry{padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)}
            .TAF-log-time{color:#95a5a6;margin-right:8px;font-size:10px}
            .TAF-log-success{color:#2ecc71}.TAF-log-info{color:#3498db}.TAF-log-warning{color:#f39c12}.TAF-log-system{color:#e94560}.TAF-log-farm{color:#e67e22}.TAF-log-gql{color:#00d4ff}.TAF-log-autonomous{color:#9b59b6}
            #TAF-footer{padding:12px 16px;background:rgba(0,0,0,.2);text-align:center;font-size:10px;color:#95a5a6}
            #TAF-log::-webkit-scrollbar{width:6px}#TAF-log::-webkit-scrollbar-thumb{background:rgba(233,69,96,.5);border-radius:3px}
            #TAF-fab{position:fixed;left:20px;bottom:20px;width:52px;height:52px;border:none;border-radius:50%;cursor:pointer;font-size:24px;background:linear-gradient(135deg,#e94560 0%,#f27121 100%);box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:999998}
            #TAF-fab[hidden]{display:none}
            .TAF-toast{position:fixed;top:80px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);border:1px solid #e94560;border-radius:8px;padding:10px 16px;color:#fff;font:12px 'Consolas',monospace;box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:9999999}
        `;
        const gui = document.createElement('div');
        gui.id = 'TAF-panel';
        if (CONFIG.minimized) gui.classList.add('minimized');
        gui.innerHTML = `
            <div id="TAF-header">
                <div id="TAF-title"><div id="TAF-logo">🎁</div><span>TAF Autonomous v4.2.1</span></div>
                <div id="TAF-controls">
                    <button id="TAF-toggle" class="TAF-btn">START</button>
                    <button id="TAF-settings" class="TAF-btn">⚙</button>
                    <button id="TAF-hide" class="TAF-btn">HIDE</button>
                    <button id="TAF-minimize" class="TAF-btn">${CONFIG.minimized ? '+' : '−'}</button>
                </div>
            </div>
            <div id="TAF-content">
                <div id="TAF-status"><div id="TAF-status-text">Ready...</div><div id="TAF-uptime">Uptime: 00:00:00</div></div>
                <div id="TAF-farm-status" hidden>
                    <div class="TAF-farm-game" id="TAF-farm-game">-</div>
                    <div class="TAF-farm-stream" id="TAF-farm-stream">-</div>
                    <div class="TAF-farm-progress"><div class="TAF-farm-progress-bar" id="TAF-farm-progress" style="width:0%">0%</div></div>
                    <div class="TAF-farm-time" id="TAF-farm-time">Осталось: --:--:--</div>
                </div>
                <div id="TAF-queue" hidden><div class="TAF-queue-title">Очередь фарма</div><div id="TAF-queue-list"></div></div>
                <div id="TAF-stats">
                    <div class="TAF-stat"><div class="TAF-stat-label">Claimed</div><div class="TAF-stat-value" id="TAF-claimed">0</div></div>
                    <div class="TAF-stat"><div class="TAF-stat-label">Streams</div><div class="TAF-stat-value" id="TAF-streams">0</div></div>
                    <div class="TAF-stat"><div class="TAF-stat-label">GQL</div><div class="TAF-stat-value" id="TAF-gql">0</div></div>
                    <div class="TAF-stat"><div class="TAF-stat-label">DOM</div><div class="TAF-stat-value" id="TAF-dom">0</div></div>
                </div>
                <div id="TAF-ops-panel" hidden><div><strong>🧠 Изученные операции:</strong></div><div id="TAF-ops-list" style="margin-top:6px;font-size:10px;line-height:1.6"></div></div>
                <div id="TAF-settings-panel" hidden>
                    <label class="TAF-field-label">Whitelist (по одной на строку)</label>
                    <textarea class="TAF-textarea" id="TAF-whitelist"></textarea>
                    <label class="TAF-field-label">Ротация стримов (мин, 0=выкл)</label>
                    <input class="TAF-input" id="TAF-rotation" type="number" min="0" max="60" step="5">
                    <label class="TAF-field-label">Проверка прогресса (сек)</label>
                    <input class="TAF-input" id="TAF-check" type="number" min="10" max="120" step="10">
                    <label class="TAF-field-label">Мин зрителей</label>
                    <input class="TAF-input" id="TAF-viewers" type="number" min="0" max="10000" step="10">
                    <button id="TAF-save" class="TAF-btn">SAVE</button>
                </div>
                <div id="TAF-log"></div>
            </div>
            <div id="TAF-footer">TAF v4.2.1 by ZeroYz</div>
        `;
        const fab = document.createElement('button');
        fab.id = 'TAF-fab'; fab.textContent = '🎁'; fab.hidden = true;
        document.head.appendChild(style);
        document.body.appendChild(gui);
        document.body.appendChild(fab);
        if (CONFIG.position) { gui.style.top = CONFIG.position.top; gui.style.left = CONFIG.position.left; }

        const $ = id => document.getElementById(id);
        const logBox = $('TAF-log');
        const TYPES = { system: 'system', info: 'info', claim: 'success', warn: 'warning', error: 'warning', farm: 'farm', gql: 'gql', autonomous: 'autonomous', success: 'success' };
        const logToGui = (msg, type = 'info') => {
            const row = document.createElement('div');
            row.className = 'TAF-log-entry';
            row.innerHTML = `<span class="TAF-log-time">${new Date().toLocaleTimeString('ru-RU', { hour12: false })}</span><span class="TAF-log-${TYPES[type] || 'info'}">${Utils.esc(msg)}</span>`;
            logBox.appendChild(row); logBox.scrollTop = logBox.scrollHeight;
            while (logBox.children.length > 100) logBox.firstChild.remove();
        };
        const toast = msg => { const t = document.createElement('div'); t.className = 'TAF-toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 4000); };

        $('TAF-toggle').onclick = () => EventBus.emit('toggle:click', !State.isRunning());
        $('TAF-minimize').onclick = () => { CONFIG.minimized = gui.classList.toggle('minimized'); $('TAF-minimize').textContent = CONFIG.minimized ? '+' : '−'; saveConfig(); };
        $('TAF-hide').onclick = () => { gui.style.display = 'none'; fab.hidden = false; };
        fab.onclick = () => { gui.style.display = ''; fab.hidden = true; };
        $('TAF-settings').onclick = () => {
            const p = $('TAF-settings-panel'); p.hidden = !p.hidden;
            if (!p.hidden) {
                $('TAF-whitelist').value = CONFIG.whitelist.join('\n');
                $('TAF-rotation').value = CONFIG.streamRotationMin;
                $('TAF-check').value = CONFIG.checkIntervalSec;
                $('TAF-viewers').value = CONFIG.minViewers;
            }
        };
        $('TAF-save').onclick = () => {
            CONFIG.whitelist = $('TAF-whitelist').value.split('\n').map(s => s.trim()).filter(Boolean);
            CONFIG.streamRotationMin = Math.min(60, Math.max(0, parseInt($('TAF-rotation').value, 10) || 0));
            CONFIG.checkIntervalSec = Math.min(120, Math.max(10, parseInt($('TAF-check').value, 10) || 30));
            CONFIG.minViewers = Math.min(10000, Math.max(0, parseInt($('TAF-viewers').value, 10) || 0));
            localStorage.setItem('taf_configured', '1'); saveConfig();
            logToGui('Настройки сохранены', 'success'); toast('💾 Сохранено');
        };

        let drag = null;
        $('TAF-header').addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;
            const r = gui.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        });
        document.addEventListener('mousemove', e => { if (!drag) return; gui.style.top = Math.max(0, e.clientY - drag.dy) + 'px'; gui.style.left = Math.max(0, e.clientX - drag.dx) + 'px'; });
        document.addEventListener('mouseup', () => { if (!drag) return; drag = null; CONFIG.position = { top: gui.style.top, left: gui.style.left }; saveConfig(); });

        const api = {
            $, logToGui, toast,
            setRunningUI: on => {
                $('TAF-toggle').textContent = on ? 'STOP' : 'START';
                $('TAF-toggle').classList.toggle('running', on);
                $('TAF-status-text').textContent = on ? 'Running — farming drops' : 'Stopped';
                $('TAF-status-text').classList.toggle('active', on);
            },
            updateStats: () => {
                $('TAF-claimed').textContent = State.stats.claimed || 0;
                $('TAF-streams').textContent = State.stats.streams || 0;
                $('TAF-gql').textContent = State.stats.gqlCalls || 0;
                $('TAF-dom').textContent = State.stats.domFallbacks || 0;
            },
            updateQueue: () => {
                $('TAF-queue').hidden = !State.farm.queue.length;
                $('TAF-queue-list').innerHTML = State.farm.queue.map(g => `<div class="TAF-queue-item">${Utils.esc(g.game)}</div>`).join('');
            },
            // [FIX] updateFarmStatus — использует rt.domRemaining напрямую
            updateFarmStatus: () => {
                const cur = State.farm.current;
                $('TAF-farm-status').hidden = !cur;
                if (!cur) return;
                $('TAF-farm-game').textContent = cur.game;
                $('TAF-farm-stream').textContent = cur.streamUrl || 'Поиск стрима...';
                
                let displayRem = rt.domRemaining, displayPct = rt.domPct;
                if (rt.domRemaining != null && rt.lastSync > 0) {
                    const elapsedMin = (Date.now() - rt.lastSync) / 60000;
                    displayRem = Math.max(0, rt.domRemaining - elapsedMin);
                    if (rt.estRequired > 0) displayPct = Math.min(100, (1 - displayRem / rt.estRequired) * 100);
                }
                
                let pct, remain;
                if (displayRem != null) {
                    remain = displayRem * 60;
                    if (displayPct != null) {
                        pct = displayPct;
                    } else if (rt.estRequired > 0) {
                        pct = Math.max(0, Math.min(100, (1 - displayRem / rt.estRequired) * 100));
                    } else {
                        pct = 0;
                    }
                } else if (displayPct != null) {
                    const totalMin = cur.watchTime / 60;
                    remain = totalMin * 60 * (1 - displayPct / 100);
                    pct = displayPct;
                } else {
                    const elapsed = cur.startedAt ? (Date.now() - cur.startedAt) / 1000 : 0;
                    pct = Math.min(100, elapsed / cur.watchTime * 100);
                    remain = Math.max(0, cur.watchTime - elapsed);
                }
                
                $('TAF-farm-progress').style.width = pct + '%';
                $('TAF-farm-progress').textContent = Math.floor(pct) + '%';
                $('TAF-farm-time').textContent = 'Осталось: ' + Utils.fmtUptime(Math.floor(remain));
            },
            updateOps: () => {
                const ops = OperationCollector.list();
                $('TAF-ops-panel').hidden = !ops.length;
                if (ops.length) $('TAF-ops-list').innerHTML = ops.slice(0, 8).map(o => `• ${Utils.esc(o.name)} <span style="color:#95a5a6">(calls: ${o.callCount})</span>`).join('<br>');
            }
        };
        Logger.setGui(logToGui);
        return api;
    };

    const isWhitelisted = (game, company) => {
        if (!CONFIG.whitelist.length) return true;
        const g = Utils.norm(game), c = Utils.norm(company);
        return CONFIG.whitelist.some(w => {
            const nw = Utils.norm(w); if (!nw) return false;
            return (g && (g.includes(nw) || nw.includes(g))) || (c && (c.includes(nw) || nw.includes(c)));
        });
    };

    const getDropInfo = btn => {
        const t = btn.querySelectorAll('p[class*="CoreText"]');
        return { game: t[0]?.textContent || '', company: t[1]?.textContent || '' };
    };

    const parseInventoryDOM = () => {
        const campaigns = [];
        Logger.info('Парсинг инвентаря (DOM)...');

        let blocks = document.querySelectorAll('.Layout-sc-1xcs6mc-0.hStHhY');
        if (!blocks.length) blocks = document.querySelectorAll('article, [class*="Campaign"], [data-test-selector*="Campaign"]');
        if (!blocks.length) {
            const set = new Set();
            document.querySelectorAll('[role="progressbar"][aria-valuenow]').forEach(b => {
                let el = b;
                for (let i = 0; i < 8 && el; i++) { el = el.parentElement; if (el && el.querySelector('a[href*="/directory/category/"]')) break; }
                if (el) set.add(el);
            });
            blocks = [...set];
        }
        Logger.info(`Блоков кампаний: ${blocks.length}`);

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const gameLink = block.querySelector('[class*="CoreText"] a') || block.querySelector('a[href*="/directory/category/"]');
            const gameName = gameLink?.textContent?.trim() || '';
            if (!gameName) continue;

            const categoryLink = block.querySelector('a[href*="/directory/category/"]');
            if (!categoryLink) continue;
            const slugMatch = categoryLink.getAttribute('href').match(/category\/([^?/]+)/);
            if (!slugMatch) continue;
            const slug = slugMatch[1], slugName = slug.replace(/-/g, ' ');

            const specificChannels = [];
            const hintText = block.querySelector('[data-test-selector="DropsCampaignInProgressDescription-hint-text-parent"]');
            if (hintText) {
                for (const link of hintText.querySelectorAll('a[href]')) {
                    const m = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{3,25})\/?$/);
                    if (m && !RESERVED.includes(m[1])) specificChannels.push(m[1]);
                }
            }

            if (!isWhitelisted(gameName, '') && !isWhitelisted(slugName, '')) continue;

            const progressBars = block.querySelectorAll('[role="progressbar"][aria-valuenow]');
            let targetRemMin = Infinity, targetPct = 0, foundActive = false, allCompleted = true;

            for (const bar of progressBars) {
                const pct = parseFloat(bar.getAttribute('aria-valuenow') || '0');
                const text = bar.parentElement?.querySelector('[class*="CoreText"]')?.textContent || bar.parentElement?.textContent || '';
                const totalMin = Utils.parseTimeFromText(text);
                if (totalMin) {
                    const isTotal = /\b(от|of)\s/i.test(text);
                    const remainingMin = isTotal ? totalMin * (1 - pct / 100) : totalMin;
                    if (pct < 100 && remainingMin > 0) {
                        foundActive = true; allCompleted = false;
                        if (remainingMin < targetRemMin) { targetRemMin = remainingMin; targetPct = pct; }
                    }
                }
            }
            if (allCompleted || !foundActive) continue;

            campaigns.push({ game: gameName, slug, channels: specificChannels, watchTime: targetRemMin * 60, currentPct: targetPct, remainingMin: targetRemMin, source: 'dom' });
            Logger.success(`✅ ${gameName}: ${targetPct}%, осталось ${targetRemMin.toFixed(1)} мин${specificChannels.length ? ', каналы: ' + specificChannels.join(', ') : ''}`);
        }

        for (const c of campaigns) {
            if (State.doneReason(c.game) === 'completed') {
                State.doneClear(c.game);
                State.farm.done = State.farm.done.filter(g => g !== c.game);
                State.saveFarm();
            }
        }
        return campaigns;
    };

    const parseInventoryGQL = data => {
        const campaigns = [];
        const drops = data?.currentUser?.drops?.inventory?.drops || data?.drops?.inventory?.campaigns || data?.currentUser?.inventory?.drops || [];
        for (const drop of drops) {
            const campaign = drop.campaign || drop;
            const gameName = campaign.game?.displayName || campaign.game?.name || '';
            const slug = campaign.game?.slug || '';
            if (!gameName || !isWhitelisted(gameName, '')) continue;
            let targetRemMin = Infinity, targetPct = 0, found = false;
            for (const td of (campaign.timeBasedDrops || [])) {
                const cur = td.self?.currentMinutesWatched || 0, req = td.requiredMinutesWatched || 0;
                if (req <= 0 || td.self?.isClaimed) continue;
                const rem = req - cur;
                if (rem > 0 && rem < targetRemMin) { targetRemMin = rem; targetPct = (cur / req) * 100; found = true; }
            }
            if (found) campaigns.push({ game: gameName, slug, channels: [], watchTime: targetRemMin * 60, currentPct: targetPct, remainingMin: targetRemMin, source: 'gql' });
        }
        return campaigns;
    };

    const onCampaigns = async () => {
        const f = State.farm;
        if (Date.now() - (f.lastScanTime || 0) < 60000) return;
        f.lastScanTime = Date.now(); f.lastCampaignScan = Date.now(); State.saveFarm();

        Logger.farm('Сканирование кампаний...');
        await Utils.sleep(3000);

        for (const btn of document.querySelectorAll('div.accordion-header button[aria-expanded="false"]')) {
            const info = getDropInfo(btn);
            if (!isWhitelisted(info.game, info.company)) continue;
            if (f.done.includes(info.game) || State.isDoneGlobal(info.game)) continue;
            btn.click();
            await Utils.sleep(1500);
        }
        await Utils.sleep(2000);

        const drops = [], conns = [];
        for (const head of document.querySelectorAll('div.accordion-header')) {
            const btn = head.querySelector('button');
            if (btn?.getAttribute('aria-expanded') !== 'true') continue;
            const info = getDropInfo(btn);
            if (!isWhitelisted(info.game, info.company)) continue;
            if (f.done.includes(info.game) || State.isDoneGlobal(info.game)) continue;
            const root = head.parentElement;

            const conn = [...root.querySelectorAll('a [data-a-target="tw-core-button-label-text"]')]
                .find(l => ['подключить', 'connect'].includes(Utils.norm(l.textContent)));
            if (conn) { conns.push({ game: info.game, url: conn.closest('a').href }); continue; }

            const rootText = root.textContent || '';
            const isWatch = /в течение|watch for|смотрите\s+\d+/i.test(rootText);
            if (State.doneReason(info.game) === 'nowatch') {
                if (!isWatch) continue;
                State.doneClear(info.game);
                f.done = f.done.filter(g => g !== info.game); State.saveFarm();
            }
            if (!isWatch) { Logger.warn(`⚠ ${info.game}: не watch-based — пропуск`); continue; }

            const link = root.querySelector('a[href*="/directory/category/"]');
            if (!link) continue;
            const slug = (link.getAttribute('href').match(/category\/([^?/]+)/) || [])[1];
            if (!slug) continue;

            const tm = rootText.match(/(?:в течение|for)\s+(\d+)\s*(час|минут|hour|minute)/i);
            const watchTime = tm ? (+tm[1]) * (/мин|minute/i.test(tm[2]) ? 60 : 3600) : (Utils.parseTimeFromText(rootText) || 60) * 60;

            const channels = [];
            const hint = root.querySelector('[data-test-selector*="hint"]') || root;
            for (const a of hint.querySelectorAll('a[href]')) {
                const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{3,25})\/?$/);
                if (m && !RESERVED.includes(m[1])) channels.push(m[1]);
            }

            drops.push({ game: info.game, slug, channels, watchTime });
        }

        handleConnections(conns);

        if (!drops.length) {
            Logger.info('На кампаниях ничего не найдено — idle');
            f.phase = 'idle'; State.saveFarm();
            return;
        }
        Logger.farm(`Найдено дропов: ${drops.length} (${drops.map(d => d.game).join(', ')})`);
        f.queue = drops; f.tried = {}; f.phase = 'dir'; State.saveFarm();
        GUI.updateQueue();
        nextFromQueue();
    };

    const checkActiveDrops = async (gameName) => {
        const out = { hasWatchDrops: false, rem: null, pct: null, claimReady: false, panelOpen: false };

        const bodyText = document.body.textContent || '';
        out.panelOpen = /drops и прочее|drops and more|drops для подписки/i.test(bodyText);

        const claimBtn = [...document.querySelectorAll('[data-a-target="tw-core-button-label-text"]')]
            .find(el => /^(получить|claim)$/i.test((el.textContent || '').trim()));
        if (claimBtn) return { ...out, hasWatchDrops: true, rem: 0, pct: 100, claimReady: true };

        const cur = State.farm.current;
        if (cur?.streamUrl && CONFIG.useGraphQL) {
            const channelLogin = cur.streamUrl.split('/').pop();
            const gqlProgress = await fetchStreamDropsProgress(channelLogin);
            if (gqlProgress && gqlProgress.rem != null) {
                return { ...out, hasWatchDrops: true, rem: Math.round(gqlProgress.rem * 10) / 10, pct: Math.round(gqlProgress.pct), claimReady: false };
            }
        }

        const timeRe = /(?:ещё\s+)?смотрите\s+\d|watch\s+\d|осталось\s+\d|\d+\s*(?:мин|ч|hour|min)|\d+\s*left/i;
        const earnRe = /чтобы\s|to earn|to receive|получить|получи|earn|receive/i;
        const cards = [];

        for (const bar of document.querySelectorAll('[role="progressbar"][aria-valuenow]')) {
            let container = bar.parentElement, text = '';
            for (let i = 0; i < 8 && container; i++) {
                text = container.textContent || '';
                if (timeRe.test(text) && (earnRe.test(text) || i >= 4)) break; 
                container = container.parentElement;
            }
            if (!container || !timeRe.test(text)) continue;
            cards.push({ bar, text, pct: parseFloat(bar.getAttribute('aria-valuenow')) });
        }

        if (!cards.length && out.panelOpen) {
            for (const bar of document.querySelectorAll('[role="progressbar"][aria-valuenow]')) {
                let container = bar.parentElement, text = '';
                for (let i = 0; i < 6 && container; i++) {
                    text = container.textContent || '';
                    if (timeRe.test(text)) break;
                    container = container.parentElement;
                }
                if (container && timeRe.test(text)) {
                    cards.push({ bar, text, pct: parseFloat(bar.getAttribute('aria-valuenow')) });
                    break;
                }
            }
        }

        if (cards.length) {
            const pick = (gameName && cards.find(c => c.text.includes(gameName))) || cards[0];
            let rem = Utils.parseTimeFromText(pick.text);
            if (rem != null && /\b(от|of)\s/i.test(pick.text) && pick.pct != null) {
                rem = rem * (1 - pick.pct / 100);
            }
            if (rem == null) rem = Utils.parseTimeFromText(pick.bar.getAttribute('aria-valuetext') || '');
            
            if (rem == null && pick.pct != null) {
                const cur = State.farm.current;
                if (cur?.watchTime && cur?.currentPct != null && cur.currentPct > 0 && cur.currentPct < 100) {
                    const remainingFromQueue = cur.watchTime / 60;
                    const totalMin = remainingFromQueue / (1 - cur.currentPct / 100);
                    rem = Math.max(0, totalMin * (1 - pick.pct / 100));
                } else if (cur?.watchTime) {
                    rem = cur.watchTime / 60;
                }
            }
            
            if (rem != null) rem = Math.round(rem * 10) / 10;
            return { ...out, hasWatchDrops: true, rem, pct: pick.pct, claimReady: false };
        }

        if (cur?.watchTime && cur.watchTime > 0) {
            const rem = cur.watchTime / 60;
            const pct = cur.currentPct != null ? cur.currentPct : 0;
            Logger.info(`Fallback из очереди: rem=${rem.toFixed(1)} мин, pct=${pct}`, 2);
            return { ...out, hasWatchDrops: true, rem: Math.round(rem * 10) / 10, pct, claimReady: false };
        }

        return out;
    };

    const ensureDropsPanel = () => {
        const body = document.body.textContent || '';
        if (/drops и прочее|drops and more|drops для подписки/i.test(body)) return true;
        const btn = document.querySelector('[data-a-target="drops-overlay-button"], button[aria-label*="drops" i], button[aria-label*="дроп" i]');
        if (btn) { btn.click(); return true; }
        return false;
    };

    const onStream = async () => {
        const cur = State.farm.current;
        if (!cur || State.farm.phase !== 'watch') { State.farm.phase = 'idle'; State.farm.current = null; State.saveFarm(); return; }

        if (!rt.setupDone) {
            rt.setupDone = true;
            await Utils.sleep(2500);
            const video = document.querySelector('video');
            if (video) {
                video.muted = CONFIG.muted;
                video.play().catch(() => {});
                video.addEventListener('pause', () => {
                    if (State.isRunning() && State.farm.phase === 'watch') setTimeout(() => { if (video.paused) video.play().catch(() => {}); }, 1000);
                });
            }
            const overlay = document.querySelector('button[aria-label*="Play" i], [data-a-target="player-overlay-click-handler"]');
            if (overlay && (!video || !video.currentTime)) overlay.click();
            Logger.farm(`Просмотр: ${cur.game}`);
            
            // [FIX] Открываем панель Drops ПЕРЕД checkActiveDrops, чтобы Twitch сделал GQL запрос
            await Utils.sleep(2000);
            ensureDropsPanel();
            Logger.info('Ожидание перехвата GQL операции...');
            await Utils.sleep(3000); // Даем время Twitch сделать запрос и интерсептору его перехватить
            
            const drops = await checkActiveDrops(cur.game);
            if (!drops.hasWatchDrops) { rt.syncAttempts = 0; }
            else {
                rt.domRemaining = drops.rem; rt.domPct = drops.pct;
                
                // [FIX] Обновляем cur.watchTime на основе синхронизации
                if (drops.rem != null) {
                    cur.watchTime = drops.rem * 60;
                    State.saveFarm();
                }
                
                if (!rt.estRequired && cur.startedAt && drops.rem != null) rt.estRequired = drops.rem + (Date.now() - cur.startedAt) / 60000;
                rt.lastSync = Date.now();
                Logger.farm(`Прогресс ${cur.game}: ${drops.pct != null ? Math.round(drops.pct) + '%, ' : ''}ещё ${drops.rem != null ? drops.rem.toFixed(1) : '?'} мин`);
            }
            if (!rt.countdownInterval) rt.countdownInterval = setInterval(() => { if (rt.domRemaining != null) GUI.updateFarmStatus(); }, 1000);
        }

        if (!rt.catChecked) {
            rt.catChecked = true;
            const cat = (document.querySelector('main') || document).querySelector('a[href^="/directory/"]');
            const catSlug = cat?.getAttribute('href')?.match(/\/directory\/(?:category|game)\/([^?/]+)/)?.[1];
            if (catSlug && cur.slug && catSlug !== cur.slug) return rotate(`категория ${catSlug} != ${cur.slug}`);
        }

        if (document.querySelector('[data-a-target="offline-screen-text"], .offline-recommendation-video')) return rotate('стрим офлайн');

        const video = document.querySelector('video');
        if (video && !document.hidden) {
            if (video.paused || video.ended) video.play().catch(() => {});
            if (video.readyState <= 2) {
                rt.stuck++;
                if (rt.stuck >= 20) {
                    rt.stuck = 0;
                    if (!rt.reloaded) { rt.reloaded = true; Logger.warn('Плеер завис — перезагрузка'); location.reload(); }
                    else return rotate('плеер не играет');
                }
            } else rt.stuck = 0;
        } else if (document.hidden) rt.stuck = 0;

        if (CONFIG.streamRotationMin > 0 && cur.startedAt && (Date.now() - cur.startedAt) / 60000 >= CONFIG.streamRotationMin) return rotate('плановая ротация');

        if (Date.now() - rt.lastCheck > 10000) {
            rt.lastCheck = Date.now();
            const now = Date.now();
            if (now - rt.lastSync > 120000 || rt.domRemaining === null || rt.domRemaining <= 1) {
                // [FIX] Переоткрываем панель перед синхронизацией
                ensureDropsPanel();
                await Utils.sleep(2000); // Даем время для GQL запроса
                
                const drops = await checkActiveDrops(cur.game);
                rt.lastSync = now;
                
                // [FIX] Обновляем cur.watchTime при каждой синхронизации
                if (drops.hasWatchDrops && drops.rem != null) {
                    cur.watchTime = drops.rem * 60;
                    State.saveFarm();
                }
                
                if (!drops.hasWatchDrops) {
                    if (!drops.panelOpen) {
                        Logger.info('Панель Drops закрыта — переоткрою на следующем тике');
                    } else {
                        const onStreamMs = now - (cur.startedAt || now);
                        if (onStreamMs > 45000 && now - (rt.lastAttempt || 0) > 20000) {
                            rt.lastAttempt = now; rt.syncAttempts = (rt.syncAttempts || 0) + 1;
                            Logger.warn(`Нет watch-дропов (попытка ${rt.syncAttempts}/5)`);
                        }
                        if (rt.syncAttempts >= 5) {
                            Logger.warn(`${cur.game}: нет watch-дропов — пропуск (nowatch 1ч)`);
                            if (!State.farm.done.includes(cur.game)) State.farm.done.push(cur.game);
                            State.doneSet(cur.game, 'nowatch'); State.saveFarm();
                            nextFromQueue(); return;
                        }
                    }
                } else {
                    rt.syncAttempts = 0; rt.domRemaining = drops.rem; rt.domPct = drops.pct;
                    if (drops.pct != null && drops.pct > 0 && drops.rem != null) rt.estRequired = drops.rem / (1 - drops.pct / 100);
                    const sig = `${Math.round(drops.pct || 0)}|${drops.rem}`;
                    if (sig !== rt.prevSig) { rt.prevSig = sig; Logger.farm(`Синхронизация ${cur.game}: ${drops.pct != null ? Math.round(drops.pct) + '%, ' : ''}ещё ${drops.rem != null ? drops.rem.toFixed(1) : '?'} мин`); }
                    if ((drops.rem != null && drops.rem <= 0) || (drops.pct != null && drops.pct >= 100)) return finishWatch();
                }
            }
        }

        if (!rt.lastActivity || Date.now() - rt.lastActivity > 120000) {
            rt.lastActivity = Date.now();
            if (video) {
                const rect = video.getBoundingClientRect();
                video.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
                video.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                if (video.paused || video.ended) video.play().catch(() => {});
            }
        }
    };

    const rotate = reason => {
        if (rt.countdownInterval) { clearInterval(rt.countdownInterval); rt.countdownInterval = null; }
        const cur = State.farm.current;
        if (cur?.streamUrl) {
            const t = State.farm.tried[cur.game] || (State.farm.tried[cur.game] = []);
            if (!t.includes(cur.streamUrl)) t.push(cur.streamUrl);
        }
        Logger.warn(`Ротация: ${reason}`);
        State.farm.phase = 'dir';
        if (cur) { cur.streamUrl = null; cur.startedAt = null; }
        rt.setupDone = false; rt.catChecked = false; rt.domRemaining = null; rt.domPct = null; rt.estRequired = 0; rt.prevSig = '';
        State.saveFarm(); GUI.updateFarmStatus();
        Nav.go(`https://www.twitch.tv/directory/category/${cur.slug}?filter=drops`, true);
    };

    const finishWatch = () => {
        if (rt.countdownInterval) { clearInterval(rt.countdownInterval); rt.countdownInterval = null; }
        const cur = State.farm.current;
        const claimBtn = [...document.querySelectorAll('[data-a-target="tw-core-button-label-text"]')].find(el => /^получить$/i.test((el.textContent || '').trim()));
        if (claimBtn) {
            const parent = claimBtn.closest('button, a');
            if (parent) {
                parent.click();
                State.bumpStat('claimed');
                Logger.success(`🎁 Дроп получен: ${cur?.game}`); GUI.toast(`🎁 ${cur?.game || ''}`);
                if (cur) { if (!State.farm.done.includes(cur.game)) State.farm.done.push(cur.game); State.doneSet(cur.game); }
                State.saveFarm();
                setTimeout(() => nextFromQueue(), 2000);
                return;
            }
        }
        if (cur) { if (!State.farm.done.includes(cur.game)) State.farm.done.push(cur.game); State.doneSet(cur.game); }
        State.saveFarm();
        Logger.success('Дроп завершён — идём за наградой');
        State.farm.phase = 'claim'; State.saveFarm();
        Nav.go(INVENTORY_URL, true);
    };

    const parseViewers = card => {
        const el = [...card.querySelectorAll('span,div,p')].find(e => /зрител|viewer/i.test(e.textContent) && e.textContent.length < 40);
        if (!el) return 0;
        const m = el.textContent.match(/([\d.,]+)\s*(тыс\.?|K|млн\.?|M)?/i);
        if (!m) return 0;
        let v = parseFloat(m[1].replace(',', '.'));
        const u = (m[2] || '').toLowerCase();
        if (u.startsWith('тыс') || u === 'k') v *= 1e3;
        if (u.startsWith('млн') || u === 'm') v *= 1e6;
        return v;
    };

    const parseStreamsDOM = (preferred = []) => {
        const scope = document.querySelector('main') || document;
        const out = [], seen = new Set();
        for (const ch of preferred) {
            if (seen.has(ch)) continue;
            const link = scope.querySelector(`a[href="/${ch}"]`);
            if (link) {
                const card = link.closest('article') || link.parentElement?.parentElement;
                if (card && card.querySelector('img, video')) { seen.add(ch); out.push({ url: `https://www.twitch.tv/${ch}`, viewers: parseViewers(card), isPreferred: true }); }
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

    const getStreams = async (slug, preferred = []) => {
        if (CONFIG.useGraphQL && TokenManager.isValid()) {
            const res = await ReplayEngine.execute('DirectoryPage_Game', { name: slug, limit: 50 });
            if (res.ok) {
                const edges = res.data?.game?.streams?.edges || [];
                const streams = edges.map(e => ({
                    url: `https://www.twitch.tv/${e.node?.creator?.login || e.node?.broadcaster?.login}`,
                    viewers: e.node?.viewersCount || 0,
                    isPreferred: preferred.includes(e.node?.creator?.login)
                })).filter(s => s.url && !s.url.endsWith('undefined'));
                if (streams.length) {
                    Logger.gql(`Стримы через GQL: ${streams.length}`);
                    return streams.sort((a, b) => (b.isPreferred - a.isPreferred) || (b.viewers - a.viewers));
                }
            }
        }
        State.bumpStat('domFallbacks');
        return parseStreamsDOM(preferred);
    };

    const onDirectory = async () => {
        const f = State.farm;
        if (!f.current) { f.phase = 'idle'; State.saveFarm(); return; }
        Logger.farm(`Поиск стримов: ${f.current.game}`);
        const channels = f.current.channels || [];
        let streams = [];
        for (let i = 0; i < 6 && !streams.length; i++) { streams = await getStreams(f.current.slug, channels); if (!streams.length) await Utils.sleep(2000); }
        const withV = streams.filter(s => s.viewers > 0);
        if (withV.length) streams = withV.filter(s => s.viewers >= CONFIG.minViewers);

        const tried = f.tried[f.current.game] || (f.tried[f.current.game] = []);
        const pick = streams.find(s => !tried.includes(s.url));
        if (!pick) {
            if (streams.length) {
                Logger.warn('Все стримы перепробованы — сброс tried');
                f.tried[f.current.game] = [];
                const retry = streams[0];
                f.tried[f.current.game].push(retry.url);
                f.current.streamUrl = retry.url; f.current.startedAt = Date.now(); f.phase = 'watch';
                rt.setupDone = false; rt.catChecked = false;
                State.saveFarm(); Nav.go(retry.url, true); return;
            }
            Logger.warn(`Нет стримов для ${f.current.game}`);
            nextFromQueue(); return;
        }
        tried.push(pick.url);
        f.current.streamUrl = pick.url; f.current.startedAt = Date.now(); f.phase = 'watch';
        rt.setupDone = false; rt.catChecked = false; rt.domRemaining = null; rt.domPct = null; rt.estRequired = 0; rt.prevSig = '';
        State.saveFarm(); State.bumpStat('streams');
        Logger.farm(`Переход на стрим: ${pick.url} (${pick.viewers} зрит.)`);
        Nav.go(pick.url, true);
    };

    const tryClaimReadyDrops = async () => {
        let claimed = 0;
        const scope = document.querySelector('main') || document;
        const btns = [
            ...scope.querySelectorAll('button[data-a-target="claim-drop-button"], button[data-a-target="DropsClaimButton"]'),
            ...[...scope.querySelectorAll('button')].filter(b => /^(получить сейчас|claim now|получить|claim)$/i.test((b.textContent || '').trim()))
        ];
        for (const b of btns) { b.click(); claimed++; State.bumpStat('claimed'); await Utils.sleep(1200); }
        if (claimed) { Logger.success(`Получено наград: ${claimed}`); GUI.toast(`🎁 Получено: ${claimed}`); await Utils.sleep(2000); }
        return claimed;
    };

    const handleConnections = pending => {
        if (!pending.length) return;
        const fresh = pending.filter(p => !notifiedConnections.has(p.game));
        fresh.forEach(p => { notifiedConnections.add(p.game); Logger.warn(`⚠ Требуется подключение: ${p.game}`); });
        if (fresh.length) GUI.toast(`⚠ Подключите: ${fresh.map(p => p.game).join(', ')}`);
        const target = pending.find(p => p.url);
        if (!target) return;
        const key = 'taf_conn_' + target.url;
        if (Date.now() - (+sessionStorage.getItem(key) || 0) < CONFIG.connectCooldownMin * 60000) return;
        sessionStorage.setItem(key, String(Date.now()));
        if (CONFIG.connectMode === 'redirect') setTimeout(() => location.assign(target.url), 2000);
        else if (CONFIG.connectMode === 'open') window.open(target.url, '_blank');
    };

    const onInventory = async (force = false) => {
        const f = State.farm;
        const now = Date.now();
        if (!force && f.phase === 'idle' && now - (f.lastInventoryScan || 0) < 45000) return;
        f.lastInventoryScan = now; State.saveFarm();

        Logger.farm('Проверка инвентаря...');
        await Utils.sleep(2000);
        await tryClaimReadyDrops();

        let campaigns = [];
        if (CONFIG.useGraphQL && TokenManager.isValid()) {
            const res = await ReplayEngine.execute('Inventory');
            if (res.ok) { campaigns = parseInventoryGQL(res.data); if (campaigns.length) Logger.gql(`Инвентарь через GQL: ${campaigns.length}`); }
        }
        if (!campaigns.length) { campaigns = parseInventoryDOM(); }

        if (campaigns.length) {
            Logger.farm(`Активных дропов: ${campaigns.length}`);
            f.queue = campaigns; f.tried = {}; f.phase = 'dir'; State.saveFarm();
            GUI.updateQueue();
            nextFromQueue();
            return;
        }
        Logger.info('Нет активных дропов — idle');
        f.phase = 'idle'; f.current = null; State.saveFarm();
        GUI.updateFarmStatus();
    };

    const nextFromQueue = () => {
        const f = State.farm;
        const next = f.queue.shift();
        GUI.updateQueue();
        if (!next) {
            f.phase = 'idle'; f.current = null; f.lastInventoryScan = 0;
            State.saveFarm(); GUI.updateFarmStatus();
            Logger.system('Очередь пуста — проверка инвентаря');
            Nav.go(INVENTORY_URL, true);
            return;
        }
        f.current = { ...next, streamUrl: null, startedAt: null };
        f.phase = 'dir'; State.saveFarm(); GUI.updateFarmStatus();
        Nav.go(`https://www.twitch.tv/directory/category/${next.slug}?filter=drops`, true);
    };

    let tickBusy = false;
    const tick = async () => {
        if (!State.isRunning() || tickBusy) return;
        tickBusy = true;
        try {
            const p = location.pathname, f = State.farm;

            if (f.phase === 'watch') {
                if (isStreamPage()) await onStream();
                else if (f.current?.streamUrl) Nav.go(f.current.streamUrl, true);
                else { f.phase = 'idle'; State.saveFarm(); }
            }
            else if (f.phase === 'dir') {
                if (p.startsWith('/directory/')) await onDirectory();
                else if (f.current?.slug) Nav.go(`https://www.twitch.tv/directory/category/${f.current.slug}?filter=drops`, true);
                else { f.phase = 'idle'; State.saveFarm(); }
            }
            else if (f.phase === 'claim') {
                if (p.startsWith('/drops/inventory')) { await tryClaimReadyDrops(); f.phase = 'idle'; f.current = null; State.saveFarm(); }
                else Nav.go(INVENTORY_URL, true);
            }
            else {
                if (p.startsWith('/drops/inventory')) await onInventory();
                else if (p.startsWith('/drops/campaigns')) await onCampaigns();
                if (f.phase === 'idle') idleSchedule(p);
            }
        } catch (e) { Logger.error('Tick: ' + e.message); }
        finally { tickBusy = false; }
    };

    const idleSchedule = p => {
        const f = State.farm, now = Date.now();
        if (isStreamPage() && document.querySelector('video')) return;
        if (now - (f.lastInventoryScan || 0) > 5 * 60 * 1000 && !p.startsWith('/drops/inventory')) { Nav.go(INVENTORY_URL); return; }
        if (now - (f.lastCampaignScan || 0) > 10 * 60 * 1000 && !p.startsWith('/drops/campaigns')) { Nav.go(CAMPAIGNS_URL); return; }
    };

    const hookHistory = () => {
        const wrap = fn => function (...args) { const r = fn.apply(this, args); setTimeout(tick, 1000); return r; };
        try { history.pushState = wrap(history.pushState); history.replaceState = wrap(history.replaceState); } catch { }
        window.addEventListener('popstate', () => setTimeout(tick, 1000));
    };

    const start = () => {
        GUI = createGUI();
        window.GUI = GUI;
        Logger.system('🤖 TAF Autonomous v4.2.1 загружен');

        window.TAF_DEBUG = () => {
            const bars = [...document.querySelectorAll('[role="progressbar"][aria-valuenow]')].map(b => ({
                pct: b.getAttribute('aria-valuenow'),
                vt: b.getAttribute('aria-valuetext'),
                around: (b.parentElement?.parentElement?.textContent || '').slice(0, 140)
            }));
            const titles = [...document.querySelectorAll('[title]')]
                .map(e => ({ tag: e.tagName, title: e.title }))
                .filter(x => /мин|ч\.|hour|min|смотрите|watch/i.test(x.title)).slice(0, 12);
            console.table(bars); console.table(titles);
            return { bars, titles, panelOpen: /drops и прочее|drops and more/i.test(document.body.textContent || '') };
        };

        hookHistory();
        GUI.updateStats(); GUI.updateQueue(); GUI.updateFarmStatus(); GUI.updateOps();
        EventBus.on('op:captured', () => GUI.updateOps());

        let uptime = 0;
        setInterval(() => {
            if (State.isRunning()) { GUI.$('TAF-uptime').textContent = 'Uptime: ' + Utils.fmtUptime(++uptime); GUI.updateFarmStatus(); }
        }, 1000);

        setInterval(() => {
            if (State.isRunning() && State.farm.phase === 'watch') {
                const v = document.querySelector('video');
                if (v) { if (v.paused || v.ended) v.play().catch(() => {}); if (v.muted !== CONFIG.muted) v.muted = CONFIG.muted; }
            }
        }, 30000);

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && State.isRunning() && State.farm.phase === 'watch') {
                const v = document.querySelector('video');
                if (v && (v.paused || v.ended)) v.play().catch(() => {});
                rt.stuck = 0; rt.reloaded = false;
            }
        });

        EventBus.on('toggle:click', on => {
            State.setRunning(on); GUI.setRunningUI(on);
            Logger.system(on ? '▶ Started' : '⏸ Stopped');
            if (on) setTimeout(tick, 500);
        });

        setInterval(tick, 15000);

        if (State.isRunning()) { GUI.setRunningUI(true); Logger.system('♻️ Возобновляю'); setTimeout(tick, 2500); }
        else if (localStorage.getItem('taf_configured') === '1' && CONFIG.autoStart) { State.setRunning(true); GUI.setRunningUI(true); Logger.system('🚀 Автостарт'); setTimeout(tick, 500); }
        else { GUI.$('TAF-status-text').textContent = 'Stopped — press START'; Logger.system('⏸ Нажми START'); }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else if (!document.body) document.addEventListener('DOMContentLoaded', start);
    else start();
})();