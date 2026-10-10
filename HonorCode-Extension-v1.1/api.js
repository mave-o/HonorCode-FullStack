// api.js
// One function that every network call goes through, so timeouts and error
// handling behave the same everywhere (background.js and popup.js both use it).

import { CONFIG } from "./config.js";

// Sends a POST with a JSON body to the backend.
// path  : e.g. "/api/events"
// body  : a plain object, sent as JSON
// token : the login token; omit for register/login
// Always RESOLVES (never throws) with one of:
//   { ok: true,  status, data }
//   { ok: false, status, code, message, network }   (network = true if no reply at all)
export async function apiPost(path, body, token) {
  // AbortController lets us cancel a request that takes too long, so one
  // slow request can never freeze the upload queue.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(CONFIG.API_BASE_URL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Only logged-in calls carry the token.
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    // Try to read the JSON reply; some errors (e.g. 502) have no JSON body.
    let data = null;
    try { data = await res.json(); } catch { /* no JSON body */ }

    // Success = HTTP 2xx AND the body does not say {ok:false}.
    if (res.ok && !(data && data.ok === false)) {
      return { ok: true, status: res.status, data };
    }
    // The spec's error shape is { ok:false, error:{ code, message } }.
    return {
      ok: false,
      status: res.status,
      code: (data && data.error && data.error.code) || `HTTP_${res.status}`,
      message: (data && data.error && data.error.message) || "The server rejected the request.",
      network: false
    };
  } catch (err) {
    // fetch itself failed: offline, DNS error, server down, or our timeout.
    const timedOut = err && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      code: timedOut ? "TIMEOUT" : "NETWORK",
      message: timedOut ? "The server took too long to answer." : "Could not reach the server.",
      network: true
    };
  } finally {
    clearTimeout(timer); // always stop the timer, success or failure
  }
}
