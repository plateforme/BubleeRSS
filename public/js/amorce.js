// Thème, accent et largeur d'index avant le premier rendu, pour éviter le
// flash. Un fichier à part plutôt qu'un script inline : la CSP n'a ainsi
// aucun hash à tenir à jour.
try {
  document.documentElement.dataset.theme = localStorage.getItem('bublee.theme') || 'auto';
  const accent = localStorage.getItem('bublee.accent');
  if (accent) document.documentElement.style.setProperty('--accent', accent);
  const largeur = localStorage.getItem('bublee.indexWidth');
  if (largeur) document.documentElement.style.setProperty('--index-w', largeur + 'px');
  // Posé sur <html> avant le rendu ; app.js le reporte sur .app au démarrage.
  if (localStorage.getItem('bublee.indexPlie') === '1') document.documentElement.dataset.plie = '1';

  // Les réglages de lecture : corps, interligne, largeur de colonne. Comme le
  // thème, ils sont posés avant le premier rendu pour éviter le saut.
  const lecture = JSON.parse(localStorage.getItem('bublee.lecture') || '{}');
  if (lecture.corps) document.documentElement.style.setProperty('--corps', lecture.corps + 'px');
  if (lecture.interligne) document.documentElement.style.setProperty('--interligne', String(lecture.interligne));
  if (lecture.colonne) document.documentElement.style.setProperty('--colonne', lecture.colonne + 'ch');
} catch (e) { /* stockage indisponible : les valeurs par défaut suffisent */ }
