#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "Usage on Linux x86_64: bash $0 <output-directory>" >&2
  exit 2
fi

mkdir -p -- "$1"
output=$(realpath -- "$1")
scratch=$(mktemp -d "$output/build.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
cd "$scratch"

download() {
  local url=$1 digest=$2 archive
  archive=${url##*/}
  curl --fail --silent --show-error --location --retry 2 --max-time 180 --output "$archive" "$url"
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
  tar -xf "$archive"
}

download https://github.com/Kitware/CMake/releases/download/v4.5.1/cmake-4.5.1-linux-x86_64.tar.gz \
  83b71181fb62b4fe8f26067a9321448572e7a43bd04ff6c7f54a24c33698f16d
download https://zlib.net/zlib-1.4.tar.gz \
  02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584
download https://github.com/openssl/openssl/releases/download/openssl-4.1.0/openssl-4.1.0.tar.gz \
  50c17baf54cb008f6ce42d50deb4b28050a1aad711636cabd4b241c7e90cc2fd

mkdir -p -- "$output/cmake"
cp -a cmake-4.5.1-linux-x86_64/. "$output/cmake/"
(
  cd zlib-1.4
  ./configure --prefix="$output/libs"
  make -j1
  make -j1 install
)
(
  cd openssl-4.1.0
  # Keep the distribution certificate store for outbound TLS. install_sw writes under the prefix.
  ./Configure --prefix="$output/libs" --libdir=lib --openssldir=/etc/ssl no-tests no-docs -O1
  make -j1 build_sw
  make -j1 install_sw
)
"$output/cmake/bin/cmake" --version
LD_LIBRARY_PATH="$output/libs/lib" "$output/libs/bin/openssl" version
PKG_CONFIG_PATH="$output/libs/lib/pkgconfig" pkg-config --modversion zlib openssl
