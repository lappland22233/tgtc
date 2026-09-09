#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

command -v node >/dev/null 2>&1 || {
  echo "错误：缺少版本校验所需命令 node。" >&2
  exit 1
}

ROOT_DIR="$ROOT_DIR" node <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.env.ROOT_DIR;
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').trim();
const version = read('VERSION');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

if (!semver.test(version)) {
  throw new Error(`VERSION 必须是有效 SemVer：${JSON.stringify(version)}`);
}

const ciTag = process.env.GITHUB_REF_TYPE === 'tag'
  ? process.env.GITHUB_REF_NAME
  : process.env.CI_TAG;
if (ciTag !== undefined && ciTag !== '') {
  if (ciTag !== `v${version}`) {
    throw new Error(`CI 标签 ${JSON.stringify(ciTag)} 必须等于 ${JSON.stringify(`v${version}`)}。`);
  }
}

const manifests = [
  'backend/package.json',
  'backend/package-lock.json',
  'frontend/package.json',
  'frontend/package-lock.json',
];
for (const file of manifests) {
  const manifest = JSON.parse(read(file));
  const packageVersion = file.endsWith('package-lock.json')
    ? manifest.packages?.['']?.version
    : manifest.version;
  if (packageVersion !== version) {
    throw new Error(`${file} 的根包版本 ${JSON.stringify(packageVersion)} 与 VERSION ${JSON.stringify(version)} 不一致。`);
  }
}

console.log(`版本校验通过：${version}`);
NODE
