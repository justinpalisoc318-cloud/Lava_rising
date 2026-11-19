// ===== SETTINGS =====
const START_RISE = 15;
const RISE_PER_ROUND = 3;
const MAX_LAVA = 100;

const PUSH_SHORT = 0;
const PUSH_MEDIUM = 5;
const PUSH_LONG = 15;
const BONUS_LONG = 5;

const BASE_TIME = 15;
const MIN_TIME = 8;

const KEY = "wordLavaHighScore";
const STATS_KEY = "wordLavaStatistics";

const BOSS_INTERVAL = 5;
const BOSS_WORDS = 2;
const LAST_CHANCE_LEVEL = 90;
const LAST_CHANCE_TIME = 7;
const EVENT_CHANCE = 0.35;
const MAX_MULTIPLIER = 5;

// ===== HTML ELEMENT HELPER =====
const $ = id => document.getElementById(id);

const screens = ["start", "how", "game", "over"];

const show = name => {
    screens.forEach(s => {
        $(s).classList.toggle("hidden", s !== name);
    });

    if (name !== "game") {
        $("heat").style.opacity = 0.15;
    }
};

// ===== GAME VARIABLES =====
let lava, round, score, used, current;
let timeLeft, roundTime, timerId, locked;
let lastCats = [];

let combo = 0;
let multiplier = 1;

let bossRound = false;
let bossCompleted = 0;
let bossTarget = 0;
let bossPush = 0;

let activeEvent = null;
let lastChance = false;

let longestWord = "";
let transitionTimer = null;

// ===== STATISTICS =====
function defaultStats() {
    return {
        gamesPlayed: 0,
        totalWords: 0,
        longestWord: "",
        bestRound: 0,
        totalScore: 0,
        highestScore: 0
    };
}

function getStats() {
    try {
        return {
            ...defaultStats(),
            ...JSON.parse(localStorage.getItem(STATS_KEY))
        };
    } catch (e) {
        return defaultStats();
    }
}

