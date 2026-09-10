// Single source of truth for how often the checker runs, so this only ever
// needs updating in one place. It used to say "hourly" in about a dozen
// spots across this file and the HTML pages — accurate when it was written,
// silently wrong (and a little embarrassing) after the schedule moved to
// every 15 minutes, since nothing here reminded anyone to go find every copy
// of the word "hourly" and update it. Static text baked into meta tags,
// JSON-LD, and og:description can't reference this (crawlers read the raw
// HTML) and was hand-edited instead — see index.html/availability.html/
// stats.html — so if the schedule changes again, update those too.
const CHECK_INTERVAL_LABEL = "every 15 minutes";

// Best-effort centre → county mapping, used only to make the centre picker
// easier to scan/search. Purely cosmetic — never sent to the backend.
const CENTRE_COUNTIES = {
  "Abbeyfeale": "Limerick",
  "Arklow": "Wicklow",
  "Athlone": "Westmeath",
  "Ballina": "Mayo",
  "Ballinasloe": "Galway",
  "Cahir": "Tipperary",
  "Cahirciveen": "Kerry",
  "Carlow": "Carlow",
  "Carndonagh": "Donegal",
  "Carrick-on-Shannon": "Leitrim",
  "Castleisland": "Kerry",
  "Castlerea": "Roscommon",
  "Cavan": "Cavan",
  "Charleville": "Cork",
  "Clifden": "Galway",
  "Cork-Blarney": "Cork",
  "Cork-Little Island": "Cork",
  "Deansgrange": "Dublin",
  "Derrybeg": "Donegal",
  "Donegal Town": "Donegal",
  "Drogheda": "Louth",
  "Dundalk": "Louth",
  "Ennis": "Clare",
  "Enniscorthy": "Wexford",
  "Fonthill": "Dublin",
  "Galway": "Galway",
  "Greenhills (Exit 11,M50)": "Dublin",
  "Kells": "Meath",
  "Kilkenny": "Kilkenny",
  "Killarney": "Kerry",
  "Letterkenny": "Donegal",
  "Limerick": "Limerick",
  "Longford": "Longford",
  "Macroom": "Cork",
  "Monaghan": "Monaghan",
  "Mullingar": "Westmeath",
  "Naas": "Kildare",
  "Navan": "Meath",
  "Nenagh": "Tipperary",
  "Northpoint 1 (Exit 4, M50)": "Dublin",
  "Northpoint 2 (Exit 4, M50)": "Dublin",
  "Portlaoise": "Laois",
  "Skibbereen": "Cork",
  "Sligo": "Sligo",
  "Tralee": "Kerry",
  "Tuam": "Galway",
  "Tullamore": "Offaly",
  "Waterford": "Waterford",
  "Westport": "Mayo",
  "Youghal": "Cork",
};

