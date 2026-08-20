// /api/ai-structure.js
// Proxy serveur vers l'API Anthropic — transforme un document (texte brut, PDF natif/scanné,
// ou image JPEG/PNG/WEBP/GIF) en procédure Task'in structurée (schéma de blocs).
// La clé API reste côté serveur. Claude lit nativement les PDF et images (OCR/vision inclus),
// donc les scans/photos sont supportés sans extraction de texte préalable.
//
// Variable d'environnement requise sur Vercel : ANTHROPIC_API_KEY

const ALLOWED_FORMATS = ['narrative', 'action_table', 'supplier_guide', 'role_guide', 'hybrid'];
const ALLOWED_BLOCK_TYPES = ['text', 'list', 'callout', 'contact', 'table'];
const ALLOWED_CALLOUT_STYLES = ['info', 'warning', 'important'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const SYSTEM_PROMPT = `Tu es un assistant qui transforme des documents internes (procédures d'agence de voyage) en fiches structurées pour l'outil interne "Task'in" d'OnSpot Travel Solutions.

Le document fourni peut être : du texte brut, un PDF (avec ou sans couche de texte — dans ce cas lis-le comme une image/scan), ou une photo/capture d'écran. Lis attentivement tout le contenu visible, y compris les tableaux, en-têtes, notes manuscrites lisibles et légendes.

Tu dois répondre UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, sans balises markdown \`\`\`, respectant EXACTEMENT ce schéma :

{
  "title": string (titre court et clair de la procédure),
  "category": string (catégorie métier, ex: "Santé & assistance", "Hébergement", "Transport"),
  "format": "narrative" | "action_table" | "supplier_guide" | "role_guide" | "hybrid",
  "description": string (1-2 phrases résumant la procédure),
  "tags": string[] (3 à 6 mots-clés en minuscules),
  "sections": Array<Block>
}

Un Block est un des objets suivants (le champ "type" détermine sa forme) :
- { "type": "text", "content": string }  — paragraphe ou titre. Utilise "**mot**" pour mettre en gras un sous-titre court.
- { "type": "list", "items": string[] }  — liste à puces.
- { "type": "callout", "style": "info" | "warning" | "important", "content": string }  — encart (alerte, note importante).
- { "type": "contact", "entries": [{ "label": string, "value": string }] }  — coordonnées, contacts, numéros utiles.
- { "type": "table", "rows": [{ "type": string, "subject": string, "impact": string, "actionSteps": string, "notes": string }] }  — tableau d'action (situation → sujet → impact → étapes → notes), utilisé pour les procédures de type "que faire si...".

Règles :
- Ne perds AUCUNE information factuelle du document source (numéros, horaires, seuils, conditions).
- Si l'image/le scan est illisible ou trop flou pour être exploité, indique-le clairement dans "description" et fais de ton mieux avec ce qui est lisible.
- Choisis "action_table" comme format si le document liste des situations avec des actions à effectuer (utilise alors des blocs "table").
- Choisis "supplier_guide" pour une fiche fournisseur/prestataire, "role_guide" pour une organisation d'équipe/rôles, "hybrid" si plusieurs types de contenu se mélangent, sinon "narrative".
- N'invente jamais de contact ou de chiffre absent du document source.
- Le JSON doit être strictement valide (pas de virgule finale, guillemets doubles partout).`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { text, fileBase64, mediaType, filename, apiKey: clientApiKey } = req.body || {};

    let userContent;
    if (fileBase64) {
      if (typeof fileBase64 !== 'string' || fileBase64.length < 100) {
        return res.status(400).json({ error: 'Fichier manquant ou invalide.' });
      }
      const introText = `Nom du fichier source : ${filename || 'inconnu'}\n\nTransforme le document ci-joint en procédure structurée selon le schéma demandé.`;
      if (mediaType === 'application/pdf') {
        userContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: introText },
        ];
      } else if (ALLOWED_IMAGE_TYPES.includes(mediaType)) {
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } },
          { type: 'text', text: introText },
        ];
      } else {
        return res.status(400).json({ error: `Type de fichier non supporté : ${mediaType}` });
      }
    } else {
      if (!text || typeof text !== 'string' || text.trim().length < 20) {
        return res.status(400).json({ error: 'Texte manquant ou trop court.' });
      }
      const truncated = text.length > 60000 ? text.slice(0, 60000) : text;
      userContent = `Nom du fichier source : ${filename || 'inconnu'}\n\nTexte brut extrait du document :\n"""\n${truncated}\n"""`;
    }

    const apiKey = (typeof clientApiKey === 'string' && clientApiKey.trim()) || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Aucune clé API configurée. Ajoute-la depuis Documentation → 🔑 Clé API IA (admin), ou définis ANTHROPIC_API_KEY côté serveur." });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error', response.status, errText);
      return res.status(502).json({ error: `Erreur API IA (${response.status}).` });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'Réponse IA vide.' });

    let raw = textBlock.text.trim();
    // Sécurité : au cas où le modèle encapsule quand même dans des balises markdown
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('JSON parse error', e, raw.slice(0, 500));
      return res.status(502).json({ error: "La réponse de l'IA n'était pas un JSON valide." });
    }

    const cleaned = sanitizeProcedure(parsed);
    return res.status(200).json({ procedure: cleaned });
  } catch (e) {
    console.error('ai-structure handler error', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur inconnue.' });
  }
};

function sanitizeProcedure(p) {
  const out = {
    title: str(p.title).slice(0, 200) || 'Procédure sans titre',
    category: str(p.category).slice(0, 100),
    format: ALLOWED_FORMATS.includes(p.format) ? p.format : 'narrative',
    description: str(p.description).slice(0, 500),
    tags: Array.isArray(p.tags) ? p.tags.filter(t => typeof t === 'string').slice(0, 8).map(t => t.toLowerCase().trim()).filter(Boolean) : [],
    sections: Array.isArray(p.sections) ? p.sections.map(sanitizeBlock).filter(Boolean) : [],
  };
  if (out.sections.length === 0) {
    out.sections = [{ type: 'text', content: str(p.description) || 'Contenu à compléter.' }];
  }
  return out;
}

function sanitizeBlock(b) {
  if (!b || !ALLOWED_BLOCK_TYPES.includes(b.type)) return null;
  if (b.type === 'text') return { type: 'text', content: str(b.content) };
  if (b.type === 'list') return { type: 'list', items: Array.isArray(b.items) ? b.items.map(str).filter(Boolean) : [] };
  if (b.type === 'callout') return {
    type: 'callout',
    style: ALLOWED_CALLOUT_STYLES.includes(b.style) ? b.style : 'info',
    content: str(b.content),
  };
  if (b.type === 'contact') return {
    type: 'contact',
    entries: Array.isArray(b.entries) ? b.entries.map(e => ({ label: str(e && e.label), value: str(e && e.value) })).filter(e => e.label || e.value) : [],
  };
  if (b.type === 'table') return {
    type: 'table',
    rows: Array.isArray(b.rows) ? b.rows.map(r => ({
      type: str(r && r.type), subject: str(r && r.subject), impact: str(r && r.impact),
      actionSteps: str(r && r.actionSteps), notes: str(r && r.notes),
    })) : [],
  };
  return null;
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }
