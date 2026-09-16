// Copies the browser builds the renderer loads as classic scripts (see public/index.html).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'public', 'vendor');
const files = [
  ['node_modules/marked/lib/marked.umd.js', 'marked.umd.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
];

fs.mkdirSync(target, { recursive: true });
for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, from), path.join(target, to));
}
console.log(`Copied ${files.length} vendor scripts to public/vendor`);
