// Télécharge les providers compilés depuis le repo Gowaru dans ./providers
// Usage : npm run sync            (providers par défaut)
//         npm run sync -- movix coflix   (liste personnalisée)
const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/providers/';
const DEFAULTS = [
  'movix', 'frenchstream', 'flemmix', 'wookafr',
  'streamzo', 'nakios', 'papadustream', 'dulourd',
];

const list = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
const dir = path.join(__dirname, 'providers');
fs.mkdirSync(dir, { recursive: true });

(async () => {
  let failed = 0;
  for (const id of list) {
    const file = `${id}.js`;
    try {
      const res = await fetch(BASE + file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(path.join(dir, file), await res.text());
      console.log(`OK   ${file}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${file} : ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
