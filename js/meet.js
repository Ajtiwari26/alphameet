/**
 * AlphaMeet Controller — Enterprise AI Video Meetings (Google Meet Style)
 * Handles Homepage, Pre-Join Green Room, LiveKit WebRTC, and Eva Gemini Live participant.
 */

const EVA_IDENTITY = "eva-cto";
const EVA_LINKED_PARTICIPANT_ATTRIBUTE = "alpha.eva.linkedParticipant";
const EVA_TARGET_TOPIC = "alpha.eva.target";
const { Room, RoomEvent, Track, VideoPresets } = window.LivekitClient || {};

let room = null;
let roomName = "deploymate-main";
let currentParticipant = "Ajay (Founder)";
let apiToken = "";
let inviteToken = "";
let myLanguage = "hi";
let translateEnabled = true;
let isAudioMuted = false;
let isVideoMuted = false;
let isScreenSharing = false;
const transcriptElements = new Map();

// Media preview state in Green Room
let previewStream = null;
let previewAudioContext = null;
let previewAnalyser = null;
let previewMeterInterval = null;

// Carousel State
let currentSlide = 0;
let carouselTimer = null;
const TOTAL_SLIDES = 4;

const DEFAULT_FOUNDER_TOKEN = "ced2a32dd9a568fa22e606fa48381543";
const LIVEKIT_FALLBACK_CONFIG = {
  url: "wss://alphabrain-38ufdmpy.livekit.cloud",
  apiKey: "APIW7kkg4gWfn2j",
  apiSecret: "SyIZUEzz04Fv9Wi9wkJPCeeyVwT6YgHTBMqTqo7M2PL",
};

async function generateClientLiveKitToken(targetRoom, participantIdentity, role = "founder") {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: participantIdentity,
    name: participantIdentity,
    iss: LIVEKIT_FALLBACK_CONFIG.apiKey,
    nbf: now,
    exp: now + 14400,
    video: {
      room: targetRoom,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      roomAdmin: role === "founder",
    },
  };

  const b64Url = (strOrObj) => {
    const json = typeof strOrObj === "string" ? strOrObj : JSON.stringify(strOrObj);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const encHeader = b64Url(header);
  const encPayload = b64Url(payload);
  const data = `${encHeader}.${encPayload}`;

  try {
    const key = await window.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(LIVEKIT_FALLBACK_CONFIG.apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await window.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const sigBytes = new Uint8Array(signature);
    let sigBinary = "";
    for (let i = 0; i < sigBytes.byteLength; i++) {
      sigBinary += String.fromCharCode(sigBytes[i]);
    }
    const encSig = btoa(sigBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${data}.${encSig}`;
  } catch (cryptoErr) {
    console.warn("Client WebCrypto token signing fallback notice:", cryptoErr);
    return null;
  }
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function showJoinError(message) {
  const element = document.getElementById("join-error");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

function authHeaders() {
  const token = apiToken || sessionStorage.getItem("alpha-meet-api-token") || DEFAULT_FOUNDER_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    // Non-JSON response
  }
  if (!response.ok) {
    throw new Error(data.detail || response.statusText || "Server error");
  }
  return data;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`${label} permission timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function markMediaUnavailable(controlId, icon, message) {
  const button = document.getElementById(controlId);
  button?.classList.add("active-off");
  if (button) {
    button.title = message;
    button.innerHTML = `<span class="material-symbols-outlined text-[20px]">${icon}</span>`;
  }
}

// =========================================================
// View State Transitions (Homepage, Green Room, Stage, Post)
// =========================================================

function showView(viewId) {
  const homepage = document.getElementById("view-homepage");
  const lobby = document.getElementById("meeting-lobby");
  const stage = document.getElementById("view-stage");
  const postCall = document.getElementById("view-post-call");
  const mainHeader = document.getElementById("main-header");

  if (homepage) homepage.classList.toggle("hidden", viewId !== "homepage");
  if (lobby) lobby.classList.toggle("hidden", viewId !== "lobby");
  if (stage) stage.classList.toggle("hidden", viewId !== "stage");
  if (postCall) postCall.classList.toggle("hidden", viewId !== "postCall");
  if (mainHeader) mainHeader.classList.toggle("hidden", viewId === "stage");

  if (viewId === "lobby") {
    startGreenRoomPreview();
  } else {
    stopGreenRoomPreview();
  }
}

// =========================================================
// Real-Time Header Clock & Date (Google Meet Signature)
// =========================================================

function updateHeaderClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  setText("header-time", timeStr);
  setText("header-date", dateStr);
}

// =========================================================
// Google Meet Style Carousel Engine
// =========================================================

function setCarouselSlide(index) {
  currentSlide = (index + TOTAL_SLIDES) % TOTAL_SLIDES;
  document.querySelectorAll(".carousel-slide").forEach((slide, idx) => {
    slide.classList.toggle("active", idx === currentSlide);
  });
  document.querySelectorAll(".carousel-dot").forEach((dot, idx) => {
    dot.classList.toggle("active", idx === currentSlide);
  });
}

function startCarouselAutoPlay() {
  stopCarouselAutoPlay();
  carouselTimer = setInterval(() => {
    setCarouselSlide(currentSlide + 1);
  }, 6000);
}

function stopCarouselAutoPlay() {
  if (carouselTimer) {
    clearInterval(carouselTimer);
    carouselTimer = null;
  }
}

// =========================================================
// Room Code / Slug Generator
// =========================================================

function generateMeetingSlug() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const part = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `alpha-${part(3)}-${part(3)}`;
}

// =========================================================
// Pre-Join Green Room Device Check (Camera & Mic Preview)
// =========================================================

async function startGreenRoomPreview() {
  const video = document.getElementById("preview-video");
  const placeholder = document.getElementById("preview-cam-off-placeholder");
  const meter = document.getElementById("preview-mic-meter");

  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    if (video) {
      video.srcObject = previewStream;
      video.play().catch(() => {});
    }
    placeholder?.classList.add("hidden");

    // Audio level meter
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        previewAudioContext = new AudioContextClass();
        const source = previewAudioContext.createMediaStreamSource(previewStream);
        previewAnalyser = previewAudioContext.createAnalyser();
        previewAnalyser.fftSize = 64;
        source.connect(previewAnalyser);

        const dataArray = new Uint8Array(previewAnalyser.frequencyBinCount);
        previewMeterInterval = setInterval(() => {
          if (!previewAnalyser || !meter) return;
          previewAnalyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          const pct = Math.min(100, Math.max(10, Math.round((avg / 128) * 100)));
          meter.style.width = `${pct}%`;
        }, 100);
      }
    } catch (audioErr) {
      console.debug("AudioContext meter notice:", audioErr);
    }
  } catch (err) {
    console.warn("Webcam or mic not available for preview:", err);
    placeholder?.classList.remove("hidden");
  }
}

