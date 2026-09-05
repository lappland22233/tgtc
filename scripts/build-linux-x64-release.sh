#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
VERSION="${1:-$(tr -d '\r\n' < "$ROOT_DIR/VERSION")}"
NODE_VERSION="${NODE_VERSION:-20.19.5}"
WORK_DIR="${WORK_DIR:-$HOME/.cache/tgtc-release/v${VERSION}}"
STAGE_DIR="$WORK_DIR/tgtc-v${VERSION}-linux-x64"
OUTPUT_DIR="$ROOT_DIR/.Releases/v${VERSION}"
JOBS="${JOBS:-$(nproc)}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "错误：必须在 Linux x86_64 环境构建。" >&2
  exit 1
fi
for command in cmake curl g++ npm rsync tar xz zip sha256sum; do
  command -v "$command" >/dev/null || { echo "错误：缺少构建命令 $command" >&2; exit 1; }
done

bash "$ROOT_DIR/scripts/release/check-version.sh"
CANONICAL_VERSION="$(tr -d '\r\n' < "$ROOT_DIR/VERSION")"
if [[ "$VERSION" != "$CANONICAL_VERSION" ]]; then
  echo "错误：发布版本 $VERSION 必须与 VERSION 中的 $CANONICAL_VERSION 一致。" >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/source" "$OUTPUT_DIR"
rsync -a --delete \
  --exclude '.git' --exclude '.codebuddy' --exclude '.Releases' \
  --exclude 'node_modules' --exclude 'dist' --exclude 'build' --exclude 'tmp' \
  "$ROOT_DIR/" "$WORK_DIR/source/"

pushd "$WORK_DIR/source/frontend" >/dev/null
npm ci --no-audit --no-fund
npm run build
popd >/dev/null

pushd "$WORK_DIR/source/backend" >/dev/null
npm ci --no-audit --no-fund
npm run typecheck
npm run build
rm -rf node_modules
npm ci --omit=dev --no-audit --no-fund
popd >/dev/null

PREBUILT_BOT_API="${PREBUILT_BOT_API:-}"
if [[ -n "$PREBUILT_BOT_API" ]]; then
  [[ -x "$PREBUILT_BOT_API" ]] || { echo "错误：PREBUILT_BOT_API 不是可执行文件：$PREBUILT_BOT_API" >&2; exit 1; }
  BOT_API_BINARY="$PREBUILT_BOT_API"
else
  cmake -S "$WORK_DIR/source/telegram-bot-api" -B "$WORK_DIR/bot-build" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
  cmake --build "$WORK_DIR/bot-build" --target telegram-bot-api --parallel "$JOBS"
  BOT_API_BINARY="$WORK_DIR/bot-build/telegram-bot-api"
fi

NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHASUMS="SHASUMS256.txt"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
# NODE_RUNTIME_CACHE：指向含已缓存的 Node tarball 与 SHASUMS256.txt 的目录
# （通常是历史构建的工作目录），跳过 nodejs.org 下载，仍执行 SHA-256 校验。
NODE_RUNTIME_CACHE="${NODE_RUNTIME_CACHE:-}"
if [[ -n "$NODE_RUNTIME_CACHE" && -f "$NODE_RUNTIME_CACHE/$NODE_ARCHIVE" && -f "$NODE_RUNTIME_CACHE/$NODE_SHASUMS" ]]; then
  cp "$NODE_RUNTIME_CACHE/$NODE_ARCHIVE" "$NODE_RUNTIME_CACHE/$NODE_SHASUMS" "$WORK_DIR/"
else
  curl --fail --location --retry 3 --silent --show-error \
    "$NODE_BASE_URL/$NODE_SHASUMS" \
    --output "$WORK_DIR/$NODE_SHASUMS"
  curl --fail --location --retry 3 --silent --show-error \
    "$NODE_BASE_URL/$NODE_ARCHIVE" \
    --output "$WORK_DIR/$NODE_ARCHIVE"
fi
(
  cd "$WORK_DIR"
  grep -F "  $NODE_ARCHIVE" "$NODE_SHASUMS" | sha256sum --check --strict --status
) || { echo "错误：Node.js 运行时 SHA-256 校验失败。" >&2; exit 1; }
tar -xJf "$WORK_DIR/$NODE_ARCHIVE" -C "$WORK_DIR"

# 发行包保持历史可用布局：backend/、frontend/、telegram-bot-api/、runtime/、bin/、start.sh。
# 发行包只包含不可变程序；Telegram workdir、数据库和 .env 必须位于发行目录之外。
mkdir -p "$STAGE_DIR/backend" "$STAGE_DIR/frontend" "$STAGE_DIR/telegram-bot-api/bin" \
  "$STAGE_DIR/runtime" "$STAGE_DIR/bin" "$STAGE_DIR/scripts/release"
