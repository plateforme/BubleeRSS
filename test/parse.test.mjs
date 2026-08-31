import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, toPlainText, firstImage, decodeEntities } from '../server/html.js';
import { parseFeed } from '../server/feed.js';

test('sanitizeHtml enleve les scripts et les gestionnaires inline', () => {
  const out = sanitizeHtml(
    '<p>Salut <script>alert(1)</script><a href="/x" onclick="bad()">lien</a></p>',
    'https://exemple.fr/blog/'
  );
  assert.ok(!out.includes('script'));
  assert.ok(!out.includes('onclick'));
  assert.ok(out.includes('href="https://exemple.fr/x"'));
  assert.ok(out.includes('rel="noopener noreferrer external"'));
});

test('sanitizeHtml resout les images relatives et bloque javascript:', () => {
  const out = sanitizeHtml('<img src="../img/a.png"><img src="javascript:evil()">', 'https://exemple.fr/blog/p/');
  assert.ok(out.includes('src="https://exemple.fr/blog/img/a.png"'));
  assert.equal(out.match(/<img/g).length, 1);
});

test('sanitizeHtml ne garde que les iframes de lecteurs connus', () => {
  const out = sanitizeHtml(
    '<iframe src="https://evil.example/x"></iframe><iframe src="https://www.youtube.com/embed/abc"></iframe>'
  );
  assert.ok(!out.includes('evil.example'));
  assert.ok(out.includes('youtube.com/embed/abc'));
});

test('sanitizeHtml referme les balises laissees ouvertes', () => {
  const out = sanitizeHtml('<div><p>texte');
  assert.equal(out, '<div><p>texte</p></div>');
});

test('decodeEntities gere le nomme et le numerique', () => {
  assert.equal(decodeEntities('caf&eacute; &amp; th&#233; &#x2014; fin'), 'café & thé — fin');
});

test('toPlainText et firstImage', () => {
  assert.equal(toPlainText('<h1>Titre</h1><p>Un&nbsp;texte</p>'), 'Titre Un texte');
  assert.equal(
    firstImage('<img src="/pixel.gif"><img src="/vraie.jpg">', 'https://exemple.fr'),
    'https://exemple.fr/vraie.jpg'
  );
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Le Journal</title>
    <link>https://journal.test/</link>
    <description>Actus</description>
    <item>
      <title>Premier &amp; unique</title>
      <link>https://journal.test/a1</link>
      <guid isPermaLink="false">urn:a1</guid>
      <pubDate>Tue, 05 Mar 2024 10:00:00 +0100</pubDate>
      <dc:creator>Camille</dc:creator>
      <description>Un resume court.</description>
      <content:encoded><![CDATA[<p>Corps complet avec <b>gras</b>.</p>]]></content:encoded>
      <media:content url="https://journal.test/hero.jpg" type="image/jpeg"/>
    </item>
  </channel>
</rss>`;

test('parseFeed lit un flux RSS 2.0', () => {
  const feed = parseFeed(RSS, 'https://journal.test/rss');
  assert.equal(feed.title, 'Le Journal');
  assert.equal(feed.siteUrl, 'https://journal.test/');
  assert.equal(feed.items.length, 1);

  const item = feed.items[0];
  assert.equal(item.title, 'Premier & unique');
  assert.equal(item.guid, 'urn:a1');
  assert.equal(item.url, 'https://journal.test/a1');
  assert.equal(item.author, 'Camille');
  assert.equal(item.image, 'https://journal.test/hero.jpg');
  assert.ok(item.content.includes('<b>gras</b>'));
  assert.equal(new Date(item.published_at).toISOString(), '2024-03-05T09:00:00.000Z');
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Carnet</title>
  <subtitle>Notes</subtitle>
  <link rel="self" href="https://carnet.test/atom"/>
  <link rel="alternate" href="https://carnet.test/"/>
  <entry>
    <title>Une note</title>
    <link rel="alternate" href="https://carnet.test/n/1"/>
    <id>tag:carnet.test,2024:1</id>
    <published>2024-06-01T08:30:00Z</published>
    <author><name>Alex</name></author>
    <content type="html">&lt;p&gt;Contenu &lt;i&gt;riche&lt;/i&gt;.&lt;/p&gt;</content>
  </entry>
</feed>`;

test('parseFeed lit un flux Atom', () => {
  const feed = parseFeed(ATOM, 'https://carnet.test/atom');
  assert.equal(feed.title, 'Carnet');
  assert.equal(feed.siteUrl, 'https://carnet.test/');
  const item = feed.items[0];
  assert.equal(item.title, 'Une note');
  assert.equal(item.url, 'https://carnet.test/n/1');
  assert.equal(item.guid, 'tag:carnet.test,2024:1');
  assert.equal(item.author, 'Alex');
  assert.ok(item.content.includes('<i>riche</i>'));
});

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://vieux.test/">
    <title>Vieux flux</title>
    <link>https://vieux.test/</link>
    <description>RSS 1.0</description>
  </channel>
  <item rdf:about="https://vieux.test/i/9">
    <title>Item RDF</title>
    <link>https://vieux.test/i/9</link>
    <dc:date>2023-11-02T12:00:00+00:00</dc:date>
    <description>Texte.</description>
  </item>
</rdf:RDF>`;

test('parseFeed lit un flux RDF (RSS 1.0)', () => {
  const feed = parseFeed(RDF, 'https://vieux.test/rdf');
  assert.equal(feed.title, 'Vieux flux');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, 'Item RDF');
  assert.equal(feed.items[0].url, 'https://vieux.test/i/9');
});

test('parseFeed refuse un document qui n est pas un flux', () => {
  assert.throws(() => parseFeed('<html><body>coucou</body></html>', 'https://x.test'));
});

test('parseFeed ramene un <link> qui pointe sur le flux vers le domaine', () => {
  const xml = RSS.replace('<link>https://journal.test/</link>', '<link>https://journal.test/rss.xml</link>');
  const feed = parseFeed(xml, 'https://journal.test/rss.xml');
  assert.equal(feed.siteUrl, 'https://journal.test/');
});