function initAds() {
  const { ADSENSE_CLIENT_ID, ADSENSE_SLOT_ID } = window.NCT_CONFIG || {};
  const slot = document.getElementById("adSlot");
  if (!ADSENSE_CLIENT_ID || !slot) return; // not configured yet — leave the page ad-free

  // Load the AdSense script only once we actually have a client id, so the
  // site works perfectly well (and shows no ad box) before you're approved.
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`;
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);

  slot.hidden = false;
  slot.innerHTML = `<ins class="adsbygoogle"
      style="display:block"
      data-ad-client="${ADSENSE_CLIENT_ID}"
      data-ad-slot="${ADSENSE_SLOT_ID}"
      data-ad-format="auto"
      data-full-width-responsive="true"></ins>`;
  (window.adsbygoogle = window.adsbygoogle || []).push({});
}

// Turn an RPC error into something a visitor should actually see. Our own
// SQL functions raise deliberate, friendly messages (e.g. "Please choose at
// least one test centre") — those pass straight through. Anything else
// (a Postgres/PostgREST internal error, a missing function, a network
// hiccup) gets swapped for a generic apology instead of raw backend text.
function prettifyError(message) {
  const knownPrefixes = [
    "Please enter a valid email address",
    "Please choose at least one test centre",
    "days_ahead must be",
    "weeks_ahead must be",
    "WhatsApp number must be",
  ];
  if (knownPrefixes.some((p) => message && message.startsWith(p))) {
    return message;
  }
  return "Something went wrong on our end — please try again in a minute.";
}

async function callRpc(fnName, args) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.NCT_CONFIG;
  let resp;
  try {
    resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    // fetch() itself throws for network-level failures (offline, DNS, etc.)
    // — there's no response to read a message from, so give a plain one.
    throw new Error("Couldn't reach the server — check your connection and try again.");
  }

  let body = null;
  try {
    body = await resp.json();
  } catch (e) {
    // no JSON body — fine for functions that return void
  }

  if (!resp.ok) {
    const message =
      (body && (body.message || body.hint || body.error_description)) ||
      "Something went wrong — please try again.";
    throw new Error(prettifyError(message));
  }
  return body;
}

function showStatus(el, message, kind) {
  el.textContent = message;
  el.className = `status show ${kind}`;
  // role="alert"/"status" are themselves ARIA live-region roles, but some
  // screen readers only pick up content changes in a region that already
  // existed (with a live-region role) at the time the change happens, not
  // one where the role itself is what's new. The element carries a baseline
  // aria-live="polite" from the markup for that reason; this just upgrades
  // it to "assertive" for errors, which matters more than the exact wording.
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
}

let centreCount = null;
let lastCheckedIso = null;

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMin < 1) return "just now";
  if (diffMin === 1) return "1 minute ago";
  if (diffMin < 60) return `${diffMin} minutes ago`;
  const hrs = Math.round(diffMin / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

function renderLiveStatus() {
  const el = document.getElementById("liveStatus");
  if (!el || centreCount == null) return;
  const ago = lastCheckedIso ? timeAgo(lastCheckedIso) : null;
  el.textContent = ago
    ? `🟢 Live — ${centreCount} NCT centres, last checked ${ago}`
    : `🟢 Live — scanning all ${centreCount} NCT centres, ${CHECK_INTERVAL_LABEL}`;
}

async function loadLastChecked() {
  try {
    const resp = await fetch("./last_checked.json", { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.timestamp) {
      lastCheckedIso = data.timestamp;
      renderLiveStatus();
    }
  } catch (e) {
    // Fine to stay quiet — the static CHECK_INTERVAL_LABEL wording is a fair fallback.
  }
}

function updateSelectedCount(grid) {
  const countEl = document.getElementById("selectedCount");
  if (!countEl) return;
  const n = grid.querySelectorAll('input[name="centre"]:checked').length;
  countEl.textContent = n === 1 ? "1 selected" : `${n} selected`;
}

function filterCentres(grid, query) {
  const q = query.trim().toLowerCase();
  const options = grid.querySelectorAll(".centre-option");
  let anyVisible = false;
  options.forEach((opt) => {
    const haystack = opt.dataset.search || "";
    const match = !q || haystack.includes(q);
    opt.classList.toggle("is-hidden", !match);
    if (match) anyVisible = true;
  });
  let emptyMsg = grid.querySelector(".no-match-hint");
  if (!anyVisible) {
    if (!emptyMsg) {
      emptyMsg = document.createElement("p");
      emptyMsg.className = "hint no-match-hint";
      emptyMsg.textContent = "No centres match that search.";
      grid.appendChild(emptyMsg);
    }
  } else if (emptyMsg) {
    emptyMsg.remove();
  }
}

async function loadCentres(preselected) {
  const grid = document.getElementById("centreGrid");
  const searchInput = document.getElementById("centreSearch");
  try {
    const resp = await fetch("./centres.json", { cache: "no-store" });
    const centres = await resp.json();
    if (!Array.isArray(centres) || centres.length === 0) {
      grid.innerHTML =
        '<p class="hint">No centre list yet — the checker hasn\'t run for the first time. Check back shortly.</p>';
      return;
    }

    centreCount = centres.length;
    renderLiveStatus();

    grid.innerHTML = "";
    for (const name of centres) {
      const county = CENTRE_COUNTIES[name] || "";
      const label = document.createElement("label");
      label.className = "centre-option";
      label.dataset.search = `${name} ${county}`.toLowerCase();

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "centre";
      checkbox.value = name;
      checkbox.addEventListener("change", () => updateSelectedCount(grid));

      const nameWrap = document.createElement("span");
      nameWrap.className = "centre-name-wrap";
      const nameEl = document.createElement("span");
      nameEl.textContent = name;
      nameWrap.appendChild(nameEl);
      if (county) {
        const countyEl = document.createElement("span");
        countyEl.className = "centre-county";
        countyEl.textContent = county;
        nameWrap.appendChild(countyEl);
      }

      label.appendChild(checkbox);
      label.appendChild(nameWrap);
      grid.appendChild(label);
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => filterCentres(grid, searchInput.value));
    }

    if (preselected && preselected.length) {
      const set = new Set(preselected);
      grid.querySelectorAll('input[name="centre"]').forEach((cb) => {
        if (set.has(cb.value)) cb.checked = true;
      });
      updateSelectedCount(grid);
    }
  } catch (e) {
    grid.innerHTML = '<p class="hint">Couldn\'t load the centre list — please refresh the page.</p>';
  }
}

function initSignupForm() {
  const form = document.getElementById("signupForm");
  if (!form) return;
  const statusEl = document.getElementById("status");
  const submitBtn = form.querySelector("button[type=submit]");
  const formOpenedAt = Date.now();

  loadCentres();
  loadLastChecked();

  // Small trust signal — only shows once there's a real number worth
  // mentioning, so a handful of early testers doesn't look sparse.
  const SOCIAL_PROOF_MIN = 5;
  callRpc("get_subscriber_count", {})
    .then((count) => {
      const el = document.getElementById("socialProof");
      if (el && typeof count === "number" && count >= SOCIAL_PROOF_MIN) {
        el.textContent = `Join ${count} people already getting NCT alerts.`;
        el.hidden = false;
      }
    })
    .catch(() => {});

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Basic bot filtering: a hidden field real visitors never see or fill,
    // plus a minimum time-on-page — no CAPTCHA needed to catch the
    // unsophisticated form-filling bots this is mainly meant to deter.
    const honeypot = document.getElementById("companyWebsite").value.trim();
    const tooFast = Date.now() - formOpenedAt < 1500;
    if (honeypot || tooFast) {
      showStatus(
        statusEl,
        "Almost there — check your inbox for a confirmation email (usually within a few minutes).",
        "success"
      );
      form.reset();
      return;
    }

    const email = document.getElementById("email").value.trim();
    const whatsapp = document.getElementById("whatsapp").value.trim();
    const daysAhead = parseInt(document.getElementById("daysAhead").value, 10);
    const centres = Array.from(
      form.querySelectorAll('input[name="centre"]:checked')
    ).map((c) => c.value);

    if (centres.length === 0) {
      showStatus(statusEl, "Please choose at least one test centre.", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing up...";

    try {
      await callRpc("signup_subscriber", {
        p_email: email,
        p_centres: centres,
        p_days_ahead: daysAhead,
        p_whatsapp_number: whatsapp || null,
      });
      showStatus(
        statusEl,
        "Almost there — check your inbox for a confirmation email (usually within a few minutes).",
        "success"
      );
      form.reset();
      updateSelectedCount(document.getElementById("centreGrid"));
    } catch (err) {
      showStatus(statusEl, err.message, "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign up for alerts";
    }
  });
}

function formatWindow(days) {
  if (days == null) return null;
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? "1 week" : `${weeks} weeks`;
  }
  return days === 1 ? "1 day" : `${days} days`;
}

const URGENT_WINDOW_DAYS = 2; // "today or tomorrow" — the closest we can honestly
                               // call "next 48 hours" when we only track dates, not times.

function renderUrgentSection(data) {
  const urgentList = document.getElementById("urgentList");
  if (!urgentList) return; // page doesn't have the urgent section (shouldn't happen, but be safe)

  const todayIso = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + URGENT_WINDOW_DAYS - 1);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const matches = [];
  for (const centre of Object.keys(data)) {
    for (const slot of data[centre] || []) {
      if (slot.iso >= todayIso && slot.iso <= cutoffIso) {
        matches.push({ centre, ...slot });
      }
    }
  }
  matches.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : a.centre.localeCompare(b.centre)));

  if (matches.length === 0) {
    urgentList.innerHTML =
      `<p class="urgent-empty">Nothing that short-notice right now — check back after the next automatic check (${CHECK_INTERVAL_LABEL}), or sign up below to get emailed the moment something opens.</p>`;
    return;
  }

  urgentList.innerHTML = "";
  for (const m of matches) {
    const county = CENTRE_COUNTIES[m.centre] || "";
    const card = document.createElement("div");
    card.className = "urgent-card";
    const heading = document.createElement("h4");
    heading.textContent = county ? `${m.centre} — ${county}` : m.centre;
    card.appendChild(heading);
    const when = document.createElement("div");
    when.className = "urgent-when";
    when.textContent = m.date;
    card.appendChild(when);
    const times = document.createElement("div");
    times.className = "avail-times";
    times.textContent = (m.times || []).join(", ") || "(times not read)";
    card.appendChild(times);
    urgentList.appendChild(card);
  }
}

async function initAvailabilityPage() {
  const listEl = document.getElementById("availabilityList");
  const noAvailSection = document.getElementById("noAvailSection");
  const noAvailList = document.getElementById("noAvailList");
  const windowNote = document.getElementById("windowNote");

  loadLastChecked();

  let allCentres = [];
  try {
    const centresResp = await fetch("./centres.json", { cache: "no-store" });
    allCentres = centresResp.ok ? await centresResp.json() : [];
    if (Array.isArray(allCentres)) {
      centreCount = allCentres.length;
      renderLiveStatus();
    }
  } catch (e) {
    // fall through — we can still render availability.json alone
  }

  try {
    const resp = await fetch("./availability.json", { cache: "no-store" });
    const raw = resp.ok ? await resp.json() : {};
    // Support both the current {window_days, centres} shape and the
    // earlier flat-object shape, just in case a stale file is still live.
    const data = raw && raw.centres ? raw.centres : raw || {};
    const windowDays = raw && raw.window_days;

    const windowText = formatWindow(windowDays) || "the next few weeks";
    windowNote.textContent = `Showing availability within ${windowText} from today — a centre with nothing listed simply has no slots that soon.`;

    renderUrgentSection(data);

    const centresWithSlots = Object.keys(data).sort();
    const fullList = allCentres.length ? allCentres.slice().sort() : centresWithSlots;
    const centresWithoutSlots = fullList.filter((c) => !data[c] || data[c].length === 0);

    if (centresWithSlots.length === 0) {
      listEl.innerHTML =
        `<p class="hint">No appointments currently available at any centre we track. Check back after the next automatic check (${CHECK_INTERVAL_LABEL}), or sign up below to get emailed automatically.</p>`;
    } else {
      listEl.innerHTML = "";
      for (const centre of centresWithSlots) {
        const county = CENTRE_COUNTIES[centre] || "";
        const card = document.createElement("div");
        card.className = "avail-card";

        const heading = document.createElement("h3");
        heading.textContent = county ? `${centre} — ${county}` : centre;
        card.appendChild(heading);

        const dateList = document.createElement("div");
        dateList.className = "avail-dates";
        for (const slot of data[centre]) {
          const row = document.createElement("div");
          row.className = "avail-date-row";
          const dateEl = document.createElement("span");
          dateEl.className = "avail-date";
          dateEl.textContent = slot.date;
          row.appendChild(dateEl);
          const timesEl = document.createElement("span");
          timesEl.className = "avail-times";
          timesEl.textContent = (slot.times || []).join(", ") || "(times not read)";
          row.appendChild(timesEl);
          dateList.appendChild(row);
        }
        card.appendChild(dateList);
        listEl.appendChild(card);
      }
    }

    if (centresWithoutSlots.length > 0) {
      noAvailSection.hidden = false;
      noAvailList.innerHTML = "";
      for (const centre of centresWithoutSlots) {
        const pill = document.createElement("span");
        pill.className = "no-avail-pill";
        const county = CENTRE_COUNTIES[centre];
        pill.textContent = county ? `${centre} (${county})` : centre;
        noAvailList.appendChild(pill);
      }
    }
  } catch (e) {
    listEl.innerHTML = '<p class="hint">Couldn\'t load the latest results — please refresh the page.</p>';
    const urgentList = document.getElementById("urgentList");
    if (urgentList) urgentList.innerHTML = '<p class="hint">Couldn\'t load the latest results.</p>';
  }
}

function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("token");
}

async function initVerifyPage() {
  const resultEl = document.getElementById("result");
  const token = getTokenFromUrl();
  if (!token) {
    resultEl.innerHTML = '<div class="icon">⚠️</div><p>Missing confirmation link. Please use the link from your email.</p>';
    return;
  }
  try {
    const ok = await callRpc("verify_subscriber", { p_token: token });
    if (ok) {
      resultEl.innerHTML =
        '<div class="icon">✅</div><p>You\'re confirmed! We\'ll email you when a matching NCT appointment opens up.</p>';
    } else {
      resultEl.innerHTML =
        '<div class="icon">⚠️</div><p>This confirmation link has already been used or has expired. If you still want alerts, sign up again.</p>';
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="icon">⚠️</div><p>${err.message}</p>`;
  }
}

