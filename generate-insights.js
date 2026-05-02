'use strict';

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 3000;

function loadData() {
    const boxscore = JSON.parse(fs.readFileSync('boxscore-data.json', 'utf8'));
    const standings = JSON.parse(fs.readFileSync('standings-data.json', 'utf8'));
    let playerStats = { batters: [], pitchers: [] };
    try {
        playerStats = JSON.parse(fs.readFileSync('player-stats.json', 'utf8'));
    } catch (e) {
        console.warn('Could not load player-stats.json:', e.message);
    }
    return { boxscore, standings, playerStats };
}

function calcLWTS(b) {
    const nonHRHits = (b.H || 0) - (b.HR || 0);
    const outs = (b.AB || 0) - (b.H || 0);
    return nonHRHits * 0.46 + (b.HR || 0) * 1.40 + (b.BB || 0) * 0.33 + outs * (-0.25);
}

function calcGamePAR(p) {
    const ip = p.IP || 0;
    if (ip === 0) return -99;
    const gameERA = (p.ER / ip) * 9;
    const gameFIP = (3 * (p.BB || 0) - 2 * (p.K || 0)) / ip + 3.10;
    return (6 - (gameFIP + gameERA) / 2) * ip / 9;
}

function cleanVenue(v) {
    if (!v) return v;
    if (v.includes('Dodger Stadium')) return 'Dodger Stadium';
    return v;
}

function formatBoxscoreForPrompt(boxscore) {
    const lines = ['Games and venues:'];
    for (const game of boxscore.games) {
        lines.push(`- ${game.away.name} (away) vs ${game.home.name} (home) at ${cleanVenue(game.venue)}`);
    }
    for (const game of boxscore.games) {
        lines.push(`\n## ${game.away.name} (${game.away.score}) @ ${game.home.name} (${game.home.score}) at ${cleanVenue(game.venue)}`);

        const innings = game.linescore.innings
            .map(inn => `${inn.inning}: A${inn.away ?? '-'} H${inn.home ?? '-'}`)
            .join(', ');
        lines.push(`Linescore: ${innings}`);

        if (game.decisions) {
            const d = game.decisions;
            if (d.winner) {
                lines.push(`W: ${d.winner}${d.loser ? '  L: ' + d.loser : ''}${d.save ? '  SV: ' + d.save : ''}`);
            }
        }

        const flags = [];
        if (game.flags.walkoff) flags.push('walkoff');
        if (game.flags.extraInnings) flags.push('extra innings');
        if (game.flags.shutout) flags.push('shutout');
        if (flags.length) lines.push(`Notable: ${flags.join(', ')}`);
        if (game.totalWPASwing !== undefined) {
            lines.push(`Total WPA Swing: ${game.totalWPASwing.toFixed(2)}`);
        }

        const awaySide = `${game.away.abbr}, away at ${cleanVenue(game.venue)}`;
        const homeSide = `${game.home.abbr}, home at ${cleanVenue(game.venue)}`;

        lines.push(`\nAway Batting (${game.away.abbr}):`);
        for (const b of game.batting.away) {
            lines.push(`  ${b.name} (${awaySide}): ${b.PA} PA, ${b.AB} AB, ${b.H} H, ${b.HR} HR, ${b.BB} BB, ${b.R} R`);
        }
        lines.push(`\nHome Batting (${game.home.abbr}):`);
        for (const b of game.batting.home) {
            lines.push(`  ${b.name} (${homeSide}): ${b.PA} PA, ${b.AB} AB, ${b.H} H, ${b.HR} HR, ${b.BB} BB, ${b.R} R`);
        }

        lines.push(`\nAway Pitching (${game.away.abbr}):`);
        for (const p of game.pitching.away) {
            lines.push(`  ${p.name} (${awaySide}): ${p.IP} IP, ${p.H} H, ${p.ER} ER, ${p.BB} BB, ${p.K} K`);
        }
        lines.push(`\nHome Pitching (${game.home.abbr}):`);
        for (const p of game.pitching.home) {
            lines.push(`  ${p.name} (${homeSide}): ${p.IP} IP, ${p.H} H, ${p.ER} ER, ${p.BB} BB, ${p.K} K`);
        }

        if (game.topWPAPlays && game.topWPAPlays.length > 0) {
            lines.push(`\nTop WPA Plays:`);
            for (const play of game.topWPAPlays) {
                lines.push(`  ${play.inning} WPA+${play.wpa}: ${play.description}`);
            }
        }
    }
    return lines.join('\n');
}

function formatStandingsForPrompt(standings) {
    const byLeague = {};
    for (const t of standings.teams) {
        if (!byLeague[t.league]) byLeague[t.league] = [];
        byLeague[t.league].push(t);
    }

    const lines = [];
    for (const [lg, teams] of Object.entries(byLeague)) {
        lines.push(`\n## ${lg}`);
        const sorted = [...teams].sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));
        for (const t of sorted) {
            const rd = t.rd > 0 ? `+${t.rd}` : String(t.rd);
            const pv = t.pythVar > 0 ? `+${t.pythVar}` : String(t.pythVar);
            lines.push(
                `${t.abbreviation} (${t.division}): ${t.w}-${t.l} .${t.pct}` +
                ` | RS/RA: ${t.rs}/${t.ra} RD: ${rd}` +
                ` | pyW: ${t.pythWins} (${pv})` +
                ` | Streak: ${t.streak || '?'} L10: ${t.splits.last10 || '?'}` +
                ` | OPS: ${t.stats.ops} FIP: ${t.stats.fip} DER: ${t.stats.der}`
            );
        }
    }
    return lines.join('\n');
}

