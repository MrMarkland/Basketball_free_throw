// ===============================
// FRONTEND-ONLY BASKETBALL SYSTEM
// ===============================

document.addEventListener("DOMContentLoaded", () => {

  // ---------- ELEMENTS ----------
  const video = document.getElementById("video");
  const canvas = document.getElementById("overlay");
  const ctx = canvas.getContext("2d");

  const modeEl = document.getElementById("mode");
  const teamEl = document.getElementById("team");
  const playerIdEl = document.getElementById("playerId");

  const startBtn = document.getElementById("start");
  const runBtn = document.getElementById("run");
  const stopBtn = document.getElementById("stop");
  const madeBtn = document.getElementById("made");
  const missBtn = document.getElementById("miss");
  const endBtn = document.getElementById("endSession");

  const clockVal = document.getElementById("clockVal");
  const statusEl = document.getElementById("status");
  const testReadoutEl = document.getElementById("testReadout");

  // ---------- STATE ----------
  let stream = null;
  let camera = null;

  let session = null;
  let attempts = [];
  let poseData = {};
  let clips = {};

  let recorder = null;
  let chunks = [];
  let attemptId = null;
  let attemptActive = false;

  let clockTimer = null;
  let clockRemaining = 0;

  let pose = null;
  let hands = null;
  let lastWrist = null;
  let lastElbow = null;
  let lastTs = 0;

  // ---------- UTILS ----------
  const nowISO = () => new Date().toISOString();
  const setStatus = (s) => statusEl.textContent = s;

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadJSON(name, obj) {
    downloadBlob(name, new Blob(
      [JSON.stringify(obj, null, 2)],
      { type: "application/json" }
    ));
  }

  // ---------- CAMERA ----------
  async function startCamera() {
    console.log("Start Camera clicked");

    try {
      session = {
        session_id: crypto.randomUUID(),
        mode: modeEl.value,
        started_at: nowISO(),
        scoreboard: { A: 0, B: 0 }
      };

      attempts = [];
      poseData = {};
      clips = {};

      if (!navigator.mediaDevices?.getUserMedia) {
        alert("Camera not supported on this browser");
        return;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;

      await video.play(); // REQUIRED

      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;

      runBtn.disabled = false;
      stopBtn.disabled = false;
      endBtn.disabled = false;

      setStatus("Camera ready");

    } catch (err) {
      console.error("Camera error:", err);
      alert(`Camera error: ${err.name}`);
    }
  }

  function stopAll() {
    clearInterval(clockTimer);
    clockVal.textContent = "--";

    if (camera) camera.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());

    attemptActive = false;
    madeBtn.disabled = true;
    missBtn.disabled = true;

    setStatus("Stopped");
  }

  // ---------- TEST MODE ----------
  function detectFingers(lm) {
    return {
      thumb: lm[4].x > lm[3].x,
      index: lm[8].y < lm[6].y,
      middle: lm[12].y < lm[10].y,
      ring: lm[16].y < lm[14].y,
      pinky: lm[20].y < lm[18].y
    };
  }

  async function startTestMode() {
    hands = new Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });

    hands.setOptions({ maxNumHands: 1, minDetectionConfidence: 0.6 });

    hands.onResults(res => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!res.multiHandLandmarks?.length) {
        testReadoutEl.textContent = "No hand detected";
        return;
      }
      const lm = res.multiHandLandmarks[0];
      drawConnectors(ctx, lm, HAND_CONNECTIONS);
      drawLandmarks(ctx, lm);

      const f = detectFingers(lm);
      const up = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
      testReadoutEl.textContent = `Fingers up: ${up.length} → ${up.join(", ") || "none"}`;
    });

    camera = new Camera(video, {
      onFrame: async () => hands.send({ image: video })
    });

    camera.start();
    setStatus("TEST MODE running");
  }

  // ---------- BASKETBALL MODE ----------
  const speed = (p, c, dt) =>
    (!p || !c || !dt) ? 0 : Math.hypot(c.x - p.x, c.y - p.y) / dt;

  function attemptMotion(w, e, dt) {
    return (
      (speed(lastWrist, w, dt) > 2 || speed(lastElbow, e, dt) > 1.5) &&
      lastWrist &&
      (lastWrist.y - w.y) > 0.02
    );
  }

  function startClock(sec) {
    clearInterval(clockTimer);
    clockRemaining = sec;
    clockVal.textContent = sec;

    clockTimer = setInterval(() => {
      clockRemaining--;
      clockVal.textContent = clockRemaining;
      if (clockRemaining <= 0) {
        clearInterval(clockTimer);
        stopRecording();
        attemptActive = false;
      }
    }, 1000);
  }

  function startRecording() {
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.start(200);
  }

  function stopRecording() {
    if (!recorder || !attemptId) return;
    recorder.onstop = () => {
      clips[attemptId] = new Blob(chunks, { type: "video/webm" });
    };
    recorder.stop();
  }

  async function startBasketballMode() {
    pose = new Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`
    });

    pose.setOptions({ smoothLandmarks: true });

    pose.onResults(res => {
      if (!res.poseLandmarks) return;
      const lm = res.poseLandmarks;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const t = performance.now();
      const dt = (t - lastTs) / 1000 || 0;
      lastTs = t;

      const w = lm[16], e = lm[14];

      if (attemptActive) {
        poseData[attemptId].push({ t_ms: t, wrist: w, elbow: e });
      }

      if (!attemptActive && attemptMotion(w, e, dt)) {
        attemptActive = true;
        attemptId = crypto.randomUUID();
        poseData[attemptId] = [];

        attempts.push({
          attempt_id: attemptId,
          team: teamEl.value,
          player_id: playerIdEl.value,
          started_at: nowISO(),
          made: "unknown"
        });

        startClock(10);
        startRecording();
        madeBtn.disabled = false;
        missBtn.disabled = false;
        setStatus("Free throw detected");
      }

      lastWrist = w;
      lastElbow = e;
    });

    camera = new Camera(video, {
      onFrame: async () => pose.send({ image: video })
    });

    camera.start();
    setStatus("Basketball mode running");
  }

  function resolve(type) {
    if (!attemptId) return;
    attempts.at(-1).made = type;
    if (type === "made") session.scoreboard[teamEl.value]++;
    madeBtn.disabled = true;
    missBtn.disabled = true;
    attemptActive = false;
    setStatus(`Shot: ${type}`);
  }

  async function endSession() {
    session.ended_at = nowISO();
    downloadJSON("session.json", session);
    downloadJSON("attempts.json", attempts);
    downloadJSON("pose.json", poseData);

    const zip = new JSZip();
    Object.entries(clips).forEach(([id, b]) => zip.file(`${id}.webm`, b));
    downloadBlob("clips.zip", await zip.generateAsync({ type: "blob" }));

    setStatus("Session downloaded");
  }

  // ---------- UI ----------
  startBtn.onclick = startCamera;
  runBtn.onclick = () => modeEl.value === "test" ? startTestMode() : startBasketballMode();
  stopBtn.onclick = stopAll;
  madeBtn.onclick = () => resolve("made");
  missBtn.onclick = () => resolve("miss");
  endBtn.onclick = endSession;

});
