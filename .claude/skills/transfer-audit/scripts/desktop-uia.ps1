# desktop-uia.ps1: the transfer-audit skill's Windows UI Automation helper for
# the Floe desktop app (a Wails v2 window whose content is a WebView2 page).
#
# It never launches Floe. lib/desktop.mjs starts the app and talks to this
# helper over a JSON line protocol; every command here is a provider-side UIA
# call (InvokePattern, ValuePattern), a read of the accessibility tree, or a
# Win32 call that needs no foreground focus (PostMessage WM_CLOSE, PrintWindow,
# ShowWindow SW_SHOWNOACTIVATE). Nothing here moves the cursor, synthesizes
# keystrokes, activates a window, or reads or writes the paste buffer; the
# self-test's FORBIDDEN list below names the Win32 and cmdlet APIs the file
# must not contain, and it also asserts that the only PostMessageW call site
# is the WM_CLOSE one. The one exception is documented on `stage`.
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#       -File desktop-uia.ps1 -Serve [-Root <dir>]
#                                          one JSON request per stdin line;
#                                          with -Root, capture refuses any
#                                          path outside that directory
#   powershell.exe ... -File desktop-uia.ps1 -SelfTest   exit 0 pass, 1 fail
#
# Protocol (UTF-8, one object per line, ConvertTo-Json -Compress -Depth 6):
#   request   {"id":7,"cmd":"set-value","hwnd":1968,"placeholder":"amber-otter-cloud","value":"x"}
#   response  {"id":7,"ok":true,"ms":180,...command fields...}
#   error     {"id":7,"ok":false,"ms":12,"reason":"not-found","detail":"..."}
# reason is one of: not-found, ambiguous, read-only, disabled, no-pattern,
# timeout, offscreen, bad-request, unknown-cmd, no-single-instance-window,
# mode-not-allowed, not-a-window, printwindow-failed, exception. A request
# that does not parse still gets its id back when the line carries one, so
# the Node side never waits a full timeout on a framing slip. A malformed
# parameter (a non-numeric hwnd, max, index or timeoutMs, an invalid regex,
# a capture path outside -Root) is bad-request, which the client never
# retries; exception is reserved for the unexpected.
#
# Commands (hwnd is the top-level window handle from find-window):
#   ping                                  -> pong, pid, ps
#   find-window {class?, title?, pid?, timeoutMs?}
#                                         -> hwnd, pid, exe, class, title, rect{l,t,r,b,w,h}, minimized, visible, count
#                                            defaults: class wailsWindow, title Floe (desktop/main.go:86);
#                                            an empty class or title means any (pid alone is a valid filter)
#   wait-tree {hwnd, name?, controlType?, timeoutMs?}
#                                         -> ready, nodes, waitedMs
#                                            default name Settings (TitleBar.tsx aria-label, on every screen)
#   snapshot {hwnd, max?}                 -> count, truncated, items[{i,type,name,help,enabled}]
#   click {hwnd, name, controlType?, index?, after?, timeoutMs?}
#                                         -> via (invoke|toggle|select), type, index, count, runtimeId
#                                            name matches ignoring case; index -1 = last match;
#                                            `after` = a placeholder; only matches after that Edit count
#   set-value {hwnd, placeholder, value, scope?, settleMs?}
#                                         -> before, after, matchedBy (name|help), runtimeId
#   get-value {hwnd, placeholder, scope?} -> value, matchedBy, runtimeId
#   read-text {hwnd, regex, controlType?, max?, ignoreCase?, join?}
#                                         -> texts[], count, joined, nodes, rects
#                                            controlType default Text, 'any' for all;
#                                            join (default false) also matches each run of
#                                            Text nodes that sit on one text line joined
#                                            into one string (MEASURED 8, INFERRED 9): a
#                                            run whose joined text matches answers as that
#                                            line (its leaves are not repeated); joined
#                                            counts the runs of 2+, rects the nodes that
#                                            had a usable BoundingRectangle
#   capture {hwnd, path}                  -> path, w, h, restored   (PNG, PrintWindow PW_RENDERFULLCONTENT)
#   show {hwnd, mode?}                    -> wasIconic, iconic       (mode 4 SW_SHOWNOACTIVATE only)
#   close {hwnd}                          -> posted                  (PostMessage WM_CLOSE)
#   foreground-check {hwnd}               -> foreground, foregroundHwnd, idleSeconds
#   exe-version {path}                    -> productVersion, fileVersion, productName
#   stage {paths[], cwd?, uniqueId?}      -> target, chars, cbData
#   list-monitors                         -> monitors[{index,device,primary,x,y,w,h}], count
#   move-window {hwnd, monitor?}          -> moved, monitor, rect, stoleFocus
#                                            monitor: secondary (default), primary or a 1-based
#                                            index; SetWindowPos with SWP_NOACTIVATE, so the
#                                            window moves without ever taking focus
#   quit                                  -> bye
#
# stage: forwards file paths to a running Floe the way a second launch does
# (WM_COPYDATA, dwData 1542, UTF-16 JSON {"Args":[...],"WorkingDirectory":"..."}
# to the message-only window class wails-app-one.floe.desktop-sic, name
# ...-siw; wails v2.12.0 internal/frontend/desktop/windows/single_instance.go).
# The receiving app calls WindowUnminimise and WindowShow (desktop/app.go
# onSecondInstanceLaunch), which is an activation attempt, so stage is
# AWAY-ONLY: lib/desktop.mjs stages files on the first launch's argv whenever
# it can and uses stage only under --user-away. Paths must be absolute because
# filterFileArgs runs os.Stat in the first instance's working directory.
#
# MEASURED against the Store build 1.2.8.0 (2026-08-29 live probe):
#   1. UIA Names carry the rendered CSS case: the mode tabs are Buttons named
#      SEND and RECEIVE, the send sub-tabs FILES and TEXT, the pill Text READY
#      (so ACTIVE, DIRECT, RELAY), the eyebrows CODE OR LINK and SAVE TO; the
#      titlebar buttons keep their case (Start over, Settings, Minimize,
#      Maximize, Close, History); the action button is `Receive` and comes
#      AFTER the RECEIVE tab in tree order. Every name match here is therefore
#      case-insensitive; click picks the tab with index 0 and the action
#      button with index -1 (last) or `after` the code Edit.
#   2. The two receive-view Edits expose the placeholder as BOTH Name and
#      HelpText (amber-otter-cloud, then Downloads (default)); ValuePattern is
#      available and not read-only while idle, and SetValue drives React (the
#      value survives a SEND/RECEIVE tab flip and Invoke on Receive runs the
#      lookup). `Please enter a code or link.` stays the failure oracle.
#   3. ShowWindow(hwnd, 4) SW_SHOWNOACTIVATE restores a minimized window
#      without taking the foreground.
#   4. Launch by explorer.exe shell:AppsFolder\<AUMID> takes about 1 s and
#      WM_CLOSE exits the app within 3 s.
#   5. PowerShell 5.1 unrolls an AutomationElementCollection returned from a
#      function (a single element loses .Item); every collection here is
#      copied into an ArrayList and returned with the unary comma.
# INFERRED (not yet measured):
#   6. The cbData formula (len(utf16 incl. NUL) * 2 + 1) is copied from Wails'
#      own SendMessage; the receiver reads lpData up to the NUL, so cbData is
#      informational for it, but it is sent exactly as Wails sends it.
#   7. Chromium enables accessibility lazily on the first WM_GETOBJECT, so the
#      first FindAll can be empty; every tree read backs off 250/500/1000/2000 ms
#      up to its timeout.
# MEASURED in the 2026-08-28 shipped run (S-DIR-D2C and S-DIR-C2D evidence):
#   8. Chromium exposes each DOM text node as its own UIA Text element, so a
#      line React renders from several expressions never exists as one Name:
#      `Sent {n} {item}` is three Text nodes (`Sent `, `1`, ` item`) and `Saved to
#      {dir}` is two. A Button's Name concatenates its children (`Send 1
#      item` matched), a bare span's does not, and a line built as one string
#      (the pill, `Incoming: ...`) is one node. Both cells timed out on
#      `^Sent \d+ items?$` for 105 s with the line on screen. Grouping the
#      leaves by their raw-view parent (the first fix) made `Saved to {dir}`
#      match on the receiver, but the sender's line still never matched
#      (`joined: 3`, `count: 0`, `Sent 1 item` on the capture): App.tsx
#      renders `Sent {n} {item}` from three expressions inside one span,
#      and whatever Chromium hands UIA for that span, the parents of its
#      leaves are not one run. So read-text join:true now groups by
#      geometry instead (INFERRED 9) and keeps the parent grouping only for
#      a node without a usable rect.
# INFERRED 9 (the thresholds wait for a live rerun to confirm them):
#      join walks the Text nodes in tree order with their cached
#      BoundingRectangle and starts a new run whenever the next leaf is not
#      on the previous leaf's text line (vertical overlap below half the
#      shorter height) or its left edge is more than JOIN_GAP away from the
#      run's right edge, either side (JOIN_GAP = max(6 px, 0.4 x the shorter
#      leaf's height), so a dropped inter-word space at any DPI still joins
#      while a same-row neighbor such as `FILES` ... `1 ITEM` does not). A
#      whitespace-only leaf never ends a run. An empty or parked (-32000)
#      rect ends the run, and such a node falls back to the raw-view parent
#      rule. Each run is matched as its raw concatenation, its
#      whitespace-normalized form and its space-joined trimmed leaves.
#
# PowerShell 5.1 only: no ternary, no ??, no pwsh 7 cmdlets.

