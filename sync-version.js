const fs = require('fs');
const version = require('./package.json').version;
let content = fs.readFileSync('src/twitch-autodrops.user.js', 'utf8');
content = content.replace(/@version\s+[0-9]+\.[0-9]+\.[0-9]+/, `@version      ${version}`);
fs.writeFileSync('src/twitch-autodrops.user.js', content);
console.log(`✅ Synced @version to ${version}`);