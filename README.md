# Bublee

Un lecteur RSS maison, composé comme une première page de journal : index noir,
manchette en serif, grille à filets, angles droits, aucune ombre. Tout ce qui
n'est pas éditorial est en mono capitales. Tout tourne en local, rien ne sort de
la machine à part les requêtes vers les flux eux-mêmes.

<p align="center">
  <img src="docs/magazine.png" width="760"
       alt="La une en thème clair : index sombre, manchette, une plein cadre, colonnes à filets, mur d'images, aplats typographiques">
  <br><em>« La une » en thème clair — la une plein cadre, la rangée de colonnes,
  le mur d'images, les aplats et les plaques typographiques, puis les dépêches.</em>
</p>

<p align="center">
  <img src="docs/sombre.png" width="760"
       alt="La même page en thème sombre : le papier passe à l'encre, l'index reste sombre">
  <br><em>La même page en thème sombre. Le papier et l'encre s'échangent ;
  l'index, lui, était déjà sombre et le reste.</em>
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

Le navigateur s'ouvre sur <http://127.0.0.1:4321>. **Au premier démarrage,
Bublee demande de créer un compte** : le premier devient super-utilisateur et
reprend la bibliothèque déjà en base, s'il y en a une. Ensuite, c'est lui qui
ouvre les comptes suivants — il n'y a pas d'inscription publique.

La base SQLite vit dans `data/bublee.db` — c'est le seul fichier à sauvegarder.
Le cache disque des images, à côté, se reconstruit tout seul.

| Variable            | Défaut      | Effet                                              |
|---------------------|-------------|----------------------------------------------------|
| `PORT`              | `4321`      | port d'écoute                                       |
| `HOST`              | `127.0.0.1` | mettre `0.0.0.0` pour lire depuis le téléphone      |
| `BUBLEE_DATA`       | `./data`    | emplacement de la base                              |
| `BUBLEE_NO_OPEN`    | —           | si défini, n'ouvre pas le navigateur au démarrage   |
| `BUBLEE_IMG_CACHE_MB` | `512`     | plafond du cache disque des images                  |

Le jeton d'API n'est pas une variable d'environnement : il est **personnel**,
un par compte, dans les réglages de chacun.

En conteneur, `/data` est le seul volume à monter :

```bash
docker build -t bublee .
docker run -d --name bublee -p 4321:4321 -v bublee-data:/data bublee
```

Pour lire depuis un autre appareil du réseau :

```bash
HOST=0.0.0.0 npm start
```

## Ce que ça fait

- **Ajouter une source** par l'adresse du flux *ou* simplement celle du site :
  la découverte lit les `<link rel="alternate">` de la page, et à défaut teste
  les chemins classiques (`/feed`, `/rss.xml`, `/atom.xml`…).
- **Importer / exporter en OPML** — l'export Feedly passe tel quel, dossiers compris.
- **Chaînes YouTube, podcasts, Mastodon, Bluesky, Reddit, dépôts GitHub**
  agrégés comme n'importe quelle source : coller le profil suffit.
- **Étiquettes** colorées, posées à la main, interrogeables par l'API.
- **Formats** : RSS 2.0, RSS 1.0 (RDF) et Atom, avec `content:encoded`,
  `media:content`, `dc:creator`, encodages latin-1, ETag / Last-Modified.
- **Texte complet** des articles que le flux ne publie qu'en résumé (voir plus bas).
- **Déduplication** des histoires reprises par plusieurs sources (voir plus bas).
- **L'édition du jour** : une pile finie, composée une fois par jour (voir plus bas).
- **Règles** : un mot dans un titre suffit à écarter un article (voir plus bas).
- **Trois mises en page** : magazine (une + grille), liste, compact.
- **Lecture intégrée** : contenu nettoyé, lettrine, temps de lecture,
  barre de progression, enchaînement vers l'article suivant, corps et colonne
  réglables.
- **Un baladeur** qui survit à la fermeture de l'article, avec reprise et vitesse.
- **Priorité par source**, et un tableau de bord du **débit** qui dit laquelle
  coûte vraiment (voir plus bas).
- **Recherche plein texte** dans le corps des articles, accents ignorés, avec
  le passage qui correspond et le classement par pertinence au choix.
- **Non lus / favoris / recherche**, dossiers renommables et sources rangeables
  à la main, compteurs, rafraîchissement automatique annoncé en direct, purge
  des vieux articles lus (jamais les non-lus, les favoris ni les étiquetés).
- **S'installe sur un écran d'accueil** et se relit **hors ligne**.
- **Thème clair « kiosque » et sombre « encre »**, ou automatique, et **couleur d’accent** au choix.

## Comptes et rôles

