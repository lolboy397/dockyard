// Generates the PWA icon set, Apple touch icon, and iOS splash screens from the
// Dockyard brand mark (the cyan "container" glyph used in the UI). Reproducible:
//   node tools/gen-pwa-assets.mjs
// Outputs PNGs into public/icons and public/splash, and prints the matching
// <link rel="apple-touch-startup-image"> tags for index.html.
//
// Requires the dev-only `sharp` dependency.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const BG = '#0A0E16';        // icon background (slightly lifted from the app bg)
const SPLASH_BG = '#05070C'; // matches the app --bg so launch → app is seamless
const ACCENT = '#22D3EE';

// The brand mark in a 0 0 24 24 viewBox (mirrors auth/ui/brand/brand.component).
function mark(size, frac) {
  const k = (size * frac) / 24;
  const t = size / 2 - 12 * k;
  return `<g transform="translate(${t},${t}) scale(${k})">
    <rect x="2" y="4" width="20" height="16" rx="3" fill="${ACCENT}"/>
    <rect x="6" y="9" width="3" height="3" rx="0.5" fill="#04181D"/>
    <rect x="10.5" y="9" width="3" height="3" rx="0.5" fill="#04181D"/>
    <rect x="15" y="9" width="3" height="3" rx="0.5" fill="#04181D"/>
    <rect x="6" y="13.5" width="3" height="3" rx="0.5" fill="#04181D"/>
    <rect x="10.5" y="13.5" width="3" height="3" rx="0.5" fill="#04181D"/>
  </g>`;
}

function standardSvg(s) {
  const r = Math.round(s * 0.22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <rect width="${s}" height="${s}" rx="${r}" fill="${BG}"/>${mark(s, 0.62)}</svg>`;
}

// Maskable: full-bleed background, mark kept inside the ~40%-radius safe zone so
// Android's circle/squircle masks never clip it.
function maskableSvg(s) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <rect width="${s}" height="${s}" fill="${BG}"/>${mark(s, 0.5)}</svg>`;
}

// Apple touch icon: iOS rounds the corners itself, so ship an opaque square.
function appleSvg(s) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <rect width="${s}" height="${s}" fill="${BG}"/>${mark(s, 0.6)}</svg>`;
}

function splashSvg(w, h) {
  const m = Math.min(w, h);
  const markSize = Math.round(m * 0.9);
  const fontSize = Math.round(m * 0.06);
  const t = (w - markSize) / 2;
  // centre the mark a touch above middle, wordmark below it
  const markY = h / 2 - markSize / 2 - fontSize * 0.9;
  const textY = markY + markSize * 0.62 + fontSize * 1.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${SPLASH_BG}"/>
    <g transform="translate(${t},${markY})">${mark(markSize, 0.6)}</g>
    <text x="${w / 2}" y="${textY}" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif"
      font-size="${fontSize}" font-weight="600" fill="#E6EDF6" letter-spacing="${fontSize * 0.04}">Dockyard</text>
  </svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true });

// iPhone + iPad launch sizes: [pxW, pxH, cssW, cssH, dpr, label]
const SPLASH = [
  [750, 1334, 375, 667, 2, 'iphone-8'],
  [828, 1792, 414, 896, 2, 'iphone-11'],
  [1125, 2436, 375, 812, 3, 'iphone-x'],
  [1242, 2688, 414, 896, 3, 'iphone-11-pro-max'],
  [1170, 2532, 390, 844, 3, 'iphone-13'],
  [1284, 2778, 428, 926, 3, 'iphone-14-plus'],
  [1179, 2556, 393, 852, 3, 'iphone-15'],
  [1290, 2796, 430, 932, 3, 'iphone-15-pro-max'],
  [1536, 2048, 768, 1024, 2, 'ipad'],
  [1668, 2388, 834, 1194, 2, 'ipad-pro-11'],
  [2048, 2732, 1024, 1366, 2, 'ipad-pro-12'],
];

async function main() {
  await mkdir(join(pub, 'icons'), { recursive: true });
  await mkdir(join(pub, 'splash'), { recursive: true });

  await png(standardSvg(192)).toFile(join(pub, 'icons', 'icon-192.png'));
  await png(standardSvg(512)).toFile(join(pub, 'icons', 'icon-512.png'));
  await png(maskableSvg(192)).toFile(join(pub, 'icons', 'icon-192-maskable.png'));
  await png(maskableSvg(512)).toFile(join(pub, 'icons', 'icon-512-maskable.png'));
  await png(appleSvg(180)).toFile(join(pub, 'apple-touch-icon.png'));
  console.log('icons: 192/512 + maskable 192/512 + apple-touch-icon (180) written');

  const links = [];
  for (const [w, h, cw, ch, dpr, label] of SPLASH) {
    const file = `splash/${label}-${w}x${h}.png`;
    await png(splashSvg(w, h)).toFile(join(pub, file));
    links.push(
      `  <link rel="apple-touch-startup-image" media="screen and (device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="${file}">`
    );
  }
  console.log(`splash: ${SPLASH.length} launch images written`);

  await writeFile(join(root, 'tools', 'splash-links.html'), links.join('\n') + '\n');
  console.log('splash <link> tags written to tools/splash-links.html');
}

main().catch((e) => { console.error(e); process.exit(1); });
