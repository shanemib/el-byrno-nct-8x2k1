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
  el.setAttribute("role", kind === "error" ? "alert" : "status");
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
    : `🟢 Live — scanning all ${centreCount} NCT centres, hourly`;
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
    // Fine to stay quiet — the static "hourly" wording is a fair fallback.
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

async function loadCentres() {
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

async function initUnsubscribePage() {
  const resultEl = document.getElementById("result");
  const token = getTokenFromUrl();
  if (!token) {
    resultEl.innerHTML = '<div class="icon">⚠️</div><p>Missing unsubscribe link. Please use the link from your email.</p>';
    return;
  }
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
}
