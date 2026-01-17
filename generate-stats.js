const fetch = require('node-fetch');
const fs = require('fs');

const API_BASE = 'https://statsapi.mlb.com/api/v1';

// Map MLB team names to Fangraphs URL slugs
function getTeamFangraphsSlug(teamName) {
    const slugMap = {
        'Arizona Diamondbacks': 'diamondbacks',
        'Atlanta Braves': 'braves',
        'Baltimore Orioles': 'orioles',
        'Boston Red Sox': 'red-sox',
        'Chicago Cubs': 'cubs',
        'Chicago White Sox': 'white-sox',
        'Cincinnati Reds': 'reds',
        'Cleveland Guardians': 'guardians',
        'Colorado Rockies': 'rockies',
        'Detroit Tigers': 'tigers',
        'Houston Astros': 'astros',
        'Kansas City Royals': 'royals',
        'Los Angeles Angels': 'angels',
        'Los Angeles Dodgers': 'dodgers',
        'Miami Marlins': 'marlins',
        'Milwaukee Brewers': 'brewers',
        'Minnesota Twins': 'twins',
        'New York Mets': 'mets',
        'New York Yankees': 'yankees',
        'Oakland Athletics': 'athletics',
        'Philadelphia Phillies': 'phillies',
        'Pittsburgh Pirates': 'pirates',
        'San Diego Padres': 'padres',
        'San Francisco Giants': 'giants',
        'Seattle Mariners': 'mariners',
        'St. Louis Cardinals': 'cardinals',
        'Tampa Bay Rays': 'rays',
        'Texas Rangers': 'rangers',
        'Toronto Blue Jays': 'blue-jays',
        'Washington Nationals': 'nationals'
    };
    
    return slugMap[teamName] || teamName.toLowerCase().replace(/\s+/g, '-');
}

// Calculate Runs Created (OBP × TB)
function calculateRC(stats) {
    const h = stats.hits || 0;
    const bb = stats.baseOnBalls || 0;
    const hbp = stats.hitByPitch || 0;
    const ab = stats.atBats || 0;
    const sf = stats.sacFlies || 0;
    
    // Calculate OBP
    const denominator = ab + bb + hbp + sf;
    if (denominator === 0) return 0;
    const obp = (h + bb + hbp) / denominator;
    
    // Calculate TB
    const singles = h - (stats.doubles || 0) - (stats.triples || 0) - (stats.homeRuns || 0);
    const tb = singles + 2 * (stats.doubles || 0) + 3 * (stats.triples || 0) + 4 * (stats.homeRuns || 0);
    
    return obp * tb;
}

// Calculate FIP
function calculateFIP(stats) {
    const ip = parseFloat(stats.inningsPitched) || 0;
    if (ip === 0) return 0;
    
    const hr = stats.homeRuns || 0;
    const bb = stats.baseOnBalls || 0;
    const hbp = stats.hitByPitch || 0;
    const k = stats.strikeOuts || 0;
    
    return ((13 * hr + 3 * (bb + hbp) - 2 * k) / ip) + 3.10;
}

// Calculate batting average without leading zero
function calcAVG(hits, ab) {
    if (ab === 0) return '.000';
    const avg = (hits / ab).toFixed(3);
    return avg.startsWith('0') ? avg.substring(1) : avg;
}

// Calculate OBP
function calcOBP(stats) {
    const h = stats.hits || 0;
    const bb = stats.baseOnBalls || 0;
    const hbp = stats.hitByPitch || 0;
    const ab = stats.atBats || 0;
    const sf = stats.sacFlies || 0;
    
    const denominator = ab + bb + hbp + sf;
    if (denominator === 0) return '.000';
    const obp = ((h + bb + hbp) / denominator).toFixed(3);
    return obp.startsWith('0') ? obp.substring(1) : obp;
}

// Calculate SLG
function calcSLG(stats) {
    const ab = stats.atBats || 0;
    if (ab === 0) return '.000';
    
    const singles = (stats.hits || 0) - (stats.doubles || 0) - (stats.triples || 0) - (stats.homeRuns || 0);
    const tb = singles + 2 * (stats.doubles || 0) + 3 * (stats.triples || 0) + 4 * (stats.homeRuns || 0);
    
    const slg = (tb / ab).toFixed(3);
    return slg.startsWith('0') ? slg.substring(1) : slg;
}

// Calculate ERA
function calcERA(er, ip) {
    const innings = parseFloat(ip) || 0;
    return innings > 0 ? ((er * 9) / innings).toFixed(2) : '0.00';
}

// Calculate WHIP
function calcWHIP(stats) {
    const ip = parseFloat(stats.inningsPitched) || 0;
    if (ip === 0) return '0.00';
    return (((stats.baseOnBalls || 0) + (stats.hits || 0)) / ip).toFixed(2);
}

async function fetchTeams(season) {
    const response = await fetch(`${API_BASE}/teams?sportId=1&season=${season}`);
    const data = await response.json();
    return data.teams;
}

async function fetchTeamRoster(teamId, season) {
    const response = await fetch(`${API_BASE}/teams/${teamId}/roster?season=${season}`);
    const data = await response.json();
    return data.roster || [];
}

async function fetchPlayerStats(playerId, season) {
    const response = await fetch(`${API_BASE}/people/${playerId}/stats?stats=season&season=${season}&group=hitting,pitching`);
    const data = await response.json();
    return data.stats || [];
}