function formatAllWPAForPrompt(boxscore) {
    return (boxscore.topWPAPlaysAllGames || [])
        .map(p => `${p.awayAbbr}@${p.homeAbbr} ${p.inning} WPA+${p.wpa}: ${p.description}`)
        .join('\n');
}

function getTopBattersForPrompt(boxscore, playerStats) {
    const allBatters = [];
    for (const game of boxscore.games) {
        for (const side of ['away', 'home']) {
            for (const b of game.batting[side]) {
                allBatters.push({ ...b, lwts: calcLWTS(b) });
            }
        }
    }
    allBatters.sort((a, b) => b.lwts - a.lwts);
    const top10 = allBatters.slice(0, 10);
    const top10Names = new Set(top10.map(b => b.name));

    const seasonMap = {};
    for (const b of (playerStats.batters || [])) {
        if (top10Names.has(b.name)) {
            seasonMap[b.name] = b;
        }
    }

    const lines = ["Today's top batters by linear weights, with season stats:"];
    for (const b of top10) {
        const s = seasonMap[b.name];
        const today = `Today: ${b.AB} AB, ${b.H} H, ${b.HR} HR, ${b.RBI} RBI (LWTS ${b.lwts.toFixed(2)})`;
        if (s) {
            lines.push(
                `${b.name} (${s.team}): ${today}` +
                ` | Season: .${s.AVG}/.${s.OBP}/.${s.SLG} OPS ${s.OPS}, ${s.HR} HR, ${s.RBI} RBI in ${s.G} G`
            );
        } else {
            lines.push(`${b.name}: ${today}`);
        }
    }
    return lines.join('\n');
}

function getTopPitchersForPrompt(boxscore, playerStats) {
    const allPitchers = [];
    for (const game of boxscore.games) {
        for (const side of ['away', 'home']) {
            for (const p of game.pitching[side]) {
                if (p.IP >= 1) allPitchers.push({ ...p, par: calcGamePAR(p), venue: cleanVenue(game.venue), side });
            }
        }
    }
    allPitchers.sort((a, b) => b.par - a.par);
    const top10 = allPitchers.slice(0, 10);
    const top10Names = new Set(top10.map(p => p.name));

    const seasonMap = {};
    for (const p of (playerStats.pitchers || [])) {
        if (top10Names.has(p.name)) {
            seasonMap[p.name] = p;
        }
    }

    const lines = ["Today's top pitchers by game PAR, with season stats:"];
    for (const p of top10) {
        const s = seasonMap[p.name];
        const context = s ? `${s.team}, ${p.side} at ${p.venue}` : `${p.side} at ${p.venue}`;
        const today = `Today: ${p.IP} IP, ${p.H} H, ${p.ER} ER, ${p.BB} BB, ${p.K} K (PAR ${p.par.toFixed(2)})`;
        if (s) {
            lines.push(
                `${p.name} (${context}): ${today}` +
                ` | Season: ${s.W}-${s.L} ERA ${s.ERA} WHIP ${s.WHIP} ${s.SO}K in ${s.IP} IP`
            );
        } else {
            lines.push(`${p.name} (${context}): ${today}`);
        }
    }
    return lines.join('\n');
}

