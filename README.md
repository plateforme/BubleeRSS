# Bublee

Un lecteur RSS maison, composé comme une première page de journal : index noir,
manchette en serif, grille à filets, angles droits, aucune ombre. Tout ce qui
n'est pas éditorial est en mono capitales. Tout tourne en local, rien ne sort de
la machine à part les requêtes vers les flux eux-mêmes.

<p align="center">
  <img src="docs/magazine.png" width="760"
       alt="La une : index noir, manchette, une plein cadre, colonnes à filets, mur d'images, aplats typographiques">
  <br><em>« La une » — la une plein cadre, la rangée de colonnes, le mur d'images,
  les aplats et les plaques typographiques, puis les dépêches.</em>
</p>

<p align="center">
  <img src="docs/lecteur.png" width="760"
       alt="Le lecteur en panneau : la liste reste visible à gauche, bandeau d'ouverture, étiquettes colorées, lettrine">
  <br><em>Le lecteur s'ouvre en panneau : la liste reste là, un clic à côté referme.
  Aeon ne publie qu'un résumé de 27 mots — l'étiquette « texte complet » signale
  les 4 100 mots lus sur la page d'origine.</em>
</p>

<p align="center">
  <img src="docs/video.png" width="760"
       alt="Une vidéo de chaîne YouTube, lecteur intégré">
  <br><em>Une chaîne YouTube arrive comme n'importe quelle source, avec son lecteur.</em>
</p>

<p align="center">
  <img src="docs/reglages.png" width="760"
       alt="Les réglages : choix de la couleur d'accent parmi quatre">
  <br><em>La couleur d'accent se choisit dans les réglages : forêt, vermillon, Klein, magenta.</em>
</p>

## Démarrer

```bash
npm install
npm start
```

Le navigateur s'ouvre sur <http://127.0.0.1:4321>. La base SQLite vit dans
`data/bublee.db` — c'est le seul fichier à sauvegarder.

| Variable            | Défaut      | Effet                                              |
|---------------------|-------------|----------------------------------------------------|
| `PORT`              | `4321`      | port d'écoute                                       |
| `HOST`              | `127.0.0.1` | mettre `0.0.0.0` pour lire depuis le téléphone      |
| `BUBLEE_DATA`       | `./data`    | emplacement de la base                              |
| `BUBLEE_AUTH`       | `lan`       | portée de l'API : `lan`, `strict` ou `off`          |
| `BUBLEE_TOKEN`      | —           | impose un jeton d'API au lieu de celui généré       |
| `BUBLEE_NO_OPEN`    | —           | si défini, n'ouvre pas le navigateur au démarrage   |

Pour lire depuis un autre appareil du réseau :

```bash
HOST=0.0.0.0 npm start
```

## Ce que ça fait

- **Ajouter une source** par l'adresse du flux *ou* simplement celle du site :
  la découverte lit les `<link rel="alternate">` de la page, et à défaut teste
  les chemins classiques (`/feed`, `/rss.xml`, `/atom.xml`…).
- **Importer / exporter en OPML** — l'export Feedly passe tel quel, dossiers compris.
- **Chaînes YouTube et podcasts** agrégés comme n'importe quelle source, avec
  leur lecteur intégré (voir plus bas).
- **Étiquettes** colorées, posées à la main, interrogeables par l'API.
- **Formats** : RSS 2.0, RSS 1.0 (RDF) et Atom, avec `content:encoded`,
  `media:content`, `dc:creator`, encodages latin-1, ETag / Last-Modified.
- **Texte complet** des articles que le flux ne publie qu'en résumé (voir plus bas).
- **Déduplication** des histoires reprises par plusieurs sources (voir plus bas).
- **Trois mises en page** : magazine (une + grille), liste, compact.
- **Lecture intégrée** : contenu nettoyé, lettrine, temps de lecture,
  barre de progression, enchaînement vers l'article suivant.
- **Non lus / favoris / recherche**, dossiers, compteurs, rafraîchissement
  automatique, purge des vieux articles lus (jamais les non-lus ni les favoris).
- **Thème clair « kiosque » et sombre « encre »**, ou automatique, et **couleur d’accent** au choix.

## Le dessin

Trois familles, et une règle : **aucun texte d'interface n'est en sans-serif.**