<p align="center">
  <img src="docs/connexion.png" width="560"
       alt="L’écran de connexion : la marque, deux champs, un bouton">
  <br><em>La porte. Au tout premier démarrage, elle propose de créer le compte
  qui deviendra super-utilisateur et reprendra la bibliothèque existante.</em>
</p>

Bublee n'avait pas d'authentification : il tournait sur une machine de bureau,
et le contrôle d'accès dispensait tout le réseau privé de jeton. Derrière un
proxy, dont l'adresse est justement privée, cette dispense laissait passer
l'internet entier. Elle a disparu : **l'identité vient de la session ou du
jeton, jamais de l'adresse IP.**

**Deux rôles.** `super` administre les comptes en plus du sien ; `editeur` n'a
que le sien. Pas de troisième rôle en lecture seule : ce serait un cas de plus
à vérifier partout pour un besoin qui n'existe pas.

**Chaque compte possède ses sources**, et les articles en descendent par
cascade. L'alternative — des flux partagés et des abonnements — économiserait
les téléchargements quand deux personnes suivent la même source, mais elle
déplacerait l'état de lecture dans une table à part et ferait dépendre
l'isolation d'un `WHERE user_id` jamais oublié sur quatre-vingts requêtes. Ici
l'isolation est structurelle : supprimer un compte emporte tout ce qui lui
appartient, et la déduplication ne rapproche jamais deux articles de comptes
différents — deux personnes qui suivent Le Monde ont chacune leur exemplaire de
la même dépêche.

**Le premier compte créé devient super** et reprend la bibliothèque d'avant les
comptes. Ensuite, plus d'inscription ouverte : c'est un super qui crée les
comptes. Un formulaire public sur une adresse exposée invite le tout-venant, et
chaque compte coûte du réseau et du CPU réels.

**Les mots de passe** sont dérivés avec scrypt (`N=2¹⁵`), de la bibliothèque
standard : bcrypt et argon2 demandent une compilation native, ce qui rendrait
le déploiement dépendant d'une chaîne de build. Dix caractères minimum, sans
rituel de majuscules et de chiffres — c'est la longueur qui compte.

**Les sessions** durent trente jours et se prolongent à l'usage. Le cookie est
`HttpOnly`, `SameSite=Lax`, et `Secure` dès que la connexion est en HTTPS. La
base ne garde que l'**empreinte** du jeton : une copie de la base ne donne pas
les sessions en cours. Suspendre un compte ferme les siennes immédiatement.

**Garde-fous** : le dernier super ne peut être ni rétrogradé, ni suspendu, ni
supprimé ; un super ne peut pas se retirer à lui-même son rôle ; et changer son
mot de passe exige de connaître l'ancien, sinon une session volée suffirait à
s'approprier le compte pour de bon.

**Le jeton d'API est personnel**, un par compte, révocable sans toucher aux
autres.

<p align="center">
  <img src="docs/comptes.png" width="760"
       alt="La section Comptes des réglages : la liste des comptes avec leur rôle, et le formulaire de création">
  <br><em>Réglages → Comptes. Chaque ligne montre ce que le compte possède
  réellement ; le sien ne peut être ni suspendu ni supprimé depuis là.</em>
</p>

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

**Deux thèmes**, et la bascule dans les réglages : clair, sombre, ou d'après le
système. Le sombre échange le papier et l'encre — mais pas tout. L'index reste
sombre dans les deux : il l'était déjà en clair, c'est sa nature de kiosque.
Et `--paper` ne s'inverse pas non plus : ce jeton ne veut pas dire « fond de
page », il veut dire « encre claire posée sur un fond sombre », et il n'a
aucune raison de foncer parce que la page a foncé. L'avoir inversé une fois
avait retourné les plaques de la une — titres blancs sur fond devenu blanc.

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

Dans les vues d'ensemble — « Non lus », « Tout », « Favoris » —, chaque carte
porte la **pastille de son dossier** : les articles y viennent de partout et
rien d'autre ne dit d'où. Elle disparaît dans un dossier ou sur une source
précise, où elle se répéterait. C'est un contour, pas un aplat : les étiquettes
posées à la main sont pleines, et les deux marques ne doivent pas se confondre —
l'une dit d'où vient l'article, l'autre ce qu'on en a décidé.

Dans l'index, la **pastille de type** distingue les sources : rien pour un
article, un carré rouge à triangle pour une chaîne vidéo, un carré ocre à barres
de niveau pour un podcast.

**Le lecteur se règle à l'œil de chacun** : corps, interligne, largeur de
colonne, dans les réglages. Un lecteur qu'on utilise une heure par jour n'a pas
de raison d'imposer sa mesure. Comme le thème et la largeur de l'index, ça vit
dans le navigateur — c'est un réglage d'écran, pas de compte — et l'amorce le
pose avant le premier rendu, pour qu'aucun texte ne saute une fois affiché.

