'use strict';

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';
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

function formatBoxscoreForPrompt(boxscore) {
    const lines = [];
    for (const game of boxscore.games) {
        lines.push(`\n## ${game.away.name} (${game.away.score}) @ ${game.home.name} (${game.home.score}) at ${game.venue}`);

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

        lines.push(`\nAway Batting (${game.away.abbr}):`);
        for (const b of game.batting.away) {
            lines.push(`  ${b.name}: ${b.AB} AB, ${b.H} H, ${b.HR} HR, ${b.RBI} RBI, ${b.BB} BB, ${b.R} R`);
        }
        lines.push(`\nHome Batting (${game.home.abbr}):`);
        for (const b of game.batting.home) {
            lines.push(`  ${b.name}: ${b.AB} AB, ${b.H} H, ${b.HR} HR, ${b.RBI} RBI, ${b.BB} BB, ${b.R} R`);
        }

        lines.push(`\nAway Pitching (${game.away.abbr}):`);
        for (const p of game.pitching.away) {
            lines.push(`  ${p.name}: ${p.IP} IP, ${p.H} H, ${p.ER} ER, ${p.BB} BB, ${p.K} K`);
        }
        lines.push(`\nHome Pitching (${game.home.abbr}):`);
        for (const p of game.pitching.home) {
            lines.push(`  ${p.name}: ${p.IP} IP, ${p.H} H, ${p.ER} ER, ${p.BB} BB, ${p.K} K`);
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
                if (p.IP >= 1) allPitchers.push({ ...p, par: calcGamePAR(p) });
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
        const today = `Today: ${p.IP} IP, ${p.H} H, ${p.ER} ER, ${p.BB} BB, ${p.K} K (PAR ${p.par.toFixed(2)})`;
        if (s) {
            lines.push(
                `${p.name} (${s.team}): ${today}` +
                ` | Season: ${s.W}-${s.L} ERA ${s.ERA} WHIP ${s.WHIP} ${s.SO}K in ${s.IP} IP`
            );
        } else {
            lines.push(`${p.name}: ${today}`);
        }
    }
    return lines.join('\n');
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
            `${t.abbreviation}: ${t.w}-${t.l} .${t.pct} GB: ${t.gb}` +
            ` | RS/RA: ${t.rs}/${t.ra} RD: ${rd}` +
            ` | pyW: ${t.pythWins} (${pv})` +
            ` | Streak: ${t.streak || '?'} L10: ${t.splits.last10 || '?'}` +
            ` | OPS: ${t.stats.ops} FIP: ${t.stats.fip} DER: ${t.stats.der}`
        );
    }

    return { metsBoxStr, metsRivalStr, metsStandStr: standLines.join('\n') };
}