function normalizeForMatch(str) {
    return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPlayerIndex(boxscore, playerStats) {
    const index = new Map(); // normalized full name -> { type, fullName, gameStats, seasonStats }

    for (const game of boxscore.games) {
        for (const side of ['away', 'home']) {
            for (const b of game.batting[side]) {
                const key = normalizeForMatch(b.name);
                if (!index.has(key))
                    index.set(key, { type: 'batter', fullName: b.name, gameStats: b, seasonStats: null });
            }
            for (const p of game.pitching[side]) {
                const key = normalizeForMatch(p.name);
                if (!index.has(key))
                    index.set(key, { type: 'pitcher', fullName: p.name, gameStats: p, seasonStats: null });
            }
        }
    }

    for (const b of (playerStats.batters || [])) {
        const key = normalizeForMatch(b.name);
        if (index.has(key)) index.get(key).seasonStats = b;
    }
    for (const p of (playerStats.pitchers || [])) {
        const key = normalizeForMatch(p.name);
        if (index.has(key)) index.get(key).seasonStats = p;
    }

    return index;
}

function formatStatBlock(entry) {
    const { type, gameStats: g, seasonStats: s } = entry;

    if (type === 'batter') {
        const parts = [`${g.H}-${g.AB}`];
        if (g.BB) parts.push(`${g.BB} BB`);
        if (g.HR) parts.push(`${g.HR} HR`);
        const gamePart = parts.join(', ');
        if (!s || s.rc == null) return `[${gamePart}]`;
        return `[${gamePart} | RC ${s.rc}]`;
    }

    if (type === 'pitcher') {
        const gamePart = `${g.IP} IP, ${g.ER} ER, ${g.K} K`;
        if (!s) return `[${gamePart}]`;
        const era = parseFloat(s.era).toFixed(2);
        const seasonParts = [`${era} ERA`];
        if (s.par != null) seasonParts.push(`PAR ${s.par}`);
        return `[${gamePart} | ${seasonParts.join(', ')}]`;
    }

    return '';
}

function injectStats(text, playerIndex) {
    const seen = new Set();

    // Build last-name index; null = ambiguous (multiple players share last name)
    const lastNameIndex = new Map();
    for (const [key, entry] of playerIndex) {
        const normLast = normalizeForMatch(entry.fullName.split(' ').pop());
        if (lastNameIndex.has(normLast)) {
            lastNameIndex.set(normLast, null);
        } else {
            lastNameIndex.set(normLast, { key, entry });
        }
    }

    // Process longest names first to avoid partial matches
    const sorted = [...playerIndex.entries()]
        .sort((a, b) => b[1].fullName.length - a[1].fullName.length);

    let result = text;

    for (const [key, entry] of sorted) {
        if (seen.has(key)) continue;

        const statBlock = formatStatBlock(entry);
        if (!statBlock) continue;

        const { fullName } = entry;
        // Try original name and de-accented variant
        const deAccented = fullName.normalize('NFD').replace(/[̀-ͯ]/g, '');
        const variants = deAccented === fullName ? [fullName] : [fullName, deAccented];

        let matched = false;

        // Full name: bold then plain
        for (const v of variants) {
            const esc = escapeRegex(v);
            if (new RegExp(`(\\*\\*${esc}\\*\\*)`, 'i').test(result)) {
                result = result.replace(new RegExp(`(\\*\\*${esc}\\*\\*)`, 'i'), `$1 ${statBlock}`);
                seen.add(key); matched = true; break;
            }
        }
        if (!matched) {
            for (const v of variants) {
                const esc = escapeRegex(v);
                if (new RegExp(`(?<![\\w*])(${esc})(?![\\w*])`, 'i').test(result)) {
                    result = result.replace(new RegExp(`(?<![\\w*])(${esc})(?![\\w*])`, 'i'), `$1 ${statBlock}`);
                    seen.add(key); matched = true; break;
                }
            }
        }

        // Last-name fallback (only when last name is unique across today's players)
        if (!matched) {
            const lastName = fullName.split(' ').pop();
            const normLast = normalizeForMatch(lastName);
            const lastEntry = lastNameIndex.get(normLast);
            if (lastEntry && lastEntry.key === key) {
                const deAccLast = lastName.normalize('NFD').replace(/[̀-ͯ]/g, '');
                const lastVariants = deAccLast === lastName ? [lastName] : [lastName, deAccLast];
                for (const v of lastVariants) {
                    const esc = escapeRegex(v);
                    if (new RegExp(`(\\*\\*${esc}\\*\\*)`, 'i').test(result)) {
                        result = result.replace(new RegExp(`(\\*\\*${esc}\\*\\*)`, 'i'), `$1 ${statBlock}`);
                        seen.add(key); matched = true; break;
                    }
                }
                if (!matched) {
                    for (const v of lastVariants) {
                        const esc = escapeRegex(v);
                        if (new RegExp(`(?<![\\w*])(${v})(?![\\w*])`, 'i').test(result)) {
                            result = result.replace(new RegExp(`(?<![\\w*])(${esc})(?![\\w*])`, 'i'), `$1 ${statBlock}`);
                            seen.add(key); break;
                        }
                    }
                }
            }
        }
    }

    return result;
}

function formatMetsData(boxscore, standings) {
    const nlEastAbbrs = new Set(
        standings.teams
            .filter(t => t.division === 'National League East')
            .map(t => t.abbreviation)
    );

    const metsGames = boxscore.games.filter(g =>
        g.away.abbr === 'NYM' || g.home.abbr === 'NYM'
    );
    const rivalGames = boxscore.games.filter(g =>
        (nlEastAbbrs.has(g.away.abbr) || nlEastAbbrs.has(g.home.abbr)) &&
        !metsGames.includes(g)
    );

    const metsBoxStr = metsGames.length > 0
        ? formatBoxscoreForPrompt({ games: metsGames })
        : 'The Mets did not play yesterday.';

    const metsRivalStr = rivalGames.length > 0
        ? formatBoxscoreForPrompt({ games: rivalGames })
        : 'No other NL East games yesterday.';

    const nlEastTeams = standings.teams
        .filter(t => t.division === 'National League East')
        .sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));

    const standLines = ['NL East Standings:'];
    for (const t of nlEastTeams) {
        const rd = t.rd > 0 ? `+${t.rd}` : String(t.rd);
        const pv = t.pythVar > 0 ? `+${t.pythVar}` : String(t.pythVar);
        standLines.push(
            `${t.abbreviation} (${t.division}): ${t.w}-${t.l} .${t.pct} GB: ${t.gb}` +
            ` | RS/RA: ${t.rs}/${t.ra} RD: ${rd}` +
            ` | pyW: ${t.pythWins} (${pv})` +
            ` | Streak: ${t.streak || '?'} L10: ${t.splits.last10 || '?'}` +
            ` | OPS: ${t.stats.ops} FIP: ${t.stats.fip} DER: ${t.stats.der}`
        );
    }

    return { metsBoxStr, metsRivalStr, metsStandStr: standLines.join('\n') };
}

