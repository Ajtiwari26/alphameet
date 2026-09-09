/** Real LiveKit meeting controller: founder + client + Eva Gemini Live participant. */

const EVA_IDENTITY = "eva-cto";
const EVA_LINKED_PARTICIPANT_ATTRIBUTE = "alpha.eva.linkedParticipant";
const EVA_TARGET_TOPIC = "alpha.eva.target";
const { Room, RoomEvent, Track, VideoPresets } = window.LivekitClient || {};

let room = null;
let roomName = "deploymate-main";
let currentParticipant = "Ajay (Founder)";
let apiToken = "";
let inviteToken = "";
let isAudioMuted = false;
let isVideoMuted = false;
let isScreenSharing = false;
const transcriptElements = new Map();

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
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
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
  button?.classList.add("bg-rose-500/80");
  if (button) {
    button.title = message;
    button.innerHTML = `<span class="material-symbols-outlined text-[20px]">${icon}</span>`;
  }
}

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
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  inviteToken = fragment.get("invite") || "";
  const identityInput = document.getElementById("identity-input");
  const roomInput = document.getElementById("room-input");
  const tokenInput = document.getElementById("api-token-input");

  if (inviteToken) {
    const claims = decodeInviteClaims(inviteToken);
    if (claims) {
      identityInput.value = claims.identity || identityInput.value;
      roomInput.value = claims.room || roomInput.value;
      identityInput.readOnly = true;
      roomInput.readOnly = true;
    }
    document.getElementById("api-token-field")?.classList.add("hidden");
  } else {
    tokenInput.value = sessionStorage.getItem("alpha-meet-api-token") || "";
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
  setInterval(() => {
    setText("session-timer", formatElapsed());
  }, 1000);
}

let lastSpeaker = null;
let lastSegmentId = null;
const translationTimers = new Map();

