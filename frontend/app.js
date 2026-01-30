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

let stream = null;
let camera = null;

// Session data (LOCAL)
let session = null;
let attempts = [];
let poseData = {};
let clips = {};

// Recording
let recorder = null;
let chunks = [];
let attemptId = null;
let attemptActive = false;

// Clock
let clockTimer = null;
let clockRemaining = 0;

// MODELS
let pose = null;
let hands = null;
let lastWrist = null;
let lastElbow = null;
let lastTs = 0;

// ---------- Utilities ----------
function nowISO(){ return new Date().toISOString(); }
function setStatus(s){ statusEl.textContent = s; }

function downloadBlob(name, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadJSON(name, obj){
  downloadBlob(name, new Blob([JSON.stringify(obj, null, 2)], { type:"application/json" }));
}

// ---------- Camera ----------
async function startCamera(){
  session = {
    session_id: crypto.randomUUID(),
    mode: modeEl.value,
    started_at: nowISO(),
    scoreboard: { A:0, B:0 }
  };
  attempts = [];
  poseData = {};
  clips = {};

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false
  });

  video.srcObject = stream;
  await new Promise(r => video.onloadedmetadata = r);

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  runBtn.disabled = false;
  stopBtn.disabled = false;
  endBtn.disabled = false;

  setStatus("Camera ready.");
}

function stopAll(){
  clearInterval(clockTimer);
  clockVal.textContent = "--";

  if (camera) camera.stop();
  if (stream) stream.getTracks().forEach(t => t.stop());

  attemptActive = false;
  madeBtn.disabled = true;
  missBtn.disabled = true;

  setStatus("Stopped.");
}

// ---------- TEST MODE ----------
function detectFingers(lm){
  return {
    thumb: lm[4].x > lm[3].x,
    index: lm[8].y < lm[6].y,
    middle: lm[12].y < lm[10].y,
    ring: lm[16].y < lm[14].y,
    pinky: lm[20].y < lm[18].y
  };
}

async function startTestMode(){
  hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  hands.setOptions({ maxNumHands:1, minDetectionConfidence:0.6 });
  hands.onResults(res => {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!res.multiHandLandmarks?.length) {
      testReadoutEl.textContent = "No hand detected";
      return;
    }
    const lm = res.multiHandLandmarks[0];
    drawConnectors(ctx, lm, HAND_CONNECTIONS);
    drawLandmarks(ctx, lm);

    const f = detectFingers(lm);
    const up = Object.entries(f).filter(([,v])=>v).map(([k])=>k);
    testReadoutEl.textContent = `Fingers up: ${up.length} → ${up.join(", ")||"none"}`;
  });

  camera = new Camera(video, {
    onFrame: async () => hands.send({ image: video })
  });
  camera.start();
  setStatus("TEST MODE running.");
}

// ---------- BASKETBALL MODE ----------
function speed(p,c,dt){
  if(!p||!c||!dt) return 0;
  return Math.hypot(c.x-p.x, c.y-p.y)/dt;
}

function attemptMotion(w,e,dt){
  return (speed(lastWrist,w,dt)>2 || speed(lastElbow,e,dt)>1.5) &&
         lastWrist && (lastWrist.y - w.y) > 0.02;
}

function startClock(sec){
  clearInterval(clockTimer);
  clockRemaining = sec;
  clockVal.textContent = sec;
  clockTimer = setInterval(()=>{
    clockRemaining--;
    clockVal.textContent = clockRemaining;
    if(clockRemaining<=0){
      clearInterval(clockTimer);
      stopRecording();
      attemptActive=false;
    }
  },1000);
}

function startRecording(){
  chunks=[];
  recorder=new MediaRecorder(stream);
  recorder.ondataavailable=e=>e.data.size&&chunks.push(e.data);
  recorder.start(200);
}

function stopRecording(){
  if(!recorder||!attemptId) return;
  recorder.onstop=()=>{
    const blob=new Blob(chunks,{type:"video/webm"});
    clips[attemptId]=blob;
  };
  recorder.stop();
}

async function startBasketballMode(){
  pose=new Pose({
    locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`
  });
  pose.setOptions({ smoothLandmarks:true });
  pose.onResults(res=>{
    if(!res.poseLandmarks) return;
    const lm=res.poseLandmarks;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    [16,14,12].forEach(i=>{
      const x=lm[i].x*canvas.width;
      const y=lm[i].y*canvas.height;
      ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.fill();
    });

    const t=performance.now();
    const dt=(t-lastTs)/1000||0; lastTs=t;
    const w=lm[16], e=lm[14];

    if(attemptActive){
      poseData[attemptId].push({t_ms:t,wrist:w,elbow:e});
    }

    if(!attemptActive && attemptMotion(w,e,dt)){
      attemptActive=true;
      attemptId=crypto.randomUUID();
      poseData[attemptId]=[];
      attempts.push({
        attempt_id:attemptId,
        team:teamEl.value,
        player_id:playerIdEl.value,
        started_at:nowISO(),
        made:"unknown"
      });
      startClock(10);
      startRecording();
      madeBtn.disabled=false;
      missBtn.disabled=false;
      setStatus("Free throw detected.");
    }

    lastWrist=w; lastElbow=e;
  });

  camera=new Camera(video,{onFrame:async()=>pose.send({image:video})});
  camera.start();
  setStatus("Basketball mode running.");
}

function resolve(type){
  if(!attemptId) return;
  attempts.at(-1).made=type;
  if(type==="made") session.scoreboard[teamEl.value]++;
  madeBtn.disabled=true;
  missBtn.disabled=true;
  attemptActive=false;
  setStatus(`Shot: ${type}`);
}

// ---------- END SESSION ----------
async function endSession(){
  session.ended_at=nowISO();
  downloadJSON("session.json",session);
  downloadJSON("attempts.json",attempts);
  downloadJSON("pose.json",poseData);

  const zip=new JSZip();
  Object.entries(clips).forEach(([id,b])=>zip.file(`${id}.webm`,b));
  const zipBlob=await zip.generateAsync({type:"blob"});
  downloadBlob("clips.zip",zipBlob);

  setStatus("Session downloaded.");
}

// ---------- UI ----------
startBtn.onclick=startCamera;
runBtn.onclick=()=>modeEl.value==="test"?startTestMode():startBasketballMode();
stopBtn.onclick=stopAll;
madeBtn.onclick=()=>resolve("made");
missBtn.onclick=()=>resolve("miss");
endBtn.onclick=endSession;

