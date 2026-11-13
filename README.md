# WebTrad

**Traducteur de webtoons, manhwa, manhua et mangas, 100 % gratuit, 100 % dans le navigateur.**

WebTrad reprend le principe d’[OpenToon](https://www.opentoon.co/#how) (importer un chapitre, choisir sa langue,
lire les bulles traduites), mais sous forme d’**application web** et **sans aucun coût** : pas de compte, pas de
pièces, pas d’abonnement, pas de serveur. L’OCR tourne dans le navigateur et les chapitres restent sur votre appareil.

## Fonctionnalités

| OpenToon (app mobile, payante) | WebTrad (web, gratuit) |
| --- | --- |
| Import par lien de chapitre | Import par liens (page de chapitre ou images directes), avec proxy CORS gratuit optionnel |
| Import d’images | Images, dossiers, archives **.zip / .cbz**, glisser-déposer, **Ctrl+V** |
| Coréen, chinois, japonais, anglais → 50+ langues | **Détection automatique** de la langue d’origine (coréen, japonais vertical inclus, chinois simplifié/traditionnel, anglais, français, espagnol…) → **60+ langues** |
| Traduction IA | Google Traduction (gratuit, sans clé), MyMemory, **traducteur intégré à Chrome/Edge** (hors ligne), ou **votre IA** (Gemini, Groq, OpenRouter en offre gratuite, Ollama / LM Studio en local) |
| Bibliothèque sur l’appareil | Bibliothèque IndexedDB avec recherche, tri et progression de lecture, utilisable **hors ligne** (PWA installable) |
| Lecteur | Lecture **immersive** (la barre s’efface en défilant, revient en remontant ou en touchant l’image), reprise à l’endroit exact, **chapitre suivant / précédent** en fin de chapitre |
| Toucher une bulle pour voir l’original | Oui, plus modes **Original** et **Comparer** (côte à côte) |
| Éditer une bulle | Éditeur complet : texte, retraduction, re-OCR, taille, couleurs, déplacer/redimensionner/ajouter/supprimer des zones |
| — | **Export .cbz** (ou page par page en JPEG) des pages traduites |

## Comment ça marche

1. **Détection des bulles** – les zones claires fermées qui contiennent de « l’encre » sont repérées
   (`src/lib/imageproc.ts`). Chaque bulle est lue séparément, ce qui est bien plus fiable que l’OCR de la page entière.
2. **OCR** – [Tesseract.js](https://github.com/naptha/tesseract.js) (WebAssembly) lit chaque bulle ; le japonais et le
   chinois traditionnel verticaux sont lus avec les modèles `*_vert`. Une seconde passe « texte épars » attrape les
   cartouches de narration et le texte hors bulles (`src/lib/ocr.ts`).
3. **Traduction** – les bulles d’une page sont envoyées ensemble au moteur choisi, avec repli automatique sur un
   autre moteur gratuit en cas d’échec ou de quota atteint (`src/lib/translate/`).
4. **Lettrage** – le texte original est effacé avec la couleur du fond de la bulle et la traduction est mise en page
   pour remplir au mieux l’intérieur de la bulle : taille calée sur le lettrage d’origine, lignes équilibrées (pas de
   mot orphelin en dernière ligne) (`src/lib/layout.ts`). Dans le lecteur, la traduction est une couche HTML
   au-dessus de l’image originale (net à tous les zooms, rien n’est perdu) ; à l’export elle est dessinée dans
   l’image.

**Mode « OCR par IA » (optionnel)** : avec une clé gratuite Google Gemini, le modèle lit *et* traduit chaque page en
une seule requête. C’est nettement meilleur sur les mangas japonais, où Tesseract est moyen.

## Lecture en série

- **Reprise** : la bibliothèque propose de reprendre le chapitre en cours, à l’endroit exact où vous l’avez laissé
  (même au milieu d’une longue page de webtoon), et indique ce qui est lu.
- **Chapitre suivant** : en fin de chapitre, WebTrad propose le chapitre suivant de la même série s’il est déjà dans
  la bibliothèque (« Série – Chapitre 12 » → « Chapitre 13 », d’après les titres). Pour un chapitre importé par lien,
  il propose sinon d’**importer le suivant** : le lien « Suivant » de la page d’origine est mémorisé à l’import (à
  défaut, le numéro de chapitre de l’adresse est incrémenté).
- **Traduction qui ne s’arrête pas** : l’écran reste allumé pendant le traitement, et un traitement interrompu
  (onglet fermé, téléphone verrouillé, navigateur tué en arrière-plan) reprend tout seul à la réouverture, sans
  relire les pages déjà faites. Une page qui fait planter l’appareil deux fois de suite est mise de côté pour ne pas
  bloquer le reste.

## Utilisation

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests unitaires (vitest)
npm run build      # site statique dans dist/
```

## Mise en ligne gratuite

Le résultat de `npm run build` est un simple site statique : il peut être hébergé gratuitement sur GitHub Pages,
Cloudflare Pages, Netlify, Vercel…

**GitHub Pages** (déjà configuré) : dans *Settings → Pages* du dépôt, choisir *Source : GitHub Actions*. Chaque
push sur `main` (ou sur la branche par défaut du dépôt) lance les tests, construit et publie le site (`.github/workflows/deploy.yml`).

## Import par lien

Collez simplement l’adresse d’un chapitre (ou d’images). Les navigateurs interdisent à une page de lire le contenu
d’un autre site sans son accord (CORS) ; WebTrad essaie donc, dans l’ordre :

1. l’accès direct (sites qui l’autorisent) ;
2. votre propre proxy, s’il est configuré (*Réglages → Proxy CORS*) ;
3. des relais publics gratuits : [r.jina.ai](https://jina.ai/reader) pour la page (il exécute aussi le JavaScript,
   donc les images chargées dynamiquement sont trouvées) et [wsrv.nl](https://wsrv.nl) pour les images, puis
   allorigins / codetabs en dernier recours.

Les images du chapitre sont repérées automatiquement (elles partagent le même dossier ; logos, pubs et images
minuscules sont écartés) et le titre est déduit de la page.

L’adresse `…/#/new?url=<adresse du chapitre>` ouvre directement l’import sur ce lien (c’est ce qu’utilise le bouton
« Importer le chapitre suivant »).

