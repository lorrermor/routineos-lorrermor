const isLocalFrontend = location.protocol === "file:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
const savedApiUrl = localStorage.getItem("pantrypro_api") || "";
const savedApiIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(savedApiUrl);
const API = (isLocalFrontend || !savedApiIsLocal ? savedApiUrl : "")
    || (window.ROUTINEOS_CONFIG && window.ROUTINEOS_CONFIG.API_URL)
    || (isLocalFrontend ? "http://localhost:8765" : "");

async function clearOldAppCaches() {
    try {
        if ("serviceWorker" in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(reg => reg.unregister()));
        }
        if ("caches" in window) {
            const names = await caches.keys();
            await Promise.all(names.map(name => caches.delete(name)));
        }
    } catch (e) {
        console.warn("Cache cleanup non riuscito:", e);
    }
}

clearOldAppCaches();

function setAuthSession(data, remember = true) {
    const storage = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    ["pantrypro_token", "pantrypro_refresh", "pantrypro_user_id", "pantrypro_email"].forEach(key => other.removeItem(key));
    storage.setItem("pantrypro_token", data.access_token || "");
    storage.setItem("pantrypro_refresh", data.refresh_token || "");
    storage.setItem("pantrypro_user_id", data.user_id || "");
    storage.setItem("pantrypro_email", data.email || "");
    localStorage.setItem("pantrypro_remember_me", remember ? "1" : "0");
}

function getAuthToken() {
    return localStorage.getItem("pantrypro_token") || sessionStorage.getItem("pantrypro_token");
}

function getRefreshToken() {
    return localStorage.getItem("pantrypro_refresh") || sessionStorage.getItem("pantrypro_refresh");
}

function getTokenExpirySeconds(token = getAuthToken()) {
    try {
        const payload = JSON.parse(atob(String(token).split(".")[1] || ""));
        return Number(payload.exp || 0);
    } catch (e) {
        return 0;
    }
}

function getStoredUserId() {
    return localStorage.getItem("pantrypro_user_id") || sessionStorage.getItem("pantrypro_user_id") || "local";
}

let refreshSessionPromise = null;

function clearAuthSession() {
    ["pantrypro_token", "pantrypro_refresh", "pantrypro_user_id", "pantrypro_email"].forEach(key => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    });
}

function requireLogin() {
    const isLoginPage = location.pathname.endsWith("login.html");
    if (!isLoginPage && !getAuthToken()) {
        window.location.href = "login.html";
        return false;
    }
    return true;
}

function logout() {
    clearAuthSession();
    window.location.href = "login.html";
}

async function refreshSession() {
    if (refreshSessionPromise) return refreshSessionPromise;
    refreshSessionPromise = refreshSessionOnce().finally(() => {
        refreshSessionPromise = null;
    });
    return refreshSessionPromise;
}

async function refreshSessionOnce() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
        const res = await fetch(`${API}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: refreshToken })
        });
        if (!res.ok) return false;
        const data = await res.json();
        const remember = localStorage.getItem("pantrypro_remember_me") !== "0";
        setAuthSession(data, remember);
        return true;
    } catch (e) {
        console.warn("Refresh sessione non riuscito:", e);
        return false;
    }
}

async function ensureFreshSession() {
    const token = getAuthToken();
    if (!token) return false;
    const exp = getTokenExpirySeconds(token);
    const now = Math.floor(Date.now() / 1000);
    if (!exp || exp - now > 300) return true;
    return refreshSession();
}

async function apiFetch(url, options = {}, retry = true) {
    if (retry) await ensureFreshSession();
    const headers = new Headers(options.headers || {});
    const token = getAuthToken();

    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
        if (retry && token && getAuthToken() && getAuthToken() !== token) {
            return apiFetch(url, options, false);
        }
        if (retry && await refreshSession()) {
            return apiFetch(url, options, false);
        }
        clearAuthSession();
        window.location.href = "login.html";
    }
    return res;
}

const giorniSettimana = ["Lunedi", "Martedi", "Mercoledi", "Giovedi", "Venerdi", "Sabato", "Domenica"];

function nomeGiornoSettimana(data = new Date()) {
    return giorniSettimana[(data.getDay() + 6) % 7];
}

function normalizePlannerLabel(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function activePlannerLabelsForDate(plan, dateIso, weekdayLabel) {
    const labels = new Set([normalizePlannerLabel(weekdayLabel)]);
    const customDays = Array.isArray(plan?.giorni) ? plan.giorni.filter(Boolean) : [];
    const normalizedDays = customDays.map(normalizePlannerLabel);
    const hasWeekday = normalizedDays.includes(normalizePlannerLabel(weekdayLabel));
    if (!hasWeekday && customDays.length && plan?.inizio) {
        const start = new Date(`${plan.inizio}T00:00:00`);
        const today = new Date(`${dateIso}T00:00:00`);
        const diff = Math.floor((today - start) / 86400000);
        if (Number.isFinite(diff) && diff >= 0) {
            labels.add(normalizePlannerLabel(customDays[diff % customDays.length]));
        }
    }
    return labels;
}

function settimanaDelMese(data = new Date()) {
    return Math.min(4, Math.ceil(data.getDate() / 7));
}

let currentPlan = { nome: "", inizio: "", fine: "", giorni: [...giorniSettimana], pasti: [] };

let originalFilename = null;

let mappaUnitaInventario = {}; 


// --- 1. INIZIALIZZAZIONE CORRETTA ---
document.addEventListener('DOMContentLoaded', async () => {
    if (!requireLogin()) return;

    initMobileSideMenu();
    await ensureFreshSession();
    await syncUserLocalData();
    renderSheetsNav();
    setTimeout(renderSheetsNav, 250);
    initGeneralInfo(); // Carica data, stagione e giorno dal server
    avviaOrologio();   // FA PARTIRE L'OROLOGIO CHE SCORRE OGNI SECONDO

    // 1. Se siamo nel Planner, carichiamo prima l'inventario per il datalist
    if (document.getElementById('select-menu-to-edit')) {
        try {
            const res = await apiFetch(API + "/get-inventario");
            const inv = await res.json();
            popolaDatalist(inv); // Crea i suggerimenti per il menu a tendina
            // initPlanner();       // Avvia il planner vero e proprio
        } catch (e) {
            console.error("Errore caricamento dati per planner:", e);
        }
    }

    // 2. Se siamo nella pagina Inventario
    if (document.getElementById('inventory-table-body')) {
        caricaInventario();
    }

    // 3. Se siamo nella Dashboard (Index)
    if (document.getElementById('active-menu-display')) {
        initDashboard();
    }

    if (document.getElementById('ai-menu-request')) {
        initAiMenuPlanner();
    }

    if (document.getElementById('today-routines-display')) {
        caricaRoutineDiOggi();
    }

    if (document.getElementById('dashboard-comments')) {
        loadDashboardComments();
    }

    if (document.getElementById('dashboard-notes-list')) {
        loadDashboardNotes();
    }

    if (document.getElementById('sheet-tree')) {
        initSheetsPage();
    }

    if (document.getElementById('extra-shopping-board')) {
        initExtraShoppingPage();
    }

    if (document.getElementById('export-data-groups')) {
        initDataPortability();
    }

    if (document.getElementById('log-container') && !document.getElementById('active-menu-display')) {
        caricaCronologia();
    }
});

function initMobileSideMenu() {
    const sideMenu = document.querySelector(".side-menu");
    if (!sideMenu || document.querySelector(".mobile-menu-toggle")) return;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "mobile-menu-toggle";
    toggle.setAttribute("aria-label", "Apri menu");
    toggle.innerHTML = "<span>☰</span><span>Menu</span>";

    const backdrop = document.createElement("div");
    backdrop.className = "mobile-menu-backdrop";

    function closeMenu() {
        document.body.classList.remove("side-menu-open");
        toggle.setAttribute("aria-label", "Apri menu");
        toggle.innerHTML = "<span>☰</span><span>Menu</span>";
    }

    toggle.addEventListener("click", () => {
        const open = document.body.classList.toggle("side-menu-open");
        toggle.setAttribute("aria-label", open ? "Chiudi menu" : "Apri menu");
        toggle.innerHTML = open ? "<span>×</span><span>Chiudi</span>" : "<span>☰</span><span>Menu</span>";
    });
    backdrop.addEventListener("click", closeMenu);
    sideMenu.addEventListener("click", event => {
        if (event.target.closest("a, button")) closeMenu();
    });

    document.body.prepend(backdrop);
    document.body.prepend(toggle);
}

window.addEventListener('pageshow', () => {
    if (getAuthToken()) renderSheetsNav();
});

// TEST IMMEDIATO OROLOGIO
function avviaOrologio() {
    console.log("Orologio avviato!"); // Controlla in console (F12) se vedi questo messaggio
    
    setInterval(() => {
        const oraElem = document.getElementById('info-ora');
        if (oraElem) {
            const ora = new Date().toLocaleTimeString('it-IT');
            oraElem.innerText = ora;
        }
    }, 1000);
}


async function initGeneralInfo() {

    try {

        const res = await apiFetch(API + "/system/info");

        const info = await res.json();

        const dataElem = document.getElementById('info-data');

        const stagioneElem = document.getElementById('stagione');

        

        // Formattazione: "Venerdi, 23 Gennaio 2026"

        if (dataElem) dataElem.innerText = `${info.giorno}, ${info.data}`;

        if (stagioneElem) stagioneElem.innerText = info.stagione;

    } catch (e) { console.error("Errore info generali:", e); }

}



// --- 2. DASHBOARD & SHOPPING ---

async function initDashboard() {
    try {
        // 1. Chiedi al server lo stato dei tasti (se lo scarico e gia stato annullato oggi)
        // Nota: Assicurati che il tuo backend Python esponga questa rotta
        const statusRes = await apiFetch(`${API}/system/status-oggi`);
        const statusOggi = await statusRes.json();
        const giaAnnullato = statusOggi.scarico_annullato; // Vero o Falso

        const infoRes = await apiFetch(`${API}/system/info`);
        const info = await infoRes.json();

        const stagioneEl = document.getElementById('stagione');
        const dataEl = document.getElementById('info-data');
        if (stagioneEl) stagioneEl.textContent = info.stagione;
        if (dataEl) dataEl.textContent = `${info.giorno}, ${info.data}`;

        const oggiNomeServer = info.giorno;
        const oggiISO = new Date().toISOString().split('T')[0];

        let files = await (await apiFetch(`${API}/menu/list`)).json();
        let pianoAttivo = null;

        for (const f of files) {
            const res = await apiFetch(`${API}/menu/${f}`);
            if (!res.ok) continue;
            const p = await res.json();
            if (oggiISO >= p.inizio && oggiISO <= p.fine) {
                pianoAttivo = p;
                break;
            }
        }

        const inv = await (await apiFetch(`${API}/get-inventario`)).json();
        popolaDatalist(inv);

        const display = document.getElementById('active-menu-display');
        if (pianoAttivo) {
            const labelsOggi = activePlannerLabelsForDate(pianoAttivo, oggiISO, oggiNomeServer);
            const pastiOggi = (pianoAttivo.pasti || []).filter(p => labelsOggi.has(normalizePlannerLabel(p.giorno)));
            
            // PASSIAMO IL VALORE giaAnnullato alla funzione render
            renderMenuDashboard(pastiOggi, giaAnnullato);
        } else {
            display.innerHTML = `<p class="empty-state">Nessun piano attivo per oggi (${oggiISO}).</p>`;
        }

        calcolaSpesa(inv);
        caricaCronologia();

    } catch (e) {
        console.error("Errore Dashboard:", e);
    }
}

function normalizzaNomeIngrediente(nome) {
    return String(nome || "").toLowerCase().trim().replace(/\s+/g, '_');
}

function nomeIngredienteDisplay(nome) {
    return String(nome || "").replace(/_/g, ' ');
}

function unitaIngredienteDaInventario(ingrediente) {
    const key = normalizzaNomeIngrediente(ingrediente.nome);
    return mappaUnitaInventario[key] || ingrediente.unita || "g";
}

function sincronizzaUnitaIngrediente(ingrediente) {
    const key = normalizzaNomeIngrediente(ingrediente.nome);
    if (!ingrediente.nome) return ingrediente;
    ingrediente.nome = key;
    if (mappaUnitaInventario[key]) ingrediente.unita = mappaUnitaInventario[key];
    else if (!ingrediente.unita) ingrediente.unita = "g";
    return ingrediente;
}

function sincronizzaUnitaPiano(piano = currentPlan) {
    (piano.pasti || []).forEach(pasto => {
        (pasto.piatti || []).forEach(piatto => {
            (piatto.ingredienti || []).forEach(sincronizzaUnitaIngrediente);
        });
    });
}

function ingredientiDaPasto(pasto) {
    return (pasto.piatti || []).flatMap(piatto => piatto.ingredienti || []);
}

function ingredientiDaPiatto(piatto) {
    return piatto.ingredienti || [];
}

function scaricoId(...parts) {
    return parts.map(normalizzaNomeIngrediente).filter(Boolean).join("::");
}

function codificaScaricoPayload(ingredienti, label, id, descendantIds = []) {
    return encodeURIComponent(JSON.stringify({
        label,
        id: id || normalizzaNomeIngrediente(label),
        descendantIds,
        ingredienti: (ingredienti || []).map(i => ({
            nome: normalizzaNomeIngrediente(i.nome),
            qta: parseFloat(i.qta) || 0,
            unita: unitaIngredienteDaInventario(i)
        })).filter(i => i.nome && i.qta > 0)
    }));
}

function scaricoParzialeStorageKey() {
    return `pantrypro_scarico_parziale:${getStoredUserId()}:${localISODate()}`;
}

function readScaricoParzialeState() {
    try {
        return JSON.parse(localStorage.getItem(scaricoParzialeStorageKey()) || "{}");
    } catch (e) {
        return {};
    }
}

function writeScaricoParzialeState(state) {
    localStorage.setItem(scaricoParzialeStorageKey(), JSON.stringify(state || {}));
}

function isScaricoParzialeAnnullato(id) {
    return readScaricoParzialeState()[id] === "annullato";
}

function hasScaricoState(ids = []) {
    const state = readScaricoParzialeState();
    return ids.some(id => state[id] === "annullato");
}

function setScaricoParzialeState(id, annullato, descendantIds = []) {
    const state = readScaricoParzialeState();
    if (annullato) {
        state[id] = "annullato";
        descendantIds.forEach(childId => delete state[childId]);
    } else {
        delete state[id];
    }
    writeScaricoParzialeState(state);
}

function scaricoControlsHtml(ingredienti, label, options = {}) {
    const id = options.id || normalizzaNomeIngrediente(label);
    const ancestorIds = options.ancestorIds || [];
    const descendantIds = options.descendantIds || [];
    const level = options.level || "dish";
    const payload = codificaScaricoPayload(ingredienti, label, id, descendantIds);
    const annullato = isScaricoParzialeAnnullato(id);
    const ancestorAnnullato = hasScaricoState(ancestorIds);
    const descendantAnnullato = hasScaricoState(descendantIds);
    const annullaDisabled = annullato || ancestorAnnullato || descendantAnnullato;
    const ripristinaDisabled = !annullato || ancestorAnnullato;
    const title = ancestorAnnullato
        ? "Gestito da un contenitore superiore"
        : descendantAnnullato
            ? "Ripristina prima gli elementi interni gia annullati"
            : "";
    return `
        <div class="scarico-controls scarico-controls-${level}">
            <button class="btn outline scarico-btn scarico-btn-annulla" title="${title}" ${annullaDisabled ? "disabled" : ""} onclick="gestisciScaricoParziale('annulla', '${payload}')">Annulla scarico</button>
            <button class="btn outline scarico-btn scarico-btn-ripristina" title="${title}" ${ripristinaDisabled ? "disabled" : ""} onclick="gestisciScaricoParziale('ripristina', '${payload}')">Ripristina scarico</button>
        </div>
    `;
}

function renderMenuDashboard(pasti, giaAnnullato) {
    const container = document.getElementById('active-menu-display');
    if (!pasti || !pasti.length) {
        container.innerHTML = "<p class='empty-state'>Nessun pasto programmato per oggi.</p>";
        return;
    }

    let html = `
        <div style="display: flex; gap: 10px; margin-bottom: 25px; flex-wrap:wrap; align-items:center;">
            <button class="btn outline" onclick="annullaScaricoOggi()"
                ${giaAnnullato ? 'disabled style="opacity:0.4; cursor:not-allowed; border-color:#444;"' : 'style="border-color: #ef4444; color: #f87171;"'}>
                ${giaAnnullato ? 'Scarico annullato' : 'Annulla scarico oggi'}
            </button>
            <button class="btn outline" onclick="rifaiScaricoOggi()"
                ${!giaAnnullato ? 'disabled style="opacity:0.4; cursor:not-allowed; border-color:#444;"' : 'style="border-color: #f59e0b; color: #fbbf24;"'}>
                Ripristina scarico
            </button>
            <span style="color:var(--dim); font-size:0.82rem; line-height:1.35; max-width:420px;">
                Lo scarico delle scorte viene applicato automaticamente quando apri l'app e viene caricato il menu di oggi.
            </span>
        </div>
    `;

    html += pasti.map(pasto => {
        const pastoId = scaricoId("pasto", pasto.nome);
        const piatti = pasto.piatti || [];
        const piattoIds = piatti.map(piatto => scaricoId(pastoId, "piatto", piatto.nome));
        const ingredienteIds = piatti.flatMap(piatto => (piatto.ingredienti || [])
            .map((i, iIdx) => scaricoId(pastoId, "piatto", piatto.nome, "ingrediente", iIdx, i.nome)));
        const pastoDescendants = [...piattoIds, ...ingredienteIds];

        return `
            <article style="margin-bottom:30px; border-left: 4px solid var(--accent); padding-left:15px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
                    <h2 style="color:var(--accent); font-size:1.4rem; text-transform: uppercase; margin:0;">${pasto.nome}</h2>
                    ${scaricoControlsHtml(ingredientiDaPasto(pasto), `pasto ${pasto.nome}`, { id: pastoId, descendantIds: pastoDescendants, level: "meal" })}
                </div>
                ${piatti.map(piatto => {
                    const piattoId = scaricoId(pastoId, "piatto", piatto.nome);
                    const ingIds = (piatto.ingredienti || [])
                        .map((i, iIdx) => scaricoId(pastoId, "piatto", piatto.nome, "ingrediente", iIdx, i.nome));

                    return `
                        <div style="margin:16px 0 10px;">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
                                <h3 style="font-size:1.1rem; color:#0f172a; margin:0;">${piatto.nome}</h3>
                                ${scaricoControlsHtml(ingredientiDaPiatto(piatto), `piatto ${piatto.nome}`, { id: piattoId, ancestorIds: [pastoId], descendantIds: ingIds, level: "dish" })}
                            </div>
                            <ul style="list-style:none; font-size:0.9rem; color:var(--dim); padding-left:0; margin-top:10px;">
                                ${(piatto.ingredienti || []).map((i, iIdx) => {
                                    const ingId = scaricoId(pastoId, "piatto", piatto.nome, "ingrediente", iIdx, i.nome);
                                    return `<li style="display:flex; justify-content:space-between; align-items:center; gap:14px; margin:8px 0; padding:8px 0; border-top:1px solid rgba(148,163,184,0.12);"><span>${i.qta}${unitaIngredienteDaInventario(i)} ${nomeIngredienteDisplay(i.nome)}</span>${scaricoControlsHtml([i], `ingrediente ${nomeIngredienteDisplay(i.nome)}`, { id: ingId, ancestorIds: [pastoId, piattoId], level: "ingredient" })}</li>`;
                                }).join("")}
                            </ul>
                        </div>`;
                }).join("")}
            </article>`;
    }).join("");

    container.innerHTML = html;
}

let lastAiMenuResult = { plans: [], inventory_suggestions: [], notes: [] };

function initAiMenuPlanner() {
    const start = document.getElementById("ai-menu-start");
    if (start && !start.value) start.value = localISODate();
}

function fillAiMenuPrompt(type) {
    const prompts = {
        settimanale: "Crea un piano menu settimanale sano, semplice e sostenibile, usando prima gli ingredienti gia presenti nell'inventario. Voglio colazione, pranzo e cena, con piatti pratici e lista ingredienti precisa.",
        mensile: "Crea un piano menu mensile organizzato, vario e non ripetitivo, con ricette semplici, economiche e bilanciate. Usa l'inventario dove possibile e indica cosa comprare.",
        stagionale: "Crea un menu stagionale adatto al periodo, con ingredienti freschi, piatti leggeri e una buona rotazione tra carboidrati, proteine e verdure.",
        vuoto: "Parti da inventario vuoto e costruisci un piano menu completo con ingredienti da acquistare. Voglio una spesa intelligente, pochi sprechi e ingredienti riutilizzabili in piu pasti."
    };
    const input = document.getElementById("ai-menu-request");
    if (input) input.value = prompts[type] || "";
}

async function generateAiMenuPlan() {
    const status = document.getElementById("ai-menu-status");
    const source = document.getElementById("ai-menu-source");
    const results = document.getElementById("ai-menu-results");
    const request = document.getElementById("ai-menu-request").value.trim();
    if (!request) {
        status.textContent = "Scrivi prima cosa vuoi far creare all'AI.";
        return;
    }

    status.textContent = "Sto generando il piano menu...";
    if (source) source.textContent = "In lavoro";
    if (results) results.innerHTML = "";

    try {
        const res = await apiFetch(`${API}/ai/menu-plan`, {
            method: "POST",
            body: JSON.stringify({
                request,
                start_date: document.getElementById("ai-menu-start").value || localISODate(),
                days: parseInt(document.getElementById("ai-menu-days").value || "7", 10),
                plan_count: parseInt(document.getElementById("ai-menu-count").value || "1", 10),
                use_inventory: document.getElementById("ai-menu-use-inventory").checked
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Generazione non riuscita.");
        lastAiMenuResult = data;
        if (source) source.textContent = data.source === "openai" ? "AI attiva" : "Bozza locale";
        status.textContent = data.message || "Piano generato.";
        renderAiMenuResult(data);
    } catch (e) {
        console.error("Errore AI menu:", e);
        status.textContent = e.message || "Errore durante la generazione.";
        if (source) source.textContent = "Errore";
    }
}

function renderAiMenuResult(data) {
    const results = document.getElementById("ai-menu-results");
    if (!results) return;
    const plans = data.plans || [];
    const suggestions = data.inventory_suggestions || [];
    const notes = data.notes || [];

    if (!plans.length && !suggestions.length) {
        results.innerHTML = `<p class="empty-state">Nessun piano generato. Prova con istruzioni piu specifiche.</p>`;
        return;
    }

    results.innerHTML = `
        ${notes.length ? `<div class="ai-menu-notes">${notes.map(note => `<span>${escapeHTML(note)}</span>`).join("")}</div>` : ""}
        ${plans.map((plan, index) => renderAiMenuPlanCard(plan, index)).join("")}
        ${suggestions.length ? `
            <section class="ai-menu-suggestions">
                <div>
                    <h3>Ingredienti suggeriti per inventario</h3>
                    <p>${suggestions.length} ingredienti che l'AI consiglia di aggiungere o comprare.</p>
                </div>
                <button class="btn outline" onclick="addAiInventorySuggestions()">Aggiungi a inventario</button>
                <div class="ai-suggestion-list">
                    ${suggestions.map(item => `<span>${escapeHTML(nomeIngredienteDisplay(item.nome || ""))}</span>`).join("")}
                </div>
            </section>
        ` : ""}
    `;
}

function renderAiMenuPlanCard(plan, index) {
    const pasti = plan.pasti || [];
    const preview = pasti.slice(0, 6).map(pasto => `
        <div class="ai-meal-preview">
            <strong>${escapeHTML(pasto.giorno || "")} - ${escapeHTML(pasto.nome || "Pasto")}</strong>
            <span>${escapeHTML((pasto.piatti || []).map(p => p.nome).join(", ") || "Nessun piatto")}</span>
        </div>
    `).join("");
    return `
        <article class="ai-plan-card">
            <header>
                <div>
                    <h3>${escapeHTML(plan.nome || `Piano AI ${index + 1}`)}</h3>
                    <p>${escapeHTML(plan.inizio || "-")} / ${escapeHTML(plan.fine || "-")} - ${pasti.length} pasti</p>
                </div>
                <button class="btn primary" onclick="saveAiMenuPlan(${index})">Salva piano</button>
            </header>
            <div class="ai-meal-grid">${preview}</div>
            ${pasti.length > 6 ? `<div class="task-meta">+ altri ${pasti.length - 6} pasti nel piano completo</div>` : ""}
        </article>
    `;
}

async function saveAiMenuPlan(index) {
    const status = document.getElementById("ai-menu-status");
    const plan = (lastAiMenuResult.plans || [])[index];
    if (!plan) return;
    const filename = plan.nome || `Piano AI ${index + 1}`;
    const res = await apiFetch(`${API}/menu/save`, {
        method: "POST",
        body: JSON.stringify({ filename, menu: plan })
    });
    const data = await res.json().catch(() => ({}));
    status.textContent = res.ok ? `Piano "${filename}" salvato.` : (data.detail || "Errore salvataggio piano.");
}

async function addAiInventorySuggestions() {
    const status = document.getElementById("ai-menu-status");
    const suggestions = (lastAiMenuResult.inventory_suggestions || []).filter(item => item.nome);
    if (!suggestions.length) return;
    const res = await apiFetch(`${API}/inventario/save`, {
        method: "POST",
        body: JSON.stringify({ inventario: suggestions })
    });
    const data = await res.json().catch(() => ({}));
    status.textContent = res.ok ? "Ingredienti suggeriti aggiunti all'inventario." : (data.detail || "Errore salvataggio inventario.");
}

function fineMese(date) {
    const domani = new Date(date);
    domani.setDate(date.getDate() + 1);
    return domani.getDate() === 1;
}

function fineAnno(date) {
    return date.getMonth() === 11 && date.getDate() === 31;
}

function inIntervallo(data, inizio, fine) {
    const giorno = localISODate(data);
    if (inizio && giorno < inizio) return false;
    if (fine && giorno > fine) return false;
    return true;
}

function localISODate(data = new Date()) {
    if (!(data instanceof Date)) data = new Date();
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, "0");
    const d = String(data.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

async function jsonOrThrow(res, label) {
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (e) {
        data = text;
    }

    if (!res.ok) {
        throw new Error(`${label}: HTTP ${res.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    return data;
}

async function fetchJsonOrDefault(url, fallback, label) {
    try {
        const res = await apiFetch(url);
        return await jsonOrThrow(res, label);
    } catch (e) {
        console.warn(`Dato non disponibile per ${label}:`, e);
        return fallback;
    }
}

function isRoutineDue(item, oggi = new Date()) {
    if (!inIntervallo(oggi, item.inizio, item.fine)) return false;
    const excludedDays = item.giorni_esclusi || item.exclude_days || [];
    if (Array.isArray(excludedDays) && excludedDays.includes(nomeGiornoSettimana(oggi))) return false;

    const frequenza = (item.frequenza || "giornaliera").toLowerCase();
    if (frequenza === "giornaliera") return true;
    if (frequenza === "settimanale") {
        const weeks = item.settimane_mese || item.weeks_of_month || [];
        if (Array.isArray(weeks) && weeks.length && !weeks.map(String).includes(String(settimanaDelMese(oggi)))) return false;
        const giorno = item.giorno_settimana;
        if (item.tipo === "sottoroutine" && (giorno === "" || giorno === undefined || giorno === null)) {
            return true;
        }
        return giorno === "" || giorno === undefined || giorno === null
            ? oggi.getDay() === 0
            : oggi.getDay() === parseInt(giorno, 10);
    }
    if (frequenza === "mensile") {
        const months = item.mesi_attivi || item.active_months || [];
        if (Array.isArray(months) && months.length && !months.map(String).includes(String(oggi.getMonth() + 1))) return false;
        return fineMese(oggi);
    }
    if (frequenza === "annuale") return fineAnno(oggi);

    if (frequenza === "personalizzata") {
        const intervallo = parseInt(item.intervallo_giorni || "1", 10);
        if (!item.inizio || !intervallo) return false;
        const start = new Date(`${item.inizio}T00:00:00`);
        const current = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate());
        const diff = Math.floor((current - start) / 86400000);
        return diff >= 0 && diff % intervallo === 0;
    }

    return false;
}

