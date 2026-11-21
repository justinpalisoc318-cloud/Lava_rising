// ===== SETTINGS =====
const START_RISE = 15;
const RISE_PER_ROUND = 3;
const MAX_LAVA = 100;

const START_CLIMB = 16;
const CLIMB_SHORT = 7;
const CLIMB_MEDIUM = 10;
const CLIMB_LONG = 14;
const BONUS_LONG = 5;

const BASE_TIME = 15;
const MIN_TIME = 8;

const KEY = "wordLavaHighScore";
const STATS_KEY = "wordLavaStatistics";
const DIFF_KEY = "wordLavaDifficulty";
const MUTE_KEY = "wordLavaMuted";

const BOSS_INTERVAL = 5;
const BOSS_WORDS = 2;
const LAST_CHANCE_LEVEL = 65;
const LAST_CHANCE_TIME = 7;
const EVENT_CHANCE = 0.35;
const MAX_MULTIPLIER = 5;

const ANNOUNCE_MS = 1400;   // how long the big "YOUR TURN" screen shows
const SPARK_COST = 5;       // score cost of the one-per-game Spark hint
const LOG_MAX = 6;          // recent words shown under the answer box

// Difficulty levels. These multiply the settings above.
// acc = bot word-knowing chance (capped 97%), speed = bot ms per letter, think = bot thinking time,
// rise = lava jump on time-out, time = seconds added to / removed from the turn timer
const DIFFICULTY = {
  easy:   { label: "Easy",   acc: 0.8,  speed: 1.4, think: 1.3,  rise: 0.7, time: 3,
            desc: "Slower, less accurate bots. Lava rises slowly and you get extra time." },
  normal: { label: "Normal", acc: 1,    speed: 1,   think: 1,    rise: 1,   time: 0,
            desc: "The standard Word Lava challenge." },
  hard:   { label: "Hard",   acc: 1.15, speed: 0.8, think: 0.75, rise: 1.3, time: -2,
            desc: "Sharp, fast bots. Lava rises quickly and the timer is shorter." }
};

// Random disaster events (rise = extra lava %, time = seconds removed)
const EVENTS = [
  { id: "heat",    name: "🔥 HEAT WAVE",        desc: "Lava rises an extra 10%!",    rise: 10, time: 0 },
  { id: "surge",   name: "🌋 LAVA SURGE",       desc: "Lava rises an extra 15%!",    rise: 15, time: 0 },
  { id: "breeze",  name: "❄️ COOL BREEZE",      desc: "Lava rise decreases by 5%!",  rise: -5, time: 0 },
  { id: "tremor",  name: "⚡ VOLCANIC TREMOR",  desc: "3 seconds less!",             rise: 0,  time: 3 }
];

// Players: you first, then two bots. faces = [normal, hot (60%+ lava), melted]
const PLAYERS = [
  { name: "You", bot: false, faces: ["🧑", "😰", "💀"], turnText: "YOUR TURN" },
  { name: "Juan", bot: true, faces: ["😎", "😅", "💀"], turnText: "JUAN'S TURN",
    acc: 0.7, maxLen: 7, speed: 200, think: [2, 5] },
  { name: "Maria", bot: true, faces: ["🤓", "😬", "💀"], turnText: "MARIA'S TURN",
    acc: 0.85, maxLen: 10, speed: 150, think: [1.5, 4] }
];

// ===== HELPERS =====
const $ = id => document.getElementById(id);
const screens = ["start", "how", "game", "over"];

const show = name => {
  screens.forEach(s => $(s).classList.toggle("hidden", s !== name));
  if (name !== "game") $("heat").style.opacity = 0.15;
};

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const climbFor = len => len >= 8 ? CLIMB_LONG : len >= 5 ? CLIMB_MEDIUM : CLIMB_SHORT;
const normalize = w => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const rand = (a, b) => a + Math.random() * (b - a);
const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newPlayers = () => PLAYERS.map(p => ({
  ...p, score: 0, combo: 0, mult: 1, lava: 0, climb: START_CLIMB, dead: false,
  tally: { words: 0, letters: 0, longBonus: 0, comboBonus: 0, lastBonus: 0, bosses: 0, timeouts: 0, longest: "", bestCombo: 0 }
}));

// ===== GAME STATE =====
let round = 0, turn = 0, used, current, timeLeft, roundTime;
let timerId, botTimer, transitionTimer, locked = true;
let players = newPlayers(), lastCats = [];
let bossRound = false, bossDone = 0, bossClimb = 0, activeEvent = null, lastChance = false;
let difficulty = load(DIFF_KEY, "normal");
if (!DIFFICULTY[difficulty]) difficulty = "normal";
let lastTickSec = 0;
let sparkUsed = false, wordLog = [], defaultPH = "";

const diff = () => DIFFICULTY[difficulty];
const botSpeed = p => p.speed * diff().speed;

// ===== SOUND (Web Audio API, no audio files) =====
let muted = !!load(MUTE_KEY, false);
let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone(freq, dur, opts = {}) {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const { type = "sine", vol = 0.15, at = 0, slideTo } = opts;
  const t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function rumble() {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const dur = 0.9, len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate), data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 140;
  const g = c.createGain(), t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.15);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(t);
}

const sfx = {
  good(len, soft) {
    const v = soft ? 0.07 : 0.15;
    tone(523, 0.14, { vol: v });
    tone(659, 0.14, { vol: v, at: 0.09 });
    tone(784, 0.2, { vol: v, at: 0.18 });
    if (len >= 8) tone(1047, 0.3, { vol: v, at: 0.28 });
  },
  bad() { tone(170, 0.28, { type: "sawtooth", vol: 0.12, slideTo: 80 }); },
  tick() { tone(880, 0.05, { type: "square", vol: 0.05 }); },
  rumble,
  turn(isYou) {
    if (isYou) { tone(660, 0.12, { vol: 0.12 }); tone(880, 0.18, { vol: 0.12, at: 0.1 }); }
    else tone(440, 0.1, { vol: 0.07 });
  },
  boss() {
    tone(196, 0.25, { type: "triangle", vol: 0.18 });
    tone(262, 0.25, { type: "triangle", vol: 0.18, at: 0.2 });
    tone(392, 0.4, { type: "triangle", vol: 0.18, at: 0.4 });
  },
  melt() { tone(400, 0.7, { type: "sawtooth", vol: 0.12, slideTo: 60 }); rumble(); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, { vol: 0.16, at: i * 0.14 })); },
  lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, { type: "triangle", vol: 0.15, at: i * 0.2 })); },
  // Spark hint: ascending arpeggio with an upward shimmer
  spark() {
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.18, { vol: 0.12, at: i * 0.07 }));
    tone(2093, 0.4, { vol: 0.05, at: 0.3, slideTo: 2637 });
  },
  // Heat Wave / Lava Surge: rising thermal sweep across two tones
  heat() {
    tone(220, 0.55, { type: "sawtooth", vol: 0.08, slideTo: 440 });
    tone(330, 0.55, { type: "triangle", vol: 0.08, at: 0.1, slideTo: 660 });
  },
  // Volcanic Tremor: low quake pulses plus rumble
  tremor() {
    [0, 0.12, 0.24, 0.36].forEach(a => tone(60, 0.1, { type: "square", vol: 0.1, at: a }));
    rumble();
  },
  // Cool Breeze: soft chimes
  breeze() {
    tone(880, 0.25, { vol: 0.05 });
    tone(1175, 0.3, { vol: 0.05, at: 0.12 });
    tone(1397, 0.4, { vol: 0.04, at: 0.24 });
  }
};

function renderMute() {
  const b = $("muteBtn");
  b.textContent = muted ? "🔇" : "🔊";
  b.setAttribute("aria-pressed", String(muted));
  b.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
}

