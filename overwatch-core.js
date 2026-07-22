/* ==========================================================================
   OVERWATCH — FACILITY CONTROL TERMINAL
   Core Engine: state, simulation, missions, achievements, audio, rendering
   ========================================================================== */
(() => {
'use strict';

/* ------------------------------------------------------------------------
   CONSTANTS
   ------------------------------------------------------------------------ */
const STORAGE_KEY = 'overwatch_profile_v1';

const STATION_DEFS = [
  { id:'power',   name:'POWER GRID'    },
  { id:'security',name:'SECURITY'      },
  { id:'comms',   name:'COMMS ARRAY'   },
  { id:'life',    name:'LIFE SUPPORT'  },
  { id:'data',    name:'DATA CORE'     },
];

const INCIDENT_TYPES = {
  surge:        { label:'POWER SURGE',        response:'stabilize' },
  interference: { label:'SIGNAL INTERFERENCE',response:'reroute'   },
  corruption:   { label:'DATA CORRUPTION',    response:'purge'     },
};
const INCIDENT_KEYS = Object.keys(INCIDENT_TYPES);

const RESPONSES = ['scan','stabilize','reroute','purge','lockdown'];
const RESPONSE_COST = { scan:8, stabilize:20, reroute:20, purge:20, lockdown:32 };

const DIFFICULTIES = {
  standard: { label:'STANDARD', incidentEvery:[6.5,10], regenRate:6.5, decay:1.6, wrongPenalty:14, lockdownPenalty:10, shiftLength:150 },
  elevated: { label:'ELEVATED', incidentEvery:[4.6,7.6], regenRate:5.6, decay:2.1, wrongPenalty:17, lockdownPenalty:12, shiftLength:165 },
  critical: { label:'CRITICAL', incidentEvery:[3.2,5.8], regenRate:4.8, decay:2.7, wrongPenalty:20, lockdownPenalty:14, shiftLength:180 },
};

const RANKS = [
  { min:0,     name:'STANDBY'      },
  { min:400,   name:'COMPETENT'    },
  { min:900,   name:'PROFICIENT'   },
  { min:1600,  name:'DISTINGUISHED'},
  { min:2600,  name:'EXEMPLARY'    },
  { min:4000,  name:'LEGENDARY'    },
];

const ACHIEVEMENTS = [
  { id:'first_contact', name:'First Contact',   desc:'Resolve your first incident.',                         check:p => p.totalResolved >= 1 },
  { id:'clean_sweep',   name:'Clean Sweep',     desc:'Complete a shift without a single wrong response.',    check:p => p.flagCleanShift },
  { id:'iron_nerves',   name:'Iron Nerves',     desc:'Reach a ×5 combo in one shift.',                       check:p => p.maxComboEver >= 5 },
  { id:'blackout',      name:'Blackout Survivor',desc:'Recover a station from below 10% back above 60%.',   check:p => p.flagBlackoutRecovery },
  { id:'overtime',      name:'Overtime',        desc:'Clear an Elevated difficulty shift.',                  check:p => p.clearedElevated },
  { id:'under_pressure',name:'Under Pressure',  desc:'Clear a Critical difficulty shift.',                   check:p => p.clearedCritical },
  { id:'perfect_shift', name:'Perfect Shift',   desc:'Finish a shift at 100% facility integrity.',           check:p => p.flagPerfectShift },
  { id:'century',       name:'Century',         desc:'Reach 10,000 lifetime score.',                        check:p => p.lifetimeScore >= 10000 },
  { id:'veteran',       name:'Veteran Operator',desc:'Reach Clearance Level 5.',                              check:p => p.clearance >= 5 },
  { id:'panic_button',  name:'Panic Button',    desc:'Use Lockdown 10 times total.',                         check:p => p.totalLockdowns >= 10 },
  { id:'marathon',      name:'Marathon',        desc:'Complete 10 shifts.',                                  check:p => p.shiftsPlayed >= 10 },
  { id:'untouchable',   name:'Untouchable',     desc:'Clear a shift without ever using Lockdown.',           check:p => p.flagNoLockdownShift },
];

const OBJECTIVE_POOL = [
  { id:'resolve_n', make:(cl)=>({ id:'resolve_n', desc:`Resolve ${6+cl} incidents`, target:6+cl, key:'resolved', progress:0 }) },
  { id:'combo_c',   make:(cl)=>({ id:'combo_c', desc:`Reach a ×${(2+Math.min(cl*0.4,3)).toFixed(1)} combo`, target:+(2+Math.min(cl*0.4,3)).toFixed(1), key:'bestCombo', progress:0 }) },
  { id:'hold_integrity', make:(cl)=>({ id:'hold_integrity', desc:`End the shift at ${Math.max(50,70-cl*2)}% facility integrity or higher`, target:Math.max(50,70-cl*2), key:'endIntegrity', progress:0, evalAtEnd:true }) },
  { id:'limit_wrong', make:(cl)=>({ id:'limit_wrong', desc:`Limit wrong responses to ${Math.max(2,4-Math.floor(cl/2))} or fewer`, target:Math.max(2,4-Math.floor(cl/2)), key:'wrongMax', progress:0, isLimit:true, evalAtEnd:true } ) },
];

/* ------------------------------------------------------------------------
   AUDIO ENGINE — synthesized console tones, no external files
   ------------------------------------------------------------------------ */
const Audio_ = {
  ctx:null,
  ensure(){ if(!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ this.ctx=null; } } return this.ctx; },
  tone(freq, dur, type='sine', gainPeak=0.18, delay=0){
    if(!Profile.settings.audio) return;
    const ctx = this.ensure(); if(!ctx) return;
    const vol = (Profile.settings.volume/100) * gainPeak;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(vol,0.001), t0+0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0+dur+0.02);
  },
  click(){ this.tone(720,0.06,'square',0.10); },
  select(){ this.tone(520,0.09,'triangle',0.12); },
  good(){ this.tone(660,0.09,'sine',0.16); this.tone(880,0.12,'sine',0.14,0.07); },
  bad(){ this.tone(180,0.22,'sawtooth',0.16); },
  alarm(){ this.tone(300,0.16,'square',0.14); this.tone(220,0.2,'square',0.12,0.14); },
  scan(){ this.tone(980,0.05,'sine',0.10); this.tone(1180,0.05,'sine',0.09,0.05); },
  achievement(){ [523,659,784,1047].forEach((f,i)=>this.tone(f,0.18,'sine',0.14,i*0.09)); },
};

