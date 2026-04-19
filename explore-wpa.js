// explore-wpa.js - minimal output version
const fetch = require('node-fetch');
const API_BASE  = 'https://statsapi.mlb.com/api/v1';
const API_BASE2 = 'https://statsapi.mlb.com/api/v1.1';

function getYesterdayDate() {
    const now = new Date();
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    eastern.setDate(eastern.getDate() - 1);
    return `${eastern.getFullYear()}-${String(eastern.getMonth()+1).padStart(2,'0')}-${String(eastern.getDate()).padStart(2,'0')}`;
}

function scanForKeys(obj, pattern, path = '', results = []) {
    if (!obj || typeof obj !== 'object') return results;
    for (const [k, v] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${k}` : k;
        if (pattern.test(k)) results.push({ path: fullPath, value: v });
        if (v && typeof v === 'object' && !Array.isArray(v)) scanForKeys(v, pattern, fullPath, results);
    }
    return results;
}

const WP_PATTERN = /win|prob|wpa|leverage/i;

async function main() {
    const date = getYesterdayDate();
    console.log(`Date: ${date}`);

    // Get first final game
    const schedData = await fetch(`${API_BASE}/schedule?sportId=1&date=${date}`).then(r => r.json());
    const finals = ((schedData.dates && schedData.dates[0] && schedData.dates[0].games) || [])
        .filter(g => g.status && g.status.abstractGameState === 'Final');
    if (!finals.length) { console.log('No final games found'); return; }
    const game = finals[0];
    const gamePk = game.gamePk;
    console.log(`Game: ${game.teams.away.team.name} @ ${game.teams.home.team.name} (gamePk=${gamePk})`);

    // Endpoint 1: /playByPlay
    console.log('\n--- /playByPlay ---');
    const pbp = await fetch(`${API_BASE}/game/${gamePk}/playByPlay`).then(r => r.json());
    const plays = pbp.allPlays || [];
    console.log(`Plays: ${plays.length}`);
    const found1 = new Map();
    plays.slice(0, 20).forEach(p => scanForKeys(p, WP_PATTERN).forEach(h => found1.set(h.path, h.value)));
    if (found1.size) found1.forEach((v,k) => console.log(`  FOUND: ${k} = ${JSON.stringify(v)}`));
    else console.log('  No WP fields found');

    // Endpoint 2: /playByPlay?hydrate=winProbability
    console.log('\n--- /playByPlay?hydrate=winProbability ---');
    const pbpH = await fetch(`${API_BASE}/game/${gamePk}/playByPlay?hydrate=winProbability`).then(r => r.json());
    const playsH = pbpH.allPlays || [];
    const found2 = new Map();
    playsH.slice(0, 20).forEach(p => scanForKeys(p, WP_PATTERN).forEach(h => found2.set(h.path, h.value)));
    if (found2.size) found2.forEach((v,k) => console.log(`  FOUND: ${k} = ${JSON.stringify(v)}`));
    else console.log('  No WP fields found');

    // Endpoint 3: /feed/live (v1.1)
    console.log('\n--- /api/v1.1/feed/live ---');
    const feed = await fetch(`${API_BASE2}/game/${gamePk}/feed/live`).then(r => r.json());
    const livePlays = (feed.liveData && feed.liveData.plays && feed.liveData.plays.allPlays) || [];
    console.log(`Plays: ${livePlays.length}`);
    // Check for top-level winProbability array
    if (feed.liveData && feed.liveData.winProbability) {
        const wp = feed.liveData.winProbability;
        console.log(`  TOP-LEVEL winProbability array: ${wp.length} entries`);
        console.log(`  First entry: ${JSON.stringify(wp[0])}`);
        console.log(`  Last entry:  ${JSON.stringify(wp[wp.length-1])}`);
    } else {
        console.log('  No top-level winProbability array');
    }
    const found3 = new Map();
    livePlays.slice(0, 20).forEach(p => scanForKeys(p, WP_PATTERN).forEach(h => found3.set(h.path, h.value)));
    if (found3.size) found3.forEach((v,k) => console.log(`  FOUND in plays: ${k} = ${JSON.stringify(v)}`));
    else console.log('  No WP fields in plays');

    // Endpoint 4: standalone winProbability
    console.log('\n--- /game/{gamePk}/winProbability ---');
    const wpResp = await fetch(`${API_BASE}/game/${gamePk}/winProbability`);
    console.log(`  HTTP status: ${wpResp.status}`);
    if (wpResp.ok) {
        const wpData = await wpResp.json();
        const entries = Array.isArray(wpData) ? wpData : (wpData.winProbability || []);
        console.log(`  Entries: ${entries.length}`);
        if (entries.length) {
            console.log(`  First: ${JSON.stringify(entries[0])}`);
            console.log(`  Last:  ${JSON.stringify(entries[entries.length-1])}`);
        }
    }

    console.log('\nDone.');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