function saveStats(stats) {
    try {
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {}
}

function updateWordStats(word) {
    const stats = getStats();

    stats.totalWords++;

    if (word.length > stats.longestWord.length) {
        stats.longestWord = word;
    }

    saveStats(stats);
}

function renderStatistics() {
    const stats = getStats();

    const average = stats.gamesPlayed > 0
        ? Math.round(stats.totalScore / stats.gamesPlayed)
        : 0;

    const startStats = $("startStats");
    const overStats = $("overStats");

    const content = `
        <strong>📊 PERSONAL STATISTICS</strong>
        <div>🎮 Games Played: ${stats.gamesPlayed}</div>
        <div>🏆 Best Round: ${stats.bestRound}</div>
        <div>📝 Total Words: ${stats.totalWords}</div>
        <div>📚 Longest Word: ${stats.longestWord || "None yet"}</div>
        <div>⭐ Highest Score: ${stats.highestScore}</div>
        <div>📈 Average Score: ${average}</div>
    `;

    if (startStats) startStats.innerHTML = content;
    if (overStats) overStats.innerHTML = content;
}

// ===== HIGH SCORE =====
function getBest() {
    try {
        return parseInt(localStorage.getItem(KEY), 10) || 0;
    } catch (e) {
        return 0;
    }
}

function saveBest(v) {
    try {
        localStorage.setItem(KEY, String(v));
    } catch (e) {}
}

function refreshBest() {
    const best = getBest();

    $("hsStart").textContent = best;
    $("hsOver").textContent = best;
    $("best").textContent = best;
}

// ===== CREATE NEW UI ELEMENTS =====
function createFeatureUI() {
    const style = document.createElement("style");

    style.textContent = `
        .feature-card {
            background: rgba(255, 100, 20, 0.10);
            border: 1px solid rgba(255, 130, 40, 0.35);
            border-radius: 10px;
            padding: 12px;
            margin: 12px 0;
            line-height: 1.8;
            font-size: 13px;
            text-align: left;
            color: #fff;
        }

        #comboDisplay {
            color: #ffae42;
            font-weight: bold;
        }

        #bossDisplay {
            color: #ff6666;
            font-weight: bold;
        }

        #lastChanceDisplay {
            color: #ff3333;
            font-weight: bold;
        }

        #eventBanner {
            color: #ffc45c;
            font-weight: bold;
            text-align: center;
        }

        .critical-mode {
            animation: criticalPulse 0.8s infinite alternate;
        }

        @keyframes criticalPulse {
            from { box-shadow: 0 0 5px #ff2222; }
            to { box-shadow: 0 0 22px #ff2222; }
        }
    `;

    document.head.appendChild(style);

    const startStats = document.createElement("div");
    startStats.id = "startStats";
    startStats.className = "feature-card";
    $("start").appendChild(startStats);

    const overStats = document.createElement("div");
    overStats.id = "overStats";
    overStats.className = "feature-card";
    $("over").appendChild(overStats);

    const panel = document.querySelector(".panel");

    if (panel) {
        const hud = document.createElement("div");
        hud.id = "featureHud";
        hud.className = "feature-card";

        hud.innerHTML = `
            <div id="comboDisplay">🔥 Combo: 0 | Multiplier: 1x</div>
            <div id="bossDisplay"></div>
            <div id="lastChanceDisplay"></div>
        `;

        panel.insertBefore(hud, $("category").parentElement);

        const banner = document.createElement("div");
        banner.id = "eventBanner";
        banner.className = "feature-card";
        banner.style.display = "none";

        panel.insertBefore(banner, $("category").parentElement);
    }

    renderStatistics();
}

// ===== UPDATE FEATURE HUD =====
function updateFeatureHUD() {
    if ($("comboDisplay")) {
        $("comboDisplay").textContent =
            `🔥 Combo: ${combo} | Multiplier: ${multiplier}x`;
    }

    if ($("bossDisplay")) {
        $("bossDisplay").textContent = bossRound
            ? `👹 BOSS ROUND: ${bossCompleted}/${bossTarget} words`
            : "";
    }

    if ($("lastChanceDisplay")) {
        $("lastChanceDisplay").textContent = lastChance
            ? "🚨 LAST CHANCE MODE! DOUBLE POINTS! SURVIVE!"
            : "";
    }

    const tower = document.querySelector(".tower");

    if (tower) {
        tower.classList.toggle("critical-mode", lastChance);
    }
}

// ===== RANDOM DISASTER EVENTS =====
const DISASTER_EVENTS = [
    {
        name: "🔥 HEAT WAVE",
        description: "Lava rises an extra 10%!",
        rise: 10,
        time: 0
    },
    {
        name: "🌋 LAVA SURGE",
        description: "Lava rises an extra 15%!",
        rise: 15,
        time: 0
    },
    {
        name: "❄️ COOL BREEZE",
        description: "Lava rise decreases by 5%!",
        rise: -5,
        time: 0
    },
    {
        name: "⚡ VOLCANIC TREMOR",
        description: "You have 3 seconds less!",
        rise: 0,
        time: 3
    }
];

function triggerDisaster() {
    activeEvent = null;

    const banner = $("eventBanner");

    if (Math.random() < EVENT_CHANCE) {
        activeEvent = DISASTER_EVENTS[
            Math.floor(Math.random() * DISASTER_EVENTS.length)
        ];

        banner.style.display = "block";

        banner.textContent =
            activeEvent.name + " - " + activeEvent.description;
    } else {
        banner.style.display = "none";
        banner.textContent = "";
    }
}

// ===== START GAME =====
function startGame() {
    clearInterval(timerId);
    clearTimeout(transitionTimer);

    lava = 0;
    round = 0;
    score = 0;

    used = new Set();
    lastCats = [];

    combo = 0;
    multiplier = 1;

    bossRound = false;
    bossCompleted = 0;
    bossTarget = 0;
    bossPush = 0;

    activeEvent = null;
    lastChance = false;
    longestWord = "";

    const stats = getStats();
    stats.gamesPlayed++;
    saveStats(stats);

    updateHud();
    updateFeatureHUD();

    show("game");
    setTh();
    nextRound();
}

// ===== NEXT ROUND =====
function nextRound() {
    round++;
    locked = false;

    if (lava >= LAST_CHANCE_LEVEL) {
        lastChance = true;
    }

    const choices = WORD_BANK.filter(
        c => !lastCats.includes(c.category)
    );

    if (!choices.length) {
        lastCats = [];
        choices.push(...WORD_BANK);
    }

    current = choices[
        Math.floor(Math.random() * choices.length)
    ];

    lastCats.push(current.category);

    if (lastCats.length > 2) {
        lastCats.shift();
    }

    current.set = new Set(
        current.words.split(" ").map(normalize)
    );

    bossRound = round % BOSS_INTERVAL === 0;

    bossCompleted = 0;
    bossPush = 0;
    bossTarget = bossRound ? BOSS_WORDS : 0;

    roundTime = lastChance
        ? LAST_CHANCE_TIME
        : Math.max(
            MIN_TIME,
            BASE_TIME - Math.floor((round - 1) / 2)
        );

    triggerDisaster();

    if (activeEvent) {
        roundTime = Math.max(4, roundTime - activeEvent.time);
    }

    timeLeft = roundTime;

    $("category").textContent = current.category;

    $("answer").value = "";
    $("answer").disabled = false;
    $("submit").disabled = false;

    setMsg("", "");

    updateHud();
    updateFeatureHUD();
    drawTimer();

    $("answer").focus();

    clearInterval(timerId);

    timerId = setInterval(() => {
        timeLeft -= 0.1;

        drawTimer();

        if (timeLeft <= 0) {
            endRound(null);
        }
    }, 100);
}

// ===== NORMALIZE WORD =====
function normalize(w) {
    return w.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
}

// ===== SCORING AND COMBO =====
function awardWord(word) {
    const len = word.length;

    combo++;

    multiplier = Math.min(
        MAX_MULTIPLIER,
        1 + Math.floor(combo / 2)
    );

    const basePoints =
        len + (len >= 8 ? BONUS_LONG : 0);

    const points = basePoints * multiplier *
        (lastChance ? 2 : 1);

    score += points;

    updateWordStats(word);

    if (word.length > longestWord.length) {
        longestWord = word;
    }

    updateFeatureHUD();
    updateHud();

    return {
        points,
        len
    };
}

// ===== SUBMIT WORD =====
function submitWord() {
    if (locked) return;

    const w = normalize($("answer").value);

    if (!w) return;

    if (used.has(w)) {
        return reject("You already used that word.");
    }

    if (!current.set.has(w)) {
        return reject(
            "Not in the " + current.category + " list. Try another word."
        );
    }

    used.add(w);

    if (bossRound) {
        const result = awardWord(w);

        bossCompleted++;

        const push = w.length >= 8
            ? PUSH_LONG
            : w.length >= 5
                ? PUSH_MEDIUM
                : PUSH_SHORT;

        bossPush += push;

        if (bossCompleted < bossTarget) {
            setMsg(
                `"${w}" accepted! +${result.points} points. ` +
                `${bossTarget - bossCompleted} more word needed!`,
                "good"
            );

            $("answer").value = "";
            $("answer").focus();

            updateFeatureHUD();
            return;
        }

        endRound(w, true);
        return;
    }

    endRound(w);
}

// ===== INVALID WORD =====
function reject(text) {
    setMsg(text, "bad");

    const el = $("answer");

    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");

    el.select();
}

// ===== END ROUND =====
function endRound(word, defeatedBoss = false) {
    if (locked) return;

    locked = true;

    clearInterval(timerId);

    $("answer").disabled = true;
    $("submit").disabled = true;

    const rise = START_RISE + (round - 1) * RISE_PER_ROUND;

    let push = 0;
    let text = "";

    if (word) {
        if (!defeatedBoss) {
            const result = awardWord(word);

            push = word.length >= 8
                ? PUSH_LONG
                : word.length >= 5
                    ? PUSH_MEDIUM
                    : PUSH_SHORT;

            text =
                `"${word}" = ${result.len} letters, ` +
                `+${result.points} pts. `;
        } else {
            push = bossPush;

            text =
                `👹 BOSS DEFEATED! ${bossCompleted} words completed! `;
        }

    } else {
        combo = 0;
        multiplier = 1;

        text = "Time's up! The lava keeps rising.";
    }

    // Disaster event
    let extraRise = activeEvent ? activeEvent.rise : 0;

    // Last Chance bonus
    if (lastChance && word) {
        text += " DOUBLE POINTS! ";
    }

    lava = Math.max(
        0,
        lava + rise + extraRise - push
    );

    lava = Math.min(lava, MAX_LAVA);

    text += `Lava +${rise + extraRise}%.`;

    if (push > 0) {
        text += ` Lava pushed back ${push}%.`;
    }

    setMsg(
        text,
        push > 0 ? "good" : "bad"
    );

    updateHud();
    updateFeatureHUD();

    if (lava >= MAX_LAVA) {
        transitionTimer = setTimeout(gameOver, 1400);
    } else {
        transitionTimer = setTimeout(nextRound, 1600);
    }
}

// ===== GAME OVER =====
function gameOver() {
    clearInterval(timerId);
    clearTimeout(transitionTimer);

    const best = getBest();

    if (score > best) {
        saveBest(score);
    }

    const stats = getStats();

    stats.bestRound = Math.max(stats.bestRound, round);
    stats.totalScore += score;
    stats.highestScore = Math.max(stats.highestScore, score);

    saveStats(stats);

    refreshBest();

    $("finalScore").textContent = score;

    $("finalInfo").textContent =
        `You survived ${round} rounds` +
        (score > best && score > 0
            ? " - NEW HIGH SCORE!"
            : ".");

    renderStatistics();

    show("over");
}

// ===== HUD =====
function updateHud() {
    const shown = Math.min(lava, MAX_LAVA);

    $("lava").style.height = shown + "%";

    $("heat").style.opacity =
        (shown / MAX_LAVA * 0.7).toFixed(2);

    $("pct").textContent = Math.round(shown) + "%";

    $("round").textContent = Math.max(round, 1);

    $("score").textContent = score;

    updateFeatureHUD();
}

function drawTimer() {
    const t = Math.max(0, timeLeft);

    $("time").textContent = Math.ceil(t);

    $("timerBar").style.width =
        (t / roundTime * 100) + "%";

    $("timerBar").style.background =
        t < 4 ? "var(--bad)" : "var(--molten)";
}

function setMsg(t, cls) {
    const m = $("msg");
    m.textContent = t;
    m.className = "msg " + cls;
}

// ===== EVENTS =====
$("startBtn").onclick = startGame;
$("howBtn").onclick = () => show("how");
$("playBtn").onclick = startGame;
$("againBtn").onclick = startGame;
$("submit").onclick = submitWord;

$("answer").addEventListener("keydown", e => {
    if (e.key === "Enter") submitWord();
});

// ===== LAVA EFFECTS =====
const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setTh() {
    $("lava").style.setProperty(
        "--th",
        document.querySelector(".tower").clientHeight + "px"
    );
}

window.addEventListener("resize", setTh);

if (reduceMotion) {
    document.querySelectorAll("animate").forEach(a => a.remove());
}

function lavaFx() {
    if (reduceMotion || $("game").classList.contains("hidden")) {
        return;
    }

    const h = $("lava").offsetHeight;

    if (h < 10) return;

    const b = document.createElement("span");

    const size = 5 + Math.random() * 11;
    const d = 1.4 + Math.random() * 1.8;

    b.className = "bubble";

    b.style.cssText =
        `width:${size}px;height:${size}px;` +
        `left:${Math.random() * 90}%;` +
        `--d:${d}s;` +
        `--h:${h * (0.3 + Math.random() * 0.6)}px`;

    $("pool").appendChild(b);

    setTimeout(() => b.remove(), d * 1000);

    if (Math.random() < 0.6) {
        const s = document.createElement("span");

        s.className = "spark";

        s.style.cssText =
            `left:${8 + Math.random() * 84}%;` +
            `bottom:${h}px;` +
            `--d:1.6s;` +
            `--x:${(Math.random() - 0.5) * 40}px`;

        document.querySelector(".tower").appendChild(s);

        setTimeout(() => s.remove(), 1600);
    }
}

// ===== INITIALIZE GAME =====
createFeatureUI();
refreshBest();
renderStatistics();

setTh();

setInterval(lavaFx, 350);
