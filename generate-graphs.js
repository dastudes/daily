const fetch = require('node-fetch');
const fs = require('fs');

const API_BASE = 'https://statsapi.mlb.com/api/v1';

// Fetch teams for a season
async function fetchTeams(season) {
    const response = await fetch(`${API_BASE}/teams?sportId=1&season=${season}`);
    const data = await response.json();
    return data.teams;
}

// Fetch standings to get W-L records and games back
async function fetchStandings(season) {
    const response = await fetch(`${API_BASE}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`);
    const data = await response.json();
    return data.records;
}

// Fetch team stats
async function fetchTeamStats(teamId, season) {
    const response = await fetch(`${API_BASE}/teams/${teamId}/stats?stats=season&season=${season}&group=hitting,pitching`);
    const data = await response.json();
    return data.stats || [];
}

// Calculate Pythagorean Variance
function calculatePythVar(w, l, rs, ra) {
    const games = w + l;
    if (games === 0) return 0;
    const pythWins = (Math.pow(rs, 2) / (Math.pow(rs, 2) + Math.pow(ra, 2))) * games;
    return w - pythWins;
}

// Calculate ISO (Isolated Power)
function calculateISO(stats) {
    const ab = stats.atBats || 0;
    if (ab === 0) return 0;
    
    const hits = stats.hits || 0;
    const doubles = stats.doubles || 0;
    const triples = stats.triples || 0;
    const hrs = stats.homeRuns || 0;
    
    const singles = hits - doubles - triples - hrs;
    const tb = singles + (2 * doubles) + (3 * triples) + (4 * hrs);
    const slg = tb / ab;
    const avg = hits / ab;
    
    return slg - avg;
}

// Calculate OBP
function calculateOBP(stats) {
    const h = stats.hits || 0;
    const bb = stats.baseOnBalls || 0;
    const hbp = stats.hitByPitch || 0;
    const ab = stats.atBats || 0;
    const sf = stats.sacFlies || 0;
    
    const denominator = ab + bb + hbp + sf;
    if (denominator === 0) return 0;
    
    return (h + bb + hbp) / denominator;
}

// Calculate FIP (Fielding Independent Pitching)
function calculateFIP(stats) {
    const ip = parseFloat(stats.inningsPitched) || 0;
    if (ip === 0) return 0;
    
    const hr = stats.homeRuns || 0;
    const bb = stats.baseOnBalls || 0;
    const hbp = stats.hitByPitch || 0;
    const k = stats.strikeOuts || 0;
    
    // FIP formula without league adjustment constant
    return (13 * hr + 3 * (bb + hbp) - 2 * k) / ip;
}

// Calculate DER (Defensive Efficiency Record)
function calculateDER(stats) {
    // DER = (BIP - H) / BIP
    // BIP (Balls In Play) = PA - BB - SO - HR - HBP - SH - SF
    const pa = stats.plateAppearances || 0;
    const bb = stats.baseOnBalls || 0;
    const so = stats.strikeOuts || 0;
    const hr = stats.homeRuns || 0;
    const hbp = stats.hitByPitch || 0;
    const sh = stats.sacBunts || 0;
    const sf = stats.sacFlies || 0;
    const h = stats.hits || 0;
    
    const bip = pa - bb - so - hr - hbp - sh - sf;
    if (bip === 0) return 0;
    
    return (bip - h) / bip;
}

async function checkSeasonHasData(season) {
    try {
        const teams = await fetchTeams(season);
        if (!teams || teams.length === 0) {
            console.log(`${season}: No teams found`);
            return false;
        }
        
        // Try to fetch standings to verify season has actual game data
        const standings = await fetchStandings(season);
        if (!standings || standings.length === 0) {
            console.log(`${season}: No standings found`);
            return false;
        }
        
        console.log(`${season}: Has data (${teams.length} teams, ${standings.length} divisions)`);
        return true;
    } catch (error) {
        console.log(`${season}: Error - ${error.message}`);
        return false;
    }
}

