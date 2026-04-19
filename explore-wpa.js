// explore-wpa.js
// Run with: node explore-wpa.js
// Fetches play-by-play for yesterday's games and dumps WPA-related fields
// so we can see exactly what the MLB API returns before building the real page.
//
// What this script does:
//   1. Fetches yesterday's schedule to find completed games
//   2. Picks the first game (or one you specify via GAME_PK env var)
//   3. Fetches full play-by-play for that game
//   4. Dumps the raw structure of the first few plays so you can see field names
//   5. Tries to find and display win probability data across several endpoint variants
//   6. Summarizes what was found and suggests next steps

const fetch = require('node-fetch');

const API_BASE  = 'https://statsapi.mlb.com/api/v1';
const API_BASE2 = 'https://statsapi.mlb.com/api/v1.1'; // some WP data lives here

// Override with a specific gamePk if you want: GAME_PK=745528 node explore-wpa.js
const OVERRIDE_GAME_PK = process.env.GAME_PK || null;

function getYesterdayDate() {
    const now = new Date();
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    eastern.setDate(eastern.getDate() - 1);
    const y = eastern.getFullYear();
    const m = String(eastern.getMonth() + 1).padStart(2, '0');
    const d = String(eastern.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function divider(label) {
    console.log('\n' + '='.repeat(70));
    if (label) console.log('  ' + label);
    console.log('='.repeat(70));
}

// Recursively scan an object for keys matching a pattern
function scanForKeys(obj, pattern, path = '', results = []) {
    if (!obj || typeof obj !== 'object') return results;
    for (const [k, v] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${k}` : k;
        if (pattern.test(k.toLowerCase())) {
            results.push({ path: fullPath, value: v });
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            scanForKeys(v, pattern, fullPath, results);
        }
    }
    return results;
}

const WP_PATTERN = /win|prob|wpa|leverage/i;

async function main() {
    const date = getYesterdayDate();
    divider(`WPA Exploration Script — ${date}`);

    // ------------------------------------------------------------------
    // Step 1: Find a game
    // ------------------------------------------------------------------
    let gamePk = OVERRIDE_GAME_PK;
    let gameLabel = '';

    if (!gamePk) {
        console.log('\nFetching schedule...');
        const resp = await fetch(`${API_BASE}/schedule?sportId=1&date=${date}`);
        const data = await resp.json();
        const games = (data.dates && data.dates[0] && data.dates[0].games) || [];
        const finals = games.filter(g => g.status && g.status.abstractGameState === 'Final');

        if (finals.length === 0) {
            console.log('No final games found for', date);
            console.log('Try:  GAME_PK=<id> node explore-wpa.js');
            return;
        }

        console.log(`\nFinal games on ${date}:`);
        finals.forEach(g =>
            console.log(`  gamePk=${g.gamePk}  ${g.teams.away.team.name} @ ${g.teams.home.team.name}`)
        );

        const chosen = finals[0];
        gamePk = chosen.gamePk;
        gameLabel = `${chosen.teams.away.team.name} @ ${chosen.teams.home.team.name}`;
        console.log(`\nUsing first game: gamePk=${gamePk}  (${gameLabel})`);
        console.log('Override with:  GAME_PK=<id> node explore-wpa.js');
    } else {
        gameLabel = `manually specified gamePk=${gamePk}`;
        console.log(`\nUsing: ${gameLabel}`);
    }

    // ------------------------------------------------------------------
    // Step 2: /playByPlay (v1)
    // ------------------------------------------------------------------
    divider('Endpoint 1: /api/v1/game/{gamePk}/playByPlay');
    const pbpURL = `${API_BASE}/game/${gamePk}/playByPlay`;
    console.log('URL:', pbpURL);
    const pbpResp = await fetch(pbpURL);
    const pbpData = await pbpResp.json();
    const pbpPlays = pbpData.allPlays || [];
    console.log(`Plays: ${pbpPlays.length}`);
    console.log('Top-level response keys:', Object.keys(pbpData));

    if (pbpPlays.length > 0) {
        console.log('\nKeys on play[0]:', Object.keys(pbpPlays[0]));

        // Scan first 10 plays for anything WP-related
        const found = [];
        for (const play of pbpPlays.slice(0, 10)) {
            const hits = scanForKeys(play, WP_PATTERN);
            hits.forEach(h => {
                if (!found.find(f => f.path === h.path)) found.push(h);
            });
        }

        if (found.length > 0) {
            console.log('\n[WIN PROBABILITY FIELDS FOUND]:');
            found.forEach(f => console.log(`  ${f.path}: ${JSON.stringify(f.value)}`));
        } else {
            console.log('\nNo win/probability/wpa keys found in first 10 plays of this endpoint.');
        }

        console.log('\n--- play[0] full JSON ---');
        console.log(JSON.stringify(pbpPlays[0], null, 2));
    }

    // ------------------------------------------------------------------
    // Step 3: /playByPlay?hydrate=winProbability
    // ------------------------------------------------------------------
    divider('Endpoint 2: /playByPlay?hydrate=winProbability');
    const hydrateURL = `${API_BASE}/game/${gamePk}/playByPlay?hydrate=winProbability`;
    console.log('URL:', hydrateURL);
    const hydrateResp = await fetch(hydrateURL);
    const hydrateData = await hydrateResp.json();
    const hydratePlays = hydrateData.allPlays || [];
    console.log(`Plays: ${hydratePlays.length}`);

    if (hydratePlays.length > 0) {
        const found = [];
        for (const play of hydratePlays.slice(0, 10)) {
            const hits = scanForKeys(play, WP_PATTERN);
            hits.forEach(h => {
                if (!found.find(f => f.path === h.path)) found.push(h);
            });
        }
        if (found.length > 0) {
            console.log('\n[WIN PROBABILITY FIELDS FOUND with hydrate]:');
            found.forEach(f => console.log(`  ${f.path}: ${JSON.stringify(f.value)}`));
            console.log('\n--- play[0] full JSON (hydrated) ---');
            console.log(JSON.stringify(hydratePlays[0], null, 2));
        } else {
            console.log('No win/probability/wpa keys found with hydrate param either.');
        }
    }

    // ------------------------------------------------------------------
    // Step 4: /feed/live (v1.1) — this is where WP often lives
    // ------------------------------------------------------------------
    divider('Endpoint 3: /api/v1.1/game/{gamePk}/feed/live');
    const feedURL = `${API_BASE2}/game/${gamePk}/feed/live`;
    console.log('URL:', feedURL);
    try {
        const feedResp = await fetch(feedURL);
        const feedData = await feedResp.json();
        const livePlays = (
            feedData.liveData &&
            feedData.liveData.plays &&
            feedData.liveData.plays.allPlays
        ) || [];
        console.log(`Plays in live feed: ${livePlays.length}`);
        console.log('liveData keys:', Object.keys(feedData.liveData || {}));
        console.log('plays keys:', Object.keys((feedData.liveData && feedData.liveData.plays) || {}));

        if (livePlays.length > 0) {
            console.log('\nKeys on livePlays[0]:', Object.keys(livePlays[0]));

            const found = [];
            for (const play of livePlays.slice(0, 10)) {
                const hits = scanForKeys(play, WP_PATTERN);
                hits.forEach(h => {
                    if (!found.find(f => f.path === h.path)) found.push(h);
                });
            }
            if (found.length > 0) {
                console.log('\n[WIN PROBABILITY FIELDS FOUND in live feed]:');
                found.forEach(f => console.log(`  ${f.path}: ${JSON.stringify(f.value)}`));
                console.log('\n--- livePlays[0] full JSON ---');
                console.log(JSON.stringify(livePlays[0], null, 2));
            } else {
                console.log('No win/probability/wpa keys found in live feed plays.');
                console.log('\n--- livePlays[0] full JSON (for manual inspection) ---');
                console.log(JSON.stringify(livePlays[0], null, 2));
            }

            // Also check for a top-level winProbability array (sometimes separate)
            if (feedData.liveData.winProbability) {
                console.log('\n[TOP-LEVEL winProbability array found in liveData]:');
                console.log('Length:', feedData.liveData.winProbability.length);
                console.log('First entry:', JSON.stringify(feedData.liveData.winProbability[0], null, 2));
                console.log('Last entry:', JSON.stringify(
                    feedData.liveData.winProbability[feedData.liveData.winProbability.length - 1], null, 2
                ));
            }
        }
    } catch (e) {
        console.log('Error fetching live feed:', e.message);
    }

    // ------------------------------------------------------------------
    // Step 5: Try a standalone winProbability endpoint
    // ------------------------------------------------------------------
    divider('Endpoint 4: /game/{gamePk}/winProbability (standalone)');
    const wpURL = `${API_BASE}/game/${gamePk}/winProbability`;
    console.log('URL:', wpURL);
    try {
        const wpResp = await fetch(wpURL);
        console.log('HTTP status:', wpResp.status);
        if (wpResp.ok) {
            const wpData = await wpResp.json();
            console.log('Response keys:', Object.keys(wpData));
            console.log('Full response:');
            console.log(JSON.stringify(wpData, null, 2));
        } else {
            console.log('Endpoint returned non-OK status — probably does not exist.');
        }
    } catch (e) {
        console.log('Error:', e.message);
    }

    divider('Done — review output above to find WPA field paths');
    console.log(`
Things to look for:
  - homeTeamWinProbability / awayTeamWinProbability (before and after each play)
  - WPA = winProbAfter - winProbBefore (home team perspective)
  - A separate top-level winProbability array in the live feed liveData object
  - Field names like "homeWinProbabilityFavorite", "atBatWinProb", etc.

Once you find the right path, report back and we'll build the actual page.
`);
}

main().catch(err => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
});