function toggleMute() {
  muted = !muted;
  save(MUTE_KEY, muted);
  renderMute();
  if (!muted) sfx.good(0, true);
}

// ===== DIFFICULTY PICKER =====
function renderDifficulty() {
  document.querySelectorAll(".diffbtn").forEach(b => {
    b.setAttribute("aria-checked", String(b.dataset.diff === difficulty));
  });
  $("diffDesc").textContent = diff().desc;
}

function setDifficulty(name) {
  if (!DIFFICULTY[name]) return;
  difficulty = name;
  save(DIFF_KEY, name);
  renderDifficulty();
}

// ===== HIGH SCORE + STATISTICS (yours only) =====
const getBest = () => parseInt(load(KEY, 0), 10) || 0;
const getStats = () => ({
  gamesPlayed: 0, totalWords: 0, longestWord: "", bestRound: 0, totalScore: 0, highestScore: 0,
  ...load(STATS_KEY, {})
});

function refreshBest() {
  ["hsStart", "hsOver", "best"].forEach(id => $(id).textContent = getBest());
}

function renderStatistics() {
  const s = getStats();
  const avg = s.gamesPlayed ? Math.round(s.totalScore / s.gamesPlayed) : 0;
  const html = `
    <strong>📊 PERSONAL STATISTICS</strong>
    <div>🎮 Games Played: ${s.gamesPlayed}</div>
    <div>🏆 Best Round: ${s.bestRound}</div>
    <div>📝 Total Words: ${s.totalWords}</div>
    <div>📚 Longest Word: ${s.longestWord || "None yet"}</div>
    <div>⭐ Highest Score: ${s.highestScore}</div>
    <div>📈 Average Score: ${avg}</div>`;
  ["startStats", "overStats"].forEach(id => { if ($(id)) $(id).innerHTML = html; });
}