function isElementoDue(elemento, oggi = new Date()) {
    const giorno = elemento.giorno_settimana;
    if (giorno === "" || giorno === undefined || giorno === null) return true;
    return oggi.getDay() === parseInt(giorno, 10);
}

function normalizzaElementiRoutine(item) {
    if (Array.isArray(item.elementi)) return item.elementi;
    if (Array.isArray(item.tasks)) return item.tasks;
    if (Array.isArray(item.attivita)) return item.attivita;
    return [{ id: "main", titolo: item.nome || "Attivita", note: item.note || "" }];
}

function escapeHTML(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function safeEncoded(value) {
    return encodeURIComponent(String(value || "")).replace(/'/g, "%27");
}

function normalizeName(value) {
    return String(value || "").trim().toLowerCase();
}

function routineElementTitle(elemento, item) {
    return elemento.titolo || elemento.nome || item.nome || "Attivita";
}

function formatSubroutineDetail(sottoroutine, oggi = new Date()) {
    const elementi = normalizzaElementiRoutine(sottoroutine)
        .filter(elemento => isElementoDue(elemento, oggi));
    const titles = elementi
        .map(elemento => routineElementTitle(elemento, sottoroutine))
        .filter(Boolean);
    return titles.join(", ");
}

function buildSubroutineLinks(sottoroutineDovute, oggi = new Date()) {
    const map = new Map();
    sottoroutineDovute.forEach(sub => {
        const parentKey = normalizeName(sub.routine_parent);
        const nameKey = normalizeName(sub.nome);
        if (!parentKey || !nameKey) return;
        const key = `${parentKey}::${nameKey}`;
        const detail = formatSubroutineDetail(sub, oggi);
        if (!detail) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ ...sub, nome: sub.nome, detail });
    });
    return map;
}

function findLinkedSubroutinesForDashboard(item, title, sottoroutineDovute, usedSubroutineKeys, oggi = new Date()) {
    const parentKey = normalizeName(item.nome);
    const titleKey = normalizeName(title);
    const candidates = sottoroutineDovute.filter(sub => {
        const subNameKey = normalizeName(sub.nome);
        const subParentKey = normalizeName(sub.routine_parent);
        const subActivityKey = normalizeName(sub.routine_activity_parent || sub.attivita_parent || sub.activity_parent);
        if (!subNameKey || usedSubroutineKeys.has(subNameKey)) return false;
        if (subActivityKey) {
            return subParentKey === parentKey && subActivityKey === titleKey;
        }
        return (
            (subParentKey === parentKey && subNameKey === titleKey) ||
            subNameKey === titleKey ||
            subParentKey === titleKey ||
            subParentKey === parentKey
        );
    });

    return candidates
        .map(sub => ({ ...sub, detail: formatSubroutineDetail(sub, oggi) }))
        .filter(sub => sub.detail);
}

function openSubroutineFromDashboard(nomeEncoded) {
    window.location.href = `sottoroutine.html?edit=${nomeEncoded}`;
}

function dashboardCommentsKey() {
    return `pantrypro_dashboard_comments:${getStoredUserId()}`;
}

function dashboardNotesKey() {
    return `pantrypro_dashboard_notes:${getStoredUserId()}`;
}