function buildPrompts(date, boxStr, standStr, wpaStr, topBattersStr, topPitchersStr, metsBoxStr, metsRivalStr, metsStandStr) {
    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const angellSystem =
        'You are a baseball writer in the tradition of Roger Angell — lyrical, unhurried, ' +
        'attentive to detail and human drama. Write vivid prose that makes the reader feel ' +
        'like they were at the ballpark. Avoid clichés. Each paragraph should earn its place. ' +
        'Output 3–5 paragraphs of polished prose. No headers, no bullet points.';

    const jamesSystem =
        'You are a baseball analyst in the tradition of Bill James — sharp, curious, willing ' +
        'to challenge conventional wisdom, with a gift for illuminating the numbers without ' +
        'losing sight of the game. Write incisive analytical prose. ' +
        '3–5 paragraphs. No headers or bullet points.';

    const fipNote =
        `IMPORTANT: FIP values in this dataset are missing the standard 3.10 constant. ` +
        `You MUST add 3.10 to every FIP value before using, referencing, or interpreting it. ` +
        `A stored FIP of 0.57 should be treated and cited as 3.67. ` +
        `Never reference the raw stored value.`;

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

    const sharedNotes = `\n\n${fipNote}\n\n${dataIntegrityNote}\n\n${homeAwayNote}`;

    const lwtsNote =
        `IMPORTANT: Linear weights are context-neutral — they do not account for game situation, ` +
        `leverage, or timing. Do not imply or suggest that a high LWTS reflects a clutch or ` +
        `high-leverage performance. Report only what the batting line shows.`;

    return [
        {
            title: "Today's Games",
            system: angellSystem,
            user:
                `Today is ${dateLabel}. Here are the complete box scores from today's MLB games:\n\n${boxStr}\n\n` +
                `Write a narrative recap of today's games, weaving together the most compelling stories — ` +
                `the outstanding performances, the dramatic moments, the pitching duels and offensive explosions. ` +
                `Let the best story lead.` +
                sharedNotes,
        },
        {
            title: 'Standings & Power Rankings',
            system: jamesSystem,
            user:
                `Today is ${dateLabel}. Here is the current MLB standings data:\n\n${standStr}\n\n` +
                `Analyze where each team stands right now. Who is overachieving their Pythagorean expectation? ` +
                `Who is getting by on a weak division? Who looks like a genuine contender, and who is in trouble? ` +
                `Be specific and direct.` +
                sharedNotes,
        },
        {
            title: 'Biggest Moments',
            system: angellSystem,
            user:
                `Today is ${dateLabel}. Here are today's highest win-probability-added plays across all games:\n\n${wpaStr}\n\n` +
                `Write a narrative that brings these pivotal moments to life. The WPA numbers tell you which plays ` +
                `mattered most; your job is to make the reader feel the weight of each one.` +
                sharedNotes,
        },
        {
            title: "Today's Best Pitchers",
            system: jamesSystem,
            user:
                `Today is ${dateLabel}. Here are today's most effective pitchers, with their game lines and season context:\n\n${topPitchersStr}\n\n` +
                `Analyze what made today's top pitching performances exceptional. How do they fit into each pitcher's ` +
                `season arc? What patterns do you see?` +
                sharedNotes,
        },
        {
            title: "Today's Best Batters",
            system: jamesSystem,
            user:
                `Today is ${dateLabel}. Here are today's most productive hitters, with their game lines and season stats:\n\n${topBattersStr}\n\n` +
                `Analyze the standout offensive performances. Who is getting hot at the right time? ` +
                `Whose production is genuinely surprising given their season numbers?` +
                sharedNotes +
                `\n\n${lwtsNote}`,
        },
        {
            title: 'Mets Daily Briefing',
            system:
                `You are writing in the style of Roger Angell — lyrical and unhurried, ` +
                `evoking the atmosphere and human drama of the game as much as the ` +
                `statistics, with beautifully crafted sentences and a deep reverence ` +
                `for baseball's rhythms and history. Angell was a lifelong New Yorker ` +
                `with a particular tenderness for the Mets — channel that affection ` +
                `without sentimentality.`,
            user:
                `Write a 4-5 paragraph daily briefing on the New York Mets for a ` +
                `devoted fan's morning read. Cover:\n\n` +
                `- Yesterday's game: a narrative account of what happened, the key ` +
                `moments and turning points, standout individual performances with ` +
                `full batting or pitching lines\n` +
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
                `PAR (Pitching Above Replacement) = ` +
                `Math.round((6.00 - (fip + era) / 2) * ip / 9). ` +
                `Higher PAR is better. A replacement level pitcher scores 0.\n\n` +
                `Yesterday's date: ${dateLabel}\n\n` +
                `Boxscore data:\n${metsBoxStr}\n\n` +
                `NL East rivals' games:\n${metsRivalStr}\n\n` +
                `${metsStandStr}` +
                sharedNotes,
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

function textToHtml(text) {
    return text
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => `<p>${p.replace(/\n/g, ' ')}</p>`)
        .join('\n');
}

function generateHTML(date, updatedStr, narratives) {
    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const panels = narratives.map((n, i) => `
        <div class="insight-card">
            <button class="insight-toggle" aria-expanded="false" onclick="toggleInsight(${i})">
                <span class="insight-title">${n.title}</span>
                <span class="insight-chevron">&#9660;</span>
            </button>
            <div class="insight-body" id="insight-${i}" hidden>
                ${textToHtml(n.text)}
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
    const prompts = buildPrompts(date, boxStr, standStr, wpaStr, topBattersStr, topPitchersStr, metsBoxStr, metsRivalStr, metsStandStr);

    console.log(`Generating ${prompts.length} narratives via Claude (${MODEL})...`);
    const narratives = [];
    for (let i = 0; i < prompts.length; i++) {
        console.log(`  [${i + 1}/${prompts.length}] ${prompts[i].title}...`);
        const text = await callClaude(client, prompts[i]);
        narratives.push({ title: prompts[i].title, text });
        console.log(`  Done (${text.length} chars)`);
    }

    const html = generateHTML(date, updatedStr, narratives);
    fs.writeFileSync('insights.html', html);
    console.log('Generated insights.html successfully!');
}

main().catch(err => {
    console.error('Error generating insights:', err);
    process.exit(1);
});
