(() => {
'use strict';
const $ = id => document.getElementById(id);
const W = 800, H = 400, FLOOR = 350, NET_X = 400, NET_HALF = 5, NET_TOP = FLOOR - 170, HORIZON = 150;
const PR = 32, BR = 18, WIN = 7, PREFIX = 'batalhanarede-';
const stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d',{alpha:false,desynchronized:true});
const TEAM = [
  {name:'Magenta', c:'#ff2d95', c2:'#ffa3d1'},
  {name:'Ciano',   c:'#19e3ff', c2:'#a8f6ff'}
];
// STUN + TURN: ajuda a conectar aparelhos em redes diferentes (4G/Wi-Fi/computador)
const ICE = { iceServers: [
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'},
  {urls:'stun:global.stun.twilio.com:3478'},
  {urls:['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'],
   username:'openrelayproject', credential:'openrelayproject'}
]};

// ---------- estado ----------
let mode = null;            // 'local' | 'host' | 'guest'
let me = 0;                 // índice do jogador local no online
let running = false;
let peer = null, conn = null;
let inp = [{l:0,r:0,u:0},{l:0,r:0,u:0}];
let G;                      // estado do jogo
let tick = 0, tLast = 0, acc = 0, lastSent = '';
let seenHit = 0, prevPh = '', roomCode = '', hostCode = '';
let rtt = null, pingTimer = null, lastRx = 0;
let fxLevel = 1, ema = 16.7, slow = 0, flash = 0, flashCol = '#fff', shake = 0;
let seq = 0, lastQ = 0;
let wl = null, muted = false, AC = null, loopId = 0, ovKey = '';

function newGame(){
  G = {
    P:[{x:200,y:FLOOR-PR,vx:0,vy:0},{x:600,y:FLOOR-PR,vx:0,vy:0}],
    B:{x:200,y:110,vx:0,vy:0},
    s:[0,0], ph:'serve', t:50, w:-1, msg:'Prepare-se!', server:0,
    hitN:0, hitX:0, hitY:0, hitC:0, hitT:-99
  };
  seenHit = 0;
}
newGame();

// ---------- telas ----------
function show(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  document.body.classList.toggle('ingame', id === 'game');
}
$('btnLocal').onclick = () => startLocal();
$('btnOnline').onclick = () => { resetLobby(); show('lobby'); };
$('btnLobbyBack').onclick = () => { cleanup(); show('menu'); };
$('btnExit').onclick = () => { cleanup(); show('menu'); };
$('btnCreate').onclick = createRoom;
$('btnJoin').onclick = joinRoom;
$('roomInput').addEventListener('input', e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('btnRematch').onclick = () => {
  if (mode === 'guest') { send({t:'rematch'}); setTimeout(() => send({t:'rematch'}), 150); setTimeout(() => send({t:'rematch'}), 400); }
  else { rematch(); }
};

function resetLobby(){
  cleanup(); hostCode = '';
  $('waitBox').classList.add('hidden');
  lobbyMsg('');
  $('btnCreate').disabled = false; $('btnJoin').disabled = false;
}
function lobbyMsg(t, ok){ const m = $('lobbyMsg'); m.textContent = t; m.classList.toggle('ok', !!ok); }

// copiar / compartilhar
const canLink = /^https?:$/.test(location.protocol);
if (!canLink) $('btnShare').classList.add('hidden');
async function copyText(t){
  try { await navigator.clipboard.writeText(t); return true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (__) { return false; }
  }
}
$('btnCopy').onclick = async () => lobbyMsg((await copyText(hostCode)) ? 'Código copiado!' : 'Não foi possível copiar.', true);
$('btnShare').onclick = async () => {
  const url = location.origin + location.pathname + '?sala=' + hostCode;
  const text = 'Vem jogar Batalha na Rede comigo! Código da sala: ' + hostCode;
  if (navigator.share) {
    try { await navigator.share({title:'Batalha na Rede', text, url}); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  lobbyMsg((await copyText(url)) ? 'Link copiado! Mande para o seu amigo.' : 'Não foi possível copiar o link.', true);
};

// ---------- rede (PeerJS) ----------
function randomCode(){
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i=0;i<4;i++) s += c[Math.floor(Math.random()*c.length)];
  return s;
}
function watchSignal(p){
  p.on('disconnected', () => { if (peer === p && !p.destroyed) try{ p.reconnect() }catch(_){} });
}
function createRoom(){
  if (typeof Peer === 'undefined') return lobbyMsg('Não foi possível carregar o serviço online. Verifique sua internet.');
  cleanup(); lobbyMsg('Criando sala…');
  const code = randomCode();
  const p = new Peer(PREFIX + code, {config: ICE}); peer = p;
  p.on('open', () => {
    lobbyMsg(''); hostCode = code;
    $('roomCode').textContent = code;
    $('waitBox').classList.remove('hidden');
    $('btnCreate').disabled = true; $('btnJoin').disabled = true;
  });
  p.on('connection', c => {
    if (conn) { c.on('open', () => c.close()); return; }
    conn = c; setupConn(c, 'host', code);
  });
  p.on('error', e => {
    if (e.type === 'unavailable-id') createRoom();
    else lobbyMsg('Erro de conexão. Tente novamente.');
  });
  watchSignal(p);
}
function joinRoom(){
  const code = $('roomInput').value.trim().toUpperCase();
  if (code.length < 4) return lobbyMsg('Digite o código de 4 letras da sala.');
  if (typeof Peer === 'undefined') return lobbyMsg('Não foi possível carregar o serviço online. Verifique sua internet.');
  cleanup(); lobbyMsg('Entrando na sala…');
  const p = new Peer(undefined, {config: ICE}); peer = p;
  p.on('open', () => {
    const c = p.connect(PREFIX + code, {reliable:false});
    conn = c; setupConn(c, 'guest', code);
    setTimeout(() => { if (conn === c && !c.open && !running) { lobbyMsg('Não foi possível conectar. Confira o código e a internet.'); cleanup(); } }, 14000);
  });
  p.on('error', e => {
    lobbyMsg(e.type === 'peer-unavailable' ? 'Sala não encontrada.' : 'Erro de conexão. Tente novamente.');
    if (e.type === 'peer-unavailable') { if (conn) try{conn.close()}catch(_){} conn = null; }
  });
  watchSignal(p);
}
function setupConn(c, role, code){
  c.on('open', () => {
    mode = role; me = role === 'host' ? 0 : 1;
    inp = [{l:0,r:0,u:0},{l:0,r:0,u:0}];
    startGame(code); startPing();
  });
  c.on('data', onData);
  c.on('close', () => { if (running) opponentLeft(); });
  c.on('error', () => { if (running) opponentLeft(); });
}
function send(o){ if (conn && conn.open) try{ conn.send(o) }catch(_){} }
function onData(m){
  if (!m) return;
  lastRx = performance.now();
  if (m.t === 'pg') { send({t:'pn', ts:m.ts}); return; }
  if (m.t === 'pn') { rtt = Math.max(0, Date.now() - m.ts); updateTag(); return; }
  if (mode === 'host') {
    if (m.t === 'in') inp[1] = {l:m.l|0, r:m.r|0, u:m.u|0};
    else if (m.t === 'rematch' && G.ph === 'over') rematch();
  } else if (mode === 'guest' && m.t === 'st') {
    if (m.q <= lastQ) return; lastQ = m.q;
    G.net = m;
    G.s = m.s; G.ph = m.ph; G.w = m.w; G.msg = m.m;
    G.hitN = m.h|0; G.hitX = m.hx; G.hitY = m.hy; G.hitC = m.hc|0;
    if (!G.seen) { G.seen = true; G.P[0].x = m.p[0][0]; G.P[0].y = m.p[0][1]; G.P[1].x = m.p[1][0]; G.P[1].y = m.p[1][1]; G.B.x = m.b[0]; G.B.y = m.b[1]; }
    updateHud();
  }
}
function startPing(){
  stopPing(); lastRx = performance.now();
  pingTimer = setInterval(() => {
    send({t:'pg', ts:Date.now()});
    if (running && performance.now() - lastRx > 12000) opponentLeft('Conexão perdida');
  }, 2000);
}
function stopPing(){ if (pingTimer) clearInterval(pingTimer); pingTimer = null; rtt = null; }
function opponentLeft(msg){
  running = false;
  showOverlay(msg || 'O outro jogador saiu da sala', false);
  setTimeout(() => { if (!running) { cleanup(); show('menu'); } }, 2500);
}
function cleanup(){
  running = false; mode = null; stopPing(); unlockScreen(); releaseAll();
  const c = conn, p = peer; conn = null; peer = null;
  if (c) { try{c.close()}catch(_){} }
  if (p) { try{p.destroy()}catch(_){} }
}

// ---------- início ----------
function startLocal(){
  cleanup(); mode = 'local'; me = 0;
  inp = [{l:0,r:0,u:0},{l:0,r:0,u:0}];
  startGame('');
}
function startGame(code){
  newGame(); seq = 0; lastQ = 0; roomCode = code || ''; rtt = null; prevPh = ''; ovKey = '';
  parts.length = 0; trail.length = 0; flash = 0; shake = 0;
  $('nameA').textContent = TEAM[0].name; $('nameB').textContent = TEAM[1].name;
  $('nameA').classList.toggle('me', mode !== 'local' && me === 0);
  $('nameB').classList.toggle('me', mode !== 'local' && me === 1);
  buildPad(); hideOverlay(); updateHud(); updateTag(); show('game'); fit(); lockScreen();
  running = true; tLast = performance.now(); acc = 0; tick = 0; fxLevel = 1; ema = 16.7; slow = 0;
  startLoop();
}
function rematch(){
  newGame(); hideOverlay(); updateHud();
}
function updateTag(){
  $('rtCode').textContent = roomCode ? 'Sala ' + roomCode : '';
  const p = $('rtPing');
  if (rtt == null || !roomCode) { p.textContent = ''; p.removeAttribute('data-q'); }
  else { p.textContent = '● ' + rtt + ' ms'; p.dataset.q = rtt < 80 ? 'g' : rtt < 170 ? 'y' : 'r'; }
}

// ---------- tela ligada / tela cheia / som / botões ----------
async function lockScreen(){
  try { if ('wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (_) {}
}
function unlockScreen(){ try{ wl && wl.release() }catch(_){} wl = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (running) lockScreen(); } else releaseAll();
});

$('btnPad').onclick = () => {
  const vis = getComputedStyle($('pad')).display !== 'none';
  document.body.dataset.pad = vis ? 'off' : 'on';
  setTimeout(fit, 50);
};
$('btnMute').onclick = () => { muted = !muted; $('btnMute').textContent = muted ? '🔇' : '🔊'; };

// ---------- som ----------
function audio(){
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
addEventListener('pointerdown', audio); addEventListener('keydown', audio);
function beep(f, d, type, v, slide){
  if (!AC || muted) return;
  const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + slide), t + d);
  g.gain.setValueAtTime(v || .06, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
  o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + d + .02);
}
function sfx(c){
  if (!audio() || muted) return;
  if (c === 0 || c === 1) beep(c ? 620 : 520, .1, 'triangle', .08, -180);
  else if (c === 2) beep(240, .08, 'square', .04, -60);
  else if (c === 4) beep(330, .06, 'sine', .05, -80);
  else beep(c === 10 ? 440 : 660, .2, 'sawtooth', .05, 240);
}
function jingle(){ [523,659,784,1047].forEach((f,i) => setTimeout(() => beep(f, .16, 'triangle', .07), i * 110)); }

// ---------- controles ----------
function setKey(p, k, v){ if (p >= 0 && p < 2) inp[p][k] = v ? 1 : 0; }
function releaseAll(){
  inp = [{l:0,r:0,u:0},{l:0,r:0,u:0}];
  document.querySelectorAll('.pb.on').forEach(b => b.classList.remove('on'));
}
const KEYS = {
  KeyA:['l',0], KeyD:['r',0], KeyW:['u',0], ArrowLeft:['l',1], ArrowRight:['r',1], ArrowUp:['u',1]
};
function keyHandler(e, v){
  const k = KEYS[e.code]; if (!k || !running) return;
  e.preventDefault();
  const p = mode === 'local' ? k[1] : me;
  setKey(p, k[0], v);
}
addEventListener('keydown', e => keyHandler(e, 1));
addEventListener('keyup', e => keyHandler(e, 0));
addEventListener('blur', releaseAll);

function buildPad(){
  const pad = $('pad'); pad.innerHTML = ''; pad.classList.toggle('local', mode === 'local');
  const mk = (p, k, txt, label) => {
    const b = document.createElement('button'); b.className = 'pb t' + p; b.textContent = txt; b.setAttribute('aria-label', label);
    const on = e => { e.preventDefault(); b.classList.add('on'); setKey(p, k, 1); try{ b.setPointerCapture(e.pointerId) }catch(_){} };
    const off = e => { e.preventDefault(); b.classList.remove('on'); setKey(p, k, 0); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
    b.addEventListener('contextmenu', e => e.preventDefault());
    return b;
  };
  const grp = () => { const d = document.createElement('div'); d.className = 'grp'; return d; };
  if (mode === 'local') {
    const a = grp(), b = grp();
    a.append(mk(0,'l','◀','Jogador 1 esquerda'), mk(0,'r','▶','Jogador 1 direita'), mk(0,'u','▲','Jogador 1 pular'));
    b.append(mk(1,'l','◀','Jogador 2 esquerda'), mk(1,'r','▶','Jogador 2 direita'), mk(1,'u','▲','Jogador 2 pular'));
    pad.append(a, b);
  } else {
    const a = grp(), b = grp();
    a.append(mk(me,'l','◀','Esquerda'), mk(me,'r','▶','Direita'));
    b.append(mk(me,'u','▲','Pular'));
    pad.append(a, b);
  }
}

// ---------- física (local e host) ----------
function hit(x, y, c){
  if (c < 10 && tick - G.hitT < 5) return;
  G.hitT = tick; G.hitN++; G.hitX = x; G.hitY = y; G.hitC = c;
}
function serve(){
  const s = G.server;
  G.P[0].x = 200; G.P[1].x = 600;
  G.P[0].y = G.P[1].y = FLOOR - PR; G.P[0].vy = G.P[1].vy = 0;
  G.B = {x: s === 0 ? 200 : 600, y:110, vx:0, vy:0};
  G.ph = 'serve'; G.t = 50; G.msg = 'Prepare-se!';
}
function step(){
  // jogadores
  for (let i = 0; i < 2; i++) {
    const p = G.P[i], c = inp[i];
    p.vx = (c.r - c.l) * 5.2;
    if (c.u && p.y >= FLOOR - PR - 0.01) p.vy = -13.5;
    p.vy += 0.6; p.x += p.vx; p.y += p.vy;
    if (p.y > FLOOR - PR) { p.y = FLOOR - PR; p.vy = 0; }
    const lo = i === 0 ? PR : NET_X + NET_HALF + PR, hi = i === 0 ? NET_X - NET_HALF - PR : W - PR;
    p.x = Math.max(lo, Math.min(hi, p.x));
  }
  if (G.ph === 'serve') { if (--G.t <= 0) { G.ph = 'play'; G.msg = ''; } return; }
  if (G.ph === 'point') { if (--G.t <= 0) serve(); return; }
  if (G.ph !== 'play') return;

  const b = G.B;
  b.vy += 0.3; b.x += b.vx; b.y += b.vy;
  if (b.x < BR) { b.x = BR; b.vx = Math.abs(b.vx); hit(b.x, b.y, 4); }
  if (b.x > W - BR) { b.x = W - BR; b.vx = -Math.abs(b.vx); hit(b.x, b.y, 4); }
  // rede (retângulo)
  const cx = Math.max(NET_X - NET_HALF, Math.min(NET_X + NET_HALF, b.x));
  const cy = Math.max(NET_TOP, Math.min(FLOOR, b.y));
  let dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy);
  if (d < BR) {
    if (d === 0) { dx = b.x < NET_X ? -1 : 1; dy = 0; d = 1; }
    const nx = dx / d, ny = dy / d;
    b.x = cx + nx * BR; b.y = cy + ny * BR;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { b.vx -= 1.8 * vn * nx; b.vy -= 1.8 * vn * ny; hit(b.x, b.y, 2); }
  }
  // jogadores
  for (let i = 0; i < 2; i++) {
    const p = G.P[i];
    dx = b.x - p.x; dy = b.y - p.y; d = Math.hypot(dx, dy);
    if (d < BR + PR && d > 0) {
      const nx = dx / d, ny = dy / d;
      b.x = p.x + nx * (BR + PR); b.y = p.y + ny * (BR + PR);
      const vn = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
      if (vn < 0) { b.vx -= 1.95 * vn * nx; b.vy -= 1.95 * vn * ny; hit(b.x, b.y, i); }
    }
  }
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > 15) { b.vx *= 15 / sp; b.vy *= 15 / sp; }
  // chão = ponto
  if (b.y + BR >= FLOOR) {
    b.y = FLOOR - BR;
    const scorer = b.x < NET_X ? 1 : 0;
    G.s[scorer]++; G.server = scorer;
    hit(b.x, FLOOR, 10 + scorer);
    if (G.s[scorer] >= WIN) { G.ph = 'over'; G.w = scorer; G.msg = TEAM[scorer].name + ' venceu!'; }
    else { G.ph = 'point'; G.t = 70; G.msg = 'Ponto para o ' + TEAM[scorer].name; }
    updateHud();
  }
}

// ---------- loop ----------
function startLoop(){
  const id = ++loopId;
  const f = now => { if (!running || id !== loopId) return; frame(now); requestAnimationFrame(f); };
  requestAnimationFrame(f);
}
function frame(now){
  const dtf = Math.min(100, now - tLast);
  acc += dtf; tLast = now;
  while (acc >= 1000/60) {
    acc -= 1000/60; tick++;
    if (mode === 'guest') guestTick(); else {
      step();
      if (mode === 'host') sendState();
    }
  }
  // se o aparelho for lento, reduz os efeitos para manter a jogabilidade
  ema = ema * .96 + dtf * .04;
  if (ema > 26 && fxLevel) { if (++slow > 180) fxLevel = 0; } else slow = Math.max(0, slow - 1);
  handleFx(); updateOverlay();
  draw(now, Math.min(.05, dtf / 1000));
}
function r1(n){ return Math.round(n * 10) / 10; }
function sendState(){
  send({t:'st', q:++seq, p:[[r1(G.P[0].x),r1(G.P[0].y)],[r1(G.P[1].x),r1(G.P[1].y)]], b:[r1(G.B.x),r1(G.B.y)], s:G.s, ph:G.ph, w:G.w, m:G.msg,
        h:G.hitN, hx:r1(G.hitX), hy:r1(G.hitY), hc:G.hitC});
}
function guestTick(){
  const c = inp[me], str = c.l + '' + c.r + c.u;
  if (str !== lastSent || tick % 4 === 0) { lastSent = str; send({t:'in', l:c.l, r:c.r, u:c.u}); }
  const n = G.net; if (!n) return;
  const k = 0.55;
  for (let i = 0; i < 2; i++) { G.P[i].x += (n.p[i][0] - G.P[i].x) * k; G.P[i].y += (n.p[i][1] - G.P[i].y) * k; }
  G.B.x += (n.b[0] - G.B.x) * 0.6; G.B.y += (n.b[1] - G.B.y) * 0.6;
}
function handleFx(){
  if (G.hitN < seenHit) seenHit = 0;
  if (G.hitN > 0 && G.hitN !== seenHit) {
    seenHit = G.hitN;
    const c = G.hitC;
    const col = c < 2 ? TEAM[c].c : c >= 10 ? TEAM[c - 10].c : '#ffffff';
    const point = c >= 10;
    burst(G.hitX, G.hitY, col, point ? 38 : 14, point ? 280 : 190);
    sfx(c);
    if (point) { flash = 1; flashCol = col; shake = 1; }
  }
  if (G.ph === 'over' && prevPh !== 'over') jingle();
  prevPh = G.ph;
}

// ---------- HUD ----------
function updateHud(){ $('scoreA').textContent = G.s[0]; $('scoreB').textContent = G.s[1]; }
function setOverlay(t, btn){
  const k = t + '|' + btn; if (k === ovKey) return; ovKey = k;
  if (t === null) { $('overlay').classList.add('hidden'); return; }
  $('overlayText').textContent = t; $('btnRematch').classList.toggle('hidden', !btn); $('overlay').classList.remove('hidden');
}
function showOverlay(t, btn){ setOverlay(t, btn); }
function hideOverlay(){ setOverlay(null, false); }
function updateOverlay(){
  if (G.ph === 'over') showOverlay(G.msg, true);
  else if (G.ph === 'point' || G.ph === 'serve') showOverlay(G.msg, false);
  else hideOverlay();
}

// ---------- tamanho do canvas (nítido em telas retina) ----------
let bg = null;
function fit(){
  const r = stage.getBoundingClientRect(); if (!r.width) return;
  let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  if (r.width * dpr > 1600) dpr = 1600 / r.width;   // limita pixels em monitores enormes
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; bg = null; SP = null; }
}
if ('ResizeObserver' in window) new ResizeObserver(fit).observe(stage);
addEventListener('resize', fit);
addEventListener('orientationchange', () => setTimeout(fit, 250));

// ---------- desenho (leve: tudo que é estático vira imagem pré-renderizada) ----------
function rng(seed){ return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function rr(x, y, w, h, r){ ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function rrx(c, x, y, w, h, r){ c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); }

let SP = null, SS = 1;          // SP = sprites, SS = pixels por unidade lógica
function spr(w, h, fn){
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * SS)); c.height = Math.max(1, Math.round(h * SS));
  const x = c.getContext('2d'); x.setTransform(SS, 0, 0, SS, w / 2 * SS, h / 2 * SS);
  fn(x); return {c, w, h};
}
function build(){
  SS = cv.width / W;
  buildBg(); SP = {gl:{}, bot:[], lbl:[]};
  [['m','#ff2d95'],['c','#19e3ff'],['l','#c6ff3d']].forEach(([k, col]) => {
    SP.gl[k] = spr(100, 100, x => {
      const g = x.createRadialGradient(0,0,0,0,0,50); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, 50, 0, 7); x.fill();
    });
  });
  TEAM.forEach((T, i) => {
    SP.bot[i] = spr(100, 110, x => {
      let g = x.createRadialGradient(-10, -13, 3, 0, 0, PR);
      g.addColorStop(0, '#4b5694'); g.addColorStop(.55, '#1a2150'); g.addColorStop(1, '#080b24');
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, PR, 0, 7); x.fill();
      x.save(); x.shadowColor = T.c; x.shadowBlur = 14 * SS; x.strokeStyle = T.c; x.lineWidth = 3;
      x.beginPath(); x.arc(0, 0, PR - 1.5, 0, 7); x.stroke(); x.restore();
      x.strokeStyle = T.c; x.globalAlpha = .55; x.lineWidth = 2; x.setLineDash([10, 6]);
      x.beginPath(); x.arc(0, 0, PR - 8, 0, 7); x.stroke(); x.setLineDash([]); x.globalAlpha = 1;
      x.fillStyle = '#04061a'; x.strokeStyle = T.c; x.lineWidth = 1.5; rrx(x, -20, -10, 40, 17, 7); x.fill(); x.stroke();
      x.fillStyle = T.c; x.globalAlpha = .8; x.fillRect(-8, 15, 16, 3); x.globalAlpha = 1;
      x.strokeStyle = '#8c9ad8'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, -PR); x.lineTo(0, -PR - 9); x.stroke();
      x.fillStyle = 'rgba(255,255,255,.12)'; x.beginPath(); x.ellipse(-12, -20, 12, 6, -.6, 0, 7); x.fill();
    });
    SP.lbl[i] = spr(44, 30, x => {
      x.fillStyle = T.c; x.font = '700 10px Orbitron, sans-serif'; x.textAlign = 'center';
      x.fillText('VOCÊ', 0, -3);
      x.beginPath(); x.moveTo(-5, 1); x.lineTo(5, 1); x.lineTo(0, 7); x.fill();
    });
  });
  SP.ballBase = spr(64, 64, x => {
    const g = x.createRadialGradient(-5, -6, 2, 0, 0, BR);
    g.addColorStop(0, '#fbffe0'); g.addColorStop(.45, '#c6ff3d'); g.addColorStop(1, '#3f7d00');
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, BR, 0, 7); x.fill();
    x.shadowColor = '#c6ff3d'; x.shadowBlur = 12 * SS; x.strokeStyle = '#f3ffc4'; x.lineWidth = 2;
    x.beginPath(); x.arc(0, 0, BR - 1, 0, 7); x.stroke();
  });
  SP.ballLines = spr(40, 40, x => {
    x.beginPath(); x.arc(0, 0, BR, 0, 7); x.clip();
    x.strokeStyle = 'rgba(8,30,0,.65)'; x.lineWidth = 1.6;
    for (let k = 0; k < 3; k++) { x.rotate(Math.PI / 3); x.beginPath(); x.ellipse(0, 0, BR * .5, BR * 1.1, 0, 0, 7); x.stroke(); }
  });
  const hg = FLOOR - NET_TOP;
  SP.net = spr(40, hg + 20, x => {
    const top = -hg / 2, bot = hg / 2;
    x.save(); x.shadowColor = '#fff'; x.shadowBlur = 10 * SS;
    const g = x.createLinearGradient(0, top, 0, bot); g.addColorStop(0, '#fff'); g.addColorStop(1, '#bdf6ff');
    x.fillStyle = g; x.fillRect(-2, top, 4, hg); x.restore();
    x.fillStyle = '#0b0f2e'; x.strokeStyle = '#d6f8ff'; x.lineWidth = 1.5;
    rrx(x, -7, top - 6, 14, 9, 3); x.fill(); x.stroke();
    rrx(x, -17, bot - 3, 34, 9, 3); x.fill(); x.stroke();
  });
  SP.field = spr(36, hg, x => {
    const g = x.createLinearGradient(-18, 0, 18, 0);
    g.addColorStop(0, 'rgba(255,45,149,0)'); g.addColorStop(.35, 'rgba(255,45,149,.22)');
    g.addColorStop(.5, 'rgba(255,255,255,.4)'); g.addColorStop(.65, 'rgba(25,227,255,.22)'); g.addColorStop(1, 'rgba(25,227,255,0)');
    x.fillStyle = g; x.fillRect(-18, -hg / 2, 36, hg);
  });
}
function buildBg(){
  bg = document.createElement('canvas'); bg.width = cv.width; bg.height = cv.height;
  const c = bg.getContext('2d'); c.setTransform(bg.width / W, 0, 0, bg.height / H, 0, 0);
  const sky = c.createLinearGradient(0, 0, 0, HORIZON);
  sky.addColorStop(0, '#05061a'); sky.addColorStop(.6, '#1a0a40'); sky.addColorStop(1, '#4a0f62');
  c.fillStyle = sky; c.fillRect(0, 0, W, HORIZON + 1);
  // estrelas
  c.fillStyle = '#fff';
  for (let i = 0; i < 36; i++) { const R = rng(i * 97 + 13); c.globalAlpha = .3 + R() * .5; c.fillRect(R() * W, R() * (HORIZON - 40), R() * 1.4 + .6, R() * 1.4 + .6); }
  c.globalAlpha = 1;
  // sol sintético
  c.save(); c.beginPath(); c.rect(0, 0, W, HORIZON); c.clip();
  let g = c.createLinearGradient(0, 50, 0, 150);
  g.addColorStop(0, '#ffd35a'); g.addColorStop(.5, '#ff5fa2'); g.addColorStop(1, '#a63cff');
  c.globalAlpha = .9; c.fillStyle = g; c.beginPath(); c.arc(400, 112, 62, 0, 7); c.fill(); c.globalAlpha = 1;
  c.fillStyle = sky; for (let i = 0; i < 6; i++) c.fillRect(330, 104 + i * 9, 140, 2 + i * 1.2);
  c.restore();
  // cidade
  const R = rng(7); let x = -10;
  while (x < W) {
    const w = 22 + R() * 34, h = 18 + R() * 58;
    c.fillStyle = '#0a0b2a'; c.fillRect(x, HORIZON - h, w, h);
    c.strokeStyle = 'rgba(60,90,255,.55)'; c.lineWidth = 1; c.strokeRect(x + .5, HORIZON - h + .5, w - 1, h - 1);
    for (let wy = HORIZON - h + 5; wy < HORIZON - 4; wy += 7)
      for (let wx = x + 4; wx < x + w - 4; wx += 7)
        if (R() > .62) { c.fillStyle = R() > .5 ? 'rgba(25,227,255,.7)' : 'rgba(255,45,149,.65)'; c.fillRect(wx, wy, 3, 3); }
    x += w + R() * 6;
  }
  // chão
  g = c.createLinearGradient(0, HORIZON, 0, H);
  g.addColorStop(0, '#2a0a52'); g.addColorStop(.25, '#0e0a30'); g.addColorStop(1, '#070818');
  c.fillStyle = g; c.fillRect(0, HORIZON, W, H - HORIZON);
  c.fillStyle = 'rgba(255,45,149,.05)'; c.fillRect(0, FLOOR, NET_X, H - FLOOR);
  c.fillStyle = 'rgba(25,227,255,.05)'; c.fillRect(NET_X, FLOOR, NET_X, H - FLOOR);
  // grade em perspectiva
  c.lineWidth = 1; c.strokeStyle = 'rgba(122,92,255,.45)'; c.beginPath();
  for (let i = -7; i <= 7; i++) { c.moveTo(400 + i * 12, HORIZON); c.lineTo(400 + i * 112, H); }
  c.stroke();
  for (let k = 1; k <= 10; k++) {
    const t = k / 10, y = HORIZON + (H - HORIZON) * t * t;
    c.strokeStyle = 'rgba(25,227,255,' + (0.12 + 0.5 * t).toFixed(2) + ')';
    c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
  }
  // horizonte
  g = c.createLinearGradient(0, HORIZON - 6, 0, HORIZON + 14);
  g.addColorStop(0, 'rgba(255,45,149,0)'); g.addColorStop(.4, 'rgba(255,45,149,.75)'); g.addColorStop(1, 'rgba(255,45,149,0)');
  c.fillStyle = g; c.fillRect(0, HORIZON - 6, W, 20);
  c.fillStyle = '#ff7ac0'; c.fillRect(0, HORIZON, W, 1.5);
  // linha da quadra
  g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, TEAM[0].c); g.addColorStop(.49, TEAM[0].c2); g.addColorStop(.5, '#fff'); g.addColorStop(.51, TEAM[1].c2); g.addColorStop(1, TEAM[1].c);
  c.fillStyle = g; c.globalAlpha = .2; c.fillRect(0, FLOOR - 2, W, 10); c.globalAlpha = .95; c.fillRect(0, FLOOR + 1, W, 2); c.globalAlpha = 1;
  // linhas de varredura + vinheta
  c.fillStyle = 'rgba(0,0,0,.13)'; for (let y = 0; y < H; y += 3) c.fillRect(0, y, W, 1);
  g = c.createRadialGradient(W / 2, H / 2, H * .55, W / 2, H / 2, W * .62);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.5)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
}

