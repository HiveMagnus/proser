import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Use the compiler's own AST and emit pipeline. Only module specifiers are
 * rewritten; prose strings, builtins and source/declaration maps are preserved. */
export function compileProject(configFile) {
  const configPath = path.resolve(configFile);
  const directory = path.dirname(configPath);
  const parsedFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const diagnostics = parsedFile.error ? [parsedFile.error] : [];
  const config = ts.parseJsonConfigFileContent(parsedFile.config ?? {}, ts.sys, directory);
  diagnostics.push(...config.errors);
  const aliases = config.options.paths ?? {};
  if (Object.keys(aliases).length !== 1 || aliases['@/*']?.length !== 1 || !['src/*', './src/*'].includes(aliases['@/*'][0]) || config.options.outFile) throw new Error('Build requires the owned @/* → src/* alias and directory output.');
  const sourceRoot = path.resolve(config.options.baseUrl ?? directory, 'src');
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmitOnError: true });
  diagnostics.push(...ts.getPreEmitDiagnostics(program));
  const report = () => {
    if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => directory, getNewLine: () => '\n' }));
    return diagnostics.some(item => item.category === ts.DiagnosticCategory.Error);
  };
  if (report()) return false;
  const rewrite = context => sourceFile => {
    const visit = (node, parent, grandparent) => {
      if (ts.isStringLiteral(node) && node.text.startsWith('@/')) {
        const moduleSpecifier = parent && ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
          || ts.isCallExpression(parent) && parent.arguments[0] === node && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(parent.expression) && parent.expression.text === 'require' || ts.isPropertyAccessExpression(parent.expression) && ts.isIdentifier(parent.expression.expression) && parent.expression.expression.text === 'require' && parent.expression.name.text === 'resolve')
          || ts.isLiteralTypeNode(parent) && grandparent && ts.isImportTypeNode(grandparent) && grandparent.argument === parent);
        if (moduleSpecifier) {
          const target = path.resolve(sourceRoot, node.text.slice(2));
          const relativeTarget = path.relative(sourceRoot, target);
          if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error('Module alias escapes the source tree.');
          let relative = path.relative(path.dirname(sourceFile.fileName), target).split(path.sep).join('/');
          if (!relative.startsWith('.')) relative = `./${relative}`;
          return ts.setTextRange(ts.setOriginalNode(context.factory.createStringLiteral(relative), node), node);
        }
      }
      return ts.visitEachChild(node, child => visit(child, node, parent), context);
    };
    return ts.visitNode(sourceFile, node => visit(node));
  };
  const emitted = program.emit(undefined, undefined, undefined, undefined, { before: [rewrite], afterDeclarations: [rewrite] });
  diagnostics.push(...emitted.diagnostics);
  return !report() && !emitted.emitSkipped;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--project')) throw new Error('Usage: node scripts/build.mjs [--project tsconfig.json]');
  process.exitCode = compileProject(args[1] ?? 'tsconfig.json') ? 0 : 1;
}
