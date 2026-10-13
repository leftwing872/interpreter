const $ = (id) => document.getElementById(id);
const els = {
  source: $("source"), language: $("language"), file: $("file"), pickFile: $("pickFile"),
  start: $("start"), stop: $("stop"), clear: $("clear"), download: $("download"),
  status: $("status"), media: $("media"), video: $("video"), caption: $("caption"),
  transcript: $("transcript"), live: $("live"), meta: $("meta"),
};

let ws = null;
let audioCtx = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;
let selectedFile = null;
let serverConfig = { sampleRate: 16000, languages: [] };
const segments = new Map(); // id -> { el, src, ko, text, translation, language } (committed pieces only)


const TOKEN_KEY = "interpreter.accessToken";
function getToken() { return localStorage.getItem(TOKEN_KEY) ?? ""; }

async function fetchConfig() {
  const res = await fetch("/api/config", { headers: { "x-access-token": getToken() } });
  if (res.status === 401) {
    const token = prompt("접근 토큰을 입력하세요");
    if (token == null) throw new Error("접근 토큰이 필요합니다");
    localStorage.setItem(TOKEN_KEY, token.trim());
    return fetchConfig();
  }
  if (!res.ok) throw new Error(`설정을 불러오지 못했습니다 (${res.status})`);
  return res.json();
}

async function init() {
  try {
    serverConfig = await fetchConfig();
  } catch (err) {
    setStatus(`오류: ${err.message}`, "error");
    return;
  }
  for (const l of serverConfig.languages) {
    const opt = document.createElement("option");
    opt.value = l.code; opt.textContent = l.label;
    els.language.appendChild(opt);
  }
  els.meta.textContent = `Amazon Transcribe → Amazon Bedrock (${serverConfig.model}) → ${serverConfig.target.name}`;

  els.source.onchange = onSourceChange;
  els.pickFile.onclick = () => els.file.click();
  els.file.onchange = () => {
    selectedFile = els.file.files[0] ?? null;
    if (selectedFile) {
      els.video.src = URL.createObjectURL(selectedFile);
      els.pickFile.textContent = selectedFile.name;
    }
  };
  els.start.onclick = start;
  els.stop.onclick = stop;
  els.clear.onclick = clearTranscript;
  els.download.onclick = downloadTranscript;
  els.video.onended = () => setTimeout(stop, 2500); // let Transcribe flush the tail
  onSourceChange();
}

function onSourceChange() {
  const isFile = els.source.value === "file";
  els.pickFile.hidden = !isFile;
  els.media.hidden = !isFile;
}

function setStatus(text, cls = "") {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
}

