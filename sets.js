/**
 * sets.js  —  Optional static card catalogue for Pokémon Cards Binder
 * ──────────────────────────────────────────────────────────────
 * Fill this file in if you want the page to work when opened
 * directly from the filesystem (file:// URLs) WITHOUT needing
 * the "Open Folder" button every time.
 *
 * Each key is the SET FOLDER NAME (must match the sub-folder
 * inside pokemon_cards/).  Each value is an array of card
 * objects with three required fields:
 *
 *   number   — card number (integer, used for sorting)
 *   name     — display name
 *   filename — exact filename including extension
 *
 * The app builds the image path as:
 *   pokemon_cards/<setName>/<filename>
 *
 * Example:
 *
 * window.POKEDEX_SETS = {
 *   "base-set": [
 *     { number: 1,  name: "Bulbasaur",  filename: "001_Bulbasaur.jpg"  },
 *     { number: 2,  name: "Ivysaur",    filename: "002_Ivysaur.jpg"    },
 *     { number: 3,  name: "Venusaur",   filename: "003_Venusaur.jpg"   },
 *     // … and so on
 *   ],
 *   "jungle": [
 *     { number: 1, name: "Clefable",  filename: "001_Clefable.jpg"  },
 *     // …
 *   ]
 * };
 *
 * TIP: You can generate this file automatically with the helper
 * script generate-sets.js (Node.js) included in this folder.
 */

// Leave as an empty object {} if you prefer to use the folder-picker instead.
window.POKEDEX_SETS = {};