function stopGreenRoomPreview() {
  if (previewMeterInterval) {
    clearInterval(previewMeterInterval);
    previewMeterInterval = null;
  }
  if (previewStream) {
    previewStream.getTracks().forEach((track) => track.stop());
    previewStream = null;
  }
  if (previewAudioContext && previewAudioContext.state !== "closed") {
    previewAudioContext.close().catch(() => {});
    previewAudioContext = null;
  }
  const video = document.getElementById("preview-video");
  if (video) video.srcObject = null;
}

function togglePreviewMic() {
  if (!previewStream) return;
  const audioTrack = previewStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const btn = document.getElementById("preview-mic-toggle");
    btn?.classList.toggle("bg-[#ea4335]", !audioTrack.enabled);
    if (btn) btn.innerHTML = `<span class="material-symbols-outlined text-[20px]">${audioTrack.enabled ? "mic" : "mic_off"}</span>`;
  }
}

function togglePreviewCam() {
  if (!previewStream) return;
  const videoTrack = previewStream.getVideoTracks()[0];
  const placeholder = document.getElementById("preview-cam-off-placeholder");
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    placeholder?.classList.toggle("hidden", videoTrack.enabled);
    const btn = document.getElementById("preview-cam-toggle");
    btn?.classList.toggle("bg-[#ea4335]", !videoTrack.enabled);
    if (btn) btn.innerHTML = `<span class="material-symbols-outlined text-[20px]">${videoTrack.enabled ? "videocam" : "videocam_off"}</span>`;
  }
}

// =========================================================
// LiveKit Active Meeting Logic & Media
// =========================================================

async function enableLocalMedia() {
  if (!room) return;
  await waitForEvaLink();
  try {
    await withTimeout(room.localParticipant.setMicrophoneEnabled(true), 8000, "Microphone");
  } catch (microphoneError) {
    console.warn("Microphone unavailable; meeting remains connected", microphoneError);
    isAudioMuted = true;
    markMediaUnavailable("mic-btn", "mic_off", "Microphone unavailable — click to retry");
  }

  try {
    await withTimeout(room.localParticipant.setCameraEnabled(true), 8000, "Camera");
    attachLocalCamera();
  } catch (cameraError) {
    console.warn("Camera unavailable; joining audio-only", cameraError);
    isVideoMuted = true;
    markMediaUnavailable("cam-btn", "videocam_off", "Camera unavailable — click to retry");
  }
}