// ===== EXTRA UI: styles, lava lanes with characters, turn screen, stats cards =====
const CSS = `
  .tower{display:none!important}
  .feature-card{background:rgba(255,100,20,.1);border:1px solid rgba(255,130,40,.35);border-radius:10px;padding:12px;margin:12px 0;line-height:1.8;font-size:13px;text-align:left;color:#fff}
  #turnDisplay{color:#9fe870;font-weight:bold}
  #comboDisplay{color:#ffae42;font-weight:bold}
  #bossDisplay{color:#f66;font-weight:bold}
  #lastChanceDisplay{color:#f33;font-weight:bold}
  #eventBanner{color:#ffc45c;font-weight:bold;text-align:center}

  .mute{position:fixed;top:12px;right:12px;z-index:60;width:44px;height:44px;border-radius:50%;border:2px solid var(--ember);background:rgba(42,29,25,.85);color:var(--bone);font-size:1.3rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s,filter .15s}
  .mute:hover{transform:scale(1.08);filter:brightness(1.15)}
  .diff{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap}
  .diffbtn{font:inherit;font-weight:800;min-width:5.5rem;padding:.55rem 1.1rem;border-radius:.6rem;border:2px solid var(--border);background:var(--card);color:var(--muted);cursor:pointer;transition:color .15s,border-color .15s,transform .15s}
  .diffbtn:hover{color:var(--bone);border-color:var(--ember);transform:translateY(-1px)}
  .diffbtn[aria-checked="true"]{background:linear-gradient(180deg,var(--molten),var(--ember));color:#2b0e04;border-color:transparent;box-shadow:0 4px 14px rgba(255,90,20,.35)}
  .diffdesc{margin:0;min-height:2.6em;max-width:28rem;color:var(--muted);font-size:.9rem}

  #arena{display:flex;gap:.7rem;width:100%;justify-content:center;align-items:flex-end;margin-bottom:.8rem}
  .lane{position:relative;flex:1;max-width:170px;min-width:0;display:flex;flex-direction:column;align-items:center;gap:5px;transition:opacity .4s,filter .4s}
  .lane.dead{opacity:.5;filter:grayscale(.8)}
  .avatar{font-size:clamp(2rem,9vw,3rem);line-height:1}
  .lane.active .avatar{animation:none}
  @keyframes hop{to{transform:translateY(-8px)}}
  .pname{font-weight:800;font-size:.85rem}
  .lane.active .pname{color:var(--molten)}
  .pscore{font-size:.8rem;color:var(--muted)}
  .lane.leader .pscore{color:var(--molten);font-weight:800}

  .speech{min-height:30px;max-width:100%;padding:4px 10px;border-radius:12px;background:#fff6e8;color:#2b0e04;font-weight:800;font-size:.85rem;letter-spacing:.04em;opacity:0;transition:opacity .15s;position:relative;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .speech.on{opacity:1}
  .caret{display:inline-block;width:2px;height:1em;margin-left:2px;vertical-align:-2px;background:#2b0e04;animation:blink .6s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  .dots i{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#2b0e04;animation:dot 1s infinite}
  .dots i:nth-child(2){animation-delay:.15s}
  .dots i:nth-child(3){animation-delay:.3s}
  @keyframes dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-5px);opacity:1}}

  .lavatower{position:relative;width:100%;height:clamp(150px,26vh,230px);background:#120a08;border:3px solid #4a342c;border-radius:12px;overflow:hidden;box-shadow:inset 0 0 18px rgba(0,0,0,.8);transition:border-color .3s,box-shadow .3s}
  .lane.active .lavatower{border-color:var(--molten);box-shadow:0 0 16px rgba(255,176,0,.55),inset 0 0 18px rgba(0,0,0,.8)}
  .lavafill{position:absolute;left:0;right:0;bottom:0;height:0%;opacity:0;transition:height .9s ease,opacity .3s;
    background:
      radial-gradient(ellipse 24px 12px at 20% 30%,rgba(40,8,2,.55),transparent 70%),
      radial-gradient(ellipse 32px 14px at 70% 60%,rgba(40,8,2,.5),transparent 70%),
      radial-gradient(ellipse 18px 10px at 45% 85%,rgba(40,8,2,.5),transparent 70%),
      radial-gradient(circle at 60% 20%,rgba(255,240,150,.75),transparent 35%),
      linear-gradient(180deg,#ffd23f 0%,#ff8a1f 25%,#e8400c 60%,#8a1403 100%);
    background-size:90px 70px,110px 80px,80px 90px,70px 70px,100% 100%;
    animation:drift 7s linear infinite;
    box-shadow:0 -6px 20px rgba(255,120,20,.85),inset 0 10px 16px rgba(255,235,130,.55)}
  @keyframes drift{to{background-position:90px 0,-110px 0,80px 0,-70px 0,0 0}}
  .lavafill::before{content:"";position:absolute;left:0;right:0;top:-8px;height:12px;
    background:radial-gradient(circle at 10px 12px,#ffd23f 9px,transparent 10px) repeat-x;background-size:20px 12px;
    filter:drop-shadow(0 -2px 4px rgba(255,150,30,.8));animation:ripple 2.5s linear infinite}
  @keyframes ripple{to{background-position:20px 0}}
  .lbub{position:absolute;bottom:0;border-radius:50%;background:radial-gradient(circle at 30% 30%,rgba(255,250,200,.95),rgba(255,180,40,.5) 60%,transparent 70%);animation:lrise var(--d) ease-in forwards}
  @keyframes lrise{to{transform:translateY(calc(var(--h) * -1)) scale(1.2);opacity:0}}
  .ember{position:absolute;width:4px;height:4px;border-radius:50%;background:#ffcf5a;box-shadow:0 0 6px #ff8a1f;animation:eup var(--d) ease-out forwards}
  @keyframes eup{to{transform:translate(var(--x),-60px);opacity:0}}
  .lpct{position:absolute;bottom:6px;left:0;right:0;text-align:center;font-weight:800;color:#fff;text-shadow:0 1px 3px #000;z-index:2}
  .critical-mode{animation:criticalPulse .8s infinite alternate}
  @keyframes criticalPulse{from{box-shadow:0 0 5px #ff2222}to{box-shadow:0 0 24px #ff2222}}

  /* breeze motes + cool flash */
  .breeze{position:absolute;left:0;width:14px;height:3px;border-radius:2px;background:rgba(170,230,255,.85);animation:bz 1.6s ease-out forwards;z-index:3}
  @keyframes bz{from{transform:translateX(0);opacity:.9}to{transform:translateX(var(--x,80px));opacity:0}}
  .lavatower.cooled{animation:cool .7s}
  @keyframes cool{50%{box-shadow:0 0 24px #7fd4ff,inset 0 0 18px rgba(127,212,255,.5)}}

  /* screen shake + floating popups */
  .quake{animation:quake .4s}
  @keyframes quake{20%{transform:translate(-6px,3px)}40%{transform:translate(5px,-4px)}60%{transform:translate(-4px,2px)}80%{transform:translate(3px,-2px)}}
  .pop{position:absolute;top:28%;left:50%;font-weight:900;font-size:1.1rem;white-space:nowrap;z-index:5;pointer-events:none;text-shadow:0 2px 6px #000;animation:popUp 1.2s ease-out forwards}
  .pop.good{color:var(--good)}
  .pop.bad{color:var(--bad)}
  .pop.gold{color:var(--molten)}
  @keyframes popUp{from{opacity:1;transform:translate(-50%,0)}to{opacity:0;transform:translate(-50%,-55px)}}

  /* Spark hint glow + recent words log */
  #answer.spark{border-color:var(--molten)!important;box-shadow:0 0 0 3px rgba(255,176,0,.5),0 0 22px rgba(255,200,60,.7)!important}
  #wordLog{display:flex;flex-wrap:wrap;gap:.35rem;min-height:1.9rem;margin:.4rem 0;transition:opacity .3s}
  #wordLog.fade{opacity:0}
  .wbadge{font-size:.72rem;font-weight:800;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid var(--border);color:var(--muted)}
  .wbadge.mine{color:var(--bone)}
  .wbadge.latest{border-color:var(--molten);box-shadow:0 0 10px rgba(255,176,0,.5);color:var(--molten)}

  .tallywrap{overflow-x:auto}
  table.tally{width:100%;border-collapse:collapse;font-size:.8rem;text-align:center}
  .tally th,.tally td{padding:6px 4px;border-bottom:1px solid rgba(255,130,40,.25)}
  .tally th{font-size:.85rem}
  .tally td:first-child,.tally th:first-child{text-align:left;color:var(--muted)}
  .tally tr.total td{font-weight:900;color:var(--molten);font-size:.95rem;border-top:2px solid var(--ember)}

  #turnOverlay{position:fixed;inset:0;z-index:50;display:none;flex-direction:column;align-items:center;justify-content:center;gap:1rem;background:rgba(14,6,4,.92);pointer-events:none}
  #turnOverlay.show{display:flex;animation:turnIn .35s ease-out}
  @keyframes turnIn{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
  #turnFace{font-size:clamp(4rem,22vw,9rem);line-height:1}
  #turnText{font-size:clamp(2.4rem,11vw,6rem);font-weight:900;text-align:center;line-height:1;letter-spacing:-.02em;padding:0 1rem;background:linear-gradient(180deg,#ffb000,#ff5a1f);-webkit-background-clip:text;background-clip:text;color:transparent}

  @media (prefers-reduced-motion:reduce){.lavafill,.lavafill::before,.lane.active .avatar,.critical-mode,.quake,.pop,.breeze,.lavatower.cooled,#turnOverlay.show{animation:none}}
  /* Visual upgrade 01: polished volcanic arena */
  #arena{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:clamp(.55rem,2vw,1.25rem);align-items:stretch}
  .lane{max-width:none;padding:.8rem .7rem;border:1px solid rgba(255,151,73,.2);border-radius:16px;background:linear-gradient(180deg,rgba(37,31,32,.92),rgba(12,14,21,.96));box-shadow:inset 0 1px rgba(255,255,255,.04),0 12px 30px rgba(0,0,0,.25)}
  .lane.active{border-color:rgba(255,190,75,.85);box-shadow:0 0 0 1px rgba(255,170,58,.18),0 0 28px rgba(255,106,27,.16)}
  .avatar{font-size:clamp(2.5rem,5vw,4rem);filter:drop-shadow(0 5px 8px rgba(0,0,0,.55))}
  .lavatower{height:clamp(190px,28vh,280px);border-radius:11px;background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 2px,transparent 2px 34px),linear-gradient(180deg,#171a22,#090b10);box-shadow:inset 0 0 24px #000,0 7px 18px rgba(0,0,0,.35)}
  .lane.active .lavatower{border-color:var(--molten)}
  @media(max-width:680px){#arena{gap:.4rem}.lane{padding:.55rem .35rem}.lavatower{height:clamp(150px,25vh,205px)}.speech{font-size:.68rem;padding:4px 5px}.pname{font-size:.72rem}.pscore{font-size:.7rem}}
  @media(max-width:360px){#arena{gap:.25rem}.lane{padding:.4rem .2rem}.lavatower{height:145px}.avatar{font-size:2.1rem}}

  /* Reference alignment pass: compact standalone vertical towers */
  #arena{
    display:grid;
    grid-template-columns:repeat(3,minmax(0,210px));
    justify-content:center;
    align-items:end;
    gap:16px;
    width:100%;
    max-width:760px;
    margin:0 auto 1rem;
  }
  .lane{
    width:100%;
    max-width:210px;
    min-width:0;
    padding:0;
    gap:6px;
    border:0;
    border-radius:0;
    background:transparent;
    box-shadow:none;
  }
  .lane.active{
    border:0;
    background:transparent;
    box-shadow:none;
  }
  .avatar{font-size:clamp(2.35rem,4vw,3rem);margin-bottom:1px}
  .pname{font-size:.9rem;letter-spacing:.035em}
  .lavatower{
    width:100%;
    height:clamp(190px,30vh,240px);
    border:3px solid #4a342c;
    border-radius:14px;
    background:
      repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 2px,transparent 2px 42px),
      linear-gradient(180deg,#100b0b 0%,#090707 100%);
    box-shadow:inset 0 0 22px rgba(0,0,0,.9);
  }
  .lane.active .lavatower{
    border-color:var(--molten);
    box-shadow:0 0 18px rgba(255,176,0,.42),inset 0 0 22px rgba(0,0,0,.9);
  }
  .lpct{bottom:7px;font-size:1rem}
  .pscore{font-size:.82rem;margin-top:1px}
  @media(max-width:680px){
    #arena{grid-template-columns:repeat(3,minmax(0,1fr));gap:clamp(6px,2vw,12px);max-width:100%}
    .lane{padding:0;gap:5px}
    .lavatower{height:clamp(155px,27vh,210px)}
    .avatar{font-size:clamp(1.8rem,7vw,2.5rem)}
    .pname{font-size:.72rem}
  }
  @media(max-width:360px){#arena{gap:4px}.lavatower{height:145px}.avatar{font-size:1.8rem}}
  /* Upgrade 03: character artwork and state-based movement */
  .avatar{height:clamp(76px,11vw,112px);width:100%;display:flex;align-items:flex-end;justify-content:center;position:relative;z-index:4;overflow:visible;transition:transform .65s cubic-bezier(.2,.8,.2,1),filter .35s}
  .avatar img{height:100%;width:100%;object-fit:contain;object-position:center bottom;filter:drop-shadow(0 5px 9px rgba(0,0,0,.65));transition:transform .65s cubic-bezier(.2,.8,.2,1)}
  .avatar.climbing img{transform:translateY(calc(var(--climb,0px) * -1)) rotate(-2deg)}
  .avatar.fallen img{transform:translateY(18px) rotate(18deg) scale(.88);filter:grayscale(.8) brightness(.65)}
  .lane.active .avatar img{animation:none}
  .avatar.climbing img{animation:characterClimb .7s cubic-bezier(.2,.8,.2,1) 1}
  @keyframes characterBreath{to{transform:translateY(-3px)}}
  @keyframes characterClimb{0%,100%{translate:0 0;rotate:0deg}50%{translate:0 -9px;rotate:-4deg}}
  .lavatower{isolation:isolate;background:linear-gradient(90deg,rgba(255,255,255,.04),transparent 18%,transparent 82%,rgba(255,255,255,.035)),repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 2px,transparent 2px 38px),linear-gradient(180deg,#171216,#080607)}
  .lavafill{z-index:1}
  .lpct{z-index:3}
  @media(prefers-reduced-motion:reduce){.avatar img,.avatar.climbing img,.avatar.fallen img{transition:none;animation:none}}

  /* Character stays inside the tower: correct answers move it up; mistakes raise lava. */
  .lavatower{position:relative;overflow:hidden}
  .avatar{position:absolute;left:0;right:0;bottom:calc(var(--climb, 16) * 1%);height:34%;width:100%;margin:0;z-index:3;pointer-events:none}
  .avatar img{height:100%;width:100%;object-fit:contain;object-position:center bottom}
  .avatar.climbing img{transform:none}
  .avatar.fallen{bottom:0;opacity:.8}
  .lavafill{z-index:1}
  .lpct{z-index:4}

  /* FINAL VISUAL PASS: larger characters, clearer lava and stronger arena */
  #arena{max-width:860px;gap:clamp(10px,2.2vw,22px);margin:0 auto 1.15rem}
  #liveLeaderboard{max-width:860px;margin:0 auto 1rem;padding:12px 15px;border:1px solid rgba(255,174,66,.28);border-radius:12px;background:linear-gradient(135deg,rgba(35,25,22,.94),rgba(12,14,20,.96));color:#f4e8d8;text-align:left}
  #liveLeaderboard h3{margin:0 0 8px;font-size:.9rem;letter-spacing:.1em;color:#ffd05a}
  .leader-row{display:grid;grid-template-columns:34px 1fr auto auto;gap:9px;align-items:center;padding:6px 2px;border-top:1px solid rgba(255,255,255,.08);font-size:.86rem}
  .leader-row:first-of-type{border-top:0}.leader-rank{color:#ffbd59;font-weight:900}.leader-state{font-size:.76rem;color:#aeb4bd}.leader-row.eliminated{opacity:.48;text-decoration:line-through}
  .leader-points{font-weight:900;color:#ffd05a;font-variant-numeric:tabular-nums}
  .lane.eliminated .lavatower{filter:grayscale(.75);opacity:.72}
  .lane.eliminated .pname::after{content:' · OUT';color:#ff7568;font-size:.72em}
  .lane{max-width:245px;gap:8px}
  .pname{font-size:.88rem;font-weight:900;letter-spacing:.1em;color:#f4e8d8}
  .lane.active .pname{color:#ffd05a;text-shadow:0 0 12px rgba(255,174,44,.45)}
  .lavatower{
    height:clamp(245px,36vh,330px);
    border-width:2px;border-color:rgba(255,150,75,.55);
    border-radius:13px;
    background:
      radial-gradient(ellipse at 50% 100%,rgba(255,85,20,.12),transparent 48%),
      repeating-linear-gradient(0deg,rgba(255,255,255,.055) 0 1px,transparent 1px 42px),
      linear-gradient(180deg,#171923 0%,#0a0c12 100%);
    box-shadow:inset 0 0 28px rgba(0,0,0,.88),0 9px 22px rgba(0,0,0,.28);
  }
  .avatar{
    height:68%;bottom:calc(var(--climb,16) * .72%);
    align-items:flex-end;justify-content:center;
    filter:drop-shadow(0 7px 8px rgba(0,0,0,.45));
  }
  .avatar img{
    height:100%;width:auto;max-width:92%;object-fit:contain;object-position:center bottom;
    mix-blend-mode:screen;
    filter:drop-shadow(0 3px 8px rgba(0,0,0,.7)) saturate(1.08);
  }
  .avatar.fallen img{filter:grayscale(1) brightness(.65)}
  .lavafill{
    background:
      radial-gradient(ellipse at 20% 10%,rgba(255,244,174,.85),transparent 28%),
      radial-gradient(ellipse at 75% 25%,rgba(255,210,65,.7),transparent 24%),
      linear-gradient(180deg,#ffd84d 0%,#ff8a20 22%,#ed3e0b 65%,#8b1705 100%);
    box-shadow:0 -7px 22px rgba(255,112,22,.9),inset 0 9px 17px rgba(255,236,139,.45);
  }
  .lavafill::before{height:15px;top:-10px}
  .lpct{font-size:.82rem;bottom:6px;padding:2px 8px;text-shadow:0 2px 5px #000}
  .lane.dead .lavatower{border-color:#8c4540;box-shadow:inset 0 0 35px rgba(120,0,0,.5)}
  .lane.dead .avatar{filter:grayscale(1)}
  .panel{gap:.8rem 1.1rem;padding:clamp(1rem,2vw,1.4rem)}
  .panel .category{font-size:clamp(1.65rem,3.8vw,2.45rem);line-height:1.08}
  .panel input{min-height:52px}
  #featureHud{font-size:.86rem}
  @media(max-width:680px){
    #arena{gap:7px}
    .lavatower{height:clamp(205px,32vh,260px)}
    .avatar{height:66%}
    .pname{font-size:.72rem;letter-spacing:.04em}
    .panel{padding:.85rem}
  }
  @media(max-width:380px){.lavatower{height:190px}.avatar{height:66%}.lpct{font-size:.72rem}}
  /* FINAL POLISH: clear feedback for every answer */
  .avatar.correct-pop img{animation:correctLeap .72s cubic-bezier(.2,.85,.25,1) both!important}
  @keyframes correctLeap{0%{transform:translateY(0) scale(1)}35%{transform:translateY(-25px) scale(1.08) rotate(-5deg)}65%{transform:translateY(-13px) scale(1.03) rotate(3deg)}100%{transform:translateY(0) scale(1)}}
  .lane.just-eliminated .lavatower{animation:eliminationShake .55s ease-out}
  .lane.just-eliminated .lavafill{filter:brightness(1.3);box-shadow:0 0 28px #ff4b13, inset 0 8px 18px rgba(255,240,150,.7)}
  @keyframes eliminationShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
  .lane.dead .pname{color:#ff8174;text-shadow:0 0 10px rgba(255,55,40,.35)}
  .lane.dead .avatar{opacity:.68;filter:grayscale(1)}
  #msg.good{color:#9df0a0;text-shadow:0 0 12px rgba(100,255,120,.25)}
  #msg.bad{color:#ff8174;text-shadow:0 0 12px rgba(255,50,30,.25)}
  #liveLeaderboard{box-shadow:0 12px 28px rgba(0,0,0,.22),inset 0 1px rgba(255,255,255,.04)}
  .leader-row{transition:opacity .25s,background .25s}
  .leader-row:not(.eliminated):first-child{background:linear-gradient(90deg,rgba(255,190,65,.09),transparent);border-radius:6px}
  #over h2{animation:screenIn .45s ease-out}
  #over .big strong{animation:scoreReveal .7s cubic-bezier(.2,.8,.2,1) both}
  @keyframes scoreReveal{from{opacity:0;transform:scale(.65)}to{opacity:1;transform:scale(1)}}
  @media(prefers-reduced-motion:reduce){.avatar.correct-pop img,.lane.just-eliminated .lavatower,#over .big strong{animation:none!important}}
  /* LAVA VISIBILITY SAFETY FIX: always show a molten pool, even before the first HUD refresh. */
  .lavatower{background-color:#180907!important}
  .lavafill{
    display:block!important;visibility:visible!important;opacity:1!important;
    min-height:26px;
    background-color:#f04a0b;
    background-image:
      radial-gradient(ellipse at 18% 0%,rgba(255,246,164,.95),transparent 34%),
      radial-gradient(ellipse at 78% 12%,rgba(255,196,70,.9),transparent 30%),
      linear-gradient(180deg,#ffd84d 0%,#ff8b21 24%,#f0440c 66%,#981804 100%);
    border-top:2px solid #ffe37a;
    box-shadow:0 -8px 24px rgba(255,112,22,.95),inset 0 8px 15px rgba(255,236,139,.55);
  }
  .lavafill::before{content:"";position:absolute;left:0;right:0;top:-9px;height:12px;background:radial-gradient(circle at 10px 12px,#ffe16b 8px,transparent 10px) repeat-x;background-size:20px 12px;filter:drop-shadow(0 -2px 5px #ff8a1f);animation:ripple 2.2s linear infinite}
  .avatar{z-index:3}.lpct{z-index:4}
  /* VOLCANIC FORTRESS PASS: visible stonework, molten motion and stronger character feedback */
  .lavatower{
    isolation:isolate;
    border:3px solid #80513a!important;
    border-radius:13px!important;
    background:
      radial-gradient(ellipse at 50% 100%,rgba(255,82,12,.18),transparent 48%),
      repeating-linear-gradient(0deg,rgba(255,255,255,.045) 0 2px,transparent 2px 36px),
      linear-gradient(90deg,rgba(255,255,255,.06),transparent 13%,transparent 87%,rgba(0,0,0,.28)),
      linear-gradient(180deg,#28232a 0%,#17151b 45%,#100d11 100%)!important;
    box-shadow:inset 0 0 25px rgba(0,0,0,.88),inset 0 0 0 5px rgba(255,170,90,.035),0 10px 24px rgba(0,0,0,.4)!important;
  }
  .lavatower::before{
    content:"";position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.38;
    background:
      linear-gradient(112deg,transparent 0 18%,rgba(255,106,38,.24) 18.2%,transparent 18.8% 100%),
      linear-gradient(72deg,transparent 0 77%,rgba(255,106,38,.18) 77.3%,transparent 78% 100%),
      linear-gradient(164deg,transparent 0 43%,rgba(255,170,80,.12) 43.2%,transparent 43.8% 100%);
    mix-blend-mode:screen;
  }
  .lavafill{
    z-index:2!important;min-height:30px!important;
    background-size:130px 80px,100% 100%!important;
    animation:moltenFlow 5s linear infinite, lavaPulse 2.1s ease-in-out infinite alternate!important;
    will-change:height,background-position,filter;
  }
  .lavafill::before{height:15px!important;top:-10px!important;animation:ripple 1.8s linear infinite!important}
  .lavafill::after{
    content:"";position:absolute;left:12%;right:12%;top:7px;height:7px;border-radius:50%;
    background:radial-gradient(ellipse,rgba(255,247,181,.9),rgba(255,183,56,.28) 45%,transparent 72%);
    filter:blur(2px);animation:lavaShimmer 2.4s ease-in-out infinite alternate;pointer-events:none;
  }
  @keyframes moltenFlow{to{background-position:130px 0,0 0}}
  @keyframes lavaPulse{from{filter:saturate(1.1) brightness(.95)}to{filter:saturate(1.35) brightness(1.16)}}
  @keyframes lavaShimmer{from{transform:translateX(-10%) scaleX(.7);opacity:.45}to{transform:translateX(10%) scaleX(1.15);opacity:1}}
  .avatar img{filter:drop-shadow(0 5px 7px rgba(0,0,0,.85)) drop-shadow(0 0 7px rgba(255,119,35,.12));transform-origin:50% 90%}
  .avatar.climbing img{animation:characterClimb .72s cubic-bezier(.2,.8,.2,1) 1!important}
  @keyframes characterClimb{0%{transform:translateY(0) rotate(0) scale(1)}28%{transform:translateY(-19px) rotate(-5deg) scale(1.05)}55%{transform:translateY(-27px) rotate(3deg) scale(1.04)}78%{transform:translateY(-7px) rotate(-2deg) scale(1.01)}100%{transform:translateY(0) rotate(0) scale(1)}}
  .lane.active .lavatower{border-color:#ffc247!important;box-shadow:0 0 0 1px rgba(255,194,71,.24),0 0 26px rgba(255,117,27,.34),inset 0 0 25px rgba(0,0,0,.88)!important}
  .lane.just-eliminated .lavatower{animation:eliminationShake .58s ease-out, eliminationFlash .58s ease-out}
  .lane.just-eliminated .lavafill{filter:brightness(1.55) saturate(1.45)!important}
  @keyframes eliminationFlash{0%,100%{box-shadow:inset 0 0 25px #000}35%{box-shadow:inset 0 0 45px rgba(255,40,8,.9),0 0 35px rgba(255,50,8,.9)}}
  .lane.dead .lavatower{border-color:#9d4330!important}
  .lane.dead .lavafill{filter:grayscale(.12) brightness(1.25)!important}
  #liveLeaderboard{border-color:rgba(255,153,65,.4)!important;background:linear-gradient(145deg,rgba(40,28,26,.96),rgba(13,14,20,.97))!important}
  #liveLeaderboard h3{color:#ffd05a!important;letter-spacing:.07em}
  @media(prefers-reduced-motion:reduce){.lavafill,.lavafill::before,.lavafill::after,.avatar.climbing img{animation:none!important}}
  `;