Un **dossier se renomme** d'un double-clic sur son nom ; lui donner le nom d'un
autre fusionne les deux. Et les **sources se rangent au glissé** dans leur
dossier : celle qu'on lit tous les jours n'a pas à rester en bas parce qu'elle
commence par un W. Tant qu'on n'a touché à rien, l'ordre reste l'alphabet.

L'**index** se replie entièrement — le chevron dans son en-tête, ou <kbd>B</kbd> —
et la scène récupère toute la largeur ; le ☰ de la barre d'outils le ramène.
Replier plutôt que réduire à une barre de pictogrammes : un nom de source ne se
résume pas à une icône, et une demi-mesure ne rendrait presque rien. L'état est
retenu et appliqué avant le premier rendu, comme le thème.

Il se règle aussi à la largeur qu'on veut : une poignée sur son bord droit,
de 240 à 460 px, double-clic pour revenir à 266. Les noms de sources longs ne
sont plus tronqués dès qu'on lui donne une centaine de pixels de plus. La
largeur tient dans le navigateur, pas sur le serveur — c'est un réglage d'écran,
pas de compte, et elle s'applique avant le premier rendu pour éviter le saut.

**Sur un téléphone**, la grille passe à une colonne et l'index devient un
tiroir. Le piège s'y cachait dans une valeur par défaut : `grid-template-columns:
1fr` vaut `minmax(auto, 1fr)`, et ce minimum automatique est la largeur minimale
du contenu. La barre d'outils en réclamait 656 px ; la colonne s'élargissait
d'autant, la fenêtre de rendu avec elle, et toute la page se mettait à défiler
latéralement — sur un écran de 375 px, elle en occupait 638. `minmax(0, 1fr)`
autorise la colonne à descendre sous son contenu, et le débordement disparaît.

La barre elle-même est resserrée pour tenir : « ＋ Source » la quitte, l'ajout
restant à portée par le « + » du kiosque dans l'index. Elle garde un défilement
horizontal comme filet — elle tient entière à 375 px, elle se décale un peu
en dessous plutôt que de casser la page.

Le **lecteur** est un panneau ancré à droite, pas une page plein écran. Il prend
`min(1080px, 100vw − 180px)` : assez large pour une colonne de texte confortable,
en laissant voir la liste par-dessous — cliquer dedans referme, comme `Échap`.
Sous 1100 px la lisière tombe à 72 px, et sous 720 px le panneau prend tout
l'écran : une lisière de 72 px, au doigt, se toucherait par accident.

Au doigt, il se parcourt au **glissé**, puisqu'il occupe tout l'écran : vers la
gauche pour l'article suivant, vers la droite pour revenir au précédent — et,
une fois revenu à celui qu'on avait ouvert depuis la liste, pour refermer. C'est
le geste « retour » du téléphone, et il évite d'aller chercher une croix en haut
de l'écran à chaque article.

**Seul le contenu bouge.** Déplacer le panneau entier découvrait le fond
derrière lui — un écran noir sur le côté — et faisait bouger jusqu'à la barre,
qui n'a aucune raison de suivre le doigt. Le cadre reste donc en place ; c'est
l'article qui glisse, au point près.

Et l'article qu'on quitte est **photographié avant de partir** : sa copie glisse
par-dessus le suivant, déjà rendu en dessous. Les deux se croisent, il n'y a
jamais de trou entre eux — sans cette photographie, le chargement laissait un
vide de quelques dixièmes. Un geste abandonné revient au repos sur un ressort
plutôt que sur un rappel sec.

Un article enchaîné ne rejoue pas l'entrée du panneau : il est déjà là, seul son
contenu change. Et le geste coupe net l'animation d'ouverture — tant qu'elle
court, ses images clés l'emportent sur le style en ligne, et un doigt posé
aussitôt ne déplacerait rien.

Vers la gauche sans article suivant, le panneau résiste comme un élastique au
lieu de promettre un passage qui n'aura pas lieu. Trois garde-fous : sous 70 px c'est une hésitation et rien ne
bouge ; l'horizontale doit l'emporter franchement sur la verticale, sinon un
défilement un peu oblique ferait trembler le panneau ; et un geste parti dans un
tableau ou un bloc de code qui défile déjà horizontalement lui laisse la
priorité.

À cette largeur, son bandeau se déleste pour tenir sur une seule ligne. Partent
la méta — que le titre juste en dessous répète —, « Texte complet » et
« Non lu ». Le premier n'est pas une perte : le texte se récupère tout seul à
l'ouverture, et quand l'extraction échoue le bandeau d'erreur porte son propre
« réessayer ». Le second fait revenir en arrière, ce qui se fait rarement au
doigt. Restent fermer, étiqueter, mettre en favori, ouvrir l'original.

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
- **Une extraction ratée est refusée plutôt qu'affichée.** Readability se trompe
  parfois de bloc et rend la page entière — sur un « bon plan », c'est tout le
  comparateur de prix qui arrive : des centaines de lignes de marchands autour
  de trois paragraphes utiles. Ça se voit au nombre de balises rapporté au
  texte : un paragraphe, c'est une balise pour cent-cinquante caractères ; une
  ligne de comparateur, huit balises pour trente. Sur la bibliothèque réelle,
  tout ce qui était lisible plafonnait à 42 balises par millier de caractères et
  les pages ratées démarraient à 95 — le seuil est posé à 70. Une galerie
  d'architecture monte aussi haut, mais parce qu'elle est faite d'images : on ne
  compte donc que le balisage que les images n'expliquent pas. L'article refusé
  garde son résumé et son lien, ce qui est la bonne réponse pour ces pages.
- `node scripts/purger-extractions.mjs` repasse les textes déjà en base devant
  ce contrôle ; `--purger` efface ceux qui ne passent plus.
- Désactivable dans les réglages.

**Le seuil est global, donc il se trompe.** Une source ne publie jamais qu'un
résumé de vingt lignes ; une autre publie tout et n'a rien à aller chercher.
Chaque source porte donc son propre réglage — *automatique*, *toujours*,
*jamais* — dans « Modifier la source ». En « toujours », le texte est récupéré
juste après le rafraîchissement, par petits paquets : l'ouverture est alors
immédiate au lieu d'attendre un aller-retour chez l'éditeur au moment précis où
l'on veut lire.

## L'édition du jour

« Non lus » a un défaut de nature : son fond se dérobe. On en lit dix, il en
arrive douze, et le compteur monte pendant qu'on travaille. Il n'y a pas de
fin, donc pas de moment où l'on a fini — et une pile sans fin finit par ne plus
appeler du tout.

L'édition est une **pile close** : une quinzaine d'articles choisis une fois
par jour, annoncés avec leur durée — « 15 articles · 19 min » —, et qui ne
bougent plus jusqu'au lendemain.

- Elle **tourne d'une source à l'autre** plutôt que de prendre les plus
  récents. Pris à la file, les quinze articles viendraient des deux sources les
  plus bavardes et l'édition ressemblerait à leur sommaire.
- Une source en **survol** ou **muette** n'y entre pas ; un article **long** y
  entre encore quand l'édition est presque vide, sinon une enquête de quarante
  minutes ne serait jamais choisie.
- Un article **lu y reste** : la pile ne doit pas fondre sous les yeux, sans
  quoi on perdrait le compte de ce qu'on a fait. Le sous-titre dit ce qui reste.

Ce qui n'y est pas n'est pas perdu — tout demeure dans « Tout », dans sa
source, dans la recherche. Ce qui n'y est pas cesse seulement d'appeler.

## Règles

La priorité par source répond au « qui » ; les règles répondent au « quoi ».
Un mot dans un titre suffit à écarter un article **avant qu'il n'apparaisse**.

Le motif est une suite de mots, **tous requis**, dans n'importe quel ordre,
accents et casse ignorés ; « entre guillemets » cherche l'expression exacte.
Rien de ce qu'on tape ne devient une expression régulière : c'est un champ de
saisie, pas un langage. Une règle porte sur le titre, le corps, l'auteur ou
tout, se borne à une source si on veut, et **marque lu**, **étiquette** ou
**met en favori**.

Elles s'appliquent dans la transaction qui insère l'article : il n'existe donc
jamais, même brièvement, sans être passé devant elles.

- **« Essayer »** montre ce qu'une règle attraperait sans rien changer.
- **Poser une règle la rejoue** sur les non-lus d'hier — sinon elle ne servirait
  qu'aux articles à venir, et la corvée resterait sur les bras. Rejouer ne
  défait jamais une lecture déjà faite.
- Chaque règle **compte ce qu'elle a pris**, se suspend et se supprime.

```bash
curl -X POST http://127.0.0.1:4321/api/rules \
  -H 'content-type: application/json' \
  -d '{"motif":"bon plan","champ":"titre","action":"lu"}'
