// Flagman.exe в корне папки программы: запускает настоящее окно склада app\Flagman.exe и сразу выходит.
// Electron работает только рядом со своими двумя десятками файлов — они в app\, а в корне человек видит
// одну программу, батники и README. Иконку и описание build.mjs вписывает при сборке архива.
// Пересобрать (на маке, Zig из pip: python3 -m pip install ziglang==0.13.0):
//   python3 -m ziglang cc -target x86_64-windows-gnu -O2 -s -municode -Wl,--subsystem,windows launcher.c -o Flagman.exe
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

#define LEN (MAX_PATH * 8)

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE prev, PWSTR args, int show) {
    (void) instance; (void) prev; (void) args; (void) show;
    static wchar_t dir[LEN], exe[LEN], cmd[LEN + 2];

    DWORD n = GetModuleFileNameW(NULL, dir, LEN);
    if (n == 0 || n >= LEN - 32) return 1;
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) *slash = L'\0';
    wcscat(dir, L"\\app");

    wcscpy(exe, dir);
    wcscat(exe, L"\\Flagman.exe");
    wcscpy(cmd, L"\"");
    wcscat(cmd, exe);
    wcscat(cmd, L"\"");

    STARTUPINFOW si = { .cb = sizeof si };
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        MessageBoxW(NULL, L"Не найдена папка app рядом с Flagman.exe.\n\nРаспакуйте архив заново целиком.",
                    L"Флагман", MB_ICONERROR | MB_OK);
        return 1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
