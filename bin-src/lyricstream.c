/* lyricstream.c — 网易云歌词通道(共享内存) → 行式 JSON 事件流
 *
 * 用法: lyricstream.exe [--json] [--shm <name>] [--evt <name>] [--duration <秒>] [--log <文件>]
 *
 * 事件（每行一个 JSON，UTF-8，立即 flush）：
 *   {"type":"hello","version":1,"pid":N,"shm":"...","evt":"..."}
 *   {"type":"status","state":"waiting-shm|attached|lost","netEase":true|false,"desktopLyrics":N,"visible":N}
 *   {"type":"track","raw":"...","song":"...","artist":"..."}
 *   {"type":"line","seq":N,"ts":"YYYY-MM-DD HH:MM:SS","text":"..."}
 *   {"type":"tick","seq":N,"ts":"..."}        // 重绘心跳：文本未变但仍被触发（用于活跃度/暂停判断）
 *
 * 说明：
 *  - 只读附加优先（写端可能是更高完整性级别的进程，Low IL 申请 FILE_MAP_WRITE 会被拒 err=5）
 *  - 不做原文/译文配对：保持原始序列，配对交由 host 侧决定
 *  - 通道默认沿用 JDLyrics 的 Local\NeteaseLyricsBuffer / Local\NeteaseLyricsEvent，
 *    可用环境变量或参数覆盖（便于隔离测试）
 */
#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <wchar.h>

#define SHM_SIZE 0x10000

static WCHAR g_shm[256] = L"Local\\NeteaseLyricsBuffer";
static WCHAR g_evt[256] = L"Local\\NeteaseLyricsEvent";
static FILE *g_log = NULL;
static int g_seq = 0;
static int g_ticks = 0;

/* ---------------- 输出 ---------------- */
static void Emit(const char *json) {
    fputs(json, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    if (g_log) { fputs(json, g_log); fputc('\n', g_log); fflush(g_log); }
}

/* 把 UTF-8 文本转义进 JSON 字符串（不含外层引号） */
static void EscapeInto(const char *src, char *dst, size_t cap) {
    size_t e = 0;
    for (const unsigned char *q = (const unsigned char *)src; *q && e + 8 < cap; q++) {
        if (*q == '"' || *q == '\\') { dst[e++] = '\\'; dst[e++] = (char)*q; }
        else if (*q == '\t') { dst[e++] = '\\'; dst[e++] = 't'; }
        else if (*q < 0x20) { e += (size_t)_snprintf_s(dst + e, cap - e, _TRUNCATE, "\\u%04x", *q); }
        else dst[e++] = (char)*q;
    }
    dst[e] = 0;
}

/* 宽字符串转 UTF-8 后转义 */
static void EscapeW(const WCHAR *src, char *dst, size_t cap) {
    char utf8[4096];
    int n = WideCharToMultiByte(CP_UTF8, 0, src, -1, utf8, (int)sizeof(utf8) - 1, NULL, NULL);
    if (n <= 0) { dst[0] = 0; return; }
    utf8[n] = 0;
    EscapeInto(utf8, dst, cap);
}

/* ---------------- 通道名 ---------------- */
static void LoadNames(int argc, char **argv) {
    char v[256];
    if (GetEnvironmentVariableA("LYRIC_SHM_NAME", v, sizeof(v)) > 0)
        MultiByteToWideChar(CP_ACP, 0, v, -1, g_shm, 256);
    if (GetEnvironmentVariableA("LYRIC_EVT_NAME", v, sizeof(v)) > 0)
        MultiByteToWideChar(CP_ACP, 0, v, -1, g_evt, 256);
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--shm") == 0 && i + 1 < argc)
            MultiByteToWideChar(CP_ACP, 0, argv[++i], -1, g_shm, 256);
        else if (strcmp(argv[i], "--evt") == 0 && i + 1 < argc)
            MultiByteToWideChar(CP_ACP, 0, argv[++i], -1, g_evt, 256);
    }
}

/* ---------------- 进程/窗口探测 ---------------- */
static int NetEaseRunning(void) {
    return -1; /* 停用：沙箱下进程快照看不到网易云，见上方注释 */
}

/* DesktopLyrics 窗口统计 + 网易云窗口标题（用于取歌名/歌手） */
typedef struct {
    int dlFound, dlVisible;
    HWND dlHwnd; /* 可见的 DesktopLyrics 窗口句柄：网易云重启后它会变，host 用它判断播放器换了 */
    WCHAR title[512];
} ProbeCtx;

