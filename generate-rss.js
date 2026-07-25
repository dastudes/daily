const fs = require('fs');

const SITE_URL = 'https://dastudes.github.io/daily/';
const PAGE_URL = SITE_URL + 'box-scores.html';
const FEED_URL = SITE_URL + 'feed.xml';
const ARCHIVE_FILE = 'briefs-archive.json';
const MAX_ITEMS = 14;

function formatDisplayDate(isoDate) {
    return new Date(isoDate + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
    });
}

function prepareBodyForFeed(html) {
    return html
        .replace(/\s*onclick="expandGame\([^"]*\)"/g, '')
        .replace(/href="#game-/g, `href="${PAGE_URL}#game-`);
}

function cdata(html) {
    return '<![CDATA[' + html.split(']]>').join(']]]]><![CDATA[>') + ']]>';
}

function generateRSS() {
    // Load today's brief body
    let body;
    try {
        body = fs.readFileSync('boxscores-brief-body.html', 'utf8').trim();
    } catch (e) {
        console.log('No boxscores-brief-body.html found — skipping RSS generation');
        return;
    }
    if (!body) {
        console.log('Brief body is empty — skipping RSS generation');
        return;
    }

    const { date } = JSON.parse(fs.readFileSync('boxscore-data.json', 'utf8'));

    // Load archive, upsert today's entry keyed by date
    let archive = [];
    try {
        archive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    } catch (e) {
        console.log('No existing archive — starting fresh');
    }

    const existing = archive.find(entry => entry.date === date);
    const pubDate = existing ? existing.pubDate : new Date().toUTCString();
    archive = archive.filter(entry => entry.date !== date);
    archive.push({ date, pubDate, html: prepareBodyForFeed(body) });

    // Newest first, trim to MAX_ITEMS
    archive.sort((a, b) => b.date.localeCompare(a.date));
    archive = archive.slice(0, MAX_ITEMS);

    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2));
    console.log(`Updated ${ARCHIVE_FILE} (${archive.length} entries)`);

    // Build feed
    const items = archive.map(entry => `    <item>
      <title>Daily Brief — ${formatDisplayDate(entry.date)}</title>
      <link>${PAGE_URL}</link>
      <guid isPermaLink="false">bgd-brief-${entry.date}</guid>
      <pubDate>${entry.pubDate}</pubDate>
      <description>${cdata(entry.html)}</description>
    </item>`).join('\n');

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Baseball Graphs Daily Brief</title>
    <link>${PAGE_URL}</link>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>
    <description>A daily AI-generated summary of MLB results, standings movement, and top performances from Baseball Graphs Daily.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;

    fs.writeFileSync('feed.xml', feed);
    console.log(`Generated feed.xml (${archive.length} items)`);
}

generateRSS();