function buildFactSheet(boxscoreData, standingsData, playerStatsData) {
    const sections = [];

    // Section 1 — game results
    const s1 = ['SECTION 1 — VERIFIED GAME RESULTS:'];
    for (const game of boxscoreData.games) {
        const awayWon = game.away.score > game.home.score;
        const winner  = awayWon ? game.away : game.home;
        const loser   = awayWon ? game.home : game.away;
        s1.push(`- ${winner.name} def. ${loser.name} ${winner.score}-${loser.score} (${cleanVenue(game.venue) || 'unknown venue'})`);
    }
    sections.push(s1.join('\n'));

    // Section 2 — pennant race impact (skip if no previous GB data)
    const hasPrevData = standingsData.teams.some(t => t.gbChange !== null || t.wcGbChange !== null);
    if (hasPrevData) {
        const teamGame = {};
        for (const game of boxscoreData.games) {
            const awayWon = game.away.score > game.home.score;
            teamGame[game.away.abbr] = { won: awayWon, opp: game.home.abbr };
            teamGame[game.home.abbr] = { won: !awayWon, opp: game.away.abbr };
        }

        const s2 = [];
        for (const team of standingsData.teams) {
            const { gbChange, wcGbChange, gb, wcGb, wcRank, abbreviation, name, division, league } = team;
            const gbNum   = parseFloat(gb);
            const wcGbNum = parseFloat(wcGb);
            const inDivRace = gb === '-' || (!isNaN(gbNum) && gbNum <= 6);
            const inWcRace  = (typeof wcRank === 'number' && wcRank <= 3) || (!isNaN(wcGbNum) && wcGbNum <= 4);
            if (!inDivRace && !inWcRace) continue;

            const g          = teamGame[abbreviation];
            const prefix     = g ? `${abbreviation} ${g.won ? 'def.' : 'lost to'} ${g.opp}: ` : '';
            const divShort   = division.replace('American League', 'AL').replace('National League', 'NL');
            const leagShort  = league.replace(' League', '');

            if (gbChange !== null && gbChange !== 0 && inDivRace) {
                const dir    = gbChange > 0 ? 'gained' : 'lost';
                const amount = Math.abs(gbChange);
                s2.push(`- ${prefix}${name} ${dir} ${amount} game${amount !== 1 ? 's' : ''} in ${division} race`);
            } else if (wcGbChange !== null && wcGbChange !== 0 && inWcRace) {
                const dir    = wcGbChange > 0 ? 'gained' : 'lost';
                const amount = Math.abs(wcGbChange);
                s2.push(`- ${prefix}${name} ${dir} ${amount} game${amount !== 1 ? 's' : ''} in ${leagShort} wild card race`);
            }
        }
        if (s2.length > 0) sections.push('SECTION 2 — PENNANT RACE IMPACT:\n' + s2.join('\n'));
    }

    // Section 3 — top performers (today)
    const gamePitchers = [];
    for (const game of boxscoreData.games) {
        for (const side of ['away', 'home']) {
            for (const p of game.pitching[side]) {
                if ((p.IP || 0) >= 1) gamePitchers.push({ ...p, par: calcGamePAR(p) });
            }
        }
    }
    gamePitchers.sort((a, b) => b.par - a.par);

    const gameBatters = [];
    for (const game of boxscoreData.games) {
        for (const side of ['away', 'home']) {
            for (const b of game.batting[side]) {
                gameBatters.push({ ...b, lwts: calcLWTS(b) });
            }
        }
    }
    gameBatters.sort((a, b) => b.lwts - a.lwts);

    const pSeasonMap = {};
    for (const p of (playerStatsData.pitchers || [])) pSeasonMap[p.name] = p;
    const bSeasonMap = {};
    for (const b of (playerStatsData.batters || [])) bSeasonMap[b.name] = b;

    const s3 = ['SECTION 3 — TOP PERFORMERS:', '\nTOP PITCHERS BY PAR:'];
    gamePitchers.slice(0, 5).forEach((p, i) => {
        const team = (pSeasonMap[p.name] || {}).teamAbbr || '?';
        s3.push(`${i + 1}. ${p.name} (${team}): PAR ${p.par.toFixed(2)}, ${p.IP} IP, ${p.ER} ER, ${p.K} K`);
    });
    s3.push('\nTOP BATTERS BY LWTS:');
    gameBatters.slice(0, 5).forEach((b, i) => {
        const team = (bSeasonMap[b.name] || {}).teamAbbr || '?';
        s3.push(`${i + 1}. ${b.name} (${team}): LWTS ${b.lwts.toFixed(2)}, ${b.H}-${b.AB}, ${b.HR} HR`);
    });
    sections.push(s3.join('\n'));

    // Section 4 — most dramatic games
    const s4 = ['SECTION 4 — MOST DRAMATIC GAMES BY WPA SWING:'];
    [...boxscoreData.games]
        .filter(g => g.totalWPASwing != null)
        .sort((a, b) => b.totalWPASwing - a.totalWPASwing)
        .slice(0, 5)
        .forEach((g, i) => s4.push(`${i + 1}. ${g.away.name}-${g.home.name}: ${g.totalWPASwing.toFixed(2)} WPA swing`));
    sections.push(s4.join('\n'));

    // Section 5 — season league leaders
    const gamesPlayed = Math.max(...(standingsData.teams || []).map(t => (t.w || 0) + (t.l || 0)), 0);
    const minPA = gamesPlayed * 3.1;
    const minIP = gamesPlayed * 1.0;

    const alBatters  = (playerStatsData.batters  || []).filter(b => b.league === 'AL');
    const nlBatters  = (playerStatsData.batters  || []).filter(b => b.league === 'NL');
    const alPitchers = (playerStatsData.pitchers || []).filter(p => p.league === 'AL');
    const nlPitchers = (playerStatsData.pitchers || []).filter(p => p.league === 'NL');

    const alQBatters  = alBatters.filter(b => (b.pa || 0) >= minPA);
    const nlQBatters  = nlBatters.filter(b => (b.pa || 0) >= minPA);
    const alQPitchers = alPitchers.filter(p => (p.ip || 0) >= minIP);
    const nlQPitchers = nlPitchers.filter(p => (p.ip || 0) >= minIP);

    function top3(arr, field, asc = false) {
        return [...arr]
            .filter(x => x[field] != null)
            .sort((a, b) => asc
                ? parseFloat(a[field]) - parseFloat(b[field])
                : parseFloat(b[field]) - parseFloat(a[field]))
            .slice(0, 3)
            .map(x => `${x.name.split(' ').pop()} (${x.teamAbbr}) ${x[field]}`)
            .join(', ') || '—';
    }

    const s5 = ['SECTION 5 — CURRENT LEAGUE LEADERS:',
        '\nAL BATTING LEADERS:',
        `HR: ${top3(alBatters, 'hr')}`,
        `OPS: ${top3(alQBatters, 'ops')}`,
        `SLG: ${top3(alQBatters, 'slg')}`,
        `RC: ${top3(alBatters, 'rc')}`,
        '\nAL PITCHING LEADERS:',
        `ERA: ${top3(alQPitchers, 'era', true)}`,
        `PAR: ${top3(alPitchers, 'par')}`,
        `K: ${top3(alPitchers, 'k')}`,
        `FIP: ${top3(alQPitchers, 'fip', true)}`,
        '\nNL BATTING LEADERS:',
        `HR: ${top3(nlBatters, 'hr')}`,
        `OPS: ${top3(nlQBatters, 'ops')}`,
        `SLG: ${top3(nlQBatters, 'slg')}`,
        `RC: ${top3(nlBatters, 'rc')}`,
        '\nNL PITCHING LEADERS:',
        `ERA: ${top3(nlQPitchers, 'era', true)}`,
        `PAR: ${top3(nlPitchers, 'par')}`,
        `K: ${top3(nlPitchers, 'k')}`,
        `FIP: ${top3(nlQPitchers, 'fip', true)}`,
    ];
    sections.push(s5.join('\n'));

    return sections.join('\n\n');
}

