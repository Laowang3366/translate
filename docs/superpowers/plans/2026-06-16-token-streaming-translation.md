# Token Streaming Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream model-generated translation text to the user as soon as tokens arrive, including the public web demo experience.

**Architecture:** Add an OpenAI-compatible streaming request path in the shared translator, expose it through the backend SSE endpoint, and update web UI consumers to append `delta` events. Keep existing chunk cache and quality checks as finalization steps so cached chunks are still instant and failed full results are not persisted.

**Tech Stack:** TypeScript, React, Electron IPC/preload, Node HTTP server, Vitest, OpenAI-compatible `/chat/completions` SSE.

---

### Task 1: Shared Model Token Stream Parser

**Files:**
- Modify: `src/shared/translator.ts`
- Test: `src/shared/translator.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that call a new streaming helper with an OpenAI-compatible SSE body containing two `choices[0].delta.content` frames and `[DONE]`. Assert that the callback receives both deltas in order and the final result equals their concatenation. Add a second test for malformed stream JSON returning a clear Chinese error.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/shared/translator.test.ts -t "streams OpenAI-compatible"`

Expected: FAIL because the streaming helper/API does not exist.

- [ ] **Step 3: Implement shared streaming**

Add an exported `translateTextStream(input, onEvent)` function that reuses prompt construction and provider error normalization, sends `stream: true`, reads `response.body`, parses `data:` SSE records, emits `{ type: 'delta', text }`, and returns the final `TranslateTextResult`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/shared/translator.test.ts -t "streams OpenAI-compatible"`

Expected: PASS.

### Task 2: Backend SSE Delta Forwarding

**Files:**
- Modify: `server/backend.mjs`
- Modify: `server/index.mjs`
- Test: `server/backend.test.mjs`

- [ ] **Step 1: Write failing tests**

Add a backend stream test whose mocked `translateText` accepts `onToken` and emits `你` then `好`. Assert `/api/translate/stream` emits `start`, `delta`, `chunk`, and `done` events, and `done.result.translatedText` is `你好`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/backend.test.mjs -t "streams model token deltas"`

Expected: FAIL because backend does not pass or emit token deltas.

- [ ] **Step 3: Implement backend delta propagation**

Pass an `onToken` callback into each provider translation call. Emit backend SSE `{ type: 'delta', chunkIndex, chunkCount, text, translatedText }` immediately when tokens arrive. Preserve cache write only after full chunk quality validation.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/backend.test.mjs -t "streams model token deltas"`

Expected: PASS.

### Task 3: Renderer Streaming UI

**Files:**
- Modify: `src/renderer/cloudClient.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/FloatingTranslateApp.tsx`
- Test: `src/renderer/App.test.tsx`
- Test: `src/renderer/FloatingTranslateApp.test.tsx`

- [ ] **Step 1: Write failing tests**

Update cloud stream event types to include `delta`. Add tests where SSE sends `delta` before `done`; assert the main translation result area shows partial text before final result. Add a floating-window test for the same behavior.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/renderer/App.test.tsx src/renderer/FloatingTranslateApp.test.tsx -t "streaming delta"`

Expected: FAIL because `delta` is ignored by the UI.

- [ ] **Step 3: Implement renderer delta appending**

Handle `delta` events by appending text per chunk index, updating `result.translatedText` while status remains `loading`. Do not show stale prior text after a new request starts.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/renderer/App.test.tsx src/renderer/FloatingTranslateApp.test.tsx -t "streaming delta"`

Expected: PASS.

### Task 4: Public Download Page Demo

**Files:**
- Modify: `server/public/download.html`
- Test: add or extend the nearest existing static/admin smoke test if practical.

- [ ] **Step 1: Write failing test or static assertion**

Assert the download page demo calls `/quick-translate/backend/api/translate/stream` and handles `delta` records instead of waiting for only full JSON.

- [ ] **Step 2: Verify RED**

Run the relevant Vitest/static assertion.

Expected: FAIL because the demo still uses the non-streaming request or debounced full response path.

- [ ] **Step 3: Implement demo streaming**

Switch demo translation fetch to the stream endpoint, append delta text into the demo result area, and keep a JSON fallback for browsers without `ReadableStream`.

- [ ] **Step 4: Verify GREEN**

Run the relevant Vitest/static assertion.

Expected: PASS.

### Task 5: Full Verification and Deployment

**Files:**
- No new production files beyond prior tasks.

- [ ] **Step 1: Run full local checks**

Run:
- `npm test`
- `npm run build`

Expected: all tests pass and build exits 0.

- [ ] **Step 2: Commit and push main**

Run:
- `git add ...`
- `git commit -m "Add token streaming translation output"`
- `git push origin main`

- [ ] **Step 3: Deploy and verify production**

Deploy to `/www/wwwroot/quick-translate` on `49.51.241.91`, restart `quick-translate`, call `/quick-translate/backend/api/translate/stream`, and confirm `delta` events arrive before `done`.
