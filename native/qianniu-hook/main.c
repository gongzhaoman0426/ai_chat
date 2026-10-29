/* Same-user, same-integrity Qianniu loader. No elevation, UI, or process restart. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <stddef.h>
#include <stdint.h>
#include <wchar.h>

enum { INVALID_ARGUMENT = 2, WRONG_PROCESS = 3, WRONG_CONTEXT = 4,
       ACCESS_DENIED = 5, WRONG_ARCHITECTURE = 6, MISSING_LIBRARY = 7,
       LOADER_UNAVAILABLE = 8, WRITE_FAILED = 9, THREAD_FAILED = 10,
       LOAD_FAILED = 11, LOAD_TIMEOUT = 12 };

// These offsets are shared with remote-loader.S. All function addresses point
// into the target's own system modules; the copied code has no local imports.
typedef struct RemoteLoadRequest {
    uintptr_t load_library;
    uintptr_t get_last_error;
    uintptr_t path;
    uintptr_t module;
    DWORD last_error;
    DWORD complete;
} RemoteLoadRequest;

_Static_assert(sizeof(uintptr_t) == 8, "The Qianniu loader requires Win64.");
_Static_assert(offsetof(RemoteLoadRequest, load_library) == 0, "Loader ABI mismatch.");
_Static_assert(offsetof(RemoteLoadRequest, get_last_error) == 8, "Loader ABI mismatch.");
_Static_assert(offsetof(RemoteLoadRequest, path) == 16, "Loader ABI mismatch.");
_Static_assert(offsetof(RemoteLoadRequest, module) == 24, "Loader ABI mismatch.");
_Static_assert(offsetof(RemoteLoadRequest, last_error) == 32, "Loader ABI mismatch.");
_Static_assert(offsetof(RemoteLoadRequest, complete) == 36, "Loader ABI mismatch.");
_Static_assert(sizeof(RemoteLoadRequest) == 40, "Loader ABI mismatch.");

extern const unsigned char judesk_remote_loader_begin[];
extern const unsigned char judesk_remote_loader_end[];

static const wchar_t *file_name(const wchar_t *path) {
    const wchar_t *slash = wcsrchr(path, L'\\');
    return slash ? slash + 1 : path;
}

static BOOL same_context(HANDLE process) {
    HANDLE ours = NULL, theirs = NULL;
    BYTE our_user[256], their_user[256], our_integrity[256], their_integrity[256];
    DWORD size, our_session = 0, their_session = 0;
    BOOL ok = FALSE;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &ours) ||
        !OpenProcessToken(process, TOKEN_QUERY, &theirs)) goto done;
    if (!GetTokenInformation(ours, TokenUser, our_user, sizeof(our_user), &size) ||
        !GetTokenInformation(theirs, TokenUser, their_user, sizeof(their_user), &size) ||
        !EqualSid(((TOKEN_USER *)our_user)->User.Sid, ((TOKEN_USER *)their_user)->User.Sid)) goto done;
    if (!GetTokenInformation(ours, TokenIntegrityLevel, our_integrity, sizeof(our_integrity), &size) ||
        !GetTokenInformation(theirs, TokenIntegrityLevel, their_integrity, sizeof(their_integrity), &size) ||
        !EqualSid(((TOKEN_MANDATORY_LABEL *)our_integrity)->Label.Sid,
                  ((TOKEN_MANDATORY_LABEL *)their_integrity)->Label.Sid)) goto done;
    if (!GetTokenInformation(ours, TokenSessionId, &our_session, sizeof(our_session), &size) ||
        !GetTokenInformation(theirs, TokenSessionId, &their_session, sizeof(their_session), &size) ||
        our_session != their_session) goto done;
    ok = TRUE;
done:
    if (ours) CloseHandle(ours);
    if (theirs) CloseHandle(theirs);
    return ok;
}

static uintptr_t module_base(DWORD pid, const wchar_t *name, BOOL full_path) {
    // Windows can report ERROR_BAD_LENGTH while its loader list is changing.
    // Retry only that transient condition, with a fixed upper bound.
    for (unsigned int attempt = 0; attempt < 4; ++attempt) {
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid);
        DWORD error;
        if (snapshot == INVALID_HANDLE_VALUE) {
            error = GetLastError();
        } else {
            MODULEENTRY32W entry = { .dwSize = sizeof(entry) };
            uintptr_t address = 0;
            if (Module32FirstW(snapshot, &entry)) {
                do {
                    if (_wcsicmp(full_path ? entry.szExePath : entry.szModule, name) == 0) {
                        address = (uintptr_t)entry.modBaseAddr;
                        break;
                    }
                } while (Module32NextW(snapshot, &entry));
            }
            error = address ? ERROR_SUCCESS : GetLastError();
            CloseHandle(snapshot);
            if (address) return address;
        }
        if (error != ERROR_BAD_LENGTH || attempt == 3) return 0;
        Sleep(10);
    }
    return 0;
}

static uintptr_t remote_function(DWORD pid, FARPROC function) {
    HMODULE local_module = NULL;
    wchar_t image[32768];
    if (!function || !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)function, &local_module)) return 0;
    DWORD length = GetModuleFileNameW(local_module, image, 32768);
    if (!length || length >= 32768) return 0;
    // Export forwarders may place each function in a different containing DLL.
    // Resolve that DLL in the target rather than assuming identical ASLR bases.
    uintptr_t remote_module = module_base(pid, file_name(image), FALSE);
    return remote_module ? remote_module + (uintptr_t)function - (uintptr_t)local_module : 0;
}

static int load_hook(DWORD pid, const wchar_t *expected_path) {
    wchar_t image[32768], library[32768];
    DWORD size = 32768;
    int result = ACCESS_DENIED;
    HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_CREATE_THREAD |
                                 PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                                 FALSE, pid);
    HANDLE thread = NULL;
    LPVOID remote_data = NULL;
    LPVOID remote_code = NULL;
    if (!process) return result;
    if (!QueryFullProcessImageNameW(process, 0, image, &size) ||
        _wcsicmp(file_name(image), L"AliWorkbench.exe") != 0 ||
        _wcsicmp(image, expected_path) != 0) { result = WRONG_PROCESS; goto done; }
    if (!same_context(process)) { result = WRONG_CONTEXT; goto done; }
    typedef BOOL (WINAPI *IsWow64Process2Fn)(HANDLE, USHORT *, USHORT *);
    union { FARPROC generic; IsWow64Process2Fn typed; } architecture;
    architecture.generic = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2");
    USHORT machine = 0, native_machine = 0;
    if (!architecture.typed || !architecture.typed(process, &machine, &native_machine) ||
        (machine == IMAGE_FILE_MACHINE_UNKNOWN ? native_machine : machine) != IMAGE_FILE_MACHINE_AMD64) {
        result = WRONG_ARCHITECTURE; goto done;
    }
    size = GetModuleFileNameW(NULL, library, 32768);
    if (!size || size >= 32768) { result = MISSING_LIBRARY; goto done; }
    wchar_t *slash = wcsrchr(library, L'\\');
    if (!slash || (slash - library) + 15 >= 32768) {
        result = MISSING_LIBRARY; goto done;
    }
    wcscpy(slash + 1, L"QnQtMsg64.dll");
    DWORD attributes = GetFileAttributesW(library);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
        result = MISSING_LIBRARY; goto done;
    }
    // An existing hook owns its reconnection logic; never run DLL initialization twice.
    if (module_base(pid, L"QnQtMsg64.dll", FALSE)) { result = 0; goto done; }

    HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
    RemoteLoadRequest request = {
        .load_library = remote_function(pid, GetProcAddress(kernel, "LoadLibraryW")),
        .get_last_error = remote_function(pid, GetProcAddress(kernel, "GetLastError")),
    };
    if (!request.load_library || !request.get_last_error) {
        result = LOADER_UNAVAILABLE; goto done;
    }
    SIZE_T path_bytes = (wcslen(library) + 1) * sizeof(wchar_t), written = 0;
    SIZE_T code_bytes = (uintptr_t)judesk_remote_loader_end - (uintptr_t)judesk_remote_loader_begin;
    if (!code_bytes || code_bytes > 4096) { result = LOADER_UNAVAILABLE; goto done; }
    remote_data = VirtualAllocEx(process, NULL, sizeof(request) + path_bytes,
                                 MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    remote_code = VirtualAllocEx(process, NULL, code_bytes,
                                 MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    request.path = (uintptr_t)remote_data + sizeof(request);
    if (!remote_data || !remote_code ||
        !WriteProcessMemory(process, remote_data, &request, sizeof(request), &written) ||
        written != sizeof(request) ||
        !WriteProcessMemory(process, (LPVOID)request.path, library, path_bytes, &written) ||
        written != path_bytes ||
        !WriteProcessMemory(process, remote_code, judesk_remote_loader_begin, code_bytes, &written) ||
        written != code_bytes) {
        result = WRITE_FAILED; goto done;
    }
    DWORD previous_protection;
    if (!VirtualProtectEx(process, remote_code, code_bytes, PAGE_EXECUTE_READ, &previous_protection) ||
        !FlushInstructionCache(process, remote_code, code_bytes)) {
        result = WRITE_FAILED; goto done;
    }
    // A genuine Win64 thread routine calls LoadLibraryW with its own shadow
    // space and captures a full-width HMODULE. Never use a system API as entry.
    thread = CreateRemoteThread(process, NULL, 0, (LPTHREAD_START_ROUTINE)remote_code,
                                remote_data, 0, NULL);
    if (!thread) { result = THREAD_FAILED; goto done; }
    DWORD wait = WaitForSingleObject(thread, 20000);
    if (wait != WAIT_OBJECT_0) {
        // A timeout or failed wait does not prove the thread stopped. It may
        // still use either allocation; preserve both until target process exit.
        remote_data = NULL;
        remote_code = NULL;
        result = LOAD_TIMEOUT; goto done;
    }
    if (!ReadProcessMemory(process, remote_data, &request, sizeof(request), &written) ||
        written != sizeof(request)) { result = LOAD_FAILED; goto done; }
    // The thread exit DWORD cannot hold an x64 HMODULE. Confirm its completed
    // data result against the module actually loaded from the expected path.
    result = request.complete == 1 && request.module &&
             module_base(pid, library, TRUE) == request.module ? 0 : LOAD_FAILED;
done:
    if (remote_code) VirtualFreeEx(process, remote_code, 0, MEM_RELEASE);
    if (remote_data) VirtualFreeEx(process, remote_data, 0, MEM_RELEASE);
    if (thread) CloseHandle(thread);
    CloseHandle(process);
    return result;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
    (void)instance; (void)previous; (void)command; (void)show;
    // Suppress OS error dialog boxes; failures are reported by exit code to JuDesk.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return INVALID_ARGUMENT;
    int result = INVALID_ARGUMENT;
    if (argc == 3) {
        wchar_t *end = NULL;
        unsigned long pid = wcstoul(argv[1], &end, 10);
        if (pid && end && !*end && argv[1][0] != L'-' && argv[1][0] != L'+')
            result = load_hook((DWORD)pid, argv[2]);
    }
    LocalFree(argv);
    return result;
}