function readStoredList(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function readStoredValue(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

function localDataKeysForUser() {
    const user = getStoredUserId();
    return [
        { localKey: `pantrypro_dashboard_comments:${user}`, remoteKey: "dashboard_comments", fallback: [] },
        { localKey: `pantrypro_dashboard_notes:${user}`, remoteKey: "dashboard_notes", fallback: [] },
        { localKey: `pantrypro_sheets:${user}`, remoteKey: "sheets", fallback: [] },
        { localKey: `pantrypro_extra_shopping:${user}`, remoteKey: "extra_shopping", fallback: [] },
        { localKey: `pantrypro_extra_shopping_columns:${user}`, remoteKey: "extra_shopping_columns", fallback: [] },
        { localKey: `pantrypro_stats:${user}`, remoteKey: "stats", fallback: {} },
        { localKey: `pantrypro_justifications:${user}`, remoteKey: "justifications", fallback: [] },
        { localKey: `pantrypro_pending_tasks:${user}`, remoteKey: "pending_tasks", fallback: {} }
    ];
}

async function getUserConfigValue(remoteKey) {
    const res = await apiFetch(`${API}/config/item/${encodeURIComponent(remoteKey)}`);
    if (!res.ok) throw new Error(`config ${remoteKey}: HTTP ${res.status}`);
    const data = await res.json();
    return data.value;
}

async function saveUserConfigValue(remoteKey, value) {
    if (!getAuthToken()) return;
    try {
        await apiFetch(`${API}/config/item/${encodeURIComponent(remoteKey)}`, {
            method: "PUT",
            body: JSON.stringify({ value })
        });
    } catch (e) {
        console.warn("Salvataggio config remoto non riuscito:", remoteKey, e);
    }
}

async function syncUserLocalData() {
    if (!getAuthToken()) return;
    await Promise.allSettled(localDataKeysForUser().map(async item => {
        try {
            const localValue = readStoredValue(item.localKey, item.fallback);
            const remoteValue = await getUserConfigValue(item.remoteKey);
            const hasRemote = remoteValue !== null && remoteValue !== undefined;
            const localHasData = Array.isArray(localValue)
                ? localValue.length > 0
                : !!localValue && typeof localValue === "object" && Object.keys(localValue).length > 0;
            if (item.remoteKey === "sheets") {
                const backupValue = readStoredValue(sheetsBackupKey(), []);
                const merged = mergeSheetsCollections(
                    mergeSheetsCollections(localValue, backupValue),
                    Array.isArray(remoteValue) ? remoteValue : []
                );
                if (merged.length) {
                    localStorage.setItem(item.localKey, JSON.stringify(merged));
                    localStorage.setItem(sheetsBackupKey(), JSON.stringify(merged));
                    const remoteString = JSON.stringify(Array.isArray(remoteValue) ? remoteValue : []);
                    if (JSON.stringify(merged) !== remoteString) {
                        await saveUserConfigValue(item.remoteKey, merged);
                    }
                }
                return;
            }
            if (hasRemote) {
                localStorage.setItem(item.localKey, JSON.stringify(remoteValue));
            } else if (localHasData) {
                await saveUserConfigValue(item.remoteKey, localValue);
            }
        } catch (e) {
            console.warn("Sync dati utente non riuscita:", item.remoteKey, e);
        }
    }));
}

function saveLocalAndRemote(localKey, remoteKey, value) {
    localStorage.setItem(localKey, JSON.stringify(value));
    saveUserConfigValue(remoteKey, value);
}

function clearUserLocalData() {
    localDataKeysForUser().forEach(item => localStorage.removeItem(item.localKey));
}

function loadDashboardComments() {
    const area = document.getElementById('dashboard-comments');
    if (!area) return;
    const legacy = localStorage.getItem(dashboardCommentsKey());
    const comments = legacy && !legacy.trim().startsWith("[")
        ? [{ id: `comment_${Date.now()}`, text: legacy, created_at: new Date().toISOString() }]
        : readStoredList(dashboardCommentsKey());
    if (legacy && !legacy.trim().startsWith("[")) {
        saveLocalAndRemote(dashboardCommentsKey(), "dashboard_comments", comments);
    }
    area.value = "";
    renderDashboardComments(comments);
}

function saveDashboardComments(comments) {
    saveLocalAndRemote(dashboardCommentsKey(), "dashboard_comments", comments);
    renderDashboardComments(comments);
}

function addDashboardComment() {
    const area = document.getElementById('dashboard-comments');
    const status = document.getElementById('dashboard-comments-status');
    if (!area) return;
    const text = area.value.trim();
    if (!text) return;
    const comments = readStoredList(dashboardCommentsKey());
    comments.unshift({ id: `comment_${Date.now()}`, text, created_at: new Date().toISOString() });
    saveDashboardComments(comments);
    area.value = "";
    if (status) status.textContent = "Commento aggiunto.";
}

function deleteDashboardComment(id) {
    saveDashboardComments(readStoredList(dashboardCommentsKey()).filter(item => item.id !== id));
}

function moveDashboardListItem(type, fromIndex, toIndex) {
    const key = type === "note" ? dashboardNotesKey() : dashboardCommentsKey();
    const items = readStoredList(key);
    if (!items.length || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return;
    const [item] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, item);
    if (type === "note") saveDashboardNotes(items);
    else saveDashboardComments(items);
}

function dashboardListDragStart(event, type, index) {
    event.dataTransfer.setData("text/plain", JSON.stringify({ type, index }));
    event.dataTransfer.effectAllowed = "move";
}

function dashboardListDrop(event, type, toIndex) {
    event.preventDefault();
    try {
        const payload = JSON.parse(event.dataTransfer.getData("text/plain") || "{}");
        if (payload.type !== type) return;
        moveDashboardListItem(type, payload.index, toIndex);
    } catch (e) {
        console.warn("Spostamento dashboard non riuscito:", e);
    }
}

function renderDashboardComments(comments) {
    const list = document.getElementById('dashboard-comments-list');
    if (!list) return;
    if (!comments.length) {
        list.innerHTML = `<p class="empty-state">Nessun commento ancora.</p>`;
        return;
    }
    list.innerHTML = comments.map((item, index) => `
        <article class="dashboard-comment-card dashboard-movable-card" draggable="true" ondragstart="dashboardListDragStart(event, 'comment', ${index})" ondragover="event.preventDefault()" ondrop="dashboardListDrop(event, 'comment', ${index})">
            <div class="dashboard-card-actions">
                <span class="drag-handle" title="Trascina commento">::</span>
                <div>
                    <div>${escapeHTML(item.text).replace(/\n/g, "<br>")}</div>
                    <div class="dashboard-card-meta">${new Date(item.created_at).toLocaleString('it-IT')}</div>
                </div>
                <span class="dashboard-card-buttons">
                    <button class="btn outline" ${index === 0 ? "disabled" : ""} onclick="moveDashboardListItem('comment', ${index}, ${index - 1})">Su</button>
                    <button class="btn outline" ${index === comments.length - 1 ? "disabled" : ""} onclick="moveDashboardListItem('comment', ${index}, ${index + 1})">Giu</button>
                    <button class="btn danger" onclick="deleteDashboardComment('${item.id}')">Elimina</button>
                </span>
            </div>
        </article>
    `).join("");
}

function loadDashboardNotes() {
    renderDashboardNotes(readStoredList(dashboardNotesKey()));
}

function saveDashboardNotes(notes) {
    saveLocalAndRemote(dashboardNotesKey(), "dashboard_notes", notes);
    renderDashboardNotes(notes);
}

function addDashboardNote() {
    const titleEl = document.getElementById('dashboard-note-title');
    const bodyEl = document.getElementById('dashboard-note-body');
    const status = document.getElementById('dashboard-notes-status');
    if (!titleEl || !bodyEl) return;
    const title = titleEl.value.trim();
    const body = bodyEl.value.trim();
    if (!title && !body) return;
    const notes = readStoredList(dashboardNotesKey());
    notes.unshift({ id: `note_${Date.now()}`, title: title || "Nota senza titolo", body, created_at: new Date().toISOString() });
    saveDashboardNotes(notes);
    titleEl.value = "";
    bodyEl.value = "";
    if (status) status.textContent = "Nota aggiunta.";
}

function deleteDashboardNote(id) {
    saveDashboardNotes(readStoredList(dashboardNotesKey()).filter(item => item.id !== id));
}

function renderDashboardNotes(notes) {
    const list = document.getElementById('dashboard-notes-list');
    if (!list) return;
    if (!notes.length) {
        list.innerHTML = `<p class="empty-state">Nessuna nota ancora.</p>`;
        return;
    }
    list.innerHTML = notes.map((item, index) => `
        <article class="dashboard-note-card dashboard-movable-card" draggable="true" ondragstart="dashboardListDragStart(event, 'note', ${index})" ondragover="event.preventDefault()" ondrop="dashboardListDrop(event, 'note', ${index})">
            <div class="dashboard-card-actions">
                <span class="drag-handle" title="Trascina nota">::</span>
                <div>
                    <h3 style="margin:0 0 6px;">${escapeHTML(item.title)}</h3>
                    ${item.body ? `<div style="line-height:1.55;">${escapeHTML(item.body).replace(/\n/g, "<br>")}</div>` : ""}
                    <div class="dashboard-card-meta">${new Date(item.created_at).toLocaleString('it-IT')}</div>
                </div>
                <span class="dashboard-card-buttons">
                    <button class="btn outline" ${index === 0 ? "disabled" : ""} onclick="moveDashboardListItem('note', ${index}, ${index - 1})">Su</button>
                    <button class="btn outline" ${index === notes.length - 1 ? "disabled" : ""} onclick="moveDashboardListItem('note', ${index}, ${index + 1})">Giu</button>
                    <button class="btn danger" onclick="deleteDashboardNote('${item.id}')">Elimina</button>
                </span>
            </div>
        </article>
    `).join("");
}

function sheetsStorageKey() {
    return `pantrypro_sheets:${getStoredUserId()}`;
}

function sheetsBackupKey() {
    return `pantrypro_sheets_backup:${getStoredUserId()}`;
}

function loadSheets() {
    let sheets = readStoredList(sheetsStorageKey());
    if (!sheets.length) {
        sheets = readStoredList(sheetsBackupKey());
        if (sheets.length) {
            localStorage.setItem(sheetsStorageKey(), JSON.stringify(sheets));
            saveUserConfigValue("sheets", sheets);
        }
    }
    let changed = false;
    const orderCounters = {};
    const normalized = sheets.map(sheet => {
        const parentId = sheet.parentId || "";
        const fallbackOrder = orderCounters[parentId] || 0;
        orderCounters[parentId] = fallbackOrder + 1;
        if (sheet.order === undefined || sheet.order === null) changed = true;
        return {
        id: sheet.id || `sheet_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        title: sheet.title || "Foglio senza titolo",
        body: sheet.body || (Array.isArray(sheet.blocks) ? sheet.blocks.map(block => [block.title, block.body].filter(Boolean).join("\n")).filter(Boolean).join("\n\n") : ""),
        parentId,
        order: Number.isFinite(Number(sheet.order)) ? Number(sheet.order) : fallbackOrder,
        created_at: sheet.created_at || new Date().toISOString(),
        updated_at: sheet.updated_at || new Date().toISOString()
    };
    });
    const cleaned = removeAutoBlankSheets(normalized);
    if (changed || cleaned.length !== normalized.length) {
        localStorage.setItem(sheetsStorageKey(), JSON.stringify(cleaned));
        localStorage.setItem(sheetsBackupKey(), JSON.stringify(cleaned));
        saveUserConfigValue("sheets", cleaned);
    }
    return cleaned;
}

function isAutoBlankSheet(sheet, allSheets = []) {
    return (sheet.title || "").trim().toLowerCase() === "foglio bianco"
        && !(sheet.body || "").trim()
        && !(sheet.parentId || "")
        && !allSheets.some(item => (item.parentId || "") === sheet.id);
}

function removeAutoBlankSheets(sheets) {
    const mainSheets = sheets.filter(sheet => !(sheet.parentId || ""));
    if (mainSheets.length <= 1) return sheets;
    const hasRealMainSheet = mainSheets.some(sheet => !isAutoBlankSheet(sheet, sheets));
    if (!hasRealMainSheet) return sheets;
    return sheets.filter(sheet => !isAutoBlankSheet(sheet, sheets));
}

function mergeSheetsCollections(localSheets, remoteSheets) {
    const map = new Map();
    [...(Array.isArray(remoteSheets) ? remoteSheets : []), ...(Array.isArray(localSheets) ? localSheets : [])]
        .map(sheet => ({
            id: sheet.id || `sheet_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            title: sheet.title || "Foglio senza titolo",
            body: sheet.body || (Array.isArray(sheet.blocks) ? sheet.blocks.map(block => [block.title, block.body].filter(Boolean).join("\n")).filter(Boolean).join("\n\n") : ""),
            parentId: sheet.parentId || "",
            order: Number.isFinite(Number(sheet.order)) ? Number(sheet.order) : 0,
            created_at: sheet.created_at || new Date().toISOString(),
            updated_at: sheet.updated_at || new Date().toISOString()
        }))
        .forEach(sheet => {
            const existing = map.get(sheet.id);
            if (!existing) {
                map.set(sheet.id, sheet);
                return;
            }
            const existingTime = Date.parse(existing.updated_at || existing.created_at || 0) || 0;
            const sheetTime = Date.parse(sheet.updated_at || sheet.created_at || 0) || 0;
            map.set(sheet.id, sheetTime >= existingTime ? sheet : existing);
        });
    return Array.from(map.values()).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
}

function saveSheets(sheets) {
    const cleanedSheets = removeAutoBlankSheets(Array.isArray(sheets) ? sheets : []);
    localStorage.setItem(sheetsBackupKey(), JSON.stringify(cleanedSheets));
    saveLocalAndRemote(sheetsStorageKey(), "sheets", cleanedSheets);
    renderSheetsNav();
}

function sheetChildren(sheets, parentId = "") {
    return sheets
        .filter(sheet => (sheet.parentId || "") === parentId)
        .sort((a, b) => {
            const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
            return orderDiff || (a.created_at || "").localeCompare(b.created_at || "");
        });
}

function nextSheetOrder(sheets, parentId = "") {
    const children = sheets.filter(sheet => (sheet.parentId || "") === parentId);
    if (!children.length) return 0;
    return Math.max(...children.map(sheet => Number(sheet.order) || 0)) + 1;
}

function normalizeSheetSiblingOrders(sheets, parentId = "") {
    sheetChildren(sheets, parentId).forEach((sheet, index) => {
        const target = sheets.find(item => item.id === sheet.id);
        if (target) target.order = index;
    });
}

function createSheetObject(parentId = "", title = "Nuovo foglio", order = 0) {
    return {
        id: `sheet_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        title,
        body: "",
        parentId,
        order,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

function ensureDefaultSheet() {
    const sheets = loadSheets();
    if (!sheets.length) {
        const first = createSheetObject("", "Foglio bianco");
        sheets.unshift(first);
        saveSheets(sheets);
    }
    return sheets;
}

function renderSheetsNav() {
    const targets = document.querySelectorAll('[data-sheets-nav]');
    if (!targets.length) return;
    try {
        const sheets = loadSheets();
        const mainSheets = sheetChildren(sheets, "");
        const currentId = new URLSearchParams(window.location.search).get("id");
        const html = mainSheets.map(sheet => `
            <a class="${sheet.id === currentId ? "active" : ""}" href="fogli.html?id=${encodeURIComponent(sheet.id)}">${escapeHTML(sheet.title)}</a>
        `).join("") || '<a href="fogli.html">Foglio bianco</a>';

        targets.forEach(target => {
            target.innerHTML = html;
        });
    } catch (e) {
        targets.forEach(target => {
            target.innerHTML = '<a href="fogli.html">Foglio bianco</a>';
        });
    }
}

function quickAddSheet() {
    const title = prompt("Nome del nuovo foglio");
    if (!title || !title.trim()) return;
    const sheets = loadSheets();
    const sheet = createSheetObject("", title.trim(), nextSheetOrder(sheets, ""));
    sheets.push(sheet);
    saveSheets(sheets);
    window.location.href = `fogli.html?id=${encodeURIComponent(sheet.id)}`;
}

let currentSheetId = null;

function initSheetsPage() {
    const sheets = ensureDefaultSheet();
    const requestedId = new URLSearchParams(window.location.search).get("id");
    const selected = sheets.find(sheet => sheet.id === requestedId) || sheets[0];
    selectSheet(selected.id);
}

function createSheet(parentId = "") {
    const title = prompt("Nome del foglio");
    if (!title || !title.trim()) return;
    const sheets = loadSheets();
    const sheet = createSheetObject(parentId, title.trim(), nextSheetOrder(sheets, parentId));
    sheets.push(sheet);
    saveSheets(sheets);
    selectSheet(sheet.id);
}

function createChildSheet() {
    if (!currentSheetId) return;
    createSheet(currentSheetId);
}

function selectSheet(id) {
    currentSheetId = id;
    const sheets = loadSheets();
    const sheet = sheets.find(item => item.id === id);
    const editor = document.getElementById('sheet-editor');
    const empty = document.getElementById('sheet-editor-empty');
    if (!sheet || !editor || !empty) return;
    empty.style.display = 'none';
    editor.style.display = 'block';
    document.getElementById('sheet-title').value = sheet.title || "";
    document.getElementById('sheet-body').value = sheet.body || "";
    renderSheetTree();
    renderSheetChildren();
}

function renderSheetTree() {
    const container = document.getElementById('sheet-tree');
    if (!container) return;
    const sheets = loadSheets();
    const renderBranch = (parentId = "", depth = 0) => sheetChildren(sheets, parentId).map(sheet => `
        <div class="sheet-tree-item ${sheet.id === currentSheetId ? "active" : ""} ${depth ? "sheet-child" : ""}" draggable="true" ondragstart="sheetDragStart(event, '${sheet.id}')" ondragover="event.preventDefault()" ondrop="sheetDrop(event, '${sheet.id}')">
            <span class="drag-handle" title="Trascina foglio">::</span>
            <div class="sheet-tree-main" onclick="selectSheet('${sheet.id}')">
                <div class="sheet-tree-title">${escapeHTML(sheet.title)}</div>
                <div class="sheet-tree-meta">${sheetChildren(sheets, sheet.id).length} sotto-fogli</div>
            </div>
            <span class="sheet-row-actions">
                <button class="btn outline" onclick="moveSheet('${sheet.id}', -1)">Su</button>
                <button class="btn outline" onclick="moveSheet('${sheet.id}', 1)">Giu</button>
                <button class="btn outline" onclick="createSheet('${sheet.id}')">+</button>
            </span>
        </div>
        ${renderBranch(sheet.id, depth + 1)}
    `).join("");

    container.innerHTML = renderBranch() || '<p class="empty-state">Nessun foglio.</p>';
}

function renderSheetChildren() {
    const container = document.getElementById('sheet-children');
    if (!container) return;
    const sheets = loadSheets();
    const children = sheetChildren(sheets, currentSheetId);
    if (!children.length) {
        container.innerHTML = "";
        return;
    }
    container.innerHTML = `
        <div class="sheet-children-box">
        <div class="sheet-section-label">Sotto-fogli</div>
        ${children.map(child => `
            <div class="task-row" style="grid-template-columns:24px minmax(0,1fr) auto;">
                <span class="drag-handle" draggable="true" ondragstart="sheetDragStart(event, '${child.id}')" ondragover="event.preventDefault()" ondrop="sheetDrop(event, '${child.id}')" title="Trascina sotto-foglio">::</span>
                <span>
                    <span class="task-title">${escapeHTML(child.title)}</span>
                    <span class="task-meta">${sheetChildren(sheets, child.id).length} sotto-fogli interni</span>
                </span>
                <span class="sheet-row-actions">
                    <button class="btn outline" onclick="moveSheet('${child.id}', -1)">Su</button>
                    <button class="btn outline" onclick="moveSheet('${child.id}', 1)">Giu</button>
                    <button class="btn outline" onclick="selectSheet('${child.id}')">Apri</button>
                </span>
            </div>
        `).join("")}
        </div>
    `;
}

function moveSheet(sheetId, direction) {
    const sheets = loadSheets();
    const sheet = sheets.find(item => item.id === sheetId);
    if (!sheet) return;
    const parentId = sheet.parentId || "";
    const siblings = sheetChildren(sheets, parentId);
    const from = siblings.findIndex(item => item.id === sheetId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const [item] = siblings.splice(from, 1);
    siblings.splice(to, 0, item);
    siblings.forEach((sibling, index) => {
        const target = sheets.find(item => item.id === sibling.id);
        if (target) {
            target.order = index;
            target.updated_at = new Date().toISOString();
        }
    });
    saveSheets(sheets);
    renderSheetTree();
    renderSheetChildren();
}

function sheetDragStart(event, sheetId) {
    event.dataTransfer.setData("text/plain", sheetId);
    event.dataTransfer.effectAllowed = "move";
}

function sheetDrop(event, targetSheetId) {
    event.preventDefault();
    const sourceSheetId = event.dataTransfer.getData("text/plain");
    if (!sourceSheetId || sourceSheetId === targetSheetId) return;
    const sheets = loadSheets();
    const source = sheets.find(item => item.id === sourceSheetId);
    const target = sheets.find(item => item.id === targetSheetId);
    if (!source || !target || (source.parentId || "") !== (target.parentId || "")) return;
    const parentId = source.parentId || "";
    const siblings = sheetChildren(sheets, parentId);
    const from = siblings.findIndex(item => item.id === sourceSheetId);
    const to = siblings.findIndex(item => item.id === targetSheetId);
    if (from < 0 || to < 0) return;
    const [item] = siblings.splice(from, 1);
    siblings.splice(to, 0, item);
    siblings.forEach((sibling, index) => {
        const original = sheets.find(item => item.id === sibling.id);
        if (original) {
            original.order = index;
            original.updated_at = new Date().toISOString();
        }
    });
    saveSheets(sheets);
    renderSheetTree();
    renderSheetChildren();
}

function getCurrentSheet() {
    return loadSheets().find(sheet => sheet.id === currentSheetId);
}

function updateCurrentSheet(mutator) {
    const sheets = loadSheets();
    const index = sheets.findIndex(sheet => sheet.id === currentSheetId);
    if (index === -1) return;
    mutator(sheets[index]);
    sheets[index].updated_at = new Date().toISOString();
    saveSheets(sheets);
    renderSheetTree();
    renderSheetChildren();
}

function saveCurrentSheet() {
    const status = document.getElementById('sheet-status');
    updateCurrentSheet(sheet => {
        sheet.title = document.getElementById('sheet-title').value.trim() || "Foglio senza titolo";
        sheet.body = document.getElementById('sheet-body').value;
    });
    renderSheetsNav();
    if (status) status.textContent = "Foglio salvato.";
}

function collectDescendantSheetIds(sheets, parentId) {
    const children = sheetChildren(sheets, parentId);
    return children.flatMap(child => [child.id, ...collectDescendantSheetIds(sheets, child.id)]);
}

function deleteCurrentSheet() {
    const sheet = getCurrentSheet();
    if (!sheet) return;
    if (!confirm(`Eliminare "${sheet.title}" e tutti i suoi sotto-fogli?`)) return;
    const sheets = loadSheets();
    const toDelete = new Set([sheet.id, ...collectDescendantSheetIds(sheets, sheet.id)]);
    const remaining = sheets.filter(item => !toDelete.has(item.id));
    saveSheets(remaining);
    const finalSheets = remaining.length ? remaining : ensureDefaultSheet();
    const next = finalSheets[0];
    if (next) {
        selectSheet(next.id);
    } else {
        currentSheetId = null;
        document.getElementById('sheet-editor').style.display = 'none';
        document.getElementById('sheet-editor-empty').style.display = 'block';
        renderSheetTree();
    }
}

const defaultExtraShoppingColumns = [
    { id: "da_comprare", title: "Da comprare", color: "#10b981", fixed: true },
    { id: "cibo_extra_menu", title: "Cibo extra menu", color: "#f59e0b", fixed: true },
    { id: "cucina", title: "Cucina", color: "#38bdf8", fixed: true },
    { id: "bagno", title: "Bagno", color: "#a78bfa", fixed: true },
    { id: "oggetti_extra_fissi", title: "Oggetti extra fissi", color: "#f472b6", fixed: true }
];

function extraShoppingKey() {
    return `pantrypro_extra_shopping:${getStoredUserId()}`;
}

function extraShoppingColumnsKey() {
    return `pantrypro_extra_shopping_columns:${getStoredUserId()}`;
}

function loadExtraShoppingColumns() {
    const saved = readStoredList(extraShoppingColumnsKey());
    const savedById = new Map(saved.filter(column => column && column.id).map(column => [column.id, column]));
    const base = defaultExtraShoppingColumns.map(column => {
        const stored = savedById.get(column.id) || {};
        return {
            ...column,
            title: stored.title || column.title,
            color: stored.color || column.color,
            fixed: true
        };
    });
    const custom = saved
        .filter(column => column && column.id && !defaultExtraShoppingColumns.some(baseColumn => baseColumn.id === column.id))
        .map(column => ({
            id: column.id,
            title: column.title || "Nuova colonna",
            color: column.color || "#60a5fa",
            fixed: false
        }));
    return [...base, ...custom];
}

function saveExtraShoppingColumns(columns) {
    saveLocalAndRemote(extraShoppingColumnsKey(), "extra_shopping_columns", columns || []);
}

function createExtraColumn() {
    const title = prompt("Nome della nuova colonna");
    if (!title || !title.trim()) return;
    const color = prompt("Colore della colonna in formato esadecimale", "#60a5fa") || "#60a5fa";
    const columns = loadExtraShoppingColumns();
    columns.push({
        id: `extra_col_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        title: title.trim(),
        color: normalizeExtraColor(color),
        fixed: false
    });
    saveExtraShoppingColumns(columns);
    renderExtraShoppingBoard();
}

function normalizeExtraColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : "#60a5fa";
}

function updateExtraColumnColor(columnId, color) {
    const columns = loadExtraShoppingColumns();
    const column = columns.find(item => item.id === columnId);
    if (!column) return;
    column.color = normalizeExtraColor(color);
    saveExtraShoppingColumns(columns);
    renderExtraShoppingBoard();
}

function updateExtraColumnTitle(columnId, title) {
    const columns = loadExtraShoppingColumns();
    const column = columns.find(item => item.id === columnId);
    if (!column) return;
    column.title = title.trim() || column.title || "Nuova colonna";
    saveExtraShoppingColumns(columns);
    renderExtraShoppingBoard();
}

function deleteExtraColumn(columnId) {
    const columns = loadExtraShoppingColumns();
    const column = columns.find(item => item.id === columnId);
    if (!column || column.fixed) return;
    if (!confirm(`Eliminare la colonna "${column.title}"? Le card verranno spostate in Cibo extra menu.`)) return;
    saveExtraShoppingColumns(columns.filter(item => item.id !== columnId));
    const cards = loadExtraShopping().map(card => card.columnId === columnId ? { ...card, columnId: "cibo_extra_menu" } : card);
    saveExtraShopping(cards);
    renderExtraShoppingBoard();
}