param(
    [switch]$Serve,
    [switch]$SelfTest,
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Windows.Forms

# In-memory P/Invoke surface. Only reads, PostMessage and the documented
# SendMessage(WM_COPYDATA) are here; keep it that way (the self-test scans
# this file for the forbidden names).
Add-Type -Namespace FloeUia -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string name);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string name);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, ref COPYDATASTRUCT l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
[DllImport("version.dll", CharSet=CharSet.Unicode)] public static extern int GetFileVersionInfoSizeW(string f, out int h);
[DllImport("version.dll", CharSet=CharSet.Unicode)] public static extern bool GetFileVersionInfoW(string f, int h, int len, byte[] d);
[DllImport("version.dll", CharSet=CharSet.Unicode)] public static extern bool VerQueryValueW(byte[] b, string sub, out IntPtr val, out int len);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
public static double IdleSeconds() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return -1;
    return (((uint)Environment.TickCount) - li.dwTime) / 1000.0;
}
public static bool IsForeground(IntPtr h) {
    return GetAncestor(GetForegroundWindow(), 2) == h;
}
public static long ForegroundRoot() {
    return (long)GetAncestor(GetForegroundWindow(), 2);
}
// The exe's version strings live under \StringFileInfo\<lang><codepage>;
// .NET's FileVersionInfo blanks every string field for the desktop exe
// because build/windows/info.json emits no FileVersion key
// (desktop-release.yml, "Verify build artifacts"). Query the subblock
// directly. The buffer stays pinned for the whole read: VerQueryValueW
// returns a pointer INTO buf, which is only pinned for the duration of
// that one P/Invoke, and the JIT treats buf as dead afterwards. The
// languages come from \VarFileInfo\Translation, with the 040904b0 block
// Floe's exe declares (info.json 0409, winres codepage 04B0) as the
// fallback for an exe that omits the table.
public static string VersionString(string file, string key) {
    int handle; int size = GetFileVersionInfoSizeW(file, out handle);
    if (size == 0) return "";
    byte[] buf = new byte[size];
    if (!GetFileVersionInfoW(file, 0, size, buf)) return "";
    GCHandle pin = GCHandle.Alloc(buf, GCHandleType.Pinned);
    try {
        IntPtr p; int len;
        var blocks = new System.Collections.Generic.List<string>();
        if (VerQueryValueW(buf, "\\VarFileInfo\\Translation", out p, out len)) {
            for (int i = 0; i + 4 <= len; i += 4) {
                ushort lang = (ushort)Marshal.ReadInt16(p, i);
                ushort cp = (ushort)Marshal.ReadInt16(p, i + 2);
                blocks.Add(lang.ToString("x4") + cp.ToString("x4"));
            }
        }
        blocks.Add("040904b0");
        foreach (string blk in blocks) {
            if (VerQueryValueW(buf, "\\StringFileInfo\\" + blk + "\\" + key, out p, out len) && len > 0) {
                string s = Marshal.PtrToStringUni(p);
                if (!string.IsNullOrEmpty(s)) return s;
            }
        }
        return "";
    } finally { pin.Free(); }
}
'@

$AE = [Windows.Automation.AutomationElement]
$TS = [Windows.Automation.TreeScope]
$TW = [Windows.Automation.TreeWalker]

$WM_CLOSE = 0x10
$WM_COPYDATA = 0x4A
$PW_RENDERFULLCONTENT = 2
$SW_SHOWNOACTIVATE = 4
# SetWindowPos: move and resize, never activate, never reorder.
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$HWND_MESSAGE = [IntPtr](-3)
$WAILS_COPYDATA_ID = 1542

$DEFAULT_CLASS = 'wailsWindow'      # wails v2.12.0 window.go:81
$DEFAULT_TITLE = 'Floe'             # desktop/main.go:86
$DEFAULT_UNIQUE_ID = 'one.floe.desktop'   # desktop/main.go:100
$CODE_PLACEHOLDER = 'amber-otter-cloud'   # App.tsx receive view
$TREE_READY_NAME = 'Settings'             # TitleBar.tsx aria-label, mounted on every screen

$COMMANDS = @(
    'ping', 'find-window', 'wait-tree', 'snapshot', 'click', 'set-value',
    'get-value', 'read-text', 'capture', 'show', 'close', 'foreground-check',
    'exe-version', 'stage', 'list-monitors', 'move-window', 'quit'
)
$REASONS = @(
    'not-found', 'ambiguous', 'read-only', 'disabled', 'no-pattern', 'timeout',
    'offscreen', 'bad-request', 'unknown-cmd', 'no-single-instance-window',
    'mode-not-allowed', 'not-a-window', 'printwindow-failed', 'exception'
)
$BACKOFF_MS = @(250, 500, 1000, 2000)
# read-text join: the geometry comes from the cached BoundingRectangle (no
# extra call per node); only a node WITHOUT a usable rect falls back to a
# parent lookup, one cross-process call each, so at most this many of those
# are grouped per read; the rest match singly.
$JOIN_PARENT_CAP = 400
# INFERRED 9: the same-line and gap thresholds of the geometric join.
$JOIN_GAP_PX = 6            # floor for the gap a run tolerates between two leaves
$JOIN_GAP_RATIO = 0.4       # or this fraction of the shorter leaf's height, whichever is larger
$JOIN_LINE_OVERLAP = 0.5    # vertical overlap (of the shorter leaf) that makes one text line
$OFFSCREEN_COORD = -32000   # where Windows parks minimized and hidden content

$script:quitRequested = $false
# Every capture path must sit under this directory when it is set (-Root).
# A separate name on purpose: the param variable $Root already lives in the
# script scope, so assigning $script:Root would overwrite the argument.
$script:CaptureRoot = ''
if ($Root -ne '') { $script:CaptureRoot = [IO.Path]::GetFullPath($Root) }

# ---------------------------------------------------------------- utilities

function Fail($reason, $detail) {
    $e = New-Object System.Exception($reason)
    $e.Data['detail'] = "$detail"
    throw $e
}

function Get-Param($req, $name, $default) {
    if ($null -eq $req) { return $default }
    $p = $req.PSObject.Properties[$name]
    if ($null -eq $p -or $null -eq $p.Value) { return $default }
    return $p.Value
}

# An integer parameter; anything that does not convert is bad-request (never
# retried) rather than an exception (retried twice for nothing).
function Get-Int($req, $name, $default) {
    $v = Get-Param $req $name $default
    try { return [int]$v } catch { Fail 'bad-request' "$name must be an integer, got '$v'" }
}

function Get-Hwnd($req) {
    $raw = Get-Param $req 'hwnd' 0
    try { $h = [IntPtr][int64]$raw } catch { Fail 'bad-request' "hwnd must be a number, got '$raw'" }
    if ($h -eq [IntPtr]::Zero) { Fail 'bad-request' 'hwnd is required' }
    if (-not [FloeUia.Native]::IsWindow($h)) { Fail 'not-a-window' "hwnd $raw" }
    return $h
}

# True when $path resolves under the capture root (always true with no -Root).
function Test-UnderRoot($path) {
    if ($script:CaptureRoot -eq '') { return $true }
    try { $full = [IO.Path]::GetFullPath($path) } catch { return $false }
    $root = $script:CaptureRoot.TrimEnd('\') + '\'
    return $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-UnderRoot($path) {
    if (-not (Test-UnderRoot $path)) { Fail 'bad-request' "path '$path' is outside -Root '$($script:CaptureRoot)'" }
}

function Get-Root($req) {
    $h = Get-Hwnd $req
    return $AE::FromHandle($h)
}

function Get-Rect($h) {
    $r = New-Object FloeUia.Native+RECT
    [void][FloeUia.Native]::GetWindowRect($h, [ref]$r)
    return @{ l = $r.L; t = $r.T; r = $r.R; b = $r.B; w = ($r.R - $r.L); h = ($r.B - $r.T) }
}

# Runs $probe until it returns something non-null or the deadline passes,
# with Chromium's lazy-accessibility backoff. Returns $null on timeout.
function Wait-Until([scriptblock]$probe, [int]$timeoutMs) {
    $i = 0
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $timeoutMs))
    while ($true) {
        $r = & $probe
        if ($null -ne $r) { return $r }
        if ([DateTime]::UtcNow -ge $deadline) { return $null }
        Start-Sleep -Milliseconds $BACKOFF_MS[[Math]::Min($i, $BACKOFF_MS.Count - 1)]
        $i++
    }
}

