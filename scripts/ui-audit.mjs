import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const appPath = path.join(root, 'frontend', 'app.js');
const cssPath = path.join(root, 'frontend', 'styles.css');
const htmlPath = path.join(root, 'frontend', 'index.html');
const app = fs.readFileSync(appPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const failures = [];

if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(app)) failures.push('frontend/app.js contains unexpected control characters.');

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${result.stderr || result.stdout}`);
}

checkSyntax(appPath);
checkSyntax(path.join(root, 'backend', 'server.js'));

// Every generated image must have accessible text and a local fallback.
for (const match of app.matchAll(/<img\b[^>]*>/g)) {
  const tag = match[0];
  if (!/\balt\s*=/.test(tag)) failures.push(`Image without alt text: ${tag.slice(0, 140)}`);
  if (!/\bdata-fallback-src\s*=/.test(tag)) failures.push(`Image without fallback: ${tag.slice(0, 140)}`);
}

// Check template class names against CSS. Known tokens from template interpolations are ignored.
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]));
const interpolationTokens = new Set(['authMode','c','deliveryType','heroTab','id','key','live','menuOpen','r','restaurant','state','tourismCategory','view']);
const usedClasses = new Set();
for (const match of app.matchAll(/class\s*=\s*["'`]([^"'`]*)/g)) {
  const template = match[1].replace(/\$\{.*?\}/g, ' ');
  for (const token of template.match(/[A-Za-z_][\w-]*/g) || []) usedClasses.add(token);
}
for (const name of usedClasses) {
  if (!cssClasses.has(name) && !interpolationTokens.has(name)) failures.push(`Missing CSS selector for .${name}`);
}

// Basic CSS brace balance catches accidental truncation or unmatched blocks.
let depth = 0;
let quote = null;
let escaped = false;
for (let index = 0; index < css.length; index += 1) {
  const char = css[index];
  if (escaped) { escaped = false; continue; }
  if (quote) {
    if (char === '\\') escaped = true;
    else if (char === quote) quote = null;
    continue;
  }
  if (char === '"' || char === "'") { quote = char; continue; }
  if (char === '{') depth += 1;
  if (char === '}') depth -= 1;
  if (depth < 0) { failures.push('CSS contains an unexpected closing brace.'); break; }
}
if (depth !== 0) failures.push(`CSS has ${depth > 0 ? 'unclosed' : 'extra closing'} brace(s).`);


// Validate every bundled SVG fallback and every explicit local fallback URL.
const assetRoot = path.join(root, 'frontend', 'assets');
function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}
const svgFiles = walkFiles(assetRoot).filter((file) => file.toLowerCase().endsWith('.svg'));
for (const file of svgFiles) {
  const source = fs.readFileSync(file, 'utf8').trim();
  const relative = path.relative(root, file);
  if (!/^<svg(?:\s|>)/i.test(source) || !/<\/svg>\s*$/i.test(source)) {
    failures.push(`${relative}: invalid SVG root element or missing closing tag.`);
  }
  if (/(^|[^#])&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]+;)/i.test(source)) {
    failures.push(`${relative}: SVG contains an unescaped ampersand.`);
  }
}
for (const match of app.matchAll(/data-fallback-src="(\/assets\/[^"]+)"/g)) {
  const asset = path.join(root, 'frontend', match[1].replace(/^\//, ''));
  if (!fs.existsSync(asset)) failures.push(`Missing local image fallback: ${match[1]}`);
}
if (!fs.existsSync(path.join(assetRoot, 'place-fallbacks', 'stays.svg'))) {
  failures.push('Missing Hospitality/stays image fallback artwork.');
}

if (!/name="viewport"/.test(html)) failures.push('The HTML document is missing its responsive viewport meta tag.');
if (!/<title>Kenchain Groups/.test(html)) failures.push('The document title is missing Kenchain Groups.');
if (/^\s*import\s/m.test(app) && !/<script\s+type="module"\s+src="\/app\.js"/.test(html)) failures.push('frontend/app.js uses ES-module imports but index.html does not load it with type=module.');

if (failures.length) {
  console.error(`UI audit failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('UI audit passed: JavaScript syntax, template image alt/fallbacks, template class selectors, CSS brace balance, SVG assets, local fallback references and document metadata.');
}