function createFeatureUI() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const card = (id, html = "") => {
    const d = document.createElement("div");
    d.id = id;
    d.className = "feature-card";
    d.innerHTML = html;
    return d;
  };

  $("start").appendChild(card("startStats"));
  $("over").appendChild(card("tallyCard"));
  $("over").appendChild(card("overStats"));

  const arena = document.createElement("div");
  arena.id = "arena";
  arena.innerHTML = players.map((p, i) => `
    <div class="lane" id="lane-${i}">
      <div class="speech" id="speech-${i}"></div>
      <div class="pname">${p.name}</div>
      <div class="lavatower" id="lt-${i}">
        <div class="lavafill" id="fill-${i}"></div>
        <div class="avatar" id="avatar-${i}"><img src="assets/${["adventurer","robot","alien"][i]}.png" alt="${p.name}" /></div>
        <div class="lpct" id="lpct-${i}">18%</div>
      </div>
      <div class="pscore" id="pscore-${i}">⭐ 0</div>
    </div>`).join("");
  document.querySelector(".board").before(arena);
  const leaderboard = document.createElement("section");
  leaderboard.id = "liveLeaderboard";
  leaderboard.setAttribute("aria-live", "polite");
  leaderboard.innerHTML = '<h3>🏆 LIVE LEADERBOARD</h3><div id="leaderRows"></div>';
  arena.after(leaderboard);

  const banner = card("eventBanner");
  banner.style.display = "none";
  $("category").before(
    card("featureHud", '<div id="turnDisplay"></div><div id="comboDisplay"></div><div id="bossDisplay"></div><div id="lastChanceDisplay"></div>'),
    banner
  );

  // Spark hint button (under the Submit button) and the recent-words log (under the message line)
  const spark = document.createElement("button");
  spark.id = "sparkBtn";
  spark.className = "btn ghost";
  spark.type = "button";
  spark.disabled = true;
  spark.textContent = `✨ Spark hint (-${SPARK_COST})`;
  spark.onclick = useSpark;
  $("submit").after(spark);

  const log = document.createElement("div");
  log.id = "wordLog";
  log.setAttribute("aria-label", "Recent words");
  $("msg").after(log);

  const overlay = document.createElement("div");
  overlay.id = "turnOverlay";
  overlay.innerHTML = '<div id="turnFace"></div><div id="turnText"></div>';
  document.body.appendChild(overlay);

  defaultPH = $("answer").placeholder || "Type a word...";
  renderStatistics();
}

