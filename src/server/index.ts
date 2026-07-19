import { db } from './db/client.js';
import { createApp } from './web/app.js';
import { startCronJobs } from './jobs/cron.js';

const app = createApp(db);
startCronJobs(db);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Silta listening on :${port}`);
});
