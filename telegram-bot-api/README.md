# Telegram Bot API

The Telegram Bot API provides an HTTP API for creating [Telegram Bots](https://core.telegram.org/bots).

If you've got any questions about bots or would like to report an issue with your bot, kindly contact us at [@BotSupport](https://t.me/BotSupport) in Telegram.

Please note that only global Bot API issues that affect all bots are suitable for this repository.

## Table of Contents
- [Installation](#installation)
- [Dependencies](#dependencies)
- [Usage](#usage)
- [Documentation](#documentation)
- [Moving a bot to a local server](#switching)
- [Moving a bot from one local server to another](#moving)
- [License](#license)

<a name="installation"></a>
## Installation

The simplest way to build and install `Telegram Bot API server` is to use our [Telegram Bot API server build instructions generator](https://tdlib.github.io/telegram-bot-api/build.html).
If you do that, you'll only need to choose the target operating system to receive the complete build instructions.

In general, you need to install all `Telegram Bot API server` [dependencies](#dependencies) and compile the source code using CMake:

```sh
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build . --target install
```

<a name="dependencies"></a>
## Dependencies
To build and run `Telegram Bot API server` you will need:

* OpenSSL
* zlib
* C++17 compatible compiler (e.g., Clang 5.0+, GCC 7.0+, MSVC 19.1+ (Visual Studio 2017.7+), Intel C++ Compiler 19+) (build only)
* gperf (build only)
* CMake (3.10+, build only)

<a name="usage"></a>
## Usage

Use `telegram-bot-api --help` to receive the list of all available options of the Telegram Bot API server.

The only mandatory options are `--api-id` and `--api-hash`. You must obtain your own `api_id` and `api_hash`
as described in https://core.telegram.org/api/obtaining_api_id and specify them using the `--api-id` and `--api-hash` options
or the `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` environment variables.

To enable Bot API features not available at `https://api.telegram.org`, specify the option `--local`. In the local mode the Bot API server allows to:
* Download files without a size limit.
* Upload files up to 2000 MB.
* Upload files using their local path and [the file URI scheme](https://en.wikipedia.org/wiki/File_URI_scheme).
* Use an HTTP URL for the webhook.
* Use any local IP address for the webhook.
* Use any port for the webhook.
* Set *max_webhook_connections* up to 100000.
* Receive the absolute local path as a value of the *file_path* field without the need to download the file after a *getFile* request.

The Telegram Bot API server accepts only HTTP requests, so a TLS termination proxy needs to be used to handle remote HTTPS requests.

By default the Telegram Bot API server is launched on the port 8081, which can be changed using the option `--http-port`.

### Streaming file endpoint

A complete Chinese integration guide is available in [流式文件端点调用指南.md](流式文件端点调用指南.md).

This fork can stream a Telegram file to an HTTP client before TDLib finishes downloading the whole file. The feature is disabled by default and doesn't change the standard `getFile` method.

Enable it with:

```sh
telegram-bot-api --api-id=<API_ID> --api-hash=<API_HASH> --enable-file-streaming
```

Download a complete file using the Bot API `file_id` returned in a message or by another Bot API method:

```text
GET /stream/file/bot<TOKEN>/<URL_ENCODED_FILE_ID>
GET /stream/file/bot<TOKEN>/test/<URL_ENCODED_FILE_ID>
```

Example:

```sh
curl --fail --output file.bin "http://127.0.0.1:8081/stream/file/bot123456:ABCDEF/<URL_ENCODED_FILE_ID>"
```

The response uses `200 OK`, `application/octet-stream`, and an exact `Content-Length`. TDLib downloads the file once and the server forwards only the continuously readable prefix in order. A successful HTTP completion guarantees that the emitted byte count equals the exact file size. If an upstream error happens after response headers have been sent, the connection is aborted; clients must reject responses shorter than `Content-Length`.

Configuration options:

| Option | Default | Description |
| --- | ---: | --- |
| `--enable-file-streaming` | off | Enables the streaming route. |
| `--file-stream-chunk-size` | 262144 | Maximum bytes read and flushed at a time; allowed range is 16 KiB–4 MiB. |
| `--file-stream-max-connections` | 100 | Global active stream limit. |
| `--file-stream-first-byte-timeout` | 30 | Seconds allowed before the first flushed data block. |
| `--file-stream-idle-timeout` | 60 | Seconds allowed between flushed data blocks. |
| `--file-stream-write-high-watermark` | 1048576 | Upper bound used for each queued streaming write. |

HTTP errors returned before streaming starts use the Bot API JSON error shape. Common statuses are `400` for malformed paths or file IDs, `401` for invalid tokens, `404` for unavailable routes/files, `405` for non-GET methods, `413` for platform size limits, `429` for connection limits, `502` for TDLib/upstream errors, `503` during shutdown, and `504` for timeouts.

The first version intentionally supports only complete sequential `GET` responses. `Range`, resumable downloads, `HEAD`, CDN caching, and multi-range responses are not implemented. The `file_id` is always validated by TDLib and is never interpreted as a local path.

<a name="documentation"></a>
## Documentation
See [Bots: An introduction for developers](https://core.telegram.org/bots) for a brief description of Telegram Bots and their features.

See the [Telegram Bot API documentation](https://core.telegram.org/bots/api) for a description of the Bot API interface and a complete list of available classes, methods and updates.

See the [Telegram Bot API server build instructions generator](https://tdlib.github.io/telegram-bot-api/build.html) for detailed instructions on how to build the Telegram Bot API server.

Subscribe to [@BotNews](https://t.me/botnews) to be the first to know about the latest updates and join the discussion in [@BotTalk](https://t.me/bottalk).

<a name="switching"></a>
## Moving a bot to a local server

To guarantee that your bot will receive all updates, you must deregister it with the `https://api.telegram.org` server by calling the method [logOut](https://core.telegram.org/bots/api#logout).
After the bot is logged out, you can replace the address to which the bot sends requests with the address of your local server and use it in the usual way.
If the server is launched in `--local` mode, make sure that the bot can correctly handle absolute file paths in response to `getFile` requests.

<a name="moving"></a>
## Moving a bot from one local server to another

If the bot is logged in on more than one server simultaneously, there is no guarantee that it will receive all updates.
To move a bot from one local server to another you can use the method [logOut](https://core.telegram.org/bots/api#logout) to log out on the old server before switching to the new one.

If you want to avoid losing updates between logging out on the old server and launching on the new server, you can remove the bot's webhook using the method
[deleteWebhook](https://core.telegram.org/bots/api#deletewebhook), then use the method [close](https://core.telegram.org/bots/api#close) to close the bot instance.
After the instance is closed, locate the bot's subdirectory in the working directory of the old server by the bot's user ID, move the subdirectory to the working directory of the new server
and continue sending requests to the new server as usual.

<a name="license"></a>
## License
`Telegram Bot API server` source code is licensed under the terms of the Boost Software License. See [LICENSE_1_0.txt](http://www.boost.org/LICENSE_1_0.txt) for more information.
