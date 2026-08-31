import test from 'node:test';
import assert from 'node:assert/strict';
import { estYouTube, contenuVideo } from '../server/youtube.js';
import { parseFeed } from '../server/feed.js';
import { sanitizeHtml } from '../server/html.js';

test('estYouTube reconnait les adresses de la plateforme', () => {
  assert.ok(estYouTube('https://www.youtube.com/@chaine'));
  assert.ok(estYouTube('https://youtu.be/abc123'));
  assert.ok(estYouTube('https://m.youtube.com/watch?v=abc'));
  assert.ok(!estYouTube('https://youtube.com.exemple.fr/piege'));
  assert.ok(!estYouTube('https://vimeo.com/12345'));
});

test('contenuVideo compose un lecteur et met les liens en forme', () => {
  const html = contenuVideo('abc123', 'Une description\navec un saut\n\nEt un lien https://exemple.fr/page');
  assert.ok(html.includes('youtube-nocookie.com/embed/abc123'));
  assert.ok(html.includes('<br>'));
  assert.ok(html.includes('<a href="https://exemple.fr/page">'));
  // Le lecteur survit au nettoyage : l'hote est dans la liste blanche.
  assert.ok(sanitizeHtml(html, 'https://www.youtube.com/').includes('youtube-nocookie.com/embed/abc123'));
});

test('contenuVideo echappe le HTML d une description hostile', () => {
  const html = contenuVideo('abc', '<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

const FLUX_YT = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Une chaîne</title>
  <link rel="alternate" href="https://www.youtube.com/channel/UC0123456789012345678901"/>
  <entry>
    <id>yt:video:VID123</id>
    <yt:videoId>VID123</yt:videoId>
    <title>Le titre de la vidéo</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=VID123"/>
    <author><name>Une chaîne</name></author>
    <published>2026-08-14T15:57:07+00:00</published>
    <media:group>
      <media:title>Le titre de la vidéo</media:title>
      <media:content url="https://www.youtube.com/v/VID123?version=3" type="application/x-shockwave-flash"/>
      <media:thumbnail url="https://i.ytimg.com/vi/VID123/hqdefault.jpg" width="480" height="360"/>
      <media:description>Ce que raconte la vidéo.</media:description>
    </media:group>
  </entry>
</feed>`;

test('parseFeed transforme une vidéo en article lisible', () => {
  const feed = parseFeed(FLUX_YT, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0123456789012345678901');
  assert.equal(feed.title, 'Une chaîne');

  const video = feed.items[0];
  assert.equal(video.title, 'Le titre de la vidéo');
  assert.equal(video.url, 'https://www.youtube.com/watch?v=VID123');
  assert.equal(video.author, 'Une chaîne');
  assert.equal(video.image, 'https://i.ytimg.com/vi/VID123/hqdefault.jpg');
  assert.equal(video.summary, 'Ce que raconte la vidéo.');
  assert.ok(video.content.includes('youtube-nocookie.com/embed/VID123'));
  // Le media:content en Flash ne doit pas être pris pour une illustration.
  assert.ok(!video.image.includes('shockwave'));
});