# One FindAll over the whole subtree with the properties the commands need
# cached, so filtering happens locally instead of one cross-process call per
# property per node. Order is UIA tree order (pre-order), which is what the
# `after` and `scope` disambiguations rely on.
function Get-Nodes($root) {
    $cr = New-Object Windows.Automation.CacheRequest
    $cr.Add($AE::NameProperty)
    $cr.Add($AE::HelpTextProperty)
    $cr.Add($AE::ControlTypeProperty)
    $cr.Add($AE::IsEnabledProperty)
    $cr.Add($AE::RuntimeIdProperty)
    $cr.Add($AE::BoundingRectangleProperty)
    $cr.TreeScope = $TS::Element
    $act = $cr.Activate()
    try {
        $all = $root.FindAll($TS::Descendants, [Windows.Automation.Condition]::TrueCondition)
    } finally {
        $act.Dispose()
    }
    $list = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $all.Count; $i++) {
        $e = $all.Item($i)
        $c = $e.Cached
        $type = ''
        if ($null -ne $c.ControlType) { $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', '' }
        $rect = $null
        try { $rect = ConvertTo-NodeRect $c.BoundingRectangle } catch { $rect = $null }
        [void]$list.Add(@{
            el = $e
            i = $i
            name = [string]$c.Name
            help = [string]$c.HelpText
            type = $type
            enabled = [bool]$c.IsEnabled
            rect = $rect
        })
    }
    return , $list
}

# A cached BoundingRectangle as @{l,t,r,b} in screen pixels, or $null when
# UIA has none for the element (Rect.Empty, an infinite or NaN edge, a
# zero-area box) or the box is parked offscreen at -32000 (a minimized
# window's content). Only a $null here sends read-text join to the parent
# fallback.
function ConvertTo-NodeRect($r) {
    if ($null -eq $r) { return $null }
    try {
        if ($r.IsEmpty) { return $null }
        $l = [double]$r.Left
        $t = [double]$r.Top
        $rt = [double]$r.Right
        $b = [double]$r.Bottom
    } catch { return $null }
    foreach ($v in @($l, $t, $rt, $b)) {
        if ([double]::IsNaN($v) -or [double]::IsInfinity($v) -or $v -le $OFFSCREEN_COORD) { return $null }
    }
    if ($rt -le $l -or $b -le $t) { return $null }
    return @{ l = $l; t = $t; r = $rt; b = $b }
}

function Get-RuntimeId($el) {
    try { return (($el.GetRuntimeId() | ForEach-Object { "$_" }) -join '.') } catch { return '' }
}

# Placeholder -> Edit. "Downloads (default)" exists on the receive view and in
# Settings, and the send-text textarea is a third Edit, so scope 'receive'
# picks the first hit after the amber-otter-cloud Edit in tree order.
function Find-Edit($nodes, $placeholder, $scope) {
    $edits = @($nodes | Where-Object { $_.type -eq 'Edit' -or $_.type -eq 'Document' })
    $codeIdx = -1
    foreach ($e in $edits) {
        if ($e.name -ieq $CODE_PLACEHOLDER -or $e.help -ieq $CODE_PLACEHOLDER) { $codeIdx = $e.i; break }
    }
    $hits = @($edits | Where-Object { $_.name -ieq $placeholder -or $_.help -ieq $placeholder })
    if ($hits.Count -eq 0) { return $null }
    if ($hits.Count -eq 1) { return $hits[0] }
    if ($scope -eq 'receive') {
        if ($codeIdx -lt 0) { Fail 'ambiguous' "$($hits.Count) Edits match '$placeholder' and the code Edit is not on screen" }
        $after = @($hits | Where-Object { $_.i -gt $codeIdx })
        if ($after.Count -ge 1) { return $after[0] }
        Fail 'ambiguous' "$($hits.Count) Edits match '$placeholder', none after the code Edit"
    }
    Fail 'ambiguous' "$($hits.Count) Edits match '$placeholder'; pass scope 'receive'"
}

function Wait-Edit($root, $placeholder, $scope, $timeoutMs) {
    $hit = Wait-Until { Find-Edit (Get-Nodes $root) $placeholder $scope } $timeoutMs
    if ($null -eq $hit) { Fail 'not-found' "no Edit named '$placeholder'" }
    return $hit
}

function Get-MatchedBy($node, $placeholder) {
    if ($node.name -ieq $placeholder) { return 'name' }
    return 'help'
}

function Get-ValuePattern($node) {
    $vp = $null
    if (-not $node.el.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        Fail 'no-pattern' 'ValuePattern is not available on that Edit'
    }
    return $vp
}

function Select-Candidates($nodes, $name, $type, $after) {
    $byName = @($nodes | Where-Object { $_.name -ieq $name })
    if ($type -and $type -ne 'any') {
        $cands = @($byName | Where-Object { $_.type -eq $type })
    } else {
        $cands = @($byName | Where-Object { $_.type -eq 'Button' })
        if ($cands.Count -eq 0) { $cands = $byName }
    }
    if ($after) {
        $anchor = $null
        foreach ($n in $nodes) {
            if (($n.type -eq 'Edit' -or $n.type -eq 'Document') -and ($n.name -ieq $after -or $n.help -ieq $after)) { $anchor = $n; break }
        }
        if ($null -eq $anchor) { return @() }
        $cands = @($cands | Where-Object { $_.i -gt $anchor.i })
    }
    return $cands
}

# index 0.. from the first match, -1 from the last (the tab is the first
# RECEIVE, the action button the last Receive). $null when out of range.
function Select-Index($cands, $index) {
    $cands = @($cands)
    if ($cands.Count -eq 0) { return $null }
    if ($index -lt 0) {
        $k = $cands.Count + $index
        if ($k -lt 0) { return $null }
        return $cands[$k]
    }
    if ($cands.Count -gt $index) { return $cands[$index] }
    return $null
}

# ---------------------------------------------- read-text join (MEASURED 8)

function Get-NormalizedText([string]$s) {
    return ([regex]::Replace($s, '\s+', ' ')).Trim()
}

# The raw-view parent's RuntimeId, or '' when none can be read. Raw view
# rather than control view: Get-Nodes is a raw-view FindAll (TrueCondition),
# and Chromium keeps unnamed spans and divs out of the control view, so the
# control-view parent of a text leaf can be a distant ancestor it shares
# with unrelated text (the status line, the pill); joining across those
# would defeat the anchored regexes. The control view is only the fallback.
function Get-ParentId($node) {
    $el = $node.el
    if ($null -eq $el) { return '' }
    $p = $null
    try { $p = $TW::RawViewWalker.GetParent($el) } catch { $p = $null }
    if ($null -eq $p) { try { $p = $TW::ControlViewWalker.GetParent($el) } catch { $p = $null } }
    if ($null -eq $p) { return '' }
    return Get-RuntimeId $p
}

# True when two rects share a text line: their vertical overlap is at least
# JOIN_LINE_OVERLAP of the shorter one (INFERRED 9).
function Test-SameLine($a, $b) {
    $overlap = [Math]::Min($a.b, $b.b) - [Math]::Max($a.t, $b.t)
    $shorter = [Math]::Min($a.b - $a.t, $b.b - $b.t)
    return ($overlap -ge ($JOIN_LINE_OVERLAP * $shorter))
}

# The horizontal slack a run tolerates before the next leaf: JOIN_GAP_PX or
# JOIN_GAP_RATIO of the shorter leaf's height, whichever is larger, so a
# dropped inter-word space still joins at any DPI (INFERRED 9).
function Get-JoinGap($a, $b) {
    $shorter = [Math]::Min($a.b - $a.t, $b.b - $b.t)
    return [Math]::Max([double]$JOIN_GAP_PX, $JOIN_GAP_RATIO * $shorter)
}

# Runs of consecutive nodes in tree order that render as one text line
# (INFERRED 9). A node with a usable rect joins the current run when the run
# is geometric, the rect shares the previous leaf's line and its left edge
# is within the join gap of the run's right edge (either side); anything
# else starts a new run. A whitespace-only leaf never ends a run: it is
# appended and, with a rect, extends the run's right edge. A node WITHOUT a
# rect falls back to the raw-view parent rule: it joins a parent-keyed run
# with the same id, and it needs a lookup, so after $cap lookups every
# remaining rectless node is a run of its own. $parentIdOf is a scriptblock
# node -> id so the self-test can feed a fixture without a window. A run
# that starts with a rectless whitespace leaf is open and adopts whatever
# the next leaf is; a rectless, parentless leaf is solo and closes at once.
function Get-TextRuns($nodes, [scriptblock]$parentIdOf, [int]$cap) {
    $runs = New-Object System.Collections.ArrayList
    $current = $null
    $meta = $null
    $looked = 0
    foreach ($n in $nodes) {
        $rect = $null
        if ($n.ContainsKey('rect')) { $rect = $n.rect }
        $blank = (([string]$n.name).Trim() -eq '')
        if ($blank -and $null -ne $current) {
            [void]$current.Add($n)
            if ($null -ne $rect -and $meta.kind -eq 'geo' -and $rect.r -gt $meta.right) { $meta.right = $rect.r }
            continue
        }
        $parentId = ''
        if ($null -eq $rect -and $looked -lt $cap) {
            $looked++
            try { $parentId = [string](& $parentIdOf $n) } catch { $parentId = '' }
        }
        $joins = $false
        if ($null -ne $current) {
            if ($null -ne $rect) {
                if ($meta.kind -eq 'geo') {
                    $gap = Get-JoinGap $meta.last $rect
                    $joins = (Test-SameLine $meta.last $rect) -and ([Math]::Abs($rect.l - $meta.right) -le $gap)
                } elseif ($meta.kind -eq 'open') {
                    $joins = $true
                }
            } elseif ($meta.kind -eq 'parent') {
                $joins = ($parentId -ne '' -and $parentId -eq $meta.parentId)
            } elseif ($meta.kind -eq 'open') {
                $joins = ($parentId -ne '')
            }
        }
        if (-not $joins) {
            $current = New-Object System.Collections.ArrayList
            [void]$runs.Add($current)
            $meta = @{ kind = 'solo'; last = $null; right = 0; parentId = '' }
        }
        [void]$current.Add($n)
        if ($null -ne $rect) {
            $meta.kind = 'geo'
            $meta.last = $rect
            if (-not $joins -or $rect.r -gt $meta.right) { $meta.right = $rect.r }
        } elseif ($parentId -ne '') {
            $meta.kind = 'parent'
            $meta.parentId = $parentId
        } elseif ($blank) {
            $meta.kind = 'open'
        } else {
            $meta.kind = 'solo'
        }
    }
    return , $runs
}