async function fetchPlayerDetails(playerId) {
    const response = await fetch(`${API_BASE}/people/${playerId}`);
    const data = await response.json();
    return data.people && data.people[0] ? data.people[0] : null;
}

function createBatterRow(player, stats, playerTeamCount) {
    const rc = Math.round(calculateRC(stats));
    const avg = calcAVG(stats.hits, stats.atBats);
    const obp = calcOBP(stats);
    const slg = calcSLG(stats);
    const position = player.position ? player.position.abbreviation : '';
    const playerLink = `https://baseballsavant.mlb.com/savant-player/${player.person.id}`;
    
    // Get age (current age from player data)
    const age = player.person.currentAge || '';
    
    // Calculate PA (Plate Appearances)
    const pa = (stats.atBats || 0) + (stats.baseOnBalls || 0) + (stats.hitByPitch || 0) + (stats.sacFlies || 0);
    
    // Calculate TB (Total Bases)
    const singles = (stats.hits || 0) - (stats.doubles || 0) - (stats.triples || 0) - (stats.homeRuns || 0);
    const tb = singles + 2 * (stats.doubles || 0) + 3 * (stats.triples || 0) + 4 * (stats.homeRuns || 0);
    
    // Determine handedness symbol for batters
    let handednessSymbol = '';
    if (player.person.batSide) {
        const batCode = player.person.batSide.code;
        if (batCode === 'L') {
            handednessSymbol = '*';
        } else if (batCode === 'S') {
            handednessSymbol = '†';
        }
        // R (right-handed) gets no symbol
    }
    
    // Check if multi-team player for italics
    const isMultiTeam = playerTeamCount[player.person.id] > 1;
    const nameStyle = isMultiTeam ? 'font-style: italic;' : '';
    
    return `
        <tr class="data-row" data-pa="${pa}">
            <td style="${nameStyle}"><a href="${playerLink}" target="_blank">${player.person.fullName}${handednessSymbol}</a></td>
            <td class="stat-num">${age}</td>
            <td>${position}</td>
            <td class="stat-num">${rc}</td>
            <td class="stat-num">${stats.runs || 0}</td>
            <td class="stat-num">${stats.rbi || 0}</td>
            <td class="stat-num">${avg}</td>
            <td class="stat-num">${obp}</td>
            <td class="stat-num">${slg}</td>
            <td class="stat-num">${stats.gamesPlayed || 0}</td>
            <td class="stat-num">${pa}</td>
            <td class="stat-num">${stats.hits || 0}</td>
            <td class="stat-num">${stats.doubles || 0}</td>
            <td class="stat-num">${stats.triples || 0}</td>
            <td class="stat-num">${stats.homeRuns || 0}</td>
            <td class="stat-num">${tb}</td>
            <td class="stat-num">${stats.baseOnBalls || 0}</td>
            <td class="stat-num">${stats.strikeOuts || 0}</td>
            <td class="stat-num">${stats.stolenBases || 0}</td>
            <td class="stat-num">${stats.caughtStealing || 0}</td>
        </tr>
    `;
}

function createPitcherRow(player, stats, playerTeamCount) {
    const era = calcERA(stats.earnedRuns, stats.inningsPitched);
    const whip = calcWHIP(stats);
    const fip = calculateFIP(stats);
    const ip = stats.inningsPitched ? parseFloat(stats.inningsPitched) : 0;
    const fipar = Math.round((6.00 - fip) * ip / 9);
    const playerLink = `https://baseballsavant.mlb.com/savant-player/${player.person.id}`;
    
    // Get age (current age from player data)
    const age = player.person.currentAge || '';
    
    // Determine handedness symbol for pitchers
    let handednessSymbol = '';
    if (player.person.pitchHand) {
        const pitchCode = player.person.pitchHand.code;
        if (pitchCode === 'L') {
            handednessSymbol = '*';
        }
        // R (right-handed) gets no symbol
        // Pitchers don't have switch option
    }
    
    // Check if multi-team player for italics
    const isMultiTeam = playerTeamCount[player.person.id] > 1;
    const nameStyle = isMultiTeam ? 'font-style: italic;' : '';
    
    return `
        <tr class="data-row" data-ip="${ip}">
            <td style="${nameStyle}"><a href="${playerLink}" target="_blank">${player.person.fullName}${handednessSymbol}</a></td>
            <td class="stat-num">${age}</td>
            <td class="stat-num">${fipar}</td>
            <td class="stat-num">${ip.toFixed(1)}</td>
            <td class="stat-num">${era}</td>
            <td class="stat-num">${fip.toFixed(2)}</td>
            <td class="stat-num">${whip}</td>
            <td class="stat-num">${stats.gamesPlayed || 0}</td>
            <td class="stat-num">${stats.gamesStarted || 0}</td>
            <td class="stat-num">${stats.wins || 0}</td>
            <td class="stat-num">${stats.losses || 0}</td>
            <td class="stat-num">${stats.saves || 0}</td>
            <td class="stat-num">${stats.hits || 0}</td>
            <td class="stat-num">${stats.runs || 0}</td>
            <td class="stat-num">${stats.earnedRuns || 0}</td>
            <td class="stat-num">${stats.homeRuns || 0}</td>
            <td class="stat-num">${stats.baseOnBalls || 0}</td>
            <td class="stat-num">${stats.strikeOuts || 0}</td>
        </tr>
    `;
}

