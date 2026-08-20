// /api/admin-manage-account.js
// Actions privilégiées sur les comptes (changement de mot de passe d'un tiers, suppression Auth).
// Nécessite le SDK Firebase Admin car l'API REST cliente ne permet pas à un admin
// de modifier le compte Auth d'un autre utilisateur.
//
// Variables d'environnement requises sur Vercel :
//   FIREBASE_SERVICE_ACCOUNT  → le JSON complet de la clé de compte de service Firebase (en une seule ligne)
//   FIREBASE_PROJECT_ID       → optionnel, sinon lu dans le JSON de la clé de service

const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant côté serveur.');
  const serviceAccount = JSON.parse(raw);
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { action, requesterIdToken, uid, newPassword } = req.body || {};
    if (!requesterIdToken) return res.status(401).json({ error: 'Authentification requise.' });
    if (!uid) return res.status(400).json({ error: 'uid manquant.' });
    if (!['setPassword', 'delete'].includes(action)) return res.status(400).json({ error: 'Action inconnue.' });

    const app = getAdminApp();
    const auth = admin.auth(app);
    const db = admin.firestore(app);

    // 1. Vérifie l'identité de l'admin qui fait la requête
    let decoded;
    try {
      decoded = await auth.verifyIdToken(requesterIdToken);
    } catch (e) {
      return res.status(401).json({ error: "Session invalide ou expirée, reconnecte-toi." });
    }

    // 2. Vérifie que ce compte a bien le rôle admin dans Firestore
    const requesterDoc = await db.collection('accounts').doc(decoded.uid).get();
    const requesterRole = requesterDoc.exists ? requesterDoc.data().role : null;
    if (requesterRole !== 'admin') {
      return res.status(403).json({ error: 'Seuls les administrateurs peuvent effectuer cette action.' });
    }

    // 3. Effectue l'action demandée
    if (action === 'setPassword') {
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      }
      await auth.updateUser(uid, { password: newPassword });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      if (uid === decoded.uid) return res.status(400).json({ error: 'Impossible de supprimer son propre compte.' });
      await auth.deleteUser(uid);
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    console.error('admin-manage-account error', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur inconnue.' });
  }
};