| Rôle | Famille |
|---|---|
| Manchettes, titres, monogrammes, lettrine | **Instrument Serif** |
| Corps de texte, chapôs, titres de dépêches | **Newsreader** |
| Méta, surtitres, boutons, compteurs, heures | **IBM Plex Mono**, capitales |

`border-radius: 0` partout, aucune ombre, aucun flou : la hiérarchie tient aux
filets et aux aplats.

La **marque** est la seule exception, et c'est ce qui la rend reconnaissable :
deux bulles qui se recouvrent, tracées au même filet que le reste de la page,
l'intersection remplie à l'accent. Ce sont les seules courbes de toute
l'interface. Le dessin dit aussi ce que fait l'app — deux sources qui se
croisent, le recoupement mis en valeur plutôt que subi. Cliquer le logo
ramène aux non-lus.

Les noirs sont **chauds et jamais purs** : l'encre est `#24231f`, l'index
`#302e2a`, le fond des blocs photo `#1b1a17`. Un aplat noir franc contre le
papier crème donnait 15,7:1 à la lisière — une arête qui fatigue sur une page
qu'on lit longtemps. On est à 10,5:1, très au-dessus du seuil AAA (7:1), et
les gris de l'index ont monté d'autant pour garder le même rapport sur un
fond éclairci. L'**accent** est une variable unique — tampon de la une,
surtitres, filet qui se dessine au survol, pastilles de non-lu, lettrine, jauge
de lecture. Quatre valeurs au choix dans les réglages : forêt `#10604a` (par
défaut), vermillon `#e2452a`, Klein `#1b3fd8`, magenta `#d81e73`.

Chaque source reçoit une **teinte** stable parmi six (plus deux neutres), tirée
du hachage de son titre. Elle sert à trois endroits : la barre de 3 px dans
l'index, le monogramme quand il n'y a pas de favicon, et le fond des plaques.

Trois mises en page, indépendantes de la vue :

- **La une** — une plein cadre, rangée de quatre colonnes séparées par des filets
  verticaux, mur d'images, aplats de couleur et plaques typographiques, dépêches
  en fin de page. Le rythme se répète à mesure qu'on descend.
- **Sommaire** — entrées numérotées, vignette de 150 × 104.
- **Dépêches** — lignes denses ; le survol inverse la ligne en encre, c'est le
  seul renversement de la page et il sert de curseur.

Dans l'index, la **pastille de type** distingue les sources : rien pour un
article, un carré rouge à triangle pour une chaîne vidéo, un carré ocre à barres
de niveau pour un podcast.

Le **lecteur** est un panneau ancré à droite, pas une page plein écran. Il prend
`min(1080px, 100vw − 180px)` : assez large pour une colonne de texte confortable,
en laissant voir la liste par-dessous — cliquer dedans referme, comme `Échap`.
Sous 1100 px la lisière tombe à 72 px, et sous 720 px le panneau prend tout
l'écran : une lisière de 72 px, au doigt, se toucherait par accident.

## Texte complet

Beaucoup d'éditeurs ne diffusent qu'un résumé dans leur flux. À l'ouverture
d'un article jugé tronqué (moins de 250 mots, réglable), Bublee va lire la
page d'origine, en extrait l'article avec Readability, le renettoie et le
garde en base : les fois suivantes, l'affichage est instantané.

- Le résumé du flux s'affiche tout de suite ; le texte complet le remplace
  dès qu'il arrive. Un bandeau signale l'opération.
- <kbd>F</kbd> (ou le bouton de la barre de lecture) force la récupération,
  même sur un article que Bublee n'estimait pas tronqué.
- Un site qui refuse la lecture automatique (Cloudflare, mur payant) affiche
  la raison et le lien vers l'original. L'échec n'est pas retenté avant 24 h.
- Désactivable dans les réglages.

## Déduplication

C'est le point qui pose problème sur Feedly : la même histoire revient trois
fois parce que trois sources la relaient, ou parce que l'éditeur a republié
son article avec un nouvel identifiant.

Deux articles sont rapprochés quand :

1. **leur adresse normalisée est identique** — schéma, `www`, fragment,
   paramètres de tracking (`utm_*`, `fbclid`, `xtor`…), variantes AMP et
   mobiles, `index.html` et barre oblique finale sont ignorés ;
2. **ou** leur **titre normalisé** est identique — sans accents, sans
   ponctuation, sans le nom du site collé en fin de titre — à condition que
   le titre fasse au moins 30 caractères et que les deux publications soient
   séparées de moins de 36 heures.