```

## Priorité par source

Le vrai problème d'un agrégateur n'est pas de collecter, c'est le débit. Sur
98 sources il entre ici **225 articles par jour** : la pile de non-lus croît
toute seule, et la rétention ne purge que les articles *lus*. Aucune étiquette
ni aucun partage ne répond à ça — ils servent une fois qu'on a décidé quoi lire.

Chaque source porte donc une priorité, réglable dans « Modifier la source » :

| Priorité | Non lus | Tout | Sa propre vue |
|---|---|---|---|
| **Suivie** (défaut) | oui | oui | oui |
| **Survol** | non, mais dans sa vue « Survol » | oui | oui |
| **Muette** | non | non | oui |

Le principe tient en une phrase : **la priorité ne joue que sur les vues
d'ensemble.** Cliquer une source, ouvrir un dossier, suivre une étiquette ou
chercher, c'est demander explicitement — et on ne cache rien à quelqu'un qui est
allé chercher. Une source muette n'est pas désabonnée : elle continue d'être
collectée, dédupliquée, indexée. Elle cesse seulement d'appeler.

Dans l'index, une source en survol a son compteur en gris ; une source muette a
sa ligne entière estompée, qui se rallume au survol. Une vue « Survol »
apparaît sous les non-lus dès qu'une source y est placée, et disparaît sinon —
pas de ligne morte pour qui ne se sert pas de la fonction.

```bash
curl -X PATCH http://127.0.0.1:4321/api/feeds/17   -H 'content-type: application/json' -d '{"priority":"survol"}'
```

### Le débit, en clair

Le chapitre ci-dessus posait la bonne question et laissait la réponse à
l'intuition : on réglait source par source, sans savoir laquelle coûtait
vraiment. La base savait — reçus, lus, favoris — il suffisait de le montrer.

Les réglages affichent les vingt-cinq sources les plus prolifiques, leur part
lue en barre, leur rythme quotidien. Une source **suivie** qui a beaucoup
publié et qu'on ne lit presque jamais est **proposée en survol**, seule ou
toutes ensemble.

Avec un garde-fou : comparer une source aux autres suppose qu'on lise quelque
part. Sur une bibliothèque à peine ouverte — un import OPML de la veille —
tout paraît ignoré, et proposer d'en mettre les deux tiers en survol serait un
conseil tiré d'un dossier vide. En dessous de quinze pour cent de lecture
globale, Bublee se tait, et dit pourquoi.

## Recherche

La recherche portait sur le titre, le résumé et l'auteur. Elle porte maintenant
sur **le corps entier des articles**, texte complet récupéré compris, via un
index FTS5.

- **Les accents sont ignorés** des deux côtés : `quebec` trouve « Québec ».
- **Le dernier mot est cherché par préfixe**, pour que la liste se resserre
  pendant la frappe et pas au dernier caractère.
- **Rien de ce qu'on tape ne devient un opérateur** : seuls les lettres et les
  chiffres sont extraits, chaque mot est cité, et `AND` tapé par mégarde reste
  le mot « and ».
- **Le balisage n'est pas indexé.** Le corps est nettoyé de son HTML avant de
  l'être — sinon `<img>` et `<span>` deviendraient des mots, et chercher « src »
  remonterait la moitié de la bibliothèque. Le nettoyage est une fonction SQL
  appelée par des déclencheurs, ce qui garantit que l'index ne peut pas dériver
  de la table quel que soit le chemin d'écriture.

L'index se remplit tout seul au premier démarrage qui suit la mise à jour.

**Un résultat montre le passage qui correspond**, le mot en évidence, plutôt
que le chapô de l'article — qui ne disait pas pourquoi il ressortait. Les
marques sont deux caractères de contrôle et non des balises : le navigateur
échappe le texte d'abord et pose le balisage ensuite, sinon un article
contenant `<b>` ouvrirait une balise pour de bon. Et quand la correspondance
est dans le titre, l'extrait le répéterait juste en dessous : on garde alors le
chapô, qui apprend quelque chose.

« Récents / Pertinents », dans la manchette, n'apparaît que pendant une
recherche — le reste du temps il n'y a rien à classer autrement que par date.
La pertinence pèse le titre huit fois le corps.

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

## Couleurs d'attente

Les illustrations n'arrivent pas toutes en même temps, et la grille se
retrouvait trouée de blancs le temps qu'elles se posent. Chaque emplacement
porte donc un fond : **deux teintes moyennes de l'image elle-même**, celle du
haut et celle du bas, en dégradé — soit une version très floue de la photo qui
va s'y poser. L'image arrive ensuite en fondu par-dessus.

Le serveur n'a pas de décodeur d'image, et en ajouter un pour ça serait cher
payé. C'est donc **le navigateur qui mesure**, une seule fois : à la première
image affichée, elle est réduite à 16 × 16 dans un canevas, moyennée par
moitié, et la paire est renvoyée à l'API — qui vérifie le format avant de
l'enregistrer, puisqu'elle vient du client. Tous les affichages suivants, sur
n'importe quel appareil, ont la couleur d'emblée.

Le calcul attend que le navigateur soit libre (`requestIdleCallback`) et ne
tourne que deux à la fois : il ne doit jamais disputer une image de plus au
défilement. Les illustrations passent par `/api/image`, donc même origine — le
canevas n'est pas souillé et reste lisible.

Tant qu'une couleur n'est pas connue, c'est la teinte de la source qui tient la
place. Et si une image ne charge pas du tout, le fond reste : mieux qu'une
icône cassée.

### Le cache disque du relais

Sans lui, chaque affichage d'une vignette repartait chercher l'octet chez
l'éditeur : le fond d'attente restait en place le temps de l'aller-retour, et
on refaisait le trajet dès que le cache du navigateur expirait ou qu'un autre
appareil regardait la même page. Désormais, seule la première vue paie le
voyage.

    1re vue  0,110 s (12 756 o)  →  2e vue  0,024 s   [x-bublee-cache: disque]
    1re vue  0,083 s (10 447 o)  →  2e vue  0,016 s   [x-bublee-cache: disque]

Un fichier par image dans `data/cache-images`, nommé d'après l'**empreinte
SHA-256 de son adresse** — jamais d'après l'adresse elle-même, qui pourrait
sortir du dossier. Le type MIME tient sur la première ligne du fichier : pas
d'index à maintenir, donc pas d'index à désynchroniser. L'écriture passe par un
fichier temporaire puis un renommage, pour qu'une lecture concurrente ne tombe
jamais sur un fichier à moitié écrit.

Le cache est plafonné (512 Mo par défaut, `BUBLEE_IMG_CACHE_MB`). Au-delà, les
entrées les moins récemment lues sont effacées jusqu'à redescendre à 90 % —
pas à 100 %, sinon on rebalaierait au fichier suivant. Le balayage ne tourne
qu'une fois toutes les dix minutes : le déclencher à chaque écriture
reviendrait à lire tout le dossier à chaque vignette. Et la date d'accès n'est
rafraîchie qu'une fois par jour, sinon afficher une page coûterait une écriture
par image.

L'en-tête `x-bublee-cache` dit d'où vient l'octet, `disque` ou `reseau`, et
`/api/health` donne l'état du cache.

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

**Accès.** Il n'y a pas de portée à régler : **personne ne passe sans
s'identifier**, et l'adresse IP ne dispense de rien. Deux façons de le faire —
la session du navigateur, ou le **jeton personnel** du compte, un par compte,
visible dans ses réglages et révocable sans toucher aux autres.

```bash
curl -H "Authorization: Bearer $JETON" http://192.168.1.20:4321/api/articles?view=unread
```

Le jeton ne voyage que dans un en-tête. En paramètre d'adresse il finirait dans
les journaux du serveur, l'historique du navigateur et le `Referer` envoyé aux
éditeurs : cette forme a été retirée.

Une page web tierce peut appeler l'API **avec un jeton** — CORS reflète alors
son origine. Elle ne peut pas le faire avec le cookie de session : l'origine
n'est jamais reflétée pour lui, et une requête venue d'ailleurs qui le
présenterait n'est pas authentifiée.

`GET /api/ping` répond sans compte, et ne dit rien d'autre que « je réponds » :
c'est ce qu'une sonde ou un `HEALTHCHECK` de conteneur peut interroger.

**Routes principales**

| Méthode  | Route                     | Rôle |
|----------|---------------------------|------|
| `GET`    | `/api/state`              | flux, dossiers, compteurs, réglages |
| `GET`    | `/api/articles`           | `view=unread\|all\|starred\|survol\|edition`, `feed`, `folder`, `q`, `tag`, `sort`, `limit`, `before` |
| `GET`    | `/api/articles/:id`       | un article et son contenu |
| `PATCH`  | `/api/articles/:id`       | `{ "read": true }` · `{ "starred": true }` |
| `POST`   | `/api/articles/:id/full`  | récupérer le texte complet (`?force=1`) |
| `POST`   | `/api/articles/read`      | `{ "all": true }` · `{ "feedId": 3 }` · `{ "ids": [1,2] }` · `{ "olderThan": … }` |
| `POST`   | `/api/articles/unread`    | annuler un marquage en masse `{ "stamp": … }` |
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
| `GET`    | `/api/rules`              | les règles de filtrage |
| `POST`   | `/api/rules`              | `{ "motif": "bon plan", "champ": "titre", "action": "lu" }` |
| `POST`   | `/api/rules/essai`        | ce qu'une règle attraperait, sans rien changer |
| `POST`   | `/api/rules/rejouer`      | rejouer les règles sur les non-lus |
| `GET`    | `/api/feeds/stats`        | ce que chaque source apporte ; `?jours=90` |
| `POST`   | `/api/feeds/priorites`    | `{ "ids": [3, 7], "priority": "survol" }` |
| `POST`   | `/api/feeds/ordre`        | l'ordre voulu dans l'index `{ "ids": [...] }` |
| `PATCH`  | `/api/folders/:nom`       | renommer un dossier (fusionne) `{ "name": "…" }` |
| `POST`   | `/api/dedupe`             | rapprocher les doublons (`?rebuild=1`) |
| `POST`   | `/api/opml/import`        | corps = XML OPML |
| `GET`    | `/api/opml/export`        | export OPML |
| `GET`    | `/api/backup`             | une copie cohérente de la base (super) |
| `GET`    | `/api/events`             | ce que le serveur annonce, en direct (SSE) |
| `GET`    | `/api/ping`               | vie du service, sans compte — pour une sonde |

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

## Sur le téléphone, et hors ligne

Bublee **s'installe sur un écran d'accueil** : un manifeste, une icône, le
plein écran. Ce qui compte davantage, c'est ce que le service worker rend
possible — **lire sans réseau**.

Trois régimes, un par nature de ressource :

- **la coquille** — HTML, JavaScript, CSS, polices — est servie du cache et
  rafraîchie derrière : l'application démarre sans réseau ;
- **les articles déjà ouverts et les images du relais** sont gardés au passage,
  et rendus du cache quand le réseau manque ;
- **le reste de l'API n'est jamais mis en cache** : un compteur périmé
  tromperait plus qu'une erreur franche.

**Recevoir un partage.** Une adresse partagée depuis le navigateur du téléphone
arrive sur `/partage` et ouvre « Ajouter une source » pré-remplie — le lien est
cherché dans le champ prévu, puis dans le texte, certaines applications ne
faisant pas la différence. `#/ajouter` fait la même chose en marque-page.

