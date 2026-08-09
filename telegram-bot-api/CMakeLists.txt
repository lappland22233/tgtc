cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

project(TelegramBotApi VERSION 10.2 LANGUAGES CXX)

add_subdirectory(td EXCLUDE_FROM_ALL)

if (NOT DEFINED CMAKE_MODULE_PATH)
  set(CMAKE_MODULE_PATH "")
endif()
set(CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/td/CMake" "${CMAKE_MODULE_PATH}")

if (NOT DEFINED CMAKE_INSTALL_BINDIR)
  set(CMAKE_INSTALL_BINDIR "bin")
endif()

if (POLICY CMP0074)
  # use environment variables to find libraries
  cmake_policy(SET CMP0074 NEW)
endif()

include(PreventInSourceBuild)
prevent_in_source_build()

if (TELEGRAM_BOT_API_ENABLE_LTO)
  include(CheckIPOSupported)
  check_ipo_supported(RESULT IPO_SUPPORTED LANGUAGES CXX)
  if (IPO_SUPPORTED)
    string(REPLACE ";" " " CXX_FLAGS_IPO "${CMAKE_CXX_COMPILE_OPTIONS_IPO}")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${CXX_FLAGS_IPO}")

    string(REPLACE ";" " " LINK_FLAGS_IPO "${CMAKE_CXX_LINK_OPTIONS_IPO}")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} ${LINK_FLAGS_IPO}")
  endif()
endif()

set(CMAKE_THREAD_PREFER_PTHREAD ON)
set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

if (THREADS_HAVE_PTHREAD_ARG)
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
endif()

include(TdSetUpCompiler)
td_set_up_compiler()

if (CLANG OR GCC)
  if (MEMPROF)
    include(CheckCXXCompilerFlag)
    check_cxx_compiler_flag(-no-pie CXX_NO_PIE_FLAG)
    if (CXX_NO_PIE_FLAG)
      set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -no-pie")
    elseif (APPLE)
      set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Wl,-no_pie")
    endif()
    include(AddCXXCompilerFlag)
    add_cxx_compiler_flag("-static-libstdc++")
    add_cxx_compiler_flag("-static-libgcc")
  endif()
endif()

set(TELEGRAM_BOT_API_SOURCE
  telegram-bot-api/telegram-bot-api.cpp

  telegram-bot-api/Client.cpp
  telegram-bot-api/ClientManager.cpp
  telegram-bot-api/FileStream.cpp
  telegram-bot-api/FileStreamCursor.cpp
  telegram-bot-api/FileStreamRoute.cpp
  telegram-bot-api/HttpConnection.cpp
  telegram-bot-api/HttpStatConnection.cpp
  telegram-bot-api/Query.cpp
  telegram-bot-api/Stats.cpp
  telegram-bot-api/Watchdog.cpp
  telegram-bot-api/WebhookActor.cpp

  telegram-bot-api/Client.h
  telegram-bot-api/ClientManager.h
  telegram-bot-api/ClientParameters.h
  telegram-bot-api/FileStream.h
  telegram-bot-api/FileStreamCore.h
  telegram-bot-api/HttpConnection.h
  telegram-bot-api/HttpServer.h
  telegram-bot-api/HttpStatConnection.h
  telegram-bot-api/Query.h
  telegram-bot-api/Stats.h
  telegram-bot-api/Watchdog.h
  telegram-bot-api/WebhookActor.h
  telegram-bot-api/WorkdirCleanupManager.h
)

add_executable(telegram-bot-api ${TELEGRAM_BOT_API_SOURCE})
target_include_directories(telegram-bot-api PRIVATE $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>)
target_link_libraries(telegram-bot-api PRIVATE memprof tdactor tdcore tddb tdnet tdutils)

include(CTest)
if (BUILD_TESTING)
  add_executable(test-file-stream
    telegram-bot-api/TestMain.cpp
    telegram-bot-api/FileStreamCursor.cpp
    telegram-bot-api/FileStreamRoute.cpp
    telegram-bot-api/FileStream.test.cpp
  )
  target_include_directories(test-file-stream PRIVATE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/td/tdactor>
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/td/tdnet>
  )
  target_link_libraries(test-file-stream PRIVATE tdutils)

  add_executable(test-workdir-cleanup
    telegram-bot-api/TestMain.cpp
    telegram-bot-api/WorkdirCleanupManager.cpp
    telegram-bot-api/WorkdirCleanupManager.test.cpp
  )
  target_include_directories(test-workdir-cleanup PRIVATE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/td/tdactor>
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/td/tddb>
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/td/tdnet>
  )
  target_compile_definitions(test-workdir-cleanup PRIVATE WORKDIR_CLEANUP_CORE_ONLY=1)
  target_link_libraries(test-workdir-cleanup PRIVATE tdutils)

  add_test(NAME test-file-stream COMMAND test-file-stream --filter FileStream)
  add_test(NAME test-workdir-cleanup COMMAND test-workdir-cleanup --filter WorkdirCleanup)
endif()

install(TARGETS telegram-bot-api RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
if (MSVC AND VCPKG_TOOLCHAIN)
  install(DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIG>/" DESTINATION "${CMAKE_INSTALL_BINDIR}" FILES_MATCHING PATTERN "*.dll" PATTERN "*.pdb")
endif()
