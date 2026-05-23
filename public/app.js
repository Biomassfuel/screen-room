const $ = (selector) => document.querySelector(selector);

const elements = {
  serverDot: $("#serverDot"),
  serverStatus: $("#serverStatus"),
  messageLine: $("#messageLine"),
  createRoomForm: $("#createRoomForm"),
  roomNameInput: $("#roomNameInput"),
  hostPasswordInput: $("#hostPasswordInput"),
  createRoomBtn: $("#createRoomBtn"),
  hostRoomCard: $("#hostRoomCard"),
  hostRoomId: $("#hostRoomId"),
  copyRoomBtn: $("#copyRoomBtn"),
  startShareBtn: $("#startShareBtn"),
  stopShareBtn: $("#stopShareBtn"),
  viewerCount: $("#viewerCount"),
  shareStatus: $("#shareStatus"),
  localPreview: $("#localPreview"),
  localPreviewEmpty: $("#localPreviewEmpty"),
  joinRoomForm: $("#joinRoomForm"),
  joinRoomIdInput: $("#joinRoomIdInput"),
  viewerPasswordInput: $("#viewerPasswordInput"),
  joinRoomBtn: $("#joinRoomBtn"),
  viewerRoomName: $("#viewerRoomName"),
  leaveRoomBtn: $("#leaveRoomBtn"),
  remoteVideo: $("#remoteVideo"),
  remoteEmpty: $("#remoteEmpty"),
  remoteEmptyText: $("#remoteEmptyText")
};

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" }
];

const state = {
  host: {
    roomId: "",
    token: "",
    cursor: 0,
    polling: false,
    stream: null,
    peers: new Map(),
    knownViewers: new Set()
  },
  viewer: {
    roomId: "",
    viewerId: "",
    token: "",
    cursor: 0,
    polling: false,
    peer: null
  }
};

function setMessage(message, kind = "info") {
  elements.messageLine.textContent = message;
  elements.messageLine.dataset.kind = kind;
}

function setServerStatus(status, online) {
  elements.serverStatus.textContent = status;
  elements.serverDot.classList.toggle("online", online === true);
  elements.serverDot.classList.toggle("offline", online === false);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败，请重试。");
  }
  return data;
}

function toggleVideoEmpty(video, empty, show) {
  empty.classList.toggle("is-hidden", !show);
  video.classList.toggle("is-hidden", show);
}

function updateHostUi(room) {
  elements.viewerCount.textContent = String(room?.viewerCount ?? 0);
  elements.shareStatus.textContent = room?.sharing ? "投屏中" : "未开始";
  elements.startShareBtn.disabled = !state.host.roomId || Boolean(state.host.stream);
  elements.stopShareBtn.disabled = !state.host.stream;
}

async function setSharingStatus(sharing) {
  if (!state.host.roomId) return;
  const data = await api(`/api/rooms/${state.host.roomId}/status`, {
    method: "POST",
    token: state.host.token,
    body: { sharing }
  });
  updateHostUi(data.room);
}

function createPeerConnection() {
  const peer = new RTCPeerConnection({ iceServers });
  peer.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      setMessage(`连接状态：${peer.connectionState}`);
    }
  };
  return peer;
}

async function sendSignalFromHost(viewerId, signal) {
  await api(`/api/rooms/${state.host.roomId}/signal`, {
    method: "POST",
    token: state.host.token,
    body: { from: "host", to: viewerId, signal }
  });
}

async function sendSignalFromViewer(signal) {
  await api(`/api/rooms/${state.viewer.roomId}/signal`, {
    method: "POST",
    token: state.viewer.token,
    body: { from: state.viewer.viewerId, signal }
  });
}

async function connectViewerFromHost(viewerId) {
  state.host.knownViewers.add(viewerId);
  if (!state.host.stream || state.host.peers.has(viewerId)) return;

  const peer = createPeerConnection();
  state.host.peers.set(viewerId, peer);
  state.host.stream.getTracks().forEach((track) => peer.addTrack(track, state.host.stream));

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalFromHost(viewerId, { type: "candidate", candidate: event.candidate }).catch(console.error);
    }
  };

  const offer = await peer.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false
  });
  await peer.setLocalDescription(offer);
  await sendSignalFromHost(viewerId, { type: "offer", description: peer.localDescription });
}

function removeHostPeer(viewerId) {
  state.host.knownViewers.delete(viewerId);
  const peer = state.host.peers.get(viewerId);
  if (!peer) return;
  peer.close();
  state.host.peers.delete(viewerId);
}

