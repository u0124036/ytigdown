// 部署前把 index.html 頁尾的版本號 +1（vNN -> vNN+1）。
// 用法：node scripts/bump-version.cjs [--check]
//   --check 只印出目前版本，不修改檔案。
const fs = require('fs');

const FILE = 'index.html';
const PATTERN = /(· v)(\d+)(?=<\/div>)/g;

const html = fs.readFileSync(FILE, 'utf8');
const matches = [...html.matchAll(PATTERN)];

if (matches.length !== 1) {
  console.error(`預期在 ${FILE} 找到 1 個版本號，實際找到 ${matches.length} 個。`);
  console.error('請確認頁尾格式仍是「· vNN</div>」，或先修正重複的版本號。');
  process.exit(1);
}

const current = Number(matches[0][2]);

if (process.argv.includes('--check')) {
  console.log(`v${current}`);
  process.exit(0);
}

const next = current + 1;
fs.writeFileSync(FILE, html.replace(PATTERN, `$1${next}`));
console.log(`v${current} -> v${next}`);