Limites : les sites qui exigent une connexion ou bloquent les robots (défi Cloudflare) ne peuvent pas être lus, et
les hébergeurs d’images qui exigent une page d’origine (Naver…) nécessitent votre propre proxy. Le plus simple est
alors de déployer gratuitement `tools/cors-proxy-worker.js` sur Cloudflare Workers et d’indiquer :

```
https://<votre-worker>.workers.dev/?url={url}&referer={referer}
```

## Moteurs IA gratuits (facultatif)

Dans *Réglages → Moteur de traduction → IA*, choisissez un fournisseur compatible OpenAI :

- **Google Gemini** – clé gratuite sur [aistudio.google.com/apikey](https://aistudio.google.com/apikey), lit aussi les
  images (mode OCR par IA) ;
- **Groq**, **OpenRouter** (modèles `:free`) ;
- **Ollama** / **LM Studio** en local (100 % hors ligne ; lancer Ollama avec `OLLAMA_ORIGINS=*`).

La clé est enregistrée uniquement dans votre navigateur et n’est envoyée qu’au fournisseur choisi.

## Confidentialité

- Aucun serveur WebTrad : images, chapitres et réglages restent dans le navigateur (IndexedDB / localStorage).
  WebTrad demande au navigateur un stockage **persistant** pour que la bibliothèque ne soit pas effacée quand
  l’appareil manque de place (*Réglages → Stockage* indique si c’est accordé ; installer l’appli sur l’écran
  d’accueil aide).
- Import par lien : si le site bloque l’accès direct, l’adresse de la page et des images passe par les relais publics
  ci-dessus.
- Seul le **texte** des bulles est envoyé au service de traduction choisi (aucun envoi avec le traducteur intégré de
  Chrome ou un modèle local). En mode « OCR par IA », l’image de la page est envoyée au fournisseur IA.

## Limites connues

- La qualité de l’OCR local est très bonne sur les webtoons/manhwa (texte horizontal net), correcte sur les mangas ;
  les onomatopées dessinées à la main ne sont généralement pas lues.
- L’effacement remplit la zone de texte avec la couleur de fond : parfait dans les bulles unies, plus visible sur du
  texte posé sur un dessin (utilisez *Garder le texte original* ou ajustez la couleur dans l’éditeur).
- Le point d’accès Google Traduction utilisé est public mais non officiel ; en cas de limitation, WebTrad bascule sur
  MyMemory.

Respectez les droits des auteurs : traduisez pour votre usage personnel et soutenez les publications officielles.

## Structure

```
src/
  lib/imageproc.ts     détection des bulles, couleur de fond, zone de texte
  lib/ocr.ts           orchestration Tesseract (bulles, passe éparse, vertical)
  lib/text.ts          regroupement des lignes OCR en bulles, nettoyage
  lib/translate/       Google, MyMemory, traducteur intégré Chrome, IA (OpenAI-compatible)
  lib/layout.ts        mise en page de la traduction (HTML et canvas)
  lib/pipeline.ts      file de traitement des chapitres, reprise après interruption
  lib/keepalive.ts     écran maintenu allumé et verrou entre onglets pendant un traitement
  lib/importers.ts     fichiers, zip/cbz, liens, lien du chapitre suivant
  lib/series.ts        séries et numéros de chapitre d’après les titres
  lib/progress.ts      position et progression de lecture
  lib/exporter.ts      rendu et export .cbz
  components/          interface React (bibliothèque, import, lecteur, éditeur, réglages)
tools/cors-proxy-worker.js   proxy CORS gratuit (Cloudflare Workers)
```

Licence MIT.