function newExtraShoppingCard(columnId, text = "") {
    return {
        id: `extra_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        columnId,
        text,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

function loadExtraShopping() {
    const data = readStoredList(extraShoppingKey());
    const columns = loadExtraShoppingColumns();
    return data
        .filter(item => item && item.id)
        .map(item => ({
            id: item.id,
            columnId: columns.some(column => column.id === item.columnId) ? item.columnId : "cibo_extra_menu",
            text: item.text || item.title || "",
            created_at: item.created_at || new Date().toISOString(),
            updated_at: item.updated_at || new Date().toISOString()
        }));
}

function saveExtraShopping(cards) {
    saveLocalAndRemote(extraShoppingKey(), "extra_shopping", cards || []);
}

function initExtraShoppingPage() {
    renderExtraShoppingBoard();
}

function renderExtraShoppingBoard() {
    const board = document.getElementById("extra-shopping-board");
    if (!board) return;
    const cards = loadExtraShopping();
    const columns = loadExtraShoppingColumns();

    board.innerHTML = columns.map(column => {
        const columnCards = cards.filter(card => card.columnId === column.id);
        return `
            <section class="extra-column" style="--extra-column-color:${escapeHTML(column.color)};" ondragover="event.preventDefault()" ondrop="dropExtraShoppingCard(event, '${column.id}')">
                <header class="extra-column-head">
                    <div>
                        <input class="extra-column-title-input" value="${escapeHTML(column.title)}" onchange="updateExtraColumnTitle('${column.id}', this.value)">
                        <span>${columnCards.length} elementi</span>
                    </div>
                    <div class="extra-column-tools">
                        <input class="extra-color-input" type="color" value="${escapeHTML(column.color)}" onchange="updateExtraColumnColor('${column.id}', this.value)" title="Colore colonna">
                        <button class="btn outline extra-add-btn" onclick="addExtraShoppingCard('${column.id}')">+</button>
                        ${column.fixed ? "" : `<button class="extra-card-action danger" onclick="deleteExtraColumn('${column.id}')">Elimina</button>`}
                    </div>
                </header>
                <div class="extra-card-list">
                    ${columnCards.map(card => renderExtraShoppingCard(card, column)).join("")}
                    ${!columnCards.length ? `<div class="extra-empty">Trascina qui o aggiungi una card.</div>` : ""}
                </div>
            </section>
        `;
    }).join("");
}

function renderExtraShoppingCard(card, column) {
    const text = escapeHTML(card.text || "");
    const addToBuyButton = card.columnId === "da_comprare"
        ? ""
        : `<button class="extra-card-action" onclick="moveExtraCardToBuy('${card.id}')">Da comprare</button>`;
    return `
        <article class="extra-card" style="--extra-column-color:${escapeHTML(column.color)};" draggable="true" ondragstart="startExtraShoppingDrag(event, '${card.id}')" ondragover="event.preventDefault()" ondrop="dropExtraShoppingCard(event, '${card.columnId}', '${card.id}')">
            <textarea rows="3" placeholder="Scrivi oggetto..." oninput="updateExtraShoppingCard('${card.id}', this.value)">${text}</textarea>
            <div class="extra-card-footer">
                ${addToBuyButton}
                <button class="extra-card-action danger" onclick="deleteExtraShoppingCard('${card.id}')">Elimina</button>
            </div>
        </article>
    `;
}

function addExtraShoppingCard(columnId = "cibo_extra_menu") {
    const cards = loadExtraShopping();
    cards.push(newExtraShoppingCard(columnId, ""));
    saveExtraShopping(cards);
    renderExtraShoppingBoard();
}

function updateExtraShoppingCard(cardId, value) {
    const cards = loadExtraShopping();
    const card = cards.find(item => item.id === cardId);
    if (!card) return;
    card.text = value;
    card.updated_at = new Date().toISOString();
    saveExtraShopping(cards);
}

function deleteExtraShoppingCard(cardId) {
    const card = loadExtraShopping().find(item => item.id === cardId);
    if (card && card.text && !confirm(`Eliminare "${card.text}"?`)) return;
    saveExtraShopping(loadExtraShopping().filter(item => item.id !== cardId));
    renderExtraShoppingBoard();
}

function moveExtraCardToBuy(cardId) {
    const cards = loadExtraShopping();
    const card = cards.find(item => item.id === cardId);
    if (!card) return;
    card.columnId = "da_comprare";
    card.updated_at = new Date().toISOString();
    saveExtraShopping(cards);
    renderExtraShoppingBoard();
}

function startExtraShoppingDrag(event, cardId) {
    event.dataTransfer.setData("text/plain", cardId);
    event.dataTransfer.effectAllowed = "move";
}

function dropExtraShoppingCard(event, columnId, beforeId = "") {
    event.preventDefault();
    event.stopPropagation();
    const cardId = event.dataTransfer.getData("text/plain");
    if (!cardId) return;

    const cards = loadExtraShopping();
    const moving = cards.find(card => card.id === cardId);
    if (!moving) return;
    moving.columnId = columnId;
    moving.updated_at = new Date().toISOString();

    const withoutMoving = cards.filter(card => card.id !== cardId);
    const targetCards = withoutMoving.filter(card => card.columnId === columnId);
    const beforeIndex = beforeId ? targetCards.findIndex(card => card.id === beforeId) : -1;
    const orderedTarget = [...targetCards];
    if (beforeIndex >= 0) orderedTarget.splice(beforeIndex, 0, moving);
    else orderedTarget.push(moving);

    const next = [];
    loadExtraShoppingColumns().forEach(column => {
        if (column.id === columnId) {
            next.push(...orderedTarget);
        } else {
            next.push(...withoutMoving.filter(card => card.columnId === column.id));
        }
    });
    saveExtraShopping(next);
    renderExtraShoppingBoard();
}

function extraShoppingBuyCards() {
    return loadExtraShopping()
        .filter(card => card.columnId === "da_comprare" && card.text.trim())
        .map(card => ({ ...card, text: card.text.trim() }));
}

function completeExtraShoppingItem(cardId) {
    saveExtraShopping(loadExtraShopping().filter(card => card.id !== cardId));
    const inv = window.lastInventoryForShopping || {};
    calcolaSpesa(inv);
}

let exportPortableData = { routine: [], sottoroutine: [], piani: [], inventario: [], spesa_extra: [], dashboard_comments: [], dashboard_notes: [], sheets: [] };
let importPortableData = null;

const portableGroups = [
    { key: "routine", title: "Routine" },
    { key: "sottoroutine", title: "Sottoroutine" },
    { key: "piani", title: "Piani menu" },
    { key: "inventario", title: "Inventario" },
    { key: "spesa_extra", title: "Spesa extra" },
    { key: "dashboard_comments", title: "Commenti dashboard" },
    { key: "dashboard_notes", title: "Note dashboard" },
    { key: "sheets", title: "Fogli" }
];

async function initDataPortability() {
    await loadPortableData();
    renderPortableExportSelectors();
}

async function loadPortableData() {
    const status = document.getElementById("export-status");
    if (status) status.textContent = "Carico i dati disponibili...";
    const warnings = [];
    const [routineList, subList, menuList, inventario] = await Promise.all([
        fetchJsonOrDefault(`${API}/routine/list`, [], "routine/list"),
        fetchJsonOrDefault(`${API}/sottoroutine/list`, [], "sottoroutine/list"),
        fetchJsonOrDefault(`${API}/menu/list`, [], "menu/list"),
        fetchJsonOrDefault(`${API}/get-inventario`, {}, "get-inventario")
    ]);

    const [routineResult, subResult, menuResult] = await Promise.allSettled([
        caricaDettagliDaLista("routine", routineList),
        caricaDettagliDaLista("sottoroutine", subList),
        loadMenuPlanDetails(menuList)
    ]);
    if (routineResult.status === "rejected") warnings.push("routine");
    if (subResult.status === "rejected") warnings.push("sottoroutine");
    if (menuResult.status === "rejected") warnings.push("menu");

    exportPortableData = {
        routine: routineResult.status === "fulfilled" ? routineResult.value : [],
        sottoroutine: subResult.status === "fulfilled" ? subResult.value : [],
        piani: menuResult.status === "fulfilled" ? menuResult.value : [],
        inventario: Object.entries(inventario || {}).map(([nome, item]) => ({ nome, ...item })),
        spesa_extra: portableExtraShoppingColumns(),
        dashboard_comments: readStoredList(dashboardCommentsKey()),
        dashboard_notes: readStoredList(dashboardNotesKey()),
        sheets: loadSheets()
    };
    if (status) status.textContent = warnings.length
        ? `Dati caricati parzialmente. Controlla: ${warnings.join(", ")}.`
        : "Dati pronti per esportazione o importazione.";
}

async function loadMenuPlanDetails(menuList) {
    const names = Array.isArray(menuList) ? menuList : [];
    const details = [];
    for (const name of names) {
        try {
            const res = await apiFetch(`${API}/menu/${encodeURIComponent(name)}`);
            if (res.ok) details.push(await res.json());
        } catch (e) {
            console.error("Errore caricamento piano:", name, e);
        }
    }
    return details;
}

function portableLabel(type, item) {
    if (type === "inventario") return item.nome || item.name || "Ingrediente";
    if (type === "spesa_extra") return item.title || "Colonna spesa extra";
    if (type === "dashboard_comments") return item.text ? item.text.slice(0, 48) : "Commento";
    if (type === "dashboard_notes") return item.title || "Nota";
    if (type === "sheets") return item.title || "Foglio";
    return item.nome || item.filename || item.name || "Elemento senza nome";
}

function portableExtraShoppingColumns() {
    const cards = loadExtraShopping();
    return loadExtraShoppingColumns().map(column => ({
        id: column.id,
        title: column.title,
        color: column.color,
        fixed: !!column.fixed,
        cards: cards
            .filter(card => card.columnId === column.id)
            .map(card => ({
                id: card.id,
                text: card.text || "",
                created_at: card.created_at,
                updated_at: card.updated_at
            }))
    }));
}

function renderPortableExportSelectors() {
    const root = document.getElementById("export-data-groups");
    if (!root) return;
    root.innerHTML = portableGroups.map(group => {
        const items = exportPortableData[group.key] || [];
        return `
            <section class="portable-group">
                <header>
                    <div>
                        <h3>${group.title}</h3>
                        <span>${items.length} elementi</span>
                    </div>
                    <label class="portable-select-all">
                        <input type="checkbox" checked onchange="togglePortableGroup('${group.key}', this.checked)">
                        Tutti
                    </label>
                </header>
                <div class="portable-check-list">
                    ${items.length ? items.map((item, index) => `
                        <label>
                            <input type="checkbox" data-export-type="${group.key}" data-export-index="${index}" checked>
                            <span>${escapeHTML(portableLabel(group.key, item))}</span>
                        </label>
                    `).join("") : `<p class="portable-empty">Nessun dato trovato.</p>`}
                </div>
            </section>
        `;
    }).join("");
}

function togglePortableGroup(type, checked) {
    document.querySelectorAll(`[data-export-type="${type}"]`).forEach(input => {
        input.checked = checked;
    });
}

function selectedPortableData() {
    const data = Object.fromEntries(portableGroups.map(group => [group.key, []]));
    document.querySelectorAll("[data-export-type]").forEach(input => {
        if (!input.checked) return;
        const type = input.dataset.exportType;
        const index = parseInt(input.dataset.exportIndex, 10);
        const item = (exportPortableData[type] || [])[index];
        if (item) data[type].push(item);
    });
    return data;
}

function portablePackage(data) {
    return {
        routineos_export: true,
        pantrypro_export: true,
        version: 1,
        exported_at: new Date().toISOString(),
        data
    };
}

function downloadTextFile(filename, content, mime = "text/plain;charset=utf-8") {
    downloadBlob(filename, new Blob([content], { type: mime }));
}

function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function exportSelectedData(format) {
    const data = selectedPortableData();
    const hasData = Object.values(data).some(items => items.length);
    const status = document.getElementById("export-status");
    if (!hasData) {
        if (status) status.textContent = "Seleziona almeno un elemento da esportare.";
        return;
    }
    const date = localISODate();
    const pack = portablePackage(data);
    if (format === "json") {
        downloadTextFile(`routineos_export_${date}.json`, JSON.stringify(pack, null, 2), "application/json;charset=utf-8");
    } else if (format === "csv") {
        downloadTextFile(`routineos_export_${date}.csv`, portableDataToCsv(data), "text/csv;charset=utf-8");
    } else if (format === "excel") {
        downloadBlob(
            `routineos_export_${date}.xlsx`,
            portableDataToXlsxBlob(data)
        );
    } else if (format === "pdf") {
        downloadPortablePdf(pack);
    }
    if (status) status.textContent = `Esportazione ${format.toUpperCase()} creata.`;
}

function portableRows(data) {
    const rows = [];
    Object.entries(data).forEach(([type, items]) => {
        (items || []).forEach(item => {
            rows.push({
                categoria: type,
                nome: portableLabel(type, item),
                riepilogo: portableSummary(type, item),
                dettagli: portableDetails(type, item),
                dati: JSON.stringify(item)
            });
        });
    });
    return rows;
}

function portableSummary(type, item) {
    if (type === "routine") {
        const count = (item.elementi || []).length;
        return `${item.frequenza || "giornaliera"} - ${count} attivita`;
    }
    if (type === "sottoroutine") {
        const count = (item.elementi || []).length;
        return `${item.routine_parent || "Senza routine principale"} - ${count} attivita`;
    }
    if (type === "piani") {
        const pasti = (item.pasti || []).length;
        return `${item.inizio || "-"} / ${item.fine || "-"} - ${pasti} pasti`;
    }
    if (type === "inventario") {
        return `${item.confezioni_attuali ?? 0}/${item.confezioni_massime ?? 0} confezioni - ${item.unita_misura || "unita"}`;
    }
    if (type === "spesa_extra") {
        const count = (item.cards || []).filter(card => (card.text || "").trim()).length;
        return `${count} card - colore ${item.color || "-"}`;
    }
    if (type === "dashboard_comments") return item.created_at ? new Date(item.created_at).toLocaleString("it-IT") : "Commento dashboard";
    if (type === "dashboard_notes") return item.created_at ? new Date(item.created_at).toLocaleString("it-IT") : "Nota dashboard";
    if (type === "sheets") return `${(item.body || "").length} caratteri - ${item.parentId ? "sottofoglio" : "foglio principale"}`;
    return "";
}

function portableDetails(type, item) {
    if (type === "routine" || type === "sottoroutine") {
        const lines = [
            `Periodo: ${item.inizio || "-"} / ${item.fine || "-"}`,
            `Frequenza: ${item.frequenza || "-"}`,
            type === "sottoroutine" ? `Routine collegata: ${item.routine_parent || "-"}` : "",
            ...(item.elementi || []).map(el => {
                const day = el.giorno_settimana !== undefined && el.giorno_settimana !== "" ? ` giorno ${el.giorno_settimana}` : "";
                return `${el.orario ? el.orario + " - " : ""}${el.titolo || el.nome || "Attivita"}${day}`;
            })
        ].filter(Boolean);
        return lines.join("\n");
    }
    if (type === "piani") {
        return (item.pasti || []).map(pasto => {
            const piatti = (pasto.piatti || []).map(piatto => {
                const ingredienti = (piatto.ingredienti || []).map(ing => `${ing.qta || ""}${ing.unita || ""} ${nomeIngredienteDisplay(ing.nome || "")}`.trim()).join(", ");
                return `${piatto.nome}${ingredienti ? ` (${ingredienti})` : ""}`;
            }).join("; ");
            return `${pasto.giorno || "-"} - ${pasto.nome || "Pasto"}: ${piatti || "nessun piatto"}`;
        }).join("\n");
    }
    if (type === "inventario") {
        return [
            `Attuali: ${item.confezioni_attuali ?? 0}`,
            `Massime: ${item.confezioni_massime ?? 0}`,
            `Alert: ${item.alert ?? 0}`,
            `Unita: ${item.unita_misura || "-"}`,
            `Valore confezione: ${item.valore_per_confezione || item.grammi_per_confezione || item.ml_per_confezione || item.pezzi_per_confezione || "-"}`
        ].join("\n");
    }
    if (type === "spesa_extra") {
        return (item.cards || [])
            .map(card => (card.text || "").trim())
            .filter(Boolean)
            .join("\n") || "Colonna vuota";
    }
    if (type === "dashboard_comments") return item.text || "";
    if (type === "dashboard_notes") return [item.title || "Nota", item.body || item.description || ""].filter(Boolean).join("\n");
    if (type === "sheets") return [item.title || "Foglio", item.body || ""].filter(Boolean).join("\n");
    return JSON.stringify(item, null, 2);
}

function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function portableDataToCsv(data) {
    const rows = portableRows(data);
    return ["categoria,nome,riepilogo,dettagli,dati_json", ...rows.map(row => [
        csvEscape(row.categoria),
        csvEscape(row.nome),
        csvEscape(row.riepilogo),
        csvEscape(row.dettagli),
        csvEscape(row.dati)
    ].join(","))].join("\n");
}

function xmlEscape(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function xlsxCell(value) {
    return `<c t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function portableDataToWorksheetXml(data) {
    const rows = portableRows(data);
    const header = ["Categoria", "Nome", "Riepilogo", "Dettagli", "Dati importazione"];
    const sheetRows = [
        header,
        ...rows.map(row => [row.categoria, row.nome, row.riepilogo, row.dettagli, row.dati])
    ];
    const body = sheetRows.map((row, index) =>
        `<row r="${index + 1}">${row.map(xlsxCell).join("")}</row>`
    ).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="5" width="52" customWidth="1"/></cols>
  <sheetData>${body}</sheetData>
</worksheet>`;
}

function crc32(bytes) {
    if (!crc32.table) {
        crc32.table = Array.from({ length: 256 }, (_, n) => {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            return c >>> 0;
        });
    }
    let crc = -1;
    bytes.forEach(byte => {
        crc = (crc >>> 8) ^ crc32.table[(crc ^ byte) & 0xff];
    });
    return (crc ^ -1) >>> 0;
}

function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
}

function writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
}

function makeZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    files.forEach(file => {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = encoder.encode(file.content);
        const crc = crc32(dataBytes);
        const local = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(local.buffer);
        writeUint32(localView, 0, 0x04034b50);
        writeUint16(localView, 4, 20);
        writeUint16(localView, 6, 0);
        writeUint16(localView, 8, 0);
        writeUint16(localView, 10, 0);
        writeUint16(localView, 12, 0);
        writeUint32(localView, 14, crc);
        writeUint32(localView, 18, dataBytes.length);
        writeUint32(localView, 22, dataBytes.length);
        writeUint16(localView, 26, nameBytes.length);
        writeUint16(localView, 28, 0);
        local.set(nameBytes, 30);
        chunks.push(local, dataBytes);

        const centralFile = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(centralFile.buffer);
        writeUint32(centralView, 0, 0x02014b50);
        writeUint16(centralView, 4, 20);
        writeUint16(centralView, 6, 20);
        writeUint16(centralView, 8, 0);
        writeUint16(centralView, 10, 0);
        writeUint16(centralView, 12, 0);
        writeUint16(centralView, 14, 0);
        writeUint32(centralView, 16, crc);
        writeUint32(centralView, 20, dataBytes.length);
        writeUint32(centralView, 24, dataBytes.length);
        writeUint16(centralView, 28, nameBytes.length);
        writeUint16(centralView, 30, 0);
        writeUint16(centralView, 32, 0);
        writeUint16(centralView, 34, 0);
        writeUint16(centralView, 36, 0);
        writeUint32(centralView, 38, 0);
        writeUint32(centralView, 42, offset);
        centralFile.set(nameBytes, 46);
        central.push(centralFile);
        offset += local.length + dataBytes.length;
    });
    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    writeUint32(endView, 0, 0x06054b50);
    writeUint16(endView, 8, files.length);
    writeUint16(endView, 10, files.length);
    writeUint32(endView, 12, centralSize);
    writeUint32(endView, 16, offset);
    writeUint16(endView, 20, 0);
    return new Blob([...chunks, ...central, end], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
}

function portableDataToXlsxBlob(data) {
    return makeZip([
        {
            name: "[Content_Types].xml",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
        },
        {
            name: "_rels/.rels",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
        },
        {
            name: "xl/workbook.xml",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="RoutineOS" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
        },
        {
            name: "xl/_rels/workbook.xml.rels",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
        },
        {
            name: "xl/worksheets/sheet1.xml",
            content: portableDataToWorksheetXml(data)
        }
    ]);
}

function portableTypeTitle(type) {
    const titles = {
        routine: "Routine",
        sottoroutine: "Sottoroutine",
        piani: "Piani menu",
        inventario: "Inventario",
        spesa_extra: "Spesa extra",
        dashboard_comments: "Commenti dashboard",
        dashboard_notes: "Note dashboard",
        sheets: "Fogli"
    };
    return titles[type] || type;
}

function downloadPortablePdf(pack) {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) {
        alert("Modulo PDF non ancora caricato. Riprova tra qualche secondo oppure esporta in CSV/Excel.");
        return;
    }
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 42;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = margin;
    const addLine = (text, size = 10, bold = false, color = [15, 23, 42]) => {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(size);
        doc.setTextColor(...color);
        const lines = doc.splitTextToSize(String(text || ""), pageWidth - margin * 2);
        lines.forEach(line => {
            if (y > pageHeight - margin) {
                doc.addPage();
                y = margin;
            }
            doc.text(line, margin, y);
            y += size + 5;
        });
    };
    addLine("Esportazione RoutineOS", 18, true, [29, 78, 216]);
    addLine(`Creata il ${new Date(pack.exported_at).toLocaleString("it-IT")}`, 10, false, [71, 85, 105]);
    y += 10;
    Object.entries(pack.data || {}).forEach(([type, items]) => {
        addLine(portableTypeTitle(type), 14, true, [29, 78, 216]);
        if (!(items || []).length) {
            addLine("Nessun elemento.", 10, false, [100, 116, 139]);
            y += 6;
            return;
        }
        (items || []).forEach(item => {
            addLine(portableLabel(type, item), 12, true);
            addLine(portableSummary(type, item), 9, false, [71, 85, 105]);
            addLine(portableDetails(type, item), 9);
            y += 10;
        });
    });
    doc.save(`routineos_export_${localISODate()}.pdf`);
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (quoted) {
            if (c === '"' && next === '"') {
                value += '"';
                i++;
            } else if (c === '"') {
                quoted = false;
            } else {
                value += c;
            }
        } else if (c === '"') {
            quoted = true;
        } else if (c === ",") {
            row.push(value);
            value = "";
        } else if (c === "\n") {
            row.push(value);
            rows.push(row);
            row = [];
            value = "";
        } else if (c !== "\r") {
            value += c;
        }
    }
    row.push(value);
    rows.push(row);
    return rows.filter(item => item.some(cell => cell !== ""));
}

function portableFromRows(rows) {
    const data = Object.fromEntries(portableGroups.map(group => [group.key, []]));
    const headerRowIndex = rows.findIndex(row => row.some(cell => String(cell || "").toLowerCase() === "categoria"));
    const effectiveRows = headerRowIndex >= 0 ? rows.slice(headerRowIndex) : rows;
    const headers = (effectiveRows[0] || []).map(cell => String(cell || "").toLowerCase());
    const hasHeader = headers.includes("categoria");
    const start = hasHeader ? 1 : 0;
    const categoryIndex = hasHeader ? headers.indexOf("categoria") : 0;
    const jsonIndex = hasHeader
        ? Math.max(headers.indexOf("dati_json"), headers.indexOf("dati importazione"), headers.indexOf("dati"))
        : 2;
    for (let i = start; i < effectiveRows.length; i++) {
        const type = effectiveRows[i][categoryIndex];
        const raw = effectiveRows[i][jsonIndex];
        if (!data[type] || !raw) continue;
        try {
            data[type].push(JSON.parse(raw));
        } catch (e) {
            console.warn("Riga import ignorata:", effectiveRows[i], e);
        }
    }
    return data;
}

function parsePortableImport(text, filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".json")) {
        const parsed = JSON.parse(text);
        return (parsed.routineos_export || parsed.pantrypro_export) ? parsed.data : parsed;
    }
    if (lower.endsWith(".csv")) {
        return portableFromRows(parseCsv(text));
    }
    if (lower.endsWith(".xls") || lower.endsWith(".xml") || lower.endsWith(".html")) {
        const type = text.trim().startsWith("<?xml") || text.includes("<Workbook")
            ? "text/xml"
            : "text/html";
        const doc = new DOMParser().parseFromString(text, type);
        const rows = [...doc.querySelectorAll("Row, tr")].map(tr => [...tr.children].map(td => td.textContent || ""));
        return portableFromRows(rows);
    }
    if (lower.endsWith(".xlsx")) {
        throw new Error("I file .xlsx moderni non sono leggibili direttamente senza una libreria dedicata. Aprilo in Excel e salvalo come CSV, oppure importa il file .xls esportato da RoutineOS.");
    }
    if (lower.endsWith(".pdf")) {
        throw new Error("L'importazione automatica da PDF non e supportata in modo affidabile. Esporta/importa in JSON, CSV o Excel per mantenere i dati strutturati.");
    }
    throw new Error("Formato non riconosciuto. Usa JSON, CSV o il file Excel esportato da RoutineOS.");
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    const status = document.getElementById("import-status");
    importPortableData = null;
    if (!file) return;
    try {
        const text = await file.text();
        importPortableData = normalizePortableData(parsePortableImport(text, file.name));
        renderImportPreview(importPortableData);
        if (status) status.textContent = `File pronto: ${file.name}`;
    } catch (e) {
        console.error("Errore import:", e);
        if (status) status.textContent = e.message || "File non leggibile.";
    }
}

function normalizePortableData(data = {}) {
    return {
        routine: Array.isArray(data.routine) ? data.routine : [],
        sottoroutine: Array.isArray(data.sottoroutine) ? data.sottoroutine : [],
        piani: Array.isArray(data.piani) ? data.piani : [],
        inventario: Array.isArray(data.inventario) ? data.inventario : [],
        spesa_extra: Array.isArray(data.spesa_extra) ? data.spesa_extra : [],
        dashboard_comments: Array.isArray(data.dashboard_comments) ? data.dashboard_comments : [],
        dashboard_notes: Array.isArray(data.dashboard_notes) ? data.dashboard_notes : [],
        sheets: Array.isArray(data.sheets) ? data.sheets : []
    };
}

function renderImportPreview(data) {
    const preview = document.getElementById("import-preview");
    if (!preview) return;
    preview.innerHTML = portableGroups.map(({ key, title }) => `
        <label class="import-preview-row">
            <input type="checkbox" data-import-type="${key}" checked>
            <span><strong>${title}</strong> ${(data[key] || []).length} elementi</span>
        </label>
    `).join("");
}

async function importSelectedData() {
    const status = document.getElementById("import-status");
    if (!importPortableData) {
        if (status) status.textContent = "Scegli prima un file da importare.";
        return;
    }
    const selected = new Set([...document.querySelectorAll("[data-import-type]")].filter(input => input.checked).map(input => input.dataset.importType));
    if (!selected.size) {
        if (status) status.textContent = "Seleziona almeno una categoria da importare.";
        return;
    }
    await importPortableDataSet(importPortableData, selected, status, "Importare i dati selezionati? Gli elementi con lo stesso nome verranno aggiornati.");
}

async function importPortableDataSet(portableData, selectedTypes, status = null, confirmMessage = null) {
    const dataToImport = normalizePortableData(portableData || {});
    const selected = selectedTypes instanceof Set ? selectedTypes : new Set(selectedTypes || Object.keys(dataToImport));
    if (!selected.size) {
        if (status) status.textContent = "Seleziona almeno una categoria da importare.";
        return false;
    }
    if (confirmMessage && !confirm(confirmMessage)) return false;
    const errors = [];
    if (status) status.textContent = "Importazione in corso...";
    try {
        if (selected.has("routine")) {
            for (const item of dataToImport.routine) {
                const nome = item.nome || item.filename;
                if (!nome) continue;
                const res = await apiFetch(`${API}/routine/save`, { method: "POST", body: JSON.stringify({ filename: nome, routine: item }) });
                if (!res.ok) errors.push(`Routine ${nome}`);
            }
        }
        if (selected.has("sottoroutine")) {
            for (const item of dataToImport.sottoroutine) {
                const nome = item.nome || item.filename;
                if (!nome) continue;
                const res = await apiFetch(`${API}/sottoroutine/save`, { method: "POST", body: JSON.stringify({ filename: nome, sottoroutine: item }) });
                if (!res.ok) errors.push(`Sottoroutine ${nome}`);
            }
        }
        if (selected.has("piani")) {
            for (const item of dataToImport.piani) {
                const nome = item.nome || item.filename;
                if (!nome) continue;
                const res = await apiFetch(`${API}/menu/save`, { method: "POST", body: JSON.stringify({ filename: nome, menu: item }) });
                if (!res.ok) errors.push(`Piano ${nome}`);
            }
        }
        if (selected.has("inventario") && dataToImport.inventario.length) {
            const res = await apiFetch(`${API}/inventario/save`, {
                method: "POST",
                body: JSON.stringify({ inventario: dataToImport.inventario })
            });
            if (!res.ok) errors.push("Inventario");
        }
        if (selected.has("spesa_extra") && dataToImport.spesa_extra.length) {
            importExtraShoppingColumns(dataToImport.spesa_extra);
        }
        if (selected.has("dashboard_comments") && dataToImport.dashboard_comments.length) {
            const comments = [...dataToImport.dashboard_comments, ...readStoredList(dashboardCommentsKey())];
            saveDashboardComments(mergePortableItems(comments));
        }
        if (selected.has("dashboard_notes") && dataToImport.dashboard_notes.length) {
            const notes = [...dataToImport.dashboard_notes, ...readStoredList(dashboardNotesKey())];
            saveDashboardNotes(mergePortableItems(notes));
        }
        if (selected.has("sheets") && dataToImport.sheets.length) {
            saveSheets(mergeSheetsCollections(loadSheets(), dataToImport.sheets));
        }
        try {
            await loadPortableData();
            renderPortableExportSelectors();
        } catch (refreshError) {
            console.warn("Refresh dopo import non riuscito:", refreshError);
        }
        if (status) status.textContent = errors.length
            ? `Importazione completata con errori: ${errors.join(", ")}`
            : "Importazione completata.";
        return !errors.length;
    } catch (e) {
        console.error("Import fallito:", e);
        if (status) status.textContent = `Importazione non riuscita: ${e.message || e}`;
        return false;
    }
}

function importExtraShoppingColumns(columns) {
    const currentColumns = loadExtraShoppingColumns();
    const currentCards = loadExtraShopping();
    const nextColumns = [...currentColumns];
    const nextCards = [...currentCards];

    columns.forEach(column => {
        const originalId = column.id || `extra_col_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        let target = nextColumns.find(item => item.id === originalId || normalizeName(item.title) === normalizeName(column.title));
        if (!target) {
            target = {
                id: originalId === "da_comprare" ? "da_comprare" : `extra_col_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                title: column.title || "Colonna importata",
                color: normalizeExtraColor(column.color || "#60a5fa"),
                fixed: false
            };
            nextColumns.push(target);
        } else {
            target.title = column.title || target.title;
            target.color = normalizeExtraColor(column.color || target.color);
        }

        (column.cards || []).forEach(card => {
            const text = (card.text || "").trim();
            if (!text) return;
            nextCards.push({
                id: `extra_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                columnId: target.id,
                text,
                created_at: card.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        });
    });

    saveExtraShoppingColumns(nextColumns);
    saveExtraShopping(nextCards);
}

