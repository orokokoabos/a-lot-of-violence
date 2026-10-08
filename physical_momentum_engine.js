"use worker";

/*
 * ============================================================
 * Physical Momentum Engine — JanitorAI
 * v0.1.0
 *
 * A scene-continuity module for physical positioning, movement,
 * held objects, environmental displacement and immediate action
 * consequences.
 *
 * PURPOSE
 * -------
 * JanitorAI roleplay can sometimes "reset" physical positioning
 * between generations:
 *
 *   - someone who fell suddenly stands again
 *   - a character holding something forgets it
 *   - a door that was kicked open becomes closed
 *   - someone pinned against a surface becomes unrestrained
 *   - characters teleport across the room
 *   - a dropped object mysteriously returns to someone's hand
 *
 * This module reminds the model to preserve RECENTLY ESTABLISHED
 * physical facts.
 *
 * SAFETY / SCOPE
 * --------------
 * This module does NOT:
 *
 *   - initiate violence
 *   - invent injuries
 *   - choose who attacks
 *   - force characters to behave violently
 *   - create weapons
 *   - escalate a peaceful scene
 *
 * It only reinforces physical continuity that already exists in
 * the recent conversation.
 *
 * INSTALLATION
 * ------------
 * Add this file as a JanitorAI Script lorebook entry.
 *
 * Start with DEBUG = true while testing, then disable it.
 * ============================================================
 */

context.character = context.character || {};
context.chat = context.chat || {};
context.character.scenario = context.character.scenario || "";

const CONFIG = {
    DEBUG: false,

    // Recent messages to inspect.
    HISTORY_DEPTH: 8,

    // Maximum approximate token footprint.
    MAX_TOKENS: 170,

    // Minimum evidence before anything is injected.
    MIN_SCORE: 4,

    // Number of physical facts retained in one generation.
    MAX_FACTS: 6,

    // The latest message gets extra weight.
    LATEST_WEIGHT: 3,

    // Older messages gradually lose weight.
    RECENCY_DECAY: 0.65
};

const MARKER = "[PHYSICAL MOMENTUM]";

const text = (value) => {
    if (typeof value !== "string") return "";
    return value;
};

const lastMessage = text(context.chat.last_message);

const recentMessages = Array.isArray(context.chat.last_messages)
    ? context.chat.last_messages
    : [];

function getRecentText() {
    const output = [];

    for (let i = 0; i < recentMessages.length; i++) {
        const item = recentMessages[i];

        if (!item) continue;

        if (typeof item === "string") {
            output.push(item);
            continue;
        }

        if (typeof item.message === "string") {
            output.push(item.message);
            continue;
        }

        if (typeof item.content === "string") {
            output.push(item.content);
        }
    }

    if (lastMessage && output.length === 0) {
        output.push(lastMessage);
    }

    if (lastMessage && output.length > 0) {
        const finalItem = output[output.length - 1];

        if (finalItem !== lastMessage) {
            output.push(lastMessage);
        }
    }

    return output.slice(-CONFIG.HISTORY_DEPTH);
}

const messages = getRecentText();

if (messages.length === 0) {
    if (CONFIG.DEBUG) {
        context.character.scenario +=
            "\n" + MARKER + " DEBUG: no readable recent messages.";
    }
    return;
}

/* ============================================================
 * UTILITIES
 * ============================================================ */

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAny(value, patterns) {
    return patterns.some((pattern) => pattern.test(value));
}

function normalizeWhitespace(value) {
    return value
        .replace(/\s+/g, " ")
        .trim();
}

