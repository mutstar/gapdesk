import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, readdir, unlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const frontend = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(frontend, '../..');
const dist = path.join(frontend, 'dist');
const assets = path.join(dist, 'assets');
const fromApp = createRequire(path.join(project, 'package.json'));
const esbuild = fromApp('esbuild');
const postcss = fromApp('postcss');
const tailwind = fromApp('@tailwindcss/postcss');

const result = await esbuild.build({
  absWorkingDir: project,
  entryPoints: [path.join(frontend, 'entry.tsx')],
  jsx: 'automatic',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
  define: {'process.env.NODE_ENV': '"production"'},
  plugins: [{
    name: 'gapdesk-seoul-collector-labels',
    setup(build) {
      build.onLoad({filter: /[\\/]app[\\/]page\.tsx$/}, async ({path: filename}) => {
        let contents = await readFile(filename, 'utf8');
        const labels = [
          ["snapshot?.mode||'이번 스캔'", "snapshot?.mode?.replace(/^PC (?=30초 수집|연속 수집)/,'서울 GCP ')||'이번 스캔'"],
        ];
        for (const [original, replacement] of labels) {
          if (!contents.includes(original)) throw new Error('Collector label changed upstream: ' + original);
          contents = contents.replace(original, replacement);
        }
        return {contents, loader: 'tsx', resolveDir: path.dirname(filename)};
      });
    },
  }],
});
const globals = path.join(project, 'app', 'globals.css');
const css = await postcss([tailwind({base: project})]).process(await readFile(globals, 'utf8'), {from: globals});
const style = await esbuild.transform(css.css, {loader: 'css', minify: true, target: 'es2022'});

await mkdir(assets, {recursive: true});
async function asset(contents, extension) {
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const name = 'gapdesk-' + hash + '.' + extension;
  await writeFile(path.join(assets, name), contents);
  return name;
}
const scriptName = await asset(result.outputFiles[0].contents, 'js');
const styleName = await asset(style.code, 'css');
for (const name of ['favicon.svg', 'mark.png', 'pekora-chart.webp']) {
  await copyFile(path.join(project, 'public', name), path.join(dist, name));
}
await writeFile(path.join(dist, 'index.html'), `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="이동 경로와 거래 비용을 확인하는 멀티토큰 아비트라지 스캐너">
  <title>Gapdesk · 아비트라지 스캐너</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/assets/${styleName}">
  <script type="module" src="/assets/${scriptName}"></script>
</head>
<body><div id="gapdesk"></div></body>
</html>
`);
for (const name of await readdir(assets)) {
  if (/^gapdesk-[0-9a-f]{16}\.(?:js|css)$/.test(name) && ![scriptName, styleName].includes(name)) {
    await unlink(path.join(assets, name));
  }
}
console.log(dist);
