const fs = require('fs');
const p = 'app/dashboard/items/bundles/[id]/edit/page.tsx';
let c = fs.readFileSync(p, 'utf8');
const target = '                          <div className="grid grid-cols-3 gap-2">\r\n                          <div className="space-y-3">';
const replacement = '                          <div className="space-y-3">';
if (c.includes(target)) {
  c = c.replace(target, replacement);
}
fs.writeFileSync(p, c, 'utf8');
console.log('done');
