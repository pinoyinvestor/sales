// Seed script for meetings - run with: node seed-meetings.mjs
import http from 'http';

const key = 'ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 3210, path, method, headers: { 'x-admin-key': key, 'content-type': 'application/json' } };
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
// Built by Weblease
async function main() {
  const products = await req('GET', '/api/dashboard/products');
  console.log('Products:', Array.isArray(products) ? products.map(p => p.id + ':' + p.name).join(', ') : 'none');
  const pid = Array.isArray(products) && products[0] ? products[0].id : null;

  const m1 = await req('POST', '/api/dashboard/meetings', {
    title: 'WPilot demo för Webbyrå Nord', contact_name: 'Anna Lindström',
    contact_email: 'anna@webbyranord.se', contact_phone: '+46701234567',
    meeting_type: 'video', meeting_url: 'https://meet.google.com/abc-defg-hij',
    date: '2026-03-25', time: '10:00', duration_minutes: 45, product_id: pid,
    notes: 'Intresserad av Pro-versionen, vill se SEO-verktyg'
  });
  console.log('Created:', m1.id, m1.title);

  const m2 = await req('POST', '/api/dashboard/meetings', {
    title: 'Bokvyx onboarding – Salongen', contact_name: 'Erik Johansson',
    contact_email: 'erik@salongen.se', meeting_type: 'phone',
    date: '2026-03-26', time: '14:30', duration_minutes: 30,
    notes: 'Ny kund, behöver genomgång av bokningssystemet'
  });
  console.log('Created:', m2.id, m2.title);

  const m3 = await req('POST', '/api/dashboard/meetings', {
    title: 'La Carta uppföljning', contact_name: 'Maria Svensson',
    contact_email: 'maria@restaurangkungen.se', contact_phone: '+46709876543',
    meeting_type: 'video', meeting_url: 'https://meet.google.com/xyz-uvwx-abc',
    date: '2026-03-27', time: '09:00', duration_minutes: 30,
    notes: 'Uppföljning efter testperiod'
  });
  console.log('Created:', m3.id, m3.title);

  // Confirm m3
  const m3u = await req('PUT', '/api/dashboard/meetings/' + m3.id, { status: 'confirmed' });
  console.log('Confirmed:', m3u.id, m3u.status);

  // Test endpoints
  const all = await req('GET', '/api/dashboard/meetings');
  console.log('All meetings:', Array.isArray(all) ? all.length : 'error');

  const upcoming = await req('GET', '/api/dashboard/meetings/upcoming?days=14');
  console.log('Upcoming:', Array.isArray(upcoming) ? upcoming.length : 'error');

  console.log('Done!');
}

main().catch(e => console.error(e));