**En direct.** Le rafraîchissement automatique entrait en silence : les
compteurs restaient ceux du chargement. Le serveur pousse maintenant ce qu'il a
à dire par un flux d'évènements. La liste ne se réordonne jamais sous les yeux
de qui lit : un bandeau propose les nouveautés, et c'est le lecteur qui décide
de le suivre.

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

## Partager

Le second pictogramme du coin d'une carte ouvre les destinations : **courriel**,
**WhatsApp**, **Signal**, **Telegram**, **copier le lien** — et, sur les
navigateurs qui la portent, la **feuille de partage du système**, qui donne
accès à tout ce qui est installé sur la machine. Chaque ligne porte son propre
pictogramme : à la lecture rapide, c'est lui qu'on vise, pas le mot.
<kbd>P</kbd> fait la même chose sur l'article au curseur, ou sur celui qu'on est
en train de lire. Sous le titre, dans le lecteur, la même paire de pictogrammes
ferme la ligne des étiquettes.

Rien n'est envoyé par Bublee : chaque destination ouvre sa propre fenêtre de
rédaction, pré-remplie du titre et du lien. C'est toi qui postes. La ligne
« Partager… » n'apparaît que si le navigateur porte vraiment l'API — pas de
bouton qui ne ferait rien.

Signal fait exception : il n'a pas d'adresse web de partage, on passe donc par
le protocole `sgnl://` que l'application installe. S'il n'est enregistré nulle
part, le navigateur ne signale rien — Bublee guette la perte de focus, qui
signe la prise en charge, et prévient si elle ne vient pas. La feuille du
système reste le chemin le plus sûr vers Signal quand elle est disponible.