static BOOL CALLBACK ProbeProc(HWND hwnd, LPARAM lp) {
    ProbeCtx *c = (ProbeCtx *)lp;
    WCHAR cls[256] = {0};
    GetClassNameW(hwnd, cls, 255);
    if (wcscmp(cls, L"DesktopLyrics") == 0) {
        c->dlFound++;
        if (IsWindowVisible(hwnd)) {
            c->dlVisible++;
            if (!c->dlHwnd) c->dlHwnd = hwnd;
        }
    }
    /* 网易云的迷你播放器 / 浏览器宿主窗口标题就是 "歌名 - 歌手" */
    if (!c->title[0] &&
        (wcscmp(cls, L"OrpheusBrowserHost") == 0 || wcscmp(cls, L"MiniPlayer") == 0) &&
        IsWindowVisible(hwnd)) {
        if (GetWindowTextW(hwnd, c->title, 511) <= 0) c->title[0] = 0;
    }
    return TRUE;
}

static void Probe(ProbeCtx *c) {
    memset(c, 0, sizeof(*c));
    EnumWindows(ProbeProc, (LPARAM)c);
}

/* "歌名 - 歌手" 解析：取最后一个 " - " 之前为歌名，之后为歌手；解析不出就让 song=raw */
static void SplitTrack(const WCHAR *raw, WCHAR *song, size_t songCap, WCHAR *artist, size_t artistCap) {
    song[0] = 0; artist[0] = 0;
    const WCHAR *sep = NULL;
    for (const WCHAR *p = raw; *p; p++) {
        if (p[0] == L' ' && p[1] == L'-' && p[2] == L' ') sep = p;
    }
    if (!sep) { wcsncpy_s(song, songCap, raw, _TRUNCATE); return; }
    size_t n = (size_t)(sep - raw);
    if (n >= songCap) n = songCap - 1;
    wmemcpy(song, raw, n);
    song[n] = 0;
    wcsncpy_s(artist, artistCap, sep + 3, _TRUNCATE);
}