async function loadTeamStats(team, season) {
    console.log(`Loading ${team.name}...`);
    const roster = await fetchTeamRoster(team.id, season);
    
    const batters = [];
    const pitchers = [];
    
    for (const player of roster) {
        // Fetch full player details for age and handedness
        const playerDetails = await fetchPlayerDetails(player.person.id);
        
        // Merge the detailed player info with the roster player info
        const enrichedPlayer = {
            ...player,
            person: {
                ...player.person,
                ...(playerDetails || {})
            }
        };
        
        const stats = await fetchPlayerStats(player.person.id, season);
        
        for (const statGroup of stats) {
            if (statGroup.group.displayName === 'hitting' && statGroup.splits.length > 0) {
                const hittingStats = statGroup.splits[0].stat;
                batters.push({ player: enrichedPlayer, stats: hittingStats });
            }
            
            if (statGroup.group.displayName === 'pitching' && statGroup.splits.length > 0) {
                const pitchingStats = statGroup.splits[0].stat;
                pitchers.push({ player: enrichedPlayer, stats: pitchingStats });
            }
        }
    }
    
    // Sort batters by RC descending
    batters.sort((a, b) => calculateRC(b.stats) - calculateRC(a.stats));
    
    // Sort pitchers by FIPAR descending
    pitchers.sort((a, b) => {
        const fiparA = (6.00 - calculateFIP(a.stats)) * parseFloat(a.stats.inningsPitched || 0) / 9;
        const fiparB = (6.00 - calculateFIP(b.stats)) * parseFloat(b.stats.inningsPitched || 0) / 9;
        return fiparB - fiparA;
    });
    
    return { batters, pitchers };
}

async function checkSeasonHasData(season) {
    console.log(`Checking if ${season} season has data...`);
    const teams = await fetchTeams(season);
    if (!teams || teams.length === 0) return false;
    
    // Check first team's roster
    const sampleTeam = teams[0];
    const roster = await fetchTeamRoster(sampleTeam.id, season);
    if (!roster || roster.length === 0) return false;
    
    // Check if any players have stats
    let hasStats = false;
    for (const player of roster.slice(0, 5)) { // Just check first 5 players
        const stats = await fetchPlayerStats(player.person.id, season);
        for (const statGroup of stats) {
            if (statGroup.splits && statGroup.splits.length > 0) {
                hasStats = true;
                break;
            }
        }
        if (hasStats) break;
    }
    
    console.log(`${season} has data: ${hasStats}`);
    return hasStats;
}