function updateFeatureHUD() {
  const p = players[turn];
  $("turnDisplay").textContent = round ? `🎯 Turn ${round}: ${p.name} (${diff().label})` : "";
  $("comboDisplay").textContent = `🔥 ${p.name} Combo: ${p.combo} | Multiplier: ${p.mult}x`;
  $("bossDisplay").textContent = bossRound ? `👹 BOSS ROUND: ${bossDone}/${BOSS_WORDS} words` : "";
  $("lastChanceDisplay").textContent = lastChance ? "🚨 LAST CHANCE MODE! DOUBLE POINTS! SURVIVE!" : "";
  players.forEach((_, i) => $("lt-" + i).classList.toggle("critical-mode", lastChance && i === turn));
}

function triggerDisaster() {
  activeEvent = Math.random() < EVENT_CHANCE ? EVENTS[Math.floor(Math.random() * EVENTS.length)] : null;
  const b = $("eventBanner");
  b.style.display = activeEvent ? "block" : "none";
  b.textContent = activeEvent ? `${activeEvent.name} - ${activeEvent.desc}` : "";
}

// sounds + visuals that play when the turn actually begins
function playEventFx() {
  if (!activeEvent) return;
  const id = activeEvent.id;
  if (id === "heat" || id === "surge") sfx.heat();
  if (id === "tremor") { sfx.tremor(); shake(); }
  if (id === "breeze") {
    sfx.breeze();
    const t = $("lt-" + turn);
    t.classList.remove("cooled");
    void t.offsetWidth;
    t.classList.add("cooled");
  }
}