## Podcasts

Un podcast, c'est un flux RSS. Colle son adresse et Bublee en fait des
articles écoutables : la durée annoncée par le flux (`itunes:duration`)
remplace le temps de lecture, et la carte porte un bouton de lecture. Rien à
récupérer sur la page d'origine : le contenu d'un épisode, c'est son audio.

**Le baladeur est unique et vit en pied de page.** L'épisode vivait d'abord
dans le panneau de lecture, et le fermer coupait le son — exactement ce qu'on
ne veut pas d'une écoute. Il survit maintenant à tout : changer d'article,
revenir à la liste, chercher autre chose. La **position est retenue** par
épisode, ce qui est la moitié de ce qu'on attend d'un baladeur — reprendre une
heure d'entretien là où on l'avait laissée. La vitesse se règle de 1× à 2×, et
les commandes de l'écran verrouillé fonctionnent là où le navigateur les porte.

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

- **Sans ouvrir l'article** : au survol d'une carte, deux pictogrammes
  apparaissent dans son coin — une étiquette et un partage. Le premier ouvre la
  liste des étiquettes : un clic pose ou retire, le champ du bas en crée une.
  <kbd>T</kbd> fait la même chose sur l'article au curseur. Les étiquettes
  posées s'affichent ensuite dans la carte elle-même, dans les trois mises en
  page.