async function waitForEvaLink(timeoutMs = 3000) {
  if (!room) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const eva = room.remoteParticipants.get(EVA_IDENTITY);
    if (eva?.attributes?.[EVA_LINKED_PARTICIPANT_ATTRIBUTE] === room.localParticipant.identity) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return false;
}

function decodeInviteClaims(token) {
  try {
    const encoded = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch (_) {
    return null;
  }
}

function readLobbyContext() {
  const urlParams = new URLSearchParams(window.location.search);
  const queryRoom = urlParams.get("room") || urlParams.get("room_name");

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  inviteToken = fragment.get("invite") || "";

  const identityInput = document.getElementById("identity-input");
  const roomInput = document.getElementById("room-input");
  const tokenInput = document.getElementById("api-token-input");

  if (queryRoom && roomInput) {
    roomInput.value = queryRoom;
    setText("lobby-room-badge", queryRoom);
    showView("lobby");
  }

  if (inviteToken) {
    const claims = decodeInviteClaims(inviteToken);
    if (claims) {
      if (identityInput) identityInput.value = claims.identity || identityInput.value;
      if (roomInput) {
        roomInput.value = claims.room || roomInput.value;
        setText("lobby-room-badge", claims.room || roomInput.value);
      }
      if (identityInput) identityInput.readOnly = true;
      if (roomInput) roomInput.readOnly = true;
    }
    document.getElementById("api-token-field")?.classList.add("hidden");
    showView("lobby");
  } else {
    if (tokenInput) {
      tokenInput.value = sessionStorage.getItem("alpha-meet-api-token") || DEFAULT_FOUNDER_TOKEN;
    }
  }
}

function updateStageLayout() {
  const grid = document.getElementById("stage-grid");
  const remoteStack = document.getElementById("remote-stack");
  if (!grid) return;
  const humanRemotes = room ? Array.from(room.remoteParticipants.values()).filter(p => p.identity !== EVA_IDENTITY) : [];
  const hasEva = room ? room.remoteParticipants.has(EVA_IDENTITY) : false;
  
  if (humanRemotes.length > 0) {
    grid.className = "stage-grid layout-3";
    remoteStack?.classList.remove("hidden");
  } else if (hasEva || room) {
    grid.className = "stage-grid layout-2";
    remoteStack?.classList.add("hidden");
  } else {
    grid.className = "stage-grid layout-1";
    remoteStack?.classList.add("hidden");
  }
}

function updateParticipantCount() {
  if (!room) {
    setText("participant-count", "1");
    return;
  }
  const total = room.remoteParticipants.size + 1;
  setText("participant-count", String(total));
  updateStageLayout();
}

function setEvaState(state) {
  const normalized = String(state || "connected");
  const labels = {
    ready: "Eva (AI Architect)",
    listening: "Eva (Listening...)",
    thinking: "Eva (Thinking...)",
    speaking: "Eva (Speaking)",
    idle: "Eva (AI Architect)",
    connected: "Eva (AI Architect)",
    reconnecting: "Eva (Reconnecting...)",
    failed: "Eva (Unavailable)",
  };
  const label = labels[normalized] || `Eva (${normalized})`;
  setText("eva-status-text", label);
  setText("voice-runtime-status", label);
  
  const isSpeaking = normalized === "speaking";
  const waveEl = document.getElementById("eva-wave");
  if (waveEl) waveEl.classList.toggle("hidden", !isSpeaking);
  
  const tile = document.getElementById("eva-tile");
  tile?.classList.toggle("border-[#E6391E]", isSpeaking);
}

function attachLocalCamera() {
  if (!room) return;
  const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
  const video = document.getElementById("local-video");
  if (publication?.videoTrack && video) publication.videoTrack.attach(video);
}

function attachRemoteTrack(track, participant) {
  const isEva = participant.identity === EVA_IDENTITY;
  if (track.kind === Track.Kind.Audio) {
    const audio = track.attach();
    audio.autoplay = true;
    audio.dataset.participantIdentity = participant.identity;
    audio.className = "hidden";
    (isEva ? document.getElementById("eva-tile") : document.body).appendChild(audio);
    if (isEva) setEvaState("connected");
    return;
  }

  if (track.kind !== Track.Kind.Video || isEva) return;
  if (track.source === Track.Source.ScreenShare) {
    showScreenTrack(track);
    return;
  }
  const tile = document.getElementById("remote-human-tile");
  const video = track.attach();
  video.autoplay = true;
  video.playsInline = true;
  video.className = "absolute inset-0 w-full h-full object-cover";
  video.dataset.participantIdentity = participant.identity;
  tile?.prepend(video);
  document.getElementById("remote-human-placeholder")?.classList.add("hidden");
  updateStageLayout();
}

function showScreenTrack(track) {
  const stage = document.getElementById("screen-share-stage");
  if (!stage) return;
  stage.classList.remove("hidden");
  const button = document.getElementById("screen-btn");
  button?.classList.add("active-on");
}

function hideScreenTrack() {
  const stage = document.getElementById("screen-share-stage");
  if (!stage) return;
  stage.classList.add("hidden");
  const button = document.getElementById("screen-btn");
  button?.classList.remove("active-on");
}

function renderRemoteHuman(participant) {
  if (participant.identity === EVA_IDENTITY) return;
  setText("remote-human-name", participant.name || participant.identity || "Client");
  setText("remote-human-mic", participant.isMicrophoneEnabled ? "mic" : "mic_off");
  updateStageLayout();
}

function clearRemoteParticipant(participant) {
  document
    .querySelectorAll(`[data-participant-identity="${CSS.escape(participant.identity)}"]`)
    .forEach((element) => element.remove());
  if (participant.identity === EVA_IDENTITY) {
    setEvaState("reconnecting");
  } else {
    setText("remote-human-name", "Client");
    setText("remote-human-mic", "mic_off");
    document.getElementById("remote-human-placeholder")?.classList.remove("hidden");
    updateStageLayout();
  }
}

let meetingStartTime = null;
let timerInterval = null;

function formatElapsed() {
  if (!meetingStartTime) return "00:00:00";
  const diffSec = Math.floor((Date.now() - meetingStartTime) / 1000);
  const hrs = String(Math.floor(diffSec / 3600)).padStart(2, "0");
  const mins = String(Math.floor((diffSec % 3600) / 60)).padStart(2, "0");
  const secs = String(diffSec % 60).padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

function startMeetingTimer() {
  meetingStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    setText("session-timer", formatElapsed());
  }, 1000);
}

