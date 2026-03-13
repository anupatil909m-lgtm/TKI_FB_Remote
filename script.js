// ================================================================
//  Device_Tch  Dashboard  script.js  v3.0
//
//  Firebase DB structure (Required_Firebase_Database_Structure):
//    /users/{userId}/devices/{deviceId}/
//      relays/
//        relay1/ state: int(1/0),  name: "Relay 1"
//        relay2/ state: int(1/0),  name: "Relay 2"
//        relay3/ state: int(1/0),  name: "Relay 3"
//        relay4/ state: int(1/0),  name: "Relay 4"
//      status/
//        last_seen: timestamp
//      timers/
//        {id}/ relay: "relay1"…"relay4"
//              action: "ON"|"OFF"
//              startTime: "HH:MM"
//              endTime:   "HH:MM"|null
//              days:      bool[7] 0=Mon…6=Sun
//              active:    bool
//
//  Auth: Option C — status is publicly readable (heartbeat pre-auth)
//                   relays + timers require auth.uid === userId
//
//  Config stored in localStorage:
//    { apiKey, databaseURL, userId, deviceId }
//
//  Path helper:  devBase = "users/{userId}/devices/{deviceId}"
// ================================================================

'use strict';

// ── State ──────────────────────────────────────────────────────────
let db                    = null;
let auth                  = null;
let relays                = {};   // { relay1: {state,name}, relay2: … }
let timers                = {};
let devBase               = '';   // users/{userId}/devices/{deviceId}
let currentEditingTimerId = null;
let lastSeenTimestamp     = 0;
let heartbeatListenerOn   = false;

const IST       = 'Asia/Kolkata';
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── DOM refs ───────────────────────────────────────────────────────
const $loading     = document.getElementById('loading');
const $configSect  = document.getElementById('configSection');
const $loginSect   = document.getElementById('loginSection');
const $relaysSect  = document.getElementById('relaysSection');
const $timersSect  = document.getElementById('timersSection');
const $connStatus  = document.getElementById('connectionStatus');
const $lastSeen    = document.getElementById('lastSeen');
const $timeBar     = document.getElementById('timeBar');
const $userBadge   = document.getElementById('userBadge');
const $settingsBtn = document.getElementById('settingsBtn');
const $logoutBtn   = document.getElementById('logoutBtn');

const showLoading = () => $loading.style.display = 'flex';
const hideLoading = () => $loading.style.display = 'none';

// ── Path builders ──────────────────────────────────────────────────
const pRelays  = ()           => `${devBase}/relays`;
const pRelay   = (key)        => `${devBase}/relays/${key}`;
const pState   = (key)        => `${devBase}/relays/${key}/state`;
const pStatus  = ()           => `${devBase}/status/last_seen`;
const pTimers  = ()           => `${devBase}/timers`;
const pTimer   = (id)         => `${devBase}/timers/${id}`;

// ================================================================
//  STARTUP
// ================================================================
window.onload = () => {
    const raw = localStorage.getItem('firebaseConfig');
    if (raw) {
        try {
            const cfg = JSON.parse(raw);
            if (cfg.apiKey && cfg.databaseURL && cfg.userId && cfg.deviceId) {
                $configSect.style.display = 'none';
                initFirebaseApp(cfg);
            } else {
                prefillConfigForm(cfg);
                hideLoading();
            }
        } catch(e) { hideLoading(); }
    } else {
        hideLoading();
    }

    setInterval(updateCurrentTime, 1000);
    updateCurrentTime();
    setInterval(updateHeartbeatUI, 1000);
};

function updateCurrentTime() {
    document.getElementById('currentTime').textContent =
        moment().tz(IST).format('DD/MM/YYYY  HH:mm:ss');
}

function prefillConfigForm(cfg) {
    if (cfg.apiKey)      document.getElementById('apiKey').value      = cfg.apiKey;
    if (cfg.databaseURL) document.getElementById('databaseURL').value = cfg.databaseURL;
    if (cfg.userId)      document.getElementById('userId').value      = cfg.userId;
    if (cfg.deviceId)    document.getElementById('deviceId').value    = cfg.deviceId;
}

