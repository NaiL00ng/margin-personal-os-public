// Zero-dependency local packaging. Reads exactly the six listed sources and
// writes only prototype.html beside this script. It never executes app code,
// installs packages, starts a server, or makes a network request.
import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('.', import.meta.url);
const filenames = ['index.html', 'style.css', 'model.js', 'effects.js', 'storage.js', 'app.js'];
const contents = await Promise.all(filenames.map(async filename => {
  const content = await readFile(new URL(filename, directory), 'utf8');
  if (!content.trim()) throw new Error('源文件为空，构建已停止：' + filename);
  return content;
}));
const sources = Object.fromEntries(filenames.map((filename, index) => [filename, contents[index]]));

function replaceExactlyOnce(document, expected, replacement) {
  const count = document.split(expected).length - 1;
  if (count !== 1) {
    throw new Error('预期引用必须完全匹配且只出现一次，实际出现 ' + count + ' 次：' + expected);
  }
  // A function replacement preserves literal dollar signs in CSS and JavaScript.
  return document.replace(expected, () => replacement);
}

function inlineScript(source) {
  // HTML recognizes closing script tags even inside JS strings/comments.
  // Escape the slash while preserving the original case and JS string value.
  return source.replace(/<\/script/gi, match => '<\\/' + match.slice(2));
}

let output = sources['index.html'];
if (/<\/style/i.test(sources['style.css'])) {
  throw new Error('样式包含 style 结束标签，无法安全内联；构建已停止。');
}
output = replaceExactlyOnce(output, '<link rel="stylesheet" href="style.css">', '<style>\n' + sources['style.css'] + '\n</style>');

const scripts = ['model.js', 'effects.js', 'storage.js', 'app.js'];
for (const filename of scripts) {
  output = replaceExactlyOnce(output, '<script src="' + filename + '" defer></script>', '');
}
if (/<script\b[^>]*\bsrc\s*=/i.test(output) || /<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(output)) {
  throw new Error('仍存在未打包的脚本或样式引用，构建已停止。');
}

// Inline classic scripts ignore defer, so place them after the rendered DOM.
// Preserve model -> effects -> app execution order without wrappers or eval.
const bundle = scripts.map(filename => '<script>\n/* Bundled from ' + filename + ' */\n' + inlineScript(sources[filename]) + '\n</script>').join('\n');
output = replaceExactlyOnce(output, '</body>', bundle + '\n</body>');

// All inputs and required markers have been checked before touching the output.
const destination = new URL('prototype.html', directory);
await writeFile(destination, output, 'utf8');
console.log('已生成 prototype.html（' + Buffer.byteLength(output, 'utf8') + ' 字节）；未修改源文件。');
