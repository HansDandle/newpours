#!/usr/bin/env node
(async () => {
  try {
    const pa11y = require('pa11y');
    const results = await pa11y('http://localhost:3000', {
      chromeLaunchConfig: {
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
      standard: 'WCAG2AA',
    });
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(2);
  }
})();
