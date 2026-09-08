import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tauri ios init 的預設 AppIcon 不等於桌面 icon；建置前明確同步正式資產。
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'src-tauri/icons/ios');
const target = path.join(root, 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset');
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'Contents.json'), 'utf8'));
const names = [...new Set(manifest.images.map(image => image.filename).filter(Boolean))];
if (!names.length) throw new Error('iOS AppIcon manifest 沒有圖示檔案');
const checkOnly = process.argv.includes('--check');
// 完整 preflight 後才複製，來源缺失不留下半套圖示。
for (const name of names) {
  if (path.basename(name) !== name || !name.endsWith('.png')) throw new Error('不合法的 AppIcon 檔名');
  if (!fs.existsSync(path.join(source, name)) || !fs.statSync(path.join(source, name)).isFile()) throw new Error(`缺少正式 iOS 圖示：${name}`);
}
for (const name of names) {
  const from = path.join(source, name);
  const to = path.join(target, name);
  if (!checkOnly) fs.copyFileSync(from, to);
  if (!fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to))) throw new Error(`iOS 圖示尚未同步：${name}`);
}
console.log(`PASS: ${names.length} 個 iOS AppIcon 已與正式 G.A.I 圖示一致`);
