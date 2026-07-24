'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
]);

function collectTypeScriptFiles(targetPath, files = []) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (/\.tsx?$/.test(targetPath) && !targetPath.endsWith('.d.ts')) {
      files.push(targetPath);
    }
    return files;
  }

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
    collectTypeScriptFiles(path.join(targetPath, entry.name), files);
  }
  return files;
}

function getDecorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}

function getDecoratorCall(node, decoratorName) {
  for (const decorator of getDecorators(node)) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) continue;

    const callee = expression.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

    if (name === decoratorName) return expression;
  }
  return undefined;
}

function hasExplicitColumnType(columnCall) {
  const firstArgument = columnCall.arguments[0];
  if (!firstArgument) return false;

  // TypeORM also accepts @Column('varchar') as an explicit column type.
  if (ts.isStringLiteralLike(firstArgument)) return true;
  if (!ts.isObjectLiteralExpression(firstArgument)) return false;

  return firstArgument.properties.some((property) => {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'type';
    }
    return false;
  });
}

function getPropertyName(member, sourceFile) {
  if (!member.name) return '<unknown>';
  if (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) || ts.isNumericLiteral(member.name)) {
    return member.name.text;
  }
  return member.name.getText(sourceFile);
}

function scanFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const matches = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !getDecoratorCall(statement, 'Entity')) continue;

    for (const member of statement.members) {
      if (!ts.isPropertyDeclaration(member) || !member.type || !ts.isUnionTypeNode(member.type)) continue;

      const columnCall = getDecoratorCall(member, 'Column');
      if (!columnCall || hasExplicitColumnType(columnCall)) continue;

      const position = sourceFile.getLineAndCharacterOfPosition(member.name.getStart(sourceFile));
      matches.push({
        filePath,
        line: position.line + 1,
        column: position.character + 1,
        propertyName: getPropertyName(member, sourceFile),
        unionType: member.type.getText(sourceFile),
      });
    }
  }

  return matches;
}

function main() {
  const target = path.resolve(process.argv[2] || path.join(process.cwd(), 'src'));
  if (!fs.existsSync(target)) {
    console.error(`扫描路径不存在: ${target}`);
    process.exitCode = 2;
    return;
  }

  const matches = collectTypeScriptFiles(target)
    .flatMap(scanFile)
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

  if (matches.length === 0) {
    console.log(`未发现缺少显式数据库类型的 TypeORM 联合类型列。扫描路径: ${target}`);
    return;
  }

  console.error(`发现 ${matches.length} 个可能导致 TypeORM 将 design:type 推断为 Object 的列:\n`);
  for (const match of matches) {
    const relativePath = path.relative(process.cwd(), match.filePath) || match.filePath;
    console.error(
      `${relativePath}:${match.line}:${match.column}  ${match.propertyName} (${match.unionType})`,
    );
  }
  console.error('\n请为对应 @Column() 增加显式 type，例如 @Column({ type: \'varchar\', nullable: true })。');
  process.exitCode = 1;
}

main();