async function requestLiveTranslation(element, text) {
  if (!text || text.length < 3) return;
  // If it's already purely simple english with no non-ASCII, skip
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
        transEl.className = "transcript-translation font-mono text-[11px] text-neutral-600 dark:text-neutral-300 mt-1.5 pl-2.5 py-1 border-l-2 border-black/60 dark:border-white/60 bg-black/5 dark:bg-white/5 rounded-r";
        element.querySelector(".space-y-1")?.appendChild(transEl);
      }
      const languageLabel = document.createElement("span");
      languageLabel.className = "font-bold text-[10px] uppercase tracking-wider text-black dark:text-white mr-1.5 opacity-75";
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

  // Remove initial empty placeholder if present
  document.getElementById("transcript-empty")?.remove();

  const key = segmentId || (speaker === lastSpeaker ? lastSegmentId : null);
  let item = key ? transcriptElements.get(key) : null;

  if (!item) {
    const newId = segmentId || `seg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    item = document.createElement("div");
    item.className = "p-4 flex gap-3 border-b border-black/10 transition-opacity";

    const timeSpan = document.createElement("span");
    timeSpan.className = "font-mono text-neutral-400 font-medium shrink-0 text-xs";
    const now = new Date();
    timeSpan.textContent = now.toTimeString().slice(3, 8); // MM:SS

    const contentDiv = document.createElement("div");
    contentDiv.className = "space-y-1 flex-1";

    const nameDiv = document.createElement("div");
    nameDiv.className = `font-mono font-bold text-xs ${isEva ? "text-[#E6391E]" : "text-black"}`;
    nameDiv.textContent = isEva ? "Eva (DeployMate CTO)" : speaker;

    const textP = document.createElement("p");
    textP.className = "transcript-content font-mono text-neutral-800 leading-relaxed text-xs";

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

  // Trigger debounced live English translation
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
      // Subscribe to my translated track
      if (participant.identity.startsWith("translate-")) {
        const langCode = participant.identity.replace("translate-", "");
        if (langCode === myLanguage) {
          publication.setSubscribed(true);
        }
      }
    })
    .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      // Mute raw audio if we are translating their language
      if (track.kind === Track.Kind.Audio && translateEnabled && participant.identity !== EVA_IDENTITY && !participant.identity.startsWith("translate-")) {
          // If the backend had sent participantLanguages mapping, we'd check their language.
          // For now, if translation is enabled, we mute ALL other human audio tracks.
          // They will come through the translate track!
          const audioElement = track.attach();
          audioElement.muted = true;
          document.body.appendChild(audioElement); // Keep attached for LiveKit but muted
          return;
      }
      if (participant.identity === EVA_IDENTITY && translateEnabled) {
          // If translation is enabled, we ALSO mute Eva's raw English audio track, 
          // because it will come through our language's translate track!
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

async function joinMeetingRoom(event) {
  event.preventDefault();
  currentParticipant = document.getElementById("identity-input").value.trim();
  roomName = document.getElementById("room-input").value.trim();
  apiToken = document.getElementById("api-token-input").value.trim();
  myLanguage = document.getElementById("language-select").value;
  translateEnabled = document.getElementById("translate-toggle").checked;
  
  if (!inviteToken && !apiToken) {
    showJoinError("Alpha Brain access token is required.");
    return;
  }

  const button = document.getElementById("join-btn");
  button.disabled = true;
  button.textContent = "Starting Eva…";
  try {
    if (apiToken) sessionStorage.setItem("alpha-meet-api-token", apiToken);
    const data = await fetchJson("/api/meet/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        room_name: roomName,
        identity: currentParticipant,
        invite_token: inviteToken || undefined,
        language: myLanguage,
      }),
    });

    roomName = data.room_name;
    currentParticipant = data.identity;
    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    });
    wireRoomEvents(room);
    button.textContent = "Connecting room…";
    await room.connect(data.livekit_url, data.token);
    try {
      await withTimeout(room.startAudio(), 3000, "Audio playback");
    } catch (audioError) {
      console.warn("Automatic audio playback unavailable; user interaction may be required", audioError);
    }
    room.remoteParticipants.forEach((participant) => {
      renderRemoteHuman(participant);
      if (participant.identity === EVA_IDENTITY) setEvaState(data.eva?.state || "connected");
    });
    setText("local-name", currentParticipant);
    setText("room-name-label", roomName);
    updateParticipantCount();
    startMeetingTimer();
    document.getElementById("meeting-lobby").classList.add("hidden");
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    void enableLocalMedia();
  } catch (error) {
    showJoinError(error.message || "Could not join meeting.");
  } finally {
    button.disabled = false;
    button.textContent = "Join meeting";
  }
}

async function toggleAudio() {
  if (!room) return;
  isAudioMuted = !isAudioMuted;
  await room.localParticipant.setMicrophoneEnabled(!isAudioMuted);
  const button = document.getElementById("mic-btn");
  button?.classList.toggle("bg-rose-500/80", isAudioMuted);
  if (button) button.innerHTML = `<span class="material-symbols-outlined text-[20px]">${isAudioMuted ? "mic_off" : "mic"}</span>`;
}

async function toggleVideo() {
  if (!room) return;
  isVideoMuted = !isVideoMuted;
  await room.localParticipant.setCameraEnabled(!isVideoMuted);
  if (!isVideoMuted) attachLocalCamera();
  const button = document.getElementById("cam-btn");
  button?.classList.toggle("bg-rose-500/80", isVideoMuted);
  if (button) button.innerHTML = `<span class="material-symbols-outlined text-[20px]">${isVideoMuted ? "videocam_off" : "videocam"}</span>`;
}

async function toggleScreenShare() {
  if (!room) return;
  const nextState = !isScreenSharing;
  try {
    await room.localParticipant.setScreenShareEnabled(nextState);
    isScreenSharing = nextState;
    const button = document.getElementById("screen-btn");
    button?.classList.toggle("bg-cyan-500/30", isScreenSharing);
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
  if (window.innerWidth < 768) toggleTranscriptDrawer(true);
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
  button?.setAttribute("aria-expanded", String(shouldOpen));
}

async function copyClientInvite() {
  if (!apiToken) {
    window.alert("Only founder/admin can create client invite links.");
    return;
  }
  const identity = window.prompt("Client name", "Client");
  if (!identity) return;
  try {
    const data = await fetchJson("/api/meet/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ room_name: roomName, identity }),
    });
    await navigator.clipboard.writeText(data.join_url);
    window.alert("Client link copied. It expires in one hour.");
  } catch (error) {
    window.alert(error.message || "Could not create invite.");
  }
}

async function endCall() {
  if (room) await room.disconnect();
  window.location.reload();
}

window.toggleAudio = toggleAudio;
window.toggleVideo = toggleVideo;
window.toggleScreenShare = toggleScreenShare;
window.handleSendChat = handleSendChat;
window.promptEva = promptEva;
window.toggleTranscriptDrawer = toggleTranscriptDrawer;
window.copyClientInvite = copyClientInvite;
window.endCall = endCall;
window.appendTranscript = appendTranscript;

window.addEventListener("DOMContentLoaded", () => {
  readLobbyContext();
  document.getElementById("join-form")?.addEventListener("submit", joinMeetingRoom);
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
  document.getElementById("dark-mode-btn")?.addEventListener("click", () => {
    document.body.classList.toggle("dark");
  });
});

// ---- Language Switch ----
document.addEventListener("DOMContentLoaded", () => {
  const langBtn = document.getElementById("language-btn");
  if (langBtn) {
    langBtn.addEventListener("click", async () => {
      const newLang = prompt("Enter new language code (hi, en, zh, ja, ko, ar, es, fr, de, pt):", myLanguage);
      if (newLang && newLang !== myLanguage) {
        myLanguage = newLang;
        // Tell the server to update our language and reconcile agents
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
          alert(`Language updated to ${myLanguage}. The translation stream will switch momentarily.`);
        } catch (e) {
          alert("Failed to update language.");
        }
      }
    });
  }
});
