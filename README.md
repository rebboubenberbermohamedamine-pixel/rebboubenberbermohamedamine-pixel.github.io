# Parlio – apprendre l'anglais et le français avec l'IA

Application web installable (PWA), sans pub, sans quota et sans abonnement.
Chaque utilisateur colle **sa propre clé d'API** dans ⚙️ Réglages.

## Fonctionnalités

- **Chat avec tuteur IA** : 4 personnages (tutrice, café, entretien d'embauche, voyage). Les réponses s'affichent au fur et à mesure, les fautes sont corrigées (✏️), on peut dicter à la voix et écouter les réponses.
- **Conversation orale avec score** : lisez une phrase à voix haute et obtenez une note mot par mot. 5 phrases intégrées marchent sans clé, et l'IA peut en générer d'autres sur un thème.
- **Leçons et quiz** : grammaire, vocabulaire et lecture adaptés au niveau (A1 à C1), suivis d'un quiz de 5 questions.
- **Progrès** : série de jours, XP, graphique de la semaine, mots appris.
- **Langue maternelle** : arabe, anglais ou français, choisie au premier lancement. Elle sert à l'interface, aux explications, aux corrections et aux traductions. L'arabe s'affiche de droite à gauche.
- **Langue apprise** : anglais ou français, modifiable à tout moment en haut de l'écran.

## Fournisseurs d'IA

| Fournisseur | Coût | Où obtenir une clé |
|---|---|---|
| Google Gemini | Offre gratuite (avec limites) | https://aistudio.google.com/apikey |
| Anthropic Claude | Payant à l'usage (modèle par défaut : `claude-opus-5-5`) | https://platform.claude.com/settings/keys |
| OpenAI | Payant à l'usage | https://platform.openai.com/api-keys |

Le bouton **Charger les modèles** affiche la liste des modèles disponibles pour la clé.

La clé reste dans le navigateur de l'utilisateur (`localStorage`) et n'est envoyée qu'au fournisseur choisi. Il n'y a aucun serveur intermédiaire.

## Tester sur le PC

```bash
npx -y http-server@14.1.1 parlio -p 5173 -c-1
```

Ouvrez ensuite http://localhost:5173. Utilisez Chrome : le micro y fonctionne.

## Mettre en ligne (gratuit)

Le micro et l'installation sur le téléphone exigent une adresse en **https**. Deux options gratuites :

1. **Netlify Drop** : allez sur https://app.netlify.com/drop et glissez-déposez le dossier `parlio`. Vous obtenez une adresse https en quelques secondes.
2. **GitHub Pages** : créez un dépôt, envoyez-y le contenu de `parlio`, puis activez Settings → Pages.

Sur Android, ouvrez l'adresse dans Chrome puis menu ⋮ → **Ajouter à l'écran d'accueil**.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `style.css` | Apparence (thème clair/sombre, mobile) |
| `app.js` | Écrans : chat, oral, leçons, progrès, réglages |
| `ai.js` | Connexion à Gemini, Claude et OpenAI (streaming) |
| `i18n.js` | Textes de l'interface en arabe, anglais et français |
| `sw.js` | Mise en cache pour un démarrage rapide et hors ligne |
| `manifest.webmanifest`, `icons/` | Installation comme une app |

## Limites connues

- La reconnaissance vocale dépend du navigateur : elle marche bien dans Chrome (Android et PC), moins bien ailleurs.
- La note orale compare des mots, pas la prononciation fine des sons.
- Les données (progrès, conversations) restent sur l'appareil : elles ne sont pas synchronisées entre téléphone et PC.
