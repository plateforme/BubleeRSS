// Compresse les réponses JSON de l'API.
//
// Les fichiers de l'interface partaient déjà compressés (statique.js), mais
// pas les réponses de l'API : /api/state fait cinquante kilo-octets, envoyés
// bruts. Sur un téléphone en cellulaire, c'est le plus gros du temps de
// démarrage. Gzippée, la réponse tombe sous dix kilo-octets.
//
// Gzip plutôt que brotli pour ces réponses-là : elles sont recalculées à
// chaque requête, et gzip compresse en une milliseconde là où brotli, à
// qualité utile, en prend plusieurs. La différence de taille est mince ; la
// différence de CPU par requête ne l'est pas.
import zlib from 'node:zlib';

/** En deçà, l'en-tête de compression coûte plus que ce qu'il économise. */
const SEUIL = 1024;

export function compresserJson(req, res, next) {
  const accepte = req.get('accept-encoding') || '';
  // On préfère gzip (rapide) ; brotli en secours si le client ne prend que lui.
  const encodeur = /\bgzip\b/.test(accepte)
    ? ['gzip', (b) => zlib.gzipSync(b)]
    : /\bbr\b/.test(accepte)
      ? ['br', (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })]
      : null;
  if (!encodeur) return next();

  const envoyer = res.json.bind(res);
  res.json = (corps) => {
    const texte = JSON.stringify(corps);
    if (texte.length < SEUIL) return envoyer(corps);   // trop petit pour valoir le coût

    const [nom, compresser] = encodeur;
    let zip;
    try { zip = compresser(Buffer.from(texte)); } catch { return envoyer(corps); }
    return res
      .set('content-type', 'application/json; charset=utf-8')
      .set('content-encoding', nom)
      .set('vary', 'accept-encoding')
      .set('content-length', String(zip.length))
      .end(zip);
  };
  next();
}
