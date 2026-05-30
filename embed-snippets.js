const fs = require('fs');

// Embed What to Know snippet into index.html
const indexHtml = fs.readFileSync('index.html', 'utf8');
const wtkSnippet = fs.existsSync('whats-to-know-snippet.html')
    ? fs.readFileSync('whats-to-know-snippet.html', 'utf8') : null;
fs.writeFileSync('index.html', indexHtml.replace('<!-- WTK_SNIPPET -->', wtkSnippet || ''), 'utf8');
console.log('Embedded whats-to-know-snippet into index.html');

// Embed Box Scores Brief snippet into box-scores.html
const boxHtml = fs.readFileSync('box-scores.html', 'utf8');
const briefSnippet = fs.existsSync('boxscores-brief-snippet.html')
    ? fs.readFileSync('boxscores-brief-snippet.html', 'utf8') : null;
fs.writeFileSync('box-scores.html', boxHtml.replace('<!-- BOXSCORES_BRIEF_SNIPPET -->', briefSnippet || ''), 'utf8');
console.log('Embedded boxscores-brief-snippet into box-scores.html');