function buildPrompts(date, boxStr, standStr, wpaStr, topBattersStr, topPitchersStr, metsBoxStr, metsRivalStr, metsStandStr, factSheet) {
    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const angellSystem =
        'You are a baseball writer in the tradition of Roger Angell — lyrical, unhurried, ' +
        'attentive to human drama and the emotional rhythms of the game. ' +
        'Do not describe the action of specific plays — the facts will speak for themselves. ' +
        'Instead reflect on what the day\'s results mean: for the team, the season, the fans. ' +
        'Find the emotional and narrative truth beneath the numbers. ' +
        'Avoid clichés. Each paragraph should earn its place. ' +
        'Output 3–5 paragraphs of polished prose. No headers, no bullet points.';

    const studemundSystem =
        'Write in the style of Dave Studenmund of The Hardball Times — ' +
        'conversational but authoritative, building arguments step by step, ' +
        'showing reasoning not just conclusions, comfortable with math and ' +
        'metrics but never showing off, occasionally personal, with dry ' +
        'understated wit. Use bullet points where they genuinely help ' +
        'break up dense information. Write for a knowledgeable baseball ' +
        'fan who appreciates clear explanation.';

    const jamesSystem =
        'You are a baseball analyst in the tradition of Bill James — sharp, curious, willing ' +
        'to challenge conventional wisdom, with a gift for illuminating the numbers without ' +
        'losing sight of the game. Write incisive analytical prose. ' +
        '3–5 paragraphs. No headers or bullet points.';

    const dataIntegrityNote =
        `Do not infer, assume, or embellish details not present in the data. ` +
        `If something is not explicitly in the data provided, do not write it.`;

    const homeAwayNote =
        `CRITICAL: Each game record contains "venue", "home", and "away" fields. ` +
        `These are ground truth — always use them. The home team is the team listed under "home". ` +
        `The away team is listed under "away". The game was played at the venue named in "venue". ` +
        `Never override these fields with your own knowledge of where teams play. ` +
        `Never infer home/away from team names or cities. ` +
        `If the data says the Pirates are away and the Brewers are home at American Family Field, ` +
        `that is correct — do not second-guess it.`;

    const cinematicsNote =
        `Do not invent or embellish physical details of plays — no descriptions of how a ball moved, ` +
        `how a fielder reacted, or what a swing looked like unless explicitly stated in the data. ` +
        `Describe outcomes, not cinematics.`;

    const teamIdNote =
        `When mentioning a player for the first time in a narrative, always identify their team. ` +
        `Use natural phrasing like "Milwaukee's Kyle Harrison" or "Kyle Harrison of the Brewers" ` +
        `rather than just the player's name alone. Subsequent mentions can use the name alone.`;

    const boldNamesNote =
        `Bold all player names using **Player Name** format throughout your response.`;

    const parNote =
        `PAR has been pre-calculated for each pitcher in the data. ` +
        `Use the par field directly — do not recalculate it yourself.`;

    const noStatsNote =
        `Do not cite any statistics in the narrative — no batting lines, no ERAs, ` +
        `no hit totals, no walk counts. Player stats will be inserted automatically ` +
        `next to each player name. Focus entirely on observation, analysis, and ` +
        `storytelling. Write as if the reader can already see the numbers.`;

    const lwtsNote =
        `IMPORTANT: Linear weights are context-neutral — they do not account for game situation, ` +
        `leverage, or timing. Do not imply or suggest that a high LWTS reflects a clutch or ` +
        `high-leverage performance. Report only what the batting line shows.`;

    const coorsNote =
        `CRITICAL: Do not mention Coors Field, altitude, or Colorado's home ballpark unless the ` +
        `game being discussed was actually played at Coors Field. A Rockies pitcher pitching on ` +
        `the road has nothing to do with Coors Field. Never use a pitcher's team identity to ` +
        `infer ballpark context — only use the venue field in the data.`;

    const sharedNotes = `\n\n${dataIntegrityNote}\n\n${homeAwayNote}\n\n${teamIdNote}\n\n${boldNamesNote}\n\n${parNote}\n\n${noStatsNote}\n\n${coorsNote}\n\n${lwtsNote}`;

    const walksNote =
        `When mentioning a batter's performance, always include walks separately from hits. ` +
        `A player who went 2-for-3 with a walk had 4 plate appearances, not 3 at-bats. ` +
        `Always describe batting performances in terms of plate appearances when walks are involved. ` +
        `Never omit walks from a batting line.`;

    const wpaSwingNote =
        `Use total WPA swing for each game as a measure of drama and volatility. ` +
        `A game with a high total WPA swing was exciting and volatile. ` +
        `Reference it when describing how dramatic or one-sided a game was.`;

    const performanceNotes = `\n\n${walksNote}\n\n${wpaSwingNote}`;

    const factSheetPrefix = factSheet
        ? `VERIFIED FACTS — use these as ground truth for all specific claims about game results, ` +
          `standings movement, top performers, and league leaders. Do not contradict anything in this section.\n\n` +
          `${factSheet}\n\n`
        : '';

    return [
        {
            title: 'What to Know',
            system: studemundSystem,
            user:
                factSheetPrefix +
                `Today is ${dateLabel}.\n\n` +
                `Box scores:\n${boxStr}\n\n` +
                `Standings:\n${standStr}\n\n` +
                `Top WPA plays:\n${wpaStr}\n\n` +
                `Top pitchers:\n${topPitchersStr}\n\n` +
                `Top batters:\n${topBattersStr}\n\n` +
                `Write a daily baseball column in four sections, flowing naturally ` +
                `from one to the next with no section headers or labels.\n\n` +
                `SECTION 1 — PENNANT RACE GAMES: Discuss 2-4 games with the most ` +
                `pennant race significance. Use the standings data to identify which ` +
                `games mattered most in division or wild card races, such as teams close in divisions '+
                'or teams close in the wild card rankings. For each game, ` +
                `write 2-3 sentences about what the result means for the teams involved.\n\n` +
                `SECTION 2 — MOST DRAMATIC GAMES: Identify the 2-3 most dramatic or ` +
                `memorable games from yesterday. Use Total WPA Swing as one measure of ` +
                `drama. Another measure would be walkoff games. For each, write 2-3 sentences describing what made it memorable.\n\n` +
                `SECTION 3 — STANDOUT PERFORMANCES: Write 1-4 bullet points. One bullet ` +
                `per outstanding individual performance — batter or pitcher. Brief and ` +
                `specific. Draw from the top batters and top pitchers data.\n\n` +
                `SECTION 4 — STANDINGS AND TRENDS: Write 2-3 sentences on what the day's ` +
                `results mean for the overall league picture — division races, Pythagorean ` +
                `outliers, teams moving in the right or wrong direction.\n\n` +
                `Do not label the sections. Write as a continuous column that happens to ` +
                `follow this order. No introductory or closing paragraph.` +
                sharedNotes,
        },
        {
            title: 'Mets Daily Briefing',
            system: angellSystem,
            user:
                factSheetPrefix +
                `Write a 4-5 paragraph daily briefing on the New York Mets for a ` +
                `devoted fan's morning read. Cover:\n\n` +
                `- Yesterday's game: a narrative account of what happened, the key ` +
                `moments and turning points, standout individual performances — ` +
                `player stats will be inserted automatically, do not cite them\n` +
                `- Current standings: where the Mets sit in the NL East, games back ` +
                `or games ahead, recent streak\n` +
                `- Division rivals: how the other NL East teams did yesterday and ` +
                `what it means for the race\n` +
                `- Team trajectory: are the Mets over or underperforming their ` +
                `Pythagorean expectation, any patterns worth noting in recent ` +
                `performance\n` +
                `- Individual standouts: any Mets player with a performance worth ` +
                `singling out beyond the game narrative\n\n` +
                `If the Mets had no game yesterday, focus on the division landscape ` +
                `and what the off day meant in context.\n\n` +
                `Tone: write as someone who genuinely cares how this turns out, ` +
                `but with clear eyes. Don't cheerlead. Don't catastrophize.\n\n` +
                `Yesterday's date: ${dateLabel}\n\n` +
                `Boxscore data:\n${metsBoxStr}\n\n` +
                `NL East rivals' games:\n${metsRivalStr}\n\n` +
                `${metsStandStr}` +
                sharedNotes +
                `\n\n${cinematicsNote}` +
                performanceNotes,
        },
    ];
}

