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

async function callRpc(fnName, args) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.NCT_CONFIG;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(args),
  });

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
    throw new Error(message);
  }
  return body;
}

function showStatus(el, message, kind) {
  el.textContent = message;
  el.className = `status show ${kind}`;
}

async function loadCentres() {
  const grid = document.getElementById("centreGrid");
  try {
    const resp = await fetch("./centres.json", { cache: "no-store" });
    const centres = await resp.json();
    if (!Array.isArray(centres) || centres.length === 0) {
      grid.innerHTML =
        '<p class="hint">No centre list yet — the checker hasn\'t run for the first time. Check back shortly.</p>';
      return;
    }
    grid.innerHTML = "";
    for (const name of centres) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "centre";
      checkbox.value = name;
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(name));
      grid.appendChild(label);
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

  loadCentres();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
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