# The joined forms of a run of two or more: the Names concatenated exactly
# as rendered (`Sent ` + `1` + ` item`), then, when they differ, the same
# with whitespace runs collapsed to one space and the ends trimmed, then the
# trimmed non-empty Names joined by one space in case a build trims each
# leaf (`Sent` + `1` + `item`).
function Get-RunTexts($run) {
    $out = New-Object System.Collections.ArrayList
    if ($run.Count -lt 2) { return , $out }
    $names = @($run | ForEach-Object { [string]$_.name })
    $raw = $names -join ''
    [void]$out.Add($raw)
    $concat = Get-NormalizedText $raw
    if ($out -notcontains $concat) { [void]$out.Add($concat) }
    $trimmed = @($names | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $spaced = Get-NormalizedText ($trimmed -join ' ')
    if ($out -notcontains $spaced) { [void]$out.Add($spaced) }
    return , $out
}

# read-text's matcher over the already type-filtered, non-empty nodes.
# Singles match on their raw Name as before. With $join a run of two or
# more whose joined text matches answers as that one line and its leaves
# are not repeated (a leaf such as `Error: ` can match `^Error: .*$` on
# its own and would otherwise come first); a run whose joined text does
# not match still answers with any leaf that does. Tree order is kept,
# count is every match and texts the first $max of them.
function Select-TextMatches($nodes, $rx, [bool]$join, [int]$max, [scriptblock]$parentIdOf, [int]$cap) {
    $texts = @()
    $total = 0
    $joined = 0
    if ($join) {
        $runs = Get-TextRuns $nodes $parentIdOf $cap
    } else {
        $runs = New-Object System.Collections.ArrayList
        foreach ($n in $nodes) {
            $one = New-Object System.Collections.ArrayList
            [void]$one.Add($n)
            [void]$runs.Add($one)
        }
    }
    foreach ($run in $runs) {
        $hit = $null
        if ($run.Count -ge 2) {
            $joined++
            foreach ($t in (Get-RunTexts $run)) {
                if ($rx.IsMatch($t)) { $hit = $t; break }
            }
        }
        if ($null -ne $hit) {
            $total++
            if ($texts.Count -lt $max) { $texts += $hit }
            continue
        }
        foreach ($n in $run) {
            if (-not $rx.IsMatch($n.name)) { continue }
            $total++
            if ($texts.Count -lt $max) { $texts += $n.name }
        }
    }
    return @{ texts = $texts; count = $total; joined = $joined }
}

function Invoke-Node($node) {
    $p = $null
    if ($node.el.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
    if ($node.el.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return 'toggle' }
    if ($node.el.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return 'select' }
    Fail 'no-pattern' "'$($node.name)' ($($node.type)) has no Invoke, Toggle or SelectionItem pattern"
}

function Find-TopWindows($class, $title) {
    $out = New-Object System.Collections.ArrayList
    $prev = [IntPtr]::Zero
    while ($true) {
        $h = [FloeUia.Native]::FindWindowExW([IntPtr]::Zero, $prev, $class, $title)
        if ($h -eq [IntPtr]::Zero) { break }
        [void]$out.Add($h)
        $prev = $h
        if ($out.Count -ge 64) { break }
    }
    return , $out
}

function Get-WindowClass($h) {
    $sb = New-Object Text.StringBuilder 256
    [void][FloeUia.Native]::GetClassNameW($h, $sb, 256)
    return $sb.ToString()
}

function Get-WindowTitle($h) {
    $sb = New-Object Text.StringBuilder 512
    [void][FloeUia.Native]::GetWindowTextW($h, $sb, 512)
    return $sb.ToString()
}

function Describe-Window($h) {
    [uint32]$owner = 0
    [void][FloeUia.Native]::GetWindowThreadProcessId($h, [ref]$owner)
    $exe = $null
    try { $exe = (Get-Process -Id ([int]$owner) -ErrorAction Stop).Path } catch { $exe = $null }
    return @{
        hwnd = [int64]$h
        pid = [int]$owner
        exe = $exe
        class = (Get-WindowClass $h)
        title = (Get-WindowTitle $h)
        rect = (Get-Rect $h)
        minimized = [bool][FloeUia.Native]::IsIconic($h)
        visible = [bool][FloeUia.Native]::IsWindowVisible($h)
    }
}

# ----------------------------------------------------------------- handlers

$Handlers = @{}

$Handlers['ping'] = {
    param($req)
    return @{ pong = $true; pid = $PID; ps = $PSVersionTable.PSVersion.ToString() }
}

$Handlers['find-window'] = {
    param($req)
    $class = Get-Param $req 'class' $DEFAULT_CLASS
    $title = Get-Param $req 'title' $DEFAULT_TITLE
    $wantPid = Get-Int $req 'pid' 0
    $timeoutMs = Get-Int $req 'timeoutMs' 30000
    # PowerShell converts $null to "" for a [string] P/Invoke parameter (an
    # empty title would then match only untitled windows); [NullString]::Value
    # is the one way to pass a real NULL, meaning "any".
    if ([string]::IsNullOrEmpty($class)) { $class = [NullString]::Value }
    if ([string]::IsNullOrEmpty($title)) { $title = [NullString]::Value }
    $found = Wait-Until {
        $wins = Find-TopWindows $class $title
        $described = @()
        foreach ($h in $wins) {
            $d = Describe-Window $h
            if ($wantPid -gt 0 -and $d.pid -ne $wantPid) { continue }
            $described += , $d
        }
        if ($described.Count -eq 0) { return $null }
        $visible = @($described | Where-Object { $_.visible })
        if ($visible.Count -gt 0) { $described = $visible + @($described | Where-Object { -not $_.visible }) }
        return @{ list = $described }
    } $timeoutMs
    if ($null -eq $found) { Fail 'not-found' "class=$class title=$title pid=$wantPid within ${timeoutMs}ms" }
    $first = $found.list[0]
    $first['count'] = $found.list.Count
    return $first
}

$Handlers['wait-tree'] = {
    param($req)
    $root = Get-Root $req
    $name = Get-Param $req 'name' $TREE_READY_NAME
    $type = Get-Param $req 'controlType' 'any'
    $timeoutMs = Get-Int $req 'timeoutMs' 20000
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $hit = Wait-Until {
        $nodes = Get-Nodes $root
        $m = @($nodes | Where-Object { $_.name -ieq $name -and ($type -eq 'any' -or $_.type -eq $type) })
        if ($m.Count -gt 0) { return @{ nodes = $nodes.Count } }
        return $null
    } $timeoutMs
    if ($null -eq $hit) { Fail 'timeout' "no element named '$name' within ${timeoutMs}ms" }
    return @{ ready = $true; nodes = $hit.nodes; waitedMs = $sw.ElapsedMilliseconds }
}

$Handlers['snapshot'] = {
    param($req)
    $max = Get-Int $req 'max' 400
    $root = Get-Root $req
    $nodes = Get-Nodes $root
    $items = @()
    $n = [Math]::Min($max, $nodes.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $x = $nodes[$i]
        $item = @{ i = $x.i; type = $x.type }
        if ($x.name -ne '') { $item['name'] = $x.name }
        if ($x.help -ne '') { $item['help'] = $x.help }
        if (-not $x.enabled) { $item['enabled'] = $false }
        $items += , $item
    }
    return @{ count = $nodes.Count; truncated = ($nodes.Count -gt $max); items = $items }
}

$Handlers['click'] = {
    param($req)
    $root = Get-Root $req
    $name = [string](Get-Param $req 'name' '')
    if ($name -eq '') { Fail 'bad-request' 'name is required' }
    $type = Get-Param $req 'controlType' 'any'
    $index = Get-Int $req 'index' 0
    $after = Get-Param $req 'after' $null
    $timeoutMs = Get-Int $req 'timeoutMs' 5000
    $found = Wait-Until {
        $cands = @(Select-Candidates (Get-Nodes $root) $name $type $after)
        $pick = Select-Index $cands $index
        if ($null -ne $pick) { return @{ node = $pick; count = $cands.Count } }
        return $null
    } $timeoutMs
    if ($null -eq $found) { Fail 'not-found' "name='$name' type=$type index=$index after='$after' within ${timeoutMs}ms" }
    $node = $found.node
    if (-not $node.enabled) { Fail 'disabled' "'$name' is present but disabled" }
    $via = Invoke-Node $node
    return @{ via = $via; type = $node.type; index = $index; count = $found.count; runtimeId = (Get-RuntimeId $node.el) }
}

$Handlers['set-value'] = {
    param($req)
    $root = Get-Root $req
    $placeholder = [string](Get-Param $req 'placeholder' '')
    if ($placeholder -eq '') { Fail 'bad-request' 'placeholder is required' }
    $value = [string](Get-Param $req 'value' '')
    $scope = Get-Param $req 'scope' $null
    $settleMs = Get-Int $req 'settleMs' 150
    $timeoutMs = Get-Int $req 'timeoutMs' 5000
    $node = Wait-Edit $root $placeholder $scope $timeoutMs
    if (-not $node.enabled) { Fail 'disabled' "Edit '$placeholder' is disabled" }
    $vp = Get-ValuePattern $node
    if ($vp.Current.IsReadOnly) { Fail 'read-only' "Edit '$placeholder' is read-only" }
    $before = [string]$vp.Current.Value
    $vp.SetValue($value)
    Start-Sleep -Milliseconds $settleMs
    $after = [string]$vp.Current.Value
    return @{
        before = $before
        after = $after
        matchedBy = (Get-MatchedBy $node $placeholder)
        runtimeId = (Get-RuntimeId $node.el)
    }
}

$Handlers['get-value'] = {
    param($req)
    $root = Get-Root $req
    $placeholder = [string](Get-Param $req 'placeholder' '')
    if ($placeholder -eq '') { Fail 'bad-request' 'placeholder is required' }
    $scope = Get-Param $req 'scope' $null
    $timeoutMs = Get-Int $req 'timeoutMs' 5000
    $node = Wait-Edit $root $placeholder $scope $timeoutMs
    $vp = Get-ValuePattern $node
    return @{
        value = [string]$vp.Current.Value
        matchedBy = (Get-MatchedBy $node $placeholder)
        runtimeId = (Get-RuntimeId $node.el)
        enabled = $node.enabled
        readOnly = [bool]$vp.Current.IsReadOnly
    }
}

$Handlers['read-text'] = {
    param($req)
    # Parameters first, so a malformed request is bad-request before any
    # window is touched.
    $regex = [string](Get-Param $req 'regex' '')
    if ($regex -eq '') { Fail 'bad-request' 'regex is required' }
    $type = Get-Param $req 'controlType' 'Text'
    $max = Get-Int $req 'max' 50
    $ignoreCase = [bool](Get-Param $req 'ignoreCase' $true)
    $join = [bool](Get-Param $req 'join' $false)
    $opts = [Text.RegularExpressions.RegexOptions]::None
    if ($ignoreCase) { $opts = [Text.RegularExpressions.RegexOptions]::IgnoreCase }
    try { $rx = New-Object Text.RegularExpressions.Regex($regex, $opts) } catch { Fail 'bad-request' "invalid regex '$regex': $($_.Exception.Message)" }
    $root = Get-Root $req
    $nodes = Get-Nodes $root
    $scoped = New-Object System.Collections.ArrayList
    $rects = 0
    foreach ($n in $nodes) {
        if ($type -ne 'any' -and $n.type -ne $type) { continue }
        if ($n.name -eq '') { continue }
        [void]$scoped.Add($n)
        if ($null -ne $n.rect) { $rects++ }
    }
    $m = Select-TextMatches $scoped $rx $join $max { param($n) Get-ParentId $n } $JOIN_PARENT_CAP
    return @{ texts = $m.texts; count = $m.count; joined = $m.joined; nodes = $nodes.Count; rects = $rects }
}

$Handlers['capture'] = {
    param($req)
    $path = [string](Get-Param $req 'path' '')
    if ($path -eq '') { Fail 'bad-request' 'path is required' }
    Assert-UnderRoot $path
    $h = Get-Hwnd $req
    $restored = $false
    if ([FloeUia.Native]::IsIconic($h)) {
        [void][FloeUia.Native]::ShowWindow($h, $SW_SHOWNOACTIVATE)
        Start-Sleep -Milliseconds 300
        $restored = $true
    }
    $r = Get-Rect $h
    if ([FloeUia.Native]::IsIconic($h) -or $r.l -le -32000 -or $r.t -le -32000) { Fail 'offscreen' "rect $($r.l),$($r.t) $($r.w)x$($r.h)" }
    if ($r.w -le 0 -or $r.h -le 0) { Fail 'offscreen' "empty rect $($r.w)x$($r.h)" }
    # The directory comes first (a bad path fails before any GDI object
    # exists) and every GDI object is disposed on every path.
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp = New-Object Drawing.Bitmap $r.w, $r.h
    try {
        $g = [Drawing.Graphics]::FromImage($bmp)
        try {
            $hdc = $g.GetHdc()
            try { $printed = [FloeUia.Native]::PrintWindow($h, $hdc, $PW_RENDERFULLCONTENT) } finally { $g.ReleaseHdc($hdc) }
        } finally { $g.Dispose() }
        if (-not $printed) { Fail 'printwindow-failed' "PrintWindow returned false for hwnd $h" }
        $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bmp.Dispose()
    }
    return @{ path = $path; w = $r.w; h = $r.h; restored = $restored }
}

$Handlers['show'] = {
    param($req)
    $mode = Get-Int $req 'mode' $SW_SHOWNOACTIVATE
    if ($mode -ne $SW_SHOWNOACTIVATE) { Fail 'mode-not-allowed' "show accepts mode 4 (SW_SHOWNOACTIVATE) only, got $mode" }
    $h = Get-Hwnd $req
    $was = [bool][FloeUia.Native]::IsIconic($h)
    [void][FloeUia.Native]::ShowWindow($h, $SW_SHOWNOACTIVATE)
    Start-Sleep -Milliseconds 200
    return @{ wasIconic = $was; iconic = [bool][FloeUia.Native]::IsIconic($h); rect = (Get-Rect $h) }
}

$Handlers['list-monitors'] = {
    param($req)
    $out = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $i++
        [void]$out.Add(@{
            index   = $i
            device  = [string]$s.DeviceName
            primary = [bool]$s.Primary
            x       = [int]$s.WorkingArea.X
            y       = [int]$s.WorkingArea.Y
            w       = [int]$s.WorkingArea.Width
            h       = [int]$s.WorkingArea.Height
        })
    }
    return @{ monitors = $out; count = $out.Count }
}

# Move the window onto a monitor without activating it. 'secondary' is the
# first non-primary screen and falls back to the primary on a one-screen
# machine; an index picks a screen by its position in AllScreens. The window
# keeps its size unless it does not fit, and is centered in the WORKING area
# so it never lands under the taskbar.
$Handlers['move-window'] = {
    param($req)
    $h = Get-Hwnd $req
    $want = if ($null -ne $req.monitor) { [string]$req.monitor } else { 'secondary' }
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    if ($screens.Count -eq 0) { Fail 'not-found' 'no monitors' }
    $target = $null
    if ($want -match '^[0-9]+$') {
        $idx = [int]$want
        if ($idx -lt 1 -or $idx -gt $screens.Count) {
            Fail 'not-found' "monitor $idx of $($screens.Count)"
        }
        $target = $screens[$idx - 1]
    }
    elseif ($want -eq 'primary') {
        $target = @($screens | Where-Object { $_.Primary })[0]
    }
    else {
        $target = @($screens | Where-Object { -not $_.Primary })[0]
        if ($null -eq $target) { $target = @($screens | Where-Object { $_.Primary })[0] }
    }
    if ($null -eq $target) { $target = $screens[0] }
    $area = $target.WorkingArea
    $before = Get-Rect $h
    $w = [Math]::Min($before.w, $area.Width)
    $ht = [Math]::Min($before.h, $area.Height)
    $x = [int]($area.X + [Math]::Floor(($area.Width - $w) / 2))
    $y = [int]($area.Y + [Math]::Floor(($area.Height - $ht) / 2))
    $flags = $SWP_NOACTIVATE -bor $SWP_NOZORDER
    $fgBefore = [FloeUia.Native]::GetForegroundWindow()
    $moved = [bool][FloeUia.Native]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $ht, $flags)
    Start-Sleep -Milliseconds 120
    $fgAfter = [FloeUia.Native]::GetForegroundWindow()
    return @{
        moved      = $moved
        monitor    = [string]$target.DeviceName
        primary    = [bool]$target.Primary
        requested  = $want
        count      = $screens.Count
        rect       = (Get-Rect $h)
        stoleFocus = ($fgBefore -ne $fgAfter -and $fgAfter -eq $h)
    }
}