// ===== SCREEN SHAKE + FLOATING POPUPS =====
function shake() {
  if (reduceMotion) return;
  const el = document.querySelector(".app");
  el.classList.remove("quake");
  void el.offsetWidth;
  el.classList.add("quake");
  setTimeout(() => el.classList.remove("quake"), 450);
}

function popup(i, text, cls) {
  const el = document.createElement("span");
  el.className = "pop " + cls;
  el.textContent = text;
  $("lane-" + i).appendChild(el);
  setTimeout(() => el.remove(), 1250);
}

// ===== WINNER / TIE HELPER =====
// Survivors are ranked by score. If nobody survived, everyone is ranked.
function pickWinner() {
  const alive = players.filter(p => !p.dead);
  const ranked = [...(alive.length ? alive : players)].sort((a, b) => b.score - a.score);
  return { winner: ranked[0], tie: ranked.length > 1 && ranked[1].score === ranked[0].score };
}

// ===== RESULTS: score tally (rubric) for every player =====
function renderTally() {
  const ranked = [...players].sort((a, b) => b.score - a.score);
  const { winner } = pickWinner();
  const place = ["1st", "2nd", "3rd"];
  const rows = [
    ["Words answered", p => p.tally.words],
    ["Points from letters", p => p.tally.letters],
    ["Long word bonus (8+ letters)", p => "+" + p.tally.longBonus],
    ["Combo multiplier bonus", p => "+" + p.tally.comboBonus],
    ["Last Chance bonus", p => "+" + p.tally.lastBonus],
    ["Boss rounds defeated", p => p.tally.bosses],
    ["Longest word", p => p.tally.longest || "-"],
    ["Best combo", p => p.tally.bestCombo],
    ["Time-outs", p => p.tally.timeouts],
    ["Final lava", p => Math.round(Math.min(p.lava, MAX_LAVA)) + "%"],
    ["Result", p => p === winner ? "🏆 Winner" : p.dead ? "🌋 Melted" : "Survived"],
    ["TOTAL SCORE", p => p.score, "total"],
    ["Rank", p => place[ranked.findIndex(x => x.score === p.score)], "total"]   // equal scores share a rank
  ];
  const head = players.map(p => `<th>${p.faces[0]}<br>${p.name}</th>`).join("");
  const body = rows.map(([label, value, cls]) =>
    `<tr class="${cls || ""}"><td>${label}</td>${players.map(p => `<td>${value(p)}</td>`).join("")}</tr>`
  ).join("");
  $("tallyCard").innerHTML =
    `<strong>🧾 SCORE TALLY (${diff().label})</strong><div class="tallywrap"><table class="tally"><tr><th>Criteria</th>${head}</tr>${body}</table></div>`;
}

// ===== SPEECH BUBBLE (typing animation) =====
const DOTS = '<span class="dots"><i></i><i></i><i></i></span>';

function setBubble(i, html) {
  const b = $("speech-" + i);
  b.innerHTML = html;
  b.classList.toggle("on", !!html);
}

function showTyping(p, text) {
  setBubble(players.indexOf(p), text ? `${text}<span class="caret"></span>` : DOTS);
  $("answer").value = text;
}

// ===== RECENT WORDS LOG =====
function logWord(word, p, points) {
  wordLog.unshift({ word: word.toUpperCase(), init: p.name[0], points, push: 0, mine: !p.bot });
  if (wordLog.length > LOG_MAX) wordLog.pop();
  renderLog();
}

function renderLog() {
  $("wordLog").innerHTML = wordLog.map((e, i) =>
    `<span class="wbadge${e.mine ? " mine" : ""}${i === 0 ? " latest" : ""}">${e.mine ? "● " : ""}${esc(e.word)} · ${e.init} · +${Math.round(e.points)}</span>`
  ).join("");
}

function clearLogSmooth() {
  if (!wordLog.length) return;
  const l = $("wordLog");
  l.classList.add("fade");
  setTimeout(() => { wordLog = []; renderLog(); l.classList.remove("fade"); }, 350);
}

// ===== SPARK HINT (one per game, costs points) =====
function useSpark() {
  const p = players[turn];
  if (locked || p.bot || sparkUsed) return;
  const pool = [...current.set].filter(w => !used.has(w));
  if (!pool.length) return setMsg("No unused words left to hint!", "bad");
  const w = pool[Math.floor(Math.random() * pool.length)];
  sparkUsed = true;
  p.score = Math.max(0, p.score - SPARK_COST);
  $("sparkBtn").disabled = true;
  $("answer").placeholder = `Starts with "${w[0].toUpperCase()}" ${w[0].toUpperCase()}${"_".repeat(w.length - 1)} (${w.length} letters)`;
  $("answer").classList.add("spark");
  $("answer").focus();
  setMsg(`✨ Spark: a valid word starts with "${w[0].toUpperCase()}" and has ${w.length} letters. -${SPARK_COST} pts.`, "good");
  popup(0, `-${SPARK_COST} ✨`, "gold");
  sfx.spark();
  updateHud();
}

function resetPlaceholder() {
  $("answer").placeholder = defaultPH;
  $("answer").classList.remove("spark");
}

// ===== START GAME =====
function startGame() {
  getCtx();
  clearInterval(timerId);
  clearTimeout(botTimer);
  clearTimeout(transitionTimer);
  $("turnOverlay").classList.remove("show");
  round = bossDone = bossClimb = 0;
  players = newPlayers();
  turn = players.length - 1;          // so the first turn goes to player 0 (you)
  used = new Set();
  lastCats = [];
  bossRound = false;
  lastChance = false;
  activeEvent = null;
  sparkUsed = false;
  wordLog = [];
  renderLog();
  resetPlaceholder();
  locked = true;
  // games played is now counted when a game finishes, so quitting midway doesn't skew the average
  updateHud();
  show("game");
  nextRound();
}

