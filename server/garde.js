// Le garde du cloisonnement.
//
// Tout ce qui touche a la bibliotheque prend le compte en premier argument, et
// commence par passer ici. Une fonction qui oublierait de le faire manipulerait
// les articles de tout le monde : mieux vaut que la verification soit un seul
// endroit, nomme, que l'on retrouve d'un coup d'oeil.
//
// Les taches du service — rafraichissement, purge — ne prennent pas de compte
// et traversent legitimement tous les comptes ; elles n'appellent donc pas ce
// garde, et c'est visible a leur signature.

export const now = () => Date.now();

export function exigeCompte(u) {
  const id = Number(u);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('Compte manquant : opération refusée.'), { status: 401 });
  }
  return id;
}
