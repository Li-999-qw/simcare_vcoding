# Tencent streaming speech implementation plan

**Goal:** Speak patient and senior physician replies as they appear in training, using Tencent Cloud TTS and case-appropriate voices.

**Architecture:** The authenticated training gateway owns credentials and sends each finished reply fragment to Tencent's streaming-text WebSocket API. The browser keeps the existing 300 ms text updates and schedules returned PCM chunks through Web Audio. The Uyghur patient remains text-only because the documented voices support Chinese and English.

**Files:** `backend/extensions/tencent_tts.py` signs and streams Tencent requests; `backend/main/app/portal_api.py` authorizes speech fragments; `backend/main/app/speech-output.js` queues browser playback; `requirements.txt` pins the WebSocket client; tests cover signing, voice selection, authorization, and segmentation.

## Tasks

- [x] Test and implement voice selection, signing, encrypted credential storage, and Tencent streaming client.
- [x] Test and implement authenticated speech route that accepts only assistant text in the learner's current attempt.
- [x] Test and implement browser sentence queue, cancellation, playback toggle, and PCM scheduling.
- [x] Verify Chinese and English routes and restart the local API.
- [x] Run live Tencent patient and senior probes and an authenticated training-gateway stream.