// ================================================================
//  STEP 1 — Firebase Config form  (first visit only)
// ================================================================
document.getElementById('configForm').addEventListener('submit', e => {
    e.preventDefault();
    const cfg = {
        apiKey      : document.getElementById('apiKey').value.trim(),
        databaseURL : document.getElementById('databaseURL').value.trim(),
        userId      : document.getElementById('userId').value.trim(),
        deviceId    : document.getElementById('deviceId').value.trim(),
    };
    if (!cfg.apiKey || !cfg.databaseURL || !cfg.userId || !cfg.deviceId) {
        return alert('Please fill all four fields.');
    }
    localStorage.setItem('firebaseConfig', JSON.stringify(cfg));
    $configSect.style.display = 'none';
    initFirebaseApp(cfg);
});

// ================================================================
//  FIREBASE APP INIT
// ================================================================
function initFirebaseApp(cfg) {
    showLoading();
    // Build the base path for this specific device
    devBase = `users/${cfg.userId}/devices/${cfg.deviceId}`;
    console.log('📂 devBase:', devBase);

    try {
        if (firebase.apps.length > 0) firebase.apps.forEach(a => a.delete());
        firebase.initializeApp({ apiKey: cfg.apiKey, databaseURL: cfg.databaseURL });
        auth = firebase.auth();
        db   = firebase.database();

        // Start heartbeat immediately — status/last_seen is publicly readable
        startHeartbeatListener();
        $connStatus.style.display = 'block';
        $timeBar.style.display    = 'block';

        auth.onAuthStateChanged(user => {
            hideLoading();
            if (user) onSignedIn(user, cfg);
            else      onSignedOut();
        });
    } catch (err) {
        hideLoading();
        alert('Firebase init failed: ' + err.message);
    }
}

// ================================================================
//  HEARTBEAT  —  starts before auth (status node is public)
// ================================================================
function startHeartbeatListener() {
    if (heartbeatListenerOn || !db) return;
    heartbeatListenerOn = true;

    db.ref(pStatus()).on('value', snap => {
        if (snap.exists()) {
            lastSeenTimestamp = snap.val();
            updateHeartbeatUI();
        }
    }, err => console.warn('Heartbeat error:', err.message));
}

// ================================================================
//  STEP 2 — Email / Password sign-in
// ================================================================
document.getElementById('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    showLoading();
    const email  = document.getElementById('loginEmail').value.trim();
    const pass   = document.getElementById('loginPassword').value;
    const errEl  = document.getElementById('loginError');
    errEl.style.display = 'none';

    auth.signInWithEmailAndPassword(email, pass)
        .catch(err => {
            hideLoading();
            errEl.style.display = 'block';
            errEl.textContent   = friendlyAuthError(err.code);
        });
});

function friendlyAuthError(code) {
    const map = {
        'auth/user-not-found'        : 'No account found with this email.',
        'auth/wrong-password'        : 'Incorrect password. Please try again.',
        'auth/invalid-email'         : 'Please enter a valid email address.',
        'auth/too-many-requests'     : 'Too many attempts. Please wait and try again.',
        'auth/network-request-failed': 'Network error. Check your connection.',
        'auth/invalid-credential'    : 'Invalid email or password.',
    };
    return map[code] || 'Sign-in failed. Please check your credentials.';
}

// ================================================================
//  AUTH STATE HANDLERS
// ================================================================
function onSignedIn(user, cfg) {
    $loginSect.style.display   = 'none';
    $configSect.style.display  = 'none';
    $relaysSect.style.display  = 'block';
    $timersSect.style.display  = 'block';
    $connStatus.style.display  = 'block';
    $timeBar.style.display     = 'block';
    $userBadge.style.display   = 'flex';
    $settingsBtn.style.display = 'flex';
    $logoutBtn.style.display   = 'flex';
    $lastSeen.style.display    = 'none';

    $userBadge.innerHTML =
        `<span><i class="fas fa-user-circle"></i>&nbsp;${user.email}</span>` +
        `<span class="device-chip"><i class="fas fa-microchip"></i>&nbsp;${cfg.deviceId}</span>`;

    startProtectedListeners();
    startTimerScheduler();
}

