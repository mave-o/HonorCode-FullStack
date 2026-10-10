// GET /api/health
// "Is the backend alive and configured?" Used by QA and by you after each deploy.
// Reveals nothing sensitive and does not touch Google (so it never costs quota).
// If configured is false, open the Vercel function logs to see which setting is wrong.

import { route, send } from "../lib/http.js";
import { env } from "../lib/env.js";

export default route(["GET"], async (req, res) => {
  let configured = true;
  try { env(); } catch { configured = false; }
  send(res, 200, { ok: true, service: "honorcode-backend", configured, time: new Date().toISOString() });
});
