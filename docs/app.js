// ===============================================
// TFJS Option 2: Pose + Release + Net Motion
// Frontend-only: download JSON + clips.zip
// ===============================================

document.addEventListener("DOMContentLoaded", () => {

  // ---------- ELEMENTS ----------
  const video = document.getElementById("video");
  const canvas = document.getElementById("overlay");
  const ctx = canvas.getContext("2d");

  const modeEl = document.getElementById("mode");
  const teamEl = document.getElementById("team");
  const playerIdEl = document.getElementById("playerId");

  const startBtn = document.getElementById("start");
  const calibrateBtn = document.getElementById("calibrate");
  const runBtn = document.getElementById("run");
  const stopBtn = document.getElementById("stop");
  const endBtn = document.getElementById("endSession");

  const statusEl = document.getElementById("status");
  const debugEl = document.getElementById("debug");

  const scoreAEl = document.getElementById("scoreA");
  const scoreBEl = document.getElementById("scoreB");
  const lastResultEl = document.getElementById("lastResult");

  const motionThreshEl = document.getElementById("motionThresh");
  const motionThreshValEl = document.getElementById("motionThreshVal");
  const attemptWindowEl = document.getElementById("attemptWindow");
  const holdoffEl = document.getElementById("holdoff");

  // ---------- STATE ----------
  let stream = null;
  let detector = null;
  let rafId = null;

  // Session + outputs
  let session = null;
  let attempts = [];
  let poseData = {};   // attempt_id -> array of samples
  let clips = {};      // attempt_id -> Blob

  // Recorder
  let recorder = null;
  let chunks = [];
  let attemptId = null;

  // Shot logic
  let shotPending = false;
  let shotStartTs = 0;

  // Calibration / hoop net ROI
  let netROI = null; // {x,y,w,h}
  let calibrating = false;
  let dragStart = null;

  // Net motion baseline
  let lastNetImage = null;

  // Pose smoothing
  let lastWrist = null;
  let lastElbow = null;

  // ---------- UTILS ----------
  const nowISO = () => new Date().toISOString();
  const setStatus = (s) => statusEl.textContent = s;
  const setDebug = (s) => debugEl.textContent = s;

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadJSON(name, obj) {
    downloadBlob(name, new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  }

  function clampRect(r) {
    const x = Math.max(0, Math.min(canvas.width - 1, r.x));
    const y = Math.max(0, Math.min(canvas.height - 1, r.y));
    const w = Math.max(10, Math.min(canvas.width - x, r.w));
    const h = Math.max(10, Math.min(canvas.height - y, r.h));
    return { x, y, w, h };
  }

  // ---------- CAMERA ----------
  async function startCamera() {
    try {
      session = {
        session_id: crypto.randomUUID(),
        started_at: nowISO(),
        scoreboard: { A: 0, B: 0 },
        model: "tfjs-movenet-lightning",
        method: "pose+net-motion",
        netROI: null
      };
      attempts = [];
      poseData = {};
      clips = {};

      if (!navigator.mediaDevices?.getUserMedia) {
        alert("Camera not supported in this browser");
        return;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;

      // Default ROI (center-ish). You will calibrate it.
      netROI = clampRect({
        x: Math.floor(canvas.width * 0.60),
        y: Math.floor(canvas.height * 0.18),
        w: Math.floor(canvas.width * 0.18),
        h: Math.floor(canvas.height * 0.18)
      });
      session.netROI = netROI;

      // Enable controls
      calibrateBtn.disabled = false;
      runBtn.disabled = false;
      stopBtn.disabled = false;
      endBtn.disabled = false;

      setStatus("Camera ready. Click 'Calibrate Hoop Box' then drag a box around the net.");
      setDebug("");

    } catch (err) {
      console.error(err);
      alert(`Camera error: ${err.name}`);
    }
  }

  // ---------- TFJS POSE ----------
  async function loadDetector() {
    if (detector) return;
    setStatus("Loading TFJS Pose detector...");
    await tf.ready();

    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );

    setStatus("Detector ready.");
  }

  // ---------- RECORDING ----------
  function startRecording() {
    if (!stream) return;

    chunks = [];

    // pick supported mimeType
    const options = {};
    const preferred = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4"
    ];
    for (const mt of preferred) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(mt)) {
        options.mimeType = mt;
        break;
      }
    }

    recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = e => e.data && e.data.size > 0 && chunks.push(e.data);
    recorder.start(200);
  }

  function stopRecording() {
    return new Promise(resolve => {
      if (!recorder || recorder.state === "inactive") {
        recorder = null;
        resolve();
        return;
      }

      recorder.onstop = () => {
        if (attemptId && chunks.length > 0) {
          clips[attemptId] = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        }
        recorder = null;
        resolve();
      };

      recorder.stop();
    });
  }

  // ---------- NET MOTION ----------
  function getNetMotionScore() {
    if (!netROI) return 0;

    const img = ctx.getImageData(netROI.x, netROI.y, netROI.w, netROI.h);

    if (!lastNetImage) {
      lastNetImage = img;
      return 0;
    }

    // Sum absolute diff on one channel for speed
    let diff = 0;
    const d = img.data;
    const p = lastNetImage.data;
    for (let i = 0; i < d.length; i += 4) {
      diff += Math.abs(d[i] - p[i]);
    }

    lastNetImage = img;
    return diff;
  }

  function resetNetBaseline() {
    lastNetImage = null;
  }

  // ---------- POSE HELPERS ----------
  function kpByName(keypoints, name) {
    return keypoints.find(k => k.name === name || k.part === name);
  }

  function releaseDetected(keypoints) {
    const rw = kpByName(keypoints, "right_wrist");
    const re = kpByName(keypoints, "right_elbow");
    const rs = kpByName(keypoints, "right_shoulder");

    if (!rw || !re || !rs) return false;
    if ((rw.score ?? 1) < 0.4 || (re.score ?? 1) < 0.4 || (rs.score ?? 1) < 0.4) return false;

    // Simple release: wrist above elbow and above shoulder a bit
    const wristAboveElbow = rw.y < re.y - 12;
    const wristAboveShoulder = rw.y < rs.y + 8;

    // Add a small motion check to reduce false triggers
    let motionOk = true;
    if (lastWrist && lastElbow) {
      const dw = Math.hypot(rw.x - lastWrist.x, rw.y - lastWrist.y);
      const de = Math.hypot(re.x - lastElbow.x, re.y - lastElbow.y);
      motionOk = (dw > 6 || de > 6);
    }
    lastWrist = { x: rw.x, y: rw.y };
    lastElbow = { x: re.x, y: re.y };

    return wristAboveElbow && wristAboveShoulder && motionOk;
  }

  // ---------- ATTEMPT LIFECYCLE ----------
  function beginAttempt() {
    attemptId = crypto.randomUUID();
    shotPending = true;
    shotStartTs = performance.now();

    poseData[attemptId] = [];

    attempts.push({
      attempt_id: attemptId,
      team: teamEl.value,
      player_id: playerIdEl.value,
      started_at: nowISO(),
      made: "unknown",
      method: "pose+net-motion"
    });

    resetNetBaseline();
    startRecording();

    lastResultEl.textContent = "attempt…";
    setStatus("Release detected → checking net motion…");
  }

  async function finalizeAttempt(result) {
    // mark attempt
    const a = attempts.at(-1);
    if (a && a.attempt_id === attemptId) {
      a.made = result;
      a.ended_at = nowISO();
    }

    // update score
    if (result === "made") {
      session.scoreboard[teamEl.value]++;
      scoreAEl.textContent = session.scoreboard.A;
      scoreBEl.textContent = session.scoreboard.B;
    }

    lastResultEl.textContent = result;
    shotPending = false;

    await stopRecording();

    setStatus(`Attempt finalized: ${result}`);
    setDebug("");
  }

  // ---------- MAIN LOOP ----------
  async function loop() {
    // draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // draw ROI
    if (netROI) {
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = calibrating ? "orange" : "red";
      ctx.strokeRect(netROI.x, netROI.y, netROI.w, netROI.h);
      ctx.fillStyle = "rgba(255,0,0,0.08)";
      ctx.fillRect(netROI.x, netROI.y, netROI.w, netROI.h);
      ctx.restore();
    }

    // Pose estimation (only when running basketball/test)
    const mode = modeEl.value;
    const poses = await detector.estimatePoses(video, { flipHorizontal: false });

    // Minimal debug overlay: show release detection status
    if (poses.length > 0 && poses[0].keypoints) {
      const kps = poses[0].keypoints;

      // record pose during pending attempt
      if (shotPending && attemptId) {
        const rw = kpByName(kps, "right_wrist");
        const re = kpByName(kps, "right_elbow");
        const rs = kpByName(kps, "right_shoulder");
        poseData[attemptId].push({
          t_ms: performance.now(),
          right_wrist: rw ? { x: rw.x, y: rw.y, score: rw.score ?? 1 } : null,
          right_elbow: re ? { x: re.x, y: re.y, score: re.score ?? 1 } : null,
          right_shoulder: rs ? { x: rs.x, y: rs.y, score: rs.score ?? 1 } : null
        });
      }

      if (mode === "basketball") {
        // Trigger attempt from pose release
        if (!shotPending && netROI && releaseDetected(kps)) {
          beginAttempt();
        }
      }
    }

    // Net motion check (TEST mode or as part of attempt)
    const motionScore = netROI ? getNetMotionScore() : 0;
    const motionThresh = Number(motionThreshEl.value);
    motionThreshValEl.textContent = String(motionThresh);

    if (mode === "test") {
      setDebug(netROI
        ? `NET MOTION score: ${Math.floor(motionScore)} (threshold ${motionThresh})`
        : "No hoop box. Click Calibrate and drag a box.");
    }

    // Decide made/miss after release
    if (shotPending) {
      const now = performance.now();
      const holdoff = Number(holdoffEl.value);
      const windowMs = Number(attemptWindowEl.value);

      const elapsed = now - shotStartTs;
      const canCheck = elapsed >= holdoff;

      if (canCheck && motionScore > motionThresh) {
        await finalizeAttempt("made");
      } else if (elapsed > windowMs) {
        await finalizeAttempt("miss");
      } else {
        setDebug(`Attempt elapsed: ${Math.floor(elapsed)}ms | motion: ${Math.floor(motionScore)}`);
      }
    }

    rafId = requestAnimationFrame(loop);
  }

  // ---------- START/STOP ----------
  async function startSystem() {
    if (!stream) {
      alert("Start camera first.");
      return;
    }
    await loadDetector();
    if (rafId) cancelAnimationFrame(rafId);
    setStatus("Running...");
    rafId = requestAnimationFrame(loop);
  }

  async function stopSystem() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;

    // finish any pending attempt cleanly
    if (shotPending) {
      await finalizeAttempt("miss");
    }

    setStatus("Stopped (system loop).");
  }

  async function endSession() {
    await stopSystem();
    await stopRecording();

    session.ended_at = nowISO();
    session.netROI = netROI;

    downloadJSON("session.json", session);
    downloadJSON("attempts.json", attempts);
    downloadJSON("pose.json", poseData);

    const clipKeys = Object.keys(clips);
    if (clipKeys.length === 0) {
      alert("No clips recorded yet. Trigger at least one attempt.");
      setStatus("Session downloaded (no clips)");
      return;
    }

    const zip = new JSZip();
    clipKeys.forEach(id => zip.file(`${id}.webm`, clips[id]));
    downloadBlob("clips.zip", await zip.generateAsync({ type: "blob" }));

    setStatus(`Session downloaded (${clipKeys.length} clip${clipKeys.length === 1 ? "" : "s"})`);
  }

  // ---------- CALIBRATION UI ----------
  function canvasToLocal(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x: Math.round(x), y: Math.round(y) };
  }

  function enableCalibration(on) {
    calibrating = on;
    if (on) {
      setStatus("Calibration: click-drag a box around the hoop/net region.");
      setDebug("Tip: include rim + net area; too large increases false motion.");
    } else {
      setStatus("Calibration saved.");
      setDebug("");
    }
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!calibrating) return;
    dragStart = canvasToLocal(e);
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!calibrating || !dragStart) return;
    const p = canvasToLocal(e);
    const x = Math.min(dragStart.x, p.x);
    const y = Math.min(dragStart.y, p.y);
    const w = Math.abs(p.x - dragStart.x);
    const h = Math.abs(p.y - dragStart.y);
    netROI = clampRect({ x, y, w, h });
  });

  canvas.addEventListener("mouseup", () => {
    if (!calibrating) return;
    dragStart = null;
    session.netROI = netROI;
  });

  // Mobile touch support
  canvas.addEventListener("touchstart", (e) => {
    if (!calibrating) return;
    e.preventDefault();
    const t = e.touches[0];
    dragStart = canvasToLocal(t);
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    if (!calibrating || !dragStart) return;
    e.preventDefault();
    const t = e.touches[0];
    const p = canvasToLocal(t);
    const x = Math.min(dragStart.x, p.x);
    const y = Math.min(dragStart.y, p.y);
    const w = Math.abs(p.x - dragStart.x);
    const h = Math.abs(p.y - dragStart.y);
    netROI = clampRect({ x, y, w, h });
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    if (!calibrating) return;
    dragStart = null;
    session.netROI = netROI;
  });

  // ---------- EVENTS ----------
  startBtn.onclick = startCamera;

  calibrateBtn.onclick = () => {
    if (!stream) return alert("Start camera first.");
    enableCalibration(!calibrating);
    calibrateBtn.textContent = calibrating ? "Finish Calibration" : "Calibrate Hoop Box";
  };

  runBtn.onclick = startSystem;
  stopBtn.onclick = stopSystem;
  endBtn.onclick = endSession;

  motionThreshEl.oninput = () => motionThreshValEl.textContent = motionThreshEl.value;

});