function mergePortableItems(items) {
    const map = new Map();
    items.forEach(item => {
        if (!item) return;
        const key = item.id || `${item.title || item.text || "item"}:${item.created_at || ""}`;
        map.set(key, item);
    });
    return [...map.values()];
}

function pendingTasksKey() {
    return `pantrypro_pending_tasks:${getStoredUserId()}`;
}

function loadPendingTasks() {
    try {
        return JSON.parse(localStorage.getItem(pendingTasksKey()) || "{}");
    } catch (e) {
        return {};
    }
}

function savePendingTasks(pending) {
    saveLocalAndRemote(pendingTasksKey(), "pending_tasks", pending);
}

function statsKey() {
    return `pantrypro_stats:${getStoredUserId()}`;
}

function justificationsKey() {
    return `pantrypro_justifications:${getStoredUserId()}`;
}

function readStats() {
    try {
        return JSON.parse(localStorage.getItem(statsKey()) || "{}");
    } catch (e) {
        return {};
    }
}

function saveStats(stats) {
    saveLocalAndRemote(statsKey(), "stats", stats || {});
}

function readJustifications() {
    try {
        const values = JSON.parse(localStorage.getItem(justificationsKey()) || "[]");
        return Array.isArray(values) && values.length
            ? values
            : ["Malattia", "Emergenza", "Impegno prioritario", "Riposo programmato"];
    } catch (e) {
        return ["Malattia", "Emergenza", "Impegno prioritario", "Riposo programmato"];
    }
}

function saveJustifications(values) {
    saveLocalAndRemote(justificationsKey(), "justifications", values.filter(Boolean));
}

function taskStatsId(tipo, nome, itemId) {
    return `${tipo}:${nome}:${itemId}`;
}

function recordTaskStat({ tipo, nome, itemId, titolo, status, justification = "", date = localISODate() }) {
    const stats = readStats();
    const key = taskStatsId(tipo, nome, itemId);
    if (!stats[key]) {
        stats[key] = {
            key,
            tipo,
            nome,
            itemId,
            titolo: titolo || itemId,
            history: {}
        };
    }
    stats[key].tipo = tipo;
    stats[key].nome = nome;
    stats[key].itemId = itemId;
    stats[key].titolo = titolo || stats[key].titolo || itemId;
    stats[key].history[date] = {
        status,
        justification,
        updated_at: new Date().toISOString()
    };
    saveStats(stats);
}

function askSkipJustification(taskLabel) {
    const options = readJustifications();
    const answer = prompt(
        `Hai una giustificazione per "${taskLabel}"?\n\nScrivi una di queste oppure lascia vuoto per nessuna giustificazione:\n${options.join(", ")}`
    );
    return (answer || "").trim();
}

function skipTask(tipo, nomeEncoded, itemIdEncoded, titoloEncoded) {
    const nome = decodeURIComponent(nomeEncoded);
    const itemId = decodeURIComponent(itemIdEncoded);
    const titolo = decodeURIComponent(titoloEncoded || itemIdEncoded);
    const justification = askSkipJustification(titolo);
    recordTaskStat({
        tipo,
        nome,
        itemId,
        titolo,
        status: justification ? "justified" : "missed",
        justification
    });
    apiFetch(`${API}/completamenti/toggle`, {
        method: "POST",
        body: JSON.stringify({
            tipo,
            piano_nome: nome,
            item_id: itemId,
            completato: false
        })
    });
    caricaRoutineDiOggi();
}

async function justifyTodayTasks() {
    const tasks = Array.isArray(window.todayStatsTasks) ? window.todayStatsTasks : [];
    if (!tasks.length) {
        alert("Non ci sono attivita da giustificare oggi.");
        return;
    }

    const justification = askSkipJustification("tutta la giornata");
    const status = justification ? "justified" : "missed";

    const updates = [];
    for (const task of tasks) {
        recordTaskStat({
            tipo: task.tipo,
            nome: task.nome,
            itemId: task.itemId,
            titolo: task.titolo,
            status,
            justification
        });
        updates.push(apiFetch(`${API}/completamenti/toggle`, {
            method: "POST",
            body: JSON.stringify({
                tipo: task.tipo,
                piano_nome: task.nome,
                item_id: task.itemId,
                completato: false
            })
        }));
    }

    await Promise.allSettled(updates);
    caricaRoutineDiOggi();
}

function statsCounts(entry) {
    const values = Object.values(entry.history || {});
    return {
        completed: values.filter(v => v.status === "completed").length,
        justified: values.filter(v => v.status === "justified").length,
        missed: values.filter(v => v.status === "missed").length
    };
}

function renderJustifications() {
    const list = document.getElementById("justifications-list");
    if (!list) return;
    const items = readJustifications();
    list.innerHTML = items.map((item, index) => `
        <div class="justification-item">
            <input value="${escapeHTML(item)}" onchange="updateJustification(${index}, this.value)">
            <button class="btn danger" onclick="deleteJustification(${index})">Elimina</button>
        </div>
    `).join("");
}

function addJustification() {
    const value = prompt("Nuova giustificazione");
    if (!value || !value.trim()) return;
    const items = readJustifications();
    items.push(value.trim());
    saveJustifications([...new Set(items)]);
    renderJustifications();
}

function updateJustification(index, value) {
    const items = readJustifications();
    items[index] = value.trim();
    saveJustifications(items);
    renderJustifications();
}

function deleteJustification(index) {
    const items = readJustifications();
    items.splice(index, 1);
    saveJustifications(items);
    renderJustifications();
}

function clearStats() {
    if (!confirm("Vuoi azzerare tutte le statistiche? Le giustificazioni preimpostate resteranno salvate.")) return;
    localStorage.removeItem(statsKey());
    renderStatsPage();
}

function renderStatsPage() {
    const stats = readStats();
    const entries = Object.values(stats);
    const totals = entries.reduce((acc, entry) => {
        const counts = statsCounts(entry);
        acc.completed += counts.completed;
        acc.justified += counts.justified;
        acc.missed += counts.missed;
        return acc;
    }, { completed: 0, justified: 0, missed: 0 });
    const total = totals.completed + totals.justified + totals.missed;
    const effective = totals.completed + totals.justified;
    const rate = total ? Math.round((effective / total) * 100) : 0;

    const completedEl = document.getElementById("stat-completed");
    const justifiedEl = document.getElementById("stat-justified");
    const missedEl = document.getElementById("stat-missed");
    const rateEl = document.getElementById("stat-rate");
    if (completedEl) completedEl.textContent = totals.completed;
    if (justifiedEl) justifiedEl.textContent = totals.justified;
    if (missedEl) missedEl.textContent = totals.missed;
    if (rateEl) rateEl.textContent = `${rate}%`;

    renderJustifications();
    renderActivityCharts(entries);
    renderStatsCalendar(entries);
}

function renderActivityCharts(entries) {
    const container = document.getElementById("activity-charts");
    if (!container) return;
    if (!entries.length) {
        container.innerHTML = `<p class="empty-state">Nessuna statistica ancora. Completa o giustifica attivita dalla dashboard.</p>`;
        return;
    }
    container.innerHTML = entries
        .sort((a, b) => (a.titolo || a.itemId).localeCompare(b.titolo || b.itemId))
        .map(entry => {
            const counts = statsCounts(entry);
            const total = Math.max(1, counts.completed + counts.justified + counts.missed);
            const completedPct = Math.round((counts.completed / total) * 100);
            const justifiedPct = Math.round((counts.justified / total) * 100);
            const missedPct = Math.max(0, 100 - completedPct - justifiedPct);
            return `
                <article class="activity-chart">
                    <div>
                        <strong>${escapeHTML(entry.titolo || entry.itemId)}</strong>
                        <span>${escapeHTML(entry.nome)} - ${escapeHTML(entry.tipo)}</span>
                    </div>
                    <div class="stacked-bar" title="Completate ${counts.completed}, giustificate ${counts.justified}, saltate ${counts.missed}">
                        <span class="bar-completed" style="width:${completedPct}%"></span>
                        <span class="bar-justified" style="width:${justifiedPct}%"></span>
                        <span class="bar-missed" style="width:${missedPct}%"></span>
                    </div>
                    <div class="chart-counts">
                        <span>OK ${counts.completed}</span>
                        <span>Giust. ${counts.justified}</span>
                        <span>Saltate ${counts.missed}</span>
                    </div>
                </article>
            `;
        }).join("");
}

