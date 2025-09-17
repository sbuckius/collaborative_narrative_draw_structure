// ----- Firebase config (paste yours) -----
const firebaseConfig = {

  apiKey: "AIzaSyC4eRwEm4P8CuYR225V8v-A19innLls_4Q",

  authDomain: "collaborativedrawingnarrative.firebaseapp.com",

  projectId: "collaborativedrawingnarrative",

  storageBucket: "collaborativedrawingnarrative.firebasestorage.app",

  messagingSenderId: "139424307999",

  appId: "1:139424307999:web:7f780ce5da69a18f8d6e2a",

  measurementId: "G-ZH4NXDVC0M"

};
// ----- Firebase config (paste yours) -----

// ----- Room & DOM -----
function getRoomId(){
  const params = new URLSearchParams(location.search);
  return (params.get('room') || 'main').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32) || 'main';
}
function randomColor(){ const h = Math.floor(Math.random()*360); return `hsl(${h}, 90%, 60%)`; }
const friendlyId = localStorage.getItem('p5draw-client') || (() => {
  const v = Math.random().toString(36).slice(2,9);
  localStorage.setItem('p5draw-client', v);
  return v;
})();
const myColor = localStorage.getItem('p5draw-color') || (() => {
  const c = randomColor(); localStorage.setItem('p5draw-color', c); return c;
})();

const colorEl = document.getElementById('color');
const sizeEl  = document.getElementById('size');
const statusEl= document.getElementById('status');
const userEl  = document.getElementById('user-id');
const roomEl  = document.getElementById('room-id');
const saveEl  = document.getElementById('save');
const roomId  = getRoomId();
roomEl.textContent = roomId;
userEl.textContent = friendlyId;
colorEl.value = toHex(myColor);

// ----- p5: draw immediately; sync later -----
let offscreen, currentStroke = null, brush = { color: myColor, size:6, mode:'pen' };
let cursorDots = new Map();
let dbReady = false, myAuthUid = null;
let roomRef, strokesRef, cursorsRef, presenceRef;

new p5((p)=>{
  p.setup = () => {
    const h = window.innerHeight - document.querySelector('header').offsetHeight;
    const c = p.createCanvas(window.innerWidth, h);
    c.parent('canvas-holder');
    p.pixelDensity(1);
    p.background(17);
    offscreen = p.createGraphics(p.width, p.height);
    offscreen.background(17);

    // UI
    colorEl.addEventListener('input', e => { 
      brush.color = e.target.value; brush.mode = 'pen';
      localStorage.setItem('p5draw-color', brush.color);
    });
    sizeEl.addEventListener('input',  e => brush.size = Number(e.target.value));
    document.getElementById('eraser').addEventListener('click', ()=> brush.mode='erase');
    document.getElementById('pen').addEventListener('click',    ()=> brush.mode='pen');
    document.getElementById('clear').addEventListener('click',  clearRoom);
    // NEW: save image
    saveEl.addEventListener('click', savePNG);

    // Responsive
    new ResizeObserver(()=>{
      const nh = window.innerHeight - document.querySelector('header').offsetHeight;
      if (p.width !== window.innerWidth || p.height !== nh) {
        const prev = offscreen.get();
        p.resizeCanvas(window.innerWidth, nh);
        offscreen = p.createGraphics(p.width, p.height);
        offscreen.background(17);
        offscreen.image(prev, 0, 0);
      }
    }).observe(document.body);
  };

  p.draw = () => {
    p.background(17);
    p.image(offscreen, 0, 0);

    if (currentStroke && currentStroke.points.length > 1){
      p.stroke(currentStroke.mode==='erase' ? 17 : currentStroke.color);
      p.strokeWeight(currentStroke.size);
      p.strokeCap(p.ROUND);
      p.noFill();
      p.beginShape();
      currentStroke.points.forEach(pt => p.vertex(pt.x, pt.y));
      p.endShape();
    }

    publishCursor(p.mouseX, p.mouseY);
  };

  p.mousePressed = () => {
    if (p.mouseX>=0 && p.mouseX<p.width && p.mouseY>=0 && p.mouseY<p.height)
      beginStroke(p.mouseX, p.mouseY);
  };
  p.mouseDragged = () => { if (currentStroke) addPoint(p.mouseX, p.mouseY); };
  p.mouseReleased= () => { if (currentStroke) finishStroke(); };

  p.touchStarted  = p.mousePressed;
  p.touchMoved    = p.mouseDragged;
  p.touchEnded    = p.mouseReleased;
});