async function generateHTML() {
    const currentYear = new Date().getFullYear();
    
    // Determine which season to use
    let season = currentYear;
    console.log(`Checking for ${currentYear} season data...`);
    const hasCurrentData = await checkSeasonHasData(currentYear);
    
    if (!hasCurrentData) {
        console.log(`No data for ${currentYear}, trying ${currentYear - 1}...`);
        season = currentYear - 1;
        const hasPriorData = await checkSeasonHasData(season);
        if (!hasPriorData) {
            throw new Error(`No data available for ${currentYear} or ${season}`);
        }
    }
    
    console.log(`Using ${season} season data`);
    
    // Fetch teams and standings
    console.log(`Fetching teams for ${season}...`);
    const teams = await fetchTeams(season);
    if (!teams || teams.length === 0) {
        throw new Error(`Failed to fetch teams for ${season}`);
    }
    console.log(`Found ${teams.length} teams`);
    
    console.log(`Fetching standings for ${season}...`);
    const standingsRecords = await fetchStandings(season);
    if (!standingsRecords || standingsRecords.length === 0) {
        throw new Error(`Failed to fetch standings for ${season}`);
    }
    console.log(`Found ${standingsRecords.length} division records`);
    
    // Create a map of team standings info
    const standingsMap = {};
    for (const divisionRecord of standingsRecords) {
        const league = divisionRecord.league.name;
        const divisionName = divisionRecord.division.name;
        const divisionAbbrev = divisionRecord.division.abbreviation;
        
        for (const teamRecord of divisionRecord.teamRecords) {
            const teamId = teamRecord.team.id;
            standingsMap[teamId] = {
                w: teamRecord.wins,
                l: teamRecord.losses,
                gb: teamRecord.gamesBack,
                wcGb: teamRecord.wildCardGamesBack,
                wcRank: teamRecord.wildCardRank,
                league: league,
                division: divisionName,
                divisionAbbrev: divisionAbbrev
            };
        }
    }
    
    console.log(`Processing ${Object.keys(standingsMap).length} teams with standings data...`);
    
    // Process each team
    const teamData = {};
    let processedCount = 0;
    
    for (const team of teams) {
        // Skip teams without standings data (e.g., All-Star teams)
        if (!standingsMap[team.id]) {
            console.log(`Skipping ${team.name} - no standings data`);
            continue;
        }
        
        // Skip teams without league info
        if (!team.league || !team.league.name) {
            console.log(`Skipping ${team.name} - no league info`);
            continue;
        }
        
        const standings = standingsMap[team.id];
        
        console.log(`Fetching stats for ${team.name}...`);
        
        try {
            // Get team stats
            const stats = await fetchTeamStats(team.id, season);
            let hittingStats = {};
            let pitchingStats = {};
            
            for (const statGroup of stats) {
                if (statGroup.group && statGroup.group.displayName === 'hitting' && statGroup.splits && statGroup.splits.length > 0) {
                    hittingStats = statGroup.splits[0].stat;
                }
                if (statGroup.group && statGroup.group.displayName === 'pitching' && statGroup.splits && statGroup.splits.length > 0) {
                    pitchingStats = statGroup.splits[0].stat;
                }
            }
            
            const w = standings.w;
            const l = standings.l;
            const pct = (w / (w + l)).toFixed(3).substring(1); // Remove leading 0
            const rs = hittingStats.runs || 0;
            const ra = pitchingStats.runs || 0;
            const gamesPlayed = w + l;
            
            teamData[team.id] = {
                name: team.name,
                abbreviation: team.abbreviation,
                league: team.league.name,
                division: team.division ? team.division.name : standings.division,
                divisionAbbrev: team.division ? team.division.nameShort : standings.divisionAbbrev,
                w: w,
                l: l,
                pct: pct,
                gb: standings.gb,
                wcGb: standings.wcGb,
                wcRank: standings.wcRank,
                rs: rs,
                ra: ra,
                gamesPlayed: gamesPlayed,
                pythVar: calculatePythVar(w, l, rs, ra),
                // Stats for graphs
                rsPerGame: gamesPlayed > 0 ? rs / gamesPlayed : 0,
                raPerGame: gamesPlayed > 0 ? ra / gamesPlayed : 0,
                obp: calculateOBP(hittingStats),
                iso: calculateISO(hittingStats),
                fip: calculateFIP(pitchingStats),
                der: calculateDER(pitchingStats)
            };
            
            processedCount++;
            
            // Add small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`Error processing ${team.name}:`, error.message);
            // Continue with other teams even if one fails
        }
    }
    
    console.log(`Successfully processed ${processedCount} teams out of ${teams.length}`);
    
    if (processedCount === 0) {
        throw new Error('No teams were successfully processed');
    }
    
    // Debug: Show what's in teamData
    console.log(`teamData contains ${Object.keys(teamData).length} teams`);
    if (Object.keys(teamData).length > 0) {
        const firstTeam = Object.values(teamData)[0];
        console.log(`First team sample:`, JSON.stringify({
            name: firstTeam.name,
            league: firstTeam.league,
            w: firstTeam.w,
            l: firstTeam.l,
            rs: firstTeam.rs
        }));
    }
    
    // Generate the HTML
    const dateStr = new Date().toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    const html = generateHTMLContent(season, dateStr, teamData);
    
    fs.writeFileSync('graphs.html', html);
    console.log('Generated graphs.html successfully!');
}

