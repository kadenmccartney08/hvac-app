const config = require('./config');
const db = require('./db/db');
const app = require('./app');

async function start() {
  await db.initDb();
  app.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