function onSignedOut() {
    // Remove protected listeners; keep heartbeat (status is public)
    if (db) {
        db.ref(pRelays()).off();
        db.ref(pTimers()).off();
    }
    relays = {};
    timers = {};

    $loginSect.style.display   = 'block';
    $relaysSect.style.display  = 'none';
    $timersSect.style.display  = 'none';
    $connStatus.style.display  = 'block';  // stays — shows online/offline on login screen
    $timeBar.style.display     = 'block';
    $userBadge.style.display   = 'none';
    $settingsBtn.style.display = 'none';
    $logoutBtn.style.display   = 'none';

    document.getElementById('loginForm').reset();
    document.getElementById('loginError').style.display = 'none';
}

function signOut() {
    showLoading();
    auth.signOut().then(hideLoading).catch(hideLoading);
}

// ================================================================
//  PROTECTED LISTENERS  (require auth)
//  Paths: devBase/relays  and  devBase/timers
// ================================================================
function startProtectedListeners() {
    // relays listener — structure: { relay1: {state, name}, relay2: … }
    db.ref(pRelays()).on('value', snap => {
        relays = snap.val() || {};
        renderRelays();
        populateTimerRelaySelect();
        hideLoading();
    }, err => { hideLoading(); console.error('relays error:', err.message); });

    // timers listener
    db.ref(pTimers()).on('value', snap => {
        timers = snap.val() || {};
        renderTimers();
    });
}

// ================================================================
//  RENDER RELAYS
//  Each relay object: { state: 1|0, name: "Relay 1" }
//  DB key: relay1, relay2, relay3, relay4
// ================================================================
function renderRelays() {
    const container = document.getElementById('relaysContainer');
    container.innerHTML = '';

    // Sort by relay key: relay1 < relay2 < relay3 < relay4
    const keys = Object.keys(relays).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
    );

    if (keys.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-plug"></i>
                <p>No relays found in database</p>
            </div>`;
        return;
    }

    keys.forEach(key => {
        const r     = relays[key] || {};
        const isOn  = r.state === 1 || r.state === true;
        const label = r.name  || key;   // fall back to key if name missing

        const card = document.createElement('div');
        card.className = `device-card ${isOn ? 'active' : ''}`;
        card.innerHTML = `
            <div class="device-info">
                <div class="icon-box">
                    <i class="fas fa-${isOn ? 'lightbulb' : 'power-off'}"></i>
                </div>
                <div class="device-name">${label}</div>
                <div class="device-key">${key}</div>
                <div class="device-status">${isOn ? 'On' : 'Off'}</div>
            </div>
            <label class="switch">
                <input type="checkbox"
                    onchange="toggleRelay('${key}', this.checked)"
                    ${isOn ? 'checked' : ''}>
                <span class="slider"></span>
            </label>`;
        container.appendChild(card);
    });
}

// Write  devBase/relays/relayN/state = 1 or 0
function toggleRelay(key, checked) {
    showLoading();
    db.ref(pState(key)).set(checked ? 1 : 0)
        .then(hideLoading)
        .catch(err => { hideLoading(); alert('Error: ' + err.message); });
}

// ================================================================
//  RENDER TIMERS
//  timer.relay = "relay1"…"relay4"  (DB key)
//  Display name resolved from relays[relay].name if available
// ================================================================
function renderTimers() {
    const container = document.getElementById('timersContainer');
    container.innerHTML = '';

    const ids = Object.keys(timers);
    if (ids.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-clock"></i>
                <p>No timers configured yet</p>
            </div>`;
        return;
    }

    ids.forEach(id => {
        const t = timers[id];
        if (!t || !t.relay) return;

        const relayLabel = (relays[t.relay] && relays[t.relay].name)
            ? relays[t.relay].name
            : t.relay;

        const activeDays  = Array.isArray(t.days)
            ? t.days.map((on, i) => on ? DAY_NAMES[i] : null).filter(Boolean).join(', ')
            : '—';
        const timeRange   = t.endTime ? `${t.startTime} → ${t.endTime}` : t.startTime;
        const actionBadge = t.action === 'ON'
            ? '<span class="badge badge-on">ON</span>'
            : '<span class="badge badge-off">OFF</span>';

        const card = document.createElement('div');
        card.className = `timer-card ${t.active ? 'active-timer' : 'inactive-timer'}`;
        card.innerHTML = `
            <div class="timer-relay-label">
                <i class="fas fa-toggle-on"></i> ${relayLabel} ${actionBadge}
            </div>
            <div class="timer-meta"><i class="fas fa-clock"></i> ${timeRange}</div>
            <div class="timer-meta"><i class="fas fa-calendar-alt"></i> ${activeDays}</div>
            <div class="timer-actions">
                <button class="btn-edit"   onclick="editTimer('${id}')">
                    <i class="fas fa-edit"></i> Edit
                </button>
                <button class="btn-delete" onclick="deleteTimer('${id}')">
                    <i class="fas fa-trash"></i> Delete
                </button>
            </div>`;
        container.appendChild(card);
    });
}

