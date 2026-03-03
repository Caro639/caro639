// generate-chart.mjs
// Génère assets/langs.svg avec :
//   - un graphe à barres des langages (compté par repo)
//   - un graphe à barres des frameworks détectés via package.json, requirements.txt, pom.xml, etc.

import fs from "fs";
import path from "path";

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;

/** Échappe les caractères spéciaux XML dans une chaîne */
function escXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

if (!USERNAME) {
  console.error("GITHUB_USERNAME non défini");
  process.exit(1);
}

// ─── Mapping frameworks → fichier source + clé de détection ──────────────────

/** @type {Record<string, {file: string, detect: (content: string) => boolean}[]>} */
const FRAMEWORK_RULES = {
  // JavaScript / TypeScript
  React: [{ file: "package.json", detect: (c) => /"react"/.test(c) }],
  "Next.js": [{ file: "package.json", detect: (c) => /"next"/.test(c) }],
  Vue: [{ file: "package.json", detect: (c) => /"vue"/.test(c) }],
  Angular: [
    { file: "package.json", detect: (c) => /"@angular\/core"/.test(c) },
  ],
  Svelte: [{ file: "package.json", detect: (c) => /"svelte"/.test(c) }],
  Nuxt: [{ file: "package.json", detect: (c) => /"nuxt"/.test(c) }],
  Astro: [{ file: "package.json", detect: (c) => /"astro"/.test(c) }],
  Express: [{ file: "package.json", detect: (c) => /"express"/.test(c) }],
  "Nest.js": [
    { file: "package.json", detect: (c) => /"@nestjs\/core"/.test(c) },
  ],
  Vite: [{ file: "package.json", detect: (c) => /"vite"/.test(c) }],
  // Python
  Django: [
    { file: "requirements.txt", detect: (c) => /django/i.test(c) },
    { file: "pyproject.toml", detect: (c) => /django/i.test(c) },
  ],
  Flask: [
    { file: "requirements.txt", detect: (c) => /flask/i.test(c) },
    { file: "pyproject.toml", detect: (c) => /flask/i.test(c) },
  ],
  FastAPI: [
    { file: "requirements.txt", detect: (c) => /fastapi/i.test(c) },
    { file: "pyproject.toml", detect: (c) => /fastapi/i.test(c) },
  ],
  "Scikit-learn": [
    { file: "requirements.txt", detect: (c) => /scikit-learn/i.test(c) },
    { file: "pyproject.toml", detect: (c) => /scikit.learn/i.test(c) },
  ],
  TensorFlow: [
    { file: "requirements.txt", detect: (c) => /tensorflow/i.test(c) },
  ],
  PyTorch: [{ file: "requirements.txt", detect: (c) => /torch/i.test(c) }],
  // Java / Kotlin
  "Spring Boot": [
    { file: "pom.xml", detect: (c) => /spring-boot/i.test(c) },
    { file: "build.gradle", detect: (c) => /spring-boot/i.test(c) },
    { file: "build.gradle.kts", detect: (c) => /spring-boot/i.test(c) },
  ],
  // Ruby
  Rails: [{ file: "Gemfile", detect: (c) => /gem ['"]rails['"]/i.test(c) }],
  // PHP
  Laravel: [
    { file: "composer.json", detect: (c) => /"laravel\/framework"/.test(c) },
  ],
  Symfony: [
    {
      file: "composer.json",
      detect: (c) => /"symfony\/framework-bundle"/.test(c),
    },
  ],
  // Rust
  Actix: [{ file: "Cargo.toml", detect: (c) => /actix/i.test(c) }],
  Axum: [{ file: "Cargo.toml", detect: (c) => /axum/i.test(c) }],
  // .NET
  "ASP.NET Core": [
    { file: "appsettings.json", detect: (c) => /"AllowedHosts"/i.test(c) },
  ],
  Blazor: [
    {
      file: "appsettings.json",
      detect: (c) => /"BlazorOptions"|"Blazor"/i.test(c),
    },
  ],
};

// ─── Utilitaires API GitHub ───────────────────────────────────────────────────

const BASE_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "profile-chart-bot",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function githubGet(url) {
  const res = await fetch(url, { headers: BASE_HEADERS });
  if (!res.ok) return null;
  return res.json();
}

async function githubRawFile(owner, repo, filepath) {
  // Utilise l'endpoint contents pour récupérer le contenu brut
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filepath}`;
  const data = await githubGet(url);
  if (!data || data.encoding !== "base64") return null;
  return Buffer.from(data.content, "base64").toString("utf-8");
}

// ─── Récupération des repos ───────────────────────────────────────────────────

async function fetchAllRepos() {
  let page = 1;
  let all = [];
  while (true) {
    const batch = await githubGet(
      `https://api.github.com/users/${USERNAME}/repos?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
    page++;
  }
  console.log(`${all.length} dépôts récupérés pour ${USERNAME}`);
  return all;
}

// ─── Détection des frameworks pour un repo ───────────────────────────────────

async function detectFrameworks(repo) {
  const detected = new Set();
  const repoName = repo.name;

  // Détection par langue du dépôt (GitHub détecte déjà C#, F#, etc.)
  const DOTNET_LANGS = ["C#", "F#", "Visual Basic"];
  if (DOTNET_LANGS.includes(repo.language)) {
    detected.add(".NET");
  }

  // Grouper les fichiers à tester pour éviter trop de requêtes
  const filesToFetch = new Set();
  for (const rules of Object.values(FRAMEWORK_RULES)) {
    for (const rule of rules) filesToFetch.add(rule.file);
  }

  // Télécharge tous les fichiers en parallèle
  const fileContents = {};
  await Promise.all(
    [...filesToFetch].map(async (file) => {
      const content = await githubRawFile(USERNAME, repoName, file);
      if (content) fileContents[file] = content;
    }),
  );

  // Applique les règles de détection
  for (const [framework, rules] of Object.entries(FRAMEWORK_RULES)) {
    for (const { file, detect } of rules) {
      if (fileContents[file] && detect(fileContents[file])) {
        detected.add(framework);
        break; // un seul match suffit par framework
      }
    }
  }

  return [...detected];
}

// ─── Génération SVG ───────────────────────────────────────────────────────────

const PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ad45c6",
  // "#ec4899",
  "#06b6d4",
  "#84cc16",
  "#f97316",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
];