function generateHTMLContent(season, dateStr, teamData) {
    // Debug: log what we received
    const teamCount = Object.keys(teamData).length;
    console.log(`generateHTMLContent received ${teamCount} teams`);
    if (teamCount > 0) {
        const sampleTeam = Object.values(teamData)[0];
        console.log(`Sample team: league="${sampleTeam.league}", division="${sampleTeam.division}", divAbbrev="${sampleTeam.divisionAbbrev}"`);
    }
    
    // Separate teams by league and division
    const alTeams = Object.values(teamData).filter(t => t.league === 'American League');
    const nlTeams = Object.values(teamData).filter(t => t.league === 'National League');
    
    console.log(`Filtered: ${alTeams.length} AL teams, ${nlTeams.length} NL teams`);
    
    // Group by division
    function groupByDivision(teams) {
        const divisions = {};
        teams.forEach(team => {
            // Extract just E, C, or W from division name if divisionAbbrev isn't working
            let divKey = team.divisionAbbrev;
            if (!divKey || divKey === 'undefined') {
                // Try to extract from division name (e.g., "American League East" -> "E")
                if (team.division && team.division.includes('East')) divKey = 'E';
                else if (team.division && team.division.includes('Central')) divKey = 'C';
                else if (team.division && team.division.includes('West')) divKey = 'W';
                else divKey = 'Unknown';
            }
            
            if (!divisions[divKey]) {
                divisions[divKey] = {
                    name: team.division,
                    teams: []
                };
            }
            divisions[divKey].teams.push(team);
        });
        
        // Sort teams within each division by wins (descending)
        Object.keys(divisions).forEach(div => {
            divisions[div].teams.sort((a, b) => b.w - a.w);
        });
        
        console.log(`Division keys found: ${Object.keys(divisions).join(', ')}`);
        
        return divisions;
    }
    
    const alDivisions = groupByDivision(alTeams);
    const nlDivisions = groupByDivision(nlTeams);
    
    // Generate standings HTML function
    function generateStandingsHTML(divisions, league) {
        let html = '';
        const divOrder = ['E', 'C', 'W'];
        
        divOrder.forEach(divAbbrev => {
            if (!divisions[divAbbrev]) return;
            
            const division = divisions[divAbbrev];
            html += `<div class="mb-4">`;
            html += `<h3 class="text-lg font-semibold text-gray-800 mb-1">${division.name}</h3>`;
            html += `<table class="w-full text-gray-800 text-sm">`;
            html += `<thead><tr class="border-b-2 border-amber-700">`;
            html += `<th class="text-left py-1 px-2" style="width: 35%;">Team</th>`;
            html += `<th class="text-center py-1 px-2" style="width: 8%;">W</th>`;
            html += `<th class="text-center py-1 px-2" style="width: 8%;">L</th>`;
            html += `<th class="text-center py-1 px-2" style="width: 8%;">GB</th>`;
            html += `<th class="text-center py-1 px-2" style="width: 10%;">PCT</th>`;
            html += `<th class="text-center py-1 px-2" style="width: 10%;">RS</th>`;
            html += `<th class="text-center py-1 px-2" style="width: 10%;">RA</th>`;
            html += `<th class="text-right py-1 px-2" style="width: 11%;">PythVar</th>`;
            html += `</tr></thead><tbody class="text-sm">`;
            
            division.teams.forEach(team => {
                // Check if team is in wild card spot (ranks 1-3)
                const wcAsterisk = (team.wcRank && team.wcRank <= 3 && parseFloat(team.gb) > 0) ? '*' : '';
                const bbrefUrl = `https://www.baseball-reference.com/teams/${team.abbreviation}/${season}.shtml`;
                
                html += `<tr class="hover:bg-blue-50 leading-tight">`;
                html += `<td class="py-0 px-2"><a href="${bbrefUrl}" target="_blank" style="color: #2563eb; text-decoration: underline;">${team.name}</a>${wcAsterisk}</td>`;
                html += `<td class="text-center py-0 px-2">${team.w}</td>`;
                html += `<td class="text-center py-0 px-2">${team.l}</td>`;
                html += `<td class="text-center py-0 px-2">${team.gb === '0.0' ? '-' : team.gb}</td>`;
                html += `<td class="text-center py-0 px-2">${team.pct}</td>`;
                html += `<td class="text-center py-0 px-2">${team.rs}</td>`;
                html += `<td class="text-center py-0 px-2">${team.ra}</td>`;
                html += `<td class="text-right py-0 px-2">${team.pythVar.toFixed(1)}</td>`;
                html += `</tr>`;
            });
            
            html += `</tbody></table></div>`;
        });
        
        return html;
    }
    
    const alStandingsHTML = generateStandingsHTML(alDivisions, 'AL');
    const nlStandingsHTML = generateStandingsHTML(nlDivisions, 'NL');
    
    // Prepare data for graphs (as JSON)
    const alTeamsData = JSON.stringify(alTeams);
    const nlTeamsData = JSON.stringify(nlTeams);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Baseball Graphs Daily</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body {
            font-family: Georgia, "Times New Roman", serif;
            background: linear-gradient(to bottom, #FFF8DC 0%, #F5DEB3 100%);
            color: #2F2F2F;
            margin: 0;
            padding: 20px;
        }
        .container {
            max-width: 960px !important;
            margin: 0 auto !important;
            padding: 0 20px;
        }
        .header {
            background: linear-gradient(135deg, #8B4513, #A0522D);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            text-align: center;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header h1 {
            margin: 0;
            font-size: 2.5em;
            font-weight: bold;
        }
        .breadcrumb {
            position: absolute;
            top: 20px;
            left: 20px;
            font-size: 0.9em;
        }
        .breadcrumb a {
            color: #2563eb;
            text-decoration: underline;
        }
        .about-section {
            background: white;
            border: 2px solid #8B4513;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .about-section details {
            cursor: pointer;
        }
        .about-section summary {
            font-weight: bold;
            font-size: 1.1em;
            color: #8B4513;
            padding: 5px;
        }
        .about-section .content {
            margin-top: 10px;
            line-height: 1.6;
        }
        .league-selector {
            display: flex;
            gap: 20px;
            justify-content: center;
            margin-bottom: 10px;
        }
        .league-selector label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            font-size: 1.1em;
            font-weight: bold;
        }
        .league-selector input[type="radio"] {
            width: 18px;
            height: 18px;
            cursor: pointer;
        }
        .standings-box {
            background: white;
            border: 4px solid #8B4513;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .standings-box h2 {
            text-align: center;
            font-size: 1.8em;
            margin-bottom: 15px;
            color: #2F2F2F;
        }
        .tab-container {
            background: white;
            border: 4px solid #888;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .tab-buttons {
            display: flex;
            border-bottom: 4px solid #888;
        }
        .tab-button {
            flex: 1;
            padding: 12px;
            font-weight: bold;
            font-size: 1.1em;
            background: #f0f0f0;
            border: none;
            border-right: 2px solid #888;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        .tab-button:last-child {
            border-right: none;
        }
        .tab-button.active {
            background: white;
        }
        .tab-button:hover:not(.active) {
            background: #e0e0e0;
        }
        .tab-content {
            padding: 20px;
        }
        .tab-content.bg-red-50 {
            background-color: #fef2f2;
        }
        .tab-content.bg-blue-50 {
            background-color: #eff6ff;
        }
        .tab-content.bg-green-50 {
            background-color: #f0fdf4;
        }
        .chart-container {
            position: relative;
            height: 500px;
            margin: 20px 0;
        }
        .graph-info {
            margin-top: 15px;
            text-align: center;
            color: #666;
            font-size: 0.9em;
        }
        .graph-controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 15px;
        }
        .about-graph {
            flex: 1;
        }
        .about-graph details {
            cursor: pointer;
        }
        .about-graph summary {
            font-weight: bold;
            color: #2563eb;
            padding: 5px;
        }
        .about-graph .content {
            margin-top: 10px;
            line-height: 1.6;
            padding: 10px;
            background: #f9f9f9;
            border-radius: 5px;
        }
        .download-button {
            padding: 8px 16px;
            background: linear-gradient(135deg, #8B4513, #A0522D);
            color: white;
            border: none;
            border-radius: 5px;
            font-weight: bold;
            cursor: pointer;
            transition: transform 0.1s;
        }
        .download-button:hover {
            transform: scale(1.05);
        }
        .footer-note {
            text-align: center;
            color: #666;
            font-size: 0.85em;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="breadcrumb">
        <a href="https://baseballgraphs.com">Baseball Graphs</a> &gt; Daily Stats
    </div>
    
    <div class="container">
        <div class="header">
            <h1>Baseball Graphs Daily</h1>
            <div style="margin-top: 10px; font-size: 0.9em;">${season} Season - Updated: ${dateStr}</div>
        </div>
        
        <div class="about-section">
            <details>
                <summary>About These Graphs</summary>
                <div class="content">
                    <p><strong>Welcome to Baseball Graphs Daily!</strong></p>
                    <p>This page automatically updates each morning with the latest MLB standings and three analytical graphs that help understand team performance.</p>
                    <p>The <strong>Run Differential</strong> graph shows how teams perform offensively and defensively, with Pythagorean win expectancy lines. The <strong>Offensive Profile</strong> graph examines how teams score runs through on-base percentage and power. The <strong>Pitching & Defense</strong> graph separates pitching quality (FIP) from fielding effectiveness (DER).</p>
                    <p>Select American League or National League to view standings and graphs for that league. Click the tabs to switch between the three graphs. For detailed player statistics, visit our <a href="index.html" style="color: #2563eb; text-decoration: underline;">Daily Stats page</a>.</p>
                </div>
            </details>
        </div>
        
        <div class="standings-box">
            <div class="league-selector">
                <label>
                    <input type="radio" name="league" value="AL" checked onchange="updateLeague()">
                    American League
                </label>
                <label>
                    <input type="radio" name="league" value="NL" onchange="updateLeague()">
                    National League
                </label>
            </div>
            
            <div id="alStandings">
                <h2>${season} American League Standings</h2>
                ${alStandingsHTML}
                <div class="footer-note">
                    <strong>*</strong> = Wild Card position | PythVar = Actual Wins - Pythagorean Expected Wins
                </div>
            </div>
            
            <div id="nlStandings" style="display: none;">
                <h2>${season} National League Standings</h2>
                ${nlStandingsHTML}
                <div class="footer-note">
                    <strong>*</strong> = Wild Card position | PythVar = Actual Wins - Pythagorean Expected Wins
                </div>
            </div>
        </div>
        
        <div class="tab-container">
            <div class="tab-buttons">
                <button class="tab-button active" onclick="switchTab(1)">Run Differential</button>
                <button class="tab-button" onclick="switchTab(2)">Runs Scored</button>
                <button class="tab-button" onclick="switchTab(3)">Runs Allowed</button>
            </div>
            
            <div id="tab1" class="tab-content bg-red-50">
                <h2 style="text-align: center; font-size: 1.5em; margin-bottom: 5px;">Win Expectation: Runs Scored and Runs Allowed</h2>
                <p id="graph1Title" style="text-align: center; color: #666; margin-bottom: 15px;"></p>
                <div class="chart-container">
                    <canvas id="chart1"></canvas>
                </div>
                <div class="graph-info">
                    <p>Better teams (upper right) score more and allow fewer runs</p>
                    <p>Win% lines of .400, .500 and .600 are based on the Pythagorean Formula</p>
                    <p>Hover over a data point to see the team name and wins</p>
                </div>
                <div class="graph-controls">
                    <div class="about-graph">
                        <details>
                            <summary>About This Graph</summary>
                            <div class="content">
                                <p><strong>Run Differential</strong></p>
                                <p>This graph shows how well each team performed scoring and allowing runs, which are the drivers of baseball success. The Runs Allowed axis (Y axis) is reversed, so that the best defensive teams are at the top and the best scoring teams are on the right.</p>
                                <p>The dotted lines are based on the Pythagorean Theorem (RS²)/(RS²+RA²), which is a good predictor of winning percentage. The lines are drawn at different winning percentages so you can compare teams in different areas of the graph. The best teams will be above the .600 line.</p>
                                <p>If you hover over a datapoint, you'll see the team name and actual wins. The PythVar column in the standings shows the difference between actual wins and Pythagorean wins.</p>
                            </div>
                        </details>
                    </div>
                    <button class="download-button" onclick="downloadChart(1)">Download Graph</button>
                </div>
            </div>
            
            <div id="tab2" class="tab-content bg-blue-50" style="display: none;">
                <h2 style="text-align: center; font-size: 1.5em; margin-bottom: 5px;">Offensive Profile: OBP and ISO</h2>
                <p id="graph2Title" style="text-align: center; color: #666; margin-bottom: 15px;"></p>
                <div class="chart-container">
                    <canvas id="chart2"></canvas>
                </div>
                <div class="graph-info">
                    <p>Better offensive teams are in the upper right (high OBP and high power)</p>
                    <p>Dotted lines represent league averages</p>
                    <p>Hover over a data point to see the team name and runs scored</p>
                </div>
                <div class="graph-controls">
                    <div class="about-graph">
                        <details>
                            <summary>About This Graph</summary>
                            <div class="content">
                                <p><strong>How Teams Score Runs</strong></p>
                                <p>This graph examines the two key components of offense: getting on base (OBP) and hitting for power (ISO - Isolated Power). ISO is calculated as slugging percentage minus batting average, measuring extra bases per at-bat.</p>
                                <p>Teams in the upper right excel at both getting on base and hitting for power, producing the most runs. Teams in the lower left struggle with both. The dotted lines show league averages for reference.</p>
                                <p>This helps identify whether a team's offensive success comes from patience at the plate, power hitting, or a combination of both.</p>
                            </div>
                        </details>
                    </div>
                    <button class="download-button" onclick="downloadChart(2)">Download Graph</button>
                </div>
            </div>
            
            <div id="tab3" class="tab-content bg-green-50" style="display: none;">
                <h2 style="text-align: center; font-size: 1.5em; margin-bottom: 5px;">Pitching & Defense: FIP and DER</h2>
                <p id="graph3Title" style="text-align: center; color: #666; margin-bottom: 15px;"></p>
                <div class="chart-container">
                    <canvas id="chart3"></canvas>
                </div>
                <div class="graph-info">
                    <p>Better pitching teams are on the right; better fielding teams are near the top</p>
                    <p>Dotted lines represent league averages</p>
                    <p>Hover over a data point to see the team name and runs allowed</p>
                </div>
                <div class="graph-controls">
                    <div class="about-graph">
                        <details>
                            <summary>About This Graph</summary>
                            <div class="content">
                                <p><strong>Separating Pitching and Fielding</strong></p>
                                <p>The easiest way to judge pitching effectiveness is to isolate outcomes that don't involve fielders: strikeouts, walks, and home runs. That's what FIP measures: (HR×13 + BB×3 - K×2) / IP. Lower FIP indicates better pitching.</p>
                                <p>All other batted balls involve fielders. To measure fielding, we use Defensive Efficiency Record (DER), which is the percent of batted balls (excluding home runs) turned into outs by fielders. Higher DER indicates better fielding.</p>
                                <p>The FIP axis is reversed so that better pitching teams are on the right. The best overall teams (upper right) combine strong pitching and fielding.</p>
                            </div>
                        </details>
                    </div>
                    <button class="download-button" onclick="downloadChart(3)">Download Graph</button>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        const alData = ${alTeamsData};
        const nlData = ${nlTeamsData};
        let currentLeague = 'AL';
        let chart1, chart2, chart3;
        
        // Plugin to draw team labels with collision detection
        const labelPlugin = {
            afterDatasetsDraw: function(chart) {
                const ctx = chart.ctx;
                const meta = chart.getDatasetMeta(0);
                
                if (!meta.data || meta.data.length === 0) return;
                
                // First pass: calculate initial label positions
                const labels = chart.data.datasets[0].data.map(function(datapoint, index) {
                    const point = meta.data[index];
                    const labelText = datapoint.label || '';
                    
                    ctx.font = 'bold 13px sans-serif';
                    const textMetrics = ctx.measureText(labelText);
                    const textWidth = textMetrics.width;
                    const textHeight = 16;
                    
                    const positions = [
                        { xOffset: 8, yOffset: 18, align: 'left' },
                        { xOffset: 8, yOffset: -8, align: 'left' },
                        { xOffset: -8, yOffset: 18, align: 'right' },
                        { xOffset: -8, yOffset: -8, align: 'right' },
                        { xOffset: 0, yOffset: -20, align: 'center' },
                        { xOffset: 0, yOffset: 28, align: 'center' }
                    ];
                    
                    return {
                        point: point,
                        text: labelText,
                        width: textWidth,
                        height: textHeight,
                        positions: positions,
                        selectedPosition: 0
                    };
                });
                
                function rectanglesOverlap(r1, r2) {
                    return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
                }
                
                function getLabelRect(label, posIndex) {
                    const pos = label.positions[posIndex];
                    const padding = 2;
                    let left;
                    if (pos.align === 'right') {
                        left = label.point.x + pos.xOffset - label.width - padding * 2;
                    } else if (pos.align === 'center') {
                        left = label.point.x + pos.xOffset - label.width / 2 - padding;
                    } else {
                        left = label.point.x + pos.xOffset - padding;
                    }
                    const top = label.point.y + pos.yOffset - label.height + 2;
                    return { left, right: left + label.width + padding * 2, top, bottom: top + label.height, pos };
                }
                
                // Second pass: resolve collisions
                for (let i = 0; i < labels.length; i++) {
                    let foundPosition = false;
                    for (let posIndex = 0; posIndex < labels[i].positions.length && !foundPosition; posIndex++) {
                        const currentRect = getLabelRect(labels[i], posIndex);
                        let hasCollision = false;
                        for (let j = 0; j < i; j++) {
                            const otherRect = getLabelRect(labels[j], labels[j].selectedPosition);
                            if (rectanglesOverlap(currentRect, otherRect)) {
                                hasCollision = true;
                                break;
                            }
                        }
                        if (!hasCollision) {
                            labels[i].selectedPosition = posIndex;
                            foundPosition = true;
                        }
                    }
                    if (!foundPosition) labels[i].selectedPosition = 0;
                }
                
                // Third pass: draw labels
                labels.forEach(function(label) {
                    const pos = label.positions[label.selectedPosition];
                    const rect = getLabelRect(label, label.selectedPosition);
                    
                    ctx.save();
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                    ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
                    ctx.font = 'bold 13px sans-serif';
                    ctx.fillStyle = '#000';
                    ctx.textAlign = pos.align;
                    ctx.fillText(label.text, label.point.x + pos.xOffset, label.point.y + pos.yOffset);
                    ctx.restore();
                });
            }
        };
        
        function updateLeague() {
            const selected = document.querySelector('input[name="league"]:checked').value;
            currentLeague = selected;
            
            if (selected === 'AL') {
                document.getElementById('alStandings').style.display = 'block';
                document.getElementById('nlStandings').style.display = 'none';
            } else {
                document.getElementById('alStandings').style.display = 'none';
                document.getElementById('nlStandings').style.display = 'block';
            }
            
            updateAllCharts();
        }
        
        function switchTab(tabNum) {
            // Hide all tabs
            for (let i = 1; i <= 3; i++) {
                document.getElementById('tab' + i).style.display = 'none';
                document.querySelectorAll('.tab-button')[i - 1].classList.remove('active');
            }
            
            // Show selected tab
            document.getElementById('tab' + tabNum).style.display = 'block';
            document.querySelectorAll('.tab-button')[tabNum - 1].classList.add('active');
        }
        
        function updateAllCharts() {
            updateChart1();
            updateChart2();
            updateChart3();
        }
        
        function calculateIsobar(teams, pythPct) {
            const rs = teams.map(t => t.rsPerGame * t.gamesPlayed);
            const ra = teams.map(t => t.raPerGame * t.gamesPlayed);
            const minR = Math.min(...rs);
            const maxR = Math.max(...rs);
            const minRA = Math.min(...ra);
            const maxRA = Math.max(...ra);
            
            const points = [];
            for (let r = minR - 50; r <= maxR + 50; r += 10) {
                const calcRA = r * Math.sqrt((1 - pythPct) / pythPct);
                if (calcRA >= minRA - 50 && calcRA <= maxRA + 50) {
                    points.push({ x: r, y: calcRA });
                }
            }
            return points;
        }
        
        function updateChart1() {
            const teams = currentLeague === 'AL' ? alData : nlData;
            document.getElementById('graph1Title').textContent = currentLeague + ' - ${season}';
            
            const ctx = document.getElementById('chart1');
            if (chart1) chart1.destroy();
            
            const teamPoints = teams.map(t => ({
                x: t.rs,
                y: t.ra,
                label: t.abbreviation,
                wins: t.w
            }));
            
            const isobar400 = calculateIsobar(teams, 0.400);
            const isobar500 = calculateIsobar(teams, 0.500);
            const isobar600 = calculateIsobar(teams, 0.600);
            
            chart1 = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: 'Teams',
                            data: teamPoints,
                            backgroundColor: '#ef4444',
                            borderColor: '#ef4444',
                            pointRadius: 6,
                            pointHoverRadius: 8
                        },
                        {
                            label: '.400',
                            data: isobar400,
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        },
                        {
                            label: '.500',
                            data: isobar500,
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        },
                        {
                            label: '.600',
                            data: isobar600,
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 1500,
                        easing: 'easeOutQuart'
                    },
                    layout: {
                        padding: { top: 30, right: 50, bottom: 20, left: 20 }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: function(context) {
                                    return context[0].raw.label;
                                },
                                label: function(context) {
                                    return [
                                        'Wins: ' + context.raw.wins,
                                        'RS: ' + context.raw.x,
                                        'RA: ' + context.raw.y
                                    ];
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: { display: true, text: 'Runs Scored', font: { size: 14, weight: 'bold' } },
                            grid: { color: '#e0e0e0' }
                        },
                        y: {
                            title: { display: true, text: 'Runs Allowed', font: { size: 14, weight: 'bold' } },
                            reverse: true,
                            grid: { color: '#e0e0e0' }
                        }
                    }
                },
                plugins: [labelPlugin]
            });
        }
        
        function updateChart2() {
            const teams = currentLeague === 'AL' ? alData : nlData;
            document.getElementById('graph2Title').textContent = currentLeague + ' - ${season}';
            
            const ctx = document.getElementById('chart2');
            if (chart2) chart2.destroy();
            
            const teamPoints = teams.map(t => ({
                x: t.obp,
                y: t.iso,
                label: t.abbreviation,
                rs: t.rs
            }));
            
            // Calculate league averages
            const avgOBP = teams.reduce((sum, t) => sum + t.obp, 0) / teams.length;
            const avgISO = teams.reduce((sum, t) => sum + t.iso, 0) / teams.length;
            
            const minOBP = Math.min(...teams.map(t => t.obp));
            const maxOBP = Math.max(...teams.map(t => t.obp));
            const minISO = Math.min(...teams.map(t => t.iso));
            const maxISO = Math.max(...teams.map(t => t.iso));
            
            chart2 = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: 'Teams',
                            data: teamPoints,
                            backgroundColor: '#3b82f6',
                            borderColor: '#3b82f6',
                            pointRadius: 6,
                            pointHoverRadius: 8
                        },
                        {
                            label: 'Avg OBP',
                            data: [{ x: avgOBP, y: minISO }, { x: avgOBP, y: maxISO }],
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        },
                        {
                            label: 'Avg ISO',
                            data: [{ x: minOBP, y: avgISO }, { x: maxOBP, y: avgISO }],
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 1500,
                        easing: 'easeOutQuart'
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: function(context) {
                                    return context[0].raw.label;
                                },
                                label: function(context) {
                                    return [
                                        'Runs: ' + context.raw.rs,
                                        'OBP: ' + context.raw.x.toFixed(3),
                                        'ISO: ' + context.raw.y.toFixed(3)
                                    ];
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: { display: true, text: 'On-Base Percentage (OBP)', font: { size: 14, weight: 'bold' } },
                            grid: { color: '#e0e0e0' }
                        },
                        y: {
                            title: { display: true, text: 'Isolated Power (ISO)', font: { size: 14, weight: 'bold' } },
                            grid: { color: '#e0e0e0' }
                        }
                    }
                },
                plugins: [labelPlugin]
            });
        }
        
        function updateChart3() {
            const teams = currentLeague === 'AL' ? alData : nlData;
            document.getElementById('graph3Title').textContent = currentLeague + ' - ${season}';
            
            const ctx = document.getElementById('chart3');
            if (chart3) chart3.destroy();
            
            const teamPoints = teams.map(t => ({
                x: t.fip,
                y: t.der,
                label: t.abbreviation,
                ra: t.ra
            }));
            
            // Calculate league averages
            const avgFIP = teams.reduce((sum, t) => sum + t.fip, 0) / teams.length;
            const avgDER = teams.reduce((sum, t) => sum + t.der, 0) / teams.length;
            
            const minFIP = Math.min(...teams.map(t => t.fip));
            const maxFIP = Math.max(...teams.map(t => t.fip));
            const minDER = Math.min(...teams.map(t => t.der));
            const maxDER = Math.max(...teams.map(t => t.der));
            
            chart3 = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: 'Teams',
                            data: teamPoints,
                            backgroundColor: '#10b981',
                            borderColor: '#10b981',
                            pointRadius: 6,
                            pointHoverRadius: 8
                        },
                        {
                            label: 'Avg FIP',
                            data: [{ x: avgFIP, y: minDER }, { x: avgFIP, y: maxDER }],
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        },
                        {
                            label: 'Avg DER',
                            data: [{ x: minFIP, y: avgDER }, { x: maxFIP, y: avgDER }],
                            type: 'line',
                            borderColor: '#888',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            fill: false,
                            showLine: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 1500,
                        easing: 'easeOutQuart'
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: function(context) {
                                    return context[0].raw.label;
                                },
                                label: function(context) {
                                    return [
                                        'Runs Allowed: ' + context.raw.ra,
                                        'FIP: ' + context.raw.x.toFixed(2),
                                        'DER: ' + context.raw.y.toFixed(3)
                                    ];
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: { display: true, text: 'FIP (Fielding Independent Pitching)', font: { size: 14, weight: 'bold' } },
                            reverse: true,
                            grid: { color: '#e0e0e0' }
                        },
                        y: {
                            title: { display: true, text: 'DER (Defensive Efficiency Record)', font: { size: 14, weight: 'bold' } },
                            grid: { color: '#e0e0e0' }
                        }
                    }
                },
                plugins: [labelPlugin]
            });
        }
        
        function downloadChart(chartNum) {
            let chart;
            if (chartNum === 1) chart = chart1;
            else if (chartNum === 2) chart = chart2;
            else if (chartNum === 3) chart = chart3;
            
            if (chart) {
                const url = chart.toBase64Image();
                const link = document.createElement('a');
                link.download = 'baseball-graph-' + chartNum + '.png';
                link.href = url;
                link.click();
            }
        }
        
        // Initialize on page load
        updateAllCharts();
    </script>
</body>
</html>`;
}

generateHTML().catch(console.error);