$Handlers['close'] = {
    param($req)
    $h = Get-Hwnd $req
    $posted = [FloeUia.Native]::PostMessageW($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    return @{ posted = [bool]$posted }
}

$Handlers['foreground-check'] = {
    param($req)
    $h = Get-Hwnd $req
    return @{
        foreground = [bool][FloeUia.Native]::IsForeground($h)
        foregroundHwnd = [FloeUia.Native]::ForegroundRoot()
        idleSeconds = [FloeUia.Native]::IdleSeconds()
    }
}

$Handlers['exe-version'] = {
    param($req)
    $path = [string](Get-Param $req 'path' '')
    if ($path -eq '') { Fail 'bad-request' 'path is required' }
    if (-not (Test-Path -LiteralPath $path)) { Fail 'not-found' $path }
    $full = (Resolve-Path -LiteralPath $path).Path
    return @{
        path = $full
        productVersion = [FloeUia.Native]::VersionString($full, 'ProductVersion')
        fileVersion = [FloeUia.Native]::VersionString($full, 'FileVersion')
        productName = [FloeUia.Native]::VersionString($full, 'ProductName')
    }
}

$Handlers['stage'] = {
    param($req)
    $paths = @(Get-Param $req 'paths' @())
    if ($paths.Count -eq 0) { Fail 'bad-request' 'paths is required' }
    $cwd = [string](Get-Param $req 'cwd' (Get-Location).Path)
    $uniqueId = [string](Get-Param $req 'uniqueId' $DEFAULT_UNIQUE_ID)
    $class = "wails-app-$uniqueId-sic"
    $name = "wails-app-$uniqueId-siw"
    $target = [FloeUia.Native]::FindWindowW($class, $name)
    if ($target -eq [IntPtr]::Zero) { $target = [FloeUia.Native]::FindWindowExW($HWND_MESSAGE, [IntPtr]::Zero, $class, $name) }
    if ($target -eq [IntPtr]::Zero) { Fail 'no-single-instance-window' "$class / $name" }
    $payload = [ordered]@{ Args = @($paths | ForEach-Object { [string]$_ }); WorkingDirectory = $cwd }
    $json = ConvertTo-Json -InputObject $payload -Compress
    $ptr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($json)
    try {
        $cds = New-Object FloeUia.Native+COPYDATASTRUCT
        $cds.dwData = [IntPtr]$WAILS_COPYDATA_ID
        $cds.cbData = ($json.Length + 1) * 2 + 1   # Wails: len(utf16 incl. NUL) * 2 + 1
        $cds.lpData = $ptr
        [void][FloeUia.Native]::SendMessageW($target, $WM_COPYDATA, [IntPtr]::Zero, [ref]$cds)
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
    }
    return @{ target = [int64]$target; chars = $json.Length; cbData = (($json.Length + 1) * 2 + 1); activates = $true }
}

$Handlers['quit'] = {
    param($req)
    $script:quitRequested = $true
    return @{ bye = $true }
}

# One request line in, one response line out. Never throws: every failure
# becomes an ok:false line so the Node side can keep its id bookkeeping.
function Invoke-Request([string]$line) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $id = $null
    # Best-effort id recovery: a line that does not parse still answers
    # under its id, so the client's pending entry settles at once.
    if ($line -match '"id"\s*:\s*(\d+)') { $id = [int64]$Matches[1] }
    try {
        try {
            $req = ConvertFrom-Json -InputObject $line
        } catch {
            Fail 'bad-request' "not JSON: $($_.Exception.Message)"
        }
        $id = Get-Param $req 'id' $id
        $cmd = [string](Get-Param $req 'cmd' '')
        if (-not $Handlers.ContainsKey($cmd)) { Fail 'unknown-cmd' "cmd '$cmd'" }
        $data = & $Handlers[$cmd] $req
        $resp = [ordered]@{ id = $id; ok = $true; ms = $sw.ElapsedMilliseconds }
        if ($data -is [System.Collections.IDictionary]) {
            foreach ($k in $data.Keys) { $resp[[string]$k] = $data[$k] }
        }
        return (ConvertTo-Json -InputObject $resp -Compress -Depth 6)
    } catch {
        $ex = $_.Exception
        if ($ex -is [System.Management.Automation.MethodInvocationException] -and $null -ne $ex.InnerException) { $ex = $ex.InnerException }
        $reason = 'exception'
        if ($REASONS -contains $ex.Message) { $reason = $ex.Message }
        $detail = ''
        if ($ex.Data.Contains('detail')) { $detail = [string]$ex.Data['detail'] } else { $detail = "$($ex.GetType().Name): $($ex.Message)" }
        $err = [ordered]@{ id = $id; ok = $false; ms = $sw.ElapsedMilliseconds; reason = $reason; detail = $detail }
        return (ConvertTo-Json -InputObject $err -Compress -Depth 6)
    }
}