/* ------------------------------------------------------------------------
   PROFILE / SAVE SYSTEM
   ------------------------------------------------------------------------ */
function defaultProfile(){
  return {
    callsign:'OPERATOR-' + Math.floor(100+Math.random()*899),
    clearance:1,
    bestScore:0,
    lifetimeScore:0,
    shiftsPlayed:0,
    totalResolved:0,
    totalLockdowns:0,
    maxComboEver:1,
    clearedElevated:false,
    clearedCritical:false,
    achievementsUnlocked:[],
    settings:{ audio:true, crt:true, motion:false, volume:55 },
    savedShift:null,
  };
}
let Profile = defaultProfile();

function loadProfile(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){ const parsed = JSON.parse(raw); Profile = Object.assign(defaultProfile(), parsed); Profile.settings = Object.assign(defaultProfile().settings, parsed.settings||{}); }
  }catch(e){ Profile = defaultProfile(); }
}
function saveProfile(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(Profile)); }catch(e){ /* storage unavailable */ }
}

/* ------------------------------------------------------------------------
   DOM HELPERS
   ------------------------------------------------------------------------ */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function showScreen(id){
  $$('.screen').forEach(s=>s.classList.add('hidden'));
  const el = document.getElementById(id);
  if(el) el.classList.remove('hidden');
}
function openModal(id){ document.getElementById(id).classList.remove('hidden'); }
function closeModal(id){ document.getElementById(id).classList.add('hidden'); }

function toast(msg, kind='info'){
  const layer = $('#toast-layer');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  layer.appendChild(el);
  setTimeout(()=>el.remove(), 3200);
}

/* ------------------------------------------------------------------------
   BOOT SEQUENCE
   ------------------------------------------------------------------------ */
