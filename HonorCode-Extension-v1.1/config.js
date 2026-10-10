// config.js  (replaces the earlier version)
// Same exports as before, so background.js, popup.js and api.js need no changes.
// The difference: values you are likely to change per environment now come from
// env.js, which scripts/build-env.js generates from your .env file.
// Everything else (backoff, caps, site lists) stays in code on purpose, because
// changing those is a code change that should go through review, not a .env edit.

import { ENV } from "./env.js"; // generated file: run `node scripts/build-env.js` first

export const CONFIG = {
  // --- From .env ---------------------------------------------------------
  API_BASE_URL: ENV.API_BASE_URL,                       // backend address
  QUIZ_URL_PREFIX: ENV.QUIZ_URL_PREFIX,                 // what counts as the quiz tab
  ALLOW_ANY_PAGE_AS_QUIZ: ENV.ALLOW_ANY_PAGE_AS_QUIZ,   // dev-only test switch
  ALLOW_MANUAL_STOP: ENV.ALLOW_MANUAL_STOP,             // show the Stop button or not

  BATCH_SIZE: ENV.BATCH_SIZE,                           // send when this many events wait
  FLUSH_INTERVAL_MS: ENV.FLUSH_INTERVAL_MS,             // ...or when this long passed
  REQUEST_TIMEOUT_MS: ENV.REQUEST_TIMEOUT_MS,           // abort a hung request after this
  HEARTBEAT_MINUTES: ENV.HEARTBEAT_MINUTES,             // "still alive" interval
  MAX_SESSION_MS: ENV.MAX_SESSION_HOURS * 60 * 60 * 1000, // .env is in hours, code wants ms

  // --- Fixed in code (not meant to change per environment) ---------------
  MAX_BATCH: 50,                              // hard ceiling on events per request
  BACKOFF_MS: [5000, 15000, 45000, 60000],    // waits between retries
  MAX_BUFFER: 3000,                           // cap on stored events during a long outage

  // Site categories, checked top to bottom (first match wins).
  // exact:false matches the domain and its subdomains; exact:true only that domain.
  CATEGORY_RULES: [
    { category: "ai_tool", exact: false, domains: [
      "chatgpt.com", "chat.openai.com", "openai.com", "gemini.google.com",
      "claude.ai", "copilot.microsoft.com", "perplexity.ai", "poe.com",
      "character.ai", "deepseek.com", "grok.com"
    ]},
    { category: "notes_docs", exact: false, domains: [
      "docs.google.com", "drive.google.com", "notion.so", "onenote.com",
      "evernote.com", "onedrive.live.com", "sharepoint.com"
    ]},
    { category: "search", exact: true, domains: [
      "google.com", "bing.com", "duckduckgo.com", "search.brave.com", "yahoo.com"
    ]}
  ]
};