- Le bouton ne se superpose à rien : là où la carte porte déjà une méta à
  droite — la source d'une dépêche, la durée d'un aplat — cette méta s'efface le
  temps du survol et le bouton prend sa place. Rien ne bouge, rien ne se
  chevauche.
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
| `Maj+A` | tout marquer comme lu — le bouton « Tout lire », lui, propose d’abord la portée |
| `G` | changer de mise en page |
| `T` | étiqueter — l’article ouvert, ou celui au curseur dans la liste |
| `P` | partager l’article au curseur |
| `B` | replier ou déplier l’index |
| `/` | rechercher |
| `,` | réglages |
| `?` | aide-mémoire |
| `Échap` | fermer |

## Sous le capot

```
server/
  index.js      écoute, ouverture du navigateur, arrêt propre
  app.js        les routes HTTP — l'application, sans écouter
  store.js      logique métier : flux, articles, texte complet, étiquettes, débit
  doublons.js   rapprochement des copies d'une même histoire
  edition.js    composition de l'édition du jour
  regles.js     motifs, champs, actions ; appliquées à l'insertion
  garde.js      exigeCompte : le contrôle par lequel tout passe
  feed.js       téléchargement et analyse RSS / RDF / Atom, découverte
  plateformes.js Mastodon, Bluesky, Reddit, GitHub : l'adresse du flux devinée
  dedupe.js     normalisation des adresses et des titres
  readable.js   extraction du texte complet (Readability), icône d'un site
  opml.js       import / export OPML
  html.js       nettoyage du HTML des articles
  youtube.js    chaînes YouTube : résolution du flux, lecteur intégré
  http.js       couche réseau commune, garde-fou SSRF, plafond de taille
  vignettes.js  réduction des illustrations (sharp, optionnel)
  cache-images.js  cache disque du relais
  statique.js   les fichiers de l'interface, compressés, servis de la mémoire
  entetes.js    CSP et en-têtes de sécurité
  limiteur.js   les tentatives de connexion, comptées
  evenements.js le flux d'évènements poussés vers la page (SSE)
  apikey.js     jeton d'API, CORS
  comptes.js    comptes, mots de passe, sessions, rôles
  db.js         schéma SQLite et migrations
public/
  index.html · styles.css · manifest.webmanifest · sw.js
  js/etat.js      l'état partagé, la palette, le message passager
  js/cartes.js    les gabarits, la composition de la une, le rendu
  js/couleurs.js  les teintes d'attente, mesurées par le navigateur
  js/baladeur.js  le lecteur audio persistant
  js/glisse.js    le geste du doigt dans le lecteur
  js/app.js       le reste : démarrage, lecteur, réglages, adresse, clavier
  js/{api,util,amorce}.js
scripts/
  icones.mjs      dessine la marque en PNG, sans bibliothèque d'images
  telecharger-polices.mjs   rapatrie les trois familles dans public/fonts
```