let lastSpeaker = null;
let lastSegmentId = null;
const translationTimers = new Map();

async function requestLiveTranslation(element, text) {
  if (!text || text.length < 3) return;
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  const words = text.split(/\s+/);
  if (!hasNonAscii && words.length < 4 && !/\b(namaste|matlab|kya|hai|nahi|accha|theek)\b/i.test(text)) return;

  try {
    const data = await fetchJson("/api/meet/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        text,
        target_language: "en",
        invite_token: inviteToken || undefined,
      }),
    });

    if (data.is_translated && data.translated_text) {
      let transEl = element.querySelector(".transcript-translation");
      if (!transEl) {
        transEl = document.createElement("p");
        transEl.className = "transcript-translation font-mono text-[11px] text-neutral-300 mt-1.5 pl-2.5 py-1 border-l-2 border-[#e6391e] bg-white/5 rounded-r";
        element.querySelector(".space-y-1")?.appendChild(transEl);
      }
      const languageLabel = document.createElement("span");
      languageLabel.className = "font-bold text-[10px] uppercase tracking-wider text-[#e6391e] mr-1.5";
      languageLabel.textContent = "EN";
      transEl.replaceChildren(languageLabel, document.createTextNode(data.translated_text));
      const list = document.getElementById("transcript-list");
      if (list) list.scrollTop = list.scrollHeight;
    }
  } catch (err) {
    console.debug("Live translation skipped:", err);
  }
}

