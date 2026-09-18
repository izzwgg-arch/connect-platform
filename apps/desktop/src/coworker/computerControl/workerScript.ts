/**
 * THE LOOPCOM LOCAL WORKER — the Windows-side half of Loopcom Computer Control.
 *
 * One long-lived `powershell.exe -File loopcom-worker.ps1` process per app,
 * started lazily by `worker.ts`, that hosts a C# class compiled at start
 * (Add-Type, .NET Framework — nothing to install, ships with every Windows). It
 * speaks newline-delimited JSON on stdin/stdout:
 *
 *   → {"id":1,"op":"windows.list","args":{...}}
 *   ← {"id":1,"ok":true,"result":{...}}          (or ok:false,error,message)
 *   ← {"event":"input","kind":"mouse"|"key"|"escape"}   (hook events, unsolicited)
 *
 * What it does, and why it is ONE process:
 *   LAYER 2  UI Automation — windows, controls (a bounded, cached tree walk),
 *            invoke / set_value / get_value / select / toggle / expand / scroll /
 *            focus / wait_for — by element reference, NO cursor movement.
 *   LAYER 3  SendInput stamped with SCREEN_CONTROL_SIGNATURE in dwExtraInfo, and
 *            the low-level hook that reads that stamp back so our own events never
 *            pause us and the PERSON's always do (the 220 ms timing heuristic of
 *            2026-09-15 is gone). Screen/window/region capture for model vision.
 *   LAYER 1  App launch (alias table + shell-execute), window activate/close,
 *            elevated-window and secure-desktop detection.
 *
 * ⛔ THIS FILE DECIDES NOTHING. The runtime (policy core + ask-once session) has
 * already said yes before any op reaches here; the worker performs and reports.
 * ⛔ C# 5 ONLY (PowerShell 5.1 compiles with the .NET Framework compiler): no
 * string interpolation, no nameof, no expression-bodied members, no `out var`.
 * ⛔ Never swallow the hook (always CallNextHookEx) and never install it outside
 * a session (`hook.start`/`hook.stop`) — a global hook adds input latency.
 */

export const WORKER_PROTOCOL_VERSION = 3;

