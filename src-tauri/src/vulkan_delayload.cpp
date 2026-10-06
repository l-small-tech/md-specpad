// Windows only, compiled by build.rs. See the comment there.
//
// ggml's Vulkan backend bootstraps through exactly one import from
// vulkan-1.dll (vkGetInstanceProcAddr; every other entry point is fetched
// dynamically). The DLL is delay-loaded, so that first call is the moment
// Windows tries to find it. When it cannot, the delay-load helper asks this
// failure hook what to do; throwing turns the failure into the C++ exception
// ggml_backend_vk_reg() already catches (std::exception) — it then reports
// no Vulkan backend and whisper.cpp runs on the CPU. The exception passes
// through the CRT's delay-load helper, which is ordinary x64 code with
// unwind tables and nothing to clean up.
//
// The hook pointers are `const` and defined (null) in delayimp.lib; the
// definitions here win because build.rs puts this object file itself on the
// link line, ahead of every library. Verified by the `notify` hook below:
// with MD_SPECPAD_NO_VULKAN set, the load is refused before it is
// attempted, so the same unwind path can be exercised on a machine that has
// the DLL (`cargo test real_model -- --ignored --nocapture`).

#include <windows.h>
#include <delayimp.h>
#include <stdexcept>
#include <cstdlib>
#include <cstring>

namespace {

bool is_vulkan(const DelayLoadInfo* info) {
    return info != nullptr && info->szDll != nullptr && _stricmp(info->szDll, "vulkan-1.dll") == 0;
}

FARPROC WINAPI failure_hook(unsigned notification, PDelayLoadInfo info) {
    if (notification == dliFailLoadLib && is_vulkan(info)) {
        throw std::runtime_error("vulkan-1.dll is not installed on this machine");
    }
    return nullptr;
}

FARPROC WINAPI notify_hook(unsigned notification, PDelayLoadInfo info) {
    if (notification == dliNotePreLoadLibrary && is_vulkan(info)) {
        char buf[2];
        // GetEnvironmentVariableA returns the needed length; any non-empty
        // value means "pretend the DLL is missing". MD_NOTEPAD_NO_VULKAN is
        // the name from before the app was renamed to MD Specpad.
        if (GetEnvironmentVariableA("MD_SPECPAD_NO_VULKAN", buf, sizeof buf) > 0 ||
            GetEnvironmentVariableA("MD_NOTEPAD_NO_VULKAN", buf, sizeof buf) > 0) {
            throw std::runtime_error("MD_SPECPAD_NO_VULKAN is set; Vulkan disabled");
        }
    }
    return nullptr;
}

} // namespace

extern "C" const PfnDliHook __pfnDliFailureHook2 = failure_hook;
extern "C" const PfnDliHook __pfnDliNotifyHook2 = notify_hook;