# ---------------------------------------------------------------- self-test

function Invoke-SelfTest {
    $failed = 0
    $results = New-Object System.Collections.ArrayList
    function Check($name, $ok, $detail) {
        $tag = 'FAIL'
        if ($ok) { $tag = 'PASS' }
        [void]$results.Add("$tag  $name  $detail")
        if (-not $ok) { $script:selfTestFailed++ }
    }
    $script:selfTestFailed = 0
    $source = Get-Content -LiteralPath $PSCommandPath -Raw

    # 1. The file parses (a syntax error anywhere would already have stopped
    #    -File, but a copy edited by hand should still get a first-class line).
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$errors)
    Check 'parses' ($errors.Count -eq 0) "$($errors.Count) parse errors"

    # 2. Every documented command has a handler and every handler is documented.
    $missing = @($COMMANDS | Where-Object { -not $Handlers.ContainsKey($_) })
    $extra = @($Handlers.Keys | Where-Object { $COMMANDS -notcontains $_ })
    Check 'commands-wired' ($missing.Count -eq 0 -and $extra.Count -eq 0) "missing=[$($missing -join ',')] extra=[$($extra -join ',')]"
    foreach ($c in $COMMANDS) {
        $documented = $source -match "(?m)^#\s+$([regex]::Escape($c))\b"
        Check "documented:$c" $documented ''
    }

    # 3. JSON round trip through ping, unknown-cmd and bad-request.
    $pong = ConvertFrom-Json -InputObject (Invoke-Request '{"id":7,"cmd":"ping"}')
    Check 'ping-roundtrip' ($pong.id -eq 7 -and $pong.ok -eq $true -and $pong.pong -eq $true -and $pong.pid -eq $PID) "id=$($pong.id) ok=$($pong.ok) pid=$($pong.pid)"
    $unk = ConvertFrom-Json -InputObject (Invoke-Request '{"id":8,"cmd":"nope"}')
    Check 'unknown-cmd' ($unk.id -eq 8 -and $unk.ok -eq $false -and $unk.reason -eq 'unknown-cmd') "reason=$($unk.reason)"
    $bad = ConvertFrom-Json -InputObject (Invoke-Request '{oops')
    Check 'bad-request' ($bad.ok -eq $false -and $bad.reason -eq 'bad-request') "reason=$($bad.reason)"
    $badId = ConvertFrom-Json -InputObject (Invoke-Request '{"id": 77, oops')
    Check 'bad-request-echoes-id' ($badId.id -eq 77 -and $badId.ok -eq $false -and $badId.reason -eq 'bad-request') "id=$($badId.id) reason=$($badId.reason)"
    $nohwnd = ConvertFrom-Json -InputObject (Invoke-Request '{"id":9,"cmd":"close"}')
    Check 'hwnd-required' ($nohwnd.ok -eq $false -and $nohwnd.reason -eq 'bad-request') "reason=$($nohwnd.reason)"
    $badShow = ConvertFrom-Json -InputObject (Invoke-Request '{"id":10,"cmd":"show","hwnd":1,"mode":9}')
    Check 'show-refuses-sw-restore' ($badShow.ok -eq $false -and $badShow.reason -eq 'mode-not-allowed') "reason=$($badShow.reason)"
    $ghost = ConvertFrom-Json -InputObject (Invoke-Request '{"id":11,"cmd":"read-text","hwnd":1,"regex":"x"}')
    Check 'dead-hwnd' ($ghost.ok -eq $false -and $ghost.reason -eq 'not-a-window') "reason=$($ghost.reason)"
    $badRx = ConvertFrom-Json -InputObject (Invoke-Request '{"id":17,"cmd":"read-text","hwnd":1,"regex":"["}')
    Check 'bad-regex-is-bad-request' ($badRx.ok -eq $false -and $badRx.reason -eq 'bad-request') "reason=$($badRx.reason)"
    $badMax = ConvertFrom-Json -InputObject (Invoke-Request '{"id":18,"cmd":"read-text","hwnd":1,"regex":"x","max":"abc"}')
    Check 'bad-max-is-bad-request' ($badMax.ok -eq $false -and $badMax.reason -eq 'bad-request') "reason=$($badMax.reason)"
    $badHwnd = ConvertFrom-Json -InputObject (Invoke-Request '{"id":19,"cmd":"close","hwnd":"abc"}')
    Check 'bad-hwnd-is-bad-request' ($badHwnd.ok -eq $false -and $badHwnd.reason -eq 'bad-request') "reason=$($badHwnd.reason)"
    $savedRoot = $script:CaptureRoot
    $script:CaptureRoot = 'C:\lta\run'
    $underRoot = (Test-UnderRoot 'C:\lta\run\cells\a\receiver-done.png') -and (Test-UnderRoot 'c:\LTA\run\x.png')
    $outsideRoot = (-not (Test-UnderRoot 'C:\lta\other\x.png')) -and (-not (Test-UnderRoot 'C:\lta\run\..\x.png')) -and (-not (Test-UnderRoot 'C:\lta\runaway\x.png'))
    $refusedCapture = ConvertFrom-Json -InputObject (Invoke-Request '{"id":20,"cmd":"capture","hwnd":1,"path":"C:\\lta\\other\\x.png"}')
    $script:CaptureRoot = $savedRoot
    Check 'capture-root-fence' ($underRoot -and $outsideRoot -and $refusedCapture.ok -eq $false -and $refusedCapture.reason -eq 'bad-request') "under=$underRoot outside=$outsideRoot reason=$($refusedCapture.reason)"

    # 4. No forbidden input, focus, paste-buffer or code-loading API is named
    #    anywhere in the file except on the FORBIDDEN lines themselves, and
    #    the only PostMessageW call site is the WM_CLOSE one. The marker
    #    string is assembled from parts so that no other line carries it.
    $marker = '#' + ' denylist'
    $FORBIDDEN = @('SetForegroundWindow', 'SendInput', 'SetCursorPos', 'mouse_event', 'Set-Clipboard', 'CopyFromScreen', 'keybd_event', 'SetActiveWindow', 'SwitchToThisWindow', 'BringWindowToTop', # denylist
                   'AttachThreadInput', 'SetFocus', 'SendKeys', 'Clipboard', 'Invoke-Expression', 'iex ', 'scriptblock]::Create', '-TypeDefinition') # denylist
    $lines = @($source -split "`r?`n" | Where-Object { $_ -notmatch $marker })
    foreach ($f in $FORBIDDEN) {
        $hits = @($lines | Where-Object { $_.IndexOf($f, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        Check "forbidden-absent:$f" ($hits.Count -eq 0) "$($hits.Count) lines"
    }
    $markerLines = @($source -split "`r?`n" | Where-Object { $_ -match $marker })
    Check 'denylist-marker-at-most-twice' ($markerLines.Count -le 2) "$($markerLines.Count) lines"
    $postSites = @([regex]::Matches($source, '::PostMessageW\('))
    Check 'postmessage-close-only' ($postSites.Count -eq 1 -and $source -match 'PostMessageW\(\$h, \$WM_CLOSE,') "$($postSites.Count) call sites"
    Check 'show-only-noactivate' ($source -notmatch 'ShowWindow\([^)]*,\s*(9|SW_RESTORE|5|SW_SHOW)\b') ''
    # SetWindowPos may move a window but never activate or raise it: one call
    # site, and its flags are exactly SWP_NOACTIVATE plus SWP_NOZORDER.
    $swpSites = @([regex]::Matches($source, '::SetWindowPos\('))
    Check 'setwindowpos-one-site' ($swpSites.Count -eq 1) "$($swpSites.Count) call sites"
    Check 'setwindowpos-noactivate' ($source -match '\$flags = \$SWP_NOACTIVATE -bor \$SWP_NOZORDER') ''
    Check 'setwindowpos-flags-only' ($source -notmatch '::SetWindowPos\([^)]*(SWP_SHOWWINDOW|HWND_TOPMOST)') ''

    # 5. VerQueryValue path on a system binary (a read; never launches anything).
    $sys = Join-Path $env:SystemRoot 'System32\notepad.exe'
    if (Test-Path -LiteralPath $sys) {
        $ver = ConvertFrom-Json -InputObject (Invoke-Request ('{"id":12,"cmd":"exe-version","path":' + (ConvertTo-Json -InputObject $sys -Compress) + '}'))
        Check 'exe-version' ($ver.ok -eq $true -and "$($ver.productVersion)" -ne '') "productVersion=$($ver.productVersion)"
    } else {
        Check 'exe-version' $true 'skipped: notepad.exe missing'
    }

    # 6. foreground-check on whatever window is foreground right now (read only).
    $fg = [FloeUia.Native]::ForegroundRoot()
    if ($fg -ne 0) {
        $fc = ConvertFrom-Json -InputObject (Invoke-Request ('{"id":13,"cmd":"foreground-check","hwnd":' + $fg + '}'))
        Check 'foreground-check' ($fc.ok -eq $true -and $fc.foreground -eq $true -and $fc.idleSeconds -ge 0) "idleSeconds=$($fc.idleSeconds)"
    } else {
        Check 'foreground-check' $true 'skipped: no foreground window'
    }

    # 7. Fixtures for the measured tree shape (Store build 1.2.8.0, 2026-08-29):
    #    rendered-case names, tab first and action button last, both Edits
    #    naming their placeholder in Name and HelpText, and the single-element
    #    collection that PowerShell 5.1 would otherwise unroll.
    $fx = New-Object System.Collections.ArrayList
    $rows = @(
        @{ type = 'Button'; name = 'Settings' }, @{ type = 'Button'; name = 'SEND' }, @{ type = 'Button'; name = 'RECEIVE' },
        @{ type = 'Text'; name = 'READY' }, @{ type = 'Text'; name = 'CODE OR LINK' },
        @{ type = 'Edit'; name = 'amber-otter-cloud'; help = 'amber-otter-cloud' },
        @{ type = 'Text'; name = 'SAVE TO' },
        @{ type = 'Edit'; name = 'Downloads (default)'; help = 'Downloads (default)' },
        @{ type = 'Button'; name = 'Browse' }, @{ type = 'Button'; name = 'Receive' },
        @{ type = 'Text'; name = 'Enter a code or link, then click Receive.' }
    )
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $help = ''
        if ($r.ContainsKey('help')) { $help = $r.help }
        [void]$fx.Add(@{ el = $null; i = $i; name = $r.name; help = $help; type = $r.type; enabled = $true })
    }
    $recv = @(Select-Candidates $fx 'Receive' 'any' $null)
    Check 'fixture-case-insensitive-names' ($recv.Count -eq 2 -and $recv[0].name -eq 'RECEIVE' -and $recv[1].name -eq 'Receive') "count=$($recv.Count)"
    $tab = Select-Index $recv 0
    $action = Select-Index $recv -1
    Check 'fixture-tab-first-action-last' ($tab.i -eq 2 -and $action.i -eq 9) "tab=$($tab.i) action=$($action.i)"
    $afterCode = @(Select-Candidates $fx 'receive' 'Button' 'amber-otter-cloud')
    Check 'fixture-after-code-edit' ($afterCode.Count -eq 1 -and $afterCode[0].i -eq 9) "count=$($afterCode.Count)"
    $one = @(Select-Candidates $fx 'settings' 'any' $null)
    Check 'fixture-single-element-keeps-count' ($one.Count -eq 1 -and $one[0].name -eq 'Settings') "count=$($one.Count)"
    $codeEdit = Find-Edit $fx 'AMBER-OTTER-CLOUD' $null
    Check 'fixture-edit-by-name-or-help' ($null -ne $codeEdit -and $codeEdit.i -eq 5 -and (Get-MatchedBy $codeEdit 'amber-otter-cloud') -eq 'name') ''
    $saveEdit = Find-Edit $fx 'Downloads (default)' 'receive'
    Check 'fixture-savedir-scope-receive' ($null -ne $saveEdit -and $saveEdit.i -eq 7) ''
    [void]$fx.Add(@{ el = $null; i = 11; name = 'Downloads (default)'; help = 'Downloads (default)'; type = 'Edit'; enabled = $true })
    $scoped = Find-Edit $fx 'Downloads (default)' 'receive'
    $ambiguous = $false
    try { [void](Find-Edit $fx 'Downloads (default)' $null) } catch { $ambiguous = ($_.Exception.Message -eq 'ambiguous') }
    Check 'fixture-two-savedir-edits' ($scoped.i -eq 7 -and $ambiguous) "scoped=$($scoped.i) ambiguous=$ambiguous"
    $missing = Select-Index @() 0
    Check 'fixture-empty-collection' ($null -eq $missing) ''

    # 9. read-text join fixtures (MEASURED 8, INFERRED 9). Rects are screen
    #    pixels at 100 percent scaling, 14 px text on 20 px lines, the
    #    measured window. Three leaves on one line join even when their
    #    fake parents differ (the nested count), a leaf on the next line
    #    starts a new run even under the same parent, so does a leaf 40 px
    #    to the right, a whitespace-only leaf (with or without a rect) never
    #    ends a run, a parked rect does, rectless leaves still group by
    #    parent, a lone node still matches, join off still sees only the
    #    split nodes, trimmed leaves get the spaced form, and the lookup cap
    #    (rectless leaves only) and max both bound the answer.
    $jx = New-Object System.Collections.ArrayList
    $jrows = @(
        @{ name = 'READY'; parent = 'p0'; rect = @(900, 100, 950, 120) },
        @{ name = 'FILES'; parent = 'p1'; rect = @(600, 140, 640, 160) },
        @{ name = '1 ITEM'; parent = 'p1'; rect = @(900, 140, 940, 160) },
        @{ name = 'Sent '; parent = 'p2'; rect = @(700, 200, 730, 220) },
        @{ name = '1'; parent = 'p3'; rect = @(730, 200, 738, 220) },
        @{ name = ' item'; parent = 'p2'; rect = @(738, 200, 770, 220) },
        @{ name = 'Saved to '; parent = 'p4'; rect = @(600, 240, 650, 260) },
        @{ name = 'C:\out\a1'; parent = 'p4'; rect = @(650, 240, 720, 260) },
        @{ name = 'Peer connected. Sending...'; parent = 'p4'; rect = @(600, 270, 760, 290) },
        @{ name = 'Error: '; parent = 'p5'; rect = @(600, 320, 640, 340) },
        @{ name = 'boom'; parent = 'p5'; rect = @(680, 320, 710, 340) },
        @{ name = 'Sent'; parent = 'p6'; rect = @(700, 360, 726, 380) },
        @{ name = '2'; parent = 'p7'; rect = @(730, 360, 738, 380) },
        @{ name = 'items'; parent = 'p6'; rect = @(742, 360, 775, 380) },
        @{ name = 'Sent '; parent = 'p8'; rect = @(700, 400, 730, 420) },
        @{ name = '3'; parent = 'p9'; rect = @(730, 400, 738, 420) },
        @{ name = ' '; parent = 'p8'; rect = @(738, 400, 742, 420) },
        @{ name = 'items'; parent = 'p8'; rect = @(742, 400, 775, 420) },
        @{ name = 'Sent '; parent = 'p10'; rect = @(700, 440, 730, 460) },
        @{ name = '4'; parent = 'p11'; rect = @(730, 440, 738, 460) },
        @{ name = ' '; parent = 'p10' },
        @{ name = 'items'; parent = 'p10'; rect = @(742, 440, 775, 460) },
        @{ name = 'Sent '; parent = 'p12'; rect = @(700, 480, 730, 500) },
        @{ name = '5'; parent = 'p12'; rect = @(-32000, -32000, -31992, -31980) },
        @{ name = 'items'; parent = 'p12'; rect = @(742, 480, 775, 500) },
        @{ name = 'Saved to '; parent = 'p13' },
        @{ name = 'C:\out\b2'; parent = 'p13' },
        @{ name = 'Error: '; parent = 'p14' },
        @{ name = 'boom'; parent = 'p15' },
        @{ name = 'Error: '; parent = 'p16'; rect = @(600, 520, 640, 540) },
        @{ name = 'boom'; parent = 'p17'; rect = @(640, 520, 670, 540) }
    )
    for ($i = 0; $i -lt $jrows.Count; $i++) {
        $row = $jrows[$i]
        $rect = $null
        if ($row.ContainsKey('rect')) {
            $rect = ConvertTo-NodeRect (New-Object Windows.Rect($row.rect[0], $row.rect[1], ($row.rect[2] - $row.rect[0]), ($row.rect[3] - $row.rect[1])))
        }
        [void]$jx.Add(@{ el = $null; i = $i; name = $row.name; help = ''; type = 'Text'; enabled = $true; parent = $row.parent; rect = $rect })
    }
    $byFixture = { param($n) $n.parent }
    $ic = [Text.RegularExpressions.RegexOptions]::IgnoreCase
    $rxSent = New-Object Text.RegularExpressions.Regex('^Sent \d+ items?$', $ic)
    $rxSaved = New-Object Text.RegularExpressions.Regex('^Saved to (.+)$', $ic)
    $rxPill = New-Object Text.RegularExpressions.Regex('^(Ready|Active|Direct|Relay)$', $ic)
    $rxError = New-Object Text.RegularExpressions.Regex('^Error: .*$', $ic)
    $parked = ConvertTo-NodeRect (New-Object Windows.Rect(-32000, -32000, 8, 20))
    $plain = ConvertTo-NodeRect (New-Object Windows.Rect(10, 20, 30, 40))
    $empty = ConvertTo-NodeRect ([Windows.Rect]::Empty)
    $flat = ConvertTo-NodeRect (New-Object Windows.Rect(10, 20, 0, 0))
    Check 'fixture-rect-parse' ($null -eq $parked -and $null -eq $empty -and $null -eq $flat -and $null -ne $plain -and $plain.l -eq 10 -and $plain.t -eq 20 -and $plain.r -eq 40 -and $plain.b -eq 60 -and $null -eq $jx[23].rect -and $null -ne $jx[3].rect) "plain=$($plain.l),$($plain.t),$($plain.r),$($plain.b)"
    $runs = Get-TextRuns $jx $byFixture $JOIN_PARENT_CAP
    $sizes = @($runs | ForEach-Object { $_.Count })
    Check 'fixture-join-runs-by-geometry' ($runs.Count -eq 18 -and ($sizes -join ',') -eq '1,1,1,3,2,1,1,1,3,4,4,1,1,1,2,1,1,2') "runs=$($runs.Count) sizes=$($sizes -join ',')"
    $off = Select-TextMatches $jx $rxSent $false 50 $byFixture $JOIN_PARENT_CAP
    Check 'fixture-join-off-sees-split-nodes-only' ($off.count -eq 0 -and $off.texts.Count -eq 0 -and $off.joined -eq 0) "texts=[$($off.texts -join '|')]"
    $on = Select-TextMatches $jx $rxSent $true 50 $byFixture $JOIN_PARENT_CAP
    Check 'fixture-join-nested-leaves-on-one-line' ($on.count -eq 4 -and $on.texts[0] -eq 'Sent 1 item' -and $on.joined -eq 7) "texts=[$($on.texts -join '|')] joined=$($on.joined)"
    Check 'fixture-join-trimmed-leaves-spaced-form' ($on.count -eq 4 -and $on.texts[1] -eq 'Sent 2 items') "texts=[$($on.texts -join '|')]"
    Check 'fixture-join-whitespace-leaf-continues' ($on.count -eq 4 -and $on.texts[2] -eq 'Sent 3 items' -and $on.texts[3] -eq 'Sent 4 items') "texts=[$($on.texts -join '|')]"
    Check 'fixture-join-parked-rect-ends-run' (@($on.texts | Where-Object { $_ -eq 'Sent 5 items' }).Count -eq 0) "texts=[$($on.texts -join '|')]"
    $saved = Select-TextMatches $jx $rxSaved $true 50 $byFixture $JOIN_PARENT_CAP
    Check 'fixture-join-next-line-starts-a-run' ($saved.count -eq 2 -and $saved.texts[0] -eq 'Saved to C:\out\a1') "texts=[$($saved.texts -join '|')]"
    Check 'fixture-join-parent-fallback-without-rects' ($saved.count -eq 2 -and $saved.texts[1] -eq 'Saved to C:\out\b2') "texts=[$($saved.texts -join '|')]"
    $errOn = Select-TextMatches $jx $rxError $true 50 $byFixture $JOIN_PARENT_CAP
    $errOff = Select-TextMatches $jx $rxError $false 50 $byFixture $JOIN_PARENT_CAP
    Check 'fixture-join-gap-starts-a-run' ($errOn.count -eq 3 -and $errOn.texts[0] -eq 'Error: ') "on=[$($errOn.texts -join '|')]"
    Check 'fixture-join-two-parents-stay-apart' ($errOn.count -eq 3 -and $errOn.texts[1] -eq 'Error: ') "on=[$($errOn.texts -join '|')]"
    Check 'fixture-join-prefers-the-joined-line' ($errOn.count -eq 3 -and $errOn.texts[2] -eq 'Error: boom' -and $errOff.count -eq 3 -and @($errOff.texts | Where-Object { $_ -ne 'Error: ' }).Count -eq 0) "on=[$($errOn.texts -join '|')] off=[$($errOff.texts -join '|')]"
    $single = Select-TextMatches $jx $rxPill $true 50 $byFixture $JOIN_PARENT_CAP
    Check 'fixture-join-single-node-still-matches' ($single.count -eq 1 -and $single.texts[0] -eq 'READY') "texts=[$($single.texts -join '|')]"
    $cappedSent = Select-TextMatches $jx $rxSent $true 50 $byFixture 0
    $cappedSaved = Select-TextMatches $jx $rxSaved $true 50 $byFixture 0
    Check 'fixture-join-cap-bounds-parent-lookups-only' ($cappedSent.count -eq 4 -and $cappedSaved.count -eq 1 -and $cappedSaved.texts[0] -eq 'Saved to C:\out\a1' -and $cappedSaved.joined -eq 6) "sent=$($cappedSent.count) saved=[$($cappedSaved.texts -join '|')] joined=$($cappedSaved.joined)"
    $maxed = Select-TextMatches $jx $rxSent $true 1 $byFixture $JOIN_PARENT_CAP
    Check 'fixture-join-max-caps-texts' ($maxed.count -eq 4 -and $maxed.texts.Count -eq 1) "count=$($maxed.count) texts=$($maxed.texts.Count)"
    $joinReq = ConvertFrom-Json -InputObject (Invoke-Request '{"id":21,"cmd":"read-text","hwnd":1,"regex":"x","join":true}')
    Check 'join-param-reaches-window-check' ($joinReq.ok -eq $false -and $joinReq.reason -eq 'not-a-window') "reason=$($joinReq.reason)"

    # 8. The UIA root is reachable (no window needed).
    $rootName = $null
    try { $rootName = $AE::RootElement.Current.ControlType.ProgrammaticName } catch { $rootName = $null }
    Check 'uia-root' ($rootName -eq 'ControlType.Pane') "$rootName"

    # Written straight to the console stream: Write-Output inside a function
    # would become the caller's return value and swallow the exit code.
    foreach ($r in $results) { [Console]::Out.WriteLine($r) }
    $total = $results.Count
    $passed = $total - $script:selfTestFailed
    [Console]::Out.WriteLine("desktop-uia self-test: $passed/$total passed")
    if ($script:selfTestFailed -gt 0) { return 1 }
    return 0
}

# --------------------------------------------------------------------- main

if ($SelfTest) {
    $code = Invoke-SelfTest
    exit $code
}

if ($Serve) {
    $utf8 = New-Object Text.UTF8Encoding($false)
    $reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8)
    $writer = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
    $writer.AutoFlush = $true
    $writer.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ id = $null; ok = $true; ready = $true; pid = $PID }) -Compress))
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $writer.WriteLine((Invoke-Request $line))
        if ($script:quitRequested) { break }
    }
    exit 0
}

Write-Output 'desktop-uia.ps1: pass -Serve or -SelfTest (see the header comment).'
exit 2