// ===== NEXT ROUND =====
function nextRound() {
  round++;
  do { turn = (turn + 1) % players.length; } while (players[turn].dead);
  const p = players[turn];
  locked = true;
  lastChance = p.lava >= LAST_CHANCE_LEVEL;

  let choices = WORD_BANK.filter(c => !lastCats.includes(c.category));
  if (!choices.length) { lastCats = []; choices = WORD_BANK; }
  current = choices[Math.floor(Math.random() * choices.length)];
  lastCats.push(current.category);
  if (lastCats.length > 2) lastCats.shift();
  current.set = new Set(current.words.split(" ").map(normalize));

  bossRound = round % BOSS_INTERVAL === 0;
  bossDone = bossClimb = 0;

  triggerDisaster();
  const d = diff();
  const minTime = Math.max(5, MIN_TIME + d.time);
  const lastChanceTime = Math.max(4, LAST_CHANCE_TIME + Math.round(d.time / 2));
  roundTime = lastChance ? lastChanceTime : Math.max(minTime, BASE_TIME + d.time - Math.floor((round - 1) / 2));
  if (activeEvent) roundTime = Math.max(4, roundTime - activeEvent.time);
  timeLeft = roundTime;

  players.forEach((_, i) => setBubble(i, ""));
  clearLogSmooth();
  resetPlaceholder();
  $("category").textContent = current.category;
  $("answer").value = "";
  $("answer").disabled = $("submit").disabled = true;
  $("sparkBtn").disabled = true;
  setMsg("", "");
  updateHud();
  drawTimer();

  $("turnFace").textContent = p.faces[0];
  $("turnText").textContent = p.turnText;
  $("turnOverlay").classList.add("show");
  if (bossRound) { sfx.boss(); shake(); } else sfx.turn(!p.bot);
  transitionTimer = setTimeout(() => {
    $("turnOverlay").classList.remove("show");
    beginTurn(p);
  }, ANNOUNCE_MS);
}

function beginTurn(p) {
  locked = false;
  lastTickSec = 0;
  $("answer").disabled = $("submit").disabled = p.bot;
  $("sparkBtn").disabled = p.bot || sparkUsed;
  setMsg(p.bot ? `${p.name} is thinking...` : "Your turn!", "");
  playEventFx();

  clearInterval(timerId);
  timerId = setInterval(() => {
    timeLeft -= 0.1;
    drawTimer();
    const sec = Math.ceil(timeLeft);
    if (!p.bot && sec <= 3 && sec > 0 && sec !== lastTickSec) {
      lastTickSec = sec;
      sfx.tick();
    }
    if (timeLeft <= 0) endRound(null);
  }, 100);

  if (p.bot) botTurn(p);
  else $("answer").focus();
}

// ===== BOT LOGIC =====
function botTurn(p) {
  setBubble(turn, DOTS);
  const d = diff();
  const acc = Math.min(0.97, p.acc * d.acc);
  const need = bossRound ? BOSS_WORDS : 1;
  const pool = [...current.set].filter(w => !used.has(w));
  const short = pool.filter(w => w.length <= p.maxLen);
  const source = short.length >= need ? short : pool;

  if (Math.random() > acc || source.length < need) return;

  const picks = [];
  while (picks.length < need) picks.push(source.splice(Math.floor(Math.random() * source.length), 1)[0]);

  const typeTime = picks.reduce((t, w) => t + w.length * botSpeed(p) / 1000 + 0.3, 0);
  let think = rand(p.think[0], p.think[1]) * d.think;
  think = Math.min(think, roundTime - 0.4 - typeTime);
  if (think < 0.3) return;

  botTimer = setTimeout(() => typeWords(p, picks, 0), think * 1000);
}

function typeWords(p, picks, i) {
  const w = picks[i];
  let n = 0;
  const step = () => {
    if (locked) return;
    showTyping(p, w.slice(0, ++n));
    if (n < w.length) {
      botTimer = setTimeout(step, botSpeed(p) * rand(0.7, 1.3));
    } else {
      botTimer = setTimeout(() => {
        used.add(w);
        if (i + 1 < picks.length) {
          showTyping(p, "");
          typeWords(p, picks, i + 1);
        } else {
          botSubmit(p, picks);
        }
      }, 300);
    }
  };
  step();
}

function botSubmit(p, picks) {
  if (bossRound) {
    bossDone = picks.length;
    bossClimb = picks.reduce((sum, w) => sum + climbFor(w.length), 0);
    picks.forEach(w => awardWord(w, p));
    endRound(picks[picks.length - 1], true);
  } else {
    endRound(picks[0]);
  }
}

// ===== SCORING =====
function awardWord(word, p) {
  const len = word.length;
  p.combo++;
  p.mult = Math.min(MAX_MULTIPLIER, 1 + Math.floor(p.combo / 2));
  const longBonus = len >= 8 ? BONUS_LONG : 0;
  const comboBonus = (len + longBonus) * (p.mult - 1);
  const subtotal = (len + longBonus) * p.mult;
  const lastBonus = lastChance ? subtotal : 0;
  const points = subtotal + lastBonus;
  p.score += points;

  const t = p.tally;
  t.words++;
  t.letters += len;
  t.longBonus += longBonus;
  t.comboBonus += comboBonus;
  t.lastBonus += lastBonus;
  t.bestCombo = Math.max(t.bestCombo, p.combo);
  if (len > t.longest.length) t.longest = word;

  if (!p.bot) {
    const s = getStats();
    s.totalWords++;
    if (len > s.longestWord.length) s.longestWord = word;
    save(STATS_KEY, s);
  }

  sfx.good(len, p.bot);
  logWord(word, p, points);
  popup(players.indexOf(p), `+${points}`, "good");
  updateHud();
  return { points, len };
}

// ===== SUBMIT WORD (your turn only) =====
function submitWord() {
  const p = players[turn];
  if (locked || p.bot) return;
  const w = normalize($("answer").value);
  if (!w) return;
  if (used.has(w)) return reject(`"${w}" was already used this round.`);
  if (!current.set.has(w)) return reject(`"${w}" is not in the ${current.category} list.`);
  used.add(w);

  if (bossRound) {
    const r = awardWord(w, p);
    bossDone++;
    bossClimb += climbFor(w.length);
    if (bossDone >= BOSS_WORDS) return endRound(w, true);
    const left = BOSS_WORDS - bossDone;
    $("answer").placeholder = `Boss round: ${left} more word${left > 1 ? "s" : ""} needed`;
    setMsg(`"${w}" accepted! +${r.points} points. ${left} more word needed!`, "good");
    $("answer").value = "";
    setBubble(0, "");
    $("answer").focus();
    return;
  }
  endRound(w);
}

function reject(text) {
  if (locked) return;
  endRound(null, false, text);
}