function renderStatsCalendar(entries) {
    const container = document.getElementById("stats-calendar");
    const monthInput = document.getElementById("stats-month");
    if (!container || !monthInput) return;
    const month = monthInput.value || new Date().toISOString().slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number);
    const days = new Date(year, monthNumber, 0).getDate();
    const byDate = {};
    entries.forEach(entry => {
        Object.entries(entry.history || {}).forEach(([date, value]) => {
            if (!date.startsWith(month)) return;
            if (!byDate[date]) byDate[date] = { completed: 0, justified: 0, missed: 0, labels: [] };
            byDate[date][value.status] = (byDate[date][value.status] || 0) + 1;
            byDate[date].labels.push(`${entry.titolo || entry.itemId}: ${value.status}${value.justification ? " - " + value.justification : ""}`);
        });
    });

    container.innerHTML = Array.from({ length: days }, (_, index) => {
        const day = index + 1;
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const data = byDate[date];
        const cls = data
            ? data.missed ? "missed" : data.justified ? "justified" : "completed"
            : "";
        const title = data ? escapeHTML(data.labels.join("\n")) : "";
        return `
            <div class="calendar-day ${cls}" title="${title}">
                <strong>${day}</strong>
                ${data ? `<span>${data.completed || 0}/${data.justified || 0}/${data.missed || 0}</span>` : "<span>-</span>"}
            </div>
        `;
    }).join("");
}

async function caricaDettagliDaLista(endpoint, listResult) {
    const nomi = Array.isArray(listResult)
        ? listResult.map(item => typeof item === "string" ? item : item.nome).filter(Boolean)
        : [];

    const risultati = await Promise.allSettled(nomi.map(async nome => {
        try {
            const res = await apiFetch(`${API}/${endpoint}/${encodeURIComponent(nome)}`);
            if (res.ok) {
                return { ok: true, value: await res.json() };
            }
            return { ok: false, error: `${nome}: HTTP ${res.status}` };
        } catch (e) {
            console.error(`Errore caricamento ${endpoint}:`, nome, e);
            return { ok: false, error: `${nome}: ${e.message || e}` };
        }
    }));

    const dettagli = [];
    const errori = [];
    risultati.forEach(result => {
        if (result.status === "fulfilled" && result.value.ok) dettagli.push(result.value.value);
        else if (result.status === "fulfilled") errori.push(result.value.error);
        else errori.push(result.reason?.message || String(result.reason));
    });

    if (nomi.length && !dettagli.length && errori.length) {
        throw new Error(`${endpoint}: elenco trovato ma dettagli non caricati (${errori.join("; ")})`);
    }

    return dettagli;
}

