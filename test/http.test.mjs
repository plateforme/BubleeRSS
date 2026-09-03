import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { urlPubliqueOuNull, ipPrivee, adressePublique, httpGet } from '../server/http.js';

test('ipPrivee reconnaît les plages privées en IPv4', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(ipPrivee(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1', '93.184.216.34']) {
    assert.equal(ipPrivee(ip), false, ip);
  }
});

test('ipPrivee reconnaît les plages privées en IPv6, IPv4 encapsulée comprise', () => {
  for (const ip of ['::1', '::', 'fd00::1', 'fc00::abcd', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:192.168.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '[::1]']) {
    assert.equal(ipPrivee(ip), true, ip);
  }
  for (const ip of ['2606:4700::1111', '2a00:1450:4007:80e::200e', '::ffff:8.8.8.8']) {
    assert.equal(ipPrivee(ip), false, ip);
  }
  assert.equal(ipPrivee('pas une adresse'), true);
});

test('urlPubliqueOuNull refuse les schémas, les noms locaux et les IP littérales privées', () => {
  for (const u of ['ftp://exemple.fr/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/',
    'http://bureau.local/', 'http://nas.lan/', 'http://127.0.0.1:4321/', 'http://2130706433/', 'http://0x7f000001/',
    'http://127.1/', 'http://0177.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/',
    'http://192.168.1.10/x', 'http://169.254.169.254/latest/meta-data']) {
    assert.equal(urlPubliqueOuNull(u), null, u);
  }
  for (const u of ['https://www.lemonde.fr/rss/une.xml', 'http://93.184.216.34/', 'https://[2606:4700::1111]/']) {
    assert.ok(urlPubliqueOuNull(u), u);
  }
});

test('adressePublique refuse un nom qui résout en privé (ou qu’on ne peut pas résoudre)', async () => {
  // localtest.me résout en 127.0.0.1 ; hors ligne, l'échec de résolution refuse aussi.
  await assert.rejects(adressePublique('http://localtest.me/'), /refusée|introuvable/);
  await assert.rejects(adressePublique('http://127.0.0.1/'), /refusée/);
});

/* Le garde-fou interdit justement 127.0.0.1 : pour éprouver les redirections
   et le plafond sur un serveur local, on injecte un vérificateur qui laisse
   passer ce seul serveur et confie tout le reste au vrai contrôle. */
async function serveurLocal(reponse) {
  const serveur = http.createServer(reponse);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const origine = `http://127.0.0.1:${serveur.address().port}`;
  const verifier = (u) => (String(u).startsWith(origine) ? Promise.resolve(new URL(u)) : adressePublique(u));
  return { serveur, origine, verifier };
}

test('httpGet suit une redirection publique mais refuse une redirection vers le réseau local', async () => {
  const { serveur, origine, verifier } = await serveurLocal((req, res) => {
    if (req.url === '/vers-prive') { res.writeHead(302, { location: 'http://192.168.1.1/admin' }); return res.end(); }
    if (req.url === '/vers-relatif') { res.writeHead(301, { location: '/final' }); return res.end(); }
    if (req.url === '/boucle') { res.writeHead(302, { location: '/boucle' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('arrivé');
  });
  try {
    await assert.rejects(httpGet(origine + '/vers-prive', { verifier }), /refusée/);
    const { res, buffer } = await httpGet(origine + '/vers-relatif', { verifier });
    assert.equal(buffer.toString(), 'arrivé');
    assert.equal(res.url, origine + '/final');
    await assert.rejects(httpGet(origine + '/boucle', { verifier }), /Trop de redirections/);
  } finally {
    serveur.close();
  }
});

test('httpGet coupe un téléchargement qui dépasse le plafond, annoncé ou non', async () => {
  const { serveur, origine, verifier } = await serveurLocal((req, res) => {
    if (req.url === '/annonce') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(5 * 1024 * 1024) });
      return res.end(Buffer.alloc(1024));
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let n = 0;
    const pousser = () => {
      while (n < 64) { n++; if (!res.write(Buffer.alloc(64 * 1024))) return res.once('drain', pousser); }
      res.end();
    };
    pousser();
  });
  try {
    await assert.rejects(httpGet(origine + '/annonce', { verifier, maxBytes: 1024 * 1024 }), /volumineuse/);
    await assert.rejects(httpGet(origine + '/flot', { verifier, maxBytes: 1024 * 1024 }), /volumineuse/);
    const { buffer } = await httpGet(origine + '/flot', { verifier, maxBytes: 8 * 1024 * 1024 });
    assert.equal(buffer.length, 64 * 64 * 1024);
  } finally {
    serveur.close();
  }
});

test('les deux /24 réservés de 192.0 sont refusés, le reste du /16 est public', () => {
  // Le troisième octet compte : sans lui, tout 192.0.0.0/16 était refusé — dont
  // les serveurs de WordPress.com, ce qui rendait injoignables les blogs qui y
  // sont hébergés. Huit sources en portaient l'erreur « adresse du réseau local ».
  for (const ip of ['192.0.0.1', '192.0.0.255', '192.0.2.5']) {
    assert.equal(ipPrivee(ip), true, ip + ' est réservé');
  }
  for (const ip of ['192.0.66.96', '192.0.78.12', '192.0.1.1', '192.0.3.1']) {
    assert.equal(ipPrivee(ip), false, ip + ' est public');
  }
  assert.ok(urlPubliqueOuNull('https://192.0.66.96/feed'), 'une IP publique de WordPress.com passe');
});
