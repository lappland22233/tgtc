import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * 静态守卫：禁止再次引入「构造函数参数的运行时类型无法解析出注入 token」的写法。
 *
 * 回归背景：`@Optional() private readonly x: X | null = null` 这类参数，联合类型在运行时
 * 只会发出 `Object`，Nest 拿不到服务类 token；`@Optional()` 又把解析失败静默降级成 `null`，
 * 于是「账号池增强能力全部不生效但不报错」可以长期潜伏（见 `bot-account-pool-di-wiring.spec.ts`）。
 *
 * 判定规则（只看构造参数，误伤成本必须为零）：
 * 1. 类型是联合类型（如 `X | null`）或没有类型标注 → `design:paramtypes` 得到 `Object`，
 *    这类参数**必须**有显式 `@Inject*` 装饰器；
 * 2. 合法写法不误伤：
 *    - `@Optional() @Inject(X)` / `@Optional() @InjectRepository(E)`：显式 token；
 *    - `@Optional() private readonly x?: X`：可选属性 + **具体类类型**，按类 token 解析，正确；
 *    - 具体类类型（无论是否 `@Optional()`）：按类 token 解析，正确。
 *
 * 为什么同时做「真实源码扫描」与「内联样本自测」：
 * 只扫源码时，扫描器一旦因为语法版本/路径变化而扫不到东西，会给出**虚假的安全结论**
 * （与 `database/migration-patterns.spec.ts` 的守卫哲学一致）。因此这里同时断言
 * 扫描覆盖量下限与扫描器对已知坏/好样本的判定能力。
 */

const SRC_DIR = join(__dirname, '..');
/** 不参与扫描的目录：测试与产物 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test']);

interface DiTokenViolation {
  file: string;
  line: number;
  param: string;
  reason: string;
}

interface ScanResult {
  violations: DiTokenViolation[];
  /** 扫描到的构造参数总数（用于证明扫描器真的解析到了构造函数） */
  constructorParams: number;
  /** 带 `@Optional()` 的构造参数数（本仓库当前为账号池增强依赖） */
  optionalParams: number;
  /** 带显式 `@Inject*` 装饰器的构造参数数 */
  explicitTokenParams: number;
}

/** 取装饰器名称（`@Optional()` → `Optional`，`@InjectRepository(X)` → `InjectRepository`） */
function decoratorName(decorator: ts.Decorator): string | null {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression)) {
    return ts.isIdentifier(expression.expression) ? expression.expression.text : null;
  }
  return ts.isIdentifier(expression) ? expression.text : null;
}

/** 运行时无法解析出类 token：联合类型（含 `X | null`）或无类型标注 → `Object` */
function isUnresolvableType(param: ts.ParameterDeclaration): boolean {
  if (!param.type) return true;
  return ts.isUnionTypeNode(param.type);
}

function scanSource(label: string, text: string): ScanResult {
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true);
  const result: ScanResult = {
    violations: [],
    constructorParams: 0,
    optionalParams: 0,
    explicitTokenParams: 0,
  };

  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node)) {
      for (const param of node.parameters) {
        result.constructorParams += 1;

        const decorators = (ts.canHaveDecorators(param) ? ts.getDecorators(param) : undefined) ?? [];
        const names = decorators.map(decoratorName).filter((name): name is string => name !== null);
        const optional = names.includes('Optional');
        const explicitToken = names.some((name) => name.startsWith('Inject'));

        if (explicitToken) result.explicitTokenParams += 1;
        if (optional) result.optionalParams += 1;
        if (explicitToken) continue;
        if (!isUnresolvableType(param)) continue;

        const position = source.getLineAndCharacterOfPosition(param.getStart(source));
        result.violations.push({
          file: label,
          line: position.line + 1,
          param: param.name.getText(source),
          reason: optional
            ? '`@Optional()` + 联合类型/无类型 + 无显式 token：解析失败会被静默降级为 null'
            : '联合类型/无类型 + 无显式 token：容器启动时必然无法解析该依赖',
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return result;
}

/** 递归收集参与扫描的源码文件（排除测试文件与产物目录） */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), acc);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (/\.(spec|e2e-spec)\.ts$/.test(entry.name)) continue;
    acc.push(join(dir, entry.name));
  }
  return acc;
}

const BAD_SAMPLE = `
@Service()
class Bad {
  constructor(
    @Optional() private readonly pool: PoolService | null = null,
    @Optional() private readonly client: ClientService | undefined,
    private readonly repo: RepoService | null,
    @Optional() private readonly legacy = null,
  ) {}
}`;

const GOOD_SAMPLE = `
@Service()
class Good {
  constructor(
    private readonly required: RequiredService,
    @Optional() @Inject(PoolService) private readonly pool: PoolService | null = null,
    @Optional() @InjectRepository(Entity) private readonly repo: Repository<Entity> | null = null,
    @Optional() private readonly budget?: BudgetService,
    @Optional() private readonly optionalConcrete: ConcreteService,
  ) {}
}`;

describe('构造参数注入 token 静态守卫', () => {
  const files = collectSourceFiles(SRC_DIR);
  const results = files.map((file) => scanSource(file, readFileSync(file, 'utf8')));

  it('真实源码中不存在「联合类型/无类型 + 无显式 token」的构造参数', () => {
    const violations = results.flatMap((result) => result.violations);
    const report = violations.map((item) => `${item.file}:${item.line} (${item.param}) ${item.reason}`).join('\n');

    // 失败信息直接给出位置与原因，便于定位（不要只看 diff 猜）
    expect(report).toBe('');
    expect(violations).toEqual([]);
  });

  it('扫描器确实覆盖了源码：文件数与可选依赖数不低于下限（防止空扫通过）', () => {
    const total = results.reduce(
      (sum, result) => ({
        constructorParams: sum.constructorParams + result.constructorParams,
        optionalParams: sum.optionalParams + result.optionalParams,
        explicitTokenParams: sum.explicitTokenParams + result.explicitTokenParams,
      }),
      { constructorParams: 0, optionalParams: 0, explicitTokenParams: 0 },
    );

    // 下限只用于证明「扫描器解析到了真实构造函数」，不用于描述业务规模
    expect(files.length).toBeGreaterThanOrEqual(100);
    expect(total.constructorParams).toBeGreaterThanOrEqual(200);
    expect(total.optionalParams).toBeGreaterThanOrEqual(15);
    expect(total.explicitTokenParams).toBeGreaterThanOrEqual(15);
  });

  it('扫描器能力自测：坏样本全部命中，好样本零误伤', () => {
    const bad = scanSource('bad-sample.ts', BAD_SAMPLE);
    expect(bad.violations).toHaveLength(4);
    expect(bad.violations.map((item) => item.param)).toEqual(['pool', 'client', 'repo', 'legacy']);
    expect(bad.optionalParams).toBe(3);
    expect(bad.constructorParams).toBe(4);

    const good = scanSource('good-sample.ts', GOOD_SAMPLE);
    expect(good.violations).toEqual([]);
    expect(good.constructorParams).toBe(5);
    expect(good.optionalParams).toBe(4);
    expect(good.explicitTokenParams).toBe(2);
  });
});