async function handleHostSignal(viewerId, signal) {
  const peer = state.host.peers.get(viewerId);
  if (!peer) return;

  if (signal.type === "answer") {
    await peer.setRemoteDescription(signal.description);
  }

  if (signal.type === "candidate" && signal.candidate) {
    await peer.addIceCandidate(signal.candidate).catch(() => {});
  }
}

async function pollHostEvents() {
  if (!state.host.roomId || state.host.polling) return;
  state.host.polling = true;

  while (state.host.roomId) {
    try {
      const data = await api(`/api/rooms/${state.host.roomId}/host-events?cursor=${state.host.cursor}`, {
        token: state.host.token
      });

      updateHostUi(data.room);
      for (const event of data.events) {
        state.host.cursor = Math.max(state.host.cursor, event.id);
        if (event.type === "viewer-joined") {
          setMessage(`${event.payload.name} 已加入房间。`);
          state.host.knownViewers.add(event.payload.viewerId);
          await connectViewerFromHost(event.payload.viewerId);
        }
        if (event.type === "viewer-left") {
          removeHostPeer(event.payload.viewerId);
          setMessage("一位观众已离开房间。");
        }
        if (event.type === "signal") {
          await handleHostSignal(event.payload.from, event.payload.signal);
        }
      }
    } catch (error) {
      setMessage(error.message, "error");
      break;
    }
  }

  state.host.polling = false;
}

async function createRoom(event) {
  event.preventDefault();
  elements.createRoomBtn.disabled = true;

  try {
    const data = await api("/api/rooms", {
      method: "POST",
      body: {
        name: elements.roomNameInput.value,
        password: elements.hostPasswordInput.value
      }
    });

    state.host.roomId = data.room.id;
    state.host.token = data.hostToken;
    state.host.cursor = 0;
    elements.hostRoomId.textContent = data.room.id;
    elements.hostRoomCard.hidden = false;
    elements.joinRoomIdInput.value = data.room.id;
    setMessage(`房间 ${data.room.id} 已创建，可以把房间号和密码发给观众。`);
    updateHostUi(data.room);
    pollHostEvents();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    elements.createRoomBtn.disabled = false;
  }
}

async function startSharing() {
  if (!state.host.roomId) {
    setMessage("请先创建房间。");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: "always",
        displaySurface: "monitor"
      },
      audio: true
    });

    state.host.stream = stream;
    elements.localPreview.srcObject = stream;
    await elements.localPreview.play().catch(() => {});
    toggleVideoEmpty(elements.localPreview, elements.localPreviewEmpty, false);

    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      stopSharing().catch(console.error);
    });

    await setSharingStatus(true);
    for (const viewerId of state.host.knownViewers) {
      await connectViewerFromHost(viewerId);
    }
    setMessage("投屏已开始。新加入的观众会自动连接。");
  } catch (error) {
    setMessage(error.name === "NotAllowedError" ? "你取消了屏幕选择。" : error.message, "error");
  }
}

async function stopSharing() {
  if (state.host.stream) {
    state.host.stream.getTracks().forEach((track) => track.stop());
    state.host.stream = null;
  }

  for (const peer of state.host.peers.values()) peer.close();
  state.host.peers.clear();
  elements.localPreview.srcObject = null;
  toggleVideoEmpty(elements.localPreview, elements.localPreviewEmpty, true);
  await setSharingStatus(false).catch(console.error);
  updateHostUi({ sharing: false, viewerCount: Number(elements.viewerCount.textContent || 0) });
  setMessage("投屏已停止。");
}

async function createViewerPeer() {
  if (state.viewer.peer) state.viewer.peer.close();

  const peer = createPeerConnection();
  state.viewer.peer = peer;

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    elements.remoteVideo.srcObject = stream;
    toggleVideoEmpty(elements.remoteVideo, elements.remoteEmpty, false);
    elements.remoteVideo.play().catch(() => {});
    setMessage("已接收到投屏画面。");
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalFromViewer({ type: "candidate", candidate: event.candidate }).catch(console.error);
    }
  };

  return peer;
}

async function handleViewerSignal(signal) {
  const peer = state.viewer.peer || (await createViewerPeer());

  if (signal.type === "offer") {
    await peer.setRemoteDescription(signal.description);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await sendSignalFromViewer({ type: "answer", description: peer.localDescription });
  }

  if (signal.type === "candidate" && signal.candidate) {
    await peer.addIceCandidate(signal.candidate).catch(() => {});
  }
}