Le front est en JavaScript natif (modules ES) : aucune étape de build,
on édite un fichier, on recharge.

Quelques choix à connaître :

- **Le HTML des articles est filtré par liste blanche** (`server/html.js`) :
  scripts, styles, `on*`, `javascript:` sont supprimés ; seules les `<iframe>`
  de lecteurs connus (YouTube, Vimeo, Spotify…) survivent.
- **Les images passent par `/api/image`**, ce qui contourne les protections
  anti-hotlink et évite que les éditeurs voient le lecteur. Elles arrivent à la
  taille où elles seront vues : une tuile de 150 px ne reçoit plus l'original
  de deux mégaoctets. Le redimensionnement demande `sharp`, dépendance
  *optionnelle* — là où il ne s'installe pas, l'original est servi comme avant.
- **Tout ce que le serveur télécharge passe par `httpGet`**, et c'est là que
  vit le garde-fou anti-SSRF : le nom est résolu, la moindre adresse privée
  refuse la requête en IPv4 comme en IPv6, chaque redirection repasse devant le
  contrôle, et le corps est coupé au-delà du plafond. Un flux, une image ou une
  page d'article ne peuvent donc pas faire sonder le réseau local.
- **Aucun script inline**, et une `Content-Security-Policy` qui n'admet que les
  scripts de Bublee, les images du relais et les lecteurs vidéo connus : si une
  charge utile passait un jour à travers le nettoyeur, le navigateur refuserait
  de l'exécuter.
- **Déduplication** sur `(feed_id, guid)` d'abord, puis sur adresse et titre
  normalisés. Un article déjà lu n'est jamais réécrit par une mise à jour du flux.

## Tests

```bash
npm test
```

214 tests : nettoyage HTML — dont trente-cinq charges utiles XSS classiques —,
analyse des trois formats de flux, chaînes YouTube et plateformes, garde-fou
SSRF, routes de l'API et cloisonnement entre comptes, règles de filtrage,
édition du jour, rétention, vignettes, et comportement complet de la
déduplication, y compris les faux positifs rencontrés sur de vrais flux.

```bash
npm run lint
npm run fumee
```

`npm run fumee` lance vraiment Bublee et s'en sert : la porte, l'index, les
trois mises en page, un article qu'on ouvre et qui décompte les non-lus, une
étiquette, la recherche, l'édition, les réglages, une règle, le clavier. Douze
épreuves, aucun réseau — la bibliothèque est semée en base. Il demande
Playwright (`npm i -D playwright && npx playwright install chromium`) ; sans
lui, il le dit et s'arrête sans échouer.