Deux garde-fous, appris sur de vrais flux :

- une adresse **sans chemin** (`https://exemple.fr/`) n'identifie rien : de
  nombreux podcasts mettent la racine du site sur chaque épisode. Elle est
  ignorée ;
- à l'intérieur d'**un même flux**, une adresse commune ne suffit pas : le
  titre doit concorder, sinon ce sont deux entrées distinctes.

Ce qui en découle :

- l'exemplaire le plus ancien fait référence, les copies lui sont rattachées ;
- hors d'un flux précis, une histoire n'apparaît **qu'une fois** ; en ouvrant
  un flux, sa liste reste complète ;
- lire, mettre en favori ou tout marquer comme lu **s'applique au groupe** :
  aucune copie ne ressort ailleurs comme non lue ;
- le lecteur indique « Aussi publié par… » quand plusieurs sources la portent.

Sur une base déjà remplie (import OPML), le rapprochement est lancé au
premier démarrage. Pour le rejouer :

```bash
curl -X POST 'http://127.0.0.1:4321/api/dedupe?rebuild=1'
```

## Illustrations

Une carte de magazine sans image fait un trou. Bublee cherche l'illustration
dans cet ordre :

1. `media:content`, `media:thumbnail`, `enclosure`, `itunes:image` — y compris
   quand le flux **ne déclare pas** que la pièce jointe est une image, ce qui
   est fréquent (ArchDaily, par exemple, envoie une `<enclosure>` nue) ;
2. la première image du contenu, hors pixels de suivi ;
3. à défaut, l'`og:image` de la page de l'article, cherchée en tâche de fond
   après chaque rafraîchissement, par paquets, et une seule fois par article.

Les images passent ensuite par le relais local, ce qui contourne les
protections anti-hotlink. Il reste des cas sans issue : un site qui répond 403
aux robots (le New York Times, par exemple) ne livrera ni image ni texte.
La carte reçoit alors une **plaque typographique** : l'initiale de l'article
en gros serif débordant du cadre, le nom de la source en petites capitales,
et une teinte propre à chaque source. Une composition, pas un trou.

## Sources injoignables

Un export Feedly ancien contient des adresses mortes. « Réparer les sources
injoignables », dans les réglages, interroge pour chacune la page du site,
puis le domaine, puis l'ancienne adresse (qui redirige parfois).

Un remplacement n'est appliqué **automatiquement** que si le titre du flux
trouvé concorde vraiment avec l'ancien. Sinon Bublee se contente de proposer,
avec un pourcentage de ressemblance et un bouton « Adopter » : un site
n'expose souvent que son flux général, et remplacer en silence
« Pitchfork — Best New Tracks » par « Pitchfork » serait pire que de laisser
la source cassée. Chaque candidat est téléchargé et analysé avant d'être
proposé, et l'ancienne adresse est restaurée si le nouveau flux ne répond pas.

L'adresse reste modifiable à la main dans la fiche de la source.

## API

Tout ce que fait l'interface passe par une API REST en JSON, utilisable
depuis un script, un raccourci ou un autre service.

```bash
curl http://127.0.0.1:4321/api          # la liste des routes
curl http://127.0.0.1:4321/api/health   # état et compteurs
```

**Accès.** Un jeton est généré au premier démarrage et affiché dans la console
(et dans `GET /api/token` depuis la machine locale). `BUBLEE_AUTH` règle la portée :

| Valeur   | Qui passe sans jeton                    |
|----------|------------------------------------------|
| `lan`    | machine locale **et** réseau privé (défaut) |
| `strict` | machine locale seulement                 |
| `off`    | tout le monde                            |

Depuis l'extérieur :

```bash
curl -H "Authorization: Bearer $BUBLEE_TOKEN" http://192.168.1.20:4321/api/articles?view=unread
```

CORS est ouvert (avec le jeton), donc une page web tierce peut appeler l'API.

**Routes principales**