/* ---------------- 主循环 ---------------- */
int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    LoadNames(argc, argv);

    int duration = 0; /* 0 = 常驻 */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) duration = atoi(argv[++i]);
        else if (strcmp(argv[i], "--log") == 0 && i + 1 < argc) g_log = fopen(argv[++i], "a");
    }

    char json[8192 + 512];
    char esc[8192];
    char shmEsc[600], evtEsc[600];
    EscapeW(g_shm, shmEsc, sizeof(shmEsc));
    EscapeW(g_evt, evtEsc, sizeof(evtEsc));
    _snprintf_s(json, sizeof(json), _TRUNCATE,
                "{\"type\":\"hello\",\"version\":1,\"pid\":%lu,\"shm\":\"%s\",\"evt\":\"%s\"}",
                GetCurrentProcessId(), shmEsc, evtEsc);
    Emit(json);

    HANDLE map = NULL, evt = NULL;
    BYTE *view = NULL;
    char last[SHM_SIZE];
    last[0] = 0;
    int attached = 0;
    int createdByUs = -1;
    int lastAttached = -1, lastDlFound = -1, lastDlVisible = -1;
    HWND lastDlHwnd = NULL;
    WCHAR lastTitle[512] = L"";
    DWORD lastTickEmit = 0;
    DWORD lastProbe = 0;
    DWORD lastAlive = GetTickCount();
    DWORD lastEventTick = GetTickCount();
    ProbeCtx probe;
    memset(&probe, 0, sizeof(probe));

    DWORD deadline = duration ? GetTickCount() + (DWORD)duration * 1000 : 0;

    for (;;) {
        if (deadline) {
            if ((int)(deadline - GetTickCount()) <= 0) break;
        }

        /* 1) 通道未就绪：尝试附加（只读优先） */
        if (!map) {
            createdByUs = 0;

            map = OpenFileMappingW(FILE_MAP_READ, FALSE, g_shm);
            if (map) {
                view = (BYTE *)MapViewOfFile(map, FILE_MAP_READ, 0, 0, SHM_SIZE);
                if (!view) { CloseHandle(map); map = NULL; }
            } else {
                createdByUs = 1;

                map = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, SHM_SIZE, g_shm);
                if (map) {
                    view = (BYTE *)MapViewOfFile(map, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, SHM_SIZE);
                    if (!view) { CloseHandle(map); map = NULL; }
                }
            }
            if (map && view) {
                if (!evt) evt = OpenEventW(SYNCHRONIZE, FALSE, g_evt);
                if (!evt) evt = CreateEventW(NULL, FALSE, FALSE, g_evt);
                if (evt) {
                    attached = 1;
                    last[0] = 0;
                } else {
                    UnmapViewOfFile(view); CloseHandle(map); map = NULL; view = NULL;
                }
            }
        }

        /* 2) 周期探测：桌面歌词窗口 / 曲目标题 / 状态心跳 */
        DWORD now = GetTickCount();
        if (now - lastProbe > 1000 || lastProbe == 0) {
            lastProbe = now;
            Probe(&probe);

            if (probe.dlFound != lastDlFound || probe.dlVisible != lastDlVisible ||
                attached != lastAttached || probe.dlHwnd != lastDlHwnd) {
                DWORD idle = (now - lastEventTick) / 1000;
                _snprintf_s(json, sizeof(json), _TRUNCATE,
                            "{\"type\":\"status\",\"state\":\"%s\",\"created\":%s,\"desktopLyrics\":%d,\"visible\":%d,\"dlHwnd\":\"0x%llX\",\"idleSecs\":%lu,\"lines\":%d}",
                            attached ? "attached" : "waiting-shm",
                            createdByUs == 1 ? "true" : "false",
                            probe.dlFound, probe.dlVisible,
                            (unsigned long long)(ULONG_PTR)probe.dlHwnd, idle, g_seq);
                Emit(json);
                lastDlFound = probe.dlFound;
                lastDlVisible = probe.dlVisible;
                lastDlHwnd = probe.dlHwnd;
                lastAttached = attached;
            }

            if (probe.title[0] && wcscmp(probe.title, lastTitle) != 0) {
                WCHAR song[512], artist[512];
                SplitTrack(probe.title, song, 512, artist, 512);
                char rawEsc[2048], songEsc[2048], artistEsc[2048];
                EscapeW(probe.title, rawEsc, sizeof(rawEsc));
                EscapeW(song, songEsc, sizeof(songEsc));
                EscapeW(artist, artistEsc, sizeof(artistEsc));
                _snprintf_s(json, sizeof(json), _TRUNCATE,
                            "{\"type\":\"track\",\"raw\":\"%s\",\"song\":\"%s\",\"artist\":\"%s\"}",
                            rawEsc, songEsc, artistEsc);
                Emit(json);
                wcscpy_s(lastTitle, 512, probe.title);
            }

            /* 存活心跳（30s）：host 用它判断 helper 是否卡死 */
            if (now - lastAlive > 30000) {
                lastAlive = now;
                _snprintf_s(json, sizeof(json), _TRUNCATE,
                            "{\"type\":\"alive\",\"uptimeSecs\":%lu,\"attached\":%s,\"lines\":%d,\"ticks\":%d,\"desktopLyrics\":%d,\"visible\":%d}",
                            now / 1000, attached ? "true" : "false", g_seq, g_ticks,
                            probe.dlFound, probe.dlVisible);
                Emit(json);
            }
        }

        /* 3) 等事件 */
        if (!evt) { Sleep(300); continue; }
        DWORD r = WaitForSingleObject(evt, 800);
        if (r != WAIT_OBJECT_0) continue; /* 超时：回到探测 */

        const char *s = (const char *)view;
        if (!s || s[0] == 0) continue;

        /* 载荷 = "YYYY-MM-DD HH:MM:SS\n歌词文本" */
        const char *nl = strchr(s, '\n');
        char stamp[64] = {0};
        const char *text = s;
        if (nl) {
            size_t n = (size_t)(nl - s);
            if (n >= sizeof(stamp)) n = sizeof(stamp) - 1;
            memcpy(stamp, s, n);
            stamp[n] = 0;
            text = nl + 1;
        }

        lastEventTick = GetTickCount();

        if (strcmp(s, last) == 0) {
            /* 同文本重绘 → tick（限流 1 次/秒） */
            g_ticks++;
            if (GetTickCount() - lastTickEmit >= 1000) {
                lastTickEmit = GetTickCount();
                _snprintf_s(json, sizeof(json), _TRUNCATE,
                            "{\"type\":\"tick\",\"seq\":%d,\"ts\":\"%s\"}", g_seq, stamp);
                Emit(json);
            }
            continue;
        }
        strncpy_s(last, sizeof(last), s, _TRUNCATE);

        EscapeInto(text, esc, sizeof(esc));
        _snprintf_s(json, sizeof(json), _TRUNCATE,
                    "{\"type\":\"line\",\"seq\":%d,\"ts\":\"%s\",\"text\":\"%s\"}",
                    ++g_seq, stamp, esc);
        Emit(json);
    }

    if (view) UnmapViewOfFile(view);
    if (map) CloseHandle(map);
    if (evt) CloseHandle(evt);
    if (g_log) fclose(g_log);
    return 0;
}