const BOOT_LINES = [
  'Initializing terminal kernel',
  'Mounting facility sensor array',
  'Calibrating integrity telemetry',
  'Loading operator profile',
  'Establishing console uplink',
  'Ready.',
];
function runBootSequence(){
  const linesEl = $('#boot-lines');
  const pctEl = $('#boot-percent-num');
  const ring = $('.boot-ring-progress');
  let i = 0;
  const total = BOOT_LINES.length;
  function step(){
    if(i >= total){
      setTimeout(()=>{
        showScreen('main-menu');
        populateMenuStats();
      }, 260);
      return;
    }
    const div = document.createElement('div');
    div.className = 'boot-line';
    const isLast = i === total-1;
    div.innerHTML = isLast ? `<span class="ok">✓</span> ${BOOT_LINES[i]}` : `${BOOT_LINES[i]}<span class="ok">…ok</span>`;
    linesEl.appendChild(div);
    i++;
    const pct = Math.round((i/total)*100);
    pctEl.textContent = pct;
    const dashoffset = 264 - (264*pct/100);
    ring.style.strokeDashoffset = dashoffset;
    setTimeout(step, 260 + Math.random()*220);
  }
  step();
}

/* ------------------------------------------------------------------------
   MENU POPULATION
   ------------------------------------------------------------------------ */
function populateMenuStats(){
  $('#operator-callsign').textContent = Profile.callsign;
  $('#stat-clearance').textContent = `LEVEL ${Profile.clearance}`;
  $('#stat-bestscore').textContent = String(Profile.bestScore).padStart(6,'0');
  $('#stat-shifts').textContent = Profile.shiftsPlayed;
  $('#stat-achv').textContent = `${Profile.achievementsUnlocked.length} / ${ACHIEVEMENTS.length}`;
  $('#btn-continue').disabled = !Profile.savedShift;
  applySettingsToUI();
}

function tickClock(){
  const now = new Date();
  $('#clock-readout').textContent = now.toTimeString().slice(0,8);
}

/* ------------------------------------------------------------------------
   SETTINGS
   ------------------------------------------------------------------------ */
function applySettingsToUI(){
  $('#toggle-audio').dataset.on = String(Profile.settings.audio);
  $('#toggle-audio').setAttribute('aria-checked', String(Profile.settings.audio));
  $('#toggle-crt').dataset.on = String(Profile.settings.crt);
  $('#toggle-crt').setAttribute('aria-checked', String(Profile.settings.crt));
  $('#toggle-motion').dataset.on = String(Profile.settings.motion);
  $('#toggle-motion').setAttribute('aria-checked', String(Profile.settings.motion));
  $('#range-volume').value = Profile.settings.volume;
  document.body.classList.toggle('crt-off', !Profile.settings.crt);
  document.body.classList.toggle('reduced-motion', Profile.settings.motion);
}
function wireSettings(){
  $('#toggle-audio').addEventListener('click', ()=>{ Profile.settings.audio = !Profile.settings.audio; applySettingsToUI(); saveProfile(); Audio_.click(); });
  $('#toggle-crt').addEventListener('click', ()=>{ Profile.settings.crt = !Profile.settings.crt; applySettingsToUI(); saveProfile(); });
  $('#toggle-motion').addEventListener('click', ()=>{ Profile.settings.motion = !Profile.settings.motion; applySettingsToUI(); saveProfile(); });
  $('#range-volume').addEventListener('input', e=>{ Profile.settings.volume = +e.target.value; saveProfile(); });
  $('#btn-reset-progress').addEventListener('click', ()=>{
    if(confirm('Reset all progress? This clears your clearance level, best score, and commendations.')){
      const settings = Profile.settings;
      Profile = defaultProfile();
      Profile.settings = settings;
      saveProfile();
      populateMenuStats();
      toast('Progress reset', 'warn');
    }
  });
}

/* ------------------------------------------------------------------------
   ACHIEVEMENTS MODAL
   ------------------------------------------------------------------------ */