async function initManagePage() {
  const tokenError = document.getElementById("tokenError");
  const tokenErrorText = document.getElementById("tokenErrorText");
  const manageWrap = document.getElementById("manageWrap");
  const token = getTokenFromUrl();

  const showError = (msg) => {
    tokenErrorText.textContent = msg;
    tokenError.hidden = false;
    manageWrap.hidden = true;
  };

  if (!token) {
    showError("Missing manage link. Please use the link from one of your alert emails.");
    return;
  }

  let prefs;
  try {
    const rows = await callRpc("get_subscriber_prefs", { p_token: token });
    if (!rows || rows.length === 0) {
      showError(
        "We couldn't find that subscription — the link may be out of date, or you've already unsubscribed."
      );
      return;
    }
    prefs = rows[0];
  } catch (err) {
    showError(err.message);
    return;
  }

  manageWrap.hidden = false;
  document.getElementById("manageEmail").textContent = `Editing alerts for ${prefs.email}`;
  document.getElementById("daysAhead").value = String(prefs.days_ahead || 28);
  document.getElementById("whatsapp").value = prefs.whatsapp_number || "";
  document.getElementById("unsubLink").href = `./unsubscribe.html?token=${encodeURIComponent(token)}`;

  loadCentres(prefs.centres || []);

  const form = document.getElementById("manageForm");
  const statusEl = document.getElementById("status");
  const submitBtn = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const whatsapp = document.getElementById("whatsapp").value.trim();
    const daysAhead = parseInt(document.getElementById("daysAhead").value, 10);
    const centres = Array.from(
      form.querySelectorAll('input[name="centre"]:checked')
    ).map((c) => c.value);

    if (centres.length === 0) {
      showStatus(statusEl, "Please choose at least one test centre.", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    try {
      await callRpc("update_subscriber_prefs", {
        p_token: token,
        p_centres: centres,
        p_days_ahead: daysAhead,
        p_whatsapp_number: whatsapp || null,
      });
      showStatus(statusEl, "Saved — your alerts are updated.", "success");
    } catch (err) {
      showStatus(statusEl, err.message, "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save changes";
    }
  });
}

const STATS_MIN_RUNS_FOR_CONFIDENCE = 96; // roughly a day of checks at a 15-minute interval

function formatTrackingSince(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch (e) {
    return null;
  }
}

async function initStatsPage() {
  const noteEl = document.getElementById("statsNote");
  const summaryEl = document.getElementById("statsSummary");
  const tableWrap = document.getElementById("statsTableWrap");

  let stats;
  try {
    stats = await callRpc("get_stats", { p_lookback_days: 30 });
  } catch (err) {
    summaryEl.innerHTML = `<p class="hint">${err.message}</p>`;
    return;
  }

  const totalRuns = stats && stats.total_runs ? stats.total_runs : 0;
  const centres = (stats && stats.centres) || [];

  if (!stats || totalRuns === 0 || centres.length === 0) {
    noteEl.hidden = false;
    noteEl.textContent =
      "We only just started tracking history for these stats — check back in a few days once more checks have run.";
    summaryEl.innerHTML = "";
    tableWrap.innerHTML = "";
    return;
  }

  if (totalRuns < STATS_MIN_RUNS_FOR_CONFIDENCE) {
    noteEl.hidden = false;
    noteEl.textContent = `Still early days — these numbers are based on only ${totalRuns} check${totalRuns === 1 ? "" : "s"} so far and will get more reliable over time.`;
  } else {
    noteEl.hidden = true;
  }

  const since = formatTrackingSince(stats.tracking_since);
  const shortNoticeRate = stats.short_notice_rate_7d;

  summaryEl.innerHTML = "";
  const cards = [
    {
      value: shortNoticeRate == null ? "—" : `${shortNoticeRate}%`,
      label: "of checks found a short-notice (within 7 days) slot somewhere in the country",
    },
    { value: String(totalRuns), label: "checks in the last 30 days" },
    { value: String(centres.length), label: "centres tracked" },
  ];
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const value = document.createElement("span");
    value.className = "stat-value";
    value.textContent = c.value;
    const label = document.createElement("span");
    label.className = "stat-label";
    label.textContent = c.label;
    card.appendChild(value);
    card.appendChild(label);
    summaryEl.appendChild(card);
  }
  if (since) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const value = document.createElement("span");
    value.className = "stat-value";
    value.style.fontSize = "16px";
    value.textContent = since;
    const label = document.createElement("span");
    label.className = "stat-label";
    label.textContent = "tracking history since";
    card.appendChild(value);
    card.appendChild(label);
    summaryEl.appendChild(card);
  }

  tableWrap.innerHTML = "";
  const table = document.createElement("table");
  table.className = "stats-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Centre</th>
        <th>Availability rate (30d)</th>
        <th>Typical wait when available</th>
        <th>Checks</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const row of centres) {
    const county = CENTRE_COUNTIES[row.centre] || "";
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = county ? `${row.centre} (${county})` : row.centre;
    tr.appendChild(nameTd);

    const rateTd = document.createElement("td");
    const rate = row.availability_rate == null ? 0 : row.availability_rate;
    rateTd.innerHTML = `<span class="stats-bar-track"><span class="stats-bar-fill" style="width:${Math.min(100, rate)}%"></span></span>${row.availability_rate == null ? "—" : rate + "%"}`;
    tr.appendChild(rateTd);

    const waitTd = document.createElement("td");
    waitTd.textContent = row.avg_soonest_days == null ? "—" : `~${row.avg_soonest_days} day${row.avg_soonest_days === 1 ? "" : "s"}`;
    tr.appendChild(waitTd);

    const checksTd = document.createElement("td");
    checksTd.textContent = String(row.checks);
    tr.appendChild(checksTd);

    tbody.appendChild(tr);
  }
  tableWrap.appendChild(table);
}