// ===== END ROUND =====
function endRound(word, bossWon = false, failureText = "") {
  if (locked) return;
  locked = true;
  clearInterval(timerId);
  clearTimeout(botTimer);
  $("answer").disabled = $("submit").disabled = true;
  $("sparkBtn").disabled = true;
  document.querySelectorAll(".breeze").forEach(el => el.remove());   // clear breeze motes with the round

  const p = players[turn];
  let text;

  if (!word) {
    // One mistake or timeout eliminates the player immediately. No extra lava life.
    p.combo = 0;
    p.mult = 1;
    if (!failureText) p.tally.timeouts++;
    p.lava = MAX_LAVA; // visual lava surge on instant elimination
    p.dead = true;
    text = failureText
      ? `${failureText} ${p.name} is eliminated!`
      : (p.bot ? `${p.name} ran out of time. Eliminated!` : "Time's up! You are eliminated!");
    setBubble(turn, failureText ? "✖" : "⏰");
    sfx.bad();
    sfx.melt();
    popup(turn, "ELIMINATED", "bad");
    const deadLane = $("lane-" + turn);
    deadLane.classList.remove("just-eliminated");
    void deadLane.offsetWidth;
    deadLane.classList.add("just-eliminated");
    setTimeout(() => deadLane.classList.remove("just-eliminated"), 650);
    shake();
  } else if (bossWon) {
    p.tally.bosses++;
    p.climb = Math.min(86, p.climb + bossClimb);
    text = `👹 BOSS DEFEATED by ${p.name}! ${bossDone} words completed. ${p.name}'s character climbs!`;
  } else {
    const r = awardWord(word, p);
    p.climb = Math.min(86, p.climb + climbFor(word.length));
    text = `${p.name}: "${word}" = ${r.len} letters, +${r.points} pts. Character climbs!` + (lastChance ? " DOUBLE POINTS!" : "");
  }

  if (word) {
    popup(turn, bossWon ? "BOSS DEFEATED!" : "CLIMB!", "good");
    const avatar = $("avatar-" + turn);
    avatar.classList.remove("correct-pop");
    void avatar.offsetWidth;
    avatar.classList.add("correct-pop");
    setTimeout(() => avatar.classList.remove("correct-pop"), 800);
  }
  setMsg(text, p.dead ? "bad" : "good");
  updateHud();

  const over = players[0].dead || players.filter(x => !x.dead).length <= 1;
  transitionTimer = setTimeout(over ? gameOver : nextRound, over ? 1900 : 1500);
}

// ===== GAME OVER =====
function gameOver() {
  clearInterval(timerId);
  clearTimeout(botTimer);
  clearTimeout(transitionTimer);

  const me = players[0], best = getBest(), s = getStats();
  if (me.score > best) save(KEY, me.score);
  s.gamesPlayed++;
  s.bestRound = Math.max(s.bestRound, round);
  s.totalScore += me.score;
  s.highestScore = Math.max(s.highestScore, me.score);
  save(STATS_KEY, s);

  const { winner, tie } = pickWinner();
  refreshBest();
  renderStatistics();
  renderTally();
  $("overTitle").textContent = me.dead ? "ELIMINATED!" : "🏆 YOU WIN!";
  $("finalScore").textContent = me.score;
  $("finalInfo").textContent =
    (me.dead
      ? `You were eliminated in round ${round}. ${tie ? "Top score is tied" : "Winner: " + winner.name}. `
      : `You are the last player standing after round ${round}! `) +
    players.map(p => `${p.name}: ${p.score}`).join(" | ") +
    (me.score > best && me.score > 0 ? " - NEW HIGH SCORE!" : "");
  show("over");
  if (me.dead) sfx.lose(); else sfx.win();
}

// ===== LIVE LEADERBOARD =====
function renderLeaderboard() {
  const host = $("leaderRows");
  if (!host) return;
  const ranked = [...players].sort((a, b) => Number(a.dead) - Number(b.dead) || b.score - a.score);
  host.innerHTML = ranked.map((p, index) => {
    const status = p.dead ? "ELIMINATED" : (index === 0 ? "LEADING" : "IN GAME");
    return `<div class="leader-row ${p.dead ? "eliminated" : ""}"><span class="leader-rank">#${index + 1}</span><strong>${esc(p.name)}</strong><span class="leader-state">${status}</span><span class="leader-points">${p.score} pts</span></div>`;
  }).join("");
}

// ===== HUD =====
function updateHud() {
  renderLeaderboard();
  const top = Math.max(...players.map(p => p.score));
  const leaders = players.filter(p => p.score === top);
  players.forEach((p, i) => {
    const shown = Math.max(18, Math.min(p.lava, MAX_LAVA)); // keep a visible lava pool at the bottom
    const fill = $("fill-" + i);
    const isLeader = top > 0 && leaders.length === 1 && p.score === top;   // crown only for a clear leader
    fill.style.height = shown + "%";
    fill.style.opacity = 1;
    $("lpct-" + i).textContent = Math.round(shown) + "%";
    $("pscore-" + i).textContent = "⭐ " + p.score + (isLeader ? " 👑" : "");
    const avatar = $("avatar-" + i);
    avatar.classList.toggle("climbing", !p.dead && p.climb > START_CLIMB);
    avatar.classList.toggle("fallen", p.dead);
    avatar.style.setProperty("--climb", p.climb);
    avatar.setAttribute("aria-label", p.dead ? `${p.name}, eliminated` : `${p.name}, climbing progress`);
    $("lane-" + i).classList.toggle("dead", p.dead);
    $("lane-" + i).classList.toggle("eliminated", p.dead);
    $("lane-" + i).classList.toggle("leader", isLeader);
    $("lane-" + i).classList.toggle("active", round > 0 && !p.dead && i === turn);
  });
  $("heat").style.opacity = (Math.min(players[0].lava, MAX_LAVA) / MAX_LAVA * 0.7).toFixed(2);
  $("round").textContent = Math.max(round, 1);
  $("score").textContent = players[0].score;
  updateFeatureHUD();
}

function drawTimer() {
  const t = Math.max(0, timeLeft);
  $("time").textContent = Math.ceil(t);
  $("timerBar").style.width = (t / roundTime * 100) + "%";
  $("timerBar").style.background = t < 4 ? "var(--bad)" : "var(--molten)";
}

function setMsg(t, cls) {
  const m = $("msg");
  m.textContent = t;
  m.className = "msg " + cls;
}

// ===== EVENTS =====
$("startBtn").onclick = $("playBtn").onclick = $("againBtn").onclick = startGame;
$("howBtn").onclick = () => show("how");
$("backBtn").onclick = $("menuBtn").onclick = () => show("start");
$("muteBtn").onclick = toggleMute;
$("submit").onclick = submitWord;
$("answer").addEventListener("keydown", e => { if (e.key === "Enter") submitWord(); });
// live typing preview in your own speech bubble, like the bots
$("answer").addEventListener("input", () => {
  if (locked || players[turn].bot) return;
  const v = $("answer").value;
  setBubble(0, v ? `${esc(v)}<span class="caret"></span>` : "");
});
document.querySelectorAll(".diffbtn").forEach(b => {
  b.onclick = () => setDifficulty(b.dataset.diff);
});

// ===== LAVA EFFECTS: bubbles, embers, and breeze motes =====
const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

function spawn(cls, css, ms, parent) {
  const el = document.createElement("span");
  el.className = cls;
  el.style.cssText = css;
  parent.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function lavaFx() {
  if (reduceMotion || $("game").classList.contains("hidden")) return;
  players.forEach((p, i) => {
    const h = $("fill-" + i).offsetHeight;
    if (p.dead) return;
    // drifting breeze motes over the active tower during Cool Breeze
    if (!locked && activeEvent && activeEvent.id === "breeze" && i === turn && Math.random() < 0.6) {
      spawn("breeze", `top:${10 + Math.random() * 75}%;--x:${50 + Math.random() * 60}px`, 1600, $("lt-" + i));
    }
    if (h < 10) return;
    if (Math.random() < 0.7) {
      const size = 5 + Math.random() * 10, d = 1.4 + Math.random() * 1.6;
      spawn("lbub", `width:${size}px;height:${size}px;left:${Math.random() * 88}%;--d:${d}s;--h:${h * (0.3 + Math.random() * 0.6)}px`, d * 1000, $("fill-" + i));
    }
    if (Math.random() < 0.35) {
      spawn("ember", `left:${8 + Math.random() * 84}%;bottom:${h}px;--d:1.4s;--x:${(Math.random() - 0.5) * 30}px`, 1400, $("lt-" + i));
    }
  });
}

// ===== INITIALIZE =====
createFeatureUI();
updateHud();
refreshBest();
renderDifficulty();
renderMute();
setInterval(lavaFx, 350);