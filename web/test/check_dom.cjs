/*
 * Static wiring check: every DOM id / class selector used by app.js must exist
 * in index.html. Catches typo'd hooks without needing a browser.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const grab = (re, s, g = 1) => {
  const out = new Set();
  let m;
  while ((m = re.exec(s))) out.add(m[g]);
  return out;
};

const ids = grab(/\$\('#([A-Za-z0-9_-]+)'\)/g, app);
const classes = grab(/querySelectorAll\('\.([A-Za-z0-9_-]+)'\)/g, app);

const htmlIds = grab(/id="([A-Za-z0-9_-]+)"/g, html);
// flatten class="a b c" into a single set
const classSet = new Set();
const reCls = /class="([^"]+)"/g;
let mc;
while ((mc = reCls.exec(html))) mc[1].split(/\s+/).forEach((c) => classSet.add(c));

const missingIds = [...ids].filter((i) => !htmlIds.has(i));
const missingCls = [...classes].filter((c) => !classSet.has(c));

console.log('ids referenced by app.js   :', ids.size);
console.log('ids defined in index.html  :', htmlIds.size);
console.log('classes queried by app.js  :', [...classes].join(', ') || '(none)');
console.log('');
console.log(missingIds.length ? 'FAIL missing ids     : ' + missingIds.join(', ')
                              : 'PASS every referenced id exists');
console.log(missingCls.length ? 'FAIL missing classes : ' + missingCls.join(', ')
                              : 'PASS every queried class exists');

// panel names used in tab switching
const tabs = grab(/data-tab="([A-Za-z0-9_-]+)"/g, html);
console.log('');
console.log('tabs declared:', [...tabs].join(', '));
const missingPanels = [...tabs].filter((t) => !htmlIds.has(t));
console.log(missingPanels.length ? 'FAIL missing panels: ' + missingPanels.join(', ')
                                 : 'PASS each tab has a matching panel');

process.exit(missingIds.length || missingCls.length || missingPanels.length ? 1 : 0);
