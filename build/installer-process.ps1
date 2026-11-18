[CmdletBinding()]
param([int]$TimeoutMs = 140000)
$ErrorActionPreference = 'Stop'
# Recheck the retained handle after a racing API failure. Unknown/live failures
# still refuse; an exited process may use only the operation's explicit recovery.
function Test-ProcessExited($Process) {
    try { return $Process.HasExited }
    catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if (($cause -is [InvalidOperationException] -or $cause -is [ComponentModel.Win32Exception]) -and $Process.HasExited) { return $true }
        throw
    }
}
function Invoke-ProcessCall($Process, [scriptblock]$Call, [scriptblock]$OnExit) {
    try { & $Call }
    catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if (($cause -is [InvalidOperationException] -or $cause -is [ComponentModel.Win32Exception]) -and (Test-ProcessExited $Process)) {
            & $OnExit
        } else { throw }
    }
}
# A false from CloseMainWindow refuses only a process that is still running.
function Request-Close($Process) {
    Invoke-ProcessCall $Process {
        if (-not $Process.CloseMainWindow() -and -not (Test-ProcessExited $Process)) { throw 'Application refused closure' }
    } { }
}
function Get-TrackedProcess($Id) {
    try { return [Diagnostics.Process]::GetProcessById($Id) }
    catch [ArgumentException] { return $null } # Gone since the native snapshot.
}
$failureCode = 6 # Inspection could not run. Only confirmed application refusals use 4.
try {
    if (-not $env:CC_INSTALL_DIR -or $env:CC_INSTALL_DIR -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)') { throw 'Unknown installation' }
    $inputRoot = [IO.Path]::GetFullPath($env:CC_INSTALL_DIR.Replace('/', '\')).TrimEnd('\')
    $root = $inputRoot
    # Resolve the existing directory through the same native handle as executable paths.
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CCInstallPath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern IntPtr CreateFile(string p, int a, int s, IntPtr x, int d, int f, IntPtr t);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder b, int n, int f);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 struct ProcessEntry {
  public uint Size, Usage, Id; public IntPtr Heap; public uint Module, Threads, Parent;
  public int Priority; public uint Flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
 }
 public class ProcessRow {
  public int ProcessId, ParentProcessId;
  public string Name, ExecutablePath, CommandLine;
  public DateTime CreationDate;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32First(IntPtr h,ref ProcessEntry e);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32Next(IntPtr h,ref ProcessEntry e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder path,ref int length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long creation,out long exit,out long kernel,out long user);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int c,IntPtr b,int n,out int needed);
 static string CommandLine(IntPtr h) {
  int n; NtQueryInformationProcess(h,60,IntPtr.Zero,0,out n);
  if(n<=0 || n>131072) return null;
  var b=Marshal.AllocHGlobal(n);
  try { if(NtQueryInformationProcess(h,60,b,n,out n)!=0) return null;
   return Marshal.PtrToStringUni(Marshal.ReadIntPtr(b,IntPtr.Size==8?8:4),((ushort)Marshal.ReadInt16(b))/2);
  } finally { Marshal.FreeHGlobal(b); }
 }
 public static ProcessRow[] Snapshot() {
  var h=CreateToolhelp32Snapshot(2,0);
  if(h==new IntPtr(-1)) throw new Exception("Cannot enumerate processes");
  try {
   var rows=new System.Collections.Generic.List<ProcessRow>();
   var e=new ProcessEntry(); e.Size=(uint)Marshal.SizeOf(e);
   if(!Process32First(h,ref e)) throw new Exception("Cannot enumerate processes");
   do {
    var row=new ProcessRow { ProcessId=(int)e.Id, ParentProcessId=(int)e.Parent, Name=e.Name };
    var p=OpenProcess(0x1000,false,e.Id);
    if(p!=IntPtr.Zero) {
     try {
      var path=new StringBuilder(32768); int n=path.Capacity; long created,exited,kernel,user;
      if(GetProcessTimes(p,out created,out exited,out kernel,out user)) row.CreationDate=DateTime.FromFileTimeUtc(created);
      if(QueryFullProcessImageName(p,0,path,ref n)) row.ExecutablePath=path.ToString();
      row.CommandLine=CommandLine(p);
     } finally { CloseHandle(p); }
    } else if(Marshal.GetLastWin32Error()==87 && e.Id!=0) { continue; } // Exited since the snapshot, not an unreadable live process.
    rows.Add(row);
   } while(Process32Next(h,ref e));
   if(Marshal.GetLastWin32Error()!=18) throw new Exception("Incomplete process enumeration");
   return rows.ToArray();
  } finally { CloseHandle(h); }
 }
 public static string Resolve(string p) {
  var h=CreateFile(p,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
  if(h==new IntPtr(-1)) throw new Exception("Unknown path");
  try { var b=new StringBuilder(32768); var n=GetFinalPathNameByHandle(h,b,b.Capacity,0);
   if(n==0 || n>=b.Capacity) throw new Exception("Unknown path"); return b.ToString().TrimEnd('\\');
  } finally { CloseHandle(h); }
 }
}
'@
    # First install can select a missing leaf. Resolve its nearest existing ancestor.
    $suffix = ''
    while (-not [IO.Directory]::Exists($root)) {
        $suffix = '\' + [IO.Path]::GetFileName($root) + $suffix
        $parent = [IO.Path]::GetDirectoryName($root)
        if (-not $parent -or $parent -eq $root) { throw 'Unknown installation' }
        $root = $parent
    }
    $root = [CCInstallPath]::Resolve($root) + $suffix
    $tracked = @{}
    $creationTimes = @{}
    $closeable = @{}
    $servers = @{}
    $graph = @{}
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $requested = @{}
    # Exit contract: an inside server that exits with code 1 did not confirm its drain.
    # Run once per pass and again as the LAST step before success, so an exit between
    # the first pass and the final liveness check is still examined.
    function Assert-ClosedCleanly {
        foreach ($id in @($tracked.Keys)) {
            $proc = $tracked[$id]
            if (-not $closeable.ContainsKey($id) -or -not (Test-ProcessExited $proc)) { continue }
            # ExitCode must remain readable. Retry after exit, never invent success.
            $exitCode = Invoke-ProcessCall $proc { $proc.ExitCode } {
                if ($servers.ContainsKey($id)) { $proc.ExitCode } else { 'unavailable' }
            }
            Write-Verbose "Process $id inside: exit=$exitCode$(if ($servers.ContainsKey($id)) { '; role=server' })"
            if ($servers.ContainsKey($id) -and $exitCode -eq 1) { throw 'Application drain failed' }
        }
    }
    do {
        $failureCode = 6
        $snapshot = @([CCInstallPath]::Snapshot())
        $self = @($snapshot | Where-Object { $_.ProcessId -eq $PID })
        if ($self.Count -ne 1) { throw 'Unknown setup identity' }
        $setupPid = 0
        if ($env:CC_SETUP_PID) {
            if (-not [int]::TryParse($env:CC_SETUP_PID, [ref]$setupPid) -or $setupPid -ne $self[0].ParentProcessId) { throw 'Unknown setup identity' }
        }
        $failureCode = 4
        # Expand the full descendant graph before closing any parent, independent of snapshot order.
        do {
        $beforeCount = $graph.Count
        foreach ($row in $snapshot) {
            if ($row.ProcessId -eq $PID -or $row.ProcessId -eq $setupPid) { continue }
            $id = [int]$row.ProcessId
            # A captured row can outlive normal exit. Compare identities, not liveness.
            # The retained process handle is the only object we ever close or wait on.
            if ($tracked.ContainsKey($id)) {
                if (Test-ProcessExited $tracked[$id]) {
                    # A reused PID is never the retained process. A new image inside
                    # this install still prevents replacement, without closing that PID.
                    if ($row.CreationDate.ToUniversalTime().Ticks -ne $graph[$id]) {
                        if ([string]::IsNullOrEmpty($row.ExecutablePath)) {
                            if ($row.Name -eq $env:CC_INSTALL_EXE) { throw 'Unknown process identity' }
                        } elseif ([CCInstallPath]::Resolve($row.ExecutablePath).StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
                            throw 'New application process identity'
                        }
                    }
                    continue
                }
                if (-not $closeable.ContainsKey($id)) { continue }
                if ($creationTimes[$id] -ne $row.CreationDate.ToUniversalTime().Ticks) { throw 'Process identity changed' }
                continue
            }
            $descendant = $graph.ContainsKey([int]$row.ParentProcessId) -and $graph[[int]$row.ParentProcessId] -le $row.CreationDate.ToUniversalTime().Ticks
            if (-not $row.ExecutablePath) {
                if ($row.Name -eq $env:CC_INSTALL_EXE) { throw 'Unknown process identity' }
                if ($descendant) { Write-Verbose "Process $id outside: unreadable non-app image; ignored" }
                continue
            }
            # Canonical separator boundary excludes similarly prefixed siblings.
            $inside = $false
            if ($row.Name -eq $env:CC_INSTALL_EXE -or $descendant -or $row.ExecutablePath.Replace('/', '\').StartsWith($inputRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                try { $canonical = [CCInstallPath]::Resolve($row.ExecutablePath) }
                catch {
                    if ($row.Name -eq $env:CC_INSTALL_EXE -or $row.ExecutablePath.Replace('/', '\').StartsWith($inputRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unknown process identity' }
                    Write-Verbose "Process $id outside: unresolved non-app image; ignored"
                    continue
                }
                $inside = $canonical.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
            }
            if (-not $inside -and -not $descendant) { continue }
            $graph[$id] = $row.CreationDate.ToUniversalTime().Ticks
            if (-not $inside) {
                Write-Verbose "Process $id outside: ignored; exit=not-waited"
                # Keep an optional diagnostic handle only. It never participates in drain.
                try {
                    $outside = Get-TrackedProcess $id
                    if (-not $outside) { continue }
                    $null = Invoke-ProcessCall $outside { $outside.Handle } { }
                    if ((Invoke-ProcessCall $outside { $outside.StartTime.ToUniversalTime().Ticks } { $row.CreationDate.ToUniversalTime().Ticks }) -eq $row.CreationDate.ToUniversalTime().Ticks) { $tracked[$id] = $outside }
                    else { $outside.Dispose() }
                } catch { Write-Verbose "Process $id outside: identity unavailable; ignored" }
                continue
            }
            $id = [int]$row.ProcessId
            if ($inside) { $closeable[$id] = $true }
            # Electron's Node server uses the same image as its shell and helpers.
            # Its entry argument identifies the server exit contract: 1 means drain unconfirmed.
            if ($row.Name -eq $env:CC_INSTALL_EXE -and -not $row.CommandLine) { throw 'Unknown process identity' }
            if ($row.CommandLine -match 'server[\\/]index\.ts') { $servers[$id] = $true }
            if (-not $tracked.ContainsKey($id)) {
                $proc = Get-TrackedProcess $id
                if (-not $proc) {
                    # An inside server gone before its handle was taken has an unreadable exit code: never success.
                    if ($servers.ContainsKey($id)) { throw 'Application drain not confirmed' }
                    continue
                }
                $null = Invoke-ProcessCall $proc { $proc.Handle } { } # Retain the exit-code-capable handle.
                if ((Invoke-ProcessCall $proc { $proc.StartTime.ToUniversalTime().Ticks } { $row.CreationDate.ToUniversalTime().Ticks }) -ne $row.CreationDate.ToUniversalTime().Ticks) { throw 'Process identity changed' }
                $tracked[$id] = $proc
                $creationTimes[$id] = $row.CreationDate.ToUniversalTime().Ticks
            }
        }
        } while ($graph.Count -gt $beforeCount)
        Assert-ClosedCleanly
        foreach ($id in @($tracked.Keys)) {
            $proc = $tracked[$id]
            if (Test-ProcessExited $proc) { continue }
            if ($closeable.ContainsKey($id) -and -not $requested.ContainsKey($id) -and (Invoke-ProcessCall $proc { $proc.MainWindowHandle } { [IntPtr]::Zero }) -ne [IntPtr]::Zero) {
                Request-Close $proc
                $requested[$id] = $true
            }
        }
        $alive = @($tracked.Keys | Where-Object { $closeable.ContainsKey($_) -and -not (Test-ProcessExited $tracked[$_]) })
        if ($alive.Count -eq 0) { Assert-ClosedCleanly; Write-Output 'Application closure and drain confirmed.'; exit 0 }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Application closure was not confirmed' }
        Start-Sleep -Milliseconds 100
    } while ($true)
} catch {
    Write-Verbose $_.Exception.Message
    if ($failureCode -eq 4) {
        Write-Output 'Command Center could not close safely. Setup stopped. Close Command Center and try again.'
    } else {
        Write-Output 'Setup could not check whether Command Center is running on this PC, so it stopped without changing anything.'
    }
    exit $failureCode
} finally {
    if ($tracked) { foreach ($proc in $tracked.Values) { $proc.Dispose() } }
}