async function caricaRoutineDiOggi() {
    const container = document.getElementById("today-routines-display");
    if (!container) return;

    try {
        const completamentiRes = await apiFetch(`${API}/completamenti/oggi`);
        const completamenti = completamentiRes.ok ? await completamentiRes.json() : [];
        const completati = new Set(
            completamenti
                .filter(item => item.completato)
                .map(item => `${item.tipo}:${item.piano_nome}:${item.item_id}`)
        );

        const routineListRes = await apiFetch(`${API}/routine/list`);
        const sottoroutineListRes = await apiFetch(`${API}/sottoroutine/list`);
        const routineList = await jsonOrThrow(routineListRes, "routine/list");
        const sottoroutineList = await jsonOrThrow(sottoroutineListRes, "sottoroutine/list");

        const routine = await caricaDettagliDaLista("routine", routineList);
        const sottoroutine = await caricaDettagliDaLista("sottoroutine", sottoroutineList);

        const routineDovute = routine.map(item => ({ ...item, tipo: "routine" })).filter(item => isRoutineDue(item));
        const sottoroutineDovute = sottoroutine.map(item => ({ ...item, tipo: "sottoroutine" })).filter(item => isRoutineDue(item));
        const linkedSubNames = new Set();
        const pending = loadPendingTasks();
        const oggi = localISODate();

        const rowsRoutine = routineDovute.flatMap(item => {
            const elementi = normalizzaElementiRoutine(item).filter(elemento => isElementoDue(elemento));
            return elementi.map((elemento, index) => {
                const itemId = elemento.id || `${item.nome}-${index}`;
                const tipo = item.tipo || "agenda";
                const key = `${tipo}:${item.nome}:${itemId}`;
                const isDaily = (item.frequenza || "giornaliera").toLowerCase() === "giornaliera";
                const title = routineElementTitle(elemento, item);
                const linkedSubs = findLinkedSubroutinesForDashboard(item, title, sottoroutineDovute, linkedSubNames);
                linkedSubs.forEach(sub => linkedSubNames.add(normalizeName(sub.nome)));
                const linkedDetail = linkedSubs.map(sub => sub.detail).filter(Boolean).join(", ");
                const linkedSubName = linkedSubs[0]?.nome || "";
                const openSub = linkedSubName
                    ? ` onclick="openSubroutineFromDashboard('${safeEncoded(linkedSubName)}')" role="link" title="Apri sottoroutine ${escapeHTML(linkedSubName)}"`
                    : "";
                if (!isDaily) {
                    pending[key] = {
                        key,
                        tipo,
                        itemNome: item.nome,
                        itemId,
                        parent: item.routine_parent || "",
                        frequenza: item.frequenza || "",
                        titolo: title,
                        note: elemento.note || "",
                        orario: elemento.orario || "",
                        subDetail: linkedDetail,
                        subName: linkedSubName,
                        dueDate: oggi
                    };
                }
                const checked = isDaily && completati.has(key) ? "checked" : "";
                const orario = elemento.orario || "";
                return {
                    key,
                    tipo,
                    nome: item.nome,
                    itemId,
                    titolo: title,
                    completed: completati.has(key),
                    isDaily,
                    orario,
                    html: `
                    <div class="task-row stat-task-row">
                        <input type="checkbox" ${checked} onchange="toggleTask('${tipo}', '${safeEncoded(item.nome)}', '${safeEncoded(itemId)}', '${safeEncoded(title)}', this.checked)">
                        <span class="${linkedSubName ? "dashboard-linked-task" : ""}"${openSub}>
                            <span class="task-title">${orario ? escapeHTML(orario) + " - " : ""}${escapeHTML(title)}</span>
                            ${linkedDetail ? `<span class="task-meta dashboard-sub-detail">${escapeHTML(linkedDetail)}</span>` : ""}
                            <span class="task-meta">${escapeHTML(item.nome)}</span>
                            ${linkedSubName ? `<span class="task-meta dashboard-open-hint">Apri dettagli</span>` : ""}
                            ${elemento.note ? `<span class="task-meta">${escapeHTML(elemento.note)}</span>` : ""}
                        </span>
                        <button class="btn outline stat-skip-btn" onclick="skipTask('${tipo}', '${safeEncoded(item.nome)}', '${safeEncoded(itemId)}', '${safeEncoded(title)}')">Giustifica</button>
                    </div>
                `};
            });
        });

        const rowsSubStandalone = sottoroutineDovute
            .filter(item => !linkedSubNames.has(normalizeName(item.nome)))
            .flatMap(item => {
                const elementi = normalizzaElementiRoutine(item).filter(elemento => isElementoDue(elemento));
                return elementi.map((elemento, index) => {
                    const itemId = elemento.id || `${item.nome}-${index}`;
                    const tipo = item.tipo || "agenda";
                    const key = `${tipo}:${item.nome}:${itemId}`;
                    const isDaily = (item.frequenza || "giornaliera").toLowerCase() === "giornaliera";
                    const title = item.nome || routineElementTitle(elemento, item);
                    const detail = routineElementTitle(elemento, item);
                    const parent = item.routine_parent ? ` - ${item.routine_parent}` : "";
                    const orario = elemento.orario || "";
                    if (!isDaily) {
                        pending[key] = {
                            key,
                            tipo,
                            itemNome: item.nome,
                            itemId,
                            parent: item.routine_parent || "",
                            frequenza: item.frequenza || "",
                            titolo: title,
                            note: elemento.note || "",
                            orario,
                            subDetail: detail && detail !== title ? detail : "",
                            subName: item.nome,
                            dueDate: oggi
                        };
                    }
                    const checked = isDaily && completati.has(key) ? "checked" : "";
                    return {
                        key,
                        tipo,
                        nome: item.nome,
                        itemId,
                        titolo: title,
                        completed: completati.has(key),
                        isDaily,
                        orario,
                        html: `
                    <div class="task-row stat-task-row">
                        <input type="checkbox" ${checked} onchange="toggleTask('${tipo}', '${safeEncoded(item.nome)}', '${safeEncoded(itemId)}', '${safeEncoded(title)}', this.checked)">
                        <span class="dashboard-linked-task" onclick="openSubroutineFromDashboard('${safeEncoded(item.nome)}')" role="link" title="Apri ${escapeHTML(item.nome)}">
                            <span class="task-title">${orario ? escapeHTML(orario) + " - " : ""}${escapeHTML(title)}</span>
                            ${detail && detail !== title ? `<span class="task-meta dashboard-sub-detail">${escapeHTML(detail)}</span>` : ""}
                            <span class="task-meta">${escapeHTML(item.nome)}${escapeHTML(parent)}</span>
                            <span class="task-meta dashboard-open-hint">Apri dettagli</span>
                            ${elemento.note ? `<span class="task-meta">${escapeHTML(elemento.note)}</span>` : ""}
                        </span>
                        <button class="btn outline stat-skip-btn" onclick="skipTask('${tipo}', '${safeEncoded(item.nome)}', '${safeEncoded(itemId)}', '${safeEncoded(title)}')">Giustifica</button>
                    </div>
                `};
                });
            });

        const rowsDovute = [...rowsRoutine, ...rowsSubStandalone];

        for (const key of Array.from(completati)) {
            delete pending[key];
        }

        const dueKeys = new Set(rowsDovute.map(row => row.key));
        const rowsPending = Object.values(pending)
            .filter(item => !dueKeys.has(item.key))
            .map(item => ({
                key: item.key,
                tipo: item.tipo,
                nome: item.itemNome,
                itemId: item.itemId,
                titolo: item.titolo,
                completed: completati.has(item.key),
                isDaily: false,
                orario: item.orario || "",
                html: `
                    <div class="task-row stat-task-row">
                        <input type="checkbox" onchange="toggleTask('${item.tipo}', '${safeEncoded(item.itemNome)}', '${safeEncoded(item.itemId)}', '${safeEncoded(item.titolo)}', this.checked)">
                        <span class="${item.subName ? "dashboard-linked-task" : ""}"${item.subName ? ` onclick="openSubroutineFromDashboard('${safeEncoded(item.subName)}')" role="link" title="Apri ${escapeHTML(item.subName)}"` : ""}>
                            <span class="task-title">${item.orario ? escapeHTML(item.orario) + " - " : ""}${escapeHTML(item.titolo)}</span>
                            ${item.subDetail ? `<span class="task-meta dashboard-sub-detail">${escapeHTML(item.subDetail)}</span>` : ""}
                            <span class="task-meta">${escapeHTML(item.itemNome)}${item.parent ? " - " + escapeHTML(item.parent) : ""} - in sospeso dal ${escapeHTML(item.dueDate)}</span>
                            ${item.subName ? `<span class="task-meta dashboard-open-hint">Apri dettagli</span>` : ""}
                            ${item.note ? `<span class="task-meta">${escapeHTML(item.note)}</span>` : ""}
                        </span>
                        <button class="btn outline stat-skip-btn" onclick="skipTask('${item.tipo}', '${safeEncoded(item.itemNome)}', '${safeEncoded(item.itemId)}', '${safeEncoded(item.titolo)}')">Giustifica</button>
                    </div>
                `
            }));

        savePendingTasks(pending);
        const rows = [...rowsDovute, ...rowsPending];
        window.todayStatsTasks = rows.map(row => ({
            tipo: row.tipo,
            nome: row.nome,
            itemId: row.itemId,
            titolo: row.titolo,
            completed: row.completed
        })).filter(item => item.tipo && item.nome && item.itemId && !item.completed);

        const summary = document.getElementById("today-routine-summary");
        if (summary) {
            const parti = [
                `${routineDovute.length} routine`
            ];
            if (sottoroutineDovute.length) parti.push(`${sottoroutineDovute.length} dettagli collegati`);
            if (rowsPending.length) parti.push(`${rowsPending.length} in sospeso`);
            summary.textContent = `Oggi: ${parti.join(", ")}. Le giornaliere si azzerano domani; le altre restano finch\u00e9 non le completi.`;
        }

        if (!rows.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>Nessuna routine prevista per oggi.</p>
                    <p style="font-size:0.78rem; margin-top:8px;">
                        Trovate: ${routine.length} routine, ${sottoroutine.length} sottoroutine.
                        Dovute oggi: ${routineDovute.length} routine, ${sottoroutineDovute.length} sottoroutine.
                    </p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <section class="task-section">
                <div class="dashboard-section-head">
                    <h3>Agenda</h3>
                    <button class="btn outline day-justify-btn" onclick="justifyTodayTasks()">Giustifica giornata</button>
                </div>
                <div class="task-list">${rows.map(row => row.html).join("")}</div>
            </section>
        `;
    } catch (e) {
        console.error("Errore routine dashboard:", e);
        container.innerHTML = `
            <div class="empty-state">
                <p>Non riesco a caricare le routine.</p>
                <p style="font-size:0.78rem; margin-top:8px;">${escapeHTML(e.message || e)}</p>
            </div>
        `;
    }
}

async function getMenuComeRoutine() {
    try {
        const infoRes = await apiFetch(`${API}/system/info`);
        const info = await infoRes.json();
        const oggiNome = info.giorno;
        const oggiISO = new Date().toISOString().split("T")[0];
        const files = await (await apiFetch(`${API}/menu/list`)).json();

        for (const f of files) {
            const res = await apiFetch(`${API}/menu/${f}`);
            if (!res.ok) continue;
            const p = await res.json();
            if (!(oggiISO >= p.inizio && oggiISO <= p.fine)) continue;

            const pasti = (p.pasti || []).filter(pasto =>
                pasto.giorno.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ===
                oggiNome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            );

            return pasti.map(pasto => {
                return {
                    tipo: "menu",
                    nome: `Menu - ${pasto.nome}`,
                    frequenza: "giornaliera",
                    elementi: (pasto.piatti || []).map((piatto, index) => ({
                        id: `menu_${pasto.nome}_${index}`,
                        titolo: piatto.nome
                    }))
                };
            });
        }
    } catch (e) {
        console.error("Errore menu come routine:", e);
    }
    return [];
}

async function toggleTask(tipo, nomeEncoded, itemIdEncoded, titoloEncoded, completato) {
    const nome = decodeURIComponent(nomeEncoded);
    const itemId = decodeURIComponent(itemIdEncoded);
    const titolo = decodeURIComponent(titoloEncoded || itemIdEncoded);
    if (completato) {
        const pending = loadPendingTasks();
        delete pending[`${tipo}:${nome}:${itemId}`];
        savePendingTasks(pending);
        recordTaskStat({ tipo, nome, itemId, titolo, status: "completed" });
    } else {
        const justification = askSkipJustification(titolo);
        recordTaskStat({
            tipo,
            nome,
            itemId,
            titolo,
            status: justification ? "justified" : "missed",
            justification
        });
    }
    await apiFetch(`${API}/completamenti/toggle`, {
        method: "POST",
        body: JSON.stringify({
            tipo,
            piano_nome: nome,
            item_id: itemId,
            completato
        })
    });
}

async function initPlanner() {
    try {
        // Carica inventario per il datalist
        const invRes = await apiFetch(`${API}/get-inventario`);
        const inv = await invRes.json();
        popolaDatalist(inv);
        
        // 1. Prendi la lista dei nomi dei file
        const response = await apiFetch(`${API}/menu/list`);
        let files = await response.json();
        
        if (files.menus) files = files.menus;
        if (files.files) files = files.files;

        const sel = document.getElementById('select-menu-to-edit');
        const btnElimina = document.getElementById('btn-elimina-piano');
        
        if (!sel) return; // Se non siamo nella pagina planner, esce silenziosamente

        sel.innerHTML = '<option value="NEW">+ Crea Nuovo Piano</option>';

        // 2. Carica i dettagli di ogni file
        for (const filename of files) {
            try {
                const resP = await apiFetch(`${API}/menu/${filename}`);
                if (resP.ok) {
                    const piano = await resP.json();
                    const option = document.createElement('option');
                    option.value = filename;
                    option.textContent = `${piano.nome || filename} (${piano.inizio || 'no data'})`;
                    sel.appendChild(option);
                }
            } catch (err) {
                console.error("Errore nel caricamento del file specifico:", filename);
            }
        }

        // Listener UNICO per il cambio selezione
        sel.onchange = async (e) => {
            if (e.target.value === "NEW") {
                originalFilename = null;
                currentPlan = { nome: "", inizio: "", fine: "", giorni: [...giorniSettimana], pasti: [] };
                if (btnElimina) btnElimina.style.display = "none";
            } else {
                originalFilename = e.target.value;
                const res = await apiFetch(`${API}/menu/${originalFilename}`);
                currentPlan = await res.json();
                if (btnElimina) btnElimina.style.display = "inline-block";
            }
            // Sincronizziamo i campi
            aggiornaCampiPlanner();
        };

        // Renderiziamo i giorni vuoti o quelli del piano caricato
        renderGiorni();

    } catch (e) {
        console.error("Errore generale initPlanner:", e);
    }
}

// Funzione di utilita per non ripetere codice
function aggiornaCampiPlanner() {
    const n = document.getElementById('plan-name');
    const s = document.getElementById('plan-start');
    const e = document.getElementById('plan-end');
    if(n) n.value = currentPlan.nome || "";
    if(s) s.value = currentPlan.inizio || "";
    if(e) e.value = currentPlan.fine || "";
    ensurePlannerDays();
    renderGiorni();
}




// --- CORREZIONE SALVATAGGIO (Dati persistenti) ---

async function saveFullPlan() {

    // Prendiamo i valori AGGIORNATI dagli input

    const nome = document.getElementById('plan-name').value;

    const inizio = document.getElementById('plan-start').value;

    const fine = document.getElementById('plan-end').value;



    if(!nome || !inizio || !fine) return alert("Compila tutti i campi!");

    

    // Aggiorniamo l'oggetto globale prima di inviarlo

    currentPlan.nome = nome;

    currentPlan.inizio = inizio;

    currentPlan.fine = fine;
    ensurePlannerDays();

    sincronizzaUnitaPiano(currentPlan);



    const payload = {

        filename: originalFilename || `plan_${nome.replace(/\s+/g,'_').toLowerCase()}.json`,

        menu: currentPlan // Inviamo l'oggetto currentPlan che contiene i pasti

    };



    try {

        const res = await apiFetch(API + "/menu/save", {

            method: "POST",

            headers: {"Content-Type":"application/json"},

            body: JSON.stringify(payload)

        });

        

        if(res.ok) {

            alert("Piano salvato correttamente.");

            window.location.href = "index.html";

        } else {

            const result = await res.json();

            alert("Errore: " + (result.detail || "Impossibile salvare"));

        }

    } catch(e) { alert("Errore di connessione."); }

}



function aggiornaCampiPlanner() {

    document.getElementById('plan-name').value = currentPlan.nome || "";

    document.getElementById('plan-start').value = currentPlan.inizio || "";

    document.getElementById('plan-end').value = currentPlan.fine || "";
    ensurePlannerDays();

    renderGiorni();

}



// --- FUNZIONE DUPLICA CORRETTA ---

async function duplicatePlan() {

    if (!currentPlan || currentPlan.pasti.length === 0) {

        alert("Seleziona prima un piano da duplicare!");

        return;

    }



    // Creiamo una copia profonda dell'oggetto

    sincronizzaUnitaPiano(currentPlan);

    const newMenu = JSON.parse(JSON.stringify(currentPlan));

    

    // Modifichiamo il nome per distinguerlo

    newMenu.nome = (newMenu.nome || "Piano") + " (Copia)";

    

    // Generiamo un nuovo nome file unico basato sul timestamp

    const newFilename = `plan_copy_${Date.now()}.json`;



    const payload = {

        filename: newFilename,

        menu: newMenu

    };



    try {

        const res = await apiFetch(`${API}/menu/save`, {

            method: "POST",

            headers: { "Content-Type": "application/json" },

            body: JSON.stringify(payload)

        });



        if (res.ok) {

            alert("Piano duplicato con successo.");

            // Ricarichiamo la pagina per vedere il nuovo piano nella lista

            window.location.reload();

        } else {

            const err = await res.json();

            alert("Errore durante la duplicazione: " + err.detail);

        }

    } catch (e) {

        alert("Errore di connessione al server.");

    }

}



// Assicuriamoci che finalSave gestisca correttamente la chiamata

function finalSave(isDuplicate) {

    if (isDuplicate) {

        duplicatePlan();

    } else {

        saveFullPlan();

    }

}



// --- 4. RENDERER PLANNER (CON TASTO X) ---
let plannerMoveSelection = null;

function moveArrayItem(list, from, to) {
    if (!Array.isArray(list) || from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
}

function startPlannerDrag(event, payload) {
    plannerMoveSelection = payload;
    event.dataTransfer.setData("application/json", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
}

function selectPlannerMove(event, payload) {
    event.preventDefault();
    event.stopPropagation();
    plannerMoveSelection = payload;
    renderGiorni();
}

function ensurePlannerDays() {
    if (!currentPlan || typeof currentPlan !== "object") currentPlan = { nome: "", inizio: "", fine: "", pasti: [] };
    if (!Array.isArray(currentPlan.pasti)) currentPlan.pasti = [];
    const saved = Array.isArray(currentPlan.giorni) ? currentPlan.giorni.filter(Boolean) : [];
    const used = currentPlan.pasti.map(pasto => pasto.giorno).filter(Boolean);
    const days = [...saved, ...used].filter((day, index, arr) => arr.indexOf(day) === index);
    currentPlan.giorni = days.length ? days : [...giorniSettimana];
    return currentPlan.giorni;
}

function renderPlannerDaysEditor() {
    const editor = document.getElementById("planner-days-editor");
    if (!editor) return;
    const days = ensurePlannerDays();
    editor.innerHTML = days.map((day, index) => `
        <span class="planner-day-chip">
            <input value="${escapeHTML(day)}" onchange="renamePlannerDay(${index}, this.value)" title="Nome sezione">
            <button type="button" onclick="removePlannerDay(${index})" title="Elimina sezione">x</button>
        </span>
    `).join("");
}

function addPlannerDay(label) {
    const value = String(label || "").trim();
    if (!value) return;
    const days = ensurePlannerDays();
    if (!days.includes(value)) days.push(value);
    currentPlan.giorni = days;
    renderGiorni();
}

function addPlannerDayFromInput() {
    const input = document.getElementById("planner-day-label");
    addPlannerDay(input?.value || "");
    if (input) input.value = "";
}

function renamePlannerDay(index, nextValue) {
    const days = ensurePlannerDays();
    const oldValue = days[index];
    const value = String(nextValue || "").trim() || oldValue;
    if (!oldValue) return;
    days[index] = value;
    currentPlan.pasti.forEach(pasto => {
        if (pasto.giorno === oldValue) pasto.giorno = value;
    });
    currentPlan.giorni = days.filter((day, idx, arr) => day && arr.indexOf(day) === idx);
    renderGiorni();
}

function removePlannerDay(index) {
    const days = ensurePlannerDays();
    const value = days[index];
    if (!value) return;
    const hasMeals = currentPlan.pasti.some(pasto => pasto.giorno === value);
    if (hasMeals && !confirm(`Eliminare "${value}" e i suoi pasti dal piano?`)) return;
    currentPlan.giorni = days.filter((_, idx) => idx !== index);
    currentPlan.pasti = currentPlan.pasti.filter(pasto => pasto.giorno !== value);
    if (!currentPlan.giorni.length) currentPlan.giorni = [...giorniSettimana];
    renderGiorni();
}

function resetPlannerDays() {
    if (!confirm("Ripristinare le sezioni settimanali? I pasti fuori da questi giorni resteranno ma verranno aggiunti come sezioni extra.")) return;
    currentPlan.giorni = [...giorniSettimana];
    ensurePlannerDays();
    renderGiorni();
}

function generateMonthlyPlannerDays() {
    const count = parseInt(prompt("Quanti giorni vuoi nel piano?", "30") || "30", 10);
    if (!Number.isFinite(count) || count < 1 || count > 62) return alert("Inserisci un numero da 1 a 62.");
    currentPlan.giorni = Array.from({ length: count }, (_, index) => `Giorno ${index + 1}`);
    ensurePlannerDays();
    renderGiorni();
}

function readPlannerDrag(event) {
    try {
        return JSON.parse(event.dataTransfer.getData("application/json") || "{}");
    } catch (e) {
        return {};
    }
}

function dropMeal(event, giorno, toIndex) {
    event.preventDefault();
    const payload = readPlannerDrag(event);
    movePlannerSelection(payload, { type: "meal", giorno, toIndex });
}

function movePlannerSelection(payload, target) {
    if (!payload || !payload.type) return;
    if (payload.type === "meal") {
        if (target.type !== "meal") return;
        movePlannerMeal(payload, target.giorno, target.toIndex);
        return;
    }
    if (payload.type === "dish") {
        if (target.type !== "dish") return;
        movePlannerDish(payload, target.pIdx, target.toIndex);
        return;
    }
    if (payload.type === "ingredient") {
        if (target.type !== "ingredient") return;
        movePlannerIngredient(payload, target.pIdx, target.ptIdx, target.toIndex);
    }
}

function movePlannerMeal(payload, giorno, toIndex) {
    const fromIndex = Number.isInteger(payload.pIdx) ? payload.pIdx : currentPlan.pasti
        .map((pasto, index) => ({ pasto, index }))
        .filter(entry => entry.pasto.giorno === payload.giorno)[payload.dayIndex]?.index;
    if (fromIndex === undefined || !currentPlan.pasti[fromIndex]) return;
    const [item] = currentPlan.pasti.splice(fromIndex, 1);
    item.giorno = giorno;
    const dayEntriesAfter = currentPlan.pasti
        .map((pasto, index) => ({ pasto, index }))
        .filter(entry => entry.pasto.giorno === giorno);
    const targetIndex = dayEntriesAfter[toIndex]?.index ?? currentPlan.pasti.length;
    currentPlan.pasti.splice(targetIndex, 0, item);
    plannerMoveSelection = null;
    renderGiorni();
}

function dropDish(event, pIdx, toIndex) {
    event.preventDefault();
    const payload = readPlannerDrag(event);
    movePlannerSelection(payload, { type: "dish", pIdx, toIndex });
}

function movePlannerDish(payload, pIdx, toIndex) {
    const source = currentPlan.pasti[payload.pIdx]?.piatti;
    const target = currentPlan.pasti[pIdx]?.piatti;
    if (!source || !target || !source[payload.index]) return;
    const [item] = source.splice(payload.index, 1);
    const insertAt = Math.max(0, Math.min(toIndex, target.length));
    target.splice(insertAt, 0, item);
    plannerMoveSelection = null;
    renderGiorni();
}

function dropIngredient(event, pIdx, ptIdx, toIndex) {
    event.preventDefault();
    const payload = readPlannerDrag(event);
    movePlannerSelection(payload, { type: "ingredient", pIdx, ptIdx, toIndex });
}

function movePlannerIngredient(payload, pIdx, ptIdx, toIndex) {
    const source = currentPlan.pasti[payload.pIdx]?.piatti?.[payload.ptIdx]?.ingredienti;
    const target = currentPlan.pasti[pIdx]?.piatti?.[ptIdx]?.ingredienti;
    if (!source || !target || !source[payload.index]) return;
    const [item] = source.splice(payload.index, 1);
    const insertAt = Math.max(0, Math.min(toIndex, target.length));
    target.splice(insertAt, 0, item);
    plannerMoveSelection = null;
    renderGiorni();
}

function dropPlannerSelection(event, type, pIdx = null, ptIdx = null, toIndex = null, giorno = "") {
    event.preventDefault();
    event.stopPropagation();
    if (!plannerMoveSelection) return;
    const target = { type, pIdx, ptIdx, toIndex, giorno };
    movePlannerSelection(plannerMoveSelection, target);
}

function plannerDropButton(type, pIdx = null, ptIdx = null, toIndex = null, giorno = "") {
    if (!plannerMoveSelection || plannerMoveSelection.type !== type) return "";
    return `<button class="planner-drop-btn" onclick="dropPlannerSelection(event, '${type}', ${pIdx === null ? 'null' : pIdx}, ${ptIdx === null ? 'null' : ptIdx}, ${toIndex === null ? 'null' : toIndex}, decodeURIComponent('${safeEncoded(giorno)}'))">Qui</button>`;
}

function plannerDayDomId(day) {
    return `content-${safeEncoded(day)}`;
}

function plannerDayArg(day) {
    return `decodeURIComponent('${safeEncoded(day)}')`;
}

function renderGiorni() {
    const container = document.getElementById('giorni-container');
    if(!container) return;
    const dayLabels = ensurePlannerDays();
    renderPlannerDaysEditor();
    
    // RENDER DELLE SEZIONI GIORNO
    container.innerHTML = dayLabels.map(g => {
        const dayArg = plannerDayArg(g);
        return `
        <div class="day-section">
            <div class="day-header" style="display:flex; justify-content:space-between; align-items:center;">
                <span>${escapeHTML(g)}</span>
                <div style="display:flex; gap:5px;">
                    <button class="btn-cp" onclick="copyDay(${dayArg})" title="Copia sezione">Copia</button>
                    <button class="btn-cp" onclick="pasteDay(${dayArg})" title="Incolla sezione">Incolla</button>
                </div>
            </div>
            <div id="${plannerDayDomId(g)}"></div>
            <button class="btn outline" onclick="addPasto(${dayArg})" style="width:100%; margin-top:10px;">+ Pasto</button>
        </div>`;
    }).join("");

    // RENDER DEI PASTI
    const dayCounters = {};
    currentPlan.pasti.forEach((pasto, pIdx) => {
        const dayIndex = dayCounters[pasto.giorno] || 0;
        dayCounters[pasto.giorno] = dayIndex + 1;
        const pDiv = document.createElement('div');
        pDiv.className = 'meal-box drag-drop-target';
        pDiv.style = "background:#ffffff; padding:15px; border-radius:8px; margin-bottom:15px; border:1px solid #e2e8f0; position:relative; box-shadow:0 1px 2px rgba(15,23,42,0.06);";
        pDiv.setAttribute('ondragover', 'event.preventDefault()');
        pDiv.setAttribute('ondrop', `dropMeal(event, decodeURIComponent('${safeEncoded(pasto.giorno)}'), ${dayIndex})`);
        
        pDiv.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="drag-handle" draggable="true" onclick="selectPlannerMove(event, {type:'meal', pIdx:${pIdx}, giorno:decodeURIComponent('${safeEncoded(pasto.giorno)}'), dayIndex:${dayIndex}})" ondragstart="startPlannerDrag(event, {type:'meal', pIdx:${pIdx}, giorno:decodeURIComponent('${safeEncoded(pasto.giorno)}'), dayIndex:${dayIndex}})" title="Trascina pasto">::</span>
                    <input type="text" value="${escapeHTML(pasto.nome || "")}" onchange="currentPlan.pasti[${pIdx}].nome=this.value" style="font-weight:bold; color:var(--accent); background:transparent; border:none; border-bottom:1px solid #444;">
                    ${plannerDropButton('meal', null, null, dayIndex, pasto.giorno)}
                    <button class="btn-cp" onclick="copyMealByIndex(${pIdx})" title="Copia Pasto">Copia</button>
                    <button class="btn-cp" onclick="pasteMealByIndex(${pIdx})" title="Incolla Pasto">Incolla</button>
                </div>
                <button class="btn-del" onclick="currentPlan.pasti.splice(${pIdx},1); renderGiorni();">X</button>
            </div>
            <div id="piatti-${pIdx}"></div>
            <button class="btn outline" onclick="addPiatto(${pIdx})" style="font-size:0.7rem; width:100%;">+ Aggiungi Piatto</button>`;
        
        const target = document.getElementById(plannerDayDomId(pasto.giorno));
        if(target) target.appendChild(pDiv);

        // RENDER DEI PIATTI
        pasto.piatti.forEach((piatto, ptIdx) => {
            const ptDiv = document.createElement('div');
            ptDiv.className = 'drag-drop-target';
            ptDiv.style = "margin:10px 0; padding:10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; position:relative;";
            ptDiv.setAttribute('ondragover', 'event.preventDefault()');
            ptDiv.setAttribute('ondrop', `dropDish(event, ${pIdx}, ${ptIdx})`);
            ptDiv.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                    <div style="display:flex; align-items:center; gap:5px; width:85%;">
                        <span class="drag-handle" draggable="true" onclick="selectPlannerMove(event, {type:'dish', pIdx:${pIdx}, index:${ptIdx}})" ondragstart="startPlannerDrag(event, {type:'dish', pIdx:${pIdx}, index:${ptIdx}})" title="Trascina piatto">::</span>
                    <input type="text" value="${escapeHTML(piatto.nome || "")}" onchange="currentPlan.pasti[${pIdx}].piatti[${ptIdx}].nome=this.value" style="background:#fff; color:#111827; border:1px solid #cbd5e1; width:70%; font-size:0.9rem; border-radius:8px;">
                        ${plannerDropButton('dish', pIdx, null, ptIdx)}
                        <button class="btn-cp" style="font-size:10px; padding:1px 4px;" onclick="copyDishByIndex(${pIdx}, ${ptIdx})" title="Copia Piatto">Copia</button>
                        <button class="btn-cp" style="font-size:10px; padding:1px 4px;" onclick="pasteDishByIndex(${pIdx}, ${ptIdx})" title="Sovrascrivi Piatto">Incolla</button>
                    </div>
                    <button class="btn-del" onclick="currentPlan.pasti[${pIdx}].piatti.splice(${ptIdx},1); renderGiorni();" style="font-size:10px;">X</button>
                </div>
                <div id="ings-${pIdx}-${ptIdx}"></div>
                <button class="btn outline" onclick="addIng(${pIdx}, ${ptIdx})" style="font-size:0.6rem; padding: 2px 5px; margin-top:5px;">+ Ingrediente</button>
                ${plannerDropButton('ingredient', pIdx, ptIdx, piatto.ingredienti.length)}`;
            document.getElementById(`piatti-${pIdx}`).appendChild(ptDiv);

            // RENDER INGREDIENTI
            piatto.ingredienti.forEach((ing, iIdx) => {
                const nomeNorm = ing.nome.toLowerCase().trim().replace(/\s+/g, '_');
                const unita = mappaUnitaInventario[nomeNorm] || ing.unita || "g";
                const isInv = !!mappaUnitaInventario[nomeNorm];
                const iRow = document.createElement('div');
                iRow.className = `planner-ingredient-row drag-drop-target ${isInv ? 'is-linked' : 'is-unlinked'}`;
                iRow.style = "display:grid; grid-template-columns: 28px minmax(140px,2fr) minmax(70px,1fr) 52px 82px 48px 24px; gap:7px; margin-top:7px; align-items:center;";
                iRow.setAttribute('ondragover', 'event.preventDefault()');
                iRow.setAttribute('ondrop', `dropIngredient(event, ${pIdx}, ${ptIdx}, ${iIdx})`);
                iRow.innerHTML = `
                    <span class="drag-handle" draggable="true" onclick="selectPlannerMove(event, {type:'ingredient', pIdx:${pIdx}, ptIdx:${ptIdx}, index:${iIdx}})" ondragstart="startPlannerDrag(event, {type:'ingredient', pIdx:${pIdx}, ptIdx:${ptIdx}, index:${iIdx}})" title="Trascina ingrediente">::</span>
                    <input class="planner-ingredient-input ${isInv ? 'is-linked' : 'is-unlinked'}" type="text" value="${escapeHTML(String(ing.nome || "").replace(/_/g, ' '))}" list="lista-ingredienti-inventario" onchange="aggiornaIng(${pIdx}, ${ptIdx}, ${iIdx}, this.value)" title="${isInv ? 'Collegato all inventario' : 'Non collegato all inventario'}">
                    <input type="number" step="0.1" value="${escapeHTML(ing.qta || 0)}" onchange="currentPlan.pasti[${pIdx}].piatti[${ptIdx}].ingredienti[${iIdx}].qta=this.value" style="font-size:0.8rem;">
                    <span class="planner-unit-label" style="font-size:0.7rem; color:var(--dim); align-self:center;">${escapeHTML(unita)}</span>
                    <span class="planner-ingredient-badge ${isInv ? 'is-linked' : 'is-unlinked'}">${isInv ? 'Inventario' : 'Extra'}</span>
                    ${plannerDropButton('ingredient', pIdx, ptIdx, iIdx)}
                    <button class="btn-del" onclick="currentPlan.pasti[${pIdx}].piatti[${ptIdx}].ingredienti.splice(${iIdx},1); renderGiorni();" style="width:20px; height:20px; font-size:10px;">X</button>`;
                document.getElementById(`ings-${pIdx}-${ptIdx}`).appendChild(iRow);
            });
        });
    });
}


// --- ALTRE FUNZIONI (UTILITIES) ---

function addPasto(g) { currentPlan.pasti.push({ giorno: g, nome: "Nuovo Pasto", piatti: [] }); renderGiorni(); }

function addPiatto(p) { currentPlan.pasti[p].piatti.push({ nome: "Nuovo Piatto", ingredienti: [] }); renderGiorni(); }

function addIng(p, pt) { currentPlan.pasti[p].piatti[pt].ingredienti.push({ nome: "", qta: 0, unita: "g" }); renderGiorni(); }



function aggiornaIng(pIdx, ptIdx, iIdx, valore) {

    const key = valore.toLowerCase().trim().replace(/\s+/g, '_');

    currentPlan.pasti[pIdx].piatti[ptIdx].ingredienti[iIdx].nome = key;

    if(mappaUnitaInventario[key]) currentPlan.pasti[pIdx].piatti[ptIdx].ingredienti[iIdx].unita = mappaUnitaInventario[key];

    renderGiorni();

}



async function caricaCronologia() {
    const container = document.getElementById('log-container');
    if (!container) return;

    try {
        const res = await apiFetch(API + "/system/log");
        const logs = await res.json();
        
        console.log("Log ricevuti dal server:", logs);

        if (!logs || !Array.isArray(logs) || logs.length === 0) {
            container.innerHTML = `<p style="color:var(--dim); font-size:0.75rem; padding:20px; text-align:center;">Nessuna attivita registrata.</p>`;
            return;
        }

        let html = "";
        logs.forEach(l => {
            // Protezione contro dati mancanti
            const azione = l.azione || "INFO";
            const dettagli = l.dettagli || "";
            const dataOra = l.data || "";

            let icon = "";
            let color = "#9ca3af";

            // Controllo icone (case insensitive)
            const azioneUpper = azione.toUpperCase();
            if (azioneUpper.includes("ACQUISTO")) {
                icon = ""; color = "#60a5fa";
            } else if (azioneUpper.includes("ANNULLAMENTO")) {
                icon = ""; color = "#f59e0b";
            } else if (azioneUpper.includes("SCARICO") || azioneUpper.includes("RIPRISTINO")) {
                icon = ""; color = "#f87171";
            }

            // Estrazione ora sicura dallo split
            const ora = dataOra.includes(' ') ? dataOra.split(' ')[1] : dataOra;

            html += `
                <div style="padding:12px 15px; border-bottom:1px solid #1e293b; font-size:0.8rem; animation: fadeIn 0.3s ease;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; align-items:center;">
                        <span style="color:${color}; font-weight:bold; display:flex; align-items:center; gap:8px;">
                            <span style="font-size:1rem;">${icon}</span> ${azione}
                        </span>
                        <span style="color:var(--dim); font-size:0.7rem; font-family:monospace;">${ora}</span>
                    </div>
                    <div style="color:#475569; padding-left:26px; line-height:1.4;">${dettagli}</div>
                </div>
            `;
        });
        
        container.innerHTML = html;

    } catch (e) {
        console.error("Errore critico render cronologia:", e);
        container.innerHTML = `<p style="color:#f87171; font-size:0.7rem; padding:15px;">Errore di connessione ai log.</p>`;
    }
}


// --- FUNZIONI CORRETTE PER LA GESTIONE SCARICO ---

async function annullaScaricoOggi() {
    // 1. Chiediamo conferma per sicurezza
    if(!confirm("Vuoi ripristinare le scorte consumate oggi? Questa azione puo essere fatta solo una volta.")) return;
    
    try {
        const res = await apiFetch(API + "/system/rollback-today", { method: "POST" });
        const data = await res.json();
        
        if(res.ok && data.status === "success") { 
            alert("Scorte ripristinate con successo!"); 
            // 2. AGGIORNA SUBITO LA DASHBOARD: il tasto diventera disabilitato
            await initDashboard(); 
        } else {
            // Se il server dice che e gia stato annullato, mostriamo il suo messaggio
            alert(data.message || "Errore durante l'annullamento");
        }
    } catch(e) { 
        alert("Errore di connessione al server."); 
    }
}

async function rifaiScaricoOggi() {
    if (!confirm("Hai annullato lo scarico. Vuoi eseguirlo di nuovo ora?")) return;
    
    try {
        const res = await apiFetch(API + "/system/reset-sync", { method: 'POST' });
        
        if (res.ok) {
            alert("Scarico ricalcolato!");
            
            // --- QUESTE RIGHE AGGIORNANO LA SCHERMATA ---
            await initDashboard();   // Aggiorna i tasti
            await caricaCronologia(); // <--- AGGIUNGI QUESTA: ricarica la lista dei log!
            // --------------------------------------------
            
        } else {
            alert("Errore durante il ripristino dello scarico.");
        }
    } catch (e) { 
        console.error("Errore:", e); 
    }
}

async function gestisciScaricoParziale(azione, payloadEncoded) {
    let payload;
    try {
        payload = JSON.parse(decodeURIComponent(payloadEncoded));
    } catch (e) {
        alert("Dati dello scarico non validi.");
        return;
    }

    if (!payload.ingredienti || payload.ingredienti.length === 0) {
        alert("Nessun ingrediente valido da aggiornare.");
        return;
    }

    const testo = azione === "annulla" ? "annullare lo scarico" : "ripristinare lo scarico";
    if (!confirm(`Vuoi ${testo} per ${payload.label}?`)) return;

    try {
        const res = await apiFetch(API + "/system/adjust-scarico", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                azione,
                ingredienti: payload.ingredienti
            })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert("Errore: " + (data.detail || "scarico parziale non riuscito"));
            return;
        }

        alert("Inventario aggiornato.");
        setScaricoParzialeState(
            payload.id || normalizzaNomeIngrediente(payload.label),
            azione === "annulla",
            payload.descendantIds || []
        );
        await initDashboard();
        await caricaCronologia();
    } catch (e) {
        console.error(e);
        alert("Errore di connessione al server.");
    }
}


async function caricaInventario() {
    const tableBody = document.getElementById('inventory-table-body');
    if(!tableBody) return; // Esce se non siamo nella pagina inventario

    try {
        // Nota: API + "/get-inventario" deve corrispondere al main.py modificato prima
        const res = await apiFetch(API + "/get-inventario?t=" + new Date().getTime());
        const inv = await res.json();
        
        console.log("Dati caricati:", inv); // Debug in console

        const keys = Object.keys(inv).sort();
        if (keys.length === 0) {
            tableBody.innerHTML = "<tr><td colspan='7'>File inventario vuoto</td></tr>";
            return;
        }

        tableBody.innerHTML = keys.map(key => {
            const data = inv[key];
            // Logica di fallback per il divisore (presa dal tuo logica.py)
            // Cerca prima il nome nuovo (valore), poi quelli vecchi (grammi, ml, pezzi)
            const contenuto = data.valore_per_confezione || data.grammi_per_confezione || data.ml_per_confezione || data.pezzi_per_confezione || 1;
            
            return `<tr data-original-name="${escapeHTML(key)}">
                <td><input type="text" value="${escapeHTML(key.replace(/_/g, ' '))}" class="edit-nome"></td>
                <td><input type="number" step="0.1" value="${escapeHTML(data.confezioni_attuali || 0)}" class="edit-attuale"></td>
                <td><input type="number" value="${escapeHTML(data.confezioni_massime || 0)}" class="edit-max"></td>
                <td><input type="text" value="${escapeHTML(data.unita_misura || 'g')}" class="edit-unita" list="unita-standard" style="width:90px"></td>
                <td><input type="number" value="${escapeHTML(contenuto)}" class="edit-fattore"></td>
                <td><input type="number" step="0.1" value="${escapeHTML(data.alert || 0)}" class="edit-alert"></td>
                <td><button class="btn-del" onclick="this.parentElement.parentElement.remove()">X</button></td>
            </tr>`;
        }).join("");

    } catch (e) {
        console.error("Errore nel caricamento inventario:", e);
        tableBody.innerHTML = "<tr><td colspan='7'>Errore di connessione al server</td></tr>";
    }
}



function popolaDatalist(inv) {

    const dl = document.getElementById('lista-ingredienti-inventario');

    mappaUnitaInventario = {};

    const options = Object.keys(inv).map(k => {

        mappaUnitaInventario[normalizzaNomeIngrediente(k)] = inv[k].unita_misura;

        return `<option value="${k.replace(/_/g, ' ')}">`;

    }).join("");

    if (dl) dl.innerHTML = options;

}



async function confermaAcquisto(key) {
    const qtaInput = document.getElementById(`buy-${key}`);
    const qtaEffettiva = parseFloat(qtaInput.value);

    if (isNaN(qtaEffettiva) || qtaEffettiva <= 0) return alert("Quantita non valida.");

    const payload = { acquisti: [{ nome: key, quantita: qtaEffettiva }] };

    try {
        const res = await apiFetch(API + "/inventario/acquista", {
            method: "POST", 
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            // 1. Recuperiamo l'inventario aggiornato dal server
            const invRes = await apiFetch(API + "/get-inventario");
            const nuovoInventario = await invRes.json();

            // 2. Aggiorniamo i componenti della dashboard senza ricaricare
            calcolaSpesa(nuovoInventario); // Toglie l'elemento dalla lista spesa
            caricaCronologia();            // Fa apparire il nuovo log dell'acquisto
            
            // Opzionale: un piccolo feedback visivo invece dell'alert bloccante
            console.log("Inventario aggiornato con successo");
        }
    } catch (e) { 
        alert("Errore connessione."); 
        console.error(e);
    }
}


function formatPackageSize(item) {
    const amount = item.valore_per_confezione
        || item.grammi_per_confezione
        || item.ml_per_confezione
        || item.pezzi_per_confezione
        || item.qta_per_confezione
        || item.quantita_per_confezione
        || "";
    const unit = item.unita_misura || item.unita || "";
    if (!amount && !unit) return "confezione";
    return `${amount || ""}${unit || ""}`.trim();
}



function calcolaSpesa(inv) {
    const shopList = document.getElementById('shopping-list');
    if (!shopList) return;
    
    console.log("Calcolo spesa con dati:", inv); // Debug
    window.lastInventoryForShopping = inv || {};
    shopList.innerHTML = "";
    let itemsToBuy = 0;

    // Ordiniamo i prodotti
    const prodotti = Object.keys(inv || {}).sort();

    prodotti.forEach(key => {
        const item = inv[key];
        // Logica: se le confezioni attuali sono minori o uguali alla soglia di alert
        if (parseFloat(item.confezioni_attuali) <= parseFloat(item.alert)) {
            itemsToBuy++;
            
            // Calcolo quante confezioni mancano per arrivare al massimo
            const daComprare = Math.max(1, Math.ceil(item.confezioni_massime - item.confezioni_attuali));
            const formatoConfezione = formatPackageSize(item);
            const packageLabel = `${daComprare} confezion${daComprare === 1 ? "e" : "i"} da ${formatoConfezione}`;
            
            const li = document.createElement('li');
            li.className = "shopping-item";
            li.style = `display: flex; align-items: center; justify-content: space-between; padding: 15px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #10b981; box-shadow: 0 1px 2px rgba(15,23,42,0.06);`;
            
            li.innerHTML = `
                <div style="flex:1;">
                    <div style="font-weight:bold; color:#0f172a; font-size:1.05rem; text-transform: capitalize;">${key.replace(/_/g, ' ')}</div>
                    <div style="color:var(--dim); font-size:0.8rem;">
                        Attuale: <span style="color:#ef4444;">${item.confezioni_attuali}</span> / Alert: ${item.alert}
                    </div>
                    <div style="color:#10b981; font-size:0.82rem; margin-top:4px; font-weight:700;">
                        ${escapeHTML(packageLabel)}
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:12px;">
                    <div style="text-align:right;">
                        <span style="display:block; font-size:0.65rem; color:var(--dim); text-transform:uppercase;">Prendi</span>
                        <input type="number" id="buy-${key}" value="${daComprare}" style="width:50px; background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; text-align:center; font-weight:bold; border-radius:6px; padding:4px;">
                        <span style="display:block; color:var(--dim); font-size:0.66rem; margin-top:3px;">da ${escapeHTML(formatoConfezione)}</span>
                    </div>
                    <button class="btn-check" onclick="confermaAcquisto('${key}')" title="Conferma">OK</button>
                </div>`;
            shopList.appendChild(li);
        }
    });

    const extraItems = extraShoppingBuyCards();
    extraItems.forEach(card => {
        itemsToBuy++;
        const li = document.createElement('li');
        li.className = "shopping-item shopping-extra-item";
        li.innerHTML = `
            <div style="flex:1;">
                <div class="shopping-extra-title">${escapeHTML(card.text)}</div>
                <div class="shopping-extra-meta">Aggiunto da Spesa extra</div>
            </div>
            <button class="btn-check" onclick="completeExtraShoppingItem('${card.id}')" title="Segna comprato">OK</button>
        `;
        shopList.appendChild(li);
    });

    if (itemsToBuy === 0) {
        shopList.innerHTML = `<div class="empty-state"><p>Dispensa al completo!</p></div>`;
    }
    
    const badge = document.getElementById('shop-count');
    if (badge) badge.innerText = itemsToBuy;
}

async function salvaInventario() {
    const tableBody = document.getElementById('inventory-table-body');
    if (!tableBody) return;

    const rows = tableBody.querySelectorAll('tr');
    // 1. Usiamo un array [] invece di un oggetto {}
    const listaInventario = []; 

    rows.forEach(row => {
    // Cerchiamo i valori usando delle classi specifiche, non l'ordine numerico
    const nomeInput = row.querySelector('.edit-nome');
    if (!nomeInput || !nomeInput.value.trim()) return;

    const nomeChiaro = nomeInput.value.trim();
    const nomePulito = nomeChiaro.toLowerCase().replace(/\s+/g, '_');

    // Creiamo l'oggetto leggendo ogni valore dalla sua classe
    const item = {
        original_nome: row.dataset.originalName || nomePulito,
        nome: nomePulito,
        confezioni_attuali: parseFloat(row.querySelector('.edit-attuale')?.value) || 0,
        confezioni_massime: parseFloat(row.querySelector('.edit-max')?.value) || 0,
        unita_misura: row.querySelector('.edit-unita')?.value || 'g',
        valore_per_confezione: parseFloat(row.querySelector('.edit-fattore')?.value) || 1,
        alert: parseFloat(row.querySelector('.edit-alert')?.value) || 0
    };

    listaInventario.push(item);
});

    try {
        const response = await apiFetch(API + "/inventario/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // 3. Inviamo la lista
            body: JSON.stringify({ inventario: listaInventario, delete_missing: true }) 
        });

        if (response.ok) {
            alert("Inventario salvato correttamente!");
            location.reload(); 
        } else {
            alert("Errore durante il salvataggio.");
        }
    } catch (e) {
        console.error("Errore:", e);
    }
}