function glow(k, x, y, rx, ry, a){
  ctx.globalAlpha = a; ctx.drawImage(SP.gl[k].c, x - rx, y - ry, rx * 2, ry * 2);
}
function img(s, x, y){ ctx.drawImage(s.c, x - s.w / 2, y - s.h / 2, s.w, s.h); }

// partículas
const parts = [], trail = [];
function burst(x, y, col, n, spd){
  if (!fxLevel) n = Math.ceil(n / 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, s = spd * (.25 + Math.random() * .75);
    parts.push({x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s - 30, l:0, d:.45 + Math.random()*.5, col, r:1.6 + Math.random()*2});
  }
  if (parts.length > 90) parts.splice(0, parts.length - 90);
}
function drawParts(dt){
  if (!parts.length) return;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.l += dt;
    if (p.l >= p.d) { parts.splice(i, 1); continue; }
    p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    ctx.globalAlpha = 1 - p.l / p.d; ctx.fillStyle = p.col; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

function drawNet(now){
  const hgt = FLOOR - NET_TOP, cy = NET_TOP + hgt / 2;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = .8 + .2 * Math.sin(now / 90) * Math.sin(now / 37);
  ctx.drawImage(SP.field.c, NET_X - 18, NET_TOP, 36, hgt);
  ctx.globalAlpha = .55; ctx.fillStyle = '#fff';
  for (let k = 0; k < 4; k++) ctx.fillRect(NET_X - 8, FLOOR - ((now / 9 + k * hgt / 4) % hgt), 16, 1.5);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  img(SP.net, NET_X, cy);
}

function drawBot(p, i, now){
  const T = TEAM[i], air = p.y < FLOOR - PR - 1;
  const moving = p.lx !== undefined && Math.abs(p.x - p.lx) > 0.4; p.lx = p.x;
  if (air || moving) {
    const f = 10 + Math.random() * 8 + (air ? 6 : 0);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .75; ctx.fillStyle = T.c2;
    ctx.beginPath(); ctx.moveTo(p.x - 10, p.y + PR - 5); ctx.lineTo(p.x + 10, p.y + PR - 5); ctx.lineTo(p.x, p.y + PR + f); ctx.fill();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  img(SP.bot[i], p.x, p.y);
  // olhos seguem a bola
  const bx = G.B.x - p.x, by = G.B.y - p.y, bl = Math.hypot(bx, by) || 1, lx = bx / bl * 3.5, ly = by / bl * 2.5;
  ctx.fillStyle = T.c2;
  ctx.fillRect(p.x - 12 + lx, p.y - 4 + ly, 8, 5); ctx.fillRect(p.x + 4 + lx, p.y - 4 + ly, 8, 5);
  // luz da antena
  ctx.globalAlpha = .6 + .4 * Math.sin(now / 220 + i); ctx.fillStyle = T.c;
  ctx.beginPath(); ctx.arc(p.x, p.y - PR - 11, 3.2, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  if (mode && mode !== 'local' && i === me) img(SP.lbl[i], p.x, p.y - PR - 24 + Math.sin(now / 260) * 2);
}

let ballRot = 0, lastBX = 0;
function drawBall(){
  const b = G.B;
  if (Math.abs(b.x - lastBX) < 40) ballRot += (b.x - lastBX) / BR;
  lastBX = b.x;
  ctx.globalCompositeOperation = 'lighter';
  if (fxLevel) {
    const last = trail[trail.length - 1];
    if (last && Math.hypot(last.x - b.x, last.y - b.y) > 60) trail.length = 0;
    trail.push({x:b.x, y:b.y}); if (trail.length > 6) trail.shift();
    trail.forEach((t, k) => { const f = k / trail.length, r = BR * (.5 + .9 * f); glow('l', t.x, t.y, r, r, f * .35); });
  }
  glow('l', b.x, b.y, BR * 2.6, BR * 2.6, .5);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  img(SP.ballBase, b.x, b.y);
  ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(ballRot);
  ctx.drawImage(SP.ballLines.c, -20, -20, 40, 40); ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(b.x - 6, b.y - 7, 5, 2.8, -.7, 0, 7); ctx.fill();
  if (b.y < -BR) {
    ctx.fillStyle = '#c6ff3d'; ctx.beginPath(); ctx.moveTo(b.x, 4); ctx.lineTo(b.x - 9, 18); ctx.lineTo(b.x + 9, 18); ctx.fill();
  }
}

function draw(now, dt){
  if (!bg || !SP) build();
  ctx.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
  ctx.fillStyle = '#04050f'; ctx.fillRect(0, 0, W, H);
  if (shake > 0 && fxLevel) ctx.translate((Math.random() - .5) * 8 * shake, (Math.random() - .5) * 8 * shake);
  ctx.drawImage(bg, 0, 0, W, H);
  // brilhos no chão (agrupados)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 2; i++) {
    const p = G.P[i], sc = 1 / (1 + Math.max(0, FLOOR - (p.y + PR)) / 150);
    glow(i ? 'c' : 'm', p.x, FLOOR + 3, 46 * sc, 9 * sc, .8 * sc);
  }
  const bs = 1 / (1 + Math.max(0, FLOOR - G.B.y) / 200);
  glow('l', G.B.x, FLOOR + 3, 26 * bs, 6 * bs, .6 * bs);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawNet(now);
  drawBot(G.P[0], 0, now); drawBot(G.P[1], 1, now);
  drawBall();
  drawParts(dt);
  if (flash > 0) {
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = flash * .16; ctx.fillStyle = flashCol;
    ctx.fillRect(-10, -10, W + 20, H + 20); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  flash = Math.max(0, flash - dt * 2.5); shake = Math.max(0, shake - dt * 3);
}


// ---------- entrar direto por link (?sala=ABCD) ----------
(() => {
  const q = new URLSearchParams(location.search).get('sala');
  if (!q) return;
  const c = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (c.length !== 4) return;
  resetLobby(); show('lobby'); $('roomInput').value = c; joinRoom();
})();
})();
