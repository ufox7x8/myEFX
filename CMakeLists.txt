cmake_minimum_required(VERSION 3.25)
project(myEFX LANGUAGES CXX)

set(VST3_SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/SDK/VST3_SDK" CACHE PATH "Path to Steinberg VST3 SDK")

if(NOT EXISTS "${VST3_SDK_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR
        "VST3 SDK not found. Extract the official Steinberg VST3 SDK into SDK/VST3_SDK")
endif()

message(STATUS "myEFX: VST3 SDK found at ${VST3_SDK_ROOT}")
message(STATUS "First milestone: build/load MyEQ VST3.")