| Méthode  | Route                     | Rôle |
|----------|---------------------------|------|
| `GET`    | `/api/state`              | flux, dossiers, compteurs, réglages |
| `GET`    | `/api/articles`           | `view=unread\|all\|starred`, `feed`, `folder`, `q`, `limit`, `before` |
| `GET`    | `/api/articles/:id`       | un article et son contenu |
| `PATCH`  | `/api/articles/:id`       | `{ "read": true }` · `{ "starred": true }` |
| `POST`   | `/api/articles/:id/full`  | récupérer le texte complet (`?force=1`) |
| `POST`   | `/api/articles/read`      | `{ "all": true }` · `{ "feedId": 3 }` · `{ "ids": [1,2] }` |
| `POST`   | `/api/feeds`              | `{ "url": "…", "folder": "…" }` |
| `DELETE` | `/api/feeds/:id`          | supprimer une source |
| `POST`   | `/api/refresh`            | rafraîchir toutes les sources |
| `POST`   | `/api/feeds/repair`       | chercher l'adresse des sources injoignables |
| `POST`   | `/api/feeds/:id/repair`   | chercher pour une source ; `{ "url": "…" }` adopte une proposition |
| `POST`   | `/api/articles/images`    | chercher les illustrations manquantes |
| `GET`    | `/api/tags`               | étiquettes, teintes, nombre d'articles |
| `POST`   | `/api/tags`               | créer une étiquette `{ "name": "…" }` |
| `POST`   | `/api/articles/:id/tags`  | `{ "add": [...] }` · `{ "remove": [...] }` · `{ "set": [...] }` |
| `PATCH`  | `/api/tags/:id`           | renommer (fusionne) ou reteindre `{ name?, color? }` |
| `DELETE` | `/api/tags/:id`           | supprimer une étiquette |
| `POST`   | `/api/dedupe`             | rapprocher les doublons (`?rebuild=1`) |
| `POST`   | `/api/opml/import`        | corps = XML OPML |
| `GET`    | `/api/opml/export`        | export OPML |

Exemples :

```bash
# les dix derniers non lus, en une ligne par titre
curl -s 'http://127.0.0.1:4321/api/articles?view=unread&limit=10' \
  | jq -r '.articles[] | "\(.feed_title) — \(.title)"'
```

```bash
# ajouter une source dans un dossier
curl -s -X POST http://127.0.0.1:4321/api/feeds \
  -H 'content-type: application/json' \
  -d '{"url":"korben.info","folder":"Tech"}'
```

## Chaînes YouTube

YouTube n'affiche plus de bouton RSS, mais publie toujours un flux Atom par
chaîne et par liste de lecture. Colle n'importe quelle adresse YouTube dans
« Ajouter une source » — Bublee retrouve le flux :

| Ce que tu colles | Ce que Bublee en fait |
|---|---|
| `youtube.com/@monsieurphi` | lit la page pour trouver l'identifiant de chaîne |
| `youtube.com/channel/UC…` | conversion directe, sans requête |
| `youtube.com/playlist?list=…` | flux de la liste de lecture |
| `youtube.com/watch?v=…` | remonte à la chaîne de la vidéo |

Les vidéos arrivent comme les articles : miniature, titre, auteur, date,
description. La carte porte un bouton de lecture, et le lecteur intègre le
player YouTube — en `youtube-nocookie.com`, sans quitter Bublee. Les liens et
les chapitres de la description restent cliquables. Ni temps de lecture ni
récupération de texte complet sur une vidéo : ça n'aurait pas de sens.

## Podcasts

Un podcast, c'est un flux RSS. Colle son adresse et Bublee en fait des
articles écoutables : le lecteur audio ouvre le contenu, la durée annoncée
par le flux (`itunes:duration`) remplace le temps de lecture, et la carte
porte un bouton de lecture. Rien à récupérer sur la page d'origine : le
contenu d'un épisode, c'est son audio.