async function generateHTML() {
    const currentYear = new Date().getFullYear();
    
    // Determine which season to use
    let season = currentYear;
    const hasCurrentData = await checkSeasonHasData(currentYear);
    
    if (!hasCurrentData) {
        console.log(`No data for ${currentYear}, using ${currentYear - 1}`);
        season = currentYear - 1;
    } else {
        console.log(`Using ${season} season data`);
    }
    
    const teams = await fetchTeams(season);
    
    // Separate teams by league
    const alTeams = teams.filter(t => t.league && t.league.name === 'American League')
        .sort((a, b) => a.name.localeCompare(b.name));
    const nlTeams = teams.filter(t => t.league && t.league.name === 'National League')
        .sort((a, b) => a.name.localeCompare(b.name));
    
    const allTeams = [...alTeams, ...nlTeams];
    const teamData = {};
    
    // First pass: count how many teams each player appears on
    console.log('Counting multi-team players...');
    const playerTeamCount = {};
    
    for (const team of allTeams) {
        const roster = await fetchTeamRoster(team.id, season);
        for (const player of roster) {
            const playerId = player.person.id;
            playerTeamCount[playerId] = (playerTeamCount[playerId] || 0) + 1;
        }
    }
    
    // Load all team stats
    for (const team of allTeams) {
        teamData[team.id] = await loadTeamStats(team, season);
    }
    
    // ========== Generate JSON for leaderboards ==========
    console.log('Generating player-stats.json for leaderboards...');
    
    const allBatters = [];
    const allPitchers = [];
    
    for (const team of allTeams) {
        const league = team.league.name === 'American League' ? 'AL' : 'NL';
        const { batters, pitchers } = teamData[team.id];
        
        for (const b of batters) {
            const stats = b.stats;
            const pa = (stats.atBats || 0) + (stats.baseOnBalls || 0) + (stats.hitByPitch || 0) + (stats.sacFlies || 0);
            const singles = (stats.hits || 0) - (stats.doubles || 0) - (stats.triples || 0) - (stats.homeRuns || 0);
            const tb = singles + 2 * (stats.doubles || 0) + 3 * (stats.triples || 0) + 4 * (stats.homeRuns || 0);
            const rc = calculateRC(stats);
            
            allBatters.push({
                name: b.player.person.fullName,
                playerId: b.player.person.id,
                team: team.name,
                teamAbbr: team.abbreviation,
                league: league,
                age: b.player.person.currentAge || null,
                g: stats.gamesPlayed || 0,
                pa: pa,
                ab: stats.atBats || 0,
                h: stats.hits || 0,
                hr: stats.homeRuns || 0,
                rbi: stats.rbi || 0,
                r: stats.runs || 0,
                sb: stats.stolenBases || 0,
                bb: stats.baseOnBalls || 0,
                so: stats.strikeOuts || 0,
                avg: stats.atBats > 0 ? Math.round((stats.hits / stats.atBats) * 1000) / 1000 : 0,
                obp: pa > 0 ? Math.round(((stats.hits || 0) + (stats.baseOnBalls || 0) + (stats.hitByPitch || 0)) / pa * 1000) / 1000 : 0,
                slg: stats.atBats > 0 ? Math.round((tb / stats.atBats) * 1000) / 1000 : 0,
                ops: Math.round(((pa > 0 ? ((stats.hits || 0) + (stats.baseOnBalls || 0) + (stats.hitByPitch || 0)) / pa : 0) + (stats.atBats > 0 ? tb / stats.atBats : 0)) * 1000) / 1000,
                doubles: stats.doubles || 0,
                triples: stats.triples || 0,
                tb: tb,
                rc: Math.round(rc)
            });
        }
        
        for (const p of pitchers) {
            const stats = p.stats;
            const ip = parseFloat(stats.inningsPitched) || 0;
            const fip = calculateFIP(stats);
            const fipar = Math.round((6.00 - fip) * ip / 9);
            
            allPitchers.push({
                name: p.player.person.fullName,
                playerId: p.player.person.id,
                team: team.name,
                teamAbbr: team.abbreviation,
                league: league,
                age: p.player.person.currentAge || null,
                g: stats.gamesPlayed || 0,
                gs: stats.gamesStarted || 0,
                ip: Math.round(ip * 10) / 10,
                w: stats.wins || 0,
                l: stats.losses || 0,
                sv: stats.saves || 0,
                hr: stats.homeRuns || 0,
                k: stats.strikeOuts || 0,
                bb: stats.baseOnBalls || 0,
                era: ip > 0 ? Math.round(((stats.earnedRuns || 0) * 9 / ip) * 100) / 100 : 0,
                whip: ip > 0 ? Math.round(((stats.baseOnBalls || 0) + (stats.hits || 0)) / ip * 100) / 100 : 0,
                fip: Math.round(fip * 100) / 100,
                fipar: fipar,
                h: stats.hits || 0,
                er: stats.earnedRuns || 0
            });
        }
    }
    
    const playerStatsJson = {
        season: season,
        updated: new Date().toISOString(),
        batters: allBatters,
        pitchers: allPitchers
    };
    // ========== End JSON generation ==========
    
    // Generate team HTML sections
    let alHTML = '';
    for (const team of alTeams) {
        const { batters, pitchers } = teamData[team.id];
        
        const batterRows = batters.length > 0 
            ? batters.map(b => createBatterRow(b.player, b.stats, playerTeamCount)).join('')
            : '<tr><td colspan="20" style="text-align:center;">No batters</td></tr>';
        
        const pitcherRows = pitchers.length > 0
            ? pitchers.map(p => createPitcherRow(p.player, p.stats, playerTeamCount)).join('')
            : '<tr><td colspan="18" style="text-align:center;">No pitchers</td></tr>';
        
        const teamId = team.name.toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
        
        const fangraphsSlug = getTeamFangraphsSlug(team.name);
        const fangraphsUrl = `https://www.fangraphs.com/teams/${fangraphsSlug}`;
        
        alHTML += `
            <div class="team-section" id="${teamId}">
                <div class="team-header"><a href="${fangraphsUrl}" target="_blank" style="color: #2563eb; text-decoration: none;">${team.name}</a></div>
                
                <div class="section-title">Batters</div>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th class="stat-num sortable" data-sort="age" data-default="desc">Age</th>
                            <th>Pos</th>
                            <th class="stat-num sortable sorted" data-sort="rc" data-default="desc">RC</th>
                            <th class="stat-num sortable" data-sort="r" data-default="desc">R</th>
                            <th class="stat-num sortable" data-sort="rbi" data-default="desc">RBI</th>
                            <th class="stat-num sortable" data-sort="ba" data-default="desc">BA</th>
                            <th class="stat-num sortable" data-sort="obp" data-default="desc">OBP</th>
                            <th class="stat-num sortable" data-sort="slg" data-default="desc">SLG</th>
                            <th class="stat-num sortable" data-sort="g" data-default="desc">G</th>
                            <th class="stat-num sortable" data-sort="pa" data-default="desc">PA</th>
                            <th class="stat-num sortable" data-sort="h" data-default="desc">H</th>
                            <th class="stat-num sortable" data-sort="2b" data-default="desc">2B</th>
                            <th class="stat-num sortable" data-sort="3b" data-default="desc">3B</th>
                            <th class="stat-num sortable" data-sort="hr" data-default="desc">HR</th>
                            <th class="stat-num sortable" data-sort="tb" data-default="desc">TB</th>
                            <th class="stat-num sortable" data-sort="bb" data-default="desc">BB</th>
                            <th class="stat-num sortable" data-sort="so" data-default="desc">SO</th>
                            <th class="stat-num sortable" data-sort="sb" data-default="desc">SB</th>
                            <th class="stat-num sortable" data-sort="cs" data-default="desc">CS</th>
                        </tr>
                    </thead>
                    <tbody id="batters-${team.id}">
                        ${batterRows}
                    </tbody>
                </table>
                
                <div class="section-title">Pitchers</div>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th class="stat-num sortable" data-sort="age" data-default="desc">Age</th>
                            <th class="stat-num sortable sorted" data-sort="fipar" data-default="desc">FIPAR</th>
                            <th class="stat-num sortable" data-sort="ip" data-default="desc">IP</th>
                            <th class="stat-num sortable" data-sort="era" data-default="asc">ERA</th>
                            <th class="stat-num sortable" data-sort="fip" data-default="asc">FIP</th>
                            <th class="stat-num sortable" data-sort="whip" data-default="asc">WHIP</th>
                            <th class="stat-num sortable" data-sort="g" data-default="desc">G</th>
                            <th class="stat-num sortable" data-sort="gs" data-default="desc">GS</th>
                            <th class="stat-num sortable" data-sort="w" data-default="desc">W</th>
                            <th class="stat-num sortable" data-sort="l" data-default="desc">L</th>
                            <th class="stat-num sortable" data-sort="sv" data-default="desc">SV</th>
                            <th class="stat-num sortable" data-sort="h" data-default="desc">H</th>
                            <th class="stat-num sortable" data-sort="r" data-default="desc">R</th>
                            <th class="stat-num sortable" data-sort="er" data-default="desc">ER</th>
                            <th class="stat-num sortable" data-sort="hr" data-default="desc">HR</th>
                            <th class="stat-num sortable" data-sort="bb" data-default="desc">BB</th>
                            <th class="stat-num sortable" data-sort="so" data-default="desc">SO</th>
                        </tr>
                    </thead>
                    <tbody id="pitchers-${team.id}">
                        ${pitcherRows}
                    </tbody>
                </table>
            </div>
        `;
    }
    
    let nlHTML = '';
    for (const team of nlTeams) {
        const { batters, pitchers } = teamData[team.id];
        
        const batterRows = batters.length > 0 
            ? batters.map(b => createBatterRow(b.player, b.stats, playerTeamCount)).join('')
            : '<tr><td colspan="20" style="text-align:center;">No batters</td></tr>';
        
        const pitcherRows = pitchers.length > 0
            ? pitchers.map(p => createPitcherRow(p.player, p.stats, playerTeamCount)).join('')
            : '<tr><td colspan="18" style="text-align:center;">No pitchers</td></tr>';
        
        const teamId = team.name.toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
        
        const fangraphsSlug = getTeamFangraphsSlug(team.name);
        const fangraphsUrl = `https://www.fangraphs.com/teams/${fangraphsSlug}`;
        
        nlHTML += `
            <div class="team-section" id="${teamId}">
                <div class="team-header"><a href="${fangraphsUrl}" target="_blank" style="color: #2563eb; text-decoration: none;">${team.name}</a></div>
                
                <div class="section-title">Batters</div>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th class="stat-num sortable" data-sort="age" data-default="desc">Age</th>
                            <th>Pos</th>
                            <th class="stat-num sortable sorted" data-sort="rc" data-default="desc">RC</th>
                            <th class="stat-num sortable" data-sort="r" data-default="desc">R</th>
                            <th class="stat-num sortable" data-sort="rbi" data-default="desc">RBI</th>
                            <th class="stat-num sortable" data-sort="ba" data-default="desc">BA</th>
                            <th class="stat-num sortable" data-sort="obp" data-default="desc">OBP</th>
                            <th class="stat-num sortable" data-sort="slg" data-default="desc">SLG</th>
                            <th class="stat-num sortable" data-sort="g" data-default="desc">G</th>
                            <th class="stat-num sortable" data-sort="pa" data-default="desc">PA</th>
                            <th class="stat-num sortable" data-sort="h" data-default="desc">H</th>
                            <th class="stat-num sortable" data-sort="2b" data-default="desc">2B</th>
                            <th class="stat-num sortable" data-sort="3b" data-default="desc">3B</th>
                            <th class="stat-num sortable" data-sort="hr" data-default="desc">HR</th>
                            <th class="stat-num sortable" data-sort="tb" data-default="desc">TB</th>
                            <th class="stat-num sortable" data-sort="bb" data-default="desc">BB</th>
                            <th class="stat-num sortable" data-sort="so" data-default="desc">SO</th>
                            <th class="stat-num sortable" data-sort="sb" data-default="desc">SB</th>
                            <th class="stat-num sortable" data-sort="cs" data-default="desc">CS</th>
                        </tr>
                    </thead>
                    <tbody id="batters-${team.id}">
                        ${batterRows}
                    </tbody>
                </table>
                
                <div class="section-title">Pitchers</div>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th class="stat-num sortable" data-sort="age" data-default="desc">Age</th>
                            <th class="stat-num sortable sorted" data-sort="fipar" data-default="desc">FIPAR</th>
                            <th class="stat-num sortable" data-sort="ip" data-default="desc">IP</th>
                            <th class="stat-num sortable" data-sort="era" data-default="asc">ERA</th>
                            <th class="stat-num sortable" data-sort="fip" data-default="asc">FIP</th>
                            <th class="stat-num sortable" data-sort="whip" data-default="asc">WHIP</th>
                            <th class="stat-num sortable" data-sort="g" data-default="desc">G</th>
                            <th class="stat-num sortable" data-sort="gs" data-default="desc">GS</th>
                            <th class="stat-num sortable" data-sort="w" data-default="desc">W</th>
                            <th class="stat-num sortable" data-sort="l" data-default="desc">L</th>
                            <th class="stat-num sortable" data-sort="sv" data-default="desc">SV</th>
                            <th class="stat-num sortable" data-sort="h" data-default="desc">H</th>
                            <th class="stat-num sortable" data-sort="r" data-default="desc">R</th>
                            <th class="stat-num sortable" data-sort="er" data-default="desc">ER</th>
                            <th class="stat-num sortable" data-sort="hr" data-default="desc">HR</th>
                            <th class="stat-num sortable" data-sort="bb" data-default="desc">BB</th>
                            <th class="stat-num sortable" data-sort="so" data-default="desc">SO</th>
                        </tr>
                    </thead>
                    <tbody id="pitchers-${team.id}">
                        ${pitcherRows}
                    </tbody>
                </table>
            </div>
        `;
    }
    
    const now = new Date();
    const dateStr = now.toLocaleString('en-US', { 
        timeZone: 'America/New_York',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
    });
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Baseball Graphs Player Stats - ${season}</title>
    <link rel="icon" href="favicon.png">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: Georgia, "Times New Roman", serif;
            background-color: #F8F8FF;
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 960px;
            margin: 0 auto;
        }
        
        .breadcrumb {
            text-align: left;
            margin-bottom: 15px;
        }
        
        .breadcrumb a {
            color: #2563eb;
            text-decoration: none;
            font-size: 1.2em;
        }
        
        .breadcrumb a:hover {
            text-decoration: underline;
            color: #1e40af;
        }
        
        .breadcrumb a::before {
            content: "\\2190 ";
        }
        
        .header {
            text-align: center;
            margin-bottom: 20px;
            padding: 25px;
            background: linear-gradient(135deg, #8B4513, #CD853F, #8B4513);
            color: white;
            border-radius: 8px;
            box-shadow: 0 3px 6px rgba(139, 69, 19, 0.3);
        }
        
        .header h1 {
            font-size: 2.2em;
            font-weight: bold;
            margin-bottom: 8px;
        }
        
        .header p {
            font-size: 1.1em;
            opacity: 0.95;
        }
        
        hr {
            height: 5px;
            background: linear-gradient(to right, #8B4513, #CD853F, #8B4513);
            border: none;
            margin: 20px auto;
            width: 95%;
        }
        
        details {
            margin: 20px auto;
            border: 2px solid #8B4513;
            border-radius: 8px;
            padding: 15px;
            background-color: #FFFAF0;
            box-shadow: 0 2px 4px rgba(139, 69, 19, 0.2);
        }
        
        details summary {
            cursor: pointer;
            font-weight: 600;
            font-size: 1.2em;
            color: #8B4513;
            user-select: none;
            list-style: none;
            position: relative;
            padding-left: 20px;
        }
        
        details summary::-webkit-details-marker {
            display: none;
        }
        
        details summary::before {
            content: "";
            position: absolute;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 5px 0 5px 8px;
            border-color: transparent transparent transparent #8B4513;
            transition: transform 0.3s ease;
        }
        
        details[open] summary::before {
            transform: translateY(-50%) rotate(90deg);
        }
        
        details summary:hover {
            opacity: 0.7;
        }
        
        .details-content {
            padding: 15px 0 5px 20px;
            line-height: 1.6;
            color: #333;
        }
        
        .details-content p {
            margin-bottom: 10px;
        }
        
        .details-content ul {
            margin-left: 20px;
            margin-bottom: 10px;
        }
        
        .details-content li {
            margin-bottom: 5px;
        }
        
        .controls {
            margin-bottom: 20px;
            padding: 15px;
            background-color: white;
            border: 2px solid #CD853F;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(139, 69, 19, 0.15);
        }
        
        .controls-inner {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        .controls-left {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        button {
            padding: 10px 20px;
            background: linear-gradient(135deg, #8B4513, #A0522D);
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 1em;
            font-family: Georgia, "Times New Roman", serif;
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            transition: all 0.3s ease;
        }
        
        button:hover {
            background: linear-gradient(135deg, #A0522D, #CD853F);
            transform: translateY(-1px);
            box-shadow: 0 3px 6px rgba(0,0,0,0.3);
        }
        
        input[type="number"] {
            padding: 6px 10px;
            font-size: 1em;
            font-family: Georgia, "Times New Roman", serif;
            border: 1px solid #CD853F;
            border-radius: 4px;
            background-color: white;
            width: 60px;
        }
        
        #statsInfo {
            font-style: italic;
            color: #666;
            font-size: 0.95em;
        }
        
        
        .league-header {
            color: #2563eb;
            font-size: 1.8em;
            font-weight: bold;
            margin: 30px 0 20px 0;
            padding-bottom: 10px;
            border-bottom: 3px solid #2563eb;
        }
        
        .team-section {
            margin-bottom: 35px;
            background-color: white;
            padding: 20px;
            border: 2px solid #CD853F;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(139, 69, 19, 0.15);
        }
        
        .team-header {
            font-size: 1.5em;
            font-weight: bold;
            margin-bottom: 15px;
            padding-bottom: 8px;
            border-bottom: 2px solid #CD853F;
            color: #2563eb;
        }
        
        .section-title {
            font-size: 1.2em;
            font-weight: bold;
            margin-top: 20px;
            margin-bottom: 10px;
            color: #8B4513;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9em;
            margin-bottom: 20px;
            font-family: "Courier New", Courier, monospace;
        }
        
        th {
            background-color: #F5DEB3;
            padding: 8px 6px;
            text-align: left;
            border-bottom: 2px solid #8B4513;
            color: #2F2F2F;
            font-weight: bold;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 1em;
        }
        
        th.sortable {
            cursor: pointer;
            user-select: none;
        }
        
        th.sortable:hover {
            background-color: #E8D5B7;
        }
        
        th.sorted {
            background-color: #DEB887;
        }
        
        td {
            padding: 6px;
            border-bottom: 1px solid #E8D5B7;
        }
        
        tr:hover {
            background-color: #FFFAF0;
        }
        
        .stat-num {
            text-align: right;
        }
        
        td a {
            color: #2563eb;
            text-decoration: none;
        }
        
        td a:hover {
            text-decoration: underline;
            color: #1e40af;
        }
        
        td:first-child {
            font-family: Georgia, "Times New Roman", serif;
        }
        
        .data-row.hidden {
            display: none;
        }
        
        /* Floating team selector */
        .floating-selector {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 1000;
            background-color: white;
            border: 2px solid #8B4513;
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            min-width: 220px;
        }
        
        .floating-selector select {
            width: 100%;
            padding: 8px;
            font-size: 0.95em;
            font-family: Georgia, "Times New Roman", serif;
            border: 1px solid #CD853F;
            border-radius: 4px;
            background-color: white;
            cursor: pointer;
        }
        
        .floating-selector select:hover {
            border-color: #8B4513;
        }
        
        .current-team-display {
            font-size: 0.9em;
            color: #2563eb;
            font-weight: bold;
            margin-bottom: 8px;
            padding-bottom: 8px;
            border-bottom: 1px solid #E8D5B7;
            text-align: center;
        }
        
        @media (max-width: 800px) {
            body {
                padding: 10px;
            }
            
            .header h1 {
                font-size: 1.6em;
            }
            
            .header p {
                font-size: 1em;
            }
            
            .controls-inner {
                flex-direction: column;
                align-items: stretch;
            }
            
            .controls-left {
                flex-direction: column;
                align-items: stretch;
            }
            
            button, input {
                width: 100%;
            }
            
            table {
                font-size: 0.75em;
            }
            
            th, td {
                padding: 4px 2px;
            }
            
            .team-section {
                padding: 12px;
            }
            
            .floating-selector {
                top: 10px;
                right: 10px;
                min-width: 180px;
                padding: 8px;
            }
            
            .floating-selector select {
                font-size: 0.85em;
            }
        }
    </style>
</head>
<body>
    <div class="floating-selector">
        <div class="current-team-display" id="currentTeamDisplay">Viewing: Top of Page</div>
        <select id="teamSelector" onchange="jumpToTeam()">
            <option value="">-- Select Team --</option>
            <!-- Will be populated dynamically after page loads -->
        </select>
    </div>
    
    <div class="container">
        <div class="breadcrumb">
            <a href="https://www.baseballgraphs.com/">To the Baseball Graphs Home Page</a>
        </div>
        
        <div class="header">
            <h1>Baseball Graphs ${season} Player Stats</h1>
            <p>Team-by-Team Stats for Easy Reading</p>
        </div>
        
        <hr>
        
        <details>
            <summary>About these Stats</summary>
            <div class="details-content">
                <p>This page has been created for you to easily view baseball stats for each player on each team, grouped onto one long webpage. Like how we used to read stats back in the old days, in the newspaper. You may remember that. The stats have been pulled from the official MLB Stats API. Player names link to their Baseball Savant profiles for advanced metrics and visualizations. If a player has played for more than one team, his complete stats are listed for each one. Players who appear on multiple teams are italicized. Lefties have an asterisk; switch-hitters have a cross.</p>
                
                <p>Most of these are standard stats, but I've added a few simple sabermetric takes to sort players by their impact.</p>
                
                <ul>
                    <li><strong>RC (Runs Created)</strong> is simply OBPxTB</li>
                    <li><strong>FIP (Fielding Independent Pitching)</strong> ((13×HR)+(3×(BB+HBP))-(2×K))/IP + 3.10</li>
                    <li><strong>FIPAR (FIP Above Replacement)</strong> (6-FIP)×IP/9</li>
                </ul>
                
                <p>These stats are value approximations only. Please don't quote them. For actual good sabermetric stats, go to <a href="https://www.fangraphs.com/">Fangraphs</a> or <a href="https://www.baseball-reference.com/">Baseball Reference</a>.</p>
            </div>
        </details>
        
        <div class="controls">
            <div class="controls-inner">
                <div class="controls-left">
                    <button onclick="applyFilters()">Apply Filters</button>
                    <div>
                        <label for="minPA">Min PA: </label>
                        <input type="number" id="minPA" value="0">
                    </div>
                    <div>
                        <label for="minIP">Min IP: </label>
                        <input type="number" id="minIP" value="0">
                    </div>
                    <button onclick="resetFilters()">Show All</button>
                </div>
                <div id="statsInfo">${season} Season - Generated: ${dateStr}</div>
            </div>
        </div>
        
        <div id="content">
            <div id="american-league">
                <h2 class="league-header">AMERICAN LEAGUE</h2>
                ${alHTML}
            </div>
            
            <div id="national-league" style="margin-top: 20px;">
                <h2 class="league-header">NATIONAL LEAGUE</h2>
                ${nlHTML}
            </div>
        </div>
    </div>

    <script>
        function applyFilters() {
            const minPA = parseInt(document.getElementById('minPA').value) || 0;
            const minIP = parseFloat(document.getElementById('minIP').value) || 0;
            
            // Filter batters
            document.querySelectorAll('tbody[id^="batters-"] .data-row').forEach(row => {
                const pa = parseInt(row.dataset.pa) || 0;
                if (pa < minPA) {
                    row.classList.add('hidden');
                } else {
                    row.classList.remove('hidden');
                }
            });
            
            // Filter pitchers
            document.querySelectorAll('tbody[id^="pitchers-"] .data-row').forEach(row => {
                const ip = parseFloat(row.dataset.ip) || 0;
                if (ip < minIP) {
                    row.classList.add('hidden');
                } else {
                    row.classList.remove('hidden');
                }
            });
        }
        
        function resetFilters() {
            document.getElementById('minPA').value = '0';
            document.getElementById('minIP').value = '0';
            document.querySelectorAll('.data-row').forEach(row => {
                row.classList.remove('hidden');
            });
        }
        
        // Floating team selector functionality
        function populateTeamSelector() {
            const selector = document.getElementById('teamSelector');
            const alSection = document.getElementById('american-league');
            const nlSection = document.getElementById('national-league');
            
            // Clear existing options except the first one
            selector.innerHTML = '<option value="">-- Select Team --</option>';
            
            // Get AL teams
            const alTeams = alSection.querySelectorAll('.team-section');
            if (alTeams.length > 0) {
                const alGroup = document.createElement('optgroup');
                alGroup.label = 'American League';
                alTeams.forEach(team => {
                    const teamName = team.querySelector('.team-header').textContent;
                    const option = document.createElement('option');
                    option.value = team.id;
                    option.textContent = teamName;
                    alGroup.appendChild(option);
                });
                selector.appendChild(alGroup);
            }
            
            // Get NL teams
            const nlTeams = nlSection.querySelectorAll('.team-section');
            if (nlTeams.length > 0) {
                const nlGroup = document.createElement('optgroup');
                nlGroup.label = 'National League';
                nlTeams.forEach(team => {
                    const teamName = team.querySelector('.team-header').textContent;
                    const option = document.createElement('option');
                    option.value = team.id;
                    option.textContent = teamName;
                    nlGroup.appendChild(option);
                });
                selector.appendChild(nlGroup);
            }
        }
        
        function jumpToTeam() {
            const selector = document.getElementById('teamSelector');
            const teamId = selector.value;
            
            if (teamId) {
                const element = document.getElementById(teamId);
                if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Reset dropdown so user can select same team again
                    setTimeout(() => {
                        selector.value = '';
                    }, 500);
                }
            }
        }
        
        // Track current visible team
        function updateCurrentTeam() {
            const teams = document.querySelectorAll('.team-section');
            const display = document.getElementById('currentTeamDisplay');
            
            let currentTeam = 'Top of Page';
            
            for (const team of teams) {
                const rect = team.getBoundingClientRect();
                if (rect.top <= 150 && rect.bottom >= 150) {
                    const teamHeader = team.querySelector('.team-header');
                    if (teamHeader) {
                        currentTeam = teamHeader.textContent;
                    }
                    break;
                }
            }
            
            display.textContent = 'Viewing: ' + (currentTeam !== 'Top of Page' ? '${season} ' : '') + currentTeam;
        }
        
        // Update current team on scroll
        let scrollTimeout;
        window.addEventListener('scroll', function() {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(updateCurrentTeam, 100);
        });
        
        // Populate team selector on load
        window.addEventListener('load', function() {
            populateTeamSelector();
            initializeSortableHeaders();
        });
        
        // Table sorting functionality
        function initializeSortableHeaders() {
            document.querySelectorAll('th.sortable').forEach(header => {
                header.addEventListener('click', function() {
                    sortTable(this);
                });
            });
        }
        
        function sortTable(header) {
            const table = header.closest('table');
            const tbody = table.querySelector('tbody');
            const columnIndex = Array.from(header.parentElement.children).indexOf(header);
            const sortKey = header.dataset.sort;
            const defaultDirection = header.dataset.default || 'desc';
            
            // Remove sorted class from all headers in this table
            table.querySelectorAll('th.sorted').forEach(th => th.classList.remove('sorted'));
            
            // Add sorted class to clicked header
            header.classList.add('sorted');
            
            // Determine sort direction
            let isAscending;
            if (header.dataset.currentDirection) {
                // Toggle direction if already sorted
                isAscending = header.dataset.currentDirection === 'desc';
            } else {
                // Use default direction for first click
                isAscending = defaultDirection === 'asc';
            }
            
            // Store current direction
            header.dataset.currentDirection = isAscending ? 'asc' : 'desc';
            
            // Get all rows (including hidden ones)
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            // Sort rows
            rows.sort((a, b) => {
                const aCell = a.children[columnIndex];
                const bCell = b.children[columnIndex];
                
                if (!aCell || !bCell) return 0;
                
                const aText = aCell.textContent.trim();
                const bText = bCell.textContent.trim();
                
                // Convert to numbers for numeric columns
                const aNum = parseFloat(aText.replace(/,/g, ''));
                const bNum = parseFloat(bText.replace(/,/g, ''));
                
                let comparison = 0;
                
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    // Numeric comparison
                    comparison = aNum - bNum;
                } else {
                    // Text comparison
                    comparison = aText.localeCompare(bText);
                }
                
                return isAscending ? comparison : -comparison;
            });
            
            // Re-append sorted rows
            rows.forEach(row => tbody.appendChild(row));
        }
    </script>
</body>
</html>`;
    
    fs.writeFileSync('index.html', html);
    console.log('Generated index.html successfully!');
    
    // Write the JSON file for leaderboards
    fs.writeFileSync('player-stats.json', JSON.stringify(playerStatsJson, null, 2));
    console.log('Generated player-stats.json successfully!');
}

generateHTML().catch(console.error);