function renderAchievements(){
  const grid = $('#achv-grid');
  grid.innerHTML = '';
  ACHIEVEMENTS.forEach(a=>{
    const unlocked = Profile.achievementsUnlocked.includes(a.id);
    const card = document.createElement('div');
    card.className = 'achv-card' + (unlocked ? ' unlocked' : '');
    card.innerHTML = `<div class="achv-icon">${unlocked ? '★' : '☆'}</div>
      <div><div class="achv-name">${a.name}</div><div class="achv-desc">${a.desc}</div></div>`;
    grid.appendChild(card);
  });
}
function checkAchievements(sessionFlags){
  const merged = Object.assign({}, Profile, sessionFlags);
  let newlyUnlocked = [];
  ACHIEVEMENTS.forEach(a=>{
    if(!Profile.achievementsUnlocked.includes(a.id) && a.check(merged)){
      Profile.achievementsUnlocked.push(a.id);
      newlyUnlocked.push(a);
    }
  });
  if(newlyUnlocked.length){ Audio_.achievement(); }
  return newlyUnlocked;
}

/* ------------------------------------------------------------------------
   GAME STATE
   ------------------------------------------------------------------------ */
let G = null; // active game session
let tickHandle = null;

function buildObjectives(clearance){
  // pick 3 distinct objectives from pool, scaled to clearance
  const pool = [...OBJECTIVE_POOL];
  const chosen = [];
  while(chosen.length < 3 && pool.length){
    const idx = Math.floor(Math.random()*pool.length);
    chosen.push(pool.splice(idx,1)[0].make(clearance));
  }
  return chosen;
}

function newSession(difficultyKey){
  const diff = DIFFICULTIES[difficultyKey];
  const stations = STATION_DEFS.map(s => ({
    id:s.id, name:s.name, integrity:100,
    incident:null, // { type, revealed }
  }));
  G = {
    difficultyKey, diff,
    stations,
    selectedStation: null,
    focus:100, maxFocus:100,
    score:0, combo:1, comboBestThisShift:1,
    resolved:0, wrong:0, lockdownsUsed:0,
    elapsed:0, shiftLength:diff.shiftLength,
    nextIncidentIn: rand(diff.incidentEvery[0], diff.incidentEvery[1]),
    objectives: buildObjectives(Profile.clearance),
    log:[],
    ended:false,
    flagCleanShift:true,
    flagNoLockdownShift:true,
    flagBlackoutRecovery:false,
    flagPerfectShift:false,
    lastActionAt:0,
  };
}

function rand(a,b){ return a + Math.random()*(b-a); }

/* ------------------------------------------------------------------------
   GAME LOOP
   ------------------------------------------------------------------------ */
function startGameLoop(){
  clearInterval(tickHandle);
  tickHandle = setInterval(gameTick, 200);
}
function stopGameLoop(){ clearInterval(tickHandle); tickHandle=null; }

function gameTick(){
  if(!G || G.ended) return;
  const dt = 0.2;
  G.elapsed += dt;

  // focus regen
  G.focus = Math.min(G.maxFocus, G.focus + G.diff.regenRate*dt);

  // incident spawn countdown
  G.nextIncidentIn -= dt;
  if(G.nextIncidentIn <= 0){
    trySpawnIncident();
    G.nextIncidentIn = rand(G.diff.incidentEvery[0], G.diff.incidentEvery[1]);
  }

  // decay for stations with unresolved incidents; slow regen for healthy stations
  G.stations.forEach(st=>{
    if(st.incident){
      st.integrity = Math.max(0, st.integrity - G.diff.decay*dt);
    } else if(st.integrity < 100){
      st.integrity = Math.min(100, st.integrity + 0.9*dt);
    }
  });

  // facility overall integrity
  const overall = facilityIntegrity();
  if(overall <= 0){
    endShift(false, 'meltdown');
    return;
  }

  // objective progress (live)
  updateObjectiveProgress();

  // timer expiry
  if(G.elapsed >= G.shiftLength){
    const allDone = G.objectives.every(o=>o.progress >= o.target || o.done);
    endShift(allDone, allDone ? 'complete' : 'timeout');
    return;
  }

  renderGame();
}

function facilityIntegrity(){
  const sum = G.stations.reduce((a,s)=>a+s.integrity,0);
  return sum / G.stations.length;
}

function trySpawnIncident(){
  const candidates = G.stations.filter(s=>!s.incident);
  if(!candidates.length) return;
  const st = candidates[Math.floor(Math.random()*candidates.length)];
  const key = INCIDENT_KEYS[Math.floor(Math.random()*INCIDENT_KEYS.length)];
  st.incident = { type:key, revealed:false };
  pushLog(`${st.name} reporting anomaly — classification pending.`, 'info');
  Audio_.alarm();
}