function avviaOrologio() {
    setInterval(() => {
        const oraElem = document.getElementById('info-ora');
        const salutoElem = document.getElementById('saluto-dinamico');
        
        const oraAttuale = new Date();
        const h = oraAttuale.getHours();

        // 1. Aggiorna l'Ora
        if (oraElem) {
            oraElem.innerText = oraAttuale.toLocaleTimeString('it-IT');
        }

        // 2. Aggiorna il Saluto

    if (salutoElem) {
        let testo = "";
        let emoji = "";
        
        if (h >= 5 && h < 12) { testo = "Buongiorno"; emoji = ""; }
        else if (h >= 12 && h < 14) { testo = "Buon appetito"; emoji = ""; }
        else if (h >= 14 && h < 18) { testo = "Buon pomeriggio"; emoji = ""; }
        else if (h >= 18 && h < 22) { testo = "Buona serata"; emoji = ""; }
        else { testo = "Buona notte"; emoji = ""; }
        
        // Inseriamo il testo nello span (per il gradiente) e l'emoji fuori
        salutoElem.innerHTML = `<span class="testo-gradiente">${testo}</span>${emoji ? " " + emoji : ""}`;
    }
    }, 1000);
}


// COPIA UN INTERO GIORNO
function copyDay(giornoNome) {
    // Filtra tutti i pasti che appartengono a quel giorno
    const pastiDelGiorno = currentPlan.pasti.filter(p => p.giorno === giornoNome);
    if (pastiDelGiorno.length === 0) {
        alert("Giorno vuoto, nulla da copiare.");
        return;
    }
    // Salviamo una copia profonda per evitare che modifiche future influenzino la copia
    plannerClipboard.giorno = JSON.parse(JSON.stringify(pastiDelGiorno));
    alert(`Giorno ${giornoNome} copiato!`);
}

// INCOLLA UN INTERO GIORNO
function pasteDay(giornoDestinazione) {
    if (!plannerClipboard.giorno) return alert("Copia prima un giorno!");

    // Rimuoviamo i pasti vecchi del giorno di destinazione
    currentPlan.pasti = currentPlan.pasti.filter(p => p.giorno !== giornoDestinazione);

    // Incolliamo i nuovi pasti rinominando il campo "giorno"
    plannerClipboard.giorno.forEach(pasto => {
        let nuovoPasto = JSON.parse(JSON.stringify(pasto));
        nuovoPasto.giorno = giornoDestinazione;
        currentPlan.pasti.push(nuovoPasto);
    });

    renderGiorni(); // Ricarica la UI
    alert(`Giorno incollato su ${giornoDestinazione}!`);
}

// COPIA UN SINGOLO PASTO
function copyMeal(giornoNome, pastoNome) {
    const pasto = currentPlan.pasti.find(p => p.giorno === giornoNome && p.nome === pastoNome);
    if (!pasto) return alert("Pasto vuoto!");
    
    plannerClipboard.pasto = JSON.parse(JSON.stringify(pasto));
    alert(`${pastoNome} copiato!`);
}

function copyMealByIndex(pastoIndex) {
    const pasto = currentPlan.pasti[pastoIndex];
    if (!pasto) return alert("Pasto vuoto!");
    plannerClipboard.pasto = JSON.parse(JSON.stringify(pasto));
    alert(`${pasto.nome || "Pasto"} copiato!`);
}

// INCOLLA UN SINGOLO PASTO
function pasteMeal(giornoDest, pastoDest) {
    if (!plannerClipboard.pasto) return alert("Copia prima un pasto!");

    // Cerchiamo se il pasto esiste gia per sovrascriverlo, altrimenti lo creiamo
    let indice = currentPlan.pasti.findIndex(p => p.giorno === giornoDest && p.nome === pastoDest);
    
    let nuovoContenuto = JSON.parse(JSON.stringify(plannerClipboard.pasto));
    nuovoContenuto.giorno = giornoDest;
    nuovoContenuto.nome = pastoDest;

    if (indice !== -1) {
        currentPlan.pasti[indice] = nuovoContenuto;
    } else {
        currentPlan.pasti.push(nuovoContenuto);
    }

    renderGiorni();
}

function pasteMealByIndex(pastoIndex) {
    if (!plannerClipboard.pasto) return alert("Copia prima un pasto!");
    const target = currentPlan.pasti[pastoIndex];
    if (!target) return alert("Pasto di destinazione non trovato.");
    const nuovoContenuto = JSON.parse(JSON.stringify(plannerClipboard.pasto));
    nuovoContenuto.giorno = target.giorno;
    nuovoContenuto.nome = target.nome;
    currentPlan.pasti[pastoIndex] = nuovoContenuto;
    renderGiorni();
}

// COPIA UN SINGOLO PIATTO
function copyDish(giornoNome, pastoNome, piattoIndex) {
    const pasto = currentPlan.pasti.find(p => p.giorno === giornoNome && p.nome === pastoNome);
    if (!pasto || !pasto.piatti[piattoIndex]) return alert("Piatto non trovato!");

    plannerClipboard.piatto = JSON.parse(JSON.stringify(pasto.piatti[piattoIndex]));
    alert(`Piatto "${plannerClipboard.piatto.nome}" copiato!`);
}

function copyDishByIndex(pastoIndex, piattoIndex) {
    const pasto = currentPlan.pasti[pastoIndex];
    if (!pasto || !pasto.piatti || !pasto.piatti[piattoIndex]) return alert("Piatto non trovato!");
    plannerClipboard.piatto = JSON.parse(JSON.stringify(pasto.piatti[piattoIndex]));
    alert(`Piatto "${plannerClipboard.piatto.nome || "senza nome"}" copiato!`);
}

// INCOLLA UN SINGOLO PIATTO
function pasteDish(giornoDest, pastoDest, piattoIndex) {
    if (!plannerClipboard.piatto) return alert("Copia prima un piatto!");

    let pasto = currentPlan.pasti.find(p => p.giorno === giornoDest && p.nome === pastoDest);
    
    // Se il pasto non esiste nel giorno di destinazione, lo creiamo vuoto
    if (!pasto) {
        pasto = { giorno: giornoDest, nome: pastoDest, piatti: [] };
        currentPlan.pasti.push(pasto);
    }

    const nuovoPiatto = JSON.parse(JSON.stringify(plannerClipboard.piatto));
    
    // Se specifichiamo un indice (modifica), lo sostituiamo, altrimenti lo aggiungiamo
    if (piattoIndex !== undefined && pasto.piatti[piattoIndex]) {
        pasto.piatti[piattoIndex] = nuovoPiatto;
    } else {
        pasto.piatti.push(nuovoPiatto);
    }

    renderGiorni();
}

function pasteDishByIndex(pastoIndex, piattoIndex) {
    if (!plannerClipboard.piatto) return alert("Copia prima un piatto!");
    const pasto = currentPlan.pasti[pastoIndex];
    if (!pasto || !pasto.piatti) return alert("Pasto non trovato.");
    pasto.piatti[piattoIndex] = JSON.parse(JSON.stringify(plannerClipboard.piatto));
    renderGiorni();
}