// ----- Stroke helpers -----
function beginStroke(x,y){
  currentStroke = { id: rid(), user: friendlyId, color: brush.color, size: brush.size, mode: brush.mode, points:[{x,y}] };
}
function addPoint(x,y){
  const last = currentStroke.points[currentStroke.points.length-1];
  if (Math.hypot(x-last.x, y-last.y) >= 1){
    currentStroke.points.push({x,y});
    offscreen.stroke(currentStroke.mode==='erase' ? 17 : currentStroke.color);
    offscreen.strokeWeight(currentStroke.size);
    offscreen.noFill();
    offscreen.line(last.x, last.y, x, y);
  }
}
function finishStroke(){
  const s = currentStroke; currentStroke = null;
  if (!s) return;
  if (dbReady && strokesRef) strokesRef.push(s).catch(console.error);
}
async function clearRoom(){
  offscreen.background(17);
  if (dbReady && roomRef) await roomRef.child('strokes').remove();
}
function drawStrokeToBuffer(s){
  if (!s || !s.points || s.points.length<2) return;
  offscreen.push();
  offscreen.stroke(s.mode==='erase' ? 17 : s.color);
  offscreen.strokeWeight(s.size || 6);
  offscreen.noFill();
  for (let i=1;i<s.points.length;i++){
    const a = s.points[i-1], b = s.points[i];
    offscreen.line(a.x, a.y, b.x, b.y);
  }
  offscreen.pop();
}
function rid(){ return Math.random().toString(36).slice(2, 9); }

// ----- Save PNG (NEW) -----
function savePNG(){
  if (!offscreen) return;
  // filename: room-YYYYMMDD-HHMMSS.png
  const d = new Date();
  const pad = (n)=> String(n).padStart(2,'0');
  const fname = `${roomId}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;

  // Prefer toBlob for memory efficiency; fallback toDataURL
  if (offscreen.canvas.toBlob) {
    offscreen.canvas.toBlob((blob)=>{
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname; a.click();
      setTimeout(()=>URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  } else {
    const a = document.createElement('a');
    a.href = offscreen.canvas.toDataURL('image/png');
    a.download = fname; a.click();
  }
}

// ----- Firebase init & sync -----
firebase.initializeApp(firebaseConfig);
statusEl.textContent = '● signing in…';
firebase.auth().onAuthStateChanged(async (user) => {
  if (!user) { try { await firebase.auth().signInAnonymously(); } catch (e) { statusEl.textContent='⚠ auth failed'; } return; }
  myAuthUid = user.uid;
  userEl.textContent = myAuthUid.slice(0,7);

  const db = firebase.database();
  roomRef    = db.ref(`rooms/${roomId}`);
  strokesRef = roomRef.child('strokes');
  cursorsRef = roomRef.child('cursors');
  presenceRef= roomRef.child('presence').child(myAuthUid);

  presenceRef.onDisconnect().remove();
  presenceRef.set({ t: firebase.database.ServerValue.TIMESTAMP });

  statusEl.textContent = '● loading…';
  const snap = await strokesRef.once('value');
  const data = snap.val();
  if (data) Object.values(data).forEach(drawStrokeToBuffer);
  strokesRef.limitToLast(2000).on('child_added', s => drawStrokeToBuffer(s.val()));

  roomRef.child('presence').on('child_removed', (s)=>{
    const id = s.key; const dot = cursorDots.get(id);
    if (dot){ dot.remove(); cursorDots.delete(id); }
  });
  cursorsRef.on('child_changed', (s)=>updateCursorDot(s.key, s.val()));
  cursorsRef.on('child_added',   (s)=>updateCursorDot(s.key, s.val()));

  dbReady = true;
  statusEl.textContent = '● live';
});

// ----- Live cursors -----
let lastCursorSent = 0;
function publishCursor(x,y){
  if (!dbReady || !cursorsRef) return;
  const now = performance.now();
  if (now - lastCursorSent < 50) return; // ~20Hz
  lastCursorSent = now;
  if (x<0 || y<0) return;
  const c = brush.mode==='erase' ? '#999' : brush.color;
  cursorsRef.child(myAuthUid).set({ x, y, c, t: firebase.database.ServerValue.TIMESTAMP });
}
function updateCursorDot(id, data){
  if (!data || id===myAuthUid) return;
  let dot = cursorDots.get(id);
  if (!dot){
    dot = document.createElement('div');
    dot.className = 'cursor-dot';
    document.getElementById('canvas-holder').appendChild(dot);
    cursorDots.set(id, dot);
  }
  dot.style.left = data.x + 'px';
  dot.style.top  = data.y + 'px';
  dot.style.background = data.c || '#fff';
}

// ----- helpers -----
function toHex(color){
  // converts hsl() to computed hex via canvas, passes through hex strings
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = color;
  return ctx.fillStyle; // browser normalizes to hex
}
