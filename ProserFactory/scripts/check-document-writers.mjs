import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const writes = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);
const projection = new Set(['prose', 'wordCount']);
const name = node => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
const property = node => ts.isPropertyAccessExpression(node) ? { object: node.expression, key: node.name.text }
  : ts.isElementAccessExpression(node) ? { object: node.expression, key: node.argumentExpression && name(node.argumentExpression) } : null;
const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;

/** Fail closed for opaque scene write payloads. This is a source restriction,
 * not a substitute for the separately reviewed database enforcement guard. */
export function scanProjectionWrites(sources) {
  const rootNames = [...sources.keys()];
  const options = { target: ts.ScriptTarget.ESNext, noResolve: true, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => sources.has(file) ? ts.createSourceFile(file, sources.get(file), ts.ScriptTarget.ESNext, true) : undefined;
  host.readFile = file => sources.get(file);
  host.fileExists = file => sources.has(file);
  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();
  const errors = [];
  for (const fileName of rootNames) {
    const file = program.getSourceFile(fileName); if (!file) continue;
    const declaration = node => checker.getSymbolAtLocation(node)?.valueDeclaration;
    function objectSymbol(expression, seen = new Set()) {
      expression = unwrap(expression); if (seen.has(expression)) return undefined; seen.add(expression);
      const value = ts.isIdentifier(expression) && declaration(expression);
      return value && ts.isVariableDeclaration(value) && value.initializer && ts.isIdentifier(value.initializer) ? objectSymbol(value.initializer, seen) : checker.getSymbolAtLocation(expression);
    }
    function memberPath(expression, seen = new Set()) {
      expression = unwrap(expression); if (seen.has(expression)) return []; seen.add(expression);
      const member = property(expression);
      if (member) return [...memberPath(member.object, seen), member.key ?? '*'];
      if (ts.isIdentifier(expression)) {
        const value = declaration(expression);
        if (value && ts.isVariableDeclaration(value) && value.initializer) return memberPath(value.initializer, seen);
        if (value && ts.isBindingElement(value) && ts.isObjectBindingPattern(value.parent) && ts.isVariableDeclaration(value.parent.parent) && value.parent.parent.initializer) return [...memberPath(value.parent.parent.initializer, seen), name(value.propertyName ?? value.name) ?? '*'];
      }
      return [];
    }
    function fields(expression, seen = new Set()) {
      expression = unwrap(expression); if (seen.has(expression)) return new Set(['*']); seen.add(expression);
      if (ts.isObjectLiteralExpression(expression)) {
        const result = new Set();
        for (const entry of expression.properties) {
          if (ts.isSpreadAssignment(entry)) for (const field of fields(entry.expression, new Set(seen))) result.add(field);
          else result.add(name(entry.name) ?? '*');
        }
        return result;
      }
      if (ts.isIdentifier(expression)) {
        const value = declaration(expression);
        if (!value || !ts.isVariableDeclaration(value) || !value.initializer) return new Set(['*']);
        const result = fields(value.initializer, seen);
        const symbol = objectSymbol(expression);
        const assignments = node => {
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const member = property(node.left);
            if (member && objectSymbol(member.object) === symbol) result.add(member.key ?? '*');
            if (ts.isIdentifier(node.left) && checker.getSymbolAtLocation(node.left) === symbol) for (const field of fields(node.right, new Set(seen))) result.add(field);
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === 'Object' && node.arguments[0] && objectSymbol(node.arguments[0]) === symbol) {
            if (node.expression.name.text === 'assign') for (const argument of node.arguments.slice(1)) for (const field of fields(argument, new Set(seen))) result.add(field);
            if (node.expression.name.text === 'defineProperty') result.add(node.arguments[1] ? name(node.arguments[1]) ?? '*' : '*');
          }
          ts.forEachChild(node, assignments);
        };
        assignments(file);
        return result;
      }
      return new Set(['*']);
    }
    function valueAt(expression, key) {
      expression = unwrap(expression);
      if (!ts.isObjectLiteralExpression(expression)) return undefined;
      const entry = expression.properties.find(item => !ts.isSpreadAssignment(item) && name(item.name) === key);
      return entry && ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
    }
    const report = (node, reason) => { const position = file.getLineAndCharacterOfPosition(node.getStart(file)); errors.push({ file: fileName, line: position.line + 1, reason }); };
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const member = memberPath(node.expression);
        const method = member.at(-1); const model = member.at(-2);
        if (model === 'scene' && writes.has(method)) {
          for (const field of method === 'upsert' ? ['create','update'] : ['data']) {
            const payload = node.arguments[0] && valueAt(node.arguments[0], field);
            const actual = payload ? fields(payload) : new Set(['*']);
            if ([...actual].some(item => projection.has(item) || item === '*')) report(node, 'Scene prose/wordCount or opaque write data must go through documents/service.ts.');
          }
        }
        // Nested hierarchy creation must not introduce another prose authority.
        if (['book','act','chapter'].includes(model) && writes.has(method)) {
          const nested = child => { if (ts.isPropertyAssignment(child) && name(child.name) === 'scenes') {
            const inspect = item => { if (ts.isPropertyAssignment(item) && projection.has(name(item.name))) report(item, 'Nested scene projections must go through documents/service.ts.'); ts.forEachChild(item, inspect); };
            inspect(child.initializer);
          } else ts.forEachChild(child, nested); };
          for (const argument of node.arguments) nested(argument);
        }
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && /\b(?:UPDATE|INSERT\s+INTO)\s+"?scenes"?\b/i.test(node.getText(file)) && /\b(?:prose|word_count|wordCount)\b/i.test(node.getText(file))) report(node, 'Raw SQL scene projection writes must go through documents/service.ts.');
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return errors;
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? entry.name === '__tests__' ? [] : sourceFiles(path.join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts') ? [path.join(directory, entry.name)] : []);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const allowed = path.join(root, 'src/documents/service.ts');
  const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'scripts'))].filter(file => file !== allowed);
  const errors = scanProjectionWrites(new Map(files.map(file => [file, fs.readFileSync(file, 'utf8')])));
  for (const error of errors) process.stderr.write(`${path.relative(root, error.file)}:${error.line}: ${error.reason}\n`);
  if (errors.length) process.exitCode = 1;
  else process.stdout.write(`Verified ${files.length} runtime/operator sources: document service owns scene projections.\n`);
}
