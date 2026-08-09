//
// Distributed under the Boost Software License, Version 1.0.
//
#include "td/utils/OptionParser.h"
#include "td/utils/Slice.h"
#include "td/utils/tests.h"

int main(int argc, char **argv) {
  auto &runner = td::TestsRunner::get_default();
  td::OptionParser options;
  options.add_option('f', "filter", "run only specified tests",
                     [&](td::Slice filter) { runner.add_substr_filter(filter.str()); });
  auto result = options.run(argc, argv, 0);
  if (result.is_error()) {
    return 1;
  }
  runner.run_all();
  return 0;
}