cp -a "$WORK_DIR/source/backend/dist" "$STAGE_DIR/backend/"
cp -a "$WORK_DIR/source/backend/node_modules" "$STAGE_DIR/backend/"
cp "$WORK_DIR/source/backend/package.json" "$WORK_DIR/source/backend/package-lock.json" "$STAGE_DIR/backend/"
cp "$WORK_DIR/source/backend/.env.example" "$STAGE_DIR/backend/.env.example"
cp -a "$WORK_DIR/source/frontend/dist/." "$STAGE_DIR/frontend/"
cp "$BOT_API_BINARY" "$STAGE_DIR/telegram-bot-api/bin/telegram-bot-api"
cp -a "$WORK_DIR/node-v${NODE_VERSION}-linux-x64/." "$STAGE_DIR/runtime/"
cat > "$STAGE_DIR/bin/tgtc" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec "$ROOT_DIR/runtime/bin/node" "$ROOT_DIR/backend/dist/main.js" "$@"
EOF
cp "$ROOT_DIR/scripts/release/start.sh" "$STAGE_DIR/start.sh"
# 运维脚本随发行包交付；不复制任何运行时数据、数据库或密钥文件。
# update-public-key.pem 是发布验证公钥（私钥只存在于 CI secret），供部署侧离线验证更新资产。
for script in common.sh health-check.sh backup.sh upgrade.sh rollback.sh validate-release.sh; do
  cp "$ROOT_DIR/scripts/release/$script" "$STAGE_DIR/scripts/release/$script"
done
cp "$ROOT_DIR/scripts/release/update-public-key.pem" "$STAGE_DIR/scripts/release/update-public-key.pem"
cp "$ROOT_DIR/LICENSE" "$STAGE_DIR/LICENSE"
printf '%s\n' "$VERSION" > "$STAGE_DIR/VERSION"
chmod +x "$STAGE_DIR/start.sh" "$STAGE_DIR/bin/tgtc" "$STAGE_DIR/runtime/bin/node" "$STAGE_DIR/telegram-bot-api/bin/telegram-bot-api" \
  "$STAGE_DIR/scripts/release/health-check.sh" "$STAGE_DIR/scripts/release/backup.sh" \
  "$STAGE_DIR/scripts/release/upgrade.sh" "$STAGE_DIR/scripts/release/rollback.sh" "$STAGE_DIR/scripts/release/validate-release.sh"

find "$STAGE_DIR" -type f \( -name '*.ts' -o -name '*.map' -o -name '*.spec.js' \) -delete
find "$STAGE_DIR/backend/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +
rm -rf "$STAGE_DIR/backend/node_modules/@types"

for required_path in backend/dist/main.js backend/dist/database/data-source.js frontend/index.html telegram-bot-api/bin/telegram-bot-api runtime/bin/node bin/tgtc start.sh scripts/release/common.sh scripts/release/health-check.sh scripts/release/backup.sh scripts/release/upgrade.sh scripts/release/rollback.sh scripts/release/validate-release.sh scripts/release/update-public-key.pem VERSION; do
  [[ -e "$STAGE_DIR/$required_path" ]] || { echo "错误：发布包缺少 $required_path" >&2; exit 1; }
done
if find "$STAGE_DIR" -type f \( -name '*.ts' -o -name '*.spec.js' -o -name '*.map' \) -print -quit | grep -q .; then
  echo "错误：发布包混入 TypeScript、测试或 source map。" >&2
  exit 1
fi
for executable in start.sh bin/tgtc runtime/bin/node telegram-bot-api/bin/telegram-bot-api scripts/release/health-check.sh scripts/release/backup.sh scripts/release/upgrade.sh scripts/release/rollback.sh scripts/release/validate-release.sh; do
  [[ -x "$STAGE_DIR/$executable" ]] || { echo "错误：发布包可执行文件权限缺失：$executable" >&2; exit 1; }
done

ARCHIVE_NAME="tgtc-v${VERSION}-linux-x64.zip"
rm -f "$OUTPUT_DIR/$ARCHIVE_NAME" "$OUTPUT_DIR/SHA256SUMS" "$OUTPUT_DIR/SHA256SUMS.sig" "$OUTPUT_DIR/release-manifest.json"
(
  cd "$WORK_DIR"
  zip --quiet --recurse-paths "$OUTPUT_DIR/$ARCHIVE_NAME" "tgtc-v${VERSION}-linux-x64"
)
(
  cd "$OUTPUT_DIR"
  sha256sum "$ARCHIVE_NAME" > SHA256SUMS
)
# 生成机器可读清单并把其摘要并入 SHA256SUMS，使签名同时覆盖 ZIP 与清单。
bash "$ROOT_DIR/scripts/release/generate-manifest.sh" "$OUTPUT_DIR"
(
  cd "$OUTPUT_DIR"
  sha256sum release-manifest.json >> SHA256SUMS
)
if [[ -n "${RELEASE_SIGNING_KEY_PATH:-}" ]]; then
  bash "$ROOT_DIR/scripts/release/sign-release.sh" "$OUTPUT_DIR/SHA256SUMS"
else
  printf '警告：未设置 RELEASE_SIGNING_KEY_PATH，跳过 SHA256SUMS 签名（正式发布必须签名）。\n' >&2
fi
bash "$ROOT_DIR/scripts/release/validate-release.sh" "$OUTPUT_DIR/$ARCHIVE_NAME" "$OUTPUT_DIR/SHA256SUMS"
printf 'TGTC v%s\nTarget: Linux x86_64\nNode.js: %s\nBundled Telegram Bot API: 10.2-tgtc.1\n' \
  "$VERSION" "$NODE_VERSION" > "$OUTPUT_DIR/RELEASE.txt"

echo "发布完成：$OUTPUT_DIR"