// ================================================================
//  TIMER MODAL
// ================================================================
function populateTimerRelaySelect() {
    const sel = document.getElementById('timerRelay');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select relay...</option>';
    Object.keys(relays).sort().forEach(key => {
        const opt   = document.createElement('option');
        opt.value   = key;
        opt.text    = (relays[key] && relays[key].name) ? `${relays[key].name} (${key})` : key;
        sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
}

function openTimerModal() {
    currentEditingTimerId = null;
    document.getElementById('modalTitle').innerHTML = '<i class="fas fa-clock"></i> Add Timer';
    document.getElementById('timerForm').reset();
    resetDays();
    populateTimerRelaySelect();
    document.getElementById('timerModal').style.display = 'flex';
}

function closeTimerModal() {
    document.getElementById('timerModal').style.display = 'none';
    currentEditingTimerId = null;
}

function editTimer(id) {
    const t = timers[id];
    if (!t) return;
    currentEditingTimerId = id;
    document.getElementById('modalTitle').innerHTML = '<i class="fas fa-edit"></i> Edit Timer';
    populateTimerRelaySelect();
    document.getElementById('timerRelay').value     = t.relay     || '';
    document.getElementById('timerAction').value    = t.action    || '';
    document.getElementById('timerStartTime').value = t.startTime || '';
    document.getElementById('timerEndTime').value   = t.endTime   || '';
    resetDays();
    if (Array.isArray(t.days)) t.days.forEach((on, i) => { if (on) activateDay(i); });
    document.getElementById('timerModal').style.display = 'flex';
}

function deleteTimer(id) {
    if (!confirm('Delete this timer?')) return;
    showLoading();
    db.ref(pTimer(id)).remove()
        .then(hideLoading)
        .catch(err => { hideLoading(); alert('Error: ' + err.message); });
}

function resetDays() {
    for (let i = 0; i < 7; i++) {
        const cb = document.getElementById('day' + i);
        cb.checked = false;
        cb.parentElement.classList.remove('active');
    }
}
function activateDay(i) {
    const cb = document.getElementById('day' + i);
    cb.checked = true;
    cb.parentElement.classList.add('active');
}
function toggleDay(i) {
    const cb = document.getElementById('day' + i);
    cb.checked = !cb.checked;
    cb.parentElement.classList.toggle('active', cb.checked);
}

// ================================================================
//  SAVE TIMER
//  Stores relay as relayKey ("relay1"…) matching the DB key
// ================================================================
document.getElementById('timerForm').addEventListener('submit', e => {
    e.preventDefault();
    showLoading();
    const relay     = document.getElementById('timerRelay').value;
    const action    = document.getElementById('timerAction').value;
    const startTime = document.getElementById('timerStartTime').value;
    const endTime   = document.getElementById('timerEndTime').value || null;

    if (!relay || !action || !startTime) {
        hideLoading();
        return alert('Please fill relay, action, and start time.');
    }
    const days = [];
    for (let i = 0; i < 7; i++) days.push(document.getElementById('day' + i).checked);
    if (!days.some(Boolean)) { hideLoading(); return alert('Select at least one day.'); }

    const data = { relay, action, startTime, endTime, days, active: true };
    const path = currentEditingTimerId
        ? pTimer(currentEditingTimerId)
        : pTimer(db.ref(pTimers()).push().key);

    db.ref(path).set(data)
        .then(() => { applyTimerNow(data); hideLoading(); closeTimerModal(); })
        .catch(err => { hideLoading(); alert('Error: ' + err.message); });
});

// ================================================================
//  TIMER SCHEDULER  — runs every 30 s
// ================================================================
function startTimerScheduler() {
    checkTimers();
    setInterval(checkTimers, 30000);
}

function checkTimers() {
    if (!db || !auth || !auth.currentUser) return;
    const now      = moment().tz(IST);
    const todayIdx = (now.day() + 6) % 7;
    let nextTimer = null, nextTimerDate = null;

    Object.entries(timers).forEach(([, t]) => {
        if (!t || !t.active || !t.relay || !t.startTime) return;
        if (!Array.isArray(t.days) || !t.days[todayIdx]) return;
        if (!relays.hasOwnProperty(t.relay)) return;

        const start = moment.tz(
            `${now.format('YYYY-MM-DD')} ${t.startTime}`, 'YYYY-MM-DD HH:mm', IST);
        let end = t.endTime
            ? moment.tz(`${now.format('YYYY-MM-DD')} ${t.endTime}`, 'YYYY-MM-DD HH:mm', IST)
            : null;
        if (end && end.isBefore(start)) end.add(1, 'day');

        if (now.isSameOrAfter(start) && (!end || now.isBefore(end))) {
            db.ref(pState(t.relay)).set(t.action === 'ON' ? 1 : 0);
        } else if (end && now.isSameOrAfter(end)) {
            db.ref(pState(t.relay)).set(t.action === 'ON' ? 0 : 1);
        }
    });

    // Find next upcoming timer for banner
    for (let offset = 0; offset < 7; offset++) {
        const cd  = moment(now).add(offset, 'days');
        const cdi = (cd.day() + 6) % 7;
        Object.entries(timers).forEach(([, t]) => {
            if (!t || !t.active || !t.relay || !t.startTime) return;
            if (!Array.isArray(t.days) || !t.days[cdi]) return;
            const start = moment.tz(
                `${cd.format('YYYY-MM-DD')} ${t.startTime}`, 'YYYY-MM-DD HH:mm', IST);
            if (offset === 0 && start.isSameOrBefore(now)) return;
            if (!nextTimer || start.isBefore(nextTimerDate)) {
                nextTimer = t; nextTimerDate = start;
            }
        });
        if (nextTimer) break;
    }

    const el = document.getElementById('nextTimer');
    if (nextTimer && nextTimerDate) {
        const label = (relays[nextTimer.relay] && relays[nextTimer.relay].name)
            ? relays[nextTimer.relay].name : nextTimer.relay;
        el.innerHTML = `<i class="fas fa-clock"></i> <strong>Next:</strong> ${label} turns
            <strong>${nextTimer.action}</strong> at
            <strong>${nextTimerDate.format('ddd DD/MM HH:mm')}</strong>
            &nbsp;(${nextTimerDate.fromNow()})`;
    } else {
        el.innerHTML = '<i class="fas fa-info-circle"></i> No upcoming timers scheduled';
    }
}

function applyTimerNow(t) {
    if (!db || !auth || !auth.currentUser || !t.relay || !t.startTime || !t.active) return;
    const now = moment().tz(IST);
    const idx = (now.day() + 6) % 7;
    if (!Array.isArray(t.days) || !t.days[idx]) return;
    const start = moment.tz(
        `${now.format('YYYY-MM-DD')} ${t.startTime}`, 'YYYY-MM-DD HH:mm', IST);
    let end = t.endTime
        ? moment.tz(`${now.format('YYYY-MM-DD')} ${t.endTime}`, 'YYYY-MM-DD HH:mm', IST)
        : null;
    if (end && end.isBefore(start)) end.add(1, 'day');
    if (now.isSameOrAfter(start) && (!end || now.isBefore(end))) {
        db.ref(pState(t.relay)).set(t.action === 'ON' ? 1 : 0);
    }
}

// ================================================================
//  HEARTBEAT UI  (works pre-auth and post-auth)
// ================================================================
function updateHeartbeatUI() {
    if (!lastSeenTimestamp) return;
    const diff  = Math.floor((Date.now() - lastSeenTimestamp) / 1000);
    const dotEl = document.querySelector('.dot');

    if (diff < 15) {
        $connStatus.innerHTML   = '<span class="dot"></span> System Online';
        $connStatus.style.color = '#34c759';
        if (dotEl) dotEl.style.background = '#34c759';
        $lastSeen.style.display = 'none';
        if (auth && auth.currentUser) {
            document.getElementById('relaysContainer').style.opacity       = '1';
            document.getElementById('relaysContainer').style.pointerEvents = 'auto';
        }
    } else if (diff < 60) {
        $connStatus.innerHTML   = '<span class="dot"></span> Connection Lost';
        $connStatus.style.color = '#ff9f0a';
        if (dotEl) dotEl.style.background = '#ff9f0a';
        $lastSeen.style.display = 'block';
        $lastSeen.style.color   = '#ff9f0a';
        $lastSeen.textContent   = `Last seen: ${diff} sec ago`;
        document.getElementById('relaysContainer').style.opacity       = '0.5';
        document.getElementById('relaysContainer').style.pointerEvents = 'none';
    } else {
        const mins = Math.floor(diff / 60);
        $connStatus.innerHTML   = '<span class="dot"></span> System Offline';
        $connStatus.style.color = '#ff3b30';
        if (dotEl) dotEl.style.background = '#ff3b30';
        $lastSeen.style.display = 'block';
        $lastSeen.style.color   = '#ff3b30';
        $lastSeen.textContent   = `Offline — last seen ${mins} min ago`;
        document.getElementById('relaysContainer').style.opacity       = '0.5';
        document.getElementById('relaysContainer').style.pointerEvents = 'none';
    }
}

// ================================================================
//  SETTINGS MODAL  — pre-fills all 4 config values
// ================================================================
function showCredentialsModal() {
    const raw = localStorage.getItem('firebaseConfig');
    if (raw) {
        const { apiKey, databaseURL, userId, deviceId } = JSON.parse(raw);
        document.getElementById('newApiKey').value      = apiKey      || '';
        document.getElementById('newDatabaseURL').value = databaseURL || '';
        document.getElementById('newUserId').value      = userId      || '';
        document.getElementById('newDeviceId').value    = deviceId    || '';
    }
    document.getElementById('credentialsModal').style.display = 'flex';
}
function closeCredentialsModal() {
    document.getElementById('credentialsModal').style.display = 'none';
}
document.getElementById('credentialsForm').addEventListener('submit', e => {
    e.preventDefault();
    const cfg = {
        apiKey      : document.getElementById('newApiKey').value.trim(),
        databaseURL : document.getElementById('newDatabaseURL').value.trim(),
        userId      : document.getElementById('newUserId').value.trim(),
        deviceId    : document.getElementById('newDeviceId').value.trim(),
    };
    if (!cfg.apiKey || !cfg.databaseURL || !cfg.userId || !cfg.deviceId) {
        return alert('Please fill all four fields.');
    }
    localStorage.setItem('firebaseConfig', JSON.stringify(cfg));
    location.reload();
});

function handleModalBackdropClick(event, modalId) {
    if (event.target.id === modalId) {
        if (modalId === 'timerModal')       closeTimerModal();
        if (modalId === 'credentialsModal') closeCredentialsModal();
    }
}
