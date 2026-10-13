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
| Bibliothèque sur l’appareil | Bibliothèque IndexedDB, reprise de lecture, utilisable **hors ligne** (PWA installable) |
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
   pour remplir au mieux l’intérieur de la bulle (`src/lib/layout.ts`). Dans le lecteur, la traduction est une couche
   HTML au-dessus de l’image originale (net à tous les zooms, rien n’est perdu) ; à l’export elle est dessinée dans
   l’image.

**Mode « OCR par IA » (optionnel)** : avec une clé gratuite Google Gemini, le modèle lit *et* traduit chaque page en
une seule requête. C’est nettement meilleur sur les mangas japonais, où Tesseract est moyen.

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

## Import par lien et proxy CORS

Les navigateurs interdisent à une page de lire le contenu d’un autre site sans son accord (CORS). Beaucoup de sites
de webtoons bloquent donc l’import direct. La solution gratuite : déployer votre propre petit proxy sur Cloudflare
Workers (100 000 requêtes/jour offertes) avec `tools/cors-proxy-worker.js`, puis indiquer dans *Réglages → Proxy
CORS* :

```
https://<votre-worker>.workers.dev/?url={url}&referer={referer}
```

Le proxy envoie l’en-tête `Referer` de la page du chapitre, exigé par certains hébergeurs d’images (Naver…). Les
pages qui chargent leurs images uniquement en JavaScript ne peuvent pas être lues ainsi : téléchargez alors les images
et importez-les (ou en .zip/.cbz).

## Moteurs IA gratuits (facultatif)

Dans *Réglages → Moteur de traduction → IA*, choisissez un fournisseur compatible OpenAI :

- **Google Gemini** – clé gratuite sur [aistudio.google.com/apikey](https://aistudio.google.com/apikey), lit aussi les
  images (mode OCR par IA) ;
- **Groq**, **OpenRouter** (modèles `:free`) ;
- **Ollama** / **LM Studio** en local (100 % hors ligne ; lancer Ollama avec `OLLAMA_ORIGINS=*`).

La clé est enregistrée uniquement dans votre navigateur et n’est envoyée qu’au fournisseur choisi.

## Confidentialité

- Aucun serveur WebTrad : images, chapitres et réglages restent dans le navigateur (IndexedDB / localStorage).
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
  lib/pipeline.ts      file de traitement des chapitres
  lib/importers.ts     fichiers, zip/cbz, liens
  lib/exporter.ts      rendu et export .cbz
  components/          interface React (bibliothèque, import, lecteur, éditeur, réglages)
tools/cors-proxy-worker.js   proxy CORS gratuit (Cloudflare Workers)
```

Licence MIT.