async function callClaude(client, prompt) {
    const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
    });
    return message.content[0].type === 'text' ? message.content[0].text : '';
}

async function verifyNarrative(client, text, sourceData) {
    const userContent =
        `You are a meticulous fact-checker for a baseball analytics website.\n` +
        `Below is a narrative and the source data it was generated from.\n\n` +
        `Your job:\n` +
        `1. Find every statistic, count, or factual claim in the narrative\n` +
        `2. Verify each one against the source data\n` +
        `3. Correct any errors by replacing wrong values with the correct ones from the data\n` +
        `4. Do not change the writing style, tone, structure, or any sentence that is factually correct\n` +
        `5. Do not add new information not in the original narrative\n` +
        `6. Return ONLY the corrected narrative text. Do not include any fact-checking notes, ` +
        `reasoning, corrections list, headers like 'Corrected Narrative:', or any other text. ` +
        `Just the narrative itself, exactly as it should appear to readers.\n\n` +
        `If you find no errors, return the narrative unchanged.\n\n` +
        `Source data:\n${sourceData}\n\n` +
        `Narrative to verify:\n${text}`;

    const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: userContent }],
    });
    return message.content[0].type === 'text' ? message.content[0].text : text;
}

function textToHtml(text) {
    const applyInline = s =>
        s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    const blocks = text.split(/\n\n+/);
    const parts = [];

    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        const lines = trimmed.split('\n');

        // Heading: #, ##, or ### → bold line
        if (/^#{1,3} /.test(lines[0])) {
            const headingText = lines[0].replace(/^#{1,3} /, '');
            parts.push(`<p><strong>${applyInline(headingText)}</strong></p>`);
            if (lines.length > 1) {
                parts.push(`<p>${lines.slice(1).map(applyInline).join(' ')}</p>`);
            }
            continue;
        }

        // List block: every line starts with - or *
        if (lines.every(l => /^[-*] /.test(l.trim()))) {
            const items = lines.map(l => `<li>${applyInline(l.trim().replace(/^[-*] /, ''))}</li>`).join('');
            parts.push(`<ul>${items}</ul>`);
            continue;
        }

        // Mixed block: some list lines, some prose — split and emit separately
        if (lines.some(l => /^[-*] /.test(l.trim()))) {
            let listLines = [];
            let proseLines = [];
            for (const l of lines) {
                if (/^[-*] /.test(l.trim())) {
                    if (proseLines.length) { parts.push(`<p>${proseLines.map(applyInline).join(' ')}</p>`); proseLines = []; }
                    listLines.push(l);
                } else {
                    if (listLines.length) { parts.push(`<ul>${listLines.map(l => `<li>${applyInline(l.trim().replace(/^[-*] /, ''))}</li>`).join('')}</ul>`); listLines = []; }
                    proseLines.push(l);
                }
            }
            if (listLines.length) parts.push(`<ul>${listLines.map(l => `<li>${applyInline(l.trim().replace(/^[-*] /, ''))}</li>`).join('')}</ul>`);
            if (proseLines.length) parts.push(`<p>${proseLines.map(applyInline).join(' ')}</p>`);
            continue;
        }

        // Plain paragraph
        parts.push(`<p>${applyInline(lines.join(' '))}</p>`);
    }

    return parts.join('\n');
}