/** The magic marker in every injected event's dwExtraInfo (same constant as session.ts). */
export const SCREEN_CONTROL_SIGNATURE = 0x10_0c_c0_1c;

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class LoopcomWorker
{
    // ───────────────────────────── native ─────────────────────────────
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder s, int n, out int needed);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr tok);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr tok, int cls, out int info, int len, out int ret);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr mod, uint th);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    delegate IntPtr HookProc(int n, IntPtr w, IntPtr l);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001;
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    const uint WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104, WM_LBUTTONDOWN = 0x201, WM_RBUTTONDOWN = 0x204, WM_MBUTTONDOWN = 0x207, WM_MOUSEWHEEL = 0x20A, WM_QUIT = 0x12, WM_CLOSE = 0x10;
    const uint LLMHF_INJECTED = 0x1, LLKHF_INJECTED = 0x10;
    const int SW_RESTORE = 9, SW_SHOW = 5, SW_MINIMIZE = 6;
    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
    const uint GW_OWNER = 4;
    const int DWMWA_CLOAKED = 14;

    public static readonly long SIGNATURE = 0x100CC01CL;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 64 };
    static readonly object OutLock = new object();
    static readonly DateTime Started = DateTime.UtcNow;
    static long ownEvents = 0;
    static int snapshotSeq = 0;
    static readonly Dictionary<string, AutomationElement> Refs = new Dictionary<string, AutomationElement>();
    static readonly Dictionary<string, Dictionary<string, object>> RefMeta = new Dictionary<string, Dictionary<string, object>>();
    static readonly Queue<string> SnapshotOrder = new Queue<string>();
    const int MAX_SNAPSHOTS_KEPT = 6;

    public static void Init()
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
    }

    // ───────────────────────────── protocol ─────────────────────────────
    public static void Emit(string line) { lock (OutLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

    static string Ok(object id, object result) { return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } }); }
    static string Fail(object id, string error, string message) { return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", error }, { "message", message } }); }

    public static string Handle(string line)
    {
        object id = null;
        try
        {
            var req = Json.DeserializeObject(line) as Dictionary<string, object>;
            if (req == null) return Fail(null, "bad_request", "not an object");
            req.TryGetValue("id", out id);
            object opObj; req.TryGetValue("op", out opObj);
            string op = opObj as string ?? "";
            object argsObj; req.TryGetValue("args", out argsObj);
            var args = argsObj as Dictionary<string, object> ?? new Dictionary<string, object>();
            var r = Dispatch(op, args);
            return Ok(id, r);
        }
        catch (WorkerError we) { return Fail(id, we.Code, we.Message); }
        catch (ElementNotAvailableException) { return Fail(id, "stale_ref", "That control is no longer on screen. Read the window again."); }
        catch (Exception e) { return Fail(id, "worker_error", (e.GetType().Name + ": " + e.Message).Substring(0, Math.Min(400, (e.GetType().Name + ": " + e.Message).Length))); }
    }

    class WorkerError : Exception { public string Code; public WorkerError(string code, string msg) : base(msg) { Code = code; } }

    static object Dispatch(string op, Dictionary<string, object> a)
    {
        switch (op)
        {
            case "ping": return Ping();
            case "screen.info": return ScreenInfo();
            case "screen.capture": return Capture(a);
            case "windows.list": return WindowsList(a);
            case "windows.find": return WindowsFind(a);
            case "windows.activate": return WindowsActivate(a);
            case "windows.close": return WindowsClose(a);
            case "windows.minimize": return WindowsMinimize(a);
            case "windows.controls": return Controls(a);
            case "windows.find_control": return FindControl(a);
            case "windows.invoke": return Invoke(a);
            case "windows.set_value": return SetValue(a);
            case "windows.get_value": return GetValue(a);
            case "windows.select": return Select(a);
            case "windows.toggle": return Toggle(a);
            case "windows.expand": return Expand(a, true);
            case "windows.collapse": return Expand(a, false);
            case "windows.scroll": return ScrollCtl(a);
            case "windows.focus": return Focus(a);
            case "windows.wait_for_control": return WaitForControl(a);
            case "windows.foreground": return Foreground();
            case "input.move": return InputMove(a);
            case "input.click": return InputClick(a);
            case "input.scroll": return InputScroll(a);
            case "input.text": return InputText(a);
            case "input.key": return InputKey(a);
            case "hook.start": return HookStart();
            case "hook.stop": return HookStop();
            case "process.launch": return Launch(a);
            case "process.kill": return Kill(a);
            case "refs.clear": Refs.Clear(); RefMeta.Clear(); SnapshotOrder.Clear(); return new Dictionary<string, object> { { "cleared", true } };
            default: throw new WorkerError("unknown_op", "unknown op " + op);
        }
    }

    // ───────────────────────────── helpers ─────────────────────────────
    static string S(Dictionary<string, object> a, string k, string def) { object v; if (a.TryGetValue(k, out v) && v != null) return Convert.ToString(v); return def; }
    static int I(Dictionary<string, object> a, string k, int def) { object v; if (a.TryGetValue(k, out v) && v != null) { try { return Convert.ToInt32(v); } catch { } } return def; }
    static long L(Dictionary<string, object> a, string k, long def) { object v; if (a.TryGetValue(k, out v) && v != null) { try { return Convert.ToInt64(v); } catch { } } return def; }
    static double D(Dictionary<string, object> a, string k, double def) { object v; if (a.TryGetValue(k, out v) && v != null) { try { return Convert.ToDouble(v); } catch { } } return def; }
    static bool B(Dictionary<string, object> a, string k, bool def) { object v; if (a.TryGetValue(k, out v) && v != null) { if (v is bool) return (bool)v; var s = Convert.ToString(v); return s == "true" || s == "1"; } return def; }
    static bool Has(Dictionary<string, object> a, string k) { object v; return a.TryGetValue(k, out v) && v != null && !(v is string && ((string)v).Length == 0); }

    static Dictionary<string, object> Rect(RECT r) { return new Dictionary<string, object> { { "x", r.L }, { "y", r.T }, { "w", r.R - r.L }, { "h", r.B - r.T } }; }
    static Dictionary<string, object> Rect(System.Windows.Rect r)
    {
        if (r.IsEmpty || double.IsInfinity(r.X) || double.IsNaN(r.X)) return null;
        return new Dictionary<string, object> { { "x", (int)r.X }, { "y", (int)r.Y }, { "w", (int)r.Width }, { "h", (int)r.Height } };
    }

    static bool IsCloaked(IntPtr h) { int v; try { if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, 4) == 0) return v != 0; } catch { } return false; }

    static string WindowTitle(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    static string WindowClass(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
    static string ProcessName(uint pid) { try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }

    static bool IsElevatedWindow(IntPtr h)
    {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid == 0) return false;
        IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (p == IntPtr.Zero) return true; // cannot even query → treat as protected
        try
        {
            IntPtr tok;
            if (!OpenProcessToken(p, 0x0008, out tok)) return true; // TOKEN_QUERY
            try { int info, ret; if (GetTokenInformation(tok, 20, out info, 4, out ret)) return info != 0; return true; } // TokenElevation
            finally { CloseHandle(tok); }
        }
        finally { CloseHandle(p); }
    }

    static bool OnSecureDesktop()
    {
        IntPtr d = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
        if (d == IntPtr.Zero) return true; // cannot open the input desktop → UAC/lock screen
        try { var sb = new StringBuilder(256); int need; if (GetUserObjectInformation(d, 2, sb, 256, out need)) return !string.Equals(sb.ToString(), "Default", StringComparison.OrdinalIgnoreCase); return false; }
        finally { CloseDesktop(d); }
    }

    static Dictionary<string, object> Ping()
    {
        return new Dictionary<string, object> { { "pid", Process.GetCurrentProcess().Id }, { "uptimeMs", (long)(DateTime.UtcNow - Started).TotalMilliseconds }, { "hook", hookThread != null }, { "refs", Refs.Count }, { "ownEvents", ownEvents }, { "secureDesktop", OnSecureDesktop() }, { "protocol", 3 } };
    }

    // ───────────────────────────── screen ─────────────────────────────
    static Dictionary<string, object> ScreenInfo()
    {
        var list = new List<object>();
        foreach (var s in System.Windows.Forms.Screen.AllScreens)
        {
            list.Add(new Dictionary<string, object> { { "name", s.DeviceName }, { "primary", s.Primary }, { "x", s.Bounds.X }, { "y", s.Bounds.Y }, { "w", s.Bounds.Width }, { "h", s.Bounds.Height }, { "workW", s.WorkingArea.Width }, { "workH", s.WorkingArea.Height } });
        }
        return new Dictionary<string, object> { { "displays", list }, { "virtual", new Dictionary<string, object> { { "x", GetSystemMetrics(SM_XVIRTUALSCREEN) }, { "y", GetSystemMetrics(SM_YVIRTUALSCREEN) }, { "w", GetSystemMetrics(SM_CXVIRTUALSCREEN) }, { "h", GetSystemMetrics(SM_CYVIRTUALSCREEN) } } }, { "secureDesktop", OnSecureDesktop() } };
    }

    /** Capture the screen, a window (hwnd) or a region; downscale to maxWidth; jpeg|png; returns base64. */
    static Dictionary<string, object> Capture(Dictionary<string, object> a)
    {
        if (OnSecureDesktop()) throw new WorkerError("user_action_required", "Windows is showing a secure screen (an administrator prompt or the lock screen). Only you can act on it; the Coworker will continue afterwards.");
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN), vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        int x = vx, y = vy, w = vw, h = vh; string what = "screen";
        if (L(a, "hwnd", 0) != 0 || Has(a, "title") || Has(a, "process") || L(a, "pid", 0) != 0)
        {
            IntPtr wh = ResolveWindow(a, true);
            RECT r; if (!GetWindowRect(wh, out r)) throw new WorkerError("window_gone", "That window no longer exists.");
            x = r.L; y = r.T; w = r.R - r.L; h = r.B - r.T; what = "window";
            if (IsIconic(wh)) throw new WorkerError("window_minimized", "That window is minimized; activate it first.");
        }
        else if (Has(a, "x") && Has(a, "w"))
        {
            x = I(a, "x", 0); y = I(a, "y", 0); w = I(a, "w", 1); h = I(a, "h", 1); what = "region";
        }
        w = Math.Max(1, Math.Min(w, 8192)); h = Math.Max(1, Math.Min(h, 8192));
        int maxWidth = Math.Max(160, Math.Min(I(a, "maxWidth", 1280), 4096));
        string format = S(a, "format", "jpeg");
        int quality = Math.Max(20, Math.Min(I(a, "quality", 55), 95));
        int maxBytes = Math.Max(50000, I(a, "maxBytes", 500000));
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp)) { g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy); }
            Bitmap outBmp = bmp; bool disposeOut = false;
            if (w > maxWidth) { int nh = Math.Max(1, (int)Math.Round(h * (maxWidth / (double)w))); outBmp = new Bitmap(bmp, new Size(maxWidth, nh)); disposeOut = true; }
            try
            {
                byte[] bytes = null;
                if (format == "png") { using (var ms = new MemoryStream()) { outBmp.Save(ms, ImageFormat.Png); bytes = ms.ToArray(); } }
                else
                {
                    int q = quality;
                    while (true)
                    {
                        using (var ms = new MemoryStream()) { SaveJpeg(outBmp, ms, q); bytes = ms.ToArray(); }
                        if (bytes.Length <= maxBytes || q <= 25) break;
                        q -= 12;
                    }
                    if (bytes.Length > maxBytes && outBmp.Width > 1024)
                    {
                        var smaller = new Bitmap(outBmp, new Size(1024, Math.Max(1, (int)Math.Round(outBmp.Height * (1024.0 / outBmp.Width)))));
                        if (disposeOut) outBmp.Dispose();
                        outBmp = smaller; disposeOut = true;
                        using (var ms = new MemoryStream()) { SaveJpeg(outBmp, ms, 35); bytes = ms.ToArray(); }
                    }
                }
                return new Dictionary<string, object> { { "what", what }, { "x", x }, { "y", y }, { "w", w }, { "h", h }, { "width", outBmp.Width }, { "height", outBmp.Height }, { "format", format == "png" ? "image/png" : "image/jpeg" }, { "bytes", bytes.Length }, { "dataBase64", Convert.ToBase64String(bytes) } };
            }
            finally { if (disposeOut) outBmp.Dispose(); }
        }
    }
    static void SaveJpeg(Bitmap bmp, Stream s, int quality)
    {
        ImageCodecInfo codec = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
        var ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        bmp.Save(s, codec, ep);
    }

    // ───────────────────────────── windows ─────────────────────────────
    static List<Dictionary<string, object>> EnumTopLevel(bool includeMinimized)
    {
        var list = new List<Dictionary<string, object>>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            IntPtr owner = GetWindow(h, GW_OWNER);
            int ex = GetWindowLong(h, GWL_EXSTYLE);
            if ((ex & WS_EX_TOOLWINDOW) != 0) return true;
            if (IsCloaked(h)) return true;
            string title = WindowTitle(h);
            if (title.Length == 0) return true;
            if (!includeMinimized && IsIconic(h)) return true;
            RECT r; GetWindowRect(h, out r);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string cls = WindowClass(h);
            string host = "";
            if (cls == "ApplicationFrameWindow")
            {
                // a packaged (UWP) app: the frame belongs to ApplicationFrameHost; the app itself owns the CoreWindow inside
                IntPtr core = FindWindowEx(h, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
                if (core != IntPtr.Zero) { uint cpid; GetWindowThreadProcessId(core, out cpid); if (cpid != 0) { host = ProcessName(pid); pid = cpid; } }
            }
            var d = new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "title", title }, { "process", ProcessName(pid) }, { "pid", (long)pid }, { "className", cls }, { "rect", Rect(r) }, { "minimized", IsIconic(h) }, { "foreground", h == fg }, { "elevated", IsElevatedWindow(h) } };
            if (host.Length > 0) d["host"] = host;
            if (owner != IntPtr.Zero) { d["dialogOf"] = owner.ToInt64(); d["dialog"] = true; }
            list.Add(d);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static Dictionary<string, object> WindowsList(Dictionary<string, object> a)
    {
        var all = EnumTopLevel(B(a, "includeMinimized", true));
        string filter = S(a, "filter", "").Trim();
        var outList = new List<object>();
        foreach (var w in all)
        {
            if (filter.Length > 0)
            {
                string t = (string)w["title"], p = (string)w["process"];
                if (t.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0 && p.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
            }
            outList.Add(w);
            if (outList.Count >= 60) break;
        }
        return new Dictionary<string, object> { { "windows", outList }, { "count", outList.Count }, { "secureDesktop", OnSecureDesktop() } };
    }

    static IntPtr ResolveWindow(Dictionary<string, object> a, bool required)
    {
        long hwnd = L(a, "hwnd", 0);
        if (hwnd != 0) { var h = new IntPtr(hwnd); if (!IsWindow(h)) throw new WorkerError("window_gone", "That window no longer exists."); return h; }
        string title = S(a, "title", "").Trim(); string proc = S(a, "process", "").Trim(); long pid = L(a, "pid", 0);
        if (title.Length == 0 && proc.Length == 0 && pid == 0)
        {
            if (!required) return GetForegroundWindow();
            throw new WorkerError("no_window", "Say which window: by hwnd, title or process.");
        }
        Dictionary<string, object> best = null; int bestScore = -1;
        foreach (var w in EnumTopLevel(true))
        {
            int score = 0;
            string t = (string)w["title"], p = (string)w["process"];
            if (pid != 0) { if ((long)w["pid"] != pid) continue; score += 4; }
            if (proc.Length > 0) { if (!string.Equals(p, proc.Replace(".exe", ""), StringComparison.OrdinalIgnoreCase)) continue; score += 2; }
            if (title.Length > 0) { if (string.Equals(t, title, StringComparison.OrdinalIgnoreCase)) score += 3; else if (t.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) score += 1; else continue; }
            if ((bool)w["foreground"]) score += 1;
            if (score > bestScore) { bestScore = score; best = w; }
        }
        if (best == null) throw new WorkerError("window_not_found", "No open window matches " + (title.Length > 0 ? "\"" + title + "\"" : proc) + ". List the windows to see what is open.");
        return new IntPtr((long)best["hwnd"]);
    }

    static Dictionary<string, object> WindowsFind(Dictionary<string, object> a)
    {
        string title = S(a, "title", "").Trim(); string proc = S(a, "process", "").Trim(); long pid = L(a, "pid", 0);
        var matches = new List<object>();
        foreach (var w in EnumTopLevel(true))
        {
            string t = (string)w["title"], p = (string)w["process"];
            if (pid != 0 && (long)w["pid"] != pid) continue;
            if (proc.Length > 0 && !string.Equals(p, proc.Replace(".exe", ""), StringComparison.OrdinalIgnoreCase)) continue;
            if (title.Length > 0 && t.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
            matches.Add(w);
        }
        return new Dictionary<string, object> { { "windows", matches }, { "count", matches.Count } };
    }

    static Dictionary<string, object> WindowsActivate(Dictionary<string, object> a)
    {
        IntPtr h = ResolveWindow(a, true);
        if (IsElevatedWindow(h)) throw new WorkerError("elevated_target", "That window runs as administrator; Loopcom cannot control it from your normal account.");
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        uint pid; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        bool attached = false;
        try
        {
            if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
            // the ALT-tap that convinces Windows' foreground lock a user action happened
            keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
            BringWindowToTop(h); SetForegroundWindow(h); ShowWindow(h, SW_SHOW);
        }
        finally { if (attached) AttachThreadInput(me, fgThread, false); }
        Thread.Sleep(120);
        IntPtr fg = GetForegroundWindow();
        bool ok = fg == h || GetAncestor(fg, 2) == h || GetAncestor(h, 2) == fg;
        return new Dictionary<string, object> { { "activated", ok }, { "hwnd", h.ToInt64() }, { "title", WindowTitle(h) }, { "foregroundTitle", WindowTitle(fg) } };
    }

    static Dictionary<string, object> WindowsClose(Dictionary<string, object> a)
    {
        IntPtr h = ResolveWindow(a, true);
        string title = WindowTitle(h);
        PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 1500 && IsWindow(h) && IsWindowVisible(h)) Thread.Sleep(50);
        bool gone = !IsWindow(h) || !IsWindowVisible(h);
        return new Dictionary<string, object> { { "closed", gone }, { "title", title }, { "note", gone ? "" : "The window is still open — it may be asking whether to save. Read its controls." } };
    }

    static Dictionary<string, object> WindowsMinimize(Dictionary<string, object> a)
    {
        IntPtr h = ResolveWindow(a, true); ShowWindow(h, SW_MINIMIZE); Thread.Sleep(60);
        return new Dictionary<string, object> { { "minimized", IsIconic(h) }, { "title", WindowTitle(h) } };
    }

    static Dictionary<string, object> Foreground()
    {
        IntPtr h = GetForegroundWindow();
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        return new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "title", WindowTitle(h) }, { "process", ProcessName(pid) }, { "pid", (long)pid }, { "rect", Rect(r) }, { "secureDesktop", OnSecureDesktop() } };
    }

    // ───────────────────────────── UI Automation ─────────────────────────────
    static readonly HashSet<string> InteractiveTypes = new HashSet<string> { "Button", "Edit", "Document", "CheckBox", "RadioButton", "ComboBox", "ListItem", "MenuItem", "TabItem", "TreeItem", "Hyperlink", "Slider", "Spinner", "DataItem", "SplitButton", "MenuBar", "Menu", "List", "Tab", "Tree", "DataGrid", "Table", "ToolBar", "ScrollBar", "Header", "HeaderItem", "Text", "Image", "Group", "Window", "TitleBar", "StatusBar", "ProgressBar", "Custom", "Pane", "Calendar", "Thumb", "Separator", "ToolTip" };
    static readonly HashSet<string> NoiseTypes = new HashSet<string> { "Separator", "Thumb", "ToolTip", "ScrollBar" };

    static CacheRequest NewCache()
    {
        var cr = new CacheRequest();
        cr.TreeScope = TreeScope.Element;
        cr.AutomationElementMode = AutomationElementMode.Full;
        cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.AutomationIdProperty);
        cr.Add(AutomationElement.ClassNameProperty); cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.IsOffscreenProperty); cr.Add(AutomationElement.IsKeyboardFocusableProperty); cr.Add(AutomationElement.HasKeyboardFocusProperty);
        cr.Add(AutomationElement.IsPasswordProperty); cr.Add(AutomationElement.LocalizedControlTypeProperty); cr.Add(AutomationElement.NativeWindowHandleProperty);
        cr.Add(AutomationElement.IsInvokePatternAvailableProperty); cr.Add(AutomationElement.IsTogglePatternAvailableProperty); cr.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
        cr.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty); cr.Add(AutomationElement.IsValuePatternAvailableProperty); cr.Add(AutomationElement.IsScrollPatternAvailableProperty);
        cr.Add(AutomationElement.IsTextPatternAvailableProperty); cr.Add(AutomationElement.IsRangeValuePatternAvailableProperty); cr.Add(AutomationElement.IsSelectionPatternAvailableProperty);
        cr.Add(ValuePattern.ValueProperty); cr.Add(ValuePattern.IsReadOnlyProperty); cr.Add(TogglePattern.ToggleStateProperty); cr.Add(SelectionItemPattern.IsSelectedProperty); cr.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
        cr.Add(RangeValuePattern.ValueProperty);
        return cr;
    }

    static AutomationElement RootFor(Dictionary<string, object> a)
    {
        IntPtr h = ResolveWindow(a, false);
        if (h == IntPtr.Zero) throw new WorkerError("no_window", "No window is in front. List the windows and activate one.");
        var root = AutomationElement.FromHandle(h);
        if (root == null) throw new WorkerError("uia_unavailable", "That window does not expose its controls to UI Automation.");
        return root;
    }

    static string CT(AutomationElement e, bool cached)
    {
        try { var ct = cached ? e.Cached.ControlType : e.Current.ControlType; return ct.ProgrammaticName.Replace("ControlType.", ""); } catch { return ""; }
    }

    static object CachedOrNull(AutomationElement e, AutomationProperty p)
    {
        try { var v = e.GetCachedPropertyValue(p, true); if (v == AutomationElement.NotSupported) return null; return v; } catch { return null; }
    }

    static Dictionary<string, object> Describe(AutomationElement e, string refId, int depth, bool cached)
    {
        var d = new Dictionary<string, object>();
        d["ref"] = refId; d["depth"] = depth;
        string ct = CT(e, cached); d["type"] = ct;
        try { d["name"] = (cached ? e.Cached.Name : e.Current.Name) ?? ""; } catch { d["name"] = ""; }
        try { string aid = cached ? e.Cached.AutomationId : e.Current.AutomationId; if (!string.IsNullOrEmpty(aid)) d["automationId"] = aid; } catch { }
        try { string cls = cached ? e.Cached.ClassName : e.Current.ClassName; if (!string.IsNullOrEmpty(cls)) d["className"] = cls; } catch { }
        try { d["enabled"] = cached ? e.Cached.IsEnabled : e.Current.IsEnabled; } catch { d["enabled"] = true; }
        try { var r = Rect(cached ? e.Cached.BoundingRectangle : e.Current.BoundingRectangle); if (r != null) d["rect"] = r; } catch { }
        try { if (cached ? e.Cached.IsOffscreen : e.Current.IsOffscreen) d["offscreen"] = true; } catch { }
        try { if (cached ? e.Cached.HasKeyboardFocus : e.Current.HasKeyboardFocus) d["focused"] = true; } catch { }
        try { if (cached ? e.Cached.IsPassword : e.Current.IsPassword) d["password"] = true; } catch { }
        var pats = new List<object>();
        if (cached)
        {
            object v;
            if ((v = CachedOrNull(e, AutomationElement.IsInvokePatternAvailableProperty)) != null && (bool)v) pats.Add("invoke");
            if ((v = CachedOrNull(e, AutomationElement.IsTogglePatternAvailableProperty)) != null && (bool)v) { pats.Add("toggle"); var ts = CachedOrNull(e, TogglePattern.ToggleStateProperty); if (ts != null) d["checked"] = ts.ToString() == "On" ? (object)true : ts.ToString() == "Off" ? (object)false : "indeterminate"; }
            if ((v = CachedOrNull(e, AutomationElement.IsSelectionItemPatternAvailableProperty)) != null && (bool)v) { pats.Add("select"); var ss = CachedOrNull(e, SelectionItemPattern.IsSelectedProperty); if (ss != null) d["selected"] = (bool)ss; }
            if ((v = CachedOrNull(e, AutomationElement.IsExpandCollapsePatternAvailableProperty)) != null && (bool)v) { pats.Add("expand"); var es = CachedOrNull(e, ExpandCollapsePattern.ExpandCollapseStateProperty); if (es != null) d["expanded"] = es.ToString(); }
            if ((v = CachedOrNull(e, AutomationElement.IsValuePatternAvailableProperty)) != null && (bool)v)
            {
                pats.Add("value");
                bool pw = false; try { pw = e.Cached.IsPassword; } catch { }
                var val = CachedOrNull(e, ValuePattern.ValueProperty);
                if (val != null && !pw) { string sv = Convert.ToString(val); d["value"] = sv.Length > 500 ? sv.Substring(0, 500) + "…" : sv; }
                var ro = CachedOrNull(e, ValuePattern.IsReadOnlyProperty); if (ro != null && (bool)ro) d["readOnly"] = true;
            }
            if ((v = CachedOrNull(e, AutomationElement.IsRangeValuePatternAvailableProperty)) != null && (bool)v) { pats.Add("range"); var rv = CachedOrNull(e, RangeValuePattern.ValueProperty); if (rv != null) d["value"] = Convert.ToDouble(rv); }
            if ((v = CachedOrNull(e, AutomationElement.IsScrollPatternAvailableProperty)) != null && (bool)v) pats.Add("scroll");
            if ((v = CachedOrNull(e, AutomationElement.IsTextPatternAvailableProperty)) != null && (bool)v) pats.Add("text");
            if ((v = CachedOrNull(e, AutomationElement.IsSelectionPatternAvailableProperty)) != null && (bool)v) { pats.Add("selection"); if (!d.ContainsKey("value")) { try { var st = SelectedText(e); if (st != null) d["value"] = st; } catch { } } }
        }
        if (pats.Count > 0) d["can"] = pats;
        return d;
    }

    static void Remember(string refId, AutomationElement e, Dictionary<string, object> meta)
    {
        Refs[refId] = e; RefMeta[refId] = meta;
    }
    static void BeginSnapshot(string snapId)
    {
        SnapshotOrder.Enqueue(snapId);
        while (SnapshotOrder.Count > MAX_SNAPSHOTS_KEPT)
        {
            string old = SnapshotOrder.Dequeue();
            var dead = new List<string>();
            foreach (var k in Refs.Keys) if (k.StartsWith(old + "_")) dead.Add(k);
            foreach (var k in dead) { Refs.Remove(k); RefMeta.Remove(k); }
        }
    }

    /** Bounded BFS over the control view with a cache request. */
    static Dictionary<string, object> Controls(Dictionary<string, object> a)
    {
        if (OnSecureDesktop()) throw new WorkerError("user_action_required", "Windows is showing a secure screen (an administrator prompt or the lock screen). Only you can act on it; the Coworker will continue afterwards.");
        IntPtr h = ResolveWindow(a, false);
        if (h == IntPtr.Zero) throw new WorkerError("no_window", "No window is in front.");
        bool elevated = IsElevatedWindow(h);
        var root = AutomationElement.FromHandle(h);
        if (root == null) throw new WorkerError("uia_unavailable", "That window does not expose its controls to UI Automation.");
        int max = Math.Max(1, Math.Min(I(a, "maxControls", 150), 600));
        int maxDepth = Math.Max(1, Math.Min(I(a, "maxDepth", 24), 40));
        bool interactive = B(a, "interactive", true);
        bool includeOffscreen = B(a, "includeOffscreen", false);
        bool deep = B(a, "deep", false);
        int budgetMs = Math.Max(500, Math.Min(I(a, "budgetMs", 4000), 15000));
        string snapId = "e" + (++snapshotSeq);
        BeginSnapshot(snapId);
        var outList = new List<object>();
        int visited = 0, n = 0; bool truncated = false;
        var sw = Stopwatch.StartNew();
        var cr = NewCache();
        var walker = TreeWalker.ControlViewWalker;
        var queue = new Queue<KeyValuePair<AutomationElement, int>>();
        AutomationElement rootC;
        using (cr.Activate()) { rootC = root.GetUpdatedCache(cr); }
        queue.Enqueue(new KeyValuePair<AutomationElement, int>(rootC, 0));
        string windowTitle = ""; try { windowTitle = rootC.Cached.Name; } catch { }
        while (queue.Count > 0)
        {
            if (sw.ElapsedMilliseconds > budgetMs || visited > 3000) { truncated = true; break; }
            var kv = queue.Dequeue(); var e = kv.Key; int depth = kv.Value; visited++;
            string ct = CT(e, true);
            bool offscreen = false; try { offscreen = e.Cached.IsOffscreen; } catch { }
            string name = ""; try { name = e.Cached.Name ?? ""; } catch { }
            bool include = depth > 0;
            if (include && NoiseTypes.Contains(ct)) include = false;
            if (include && offscreen && !includeOffscreen) include = false;
            if (include && interactive)
            {
                if (ct == "Pane" || ct == "Custom" || ct == "Group") { bool focusable = false; try { focusable = e.Cached.IsKeyboardFocusable; } catch { } include = name.Length > 0 || focusable; }
                else if (ct == "Text" || ct == "Image") include = name.Length > 0 && name.Length <= 200;
                else if (ct == "Window" || ct == "TitleBar" || ct == "StatusBar") include = name.Length > 0;
                else if (!InteractiveTypes.Contains(ct)) include = name.Length > 0;
            }
            if (include)
            {
                n++;
                string refId = snapId + "_" + n;
                var d = Describe(e, refId, depth, true);
                Remember(refId, e, new Dictionary<string, object> { { "name", d["name"] }, { "type", ct }, { "hwnd", h.ToInt64() } });
                outList.Add(d);
                if (n >= max) { truncated = true; break; }
            }
            // descend — documents (browser pages, rich editors) are leaves unless deep
            if (depth >= maxDepth) continue;
            if (ct == "Document" && !deep && depth > 0) continue;
            if (ct == "ComboBox" && !deep) { /* items appear when expanded; keep the box itself */ }
            AutomationElement child = null;
            try { using (cr.Activate()) { child = walker.GetFirstChild(e, cr); } } catch { child = null; }
            int siblings = 0;
            while (child != null && siblings < 400)
            {
                queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, depth + 1)); siblings++;
                try { using (cr.Activate()) { child = walker.GetNextSibling(child, cr); } } catch { child = null; }
            }
        }
        var res = new Dictionary<string, object> { { "window", windowTitle }, { "hwnd", h.ToInt64() }, { "elevated", elevated }, { "controls", outList }, { "count", outList.Count }, { "visited", visited }, { "truncated", truncated }, { "ms", sw.ElapsedMilliseconds }, { "snapshot", snapId } };
        return res;
    }

    static Dictionary<string, object> FindControl(Dictionary<string, object> a)
    {
        var root = RootFor(a);
        string name = S(a, "name", "").Trim(); string type = S(a, "type", "").Trim(); string aid = S(a, "automationId", "").Trim(); string contains = S(a, "contains", "").Trim();
        if (name.Length == 0 && aid.Length == 0 && contains.Length == 0 && type.Length == 0) throw new WorkerError("no_criteria", "Give a name, automationId, contains or type.");
        int max = Math.Max(1, Math.Min(I(a, "max", 20), 100));
        var cr = NewCache(); cr.TreeScope = TreeScope.Element;
        var conds = new List<Condition>();
        if (aid.Length > 0) conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, aid));
        if (name.Length > 0) conds.Add(new PropertyCondition(AutomationElement.NameProperty, name, PropertyConditionFlags.IgnoreCase));
        Condition cond = conds.Count == 0 ? Condition.TrueCondition : conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray());
        AutomationElementCollection found;
        using (cr.Activate()) { found = root.FindAll(TreeScope.Descendants, cond); }
        string snapId = "e" + (++snapshotSeq); BeginSnapshot(snapId);
        var outList = new List<object>(); int n = 0;
        foreach (AutomationElement e in found)
        {
            string ct = CT(e, true);
            if (type.Length > 0 && !string.Equals(ct, type, StringComparison.OrdinalIgnoreCase)) continue;
            if (contains.Length > 0) { string nm = ""; try { nm = e.Cached.Name ?? ""; } catch { } if (nm.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) continue; }
            n++;
            string refId = snapId + "_" + n;
            var d = Describe(e, refId, -1, true);
            Remember(refId, e, new Dictionary<string, object> { { "name", d["name"] }, { "type", ct }, { "hwnd", 0L } });
            outList.Add(d);
            if (n >= max) break;
        }
        return new Dictionary<string, object> { { "controls", outList }, { "count", outList.Count }, { "snapshot", snapId } };
    }

    /** Which control types an action wants first when several share a name (a label "Name" beside an edit "Name"). */
    static readonly Dictionary<string, string[]> Prefer = new Dictionary<string, string[]> {
        { "edit", new[] { "Edit", "Document", "ComboBox", "Spinner" } },
        { "invoke", new[] { "Button", "MenuItem", "Hyperlink", "ListItem", "TabItem", "TreeItem", "SplitButton", "CheckBox", "RadioButton" } },
        { "toggle", new[] { "CheckBox", "Button", "MenuItem", "ListItem" } },
        { "select", new[] { "RadioButton", "TabItem", "ListItem", "TreeItem", "ComboBox", "List", "Tab", "Tree", "DataItem", "MenuItem" } },
        { "expand", new[] { "ComboBox", "TreeItem", "MenuItem", "Button", "Group" } },
        { "scroll", new[] { "List", "Document", "Pane", "Tree", "DataGrid", "Table", "Edit" } },
        { "focus", new[] { "Edit", "Document", "ComboBox", "Button", "CheckBox", "List" } }
    };

    static AutomationElement ByRef(Dictionary<string, object> a, out string refId) { return ByRef(a, "", out refId); }
    static AutomationElement ByRef(Dictionary<string, object> a, string prefer, out string refId)
    {
        refId = S(a, "ref", "").Trim();
        if (refId.Length == 0)
        {
            // by name (and optional type) within the window — ranked by the control kind the action needs
            string name = S(a, "name", "").Trim();
            if (name.Length == 0) throw new WorkerError("no_ref", "Give the control's ref (from the controls list) or its exact name.");
            var found = FindControl(new Dictionary<string, object> { { "name", name }, { "type", S(a, "type", "") }, { "hwnd", L(a, "hwnd", 0) }, { "title", S(a, "title", "") }, { "process", S(a, "process", "") }, { "max", 20 } });
            var list = (List<object>)found["controls"];
            if (list.Count == 0) throw new WorkerError("control_not_found", "No control named \"" + name + "\" in that window. Read the controls to see the names.");
            Dictionary<string, object> best = null; int bestScore = int.MinValue;
            string[] pref; if (!Prefer.TryGetValue(prefer, out pref)) pref = new string[0];
            foreach (var o in list)
            {
                var d = (Dictionary<string, object>)o;
                string ct = (string)d["type"];
                int score = 0;
                int idx = Array.IndexOf(pref, ct);
                if (idx >= 0) score += 100 - idx * 5;
                object en; if (d.TryGetValue("enabled", out en) && en is bool && (bool)en) score += 3;
                if (!d.ContainsKey("offscreen")) score += 2;
                if (ct == "Text") score -= 50; // a static label is almost never the target
                if (score > bestScore) { bestScore = score; best = d; }
            }
            refId = (string)best["ref"];
        }
        AutomationElement e;
        if (!Refs.TryGetValue(refId, out e)) throw new WorkerError("unknown_ref", "Unknown control ref " + refId + ". Read the window's controls again to get fresh refs.");
        try { var _ = e.Current.ControlType; } catch (ElementNotAvailableException) { Refs.Remove(refId); throw new WorkerError("stale_ref", "That control is no longer on screen. Read the window again."); }
        return e;
    }

    static Dictionary<string, object> State(AutomationElement e)
    {
        var cr = NewCache(); AutomationElement c;
        using (cr.Activate()) { c = e.GetUpdatedCache(cr); }
        var d = Describe(c, "", -1, true); d.Remove("ref"); d.Remove("depth");
        return d;
    }

    static void EnsureNotElevated(AutomationElement e)
    {
        try { if (!e.Current.IsEnabled) throw new WorkerError("control_disabled", "That control is disabled right now — usually a dialog is open in front of its window. List the windows (dialog:true) and deal with the dialog first."); } catch (WorkerError) { throw; } catch { }
        try { int nh = e.Current.NativeWindowHandle; if (nh != 0 && IsElevatedWindow(GetAncestor(new IntPtr(nh), 2))) throw new WorkerError("elevated_target", "That window runs as administrator; Loopcom cannot control it from your normal account."); } catch (WorkerError) { throw; } catch { }
    }

    static Dictionary<string, object> Invoke(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "invoke", out refId);
        EnsureNotElevated(e);
        string via = ""; object pat;
        string name = ""; try { name = e.Current.Name ?? ""; } catch { }
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); via = "invoke"; }
        else if (e.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); via = "toggle"; }
        else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); via = "select"; }
        else if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { var ec = (ExpandCollapsePattern)pat; if (ec.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ec.Expand(); else ec.Collapse(); via = "expand"; }
        else if (B(a, "allowClick", true))
        {
            // no pattern: a real click at the control's centre (cursor moves; stamped as ours)
            System.Windows.Rect r = e.Current.BoundingRectangle;
            if (r.IsEmpty || r.Width <= 0) throw new WorkerError("no_pattern", "That control cannot be pressed through UI Automation and has no on-screen area to click.");
            try { e.SetFocus(); } catch { }
            ClickPx((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", false);
            via = "click";
        }
        else throw new WorkerError("no_pattern", "That control cannot be pressed through UI Automation.");
        Thread.Sleep(I(a, "settleMs", 150));
        Dictionary<string, object> after = null; try { after = State(e); } catch { }
        var fg = Foreground();
        return new Dictionary<string, object> { { "invoked", true }, { "via", via }, { "ref", refId }, { "name", name }, { "after", after }, { "foreground", fg } };
    }

    static Dictionary<string, object> SetValue(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "edit", out refId);
        EnsureNotElevated(e);
        string value = S(a, "value", "");
        bool append = B(a, "append", false);
        bool pw = false; try { pw = e.Current.IsPassword; } catch { }
        string via = ""; object pat;
        bool done = false;
        if (!append && e.TryGetCurrentPattern(ValuePattern.Pattern, out pat))
        {
            var vp = (ValuePattern)pat;
            try { if (!vp.Current.IsReadOnly) { vp.SetValue(value); via = "value_pattern"; done = true; } } catch { done = false; }
        }
        if (!done)
        {
            // keyboard path: focus the control, select-all (unless appending), type as unicode
            try { e.SetFocus(); } catch { throw new WorkerError("cannot_focus", "That control cannot take keyboard focus."); }
            Thread.Sleep(80);
            if (!append) { KeyChord(new string[] { "ctrl" }, "a"); Thread.Sleep(40); }
            TypeText(value);
            via = "typed";
        }
        Thread.Sleep(I(a, "settleMs", 120));
        string readback = ReadText(e, 4000);
        bool verified = readback != null && (readback == value || (append && readback.EndsWith(value)) || readback.Replace("\r\n", "\n") == value.Replace("\r\n", "\n"));
        var res = new Dictionary<string, object> { { "set", true }, { "via", via }, { "ref", refId }, { "verified", verified } };
        if (!pw) res["readback"] = readback == null ? null : (readback.Length > 1000 ? readback.Substring(0, 1000) + "…" : readback);
        if (pw) res["password"] = true;
        return res;
    }

    /** The selected item's name for a combo/list (SelectionPattern), else the value. */
    static string SelectedText(AutomationElement e)
    {
        object pat;
        try { if (e.TryGetCurrentPattern(SelectionPattern.Pattern, out pat)) { var sel = ((SelectionPattern)pat).Current.GetSelection(); if (sel != null && sel.Length > 0) return sel[0].Current.Name; } } catch { }
        try { if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) return ((ValuePattern)pat).Current.Value; } catch { }
        return null;
    }

    static string ReadText(AutomationElement e, int max)
    {
        object pat;
        // a combo box / list answers with its selected item, not its label
        try { string ct = CT(e, false); if (ct == "ComboBox" || ct == "List" || ct == "Tree" || ct == "Tab" || ct == "DataGrid") { string st = SelectedText(e); if (st != null) return st; } } catch { }
        try { if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) { var v = ((ValuePattern)pat).Current.Value; if (v != null) return v.Length > max ? v.Substring(0, max) : v; } } catch { }
        try { if (e.TryGetCurrentPattern(TextPattern.Pattern, out pat)) { var t = ((TextPattern)pat).DocumentRange.GetText(max); if (t != null) return t; } } catch { }
        try { return e.Current.Name; } catch { return null; }
    }

    static Dictionary<string, object> GetValue(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "edit", out refId);
        bool pw = false; try { pw = e.Current.IsPassword; } catch { }
        Dictionary<string, object> st; try { st = State(e); } catch (Exception ex) { st = new Dictionary<string, object> { { "stateError", ex.GetType().Name } }; }
        if (pw) { st.Remove("value"); st["password"] = true; return new Dictionary<string, object> { { "ref", refId }, { "state", st }, { "text", null }, { "password", true } }; }
        string text = ReadText(e, Math.Max(1, Math.Min(I(a, "maxChars", 4000), 20000)));
        return new Dictionary<string, object> { { "ref", refId }, { "state", st }, { "text", text } };
    }

    static Dictionary<string, object> Select(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "select", out refId);
        EnsureNotElevated(e);
        string item = S(a, "item", "").Trim();
        object pat; string via = "";
        if (item.Length == 0)
        {
            if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); via = "select_item"; }
            else throw new WorkerError("not_selectable", "That control is not selectable; give an item name to choose inside it.");
        }
        else
        {
            // a container (ComboBox / List / Tab / Tree): expand if needed, find the item by name, select it
            ExpandCollapsePattern ec = null;
            if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { ec = (ExpandCollapsePattern)pat; try { if (ec.Current.ExpandCollapseState != ExpandCollapseState.Expanded) { ec.Expand(); Thread.Sleep(200); } } catch { } }
            var cond = new PropertyCondition(AutomationElement.NameProperty, item, PropertyConditionFlags.IgnoreCase);
            AutomationElement found = null;
            // the items may take a moment to appear after expanding
            for (int attempt = 0; attempt < 6 && found == null; attempt++)
            {
                found = e.FindFirst(TreeScope.Descendants, cond);
                if (found == null && ec != null)
                {
                    // Win32/WinForms combo boxes host their list in a separate popup window (ComboLBox): search the desktop's direct children for an open list
                    try
                    {
                        var lists = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.List));
                        foreach (AutomationElement lst in lists) { found = lst.FindFirst(TreeScope.Descendants, cond); if (found != null) break; }
                        if (found == null) { var panes = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "ComboLBox")); foreach (AutomationElement pn in panes) { found = pn.FindFirst(TreeScope.Descendants, cond); if (found != null) break; } }
                    }
                    catch { found = null; }
                }
                if (found == null) Thread.Sleep(100);
            }
            if (found == null)
            {
                // contains-match fallback
                var all = e.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                foreach (AutomationElement c in all) { string nm = ""; try { nm = c.Current.Name ?? ""; } catch { } if (nm.IndexOf(item, StringComparison.OrdinalIgnoreCase) >= 0) { found = c; break; } }
            }
            if (found == null)
            {
                bool okv = false;
                if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) { try { ((ValuePattern)pat).SetValue(item); via = "value"; okv = true; } catch { okv = false; } }
                if (!okv)
                {
                    // keyboard fallback: focus the box (collapse first so keys reach it) and type the item's text — Win32 combos select by typed prefix
                    if (ec != null) { try { ec.Collapse(); } catch { } }
                    try { e.SetFocus(); } catch { throw new WorkerError("item_not_found", "No item named \"" + item + "\" inside that control, and it cannot take keyboard focus."); }
                    Thread.Sleep(80);
                    foreach (char ch in item) { TypeChar(ch); Thread.Sleep(15); }
                    Thread.Sleep(120);
                    via = "typed";
                }
                string nowSel = SelectedText(e);
                if (nowSel == null || nowSel.IndexOf(item, StringComparison.OrdinalIgnoreCase) < 0) throw new WorkerError("item_not_found", "No item named \"" + item + "\" inside that control (it now shows \"" + (nowSel ?? "") + "\"). Read the control to see its items.");
            }
            else
            {
                if (found.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); via = "select_item"; }
                else if (found.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); via = "invoke_item"; }
                else { var r = found.Current.BoundingRectangle; if (!r.IsEmpty) { ClickPx((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", false); via = "click_item"; } else throw new WorkerError("item_not_selectable", "Found the item but it cannot be selected."); }
            }
            if (ec != null) { try { Thread.Sleep(120); if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse(); } catch { } }
        }
        Thread.Sleep(I(a, "settleMs", 120));
        return new Dictionary<string, object> { { "selected", true }, { "via", via }, { "ref", refId }, { "after", State(e) } };
    }

    static Dictionary<string, object> Toggle(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "toggle", out refId);
        EnsureNotElevated(e);
        object pat;
        if (!e.TryGetCurrentPattern(TogglePattern.Pattern, out pat))
        {
            if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); return new Dictionary<string, object> { { "toggled", true }, { "via", "select" }, { "after", State(e) } }; }
            throw new WorkerError("not_toggleable", "That control is not a checkbox or toggle.");
        }
        var tp = (TogglePattern)pat;
        bool? want = null; object wv; if (a.TryGetValue("state", out wv) && wv != null) want = B(a, "state", false);
        int guard = 0;
        while (guard++ < 3)
        {
            var cur = tp.Current.ToggleState;
            if (want == null) { tp.Toggle(); break; }
            if ((cur == ToggleState.On) == want.Value) break;
            tp.Toggle(); Thread.Sleep(60);
        }
        Thread.Sleep(I(a, "settleMs", 100));
        var st = tp.Current.ToggleState;
        return new Dictionary<string, object> { { "toggled", true }, { "via", "toggle" }, { "ref", refId }, { "checked", st == ToggleState.On ? (object)true : st == ToggleState.Off ? (object)false : "indeterminate" }, { "after", State(e) } };
    }

    static Dictionary<string, object> Expand(Dictionary<string, object> a, bool expand)
    {
        string refId; var e = ByRef(a, "expand", out refId);
        EnsureNotElevated(e);
        object pat;
        if (!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) throw new WorkerError("not_expandable", "That control cannot be expanded or collapsed.");
        var ec = (ExpandCollapsePattern)pat;
        if (expand) ec.Expand(); else ec.Collapse();
        Thread.Sleep(I(a, "settleMs", 150));
        return new Dictionary<string, object> { { "done", true }, { "state", ec.Current.ExpandCollapseState.ToString() }, { "ref", refId } };
    }

    static Dictionary<string, object> ScrollCtl(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "scroll", out refId);
        string dir = S(a, "direction", "down").ToLowerInvariant();
        int amount = Math.Max(1, Math.Min(I(a, "amount", 3), 50));
        object pat;
        if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out pat))
        {
            var sp = (ScrollPattern)pat;
            for (int i = 0; i < amount; i++)
            {
                ScrollAmount v = ScrollAmount.NoAmount, hz = ScrollAmount.NoAmount;
                if (dir == "down") v = ScrollAmount.SmallIncrement; else if (dir == "up") v = ScrollAmount.SmallDecrement; else if (dir == "right") hz = ScrollAmount.SmallIncrement; else if (dir == "left") hz = ScrollAmount.SmallDecrement;
                try { sp.Scroll(hz, v); } catch { break; }
            }
            return new Dictionary<string, object> { { "scrolled", true }, { "via", "scroll_pattern" }, { "vertical", sp.Current.VerticalScrollPercent }, { "horizontal", sp.Current.HorizontalScrollPercent } };
        }
        var r = e.Current.BoundingRectangle;
        if (r.IsEmpty) throw new WorkerError("not_scrollable", "That control cannot be scrolled.");
        int cx = (int)(r.X + r.Width / 2), cy = (int)(r.Y + r.Height / 2);
        int delta = (dir == "up" || dir == "left") ? 120 * amount : -120 * amount;
        MoveToPx(cx, cy);
        SendMouse(dir == "left" || dir == "right" ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta));
        return new Dictionary<string, object> { { "scrolled", true }, { "via", "wheel" } };
    }

    static Dictionary<string, object> Focus(Dictionary<string, object> a)
    {
        string refId; var e = ByRef(a, "focus", out refId);
        EnsureNotElevated(e);
        try { e.SetFocus(); } catch { throw new WorkerError("cannot_focus", "That control cannot take keyboard focus."); }
        Thread.Sleep(60);
        return new Dictionary<string, object> { { "focused", true }, { "ref", refId }, { "after", State(e) } };
    }

    static Dictionary<string, object> WaitForControl(Dictionary<string, object> a)
    {
        int timeout = Math.Max(100, Math.Min(I(a, "timeoutMs", 5000), 60000));
        var sw = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                var r = FindControl(a);
                if ((int)r["count"] > 0) { r["waitedMs"] = sw.ElapsedMilliseconds; r["found"] = true; return r; }
            }
            catch (WorkerError we) { if (we.Code != "window_not_found" && we.Code != "no_window") throw; }
            if (sw.ElapsedMilliseconds > timeout) return new Dictionary<string, object> { { "found", false }, { "waitedMs", sw.ElapsedMilliseconds }, { "controls", new List<object>() }, { "count", 0 } };
            Thread.Sleep(150);
        }
    }

    // ───────────────────────────── input (stamped SendInput) ─────────────────────────────
    static void SendMouse(uint flags, double fx, double fy, uint data)
    {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE; inputs[0].u.mi.dwFlags = flags; inputs[0].u.mi.mouseData = data; inputs[0].u.mi.dwExtraInfo = new IntPtr(SIGNATURE);
        if ((flags & MOUSEEVENTF_ABSOLUTE) != 0) { inputs[0].u.mi.dx = (int)Math.Round(fx * 65535.0); inputs[0].u.mi.dy = (int)Math.Round(fy * 65535.0); }
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Interlocked.Increment(ref ownEvents);
    }
    static void MoveToFrac(double fx, double fy) { SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, Clamp01(fx), Clamp01(fy), 0); }
    static double Clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    static void PxToFrac(int px, int py, out double fx, out double fy)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN), vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        fx = vw > 1 ? (px - vx) / (double)(vw - 1) : 0; fy = vh > 1 ? (py - vy) / (double)(vh - 1) : 0;
    }
    static void MoveToPx(int px, int py) { double fx, fy; PxToFrac(px, py, out fx, out fy); MoveToFrac(fx, fy); }
    static void Button(string button, bool down) { uint f; if (button == "right") f = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; else if (button == "middle") f = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; else f = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; SendMouse(f, 0, 0, 0); }
    static void ClickPx(int px, int py, string button, bool dbl) { MoveToPx(px, py); Thread.Sleep(20); Button(button, true); Button(button, false); if (dbl) { Thread.Sleep(40); Button(button, true); Button(button, false); } }
    static void TypeChar(char c)
    {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].u.ki.wScan = c; inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE; inputs[0].u.ki.dwExtraInfo = new IntPtr(SIGNATURE);
        inputs[1] = inputs[0]; inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        Interlocked.Add(ref ownEvents, 2);
    }
    static void TypeText(string text)
    {
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            if (ch == '\n') { VKey(0x0D, true); VKey(0x0D, false); continue; }
            if (ch == '\t') { VKey(0x09, true); VKey(0x09, false); continue; }
            TypeChar(ch);
        }
    }
    static void VKey(ushort vk, bool down)
    {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].u.ki.wVk = vk; inputs[0].u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP; inputs[0].u.ki.dwExtraInfo = new IntPtr(SIGNATURE);
        if (vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2E || vk == 0x2D || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22) inputs[0].u.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Interlocked.Increment(ref ownEvents);
    }
    static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort> {
        {"backspace",0x08},{"tab",0x09},{"enter",0x0D},{"return",0x0D},{"shift",0x10},{"ctrl",0x11},{"control",0x11},{"alt",0x12},{"pause",0x13},{"capslock",0x14},{"escape",0x1B},{"esc",0x1B},{"space",0x20},
        {"pageup",0x21},{"pagedown",0x22},{"end",0x23},{"home",0x24},{"left",0x25},{"up",0x26},{"right",0x27},{"down",0x28},{"printscreen",0x2C},{"insert",0x2D},{"delete",0x2E},{"del",0x2E},{"meta",0x5B},{"win",0x5B},{"windows",0x5B},
        {"f1",0x70},{"f2",0x71},{"f3",0x72},{"f4",0x73},{"f5",0x74},{"f6",0x75},{"f7",0x76},{"f8",0x77},{"f9",0x78},{"f10",0x79},{"f11",0x7A},{"f12",0x7B},
        {"0",0x30},{"1",0x31},{"2",0x32},{"3",0x33},{"4",0x34},{"5",0x35},{"6",0x36},{"7",0x37},{"8",0x38},{"9",0x39},
        {"a",0x41},{"b",0x42},{"c",0x43},{"d",0x44},{"e",0x45},{"f",0x46},{"g",0x47},{"h",0x48},{"i",0x49},{"j",0x4A},{"k",0x4B},{"l",0x4C},{"m",0x4D},{"n",0x4E},{"o",0x4F},{"p",0x50},{"q",0x51},{"r",0x52},{"s",0x53},{"t",0x54},{"u",0x55},{"v",0x56},{"w",0x57},{"x",0x58},{"y",0x59},{"z",0x5A}
    };
    static void KeyChord(string[] mods, string key)
    {
        var held = new List<ushort>();
        foreach (var m in mods) { ushort vk; if (VK.TryGetValue(m.ToLowerInvariant(), out vk)) { VKey(vk, true); held.Add(vk); } }
        ushort k; string kl = key.ToLowerInvariant();
        if (VK.TryGetValue(kl, out k)) { VKey(k, true); VKey(k, false); }
        else if (key.Length == 1) TypeChar(key[0]);
        for (int i = held.Count - 1; i >= 0; i--) VKey(held[i], false);
    }

    static void GuardInput()
    {
        if (OnSecureDesktop()) throw new WorkerError("user_action_required", "Windows is showing a secure screen (an administrator prompt or the lock screen). Only you can act on it; the Coworker will continue afterwards.");
        IntPtr fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && IsElevatedWindow(fg)) throw new WorkerError("elevated_target", "The window in front runs as administrator; Loopcom cannot type or click in it from your normal account.");
    }
    static void ResolvePoint(Dictionary<string, object> a, out double fx, out double fy)
    {
        string unit = S(a, "unit", "fraction");
        if (unit == "px") { PxToFrac(I(a, "x", 0), I(a, "y", 0), out fx, out fy); }
        else { fx = D(a, "x", double.NaN); fy = D(a, "y", double.NaN); }
        if (double.IsNaN(fx) || double.IsNaN(fy) || fx < 0 || fx > 1 || fy < 0 || fy > 1) throw new WorkerError("bad_point", "x and y must be fractions 0..1 of the screen (or pixels with unit px).");
    }
    static Dictionary<string, object> InputMove(Dictionary<string, object> a) { GuardInput(); double fx, fy; ResolvePoint(a, out fx, out fy); MoveToFrac(fx, fy); return new Dictionary<string, object> { { "moved", true } }; }
    static Dictionary<string, object> InputClick(Dictionary<string, object> a)
    {
        GuardInput(); double fx, fy; ResolvePoint(a, out fx, out fy);
        string button = S(a, "button", "left"); bool dbl = B(a, "double", false);
        var before = Foreground();
        MoveToFrac(fx, fy); Thread.Sleep(20); Button(button, true); Button(button, false);
        if (dbl) { Thread.Sleep(40); Button(button, true); Button(button, false); }
        Thread.Sleep(I(a, "settleMs", 150));
        return new Dictionary<string, object> { { "clicked", true }, { "button", button }, { "double", dbl }, { "foregroundBefore", before["title"] }, { "foreground", Foreground() } };
    }
    static Dictionary<string, object> InputScroll(Dictionary<string, object> a)
    {
        GuardInput(); double fx, fy; ResolvePoint(a, out fx, out fy);
        int delta = I(a, "deltaY", 0); if (delta == 0) throw new WorkerError("bad_scroll", "deltaY is required.");
        MoveToFrac(fx, fy); SendMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta));
        return new Dictionary<string, object> { { "scrolled", true } };
    }
    static Dictionary<string, object> InputText(Dictionary<string, object> a)
    {
        GuardInput(); string text = S(a, "text", ""); if (text.Length == 0) throw new WorkerError("bad_text", "text is required.");
        if (text.Length > 5000) throw new WorkerError("text_too_long", "Type at most 5000 characters at a time.");
        TypeText(text);
        return new Dictionary<string, object> { { "typed", text.Length }, { "foreground", Foreground() } };
    }
    static Dictionary<string, object> InputKey(Dictionary<string, object> a)
    {
        GuardInput(); string key = S(a, "key", ""); if (key.Length == 0) throw new WorkerError("bad_key", "key is required.");
        var mods = new List<string>(); object mo; if (a.TryGetValue("modifiers", out mo) && mo is System.Collections.IEnumerable) foreach (var m in (System.Collections.IEnumerable)mo) mods.Add(Convert.ToString(m));
        // safety: never Ctrl+Alt+Del / Win+L style chords from the model
        string kl = key.ToLowerInvariant();
        if (mods.Count >= 2 && kl == "delete") throw new WorkerError("refused_chord", "That key combination is reserved for you.");
        if (mods.Exists(m => m.ToLowerInvariant() == "win" || m.ToLowerInvariant() == "meta" || m.ToLowerInvariant() == "windows") && (kl == "l" || kl == "r" || kl == "x")) throw new WorkerError("refused_chord", "That key combination is reserved for you.");
        KeyChord(mods.ToArray(), key);
        return new Dictionary<string, object> { { "pressed", key }, { "modifiers", mods }, { "foreground", Foreground() } };
    }

    // ───────────────────────────── the yield + Escape hook ─────────────────────────────
    static Thread hookThread = null; static uint hookThreadId = 0; static IntPtr hm = IntPtr.Zero, hk = IntPtr.Zero;
    static HookProc mouseProc, keyProc; // kept alive for the GC
    static long lastMouseEmit = 0;

    static Dictionary<string, object> HookStart()
    {
        if (hookThread != null) return new Dictionary<string, object> { { "hook", true }, { "already", true } };
        var ready = new ManualResetEvent(false);
        hookThread = new Thread(delegate ()
        {
            hookThreadId = GetCurrentThreadId();
            mouseProc = MouseHook; keyProc = KeyHook;
            IntPtr mod = GetModuleHandle(null);
            hm = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0);
            hk = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, mod, 0);
            ready.Set();
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            if (hm != IntPtr.Zero) UnhookWindowsHookEx(hm); if (hk != IntPtr.Zero) UnhookWindowsHookEx(hk);
            hm = IntPtr.Zero; hk = IntPtr.Zero;
        });
        hookThread.IsBackground = true; hookThread.Start();
        ready.WaitOne(3000);
        return new Dictionary<string, object> { { "hook", hm != IntPtr.Zero && hk != IntPtr.Zero }, { "mouse", hm != IntPtr.Zero }, { "keyboard", hk != IntPtr.Zero } };
    }
    static Dictionary<string, object> HookStop()
    {
        if (hookThread == null) return new Dictionary<string, object> { { "hook", false } };
        PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        hookThread.Join(2000); hookThread = null;
        return new Dictionary<string, object> { { "hook", false } };
    }
    static IntPtr MouseHook(int n, IntPtr w, IntPtr l)
    {
        if (n >= 0)
        {
            try
            {
                var s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
                bool injected = (s.flags & LLMHF_INJECTED) != 0;
                bool own = injected && s.dwExtraInfo.ToInt64() == SIGNATURE;
                if (!own)
                {
                    uint m = (uint)w.ToInt64();
                    bool button = m == WM_LBUTTONDOWN || m == WM_RBUTTONDOWN || m == WM_MBUTTONDOWN || m == WM_MOUSEWHEEL;
                    long now = Environment.TickCount;
                    if (button || now - lastMouseEmit > 150) { lastMouseEmit = now; Emit("{\"event\":\"input\",\"kind\":\"mouse\",\"button\":" + (button ? "true" : "false") + ",\"injected\":" + (injected ? "true" : "false") + "}"); }
                }
            }
            catch { }
        }
        return CallNextHookEx(IntPtr.Zero, n, w, l);
    }
    static IntPtr KeyHook(int n, IntPtr w, IntPtr l)
    {
        if (n >= 0)
        {
            try
            {
                uint m = (uint)w.ToInt64();
                if (m == WM_KEYDOWN || m == WM_SYSKEYDOWN)
                {
                    var s = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
                    bool injected = (s.flags & LLKHF_INJECTED) != 0;
                    bool own = injected && s.dwExtraInfo.ToInt64() == SIGNATURE;
                    if (!own) Emit(s.vkCode == 0x1B ? "{\"event\":\"input\",\"kind\":\"escape\"}" : "{\"event\":\"input\",\"kind\":\"key\",\"injected\":" + (injected ? "true" : "false") + "}");
                }
            }
            catch { }
        }
        return CallNextHookEx(IntPtr.Zero, n, w, l);
    }

    // ───────────────────────────── processes ─────────────────────────────
    static readonly Dictionary<string, string[]> Aliases = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase) {
        {"notepad", new[]{"notepad.exe","Notepad"}}, {"calculator", new[]{"calc.exe","Calculator"}}, {"calc", new[]{"calc.exe","Calculator"}},
        {"explorer", new[]{"explorer.exe",""}}, {"file explorer", new[]{"explorer.exe",""}}, {"paint", new[]{"mspaint.exe","Paint"}}, {"mspaint", new[]{"mspaint.exe","Paint"}},
        {"wordpad", new[]{"wordpad.exe","WordPad"}}, {"settings", new[]{"ms-settings:","Settings"}}, {"windows settings", new[]{"ms-settings:","Settings"}},
        {"chrome", new[]{"chrome.exe",""}}, {"google chrome", new[]{"chrome.exe",""}}, {"edge", new[]{"msedge.exe",""}}, {"microsoft edge", new[]{"msedge.exe",""}},
        {"task manager", new[]{"taskmgr.exe","Task Manager"}}, {"snipping tool", new[]{"ms-screenclip:","Snipping Tool"}}, {"terminal", new[]{"wt.exe",""}}, {"powershell", new[]{"powershell.exe",""}},
        {"cmd", new[]{"cmd.exe",""}}, {"command prompt", new[]{"cmd.exe",""}}, {"control panel", new[]{"control.exe","Control Panel"}}, {"word", new[]{"winword.exe",""}}, {"excel", new[]{"excel.exe",""}},
        {"outlook", new[]{"outlook.exe",""}}, {"powerpoint", new[]{"powerpnt.exe",""}}, {"onenote", new[]{"onenote.exe",""}}, {"teams", new[]{"ms-teams.exe",""}}, {"quickbooks", new[]{"QBW.EXE",""}},
        {"loopcom", new[]{"Loopcom.exe","Loopcom"}}, {"clock", new[]{"ms-clock:",""}}, {"camera", new[]{"microsoft.windows.camera:",""}}, {"photos", new[]{"ms-photos:",""}}, {"mail", new[]{"outlookmail:",""}},
        {"sticky notes", new[]{"ms-stickynotes:",""}}, {"regedit", new[]{"regedit.exe","Registry Editor"}}, {"device manager", new[]{"devmgmt.msc",""}}, {"event viewer", new[]{"eventvwr.msc",""}}, {"services", new[]{"services.msc",""}}
    };

    static Dictionary<string, object> Launch(Dictionary<string, object> a)
    {
        string app = S(a, "app", "").Trim(); string args = S(a, "args", "").Trim(); string cwd = S(a, "cwd", "").Trim();
        int waitMs = Math.Max(0, Math.Min(I(a, "waitMs", 8000), 30000));
        if (app.Length == 0) throw new WorkerError("no_app", "Say which program to open.");
        string target = app; string expectTitle = "";
        string[] alias; if (Aliases.TryGetValue(app, out alias)) { target = alias[0]; expectTitle = alias[1]; }
        var beforeWins = new HashSet<long>(); foreach (var w in EnumTopLevel(true)) beforeWins.Add((long)w["hwnd"]);
        var psi = new ProcessStartInfo(target) { UseShellExecute = true };
        if (args.Length > 0) psi.Arguments = args;
        if (cwd.Length > 0) psi.WorkingDirectory = cwd;
        Process p;
        try { p = Process.Start(psi); }
        catch (System.ComponentModel.Win32Exception we) { throw new WorkerError("launch_failed", "Could not open " + app + ": " + we.Message); }
        int pid = 0; try { pid = p != null ? p.Id : 0; } catch { }
        Dictionary<string, object> win = null;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < waitMs)
        {
            Thread.Sleep(200);
            foreach (var w in EnumTopLevel(false))
            {
                long h = (long)w["hwnd"]; if (beforeWins.Contains(h)) continue;
                string t = (string)w["title"]; long wp = (long)w["pid"];
                bool match = (pid != 0 && wp == pid) || (expectTitle.Length > 0 && t.IndexOf(expectTitle, StringComparison.OrdinalIgnoreCase) >= 0) || (expectTitle.Length == 0 && pid == 0);
                if (!match && pid != 0) { try { var pp = Process.GetProcessById((int)wp); if (string.Equals(pp.ProcessName, Path.GetFileNameWithoutExtension(target), StringComparison.OrdinalIgnoreCase)) match = true; } catch { } }
                if (match) { win = w; break; }
            }
            if (win != null) break;
            // a launcher that exits at once (calc.exe → CalculatorApp.exe): accept any NEW window after 1.5 s
            if (win == null && sw.ElapsedMilliseconds > 1500) { foreach (var w in EnumTopLevel(false)) { if (!beforeWins.Contains((long)w["hwnd"])) { win = w; break; } } if (win != null) break; }
        }
        return new Dictionary<string, object> { { "launched", true }, { "app", app }, { "target", target }, { "pid", pid }, { "window", win }, { "waitedMs", sw.ElapsedMilliseconds }, { "note", win == null ? "No new window appeared yet; list the windows again in a moment." : "" } };
    }

    static Dictionary<string, object> Kill(Dictionary<string, object> a)
    {
        int pid = I(a, "pid", 0); string name = S(a, "name", "").Trim();
        var killed = new List<object>();
        var procs = new List<Process>();
        if (pid != 0) { try { procs.Add(Process.GetProcessById(pid)); } catch { throw new WorkerError("no_process", "No process with id " + pid + "."); } }
        else if (name.Length > 0) procs.AddRange(Process.GetProcessesByName(name.Replace(".exe", "")));
        else throw new WorkerError("no_target", "Give a pid or a process name.");
        if (procs.Count == 0) throw new WorkerError("no_process", "No running process named " + name + ".");
        foreach (var p in procs)
        {
            string pn = ""; try { pn = p.ProcessName; } catch { }
            if (string.Equals(pn, "Loopcom", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "csrss", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "winlogon", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "lsass", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "wininit", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "services", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "smss", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "explorer", StringComparison.OrdinalIgnoreCase) || string.Equals(pn, "powershell", StringComparison.OrdinalIgnoreCase) && p.Id == Process.GetCurrentProcess().Id)
                throw new WorkerError("protected_process", "The Coworker will not end " + pn + " — it is part of Windows or Loopcom itself.");
            try { p.CloseMainWindow(); if (!p.WaitForExit(1500)) p.Kill(); p.WaitForExit(3000); killed.Add(new Dictionary<string, object> { { "pid", p.Id }, { "name", pn }, { "exited", p.HasExited } }); }
            catch (Exception e) { killed.Add(new Dictionary<string, object> { { "pid", p.Id }, { "name", pn }, { "exited", false }, { "error", e.Message } }); }
        }
        return new Dictionary<string, object> { { "killed", killed } };
    }
}
`;

/** The whole worker script: compile the class, then loop over stdin. */
export const WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms, System.Web.Extensions, WindowsBase
  Add-Type -TypeDefinition @'
` + CSHARP + String.raw`
'@ -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms, System.Web.Extensions, WindowsBase
  [LoopcomWorker]::Init()
  [Console]::Out.WriteLine('{"event":"ready","protocol":' + ${WORKER_PROTOCOL_VERSION} + ',"pid":' + $PID + '}')
  [Console]::Out.Flush()
} catch {
  [Console]::Out.WriteLine('{"event":"fatal","message":' + (($_.Exception.Message) | ConvertTo-Json) + '}')
  [Console]::Out.Flush()
  exit 3
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  if ($line.Trim() -eq '{"op":"exit"}') { break }
  $out = [LoopcomWorker]::Handle($line)
  [LoopcomWorker]::Emit($out)
}
try { [LoopcomWorker]::Handle('{"op":"hook.stop"}') | Out-Null } catch {}
exit 0
`;