function estimateTokens(value) {
    if (!value) return 0;
    return Math.ceil(value.length / 4);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/*
 * We deliberately avoid extracting arbitrary names.
 *
 * The module describes facts such as:
 *   "the character remains seated"
 * rather than attempting to decide exactly which character is
 * which. The LLM is better positioned to resolve pronouns and
 * character identity from the surrounding context.
 */

/* ============================================================
 * PHYSICAL SIGNALS
 *
 * Each signal describes something the conversation may already
 * have established.
 * ============================================================ */

const SIGNALS = [
    {
        id: "fallen",
        label: "fallen or down",
        weight: 3,
        patterns: [
            /\bfell\b/i,
            /\bfalls?\b/i,
            /\bfallen\b/i,
            /\bknocked (?:to|onto|off)\b/i,
            /\bon the floor\b/i,
            /\bon the ground\b/i,
            /\blanded\b/i,
            /\blay on the floor\b/i,
            /\blaying on the floor\b/i,
            /\blying on the floor\b/i,
            /\blying on the ground\b/i,
            /\bsprawled\b/i
        ],
        reminder:
            "Preserve any recently established fallen/downed position until the story explicitly changes it."
    },

    {
        id: "seated",
        label: "seated",
        weight: 2,
        patterns: [
            /\bsat down\b/i,
            /\bsits down\b/i,
            /\bsitting\b/i,
            /\bseated\b/i,
            /\bsat in\b/i
        ],
        reminder:
            "Preserve recently established sitting/seated positions unless the narration explicitly has someone stand or move."
    },

    {
        id: "standing",
        label: "standing",
        weight: 1,
        patterns: [
            /\bstanding\b/i,
            /\bstood up\b/i,
            /\bstands up\b/i,
            /\bgets to (?:his|her|their|my|your) feet\b/i,
            /\bon (?:his|her|their|my|your) feet\b/i
        ],
        reminder:
            "Keep established standing positions coherent with the immediately preceding movement."
    },

    {
        id: "pinned",
        label: "pinned or restrained",
        weight: 4,
        patterns: [
            /\bpinned\b/i,
            /\bpin(?:s|ned|ning)? (?:him|her|them|me|you)\b/i,
            /\bheld against\b/i,
            /\bpressed against\b/i,
            /\btrapped against\b/i,
            /\brestrained\b/i,
            /\bheld down\b/i,
            /\bheld in place\b/i,
            /\bgrappl(?:e|ed|ing)\b/i,
            /\bgrabb(?:ed|ing) (?:him|her|them|me|you)\b/i,
            /\bgrabbed by\b/i
        ],
        reminder:
            "Do not silently break or reverse an established hold, pin, restraint or trapped position; require an explicit physical change."
    },

    {
        id: "wall",
        label: "against a wall or surface",
        weight: 3,
        patterns: [
            /\bagainst the wall\b/i,
            /\bagainst a door\b/i,
            /\bagainst the floor\b/i,
            /\bagainst the table\b/i,
            /\bagainst the ground\b/i,
            /\bback against\b/i,
            /\bshoulder against\b/i,
            /\bpressed to the wall\b/i
        ],
        reminder:
            "Preserve recently established contact with a wall, door, floor, table or other surface unless movement explicitly breaks that contact."
    },

    {
        id: "moving",
        label: "active movement",
        weight: 2,
        patterns: [
            /\brunn(?:ing|ed)\b/i,
            /\brush(?:es|ed|ing)\b/i,
            /\bcharg(?:e|ed|ing)\b/i,
            /\bmov(?:e|es|ed|ing)\b/i,
            /\bwalk(?:s|ed|ing)?\b/i,
            /\bstep(?:s|ped|ping)?\b/i,
            /\bback(?:s|ed|ing) away\b/i,
            /\bretreat(?:s|ed|ing)?\b/i,
            /\blean(?:s|ed|ing)?\b/i,
            /\breach(?:es|ed|ing)?\b/i
        ],
        reminder:
            "Respect the direction and endpoint of recently narrated movement instead of resetting positions between replies."
    },

    {
        id: "dropped",
        label: "dropped object",
        weight: 3,
        patterns: [
            /\bdropped\b/i,
            /\blet go of\b/i,
            /\bslipped from (?:his|her|their|my|your) (?:hand|hands)\b/i,
            /\bfell from (?:his|her|their|my|your) hand\b/i,
            /\bon the floor beside\b/i,
            /\blanded beside\b/i
        ],
        reminder:
            "A recently dropped object should remain dropped until the story explicitly retrieves or moves it."
    },

    {
        id: "held",
        label: "held object",
        weight: 3,
        patterns: [
            /\bholding\b/i,
            /\bholds\b/i,
            /\bheld\b/i,
            /\bgripping\b/i,
            /\bgripped\b/i,
            /\bin (?:his|her|their|my|your) hand\b/i,
            /\bin (?:his|her|their|my|your) hands\b/i,
            /\bclutch(?:es|ed|ing)\b/i
        ],
        reminder:
            "Preserve ownership and hand placement of recently established held objects unless the narration explicitly transfers, drops or releases them."
    },

    {
        id: "door",
        label: "door state",
        weight: 2,
        patterns: [
            /\bdoor (?:is|was|stands|stood) open\b/i,
            /\bdoor (?:is|was) closed\b/i,
            /\bopened the door\b/i,
            /\bclosed the door\b/i,
            /\bslammed the door\b/i,
            /\bkicked the door open\b/i,
            /\bdoor swung open\b/i,
            /\bdoor swung shut\b/i
        ],
        reminder:
            "Preserve the most recently established door state unless the narration explicitly changes it."
    },

    {
        id: "furniture",
        label: "displaced furniture",
        weight: 2,
        patterns: [
            /\boverturned\b/i,
            /\bknocked over\b/i,
            /\btoppled\b/i,
            /\bflipped\b/i,
            /\bchair .* (?:fell|tipped|toppled)\b/i,
            /\btable .* (?:fell|tipped|toppled)\b/i,
            /\bdesk .* (?:fell|tipped|toppled)\b/i,
            /\bbench .* (?:fell|tipped|toppled)\b/i
        ],
        reminder:
            "Recently displaced furniture should stay displaced until someone explicitly moves or restores it."
    },

    {
        id: "broken",
        label: "broken object",
        weight: 2,
        patterns: [
            /\bbroken\b/i,
            /\bcracked\b/i,
            /\bshattered\b/i,
            /\bsplintered\b/i,
            /\bsmashed\b/i,
            /\bsnapped\b/i,
            /\bdented\b/i,
            /\bbent\b/i
        ],
        reminder:
            "Do not restore an object that was just established as broken unless repair or replacement is explicitly narrated."
    },

    {
        id: "blood_scene",
        label: "established blood or debris",
        weight: 2,
        patterns: [
            /\bblood on the floor\b/i,
            /\bblood on the wall\b/i,
            /\bbloodstain/i,
            /\bpool of blood\b/i,
            /\bdebris\b/i,
            /\brubble\b/i,
            /\bshards\b/i,
            /\bsplinters\b/i,
            /\bglass everywhere\b/i
        ],
        reminder:
            "Preserve recently established blood, debris, shards or other scene clutter as part of the physical environment."
    },

    {
        id: "distance",
        label: "established distance",
        weight: 2,
        patterns: [
            /\b(?:a few|several|two|three|four|five) (?:feet|meters|metres) away\b/i,
            /\bwithin arm(?:'s| )? reach\b/i,
            /\bwithin reach\b/i,
            /\bclose enough to touch\b/i,
            /\bacross the room\b/i,
            /\bfrom across the room\b/i,
            /\bstanding beside\b/i,
            /\bstanding next to\b/i,
            /\bnearby\b/i
        ],
        reminder:
            "Respect recently established spatial distance; characters should not silently teleport closer or farther away."
    }
];

/* ============================================================
 * SCORE RECENT HISTORY
 * ============================================================ */

function scoreSignal(signal, message) {
    let hits = 0;

    for (const pattern of signal.patterns) {
        if (pattern.test(message)) {
            hits++;
        }
    }

    return hits;
}

const facts = [];

for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    /*
     * Messages near the end of the window matter more.
     *
     * The newest message receives a strong bonus because physical
     * continuity should primarily preserve immediate action.
     */
    const distanceFromLatest = messages.length - 1 - index;

    let recencyWeight;

    if (distanceFromLatest === 0) {
        recencyWeight = CONFIG.LATEST_WEIGHT;
    } else {
        recencyWeight = Math.max(
            0.35,
            Math.pow(CONFIG.RECENCY_DECAY, distanceFromLatest)
        );
    }

    for (const signal of SIGNALS) {
        const hits = scoreSignal(signal, message);

        if (hits <= 0) continue;

        const score =
            signal.weight *
            hits *
            recencyWeight;

        facts.push({
            id: signal.id,
            label: signal.label,
            reminder: signal.reminder,
            score: score,
            hits: hits,
            messageIndex: index
        });
    }
}

/* ============================================================
 * MERGE DUPLICATES
 *
 * A fact mentioned repeatedly becomes more reliable, but repeated
 * wording doesn't produce repeated instructions.
 * ============================================================ */

const merged = new Map();

for (const fact of facts) {
    if (!merged.has(fact.id)) {
        merged.set(fact.id, {
            id: fact.id,
            label: fact.label,
            reminder: fact.reminder,
            score: fact.score,
            hits: fact.hits,
            newestIndex: fact.messageIndex
        });
        continue;
    }

    const existing = merged.get(fact.id);

    existing.score += fact.score * 0.45;
    existing.hits += fact.hits;
    existing.newestIndex = Math.max(
        existing.newestIndex,
        fact.messageIndex
    );
}

let candidates = Array.from(merged.values());

/*
 * Very old, weak evidence should not keep a physical state alive
 * forever.
 */
candidates = candidates.filter((fact) => {
    const age =
        messages.length -
        1 -
        fact.newestIndex;

    if (age <= 2) return true;

    return fact.score >= 3.5;
});

/*
 * Strongest facts first.
 *
 * Ties favor the most recently observed fact.
 */
candidates.sort((a, b) => {
    if (b.score !== a.score) {
        return b.score - a.score;
    }

    return b.newestIndex - a.newestIndex;
});

candidates = candidates.slice(0, CONFIG.MAX_FACTS);

/* ============================================================
 * CONTRADICTION DETECTION
 *
 * We don't want to insist that someone remains standing if the
 * newest message explicitly says they fell.
 *
 * The latest message gets to override older physical states.
 * ============================================================ */

const latestLower = lastMessage.toLowerCase();

function latestExplicitlyChangesState(id) {
    if (!latestLower) return false;

    const overrides = {
        fallen: [
            /\bgets? (?:back )?up\b/i,
            /\bst(?:and|ands|ood) up\b/i,
            /\brises?\b/i,
            /\bstands? up\b/i
        ],

        seated: [
            /\bstands? up\b/i,
            /\bgets? up\b/i,
            /\brises?\b/i
        ],

        standing: [
            /\bsits? down\b/i,
            /\bsat down\b/i,
            /\bfalls?\b/i,
            /\bfell\b/i,
            /\bdrops? to (?:the )?floor\b/i
        ],

        pinned: [
            /\bbreaks? free\b/i,
            /\bgets? free\b/i,
            /\bescapes?\b/i,
            /\breleases?\b/i,
            /\blet(?:s|ting) go\b/i
        ],

        dropped: [
            /\bpicks? (?:it|the(?:m|object|item)) up\b/i,
            /\bgrabs? (?:it|the(?:m|object|item))\b/i,
            /\bretrieves?\b/i
        ],

        held: [
            /\bdrops?\b/i,
            /\blets? go\b/i,
            /\breleases?\b/i,
            /\bthrows?\b/i
        ],

        door: [
            /\bopens? (?:the )?door\b/i,
            /\bcloses? (?:the )?door\b/i,
            /\bshuts? (?:the )?door\b/i
        ],

        furniture: [
            /\bputs? (?:it|the (?:chair|table|desk|bench)) back\b/i,
            /\bsets? (?:it|the (?:chair|table|desk|bench)) upright\b/i
        ],

        broken: [
            /\brepairs?\b/i,
            /\bfixes?\b/i,
            /\breplaced\b/i,
            /\brestored\b/i
        ],

        distance: [
            /\bmoves? closer\b/i,
            /\bsteps? closer\b/i,
            /\bmoves? away\b/i,
            /\bbacks? away\b/i
        ]
    };

    const patterns = overrides[id] || [];

    return patterns.some((pattern) => pattern.test(latestLower));
}

candidates = candidates.filter(
    (fact) => !latestExplicitlyChangesState(fact.id)
);

/* ============================================================
 * ACTIVATION
 * ============================================================ */

const totalScore = candidates.reduce(
    (sum, fact) => sum + fact.score,
    0
);

if (
    candidates.length === 0 ||
    totalScore < CONFIG.MIN_SCORE
) {
    if (CONFIG.DEBUG) {
        context.character.scenario +=
            "\n" +
            MARKER +
            " DEBUG: below activation threshold.";
    }

    return;
}

/* ============================================================
 * BUILD COMPACT CONTINUITY NOTE
 * ============================================================ */

const selected = [];
let budget = 0;

for (const fact of candidates) {
    const sentence =
        fact.reminder;

    const cost = estimateTokens(sentence);

    if (
        selected.length > 0 &&
        budget + cost > CONFIG.MAX_TOKENS
    ) {
        continue;
    }

    selected.push(sentence);
    budget += cost;

    if (selected.length >= CONFIG.MAX_FACTS) {
        break;
    }
}

if (selected.length === 0) {
    return;
}

/*
 * The wording is intentionally an instruction to preserve facts,
 * not an instruction to create new events.
 */
let injection =
    "\n\n" +
    MARKER +
    "\n" +
    "Maintain physical continuity with the immediately preceding story. " +
    "Do not reset established positions, object ownership, environmental " +
    "states or spatial relationships without an explicit narrated change.\n" +
    selected.map((item) => "- " + item).join("\n") +
    "\n" +
    "Do not invent a new physical event merely to satisfy this reminder.";

/*
 * Defensive token cap.
 *
 * If a future edit makes the instructions too large, trim them
 * rather than bloating every generation.
 */
if (estimateTokens(injection) > CONFIG.MAX_TOKENS) {
    injection =
        "\n\n" +
        MARKER +
        "\n" +
        "Preserve established physical continuity. " +
        selected
            .slice(0, 3)
            .map((item) => "- " + item)
            .join("\n");
}

/* ============================================================
 * SIBLING MODULE COMPATIBILITY
 *
 * If another continuity module has already inserted a note,
 * keep this module compact.
 * ============================================================ */

const scenarioAlreadyContains = context.character.scenario;

if (
    scenarioAlreadyContains.includes(MARKER)
) {
    return;
}

if (
    scenarioAlreadyContains.includes("[SCENE AFTERMATH]")
) {
    injection =
        "\n\n" +
        MARKER +
        "\n" +
        "Preserve the scene's established physical positioning, " +
        "object placement and spatial relationships. Do not reset " +
        "them without explicit narration.\n" +
        selected
            .slice(0, 3)
            .map((item) => "- " + item)
            .join("\n");
}

if (scenarioAlreadyContains.includes("[BLOODLOSS CONTINUITY]")) {
    injection =
        "\n\n" +
        MARKER +
        "\n" +
        "Keep established physical positioning and object placement " +
        "consistent with the current scene.\n" +
        selected
            .slice(0, 3)
            .map((item) => "- " + item)
            .join("\n");
}

/* ============================================================
 * OUTPUT
 * ============================================================ */

context.character.scenario += injection;

if (CONFIG.DEBUG) {
    const debugFacts = candidates
        .slice(0, 6)
        .map(
            (fact) =>
                fact.id +
                "=" +
                fact.score.toFixed(2)
        )
        .join(", ");

    context.character.scenario +=
        "\n" +
        MARKER +
        " DEBUG: " +
        "score=" +
        totalScore.toFixed(2) +
        "; facts=" +
        debugFacts +
        "; tokens~" +
        estimateTokens(injection);
}
