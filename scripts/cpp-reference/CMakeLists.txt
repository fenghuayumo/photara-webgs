cmake_minimum_required(VERSION 3.24)
project(photara_web_reference LANGUAGES CXX)
set(PHOTARA_ROOT "" CACHE PATH "Existing photara-studio checkout with Release libraries")
set(PHOTARA_BUILD "${PHOTARA_ROOT}/build" CACHE PATH "Existing Photara build")
find_package(Vulkan REQUIRED)
find_path(JSON_INCLUDE nlohmann/json.hpp HINTS "${PHOTARA_ROOT}/../../vcpkg/installed/x64-windows/include" REQUIRED)
add_executable(photara_web_reference main.cpp)
target_compile_features(photara_web_reference PRIVATE cxx_std_20)
target_include_directories(photara_web_reference PRIVATE
  "${PHOTARA_ROOT}/apps/editor/splat_render/include"
  "${PHOTARA_ROOT}/third_party/photara_vk/include" "${JSON_INCLUDE}")
target_link_libraries(photara_web_reference PRIVATE
  "${PHOTARA_BUILD}/photara/splat_render/Release/splat_render.lib"
  "${PHOTARA_BUILD}/photara/splat_drender/Release/splat_drender_vulkan.lib"
  "${PHOTARA_BUILD}/third_party/photara_vk/Release/photara_vk.lib" Vulkan::Vulkan)
if(MSVC)
  target_compile_options(photara_web_reference PRIVATE /utf-8 /O2)
endif()
