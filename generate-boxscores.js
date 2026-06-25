const fs = require('fs');
const config = require('./config.json');

const API_BASE = 'https://statsapi.mlb.com/api/v1';

async function withConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    let index = 0;
    async function worker() {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

// Get yesterday's date in Eastern time (YYYY-MM-DD)
function getYesterdayDate() {
    const now = new Date();
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    eastern.setDate(eastern.getDate() - 1);
    const year = eastern.getFullYear();
    const month = String(eastern.getMonth() + 1).padStart(2, '0');
    const day = String(eastern.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Format a rate stat (OBP, AVG, etc.) without leading zero
// OPS can exceed 1.000, so handle that case
function formatOPS(val) {
    if (!val || isNaN(parseFloat(val))) return '-';
    const num = parseFloat(val);
    if (num >= 1) return num.toFixed(3);
    return num.toFixed(3).replace(/^0/, '');
}

async function fetchSchedule(date) {
    const url = `${API_BASE}/schedule?sportId=1&date=${date}&hydrate=linescore,decisions`;
    const response = await fetch(url);
    const data = await response.json();
    return data.dates && data.dates.length > 0 ? data.dates[0].games : [];
}

async function fetchBoxscore(gamePk) {
    const url = `${API_BASE}/game/${gamePk}/boxscore`;
    const response = await fetch(url);
    return response.json();
}

// Fetch all MLB teams for the season and build an id -> abbreviation map
// Also returns divMap: id -> { divisionId, leagueId } for grouping jump links
async function fetchTeamMap(season) {
    const url = `${API_BASE}/teams?sportId=1&season=${season}`;
    const response = await fetch(url);
    const data = await response.json();
    const abbrMap = {};
    const divMap = {};
    (data.teams || []).forEach(t => {
        abbrMap[t.id] = t.abbreviation;
        divMap[t.id] = {
            divisionId: t.division && t.division.id,
            leagueId:   t.league   && t.league.id
        };
    });
    return { abbrMap, divMap };
}

// Build a Baseball Savant player URL from name + MLB id
function statcastURL(fullName, id) {
    const slug = fullName.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    return `https://baseballsavant.mlb.com/savant-player/${slug}-${id}`;
}

// Generate the inning-by-inning linescore table
function generateLinescoreHTML(linescore, awayAbbr, homeAbbr) {
    if (!linescore || !linescore.innings) return '';

    const innings = linescore.innings;
    const numInnings = Math.max(innings.length, 9);

    let html = '<table class="linescore-table"><thead><tr>';
    html += '<th class="ls-team">Team</th>';
    for (let i = 1; i <= numInnings; i++) {
        html += `<th>${i}</th>`;
    }
    html += '<th class="ls-rhe-sep">R</th><th>H</th><th>E</th>';
    html += '</tr></thead><tbody>';

    // Away row
    html += '<tr>';
    html += `<td class="ls-team">${awayAbbr}</td>`;
    for (let i = 0; i < numInnings; i++) {
        const inning = innings[i];
        const runs = inning && inning.away && inning.away.runs !== undefined
            ? inning.away.runs : (i < innings.length ? '' : '');
        html += `<td>${runs}</td>`;
    }
    const awayTotals = linescore.teams && linescore.teams.away ? linescore.teams.away : {};
    html += `<td class="ls-rhe-sep ls-bold">${awayTotals.runs !== undefined ? awayTotals.runs : ''}</td>`;
    html += `<td class="ls-bold">${awayTotals.hits !== undefined ? awayTotals.hits : ''}</td>`;
    html += `<td class="ls-bold">${awayTotals.errors !== undefined ? awayTotals.errors : ''}</td>`;
    html += '</tr>';

    // Home row
    html += '<tr>';
    html += `<td class="ls-team">${homeAbbr}</td>`;
    for (let i = 0; i < numInnings; i++) {
        const inning = innings[i];
        let runs = '';
        if (inning && inning.home) {
            // runs undefined = walk-off, bottom not played
            runs = inning.home.runs !== undefined ? inning.home.runs : 'x';
        } else if (i < innings.length) {
            runs = 'x';
        }
        html += `<td>${runs}</td>`;
    }
    const homeTotals = linescore.teams && linescore.teams.home ? linescore.teams.home : {};
    html += `<td class="ls-rhe-sep ls-bold">${homeTotals.runs !== undefined ? homeTotals.runs : ''}</td>`;
    html += `<td class="ls-bold">${homeTotals.hits !== undefined ? homeTotals.hits : ''}</td>`;
    html += `<td class="ls-bold">${homeTotals.errors !== undefined ? homeTotals.errors : ''}</td>`;
    html += '</tr>';

    html += '</tbody></table>';
    return html;
}

// Generate batting table for one team
// Returns { html, subs } where subs = [ { name, type } ] for PR/DEF players who didn't bat
function generateBattingHTML(teamData, teamName) {
    const players = teamData.players || {};

    // Sort all players by their battingOrder property (e.g. "400", "401")
    // 0 or missing = not a batter (pitcher, PR, DEF sub)
    const allByOrder = Object.values(players)
        .filter(p => p.battingOrder && parseInt(p.battingOrder) > 0)
        .sort((a, b) => parseInt(a.battingOrder) - parseInt(b.battingOrder));

    // A player is a substitute if battingOrder doesn't end in "0" (e.g. "401" not "400")
    const isSub = p => p.battingOrder && parseInt(p.battingOrder) % 10 !== 0;

    // Players with a battingOrder but zero PAs: PR or defensive subs
    const nonBatters = allByOrder.filter(p => {
        const s = p.stats && p.stats.batting;
        const pa = s ? (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0) : 0;
        return pa === 0;
    });
    const subs = nonBatters.map(p => {
        const pos = p.position ? p.position.abbreviation : '';
        const type = pos === 'PR' ? 'PR' : 'DEF';
        return { name: p.person.fullName, type, pos };
    });

    // Active batters: had at least one PA
    const active = allByOrder.filter(p => {
        const s = p.stats && p.stats.batting;
        if (!s) return false;
        return (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0) > 0;
    });

    // Catch edge cases: players with stats but no battingOrder (rare DH swap etc.)
    const seenIds = new Set(allByOrder.map(p => p.person.id));
    Object.values(players).forEach(p => {
        if (seenIds.has(p.person.id)) return;
        const s = p.stats && p.stats.batting;
        if (s && (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0) > 0) {
            active.push(p);
        }
    });

    if (active.length === 0) return { html: '', subs };

    const totals = teamData.teamStats && teamData.teamStats.batting ? teamData.teamStats.batting : null;

    let html = `<div class="section-title">${teamName} Batting</div>`;
    html += '<div class="table-scroll"><table class="box-table">';
    html += '<thead><tr>';
    html += '<th class="name-col">Batter</th>';
    html += '<th class="stat-num">PA</th>';
    html += '<th class="stat-num">R</th>';
    html += '<th class="stat-num">H</th>';
    html += '<th class="stat-num">RBI</th>';
    html += '<th class="stat-num">2B</th>';
    html += '<th class="stat-num">HR</th>';
    html += '<th class="stat-num">BB+</th>';
    html += '<th class="stat-num">SO</th>';
    html += '<th class="stat-num">SB</th>';
    html += '<th class="stat-num season-col">OPS</th>';
    html += '</tr></thead><tbody>';

    active.forEach(p => {
        const s = p.stats.batting;
        const pos = p.position ? p.position.abbreviation : '';
        const seasonOPS = p.seasonStats && p.seasonStats.batting
            ? formatOPS(p.seasonStats.batting.ops) : '-';
        const sub = isSub(p);
        const batterURL = statcastURL(p.person.fullName, p.person.id);
        const nameCell = sub
            ? `&nbsp;&nbsp;<a href="${batterURL}" class="player-link" target="_blank" rel="noopener">${p.person.fullName}</a> <span class="pos-tag">${pos}</span>`
            : `<a href="${batterURL}" class="player-link" target="_blank" rel="noopener">${p.person.fullName}</a> <span class="pos-tag">${pos}</span>`;
        html += sub ? '<tr class="sub-row">' : '<tr>';
        html += `<td class="name-col">${nameCell}</td>`;
        const pa = (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0);
        html += `<td class="stat-num">${pa}</td>`;
        html += `<td class="stat-num">${s.runs || 0}</td>`;
        html += `<td class="stat-num">${s.hits || 0}</td>`;
        html += `<td class="stat-num">${s.rbi || 0}</td>`;
        html += `<td class="stat-num">${s.doubles || 0}</td>`;
        html += `<td class="stat-num">${s.homeRuns || 0}</td>`;
        html += `<td class="stat-num">${(s.baseOnBalls || 0) + (s.hitByPitch || 0)}</td>`;
        html += `<td class="stat-num">${s.strikeOuts || 0}</td>`;
        html += `<td class="stat-num">${s.stolenBases || 0}</td>`;
        html += `<td class="stat-num season-col">${seasonOPS}</td>`;
        html += '</tr>';
    });

    if (totals) {
        html += '<tr class="totals-row">';
        html += '<td class="name-col">Totals</td>';
        const totalPA = (totals.atBats||0)+(totals.baseOnBalls||0)+(totals.hitByPitch||0)+(totals.sacFlies||0)+(totals.sacBunts||0);
        html += `<td class="stat-num">${totalPA}</td>`;
        html += `<td class="stat-num">${totals.runs || 0}</td>`;
        html += `<td class="stat-num">${totals.hits || 0}</td>`;
        html += `<td class="stat-num">${totals.rbi || 0}</td>`;
        html += `<td class="stat-num">${totals.doubles || 0}</td>`;
        html += `<td class="stat-num">${totals.homeRuns || 0}</td>`;
        html += `<td class="stat-num">${(totals.baseOnBalls || 0) + (totals.hitByPitch || 0)}</td>`;
        html += `<td class="stat-num">${totals.strikeOuts || 0}</td>`;
        html += `<td class="stat-num">${totals.stolenBases || 0}</td>`;
        html += '<td class="stat-num season-col"></td>';
        html += '</tr>';
    }

    html += '</tbody></table></div>';
    return { html, subs };
}

// Generate pitching table for one team
function generatePitchingHTML(teamData, teamName) {
    const players = teamData.players || {};
    const pitcherIds = teamData.pitchers || [];

    const pitchers = pitcherIds
        .map(id => players[`ID${id}`])
        .filter(p => {
            if (!p || !p.stats || !p.stats.pitching) return false;
            const s = p.stats.pitching;
            if (parseFloat(s.inningsPitched || 0) > 0) return true;
            return (s.hits || 0) + (s.baseOnBalls || 0) + (s.hitByPitch || 0)
                 + (s.strikeOuts || 0) + (s.runs || 0) > 0;
        });

    if (pitchers.length === 0) return '';

    let html = `<div class="section-title">${teamName} Pitching</div>`;
    html += '<div class="table-scroll"><table class="box-table">';
    html += '<thead><tr>';
    html += '<th class="name-col">Pitcher</th>';
    html += '<th class="stat-num">IP</th>';
    html += '<th class="stat-num">H</th>';
    html += '<th class="stat-num">R</th>';
    html += '<th class="stat-num">ER</th>';
    html += '<th class="stat-num">BB</th>';
    html += '<th class="stat-num">SO</th>';
    html += '<th class="stat-num">HR</th>';
    html += '<th class="stat-num season-col">ERA</th>';
    html += '</tr></thead><tbody>';

    pitchers.forEach(p => {
        const s = p.stats.pitching;
        const seasonERA = p.seasonStats && p.seasonStats.pitching && p.seasonStats.pitching.era !== undefined
            ? parseFloat(p.seasonStats.pitching.era).toFixed(2) : '-';

        const pitcherURL = statcastURL(p.person.fullName, p.person.id);
        html += '<tr>';
        html += `<td class="name-col"><a href="${pitcherURL}" class="player-link" target="_blank" rel="noopener">${p.person.fullName}</a></td>`;
        html += `<td class="stat-num">${parseFloat(s.inningsPitched || 0).toFixed(1)}</td>`;
        html += `<td class="stat-num">${s.hits || 0}</td>`;
        html += `<td class="stat-num">${s.runs || 0}</td>`;
        html += `<td class="stat-num">${s.earnedRuns || 0}</td>`;
        html += `<td class="stat-num">${s.baseOnBalls || 0}</td>`;
        html += `<td class="stat-num">${s.strikeOuts || 0}</td>`;
        html += `<td class="stat-num">${s.homeRuns || 0}</td>`;
        html += `<td class="stat-num season-col">${seasonERA}</td>`;
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

// Generate W/L/SV decisions line plus PR/DEF subs for each team
function generateDecisionsHTML(decisions, awayAbbr, awaySubs, homeAbbr, homeSubs) {
    const parts = [];
    if (decisions) {
        if (decisions.winner) parts.push(`W: ${decisions.winner.fullName}`);
        if (decisions.loser)  parts.push(`L: ${decisions.loser.fullName}`);
        if (decisions.save)   parts.push(`SV: ${decisions.save.fullName}`);
    }

    // Combine subs from both teams, tagging each with their team abbr
    const allSubs = [
        ...(awaySubs || []).map(s => ({ ...s, team: awayAbbr })),
        ...(homeSubs  || []).map(s => ({ ...s, team: homeAbbr })),
    ];

    const prs  = allSubs.filter(s => s.type === 'PR') .map(s => `${s.name} (${s.team})`);
    const defs = allSubs.filter(s => s.type === 'DEF').map(s => `${s.name} (${s.pos}/${s.team})`);

    if (parts.length === 0 && !prs.length && !defs.length) return '';

    let html = `<div class="decisions">`;
    if (parts.length) html += parts.join(' &nbsp;&bull;&nbsp; ');
    if (prs.length)  html += `${parts.length ? '<br>' : ''}<span class="subs-line">PR: ${prs.join(' &nbsp;&bull;&nbsp; ')}</span>`;
    if (defs.length) html += `${(parts.length || prs.length) ? '<br>' : ''}<span class="subs-line">DEF: ${defs.join(' &nbsp;&bull;&nbsp; ')}</span>`;
    html += '</div>';
    return html;
}

// Extract batting stats for JSON output
function extractBattingData(teamData) {
    const players = teamData.players || {};
    const allByOrder = Object.values(players)
        .filter(p => p.battingOrder && parseInt(p.battingOrder) > 0)
        .sort((a, b) => parseInt(a.battingOrder) - parseInt(b.battingOrder));
    const seenIds = new Set(allByOrder.map(p => p.person.id));
    const active = allByOrder.filter(p => {
        const s = p.stats && p.stats.batting;
        if (!s) return false;
        return (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0) > 0;
    });
    Object.values(players).forEach(p => {
        if (seenIds.has(p.person.id)) return;
        const s = p.stats && p.stats.batting;
        if (s && (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0) > 0)
            active.push(p);
    });
    return active.map(p => {
        const s = p.stats.batting;
        const ab  = s.atBats     || 0;
        const bb  = s.baseOnBalls || 0;
        const hbp = s.hitByPitch  || 0;
        const sf  = s.sacFlies    || 0;
        const sh  = s.sacBunts    || 0;
        return {
            name: p.person.fullName,
            PA: ab + bb + hbp + sf + sh,
            AB: ab,
            R: s.runs     || 0,
            H:       s.hits      || 0,
            doubles: s.doubles  || 0,
            triples: s.triples  || 0,
            HR: s.homeRuns || 0,
            RBI: s.rbi    || 0,
            BB: bb + hbp,
        };
    });
}

// Extract pitching stats for JSON output
function extractPitchingData(teamData) {
    const players = teamData.players || {};
    const pitcherIds = teamData.pitchers || [];
    return pitcherIds
        .map(id => players[`ID${id}`])
        .filter(p => {
            if (!p || !p.stats || !p.stats.pitching) return false;
            const s = p.stats.pitching;
            return parseFloat(s.inningsPitched || 0) > 0 ||
                (s.hits||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.strikeOuts||0)+(s.runs||0) > 0;
        })
        .map(p => {
            const s = p.stats.pitching;
            const ip  = parseFloat(s.inningsPitched || 0);
            const er  = s.earnedRuns  || 0;
            const bb  = s.baseOnBalls || 0;
            const k   = s.strikeOuts  || 0;
            const hr  = s.homeRuns    || 0;
            const hbp = s.hitByPitch  || 0;
            let par = null;
            if (ip > 0) {
                const era = (er / ip) * 9;
                const fip = ((13 * hr) + (3 * (bb + hbp)) - (2 * k)) / ip + 3.10;
                par = Math.round((6.00 - (fip + era) / 2) * ip / 9 * 100) / 100;
            }
            return {
                name: p.person.fullName,
                IP: ip,
                H: s.hits || 0,
                ER: er,
                BB: bb,
                K: k,
                par,
            };
        });
}

// Fetch win probability data for a game
async function fetchWPA(gamePk) {
    try {
        const url = `${API_BASE}/game/${gamePk}/winProbability`;
        const response = await fetch(url);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn(`WPA fetch failed for gamePk ${gamePk}: ${e.message}`);
        return [];
    }
}

// Batting events where pitcher attribution makes sense
const BATTING_EVENTS = new Set([
    'Single', 'Double', 'Triple', 'Home Run',
    'Walk', 'Intent Walk', 'Hit By Pitch',
    'Strikeout', 'Groundout', 'Flyout', 'Lineout', 'Pop Out',
    'Grounded Into DP', 'Double Play', 'Triple Play',
    'Sac Fly', 'Sac Bunt', 'Field Error', 'Fielders Choice'
]);

// Format inning string e.g. "top 7th" or "bot 9th"
function formatInning(about) {
    const num = about.inning || '?';
    const half = about.isTopInning ? 'TOP' : 'BOT';
    const suffix = num === 1 ? 'st' : num === 2 ? 'nd' : num === 3 ? 'rd' : 'th';
    return `${half} ${num}${suffix}`;
}

// Generate Key Plays (WPA) section
// API returns WPA in percentage points (0-100 scale), so 20 = 20pp swing = 0.20 WPA
function generateWPAHTML(plays, awayAbbr, homeAbbr) {
    const SECONDARY_THRESHOLD = 20;
    const MAX_PLAYS = 3;

    if (!plays || plays.length === 0) return '';

    // Sort all plays by absolute WPA descending
    const sorted = plays
        .filter(p => (p.homeTeamWinProbabilityAdded || 0) !== 0)
        .sort((a, b) => Math.abs(b.homeTeamWinProbabilityAdded) - Math.abs(a.homeTeamWinProbabilityAdded));

    if (sorted.length === 0) return '';

    // Always include the top play, then add others over the threshold, up to MAX_PLAYS
    const notable = [sorted[0]];
    for (let i = 1; i < sorted.length && notable.length < MAX_PLAYS; i++) {
        if (Math.abs(sorted[i].homeTeamWinProbabilityAdded) >= SECONDARY_THRESHOLD) {
            notable.push(sorted[i]);
        } else {
            break; // sorted descending, so no point continuing
        }
    }

    let html = '<div class="wpa-section">';
    html += '<div class="wpa-title">Key Plays</div>';

    notable.forEach(play => {
        const wpaRaw = play.homeTeamWinProbabilityAdded || 0;
        // Convert from percentage points to conventional WPA decimal (+.31 format)
        const wpaDisplay = (Math.abs(wpaRaw) / 100).toFixed(2);
        const inning = formatInning(play.about || {});
        const desc = (play.result && play.result.description) || '';
        const event = (play.result && play.result.event) || '';
        const pitcher = play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName;

        // Score after the play, labeled with team abbreviations
        const awayScore = play.result && play.result.awayScore !== undefined ? play.result.awayScore : '';
        const homeScore = play.result && play.result.homeScore !== undefined ? play.result.homeScore : '';
        const scoreStr = (awayScore !== '' && homeScore !== '')
            ? ` -- ${awayAbbr} ${awayScore}, ${homeAbbr} ${homeScore}`
            : '';

        // Append pitcher only for true batting events
        let fullDesc = desc;
        if (pitcher && BATTING_EVENTS.has(event)) {
            fullDesc += ` (pitcher: ${pitcher})`;
        }
        fullDesc += `<span class="wpa-score">${scoreStr}</span>`;

        html += `<div class="wpa-play">`;
        html += `<span class="wpa-badge">+${wpaDisplay}</span>`;
        html += `<span class="wpa-inning">${inning}</span>`;
        html += `<span class="wpa-desc">${fullDesc}</span>`;
        html += `</div>`;
    });

    html += '</div>';
    return html;
}

// Build the four daily leaderboard tables
// wpa values arrive as percentage points (0-100 scale); divide by 100 for display
function generateLeaderboardsHTML(topLwts, topPAR, topRelief, topExcitement, topWPAPlays) {
    if (!topLwts.length && !topPAR.length && !topRelief.length && !topExcitement.length && !topWPAPlays.length) return '';

    function panel(title, headers, rows) {
        let html = `<div class="lb-panel"><div class="lb-panel-title">${title}</div>`;
        if (rows.length === 0) {
            html += '<div class="lb-empty">No data available.</div></div>';
            return html;
        }
        html += '<table class="lb-table"><thead><tr>';
        headers.forEach((h, j) => {
            const cls = j === 0 ? 'lb-rank' : j === 1 ? '' : 'lb-th-num';
            html += `<th${cls ? ` class="${cls}"` : ''}>${h}</th>`;
        });
        html += '</tr></thead><tbody>';
        rows.forEach(row => {
            html += '<tr>';
            row.forEach((cell, j) => {
                const cls = j === 0 ? 'lb-rank' : j === 1 ? 'lb-name' : 'lb-num';
                html += `<td class="${cls}">${cell}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        return html;
    }

    function playerLink(name, id) {
        return `<a href="${statcastURL(name, id)}" class="lb-player-link" target="_blank" rel="noopener">${name}</a>`;
    }

    const lwtsRows = topLwts.map((r, i) => [
        i + 1,
        `${playerLink(r.name, r.id)} <span class="lb-team">${r.team}</span>`,
        r.lwts.toFixed(2)
    ]);

    const parRows = topPAR.map((r, i) => [
        i + 1,
        `${playerLink(r.name, r.id)} <span class="lb-team">${r.team}</span>`,
        r.ip.toFixed(1),
        r.par.toFixed(2)
    ]);

    const reliefRows = topRelief.map((r, i) => [
        i + 1,
        `${playerLink(r.name, r.id)} <span class="lb-team">${r.team}</span>`,
        (r.wpa / 100).toFixed(3)
    ]);

    const excitementRows = topExcitement.map((r, i) => [
        i + 1,
        r.innings > 9 ? `${r.label} (${r.innings})` : r.label,
        (r.absWPA / 100).toFixed(2)
    ]);

    // Top WPA plays: wide panel, one row per play
    let wpaPlaysHTML = '';
    if (topWPAPlays.length > 0) {
        wpaPlaysHTML += '<div class="lb-panel lb-panel-wide"><div class="lb-panel-title">Top WPA Plays of the Day</div>';
        wpaPlaysHTML += '<table class="lb-table"><thead><tr>';
        wpaPlaysHTML += '<th></th><th>Game</th><th class="lb-th-center">Inn</th><th>Play</th><th>Score</th><th class="lb-th-num">WPA</th>';
        wpaPlaysHTML += '</tr></thead><tbody>';
        topWPAPlays.forEach((p, i) => {
            const scoreStr = (p.awayScore !== '' && p.homeScore !== '')
                ? `${p.awayAbbr} ${p.awayScore}, ${p.homeAbbr} ${p.homeScore}` : '';
            const wpaDisplay = (p.absWPA / 100).toFixed(3);
            wpaPlaysHTML += '<tr>';
            wpaPlaysHTML += `<td class="lb-rank">${i + 1}</td>`;
            wpaPlaysHTML += `<td class="lb-name">${p.gameLabel}</td>`;
            wpaPlaysHTML += `<td class="lb-center">${p.inning}</td>`;
            wpaPlaysHTML += `<td class="lb-desc">${p.desc}</td>`;
            wpaPlaysHTML += `<td class="lb-num" style="white-space:nowrap">${scoreStr}</td>`;
            wpaPlaysHTML += `<td class="lb-num">+${wpaDisplay}</td>`;
            wpaPlaysHTML += '</tr>';
        });
        wpaPlaysHTML += '</tbody></table></div>';
    }

    let html = '<div class="lb-section">';
    html += '<div class="lb-section-title">Daily Leaderboards</div>';
    html += '<div class="lb-grid">';
    html += panel('Top Batters (Linear Weights)', ['', 'Player', 'LWTS'], lwtsRows);
    html += panel('Top Pitchers (PAR)', ['', 'Player', 'IP', 'PAR'], parRows);
    html += panel('Top Relief Appearances (WPA)', ['', 'Pitcher', 'WPA'], reliefRows);
    html += panel('Most Exciting Games', ['', 'Game', 'WPA'], excitementRows);
    html += '</div>';
    html += wpaPlaysHTML;
    html += '</div>';
    return html;
}

async function generateHTML() {
    const date = getYesterdayDate();
    console.log(`Fetching games for ${date}...`);

    const season = new Date().getFullYear();
    const { abbrMap: teamMap, divMap } = await fetchTeamMap(season);
    console.log(`Loaded abbreviations for ${Object.keys(teamMap).length} teams`);

    const games = await fetchSchedule(date);

    // Only include completed, non-postponed games
    const finalGames = games.filter(g =>
        g.status && g.status.abstractGameState === 'Final' &&
        g.status.statusCode !== 'PPD'
    );

    // Collect postponed / cancelled games for display in jump links
    const PPD_CODES = new Set(['PPD', 'DR', 'CO']);
    const deferredGames = games.filter(g =>
        g.status && (
            PPD_CODES.has(g.status.statusCode) ||
            (g.status.detailedState && /postponed|cancelled/i.test(g.status.detailedState))
        )
    );

    console.log(`Found ${finalGames.length} final games on ${date}`);

    // Format dates for display
    // Add T12:00:00 to avoid timezone shifting the date itself
    const displayDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const now = new Date();
    const updatedStr = now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });

    // Leaderboard accumulators (filled during game loop, rendered after)
    const lwtsAccum    = {};  // { [playerId]: { name, team, lwts } }
    const parAccum     = {};  // { [playerId]: { name, team, ip, par } }
    const reliefAccum  = {};  // { [playerId]: { name, team, wpa (pp) } }
    const excitement   = [];  // [ { label, absWPA (pp) } ]
    const allWPAPlays  = [];  // top plays across all games for daily WPA leaderboard
    const gamesData    = [];  // structured data for boxscore-data.json

    let gamesHTML = '';
    const jumpLinks = [];

    // Fetch all game data in parallel, then process sequentially
    const gameData = await withConcurrency(finalGames, config.concurrency, async (game) => {
        const awayTeam = game.teams.away.team;
        const homeTeam = game.teams.home.team;
        console.log(`Fetching boxscore for ${awayTeam.name} @ ${homeTeam.name}...`);
        const boxscore = await fetchBoxscore(game.gamePk);
        console.log(`Fetching WPA for ${awayTeam.name} @ ${homeTeam.name}...`);
        const wpaPlays = await fetchWPA(game.gamePk);
        return { game, boxscore, wpaPlays };
    });

    for (const { game, boxscore, wpaPlays } of gameData) {
        const gamePk = game.gamePk;
        const awayTeam = game.teams.away.team;
        const homeTeam = game.teams.home.team;
        const awayAbbr = teamMap[awayTeam.id] || awayTeam.abbreviation || awayTeam.name;
        const homeAbbr = teamMap[homeTeam.id] || homeTeam.abbreviation || homeTeam.name;
        const awayScore = game.teams.away.score !== undefined ? game.teams.away.score : game.linescore?.teams?.away?.runs;
        const homeScore = game.teams.home.score !== undefined ? game.teams.home.score : game.linescore?.teams?.home?.runs;
        if (awayScore === undefined || homeScore === undefined) {
            console.warn(`Skipping game ${game.gamePk} (${awayTeam.name} @ ${homeTeam.name}): scores unavailable`);
            continue;
        }
        const gameNumber = game.gameNumber > 1 ? ` - Game ${game.gameNumber}` : '';
        const gameId = `game-${gamePk}`;

        const linescore = game.linescore;
        const decisions = game.decisions;

        // --- Accumulate leaderboard data ---

        // Starters = first pitcher listed for each team
        const awayStarterId = boxscore.teams.away.pitchers && boxscore.teams.away.pitchers[0];
        const homeStarterId = boxscore.teams.home.pitchers && boxscore.teams.home.pitchers[0];
        const starterIds = new Set([awayStarterId, homeStarterId].filter(Boolean));

        // Linear weights per batter (LWTS coefficients: 1B .47, 2B .77, 3B 1.07, HR 1.40, BB .33, HBP .34, out -.27)
        for (const side of ['away', 'home']) {
            const abbr = side === 'away' ? awayAbbr : homeAbbr;
            const players = boxscore.teams[side].players || {};
            Object.values(players).forEach(p => {
                const s = p.stats && p.stats.batting;
                if (!s) return;
                const pa = (s.atBats||0)+(s.baseOnBalls||0)+(s.hitByPitch||0)+(s.sacFlies||0)+(s.sacBunts||0);
                if (pa === 0) return;
                const singles = (s.hits||0)-(s.doubles||0)-(s.triples||0)-(s.homeRuns||0);
                const outs    = (s.atBats||0)-(s.hits||0);
                const lwts    = singles*0.47 + (s.doubles||0)*0.77 + (s.triples||0)*1.07
                              + (s.homeRuns||0)*1.40 + (s.baseOnBalls||0)*0.33
                              + (s.hitByPitch||0)*0.34 + outs*(-0.27);
                const id = p.person.id;
                if (!lwtsAccum[id]) lwtsAccum[id] = { id, name: p.person.fullName, team: abbr, lwts: 0 };
                lwtsAccum[id].lwts += lwts;
            });
        }

        // Single-game PAR per pitcher (game ERA + game FIP blended, same formula as season PAR)
        for (const side of ['away', 'home']) {
            const abbr = side === 'away' ? awayAbbr : homeAbbr;
            const players   = boxscore.teams[side].players || {};
            const pitcherIds = boxscore.teams[side].pitchers || [];
            pitcherIds.forEach(pid => {
                const p = players[`ID${pid}`];
                if (!p || !p.stats || !p.stats.pitching) return;
                const s  = p.stats.pitching;
                const ip = parseFloat(s.inningsPitched || 0);
                if (ip <= 0) return;
                const er  = s.earnedRuns   || 0;
                const bb  = s.baseOnBalls  || 0;
                const so  = s.strikeOuts   || 0;
                const hr  = s.homeRuns     || 0;
                const hbp = s.hitByPitch   || 0;
                const gameERA = (er / ip) * 9;
                const gameFIP = (13*hr + 3*(bb+hbp) - 2*so) / ip + 3.10;
                const par     = (6 - (gameFIP + gameERA) / 2) * ip / 9;
                const id = p.person.id;
                if (!parAccum[id]) parAccum[id] = { id, name: p.person.fullName, team: abbr, ip: 0, par: 0 };
                parAccum[id].ip  += ip;
                parAccum[id].par += par;
            });
        }

        // Relief WPA and game excitement from WPA plays
        let gameAbsWPA = 0;
        (wpaPlays || []).forEach(play => {
            const wpaRaw = play.homeTeamWinProbabilityAdded || 0;
            gameAbsWPA += Math.abs(wpaRaw);

            const isTop      = play.about && play.about.isTopInning;
            const pitcherId  = play.matchup && play.matchup.pitcher && play.matchup.pitcher.id;
            const pitcherName = play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName;

            if (pitcherId && !starterIds.has(pitcherId) && pitcherName) {
                // Positive = pitcher helped their team
                const pitcherWPA  = isTop ? wpaRaw : -wpaRaw;
                const pitcherTeam = isTop ? homeAbbr : awayAbbr;
                if (!reliefAccum[pitcherId]) reliefAccum[pitcherId] = { id: pitcherId, name: pitcherName, team: pitcherTeam, wpa: 0 };
                reliefAccum[pitcherId].wpa += pitcherWPA;
            }

            // Collect for cross-game top plays leaderboard
            if (Math.abs(wpaRaw) > 0) {
                allWPAPlays.push({
                    absWPA: Math.abs(wpaRaw),
                    wpaRaw,
                    gameLabel: `${awayAbbr} @ ${homeAbbr}`,
                    inning: formatInning(play.about || {}),
                    desc: (play.result && play.result.description) || '',
                    event: (play.result && play.result.event) || '',
                    awayScore: play.result && play.result.awayScore !== undefined ? play.result.awayScore : '',
                    homeScore: play.result && play.result.homeScore !== undefined ? play.result.homeScore : '',
                    awayAbbr,
                    homeAbbr,
                });
            }
        });
        excitement.push({
            label: `${awayAbbr} ${awayScore}, ${homeAbbr} ${homeScore}`,
            absWPA: gameAbsWPA,
            innings: linescore && linescore.innings ? linescore.innings.length : 9
        });

        const awayDiv = divMap[awayTeam.id] || {};
        const homeDiv = divMap[homeTeam.id] || {};
        const isDivision  = awayDiv.divisionId && awayDiv.divisionId === homeDiv.divisionId;
        const isLeague    = !isDivision && awayDiv.leagueId && awayDiv.leagueId === homeDiv.leagueId;
        const gameType    = isDivision ? 'division' : isLeague ? 'league' : 'interleague';
        const gameInnings = linescore && linescore.innings ? linescore.innings.length : 9;
        const scoreDiff   = Math.abs((awayScore || 0) - (homeScore || 0));
        const isNotable   = gameInnings > 9 || scoreDiff <= 2;

        jumpLinks.push({
            id: gameId,
            text: `${awayAbbr} ${awayScore}, ${homeAbbr} ${homeScore}${gameNumber}`,
            awayAbbr,
            gameType,
            isNotable
        });

        const linescoreHTML    = generateLinescoreHTML(linescore, awayAbbr, homeAbbr);
        const awayBatting      = generateBattingHTML(boxscore.teams.away, awayTeam.name);
        const awayBattingHTML  = awayBatting.html;
        const awayPitchingHTML = generatePitchingHTML(boxscore.teams.away, awayTeam.name);
        const homeBatting      = generateBattingHTML(boxscore.teams.home, homeTeam.name);
        const homeBattingHTML  = homeBatting.html;
        const homePitchingHTML = generatePitchingHTML(boxscore.teams.home, homeTeam.name);
        const decisionsHTML    = generateDecisionsHTML(decisions, awayAbbr, awayBatting.subs, homeAbbr, homeBatting.subs);
        const wpaHTML          = generateWPAHTML(wpaPlays, awayAbbr, homeAbbr);

        gamesHTML += `
        <details class="game-box" id="${gameId}">
            <summary class="game-summary">
                <span class="game-teams">${awayScore > homeScore ? `${awayTeam.name} ${awayScore}, ${homeTeam.name} ${homeScore}` : `${homeTeam.name} ${homeScore}, ${awayTeam.name} ${awayScore}`}${gameNumber}</span>
            </summary>
            <div class="game-content">
                <div class="linescore-wrap">
                    ${linescoreHTML}
                </div>
                <div class="teams-grid">
                    <div class="team-col-box">
                        ${awayBattingHTML}
                        ${awayPitchingHTML}
                    </div>
                    <div class="team-col-box">
                        ${homeBattingHTML}
                        ${homePitchingHTML}
                    </div>
                </div>
                ${decisionsHTML}
                ${wpaHTML}
            </div>
        </details>`;

        // --- Build JSON game record ---
        const inningsArr = linescore && linescore.innings ? linescore.innings : [];
        const lastInn = inningsArr[inningsArr.length - 1];
        gamesData.push({
            gamePk,
            venue: game.venue ? game.venue.name : null,
            away: { name: awayTeam.name, abbr: awayAbbr, score: awayScore },
            home: { name: homeTeam.name, abbr: homeAbbr, score: homeScore },
            linescore: {
                innings: inningsArr.map((inn, i) => ({
                    inning: i + 1,
                    away: inn.away && inn.away.runs !== undefined ? inn.away.runs : null,
                    home: inn.home && inn.home.runs !== undefined ? inn.home.runs : null,
                })),
                totals: {
                    away: linescore && linescore.teams && linescore.teams.away
                        ? { runs: linescore.teams.away.runs, hits: linescore.teams.away.hits, errors: linescore.teams.away.errors }
                        : null,
                    home: linescore && linescore.teams && linescore.teams.home
                        ? { runs: linescore.teams.home.runs, hits: linescore.teams.home.hits, errors: linescore.teams.home.errors }
                        : null,
                },
            },
            batting: {
                away: extractBattingData(boxscore.teams.away),
                home: extractBattingData(boxscore.teams.home),
            },
            pitching: {
                away: extractPitchingData(boxscore.teams.away),
                home: extractPitchingData(boxscore.teams.home),
            },
            decisions: decisions ? {
                winner: decisions.winner ? decisions.winner.fullName : null,
                loser:  decisions.loser  ? decisions.loser.fullName  : null,
                save:   decisions.save   ? decisions.save.fullName   : null,
            } : null,
            topWPAPlays: [...(wpaPlays || [])]
                .filter(p => (p.homeTeamWinProbabilityAdded || 0) !== 0)
                .sort((a, b) => Math.abs(b.homeTeamWinProbabilityAdded) - Math.abs(a.homeTeamWinProbabilityAdded))
                .slice(0, 5)
                .map(p => ({
                    wpa: parseFloat((Math.abs(p.homeTeamWinProbabilityAdded) / 100).toFixed(3)),
                    inning: formatInning(p.about || {}),
                    description: (p.result && p.result.description) || '',
                    awayScore: p.result && p.result.awayScore !== undefined ? p.result.awayScore : null,
                    homeScore: p.result && p.result.homeScore !== undefined ? p.result.homeScore : null,
                })),
            totalWPASwing: parseFloat((gameAbsWPA / 100).toFixed(2)),
            flags: {
                walkoff: homeScore > awayScore &&
                    !!lastInn && !!lastInn.home &&
                    lastInn.home.runs !== undefined && lastInn.home.runs > 0,
                extraInnings: inningsArr.length > 9,
                shutout: Math.min(awayScore || 0, homeScore || 0) === 0 &&
                    Math.max(awayScore || 0, homeScore || 0) > 0,
                sweep: false,
            },
            notable: (() => {
                const awayFielding = boxscore.teams.away.teamStats &&
                    boxscore.teams.away.teamStats.fielding || {};
                const homeFielding = boxscore.teams.home.teamStats &&
                    boxscore.teams.home.teamStats.fielding || {};
                const doublePlays = (awayFielding.doublePlays || 0) +
                    (homeFielding.doublePlays || 0);
                const triplePlays = (awayFielding.triplePlays || 0) +
                    (homeFielding.triplePlays || 0);
                const unassistedTP = (wpaPlays || []).some(p =>
                    ((p.result && p.result.description) || '').toLowerCase().includes('unassisted triple play')
                );
                return { doublePlays, triplePlays, unassistedTP };
            })(),
        });

    }

    // Add PPD / cancelled game entries to jump links
    for (const g of deferredGames) {
        const awayTeam = g.teams.away.team;
        const homeTeam = g.teams.home.team;
        const awayAbbr = teamMap[awayTeam.id] || awayTeam.abbreviation || awayTeam.name;
        const homeAbbr = teamMap[homeTeam.id] || homeTeam.abbreviation || homeTeam.name;
        const gameNumber = g.gameNumber > 1 ? ` - Game ${g.gameNumber}` : '';
        const label = g.status.statusCode === 'CO' ? 'CNCL' : 'PPD';
        const awayDiv = divMap[awayTeam.id] || {};
        const homeDiv = divMap[homeTeam.id] || {};
        const isDivision = awayDiv.divisionId && awayDiv.divisionId === homeDiv.divisionId;
        const isLeague   = !isDivision && awayDiv.leagueId && awayDiv.leagueId === homeDiv.leagueId;
        const gameType   = isDivision ? 'division' : isLeague ? 'league' : 'interleague';
        jumpLinks.push({
            id: null,
            text: `${awayAbbr} vs ${homeAbbr}${gameNumber} - ${label}`,
            awayAbbr,
            gameType,
            isNotable: false,
            isDeferred: true,
        });
    }

    // Sort accumulators and take top 5 for each leaderboard
    const topLwts       = Object.values(lwtsAccum).sort((a, b) => b.lwts - a.lwts).slice(0, config.leaderboardSize);
    const topPAR        = Object.values(parAccum).sort((a, b) => b.par - a.par).slice(0, config.leaderboardSize);
    const topRelief     = Object.values(reliefAccum).sort((a, b) => b.wpa - a.wpa).slice(0, config.leaderboardSize);
    const topExcitement = excitement.sort((a, b) => b.absWPA - a.absWPA).slice(0, config.leaderboardSize);
    const topWPAPlays   = allWPAPlays.sort((a, b) => b.absWPA - a.absWPA).slice(0, config.leaderboardSize);
    const leaderboardsHTML = generateLeaderboardsHTML(topLwts, topPAR, topRelief, topExcitement, topWPAPlays);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Baseball Graphs Box Scores - ${displayDate}</title>
    <link rel="icon" href="favicon.png">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: Georgia, "Times New Roman", serif;
            background-color: #F8F8FF;
            min-height: 100vh;
            padding: 20px;
        }

        .container { max-width: 960px; margin: 0 auto; }

        .breadcrumb {
            text-align: left;
            margin-bottom: 15px;
            font-size: 1.1em;
        }
        .breadcrumb a { color: #2563eb; text-decoration: none; }
        .breadcrumb a:hover { text-decoration: underline; color: #1e40af; }

        .header {
            text-align: center;
            margin-bottom: 20px;
            padding: 25px;
            background: linear-gradient(135deg, #2d6a4f, #52b788, #2d6a4f);
            color: white;
            border-radius: 8px;
            box-shadow: 0 3px 6px rgba(45, 106, 79, 0.3);
        }
        .header h1 { font-size: 2.2em; font-weight: bold; margin: 0 0 8px 0; line-height: 1.2; }
        .header p { font-size: 1.1em; opacity: 0.95; margin: 0; }

        .nav-bar {
            display: flex;
            margin-bottom: 20px;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .nav-bar a {
            flex: 1;
            padding: 12px 20px;
            text-align: center;
            text-decoration: none;
            font-weight: bold;
            font-size: 1.1em;
            transition: background-color 0.2s;
        }
        .nav-bar a.active { background: #2d6a4f; color: white; }
        .nav-bar a:not(.active) { background: #e5e7eb; color: #374151; }
        .nav-bar a:not(.active):hover { background: #d1d5db; }

        /* Controls bar: jump links + expand button */
        .controls-bar {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }

        .controls-right {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 5px;
            flex-shrink: 0;
        }
        .expand-btn {
            padding: 8px 18px;
            background: linear-gradient(135deg, #2d6a4f, #40916c);
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 0.95em;
            font-family: Georgia, "Times New Roman", serif;
            font-weight: bold;
            white-space: nowrap;
            box-shadow: 0 2px 4px rgba(0,0,0,0.15);
        }
        .expand-btn:hover { background: linear-gradient(135deg, #40916c, #52b788); }

        /* Individual game box */
        .game-box {
            margin-bottom: 14px;
            border: 2px solid #52b788;
            border-radius: 8px;
            background: white;
            box-shadow: 0 2px 4px rgba(45, 106, 79, 0.12);
        }

        .game-summary {
            padding: 13px 18px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 14px;
            user-select: none;
            list-style: none;
            border-radius: 6px;
        }
        .game-summary::-webkit-details-marker { display: none; }
        details[open] > .game-summary {
            border-bottom: 2px solid #52b788;
            background: #f0faf4;
            border-radius: 6px 6px 0 0;
        }

        /* Expand arrow */
        .game-summary::before {
            content: "";
            display: inline-block;
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 5px 0 5px 8px;
            border-color: transparent transparent transparent #2d6a4f;
            transition: transform 0.25s ease;
            flex-shrink: 0;
        }
        details[open] > .game-summary::before {
            transform: rotate(90deg);
        }

        .game-teams {
            font-size: 1.1em;
            font-weight: bold;
            color: #2d6a4f;
            flex: 1;
        }
        .game-content { padding: 16px 18px 12px; }
        .game-content ul { padding-left: 1.25em; margin: 0.5em 0; }
        .game-content li { margin-bottom: 0.4em; line-height: 1.6; }

        /* Linescore */
        .linescore-wrap {
            overflow-x: auto;
            margin-bottom: 18px;
        }
        .linescore-table {
            border-collapse: collapse;
            font-family: "Courier New", Courier, monospace;
            font-size: 0.88em;
            white-space: nowrap;
        }
        .linescore-table th {
            background: #d8f3dc;
            padding: 5px 9px;
            text-align: center;
            border-bottom: 2px solid #2d6a4f;
            font-family: Georgia, "Times New Roman", serif;
            min-width: 26px;
        }
        .linescore-table th.ls-team { text-align: left; min-width: 55px; }
        .linescore-table td {
            padding: 4px 9px;
            text-align: center;
            border-bottom: 1px solid #b7e4c7;
        }
        .linescore-table td.ls-team {
            text-align: left;
            font-family: Georgia, "Times New Roman", serif;
            font-weight: bold;
        }
        .ls-rhe-sep { border-left: 2px solid #2d6a4f !important; }
        .ls-bold { font-weight: bold; }

        /* Two-column layout for batting/pitching */
        .teams-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 12px;
        }
        @media (max-width: 680px) {
            .teams-grid { grid-template-columns: 1fr; }
        }

        .section-title {
            font-size: 1.0em;
            font-weight: bold;
            color: #2d6a4f;
            margin-top: 14px;
            margin-bottom: 5px;
        }
        .team-col-box .section-title:first-child { margin-top: 0; }

        .table-scroll { overflow-x: auto; }

        .box-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.82em;
            font-family: "Courier New", Courier, monospace;
            margin-bottom: 2px;
        }
        .box-table th {
            background: #d8f3dc;
            padding: 5px 4px;
            border-bottom: 2px solid #2d6a4f;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 0.95em;
            white-space: nowrap;
        }
        .box-table th.name-col { text-align: left; }
        .box-table td {
            padding: 3px 4px;
            border-bottom: 1px solid #b7e4c7;
        }
        .box-table td.name-col {
            font-family: Georgia, "Times New Roman", serif;
            white-space: nowrap;
        }
        .stat-num { text-align: right; }
        .pos-tag { font-size: 0.78em; color: #6b7280; }
        .player-link { color: inherit; text-decoration: none; }
        .season-col { color: #2d6a4f; font-weight: bold; }
        .totals-row td {
            border-top: 2px solid #2d6a4f;
            font-weight: bold;
        }

        /* Decisions line */
        .decisions {
            font-size: 0.9em;
            color: #374151;
            padding-top: 10px;
            border-top: 1px solid #b7e4c7;
        }
        .subs-line {
            font-size: 0.88em;
            color: #374151;
        }
        .sub-row td { color: #374151; }

        /* Key Plays (WPA) section */
        .wpa-section {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #b7e4c7;
        }
        .wpa-title {
            font-size: 0.9em;
            font-weight: bold;
            color: #2d6a4f;
            margin-bottom: 5px;
        }
        .wpa-play {
            display: flex;
            align-items: baseline;
            gap: 8px;
            font-size: 0.85em;
            color: #1a1a1a;
            padding: 3px 0;
            border-bottom: 1px dotted #d1fae5;
            line-height: 1.4;
        }
        .wpa-play:last-child { border-bottom: none; }
        .wpa-badge {
            font-family: "Courier New", Courier, monospace;
            font-weight: bold;
            color: #2d6a4f;
            white-space: nowrap;
            flex-shrink: 0;
            font-size: 1.1em;
        }
        .wpa-inning {
            font-family: Georgia, "Times New Roman", serif;
            color: #1a1a1a;
            white-space: nowrap;
            flex-shrink: 0;
            font-size: 0.9em;
        }
        .wpa-desc { flex: 1; }
        .wpa-score {
            font-family: Georgia, "Times New Roman", serif;
            color: #1a1a1a;
            font-size: 0.95em;
        }

        .no-games {
            text-align: center;
            padding: 50px;
            color: #6b7280;
            font-size: 1.1em;
            background: white;
            border: 2px solid #52b788;
            border-radius: 8px;
        }

        @media (max-width: 600px) {
            body { padding: 10px; }
            .header h1 { font-size: 1.6em; }
            .game-teams { font-size: 0.95em; }
            .table-scroll { width: 100%; overflow-x: auto; display: block; }
            .box-table { width: max-content; min-width: 100%; }
            .team-col-box { min-width: 0; }
            .box-table td.name-col,
            .box-table th.name-col {
                position: sticky;
                left: 0;
                background: white;
                z-index: 1;
            }
        }
        /* Daily Leaderboards */
        .lb-section {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 2px solid #52b788;
        }
        .lb-section-title {
            font-size: 1.3em;
            font-weight: bold;
            color: #2d6a4f;
            margin-bottom: 16px;
        }
        .lb-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
        }
        @media (max-width: 680px) { .lb-grid { grid-template-columns: 1fr; } }
        .lb-panel {
            background: white;
            border: 1px solid #b7e4c7;
            border-radius: 6px;
            padding: 12px 14px;
        }
        .lb-panel-title {
            font-size: 0.95em;
            font-weight: bold;
            color: #2d6a4f;
            margin-bottom: 8px;
            padding-bottom: 5px;
            border-bottom: 1px solid #d8f3dc;
            text-align: center;
        }
        .lb-empty { color: #9ca3af; font-size: 0.85em; padding: 6px 0; }
        .lb-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.82em;
            font-family: "Courier New", Courier, monospace;
        }
        .lb-table th {
            background: #d8f3dc;
            padding: 4px 8px;
            text-align: left;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 0.88em;
            border-bottom: 1px solid #b7e4c7;
            color: #1a1a1a;
        }
        .lb-table td { padding: 4px 8px; border-bottom: 1px solid #f0f9f3; vertical-align: middle; color: #1a1a1a; }
        .lb-table tr:last-child td { border-bottom: none; }
        .lb-rank { color: #6b7280; font-size: 0.85em; width: 18px; }
        .lb-name { font-family: Georgia, "Times New Roman", serif; }
        .lb-num  { text-align: right; }
        .lb-center { text-align: center; }
        .lb-table th.lb-th-num { text-align: right; }
        .lb-table th.lb-th-center { text-align: center; }
        .lb-desc { font-family: Georgia, "Times New Roman", serif; }
        .lb-team { font-size: 0.8em; color: #6b7280; font-family: Georgia, "Times New Roman", serif; }
        .lb-panel-wide { margin-top: 16px; }
        .lb-player-link { color: inherit; text-decoration: none; }
        .lb-player-link:hover { text-decoration: underline; }

    </style>
    <script data-goatcounter="https://baseball-graphs.goatcounter.com/count"
            async src="//gc.zgo.at/count.js"></script>
</head>
<body>
    <div class="container">
        <div class="breadcrumb">
            <a href="https://www.baseballgraphs.com/">&larr; Baseball Graphs Home</a>
        </div>

        <div class="header">
            <h1>Baseball Graphs Box Scores</h1>
            <p>${displayDate}</p>
            <p style="font-size: 0.9em; margin-top: 8px; opacity: 0.9;">Updated: ${updatedStr}</p>
        </div>

        <div class="nav-bar">
            <a href="index.html">Graphs &amp; Standings</a>
            <a href="player_stats.html">Player Stats</a>
            <a href="box-scores.html" class="active">Box Scores</a>
        </div>

        <!-- BOXSCORES_BRIEF_SNIPPET -->

        ${finalGames.length > 0 ? `
        <div class="controls-bar">
            <div class="controls-right">
                <button class="expand-btn" id="expandBtn" onclick="toggleAll()">Expand All</button>
            </div>
        </div>
        ${gamesHTML}
        ${leaderboardsHTML}
        ` : '<div class="no-games">No completed games found for ' + displayDate + '.</div>'}
    </div>

    <script>
        function expandGame(e, id) {
            e.preventDefault();
            const el = document.getElementById(id);
            if (!el) return;
            if (!el.open) el.setAttribute('open', '');
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.replaceState(null, '', '#' + id);
        }

        let allExpanded = false;

        function toggleAll() {
            const boxes = document.querySelectorAll('.game-box');
            allExpanded = !allExpanded;
            boxes.forEach(box => {
                if (allExpanded) {
                    box.setAttribute('open', '');
                } else {
                    box.removeAttribute('open');
                }
            });
            document.getElementById('expandBtn').textContent = allExpanded ? 'Collapse All' : 'Expand All';
        }
    </script>
</body>
</html>`;

    fs.writeFileSync('box-scores.html', html);
    console.log('Generated box-scores.html successfully!');

    const boxscoreJson = {
        date,
        generatedAt: updatedStr,
        games: gamesData,
        postponedGames: deferredGames.map(g => ({
            awayTeam: g.teams.away.team.name,
            homeTeam: g.teams.home.team.name,
            date,
            status: g.status.detailedState || g.status.statusCode,
        })),
        topWPAPlaysAllGames: topWPAPlays.map(p => ({
            game: p.gameLabel,
            wpa: parseFloat((p.absWPA / 100).toFixed(3)),
            inning: p.inning,
            description: p.desc,
            awayAbbr: p.awayAbbr,
            homeAbbr: p.homeAbbr,
            awayScore: p.awayScore !== '' ? p.awayScore : null,
            homeScore: p.homeScore !== '' ? p.homeScore : null,
        })),
    };
    fs.writeFileSync('boxscore-data.json', JSON.stringify(boxscoreJson, null, 2));
    console.log('Generated boxscore-data.json successfully!');
}

generateHTML().catch(console.error);