function pushLog(text, kind='info'){
  const time = formatTime(G.elapsed);
  G.log.push({ text, kind, time });
  if(G.log.length > 40) G.log.shift();
}

function formatTime(sec){
  const m = Math.floor(sec/60).toString().padStart(2,'0');
  const s = Math.floor(sec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

/* ------------------------------------------------------------------------
   OBJECTIVES
   ------------------------------------------------------------------------ */
function updateObjectiveProgress(){
  G.objectives.forEach(o=>{
    if(o.key === 'resolved') o.progress = G.resolved;
    if(o.key === 'bestCombo') o.progress = G.comboBestThisShift;
    if(o.key === 'endIntegrity') o.progress = facilityIntegrity();
    if(o.key === 'wrongMax') o.progress = G.wrong;
    if(o.isLimit){ o.done = o.progress <= o.target; }
    else { o.done = o.progress >= o.target; }
  });
}

/* ------------------------------------------------------------------------
   PLAYER ACTIONS
   ------------------------------------------------------------------------ */
function selectStation(id){
  G.selectedStation = id;
  Audio_.select();
  renderGame();
}

function performAction(actionKey){
  if(!G || G.ended) return;
  if(!G.selectedStation){ toast('Select a station first', 'warn'); return; }
  const st = G.stations.find(s=>s.id===G.selectedStation);
  if(!st){ return; }
  const cost = RESPONSE_COST[actionKey];
  if(G.focus < cost){ toast('Insufficient Focus', 'bad'); Audio_.bad(); return; }

  if(actionKey === 'scan'){
    if(!st.incident){ toast('Nothing to scan', 'warn'); return; }
    if(st.incident.revealed){ toast('Already identified', 'warn'); return; }
    G.focus -= cost;
    st.incident.revealed = true;
    pushLog(`${st.name} scan complete — identified as ${INCIDENT_TYPES[st.incident.type].label}.`, 'info');
    Audio_.scan();
    renderGame();
    return;
  }

  if(!st.incident){ toast('Station is nominal — nothing to respond to', 'warn'); return; }

  G.focus -= cost;

  if(actionKey === 'lockdown'){
    // guaranteed resolve, costly, breaks combo
    st.incident = null;
    const before = st.integrity;
    st.integrity = Math.max(0, st.integrity - G.diff.lockdownPenalty);
    if(before < 10 && st.integrity < 10) { /* still critical, no recovery flag */ }
    G.lockdownsUsed++;
    G.flagNoLockdownShift = false;
    G.combo = 1;
    G.score += 40;
    G.resolved++;
    Profile.totalLockdowns++;
    pushLog(`${st.name} force-locked down. Incident contained at cost.`, 'warn');
    Audio_.bad();
    renderGame();
    return;
  }

  const correct = st.incident.type && INCIDENT_TYPES[st.incident.type].response === actionKey;
  if(correct){
    const wasBelow10 = st.integrity < 10;
    st.incident = null;
    const recoveredTo = Math.min(100, st.integrity + 22);
    st.integrity = recoveredTo;
    if(wasBelow10 && recoveredTo >= 60) G.flagBlackoutRecovery = true;
    G.combo = +(G.combo + 0.3).toFixed(2);
    G.comboBestThisShift = Math.max(G.comboBestThisShift, G.combo);
    Profile.maxComboEver = Math.max(Profile.maxComboEver, G.combo);
    const points = Math.round(60 * G.combo);
    G.score += points;
    G.resolved++;
    Profile.totalResolved++;
    pushLog(`${st.name} incident resolved cleanly. +${points} pts.`, 'good');
    Audio_.good();
  } else {
    st.integrity = Math.max(0, st.integrity - G.diff.wrongPenalty);
    G.combo = 1;
    G.wrong++;
    G.flagCleanShift = false;
    pushLog(`${st.name} response mismatched — condition worsened.`, 'bad');
    Audio_.bad();
  }
  renderGame();
}

/* ------------------------------------------------------------------------
   RENDER
   ------------------------------------------------------------------------ */
function renderGame(){
  // HUD
  $('#hud-score').textContent = Math.round(G.score);
  $('#hud-combo').textContent = `×${G.combo.toFixed(1)}`;
  $('#hud-clearance').textContent = Profile.c
