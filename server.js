'use strict';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13+ is required (built-in SQLite). Current: ${process.version}`);
  process.exit(1);
}

const app = require('./src/app');
const config = require('./src/config');

app.listen(config.port, () => {
  console.log(`${config.siteNameEn} listening on ${config.siteUrl} (port ${config.port}, payments: ${config.payment.mode})`);
});
