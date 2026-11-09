# Mirrors the -Dbenchmarks branch of build.zig. Linked against the same core and the same
# libsodium the server is, because what a JWT costs depends on which SHA-256 is underneath.
#
# Build type matters more here than anywhere else: a Debug build measures Debug.
#   cmake -B build -DFS_ENABLE_BENCHMARKS=ON -DCMAKE_BUILD_TYPE=Release

add_executable(bench_jwt bench_jwt.c)
target_include_directories(bench_jwt PRIVATE ${FS_INCLUDE_DIRS} ${arnm_SOURCE_DIR}/include)
target_compile_options(bench_jwt PRIVATE ${FS_WARNING_FLAGS})
target_link_libraries(bench_jwt PRIVATE service_core)

# What h2o's gzip filter costs per response. Only in an h2o build: it calls the compressor
# in libh2o-evloop, and the zlib it reads out is the one that library was built against.
if(FS_ENABLE_H2O)
  find_package(ZLIB REQUIRED)
  add_executable(bench_gzip bench_gzip.c)
  target_include_directories(bench_gzip PRIVATE ${FS_INCLUDE_DIRS} ${H2O_INCLUDE_DIRS})
  target_compile_definitions(bench_gzip PRIVATE H2O_USE_LIBUV=0)
  target_compile_options(bench_gzip PRIVATE ${FS_WARNING_FLAGS})
  target_link_libraries(bench_gzip PRIVATE service_core ZLIB::ZLIB)
endif()