Où trouver l'adresse : la plupart des podcasts publient leur flux RSS sur
leur propre site. Pour ceux hébergés ailleurs, Apple Podcasts, Podcast Addict
ou [getrssfeed.com](https://getrssfeed.com) donnent l'adresse à partir du lien
de l'émission.

**Spotify est un cas à part.** La plateforme ne publie pas de flux RSS pour
les émissions qu'elle héberge, et ses exclusivités n'existent nulle part
ailleurs — aucun lecteur tiers ne peut les récupérer. En revanche l'immense
majorité des podcasts *diffusés sur* Spotify ont un flux public : c'est
celui-là qu'il faut donner à Bublee.

## Étiquettes

Poser une étiquette sur un article, c'est le retrouver ensuite — dans
l'interface comme par l'API.

- Dans le lecteur, sous le titre : les étiquettes de l'article, chacune
  retirable, et un champ pour en ajouter (<kbd>T</kbd> y place le curseur).
  Plusieurs d'un coup en les séparant par des virgules.
- Dans la colonne de gauche, la section **Étiquettes** liste les tiennes avec
  leur nombre d'articles ; un clic filtre. Le crayon ouvre le gestionnaire :
  renommer, reteindre, supprimer, ou créer une étiquette vide.
- Chaque étiquette porte une **teinte** parmi huit, attribuée à la création et
  modifiable. Elle sert de repère dans la liste comme dans le lecteur.
- Renommer une étiquette avec le nom d'une autre **fusionne** les deux.
- Les variantes de casse et d'espacement retrouvent l'étiquette existante au
  lieu d'en créer une jumelle.
- Comme la lecture et les favoris, une étiquette s'applique au **groupe de
  doublons** : l'article reste retrouvable quelle que soit la source par
  laquelle on l'a lu.

Par l'API :

```bash
# étiqueter
curl -X POST http://127.0.0.1:4321/api/articles/482/tags \
  -H 'content-type: application/json' \
  -d '{"add":["veille IA","à lire"]}'

# tout ce qui porte une étiquette
curl -s 'http://127.0.0.1:4321/api/articles?view=all&tag=veille%20IA' | jq -r '.articles[].title'

# les deux à la fois (et non l'une ou l'autre)
curl -s 'http://127.0.0.1:4321/api/articles?view=all&tag=veille%20IA,à%20lire'
```

Quatre adresses directes, utiles en marque-page : `#/article/482` ouvre un
article, `#/tags` le gestionnaire d'étiquettes, `#/reglages` les préférences,
`#/shortcuts` l'aide-mémoire.

## Raccourcis clavier

<kbd>?</kbd> à tout moment ouvre l'aide-mémoire, aussi accessible par l'icône
de clavier en bas de la colonne de gauche.

| Touche | Action |
|--------|--------|
| `J` / `K` | article suivant / précédent |
| `1` `2` `3` | vues Non lus / Tout / Favoris |
| `Entrée` ou `O` | ouvrir |
| `M` | lu / non lu |
| `S` | favori |
| `V` | ouvrir l'article original |
| `F` | forcer le texte complet |
| `R` | rafraîchir |
| `A` | ajouter une source |
| `Maj+A` | tout marquer comme lu |
| `G` | changer de mise en page |
| `T` | étiqueter l’article ouvert |
| `/` | rechercher |
| `,` | réglages |
| `?` | aide-mémoire |
| `Échap` | fermer |

## Sous le capot

```
server/
  index.js    routes HTTP, rafraîchissement périodique, relais d'images
  store.js    logique métier : flux, articles, doublons, texte complet
  feed.js     téléchargement et analyse RSS / RDF / Atom, découverte
  dedupe.js   normalisation des adresses et des titres
  readable.js extraction du texte complet (Readability)
  opml.js     import / export OPML
  html.js     nettoyage du HTML des articles
  youtube.js  chaînes YouTube : résolution du flux, lecteur intégré
  http.js     couche réseau commune, garde-fous SSRF
  apikey.js   jeton d'API, portée réseau, CORS
  db.js       schéma SQLite et migrations
public/
  index.html · styles.css · js/{app,api,util}.js
```

Le front est en JavaScript natif (modules ES) : aucune étape de build,
on édite un fichier, on recharge.

Quelques choix à connaître :

- **Le HTML des articles est filtré par liste blanche** (`server/html.js`) :
  scripts, styles, `on*`, `javascript:` sont supprimés ; seules les `<iframe>`
  de lecteurs connus (YouTube, Vimeo, Spotify…) survivent.
- **Les images passent par `/api/image`**, ce qui contourne les protections
  anti-hotlink et évite que les éditeurs voient le lecteur. Le relais refuse
  les adresses privées (anti-SSRF), tout comme l'extraction de texte.
- **Déduplication** sur `(feed_id, guid)` d'abord, puis sur adresse et titre
  normalisés. Un article déjà lu n'est jamais réécrit par une mise à jour du flux.

## Tests

```bash
npm test
```

47 tests : nettoyage HTML, analyse des trois formats de flux, chaînes
YouTube et podcasts, normalisation des clés de comparaison, étiquettes, et
comportement complet de la déduplication — y compris les faux positifs
rencontrés sur de vrais flux.
