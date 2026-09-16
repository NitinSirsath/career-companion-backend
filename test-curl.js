fetch('http://localhost:3000/api/gmail/sync', {
  method: 'POST',
  headers: { 'X-Development-User': 'test-user@example.com' }
}).then(async r => console.log(r.status, await r.json()));