function colorFor(index) {
  return PALETTE[index % PALETTE.length];
}

/**
 * Génère un bloc SVG "graphique à barres horizontales"
 * @param {string} title
 * @param {[string, number][]} entries  — triées par valeur décroissante
 * @param {number} offsetY  — position verticale de départ
 * @param {number} maxVal   — valeur max (pour normaliser la largeur)
 * @param {number} colorOffset — décalage de palette
 */
function barBlock(title, entries, offsetY, maxVal, colorOffset = 0) {
  const BAR_MAX_W = 280;
  const ROW_H = 28;
  let svg = "";

  svg += `<text x="16" y="${offsetY + 18}" font-size="14" font-weight="bold" fill="#cdd6f4">${escXml(title)}</text>`;

  entries.forEach(([label, value], i) => {
    const y = offsetY + 32 + i * ROW_H;
    const barW = Math.max(4, Math.round((value / maxVal) * BAR_MAX_W));
    const color = colorFor(i + colorOffset);
    const pct = Math.round(
      (value / entries.reduce((s, [, v]) => s + v, 0)) * 100,
    );

    svg += `<rect x="16" y="${y}" width="${barW}" height="18" rx="4" fill="${color}" opacity="0.9"/>`;
    svg += `<text x="${16 + barW + 6}" y="${y + 13}" font-size="11" fill="#a6adc8">${escXml(label)} · ${value} (${pct}%)</text>`;
  });

  return { svg, height: 32 + entries.length * ROW_H + 16 };
}

function generateSVG(langStats, frameworkStats) {
  const langEntries = Object.entries(langStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const fwEntries = Object.entries(frameworkStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const langMax = langEntries[0]?.[1] ?? 1;
  const fwMax = fwEntries[0]?.[1] ?? 1;

  const WIDTH = 440;
  const PADDING = 16;
  const SEPARATOR = 12;

  let currentY = PADDING + 32; // espace pour le titre principal

  const langBlock = barBlock("Langages", langEntries, currentY, langMax, 0);
  currentY += langBlock.height + SEPARATOR;

  const fwBlock =
    fwEntries.length > 0
      ? barBlock("Frameworks & Librairies", fwEntries, currentY, fwMax, 5)
      : {
          svg: `<text x="16" y="${currentY + 18}" font-size="12" fill="#585b70">Aucun framework détecté</text>`,
          height: 32,
        };

  currentY += fwBlock.height + PADDING;
  const HEIGHT = currentY;

  const now = new Date().toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <!-- Fond -->
  <rect width="${WIDTH}" height="${HEIGHT}" rx="12" fill="#1e1e2e"/>
  <!-- Titre -->
  <text x="16" y="28" font-size="16" font-weight="bold" fill="#89b4fa">⚡ Stack — ${escXml(USERNAME)}</text>
  <text x="${WIDTH - 16}" y="28" font-size="10" fill="#585b70" text-anchor="end">màj ${now}</text>
  <!-- Séparateur -->
  <line x1="16" y1="38" x2="${WIDTH - 16}" y2="38" stroke="#313244" stroke-width="1"/>
  <!-- Langages -->
  ${langBlock.svg}
  <!-- Séparateur intermédiaire -->
  <line x1="16" y1="${PADDING + 32 + langBlock.height}" x2="${WIDTH - 16}" y2="${PADDING + 32 + langBlock.height}" stroke="#313244" stroke-width="1" stroke-dasharray="4 4"/>
  <!-- Frameworks -->
  ${fwBlock.svg}
</svg>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const repos = await fetchAllRepos();

  // 1. Compter les langages
  /** @type {Record<string, number>} */
  const langStats = {};
  repos.forEach(({ language }) => {
    if (language) langStats[language] = (langStats[language] || 0) + 1;
  });

  // 2. Détecter les frameworks (en parallèle, max 10 repos à la fois pour éviter le rate-limit)
  /** @type {Record<string, number>} */
  const frameworkStats = {};
  const BATCH = 10;
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((repo) => detectFrameworks(repo)),
    );
    results.forEach((frameworks) => {
      frameworks.forEach((fw) => {
        frameworkStats[fw] = (frameworkStats[fw] || 0) + 1;
      });
    });
    console.log(
      `Frameworks analysés : ${Math.min(i + BATCH, repos.length)}/${repos.length} repos`,
    );
  }

  console.log("Langages :", langStats);
  console.log("Frameworks :", frameworkStats);

  // 3. Générer le SVG
  const svg = generateSVG(langStats, frameworkStats);
  fs.mkdirSync("assets", { recursive: true });
  fs.writeFileSync(path.join("assets", "langs.svg"), svg, "utf-8");
  console.log("✅ assets/langs.svg généré avec succès");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