function generateHTML(date, updatedStr, narratives, factSheet) {
    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const factSheetPanel = factSheet ? `
        <div class="insight-card">
            <button class="insight-toggle" aria-expanded="false" onclick="toggleInsight('factsheet')">
                <span class="insight-title">Today's Fact Sheet</span>
                <span class="insight-chevron">&#9660;</span>
            </button>
            <div class="insight-body" id="insight-factsheet" hidden>
                <pre class="factsheet-pre">${escHtml(factSheet)}</pre>
            </div>
        </div>` : '';

    const panels = narratives.map((n, i) => `
        <div class="insight-card">
            <button class="insight-toggle" aria-expanded="false" onclick="toggleInsight(${i})">
                <span class="insight-title">${n.title}</span>
                <span class="insight-chevron">&#9660;</span>
            </button>
            <div class="insight-body" id="insight-${i}" hidden>
                ${textToHtml(n.text)}
                <p><em>By the way, I'm not infallible. Wish I had an editor.</em></p>
            </div>
        </div>`).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MLB Insights — ${dateLabel}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: Georgia, 'Times New Roman', serif;
            background: #FFF8F0;
            color: #3b1e08;
            min-height: 100vh;
        }
        .site-header {
            background: linear-gradient(135deg, #78350f, #b45309, #78350f);
            color: #fff;
            padding: 0;
        }
        .header-inner {
            max-width: 960px;
            margin: 0 auto;
            padding: 1.25rem 1rem 0;
        }
        .site-title { font-size: 1.5rem; font-weight: bold; letter-spacing: 0.03em; }
        .site-subtitle { font-size: 0.9rem; opacity: 0.85; margin-top: 0.15rem; }
        nav {
            max-width: 960px;
            margin: 0 auto;
            padding: 0 1rem;
            display: flex;
            margin-top: 0.75rem;
        }
        nav a {
            display: inline-block;
            padding: 0.5rem 1.1rem;
            color: rgba(255,255,255,0.8);
            text-decoration: none;
            font-family: system-ui, sans-serif;
            font-size: 0.875rem;
            border-radius: 4px 4px 0 0;
            transition: background 0.15s;
        }
        nav a:hover { background: rgba(255,255,255,0.12); color: #fff; }
        nav a.active { background: #FFF8F0; color: #78350f; font-weight: 600; }
        .main-content { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
        h1 { font-size: 1.8rem; color: #78350f; margin-bottom: 0.4rem; }
        .updated {
            font-family: system-ui, sans-serif;
            font-size: 0.8rem;
            color: #92400e;
            margin-bottom: 2rem;
        }
        .insight-card {
            border: 2px solid #b45309;
            border-radius: 6px;
            margin-bottom: 1.25rem;
            overflow: hidden;
        }
        .insight-toggle {
            width: 100%;
            background: #fff7ed;
            border: none;
            cursor: pointer;
            padding: 0.9rem 1.25rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-family: Georgia, serif;
            font-size: 1.05rem;
            color: #78350f;
            font-weight: bold;
            text-align: left;
            transition: background 0.15s;
        }
        .insight-toggle:hover { background: rgba(253,230,138,0.2); }
        .insight-toggle[aria-expanded="true"] {
            background: linear-gradient(135deg, #78350f, #92400e);
            color: #fff;
        }
        .insight-chevron { font-size: 0.75rem; transition: transform 0.2s; }
        .insight-toggle[aria-expanded="true"] .insight-chevron { transform: rotate(180deg); }
        .insight-body {
            padding: 1.5rem 1.75rem;
            background: #fffbf5;
            border-top: 1px solid #f6d28d;
        }
        .insight-body p { line-height: 1.75; font-size: 1rem; color: #3b1e08; margin-bottom: 1.1em; }
        .insight-body p:last-child { margin-bottom: 0; }
        .insight-body ul { margin: 0.5em 0 0.5em 1.5em; }
        .insight-body li { margin-bottom: 0.3em; line-height: 1.75; }
        .factsheet-pre {
            font-family: 'Courier New', Courier, monospace;
            font-size: 0.82rem;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-word;
            color: #3b1e08;
            margin: 0;
        }
        footer {
            text-align: center;
            padding: 2rem 1rem;
            font-family: system-ui, sans-serif;
            font-size: 0.75rem;
            color: #92400e;
        }
    </style>
</head>
<body>
    <header class="site-header">
        <div class="header-inner">
            <div class="site-title">MLB Daily</div>
            <div class="site-subtitle">Daily baseball stats, standings, and insights</div>
        </div>
        <nav>
            <a href="index.html">Standings</a>
            <a href="player_stats.html">Players</a>
            <a href="graphs.html">Graphs</a>
            <a href="box-scores.html">Box Scores</a>
            <a href="insights.html" class="active">Insights</a>
        </nav>
    </header>
    <main class="main-content">
        <h1>Daily Insights — ${dateLabel}</h1>
        <p class="updated">Generated ${updatedStr}</p>
        ${factSheetPanel}
        ${panels}
    </main>
    <footer>Generated by Claude AI &bull; ${updatedStr}</footer>
    <script>
        function toggleInsight(i) {
            const body = document.getElementById('insight-' + i);
            const btn = body.previousElementSibling;
            const expanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!expanded));
            body.hidden = expanded;
        }
    </script>
</body>
</html>`;
}

async function main() {
    const { boxscore, standings, playerStats } = loadData();
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const date = boxscore.date;
    const now = new Date();
    const updatedStr = now.toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: 'America/New_York', timeZoneName: 'short',
    });

    const boxStr = formatBoxscoreForPrompt(boxscore);
    const standStr = formatStandingsForPrompt(standings);
    const wpaStr = formatAllWPAForPrompt(boxscore);
    const topBattersStr = getTopBattersForPrompt(boxscore, playerStats);
    const topPitchersStr = getTopPitchersForPrompt(boxscore, playerStats);

    const { metsBoxStr, metsRivalStr, metsStandStr } = formatMetsData(boxscore, standings);
    const factSheet = buildFactSheet(boxscore, standings, playerStats);
    const prompts = buildPrompts(date, boxStr, standStr, wpaStr, topBattersStr, topPitchersStr, metsBoxStr, metsRivalStr, metsStandStr, factSheet);

    // Build player index for stat injection
    const playerIndex = buildPlayerIndex(boxscore, playerStats);
    console.log(`Player index built: ${playerIndex.size} players`);

    // Source data for verification passes
    const metsGames = boxscore.games.filter(g => g.away.abbr === 'NYM' || g.home.abbr === 'NYM');
    const nlEastTeams = standings.teams.filter(t => t.division === 'National League East');
    const verifySourceData = {
        'What to Know': JSON.stringify({ games: boxscore.games, standings: standings.teams }, null, 2),
        'Mets Daily Briefing': JSON.stringify({ metsGames, nlEastStandings: nlEastTeams }, null, 2),
    };

    console.log(`Generating ${prompts.length} narratives via Claude (${MODEL})...`);
    const narratives = [];
    for (let i = 0; i < prompts.length; i++) {
        const title = prompts[i].title;
        console.log(`  [${i + 1}/${prompts.length}] ${title}...`);
        const text = await callClaude(client, prompts[i]);
        console.log(`  Generated (${text.length} chars), injecting stats...`);
        const withStats = injectStats(text, playerIndex);
        console.log(`  Stats injected, verifying...`);
        const verified = await verifyNarrative(client, withStats, verifySourceData[title]);
        console.log(`  Verified (${verified.length} chars)`);
        narratives.push({ title, text: verified });
    }

    const html = generateHTML(date, updatedStr, narratives, factSheet);
    fs.writeFileSync('insights.html', html);
    console.log('Generated insights.html successfully!');

    const snippetMeta = [
        { filename: 'whats-to-know-snippet.html', id: 'index-insight-0' },
        { filename: 'mets-snippet.html',           id: 'index-insight-1' },
    ];
    narratives.forEach((n, i) => {
        const { filename, id } = snippetMeta[i];
        const snippet = `<div class="insight-card">
            <button class="insight-toggle" aria-expanded="false" onclick="toggleInsight('${id}')">
                <span class="insight-title">${n.title}</span>
                <span class="insight-chevron">&#9660;</span>
            </button>
            <div class="insight-body" id="${id}" hidden>
                ${textToHtml(n.text)}
                <p><em>By the way, I'm not infallible. Wish I had an editor.</em></p>
            </div>
        </div>`;
        fs.writeFileSync(filename, snippet);
        console.log(`Generated ${filename}`);
    });
}

main().catch(err => {
    console.error('Error generating insights:', err);
    process.exit(1);
});
