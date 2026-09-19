const PgBoss = require('pg-boss');

async function main() {
  const boss = new PgBoss(process.env.DATABASE_URL);
  await boss.start();
  
  await boss.send('test-job', { foo: 'bar' });
  
  await boss.work('test-job', async (job) => {
    console.log('Received job argument type:', Array.isArray(job) ? 'array' : 'object');
    console.log('Received job argument length:', Array.isArray(job) ? job.length : 1);
    console.log('Job argument:', JSON.stringify(job, null, 2));
    process.exit(0);
  });
}

main().catch(console.error);
