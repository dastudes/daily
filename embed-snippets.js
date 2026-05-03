const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');

const wtkSnippet = fs.existsSync('whats-to-know-snippet.html')
    ? fs.readFileSync('whats-to-know-snippet.html', 'utf8') : null;

const metsSnippet = fs.existsSync('mets-snippet.html')
    ? fs.readFileSync('mets-snippet.html', 'utf8') : null;

let result = html;

result = result.replace(
    '<!-- WTK_SNIPPET -->',
    wtkSnippet || ''
);

result = result.replace(
    '<!-- METS_SNIPPET -->',
    metsSnippet ? `<div class="page-container">${metsSnippet}</div>` : ''
);

fs.writeFileSync('index.html', result, 'utf8');
console.log('Embedded snippets into index.html');