async function pollViewerEvents() {
  if (!state.viewer.roomId || state.viewer.polling) return;
  state.viewer.polling = true;

  while (state.viewer.roomId) {
    try {
      const data = await api(
        `/api/rooms/${state.viewer.roomId}/viewers/${encodeURIComponent(state.viewer.viewerId)}/events?cursor=${state.viewer.cursor}`,
        { token: state.viewer.token }
      );

      for (const event of data.events) {
        state.viewer.cursor = Math.max(state.viewer.cursor, event.id);
        if (event.type === "signal") {
          await handleViewerSignal(event.payload.signal);
        }
        if (event.type === "sharing-status") {
          elements.remoteEmptyText.textContent = event.payload.sharing ? "房主正在连接投屏" : "房主尚未开始投屏";
          if (!event.payload.sharing) {
            toggleVideoEmpty(elements.remoteVideo, elements.remoteEmpty, true);
          }
        }
        if (event.type === "room-closed") {
          setMessage("房间已关闭。");
          leaveRoom(false);
        }
      }
    } catch (error) {
      setMessage(error.message, "error");
      break;
    }
  }

  state.viewer.polling = false;
}

async function joinRoom(event) {
  event.preventDefault();
  elements.joinRoomBtn.disabled = true;

  try {
    const roomId = elements.joinRoomIdInput.value.trim();
    const data = await api(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: {
        password: elements.viewerPasswordInput.value,
        name: `观众 ${Math.floor(Math.random() * 90 + 10)}`
      }
    });

    state.viewer.roomId = data.room.id;
    state.viewer.viewerId = data.viewerId;
    state.viewer.token = data.viewerToken;
    state.viewer.cursor = 0;
    elements.viewerRoomName.textContent = `${data.room.name} · ${data.room.id}`;
    elements.leaveRoomBtn.disabled = false;
    elements.remoteEmptyText.textContent = data.room.sharing ? "房主正在连接投屏" : "房主尚未开始投屏";
    toggleVideoEmpty(elements.remoteVideo, elements.remoteEmpty, true);
    setMessage(`已加入房间 ${data.room.id}。`);
    await createViewerPeer();
    pollViewerEvents();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    elements.joinRoomBtn.disabled = false;
  }
}

async function leaveRoom(notifyServer = true) {
  const { roomId, viewerId, token } = state.viewer;
  state.viewer.roomId = "";
  state.viewer.viewerId = "";
  state.viewer.token = "";
  state.viewer.cursor = 0;

  if (state.viewer.peer) {
    state.viewer.peer.close();
    state.viewer.peer = null;
  }

  elements.remoteVideo.srcObject = null;
  elements.viewerRoomName.textContent = "尚未加入";
  elements.leaveRoomBtn.disabled = true;
  elements.remoteEmptyText.textContent = "等待加入房间";
  toggleVideoEmpty(elements.remoteVideo, elements.remoteEmpty, true);

  if (notifyServer && roomId && viewerId && token) {
    await api(`/api/rooms/${roomId}/viewers/${encodeURIComponent(viewerId)}`, {
      method: "DELETE",
      token
    }).catch(() => {});
  }
}

async function copyRoomId() {
  if (!state.host.roomId) return;
  await navigator.clipboard.writeText(state.host.roomId).catch(() => {});
  setMessage(`房间号 ${state.host.roomId} 已复制。`);
}

async function healthCheck() {
  try {
    await fetch("/", { cache: "no-store" });
    setServerStatus("本地服务已连接", true);
  } catch {
    setServerStatus("本地服务未连接", false);
  }
}

elements.createRoomForm.addEventListener("submit", createRoom);
elements.startShareBtn.addEventListener("click", startSharing);
elements.stopShareBtn.addEventListener("click", () => stopSharing().catch(console.error));
elements.joinRoomForm.addEventListener("submit", joinRoom);
elements.leaveRoomBtn.addEventListener("click", () => leaveRoom(true));
elements.copyRoomBtn.addEventListener("click", copyRoomId);

window.addEventListener("beforeunload", () => {
  if (state.host.stream) {
    state.host.stream.getTracks().forEach((track) => track.stop());
  }
});

toggleVideoEmpty(elements.localPreview, elements.localPreviewEmpty, true);
toggleVideoEmpty(elements.remoteVideo, elements.remoteEmpty, true);
healthCheck();
