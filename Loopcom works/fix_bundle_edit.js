const fs = require('fs');
const p = 'app/dashboard/items/bundles/[id]/edit/page.tsx';
let content = fs.readFileSync(p, 'utf8');
const lines = content.split('\n');
const newLines = [];
let skip = false;
for (let i = 0; i < lines.length; i++) {
  if (skip) {
    if (lines[i].includes('</Link>')) { skip = false; }
    continue;
  }
  if (lines[i].includes('<Link href={') && lines[i].includes('bundleId')) {
    newLines.push('        <Button variant="ghost" size="sm" onClick={() => router.back()}>');
    newLines.push('          <ArrowLeft className="mr-2 h-4 w-4" />');
    newLines.push('          Back');
    newLines.push('        </Button>');
    skip = true;
    continue;
  }
  newLines.push(lines[i]);
}
fs.writeFileSync(p, newLines.join('\n'));
console.log('Done - fixed ' + p);
