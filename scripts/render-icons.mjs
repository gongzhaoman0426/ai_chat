import { app, BrowserWindow, nativeImage } from 'electron';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const resources = join(root, 'resources');
function mapBitmap(png, map) {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  for (let i = 0; i < buf.length; i += 4) {
    const pixel = map(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    buf[i] = pixel[0];
    buf[i + 1] = pixel[1];
    buf[i + 2] = pixel[2];
    buf[i + 3] = pixel[3];
  }
  return nativeImage.createFromBitmap(buf, { width, height }).toPNG();
}
async function rasterize(svg, size, background = '#ffffff') {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    backgroundColor: background,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;width:${size}px;height:${size}px;background:${background}}
    svg{display:block;width:100%;height:100%}
  </style></head><body>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 80));
  const captured = await win.webContents.capturePage();
  const png = (
    captured.getSize().width === size
      ? captured
      : captured.resize({ width: size, height: size, quality: 'best' })
  ).toPNG();
  win.destroy();
  return png;
}
async function writePng(svg, size, file, kind = 'app') {
  const raw = await rasterize(svg, size, kind === 'template' ? '#ffffff' : '#ff00ff');
  const png = mapBitmap(raw, (b, g, r, a) => {
    if (kind === 'template') {
      const alpha = 255 - Math.round((r + g + b) / 3);
      return [0, 0, 0, alpha];
    }
    if (r > 220 && g < 40 && b > 220) return [0, 0, 0, 0];
    return [b, g, r, a];
  });
  await writeFile(file, png);
}
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const appSvg = (await readFile(join(resources, 'icon.svg'), 'utf8')).replace(
    /width="\d+" height="\d+"/,
    'width="100%" height="100%"',
  );
  const traySvg = (await readFile(join(resources, 'tray-template.svg'), 'utf8')).replace(
    /width="\d+" height="\d+"/,
    'width="100%" height="100%"',
  );
  await writePng(appSvg, 1024, join(resources, 'icon.png'));
  console.log('icon.png');
  await writePng(appSvg, 256, join(resources, 'icon-256.png'));
  await writePng(appSvg, 32, join(resources, 'tray.png'));
  await writePng(appSvg, 64, join(resources, 'tray@2x.png'));
  await writePng(traySvg, 22, join(resources, 'trayTemplate.png'), 'template');
  await writePng(traySvg, 44, join(resources, 'trayTemplate@2x.png'), 'template');
  console.log('tray pngs');
  if (process.platform === 'darwin') {
    const set = join(resources, 'icon.iconset');
    await rm(set, { recursive: true, force: true });
    await mkdir(set);
    const iconset = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ];
    const cache = new Map();
    for (const [size, name] of iconset) {
      if (!cache.has(size)) {
        const raw = await rasterize(appSvg, size, '#ff00ff');
        cache.set(
          size,
          mapBitmap(raw, (b, g, r, a) =>
            r > 220 && g < 40 && b > 220 ? [0, 0, 0, 0] : [b, g, r, a],
          ),
        );
      }
      await writeFile(join(set, name), cache.get(size));
    }
    await exec('iconutil', ['-c', 'icns', set, '-o', join(resources, 'icon.icns')]);
    await rm(set, { recursive: true, force: true });
  }
  await mkdir(join(root, 'apps/desktop/public'), { recursive: true });
  await cp(join(resources, 'icon.svg'), join(root, 'apps/desktop/public/icon.svg'));
  console.log('icons written');
  app.quit();
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  app.exit(1);
});