async function initUnsubscribePage() {
  const resultEl = document.getElementById("result");
  const token = getTokenFromUrl();
  if (!token) {
    resultEl.innerHTML = '<div class="icon">⚠️</div><p>Missing unsubscribe link. Please use the link from your email.</p>';
    return;
  }

  // Deliberately does NOT unsubscribe just from this page loading. Some
  // corporate email gateways and security scanners (Microsoft Safe Links,
  // Mimecast, Proofpoint and similar) automatically open every link in an
  // email before it reaches the inbox, to check it's safe — if unsubscribing
  // happened on page load, that alone could silently unsubscribe someone who
  // never clicked anything themselves. Requiring one extra click here means
  // only an actual visitor triggers it.
  const runUnsubscribe = async () => {
    resultEl.innerHTML = '<div class="icon">⏳</div><p>Unsubscribing…</p>';
    try {
      const ok = await callRpc("unsubscribe_subscriber", { p_token: token });
      if (ok) {
        resultEl.innerHTML = '<div class="icon">👋</div><p>You\'ve been unsubscribed — you won\'t receive any more alerts.</p>';
      } else {
        resultEl.innerHTML = '<div class="icon">⚠️</div><p>We couldn\'t find that subscription — it may already be removed.</p>';
      }
    } catch (err) {
      resultEl.innerHTML = `<div class="icon">⚠️</div><p>${err.message}</p>`;
    }
  };

  resultEl.innerHTML =
    '<div class="icon">👋</div>' +
    "<p>Sure you want to stop getting NCT appointment alerts?</p>" +
    '<button type="button" id="confirmUnsubBtn" style="width:auto;padding:10px 20px;">Yes, unsubscribe me</button>';
  document.getElementById("confirmUnsubBtn").addEventListener("click", runUnsubscribe);
}