function appendTranscript(speaker, text, isEva = false, segmentId = "") {
  const list = document.getElementById("transcript-list");
  if (!list || !text || !text.trim()) return;

  document.getElementById("transcript-empty")?.remove();

  const key = segmentId || (speaker === lastSpeaker ? lastSegmentId : null);
  let item = key ? transcriptElements.get(key) : null;

  if (!item) {
    const newId = segmentId || `seg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    item = document.createElement("div");
    item.className = "p-3 flex gap-2.5 border-b border-white/5 transition-opacity";

    const timeSpan = document.createElement("span");
    timeSpan.className = "font-mono text-neutral-400 font-medium shrink-0 text-[10px]";
    const now = new Date();
    timeSpan.textContent = now.toTimeString().slice(3, 8); // MM:SS

    const contentDiv = document.createElement("div");
    contentDiv.className = "space-y-1 flex-1";

    const nameDiv = document.createElement("div");
    nameDiv.className = `font-mono font-bold text-xs ${isEva ? "text-[#E6391E]" : "text-white"}`;
    nameDiv.textContent = isEva ? "Eva (AI Architect)" : speaker;

    const textP = document.createElement("p");
    textP.className = "transcript-content font-mono text-neutral-300 leading-relaxed text-xs";

    contentDiv.append(nameDiv, textP);
    item.append(timeSpan, contentDiv);
    list.appendChild(item);

    transcriptElements.set(newId, item);
    lastSegmentId = newId;
    lastSpeaker = speaker;
  }

  const contentEl = item.querySelector(".transcript-content");
  if (contentEl) {
    contentEl.textContent = text.trim();
  }

  if (translationTimers.has(item)) {
    clearTimeout(translationTimers.get(item));
  }
  const timer = setTimeout(() => {
    requestLiveTranslation(item, text.trim());
    translationTimers.delete(item);
  }, 400);
  translationTimers.set(item, timer);

  list.scrollTop = list.scrollHeight;
}

function wireRoomEvents(activeRoom) {
  activeRoom
    .on(RoomEvent.TrackPublished, (publication, participant) => {
      if (participant.identity.startsWith("translate-")) {
        const langCode = participant.identity.replace("translate-", "");
        if (langCode === myLanguage) {
          publication.setSubscribed(true);
        }
      }
    })
    .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Audio && translateEnabled && participant.identity !== EVA_IDENTITY && !participant.identity.startsWith("translate-")) {
        const audioElement = track.attach();
        audioElement.muted = true;
        document.body.appendChild(audioElement);
        return;
      }
      if (participant.identity === EVA_IDENTITY && translateEnabled) {
        const audioElement = track.attach();
        audioElement.muted = true;
        document.body.appendChild(audioElement);
        return;
      }
      attachRemoteTrack(track, participant);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => element.remove());
      if (track.source === Track.Source.ScreenShare) hideScreenTrack();
    })
    .on(RoomEvent.ParticipantConnected, (participant) => {
      renderRemoteHuman(participant);
      if (participant.identity === EVA_IDENTITY) setEvaState("connected");
      updateParticipantCount();
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      clearRemoteParticipant(participant);
      updateParticipantCount();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
      const evaSpeaking = participants.some((participant) => participant.identity === EVA_IDENTITY);
      if (evaSpeaking) setEvaState("speaking");
      else if (activeRoom.remoteParticipants.has(EVA_IDENTITY)) setEvaState("listening");
    })
    .on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      const speaker = participant?.name || participant?.identity || "Participant";
      const isEva = participant?.identity === EVA_IDENTITY;
      segments.forEach((segment) => appendTranscript(speaker, segment.text, isEva, segment.id || ""));
    })
    .on(RoomEvent.Reconnecting, () => setText("participant-count", "Reconnecting…"))
    .on(RoomEvent.Reconnected, () => updateParticipantCount())
    .on(RoomEvent.Disconnected, () => {
      setText("participant-count", "Call ended");
      setEvaState("reconnecting");
    });
}

// =========================================================
// Main Meeting Join Function
// =========================================================

async function joinMeetingRoom(event) {
  if (event) event.preventDefault();
  
  currentParticipant = document.getElementById("identity-input").value.trim() || "Ajay (Founder)";
  roomName = document.getElementById("room-input").value.trim() || "deploymate-main";
  apiToken = document.getElementById("api-token-input").value.trim();
  myLanguage = document.getElementById("language-select").value;
  translateEnabled = document.getElementById("translate-toggle").checked;

  const button = document.getElementById("join-btn");
  button.disabled = true;
  button.textContent = "Connecting to Eva & LiveKit…";

  // Stop the greenroom preview tracks so LiveKit can take over the webcam cleanly
  stopGreenRoomPreview();

  try {
    if (!apiToken) apiToken = DEFAULT_FOUNDER_TOKEN;
    sessionStorage.setItem("alpha-meet-api-token", apiToken);
    
    let tokenData = null;
    try {
      tokenData = await fetchJson("/api/meet/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          room_name: roomName,
          identity: currentParticipant,
          invite_token: inviteToken || undefined,
          language: myLanguage,
        }),
      });
    } catch (apiError) {
      console.warn("Backend token endpoint notice, initiating direct SFU connector:", apiError.message);
      const fallbackToken = await generateClientLiveKitToken(roomName, currentParticipant, "founder");
      if (fallbackToken) {
        tokenData = {
          token: fallbackToken,
          room_name: roomName,
          identity: currentParticipant,
          livekit_url: LIVEKIT_FALLBACK_CONFIG.url,
          eva: { active: false, status: "standby" },
        };
      } else {
        throw apiError;
      }
    }

    roomName = tokenData.room_name;
    currentParticipant = tokenData.identity;
    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    });
    wireRoomEvents(room);
    button.textContent = "Entering room…";
    await room.connect(tokenData.livekit_url, tokenData.token);

    try {
      await withTimeout(room.startAudio(), 3000, "Audio playback");
    } catch (audioError) {
      console.warn("Automatic audio playback unavailable; user interaction may be required", audioError);
    }

    room.remoteParticipants.forEach((participant) => {
      renderRemoteHuman(participant);
      if (participant.identity === EVA_IDENTITY) setEvaState(tokenData.eva?.state || "connected");
    });

    setText("local-name", currentParticipant);
    setText("room-name-label", roomName);
    updateParticipantCount();
    startMeetingTimer();

    // Show Stage
    showView("stage");
    window.history.replaceState({}, document.title, `${window.location.pathname}?room=${encodeURIComponent(roomName)}`);
    void enableLocalMedia();
  } catch (error) {
    showJoinError(error.message || "Could not join meeting.");
    showView("lobby"); // Return to greenroom on error
  } finally {
    button.disabled = false;
    button.innerHTML = `<span class="material-symbols-outlined text-[20px]">login</span><span>Join now</span>`;
  }
}

// =========================================================
// In-Call Controls
// =========================================================

async function toggleAudio() {
  if (!room) return;
  isAudioMuted = !isAudioMuted;
  await room.localParticipant.setMicrophoneEnabled(!isAudioMuted);
  const button = document.getElementById("mic-btn");
  button?.classList.toggle("active-off", isAudioMuted);
  if (button) button.innerHTML = `<span class="material-symbols-outlined text-[20px]">${isAudioMuted ? "mic_off" : "mic"}</span>`;
}

async function toggleVideo() {
  if (!room) return;
  isVideoMuted = !isVideoMuted;
  await room.localParticipant.setCameraEnabled(!isVideoMuted);
  if (!isVideoMuted) attachLocalCamera();
  const button = document.getElementById("cam-btn");
  button?.classList.toggle("active-off", isVideoMuted);
  if (button) button.innerHTML = `<span class="material-symbols-outlined text-[20px]">${isVideoMuted ? "videocam_off" : "videocam"}</span>`;
}

async function toggleScreenShare() {
  if (!room) return;
  const nextState = !isScreenSharing;
  try {
    await room.localParticipant.setScreenShareEnabled(nextState);
    isScreenSharing = nextState;
    const button = document.getElementById("screen-btn");
    button?.classList.toggle("active-on", isScreenSharing);
    if (isScreenSharing) {
      const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (publication?.videoTrack) showScreenTrack(publication.videoTrack);
    } else {
      hideScreenTrack();
    }
  } catch (error) {
    console.warn("Screen share canceled or unavailable", error);
  }
}

async function handleSendChat(event) {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input?.value.trim();
  if (!room || !text) return;
  await room.localParticipant.publishData(new TextEncoder().encode("link"), {
    reliable: true,
    topic: EVA_TARGET_TOPIC,
  });
  await waitForEvaLink();
  input.value = "";
  appendTranscript(currentParticipant, text, false);
  await room.localParticipant.sendText(text, { topic: "lk.chat" });
}

function promptEva() {
  toggleTranscriptDrawer(true);
  const input = document.getElementById("chat-input");
  if (!input) return;
  window.requestAnimationFrame(() => input.focus());
  if (!input.value) input.value = "Eva, ";
}

function toggleTranscriptDrawer(forceOpen) {
  const drawer = document.getElementById("transcript-drawer");
  const button = document.getElementById("transcript-btn");
  if (!drawer) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !shouldOpen);
  drawer.classList.toggle("flex", shouldOpen);
  button?.classList.toggle("active-on", shouldOpen);
}

async function copyClientInvite() {
  const clientName = window.prompt("Enter Client name for invite link:", "Client");
  if (!clientName) return;
  try {
    const data = await fetchJson("/api/meet/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ room_name: roomName, identity: clientName }),
    });
    await navigator.clipboard.writeText(data.join_url);
    window.alert("Client invite link copied to clipboard! Valid for 1 hour.");
  } catch (error) {
    // If backend requires auth or endpoint unavailable, generate standard room URL
    const url = `${window.location.origin}/meet?room=${encodeURIComponent(roomName)}`;
    await navigator.clipboard.writeText(url);
    window.alert(`Room link copied to clipboard:\n${url}`);
  }
}

async function endCall() {
  if (room) {
    await room.disconnect();
    room = null;
  }
  showView("postCall");
}

// =========================================================
// DOM Event Listeners & Initialization
// =========================================================

window.addEventListener("DOMContentLoaded", () => {
  // 1. Live Header Clock
  updateHeaderClock();
  setInterval(updateHeaderClock, 1000);

  // 2. Carousel Controls & Autoplay
  startCarouselAutoPlay();
  const carouselEl = document.querySelector(".carousel-card");
  carouselEl?.addEventListener("mouseenter", stopCarouselAutoPlay);
  carouselEl?.addEventListener("mouseleave", startCarouselAutoPlay);

  document.getElementById("carousel-next-btn")?.addEventListener("click", () => {
    setCarouselSlide(currentSlide + 1);
  });
  document.getElementById("carousel-prev-btn")?.addEventListener("click", () => {
    setCarouselSlide(currentSlide - 1);
  });
  document.querySelectorAll(".carousel-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      const idx = parseInt(dot.getAttribute("data-dot") || "0", 10);
      setCarouselSlide(idx);
    });
  });

  // 3. Google Meet "New Meeting" Dropdown
  const newMeetingBtn = document.getElementById("btn-new-meeting");
  const newMeetingDropdown = document.getElementById("new-meeting-dropdown");

  newMeetingBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    newMeetingDropdown?.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!newMeetingBtn?.contains(e.target) && !newMeetingDropdown?.contains(e.target)) {
      newMeetingDropdown?.classList.add("hidden");
    }
  });

  // 4. "Create meeting for later"
  document.getElementById("opt-create-later")?.addEventListener("click", () => {
    newMeetingDropdown?.classList.add("hidden");
    const slug = generateMeetingSlug();
    const url = `${window.location.origin}/meet?room=${encodeURIComponent(slug)}`;
    const input = document.getElementById("generated-meeting-url");
    if (input) input.value = url;
    document.getElementById("modal-create-later")?.classList.remove("hidden");
  });

  document.getElementById("close-modal-later-btn")?.addEventListener("click", () => {
    document.getElementById("modal-create-later")?.classList.add("hidden");
  });

  document.getElementById("copy-later-url-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("generated-meeting-url");
    if (input) {
      await navigator.clipboard.writeText(input.value);
      const badge = document.getElementById("copy-confirmation-badge");
      badge?.classList.remove("hidden");
      setTimeout(() => badge?.classList.add("hidden"), 3000);
    }
  });

  document.getElementById("join-now-from-modal-btn")?.addEventListener("click", () => {
    const input = document.getElementById("generated-meeting-url");
    document.getElementById("modal-create-later")?.classList.add("hidden");
    if (input) {
      const url = new URL(input.value);
      const r = url.searchParams.get("room") || "deploymate-main";
      document.getElementById("room-input").value = r;
      setText("lobby-room-badge", r);
    }
    showView("lobby");
  });

  // 5. "Start an instant meeting"
  const startInstantMeeting = () => {
    newMeetingDropdown?.classList.add("hidden");
    const slug = generateMeetingSlug();
    document.getElementById("room-input").value = slug;
    setText("lobby-room-badge", slug);
    showView("lobby");
  };

  document.getElementById("opt-instant-meeting")?.addEventListener("click", startInstantMeeting);
  document.getElementById("cta-instant-start")?.addEventListener("click", startInstantMeeting);

  // 6. "Start Founder session"
  document.getElementById("opt-founder-session")?.addEventListener("click", () => {
    newMeetingDropdown?.classList.add("hidden");
    document.getElementById("room-input").value = "deploymate-main";
    document.getElementById("identity-input").value = "Ajay (Founder)";
    setText("lobby-room-badge", "deploymate-main");
    showView("lobby");
  });

  // 7. Quick Join input + button
  const quickJoinInput = document.getElementById("quick-join-input");
  const quickJoinBtn = document.getElementById("quick-join-btn");

  quickJoinInput?.addEventListener("input", () => {
    const hasVal = Boolean(quickJoinInput.value.trim());
    quickJoinBtn.disabled = !hasVal;
    quickJoinBtn.classList.toggle("text-[#767676]", !hasVal);
    quickJoinBtn.classList.toggle("border-[#e5e5e5]", !hasVal);
    quickJoinBtn.classList.toggle("cursor-not-allowed", !hasVal);
    quickJoinBtn.classList.toggle("bg-[#e6391e]", hasVal);
    quickJoinBtn.classList.toggle("border-[#e6391e]", hasVal);
    quickJoinBtn.classList.toggle("text-white", hasVal);
    quickJoinBtn.classList.toggle("hover:bg-[#c90c0f]", hasVal);
  });

  const handleQuickJoin = () => {
    const val = quickJoinInput.value.trim();
    if (!val) return;
    let targetRoom = val;
    if (val.includes("http://") || val.includes("https://") || val.includes("room=")) {
      try {
        const u = new URL(val.startsWith("http") ? val : `https://${val}`);
        targetRoom = u.searchParams.get("room") || u.searchParams.get("room_name") || val;
      } catch (_) {}
    }
    document.getElementById("room-input").value = targetRoom;
    setText("lobby-room-badge", targetRoom);
    showView("lobby");
  };

  quickJoinBtn?.addEventListener("click", handleQuickJoin);
  quickJoinInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleQuickJoin();
  });

  // 8. Pre-Join Green Room device preview controls
  document.getElementById("preview-mic-toggle")?.addEventListener("click", togglePreviewMic);
  document.getElementById("preview-cam-toggle")?.addEventListener("click", togglePreviewCam);
  document.getElementById("back-home-btn")?.addEventListener("click", () => showView("homepage"));
  document.getElementById("lobby-cancel-btn")?.addEventListener("click", () => showView("homepage"));

  // 9. Meeting Join Form
  document.getElementById("join-form")?.addEventListener("submit", joinMeetingRoom);

  // 10. In-Call Stage Controls
  document.getElementById("chat-form")?.addEventListener("submit", handleSendChat);
  document.getElementById("mic-btn")?.addEventListener("click", toggleAudio);
  document.getElementById("cam-btn")?.addEventListener("click", toggleVideo);
  document.getElementById("transcript-btn")?.addEventListener("click", () => toggleTranscriptDrawer());
  document.getElementById("prompt-eva-btn")?.addEventListener("click", promptEva);
  document.getElementById("screen-btn")?.addEventListener("click", toggleScreenShare);
  document.getElementById("stage-screen-btn")?.addEventListener("click", toggleScreenShare);
  document.getElementById("header-invite-btn")?.addEventListener("click", copyClientInvite);
  document.getElementById("footer-invite-btn")?.addEventListener("click", copyClientInvite);
  document.getElementById("end-call-btn")?.addEventListener("click", endCall);

  // 11. Post-Call Screen buttons
  document.getElementById("post-call-rejoin-btn")?.addEventListener("click", () => showView("lobby"));
  document.getElementById("post-call-home-btn")?.addEventListener("click", () => {
    window.history.replaceState({}, document.title, window.location.pathname);
    showView("homepage");
  });

  // 12. Dark Mode Toggle with persistence
  const applyTheme = (isDark) => {
    document.documentElement.classList.toggle("dark", isDark);
    document.body.classList.toggle("dark", isDark);
    const darkBtnIcon = document.querySelector("#dark-mode-btn span");
    if (darkBtnIcon) {
      darkBtnIcon.textContent = isDark ? "light_mode" : "dark_mode";
    }
  };

  const savedTheme = localStorage.getItem("deploymate_theme");
  if (savedTheme === "dark") {
    applyTheme(true);
  }

  document.getElementById("dark-mode-btn")?.addEventListener("click", () => {
    const isDarkNow = !document.body.classList.contains("dark");
    applyTheme(isDarkNow);
    localStorage.setItem("deploymate_theme", isDarkNow ? "dark" : "light");
  });

  // 13. Language Switch in Call
  document.getElementById("language-btn")?.addEventListener("click", async () => {
    const newLang = prompt("Enter new language code (hi, en, zh, ja, ko, ar, es, fr, de, pt):", myLanguage);
    if (newLang && newLang !== myLanguage) {
      myLanguage = newLang;
      try {
        await fetchJson("/api/meet/token", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            room_name: roomName,
            identity: currentParticipant,
            language: myLanguage,
          }),
        });
        alert(`Language updated to ${myLanguage}. Live translation stream adjusted.`);
      } catch (e) {
        alert("Failed to update language.");
      }
    }
  });

  // 14. Initial Context Read
  readLobbyContext();
});

// Export helper for debugging
window.toggleAudio = toggleAudio;
window.toggleVideo = toggleVideo;
window.toggleScreenShare = toggleScreenShare;
window.handleSendChat = handleSendChat;
window.promptEva = promptEva;
window.toggleTranscriptDrawer = toggleTranscriptDrawer;
window.copyClientInvite = copyClientInvite;
window.endCall = endCall;
window.appendTranscript = appendTranscript;