async function start() {
  try {
    els.start.disabled = true;
    setStatus("연결 중…");
    await openSocket();
    await startAudio();
    els.stop.disabled = false;
    setStatus("● 실시간", "live");
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message}`, "error");
    await teardownAudio();
    els.start.disabled = false;
  }
}

function stop() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
  teardownAudio();
  els.stop.disabled = true;
  setStatus("마무리 중…");
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const query = getToken() ? `?token=${encodeURIComponent(getToken())}` : "";
    ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", language: els.language.value }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ready") resolve();
      handleServerMessage(msg);
    };
    ws.onerror = () => {
      if (serverConfig.authRequired) localStorage.removeItem(TOKEN_KEY);
      reject(new Error("WebSocket 연결 실패 (토큰이 틀렸으면 새로고침 후 다시 입력)"));
    };
    ws.onclose = (ev) => {
      console.log("ws closed", ev.code, ev.reason);
      ws = null;
      els.start.disabled = false;
      els.stop.disabled = true;
      if (!els.status.classList.contains("error")) setStatus("대기");
    };
  });
}

async function startAudio() {
  const source = els.source.value;
  audioCtx = new AudioContext({ sampleRate: serverConfig.sampleRate });
  await audioCtx.audioWorklet.addModule("pcm-processor.js");
  workletNode = new AudioWorkletNode(audioCtx, "pcm-processor", {
    processorOptions: { targetRate: serverConfig.sampleRate },
  });
  workletNode.port.onmessage = (ev) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(ev.data);
  };

  if (source === "mic") {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    sourceNode.connect(workletNode);
  } else if (source === "display") {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (mediaStream.getAudioTracks().length === 0) {
      throw new Error("공유한 화면/탭에 오디오가 없습니다. '탭 오디오 공유'를 체크하세요.");
    }
    mediaStream.getTracks().forEach((t) => (t.onended = () => {
      addNotice(`화면 공유 ${t.kind} 트랙이 종료되어 중지합니다`, "info");
      stop();
    }));
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    sourceNode.connect(workletNode);
  } else {
    if (!selectedFile) throw new Error("파일을 먼저 선택하세요.");
    if (!els.video.dataset.connected) {
      sourceNode = audioCtx.createMediaElementSource(els.video);
      els.video.dataset.connected = "1";
    }
    sourceNode.connect(workletNode);
    sourceNode.connect(audioCtx.destination); // keep playback audible
    els.video.currentTime = 0;
    await els.video.play();
  }
  // Worklet must be connected to the graph to run; route through a silent gain.
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  workletNode.connect(silent).connect(audioCtx.destination);
  await audioCtx.resume();
}

async function teardownAudio() {
  if (els.source.value === "file" && !els.video.paused) els.video.pause();
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  try { workletNode?.disconnect(); } catch {}
  workletNode = null;
  if (audioCtx && els.source.value !== "file") {
    // MediaElementSource is bound to its AudioContext; keep it alive for the file source.
    await audioCtx.close();
    audioCtx = null;
    sourceNode = null;
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "partial": {
      // live text not yet committed; one rolling line at the bottom. Empty text clears it.
      els.live.hidden = !msg.text;
      els.live.querySelector(".src").textContent = msg.text;
      els.live.querySelector(".lang").textContent = msg.language ?? "";
      if (msg.text) scrollToBottom();
      break;
    }
    case "final": {
      const seg = upsertSegment(msg.id);
      seg.text = msg.text;
      seg.language = msg.language;
      seg.src.textContent = msg.text;
      if (msg.language) seg.langEl.textContent = msg.language;
      seg.ko.classList.add("loading");
      updateCaption(seg);
      scrollToBottom();
      break;
    }
    case "translation_delta": {
      const seg = segments.get(msg.id);
      if (!seg) break;
      seg.ko.classList.remove("loading");
      seg.translation += msg.delta;
      seg.ko.textContent = seg.translation;
      updateCaption(seg);
      break;
    }
    case "translation": {
      const seg = segments.get(msg.id);
      if (!seg) break;
      seg.ko.classList.remove("loading");
      seg.translation = msg.text;
      seg.ko.textContent = msg.text;
      seg.el.classList.toggle("skipped", Boolean(msg.skipped));
      seg.el.classList.toggle("failed", Boolean(msg.failed));
      if (msg.model) seg.el.title = `${msg.model} · ${msg.ms} ms`;
      if (!msg.skipped) updateCaption(seg);
      scrollToBottom();
      break;
    }
    case "info":
      addNotice(msg.message, "info");
      break;
    case "ended":
      els.live.hidden = true;
      if (!els.status.classList.contains("error")) setStatus("완료");
      ws?.close();
      break;
    case "error":
      console.error("server error:", msg.message);
      setStatus(`오류: ${msg.message}`, "error");
      addNotice(msg.message, "error");
      break;
  }
}

function upsertSegment(id) {
  let seg = segments.get(id);
  if (seg) return seg;
  const el = document.createElement("div");
  el.className = "seg";
  const src = document.createElement("div");
  src.className = "src";
  const langEl = document.createElement("span");
  langEl.className = "lang";
  const ko = document.createElement("div");
  ko.className = "ko";
  el.append(langEl, src, ko);
  els.transcript.insertBefore(el, els.live);
  seg = { el, src, ko, langEl, text: "", translation: "", language: undefined };
  segments.set(id, seg);
  return seg;
}

function addNotice(text, cls) {
  const el = document.createElement("div");
  el.className = `notice ${cls}`;
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  els.transcript.insertBefore(el, els.live);
  scrollToBottom();
}

function updateCaption(seg) {
  if (els.media.hidden) return;
  els.caption.querySelector(".cap-src").textContent = seg.text;
  els.caption.querySelector(".cap-ko").textContent = seg.translation;
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function clearTranscript() {
  segments.clear();
  for (const el of [...els.transcript.children]) if (el !== els.live) el.remove();
  els.live.hidden = true;
  els.caption.querySelector(".cap-src").textContent = "";
  els.caption.querySelector(".cap-ko").textContent = "";
}

function downloadTranscript() {
  const lines = [];
  for (const seg of segments.values()) {
    if (seg.el.classList.contains("skipped")) continue;
    lines.push(`[${seg.language ?? "?"}] ${seg.text}`, `[ko] ${seg.translation}`, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

init();
