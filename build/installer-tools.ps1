param([switch]$NormalizeOnly)
$ErrorActionPreference = 'Stop'
function Normalize-Base([string]$Value) {
    if (-not $Value -or $Value -match '["\r\n\x00]' -or $Value -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)') { throw 'Unsupported base' }
    $normalized = [IO.Path]::GetFullPath($Value.Replace('/', '\'))
    if ($normalized -match '^[A-Za-z]:\\$') { return $normalized }
    return $normalized.TrimEnd('\')
}
function Get-Entry([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
}
function Assert-Directory([string]$Path) {
    $item = Get-Entry $Path
    if ($item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw 'Unsafe boundary' }
    return $item
}
function Remove-OwnedEntry([string]$Path) {
    $item = Get-Entry $Path
    if (-not $item) { return }
    # Reparse points are unlinked, never enumerated, including links inside owned entries.
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($item.PSIsContainer) { [IO.Directory]::Delete($Path, $false) } else { [IO.File]::Delete($Path) }
    } elseif ($item.PSIsContainer) {
        # Keep the ownership record until all other entries are gone, so locked files remain retryable.
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
            if ($child.Name -ne '.command-center-owner.json') { Remove-OwnedEntry $child.FullName }
        }
        $marker = Join-Path $Path '.command-center-owner.json'
        $ownership = if (Get-Entry $marker) { [IO.File]::ReadAllBytes($marker) } else { $null }
        if (Get-Entry $marker) { Remove-OwnedEntry $marker }
        try { [IO.Directory]::Delete($Path, $false) }
        catch {
            # Windows cannot atomically unlink a nonempty directory. Restore its record
            # if the final empty-directory delete fails, so the next attempt can retry.
            if ($ownership -and (Assert-Directory $Path) -and -not (Get-Entry $marker)) { [IO.File]::WriteAllBytes($marker, $ownership) }
            throw
        }
    } else { [IO.File]::Delete($Path) }
}
$leftovers = $false
try {
    $base = Normalize-Base $env:LOCALAPPDATA
    if ($NormalizeOnly) { Write-Output $base; exit 0 }
    if (-not (Get-Entry $base)) { throw 'Inaccessible base' }
    $app = Join-Path $base 'Command Center'
    $tools = Join-Path $app 'tools'
    $null = Assert-Directory $app
    if (-not (Assert-Directory $tools)) { Write-Output 'No managed tools to remove.'; exit 0 }
    foreach ($tool in @('opencode-v1', 'copilot')) {
        $folder = Join-Path $tools $tool
        try {
            if (-not (Assert-Directory $folder)) { continue }
            $removed = @()
            foreach ($entry in @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop)) {
                if ($entry.Name -notmatch '^install-[a-f0-9-]+$') { continue }
                if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $leftovers = $true; continue }
                $marker = Get-Entry (Join-Path $entry.FullName '.command-center-owner.json')
                if (-not $marker -or $marker.PSIsContainer -or $marker.Length -gt 4096 -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $leftovers = $true; continue }
                try { $record = [IO.File]::ReadAllText($marker.FullName) | ConvertFrom-Json }
                catch { $leftovers = $true; continue }
                $expectedTool = if ($tool -eq 'opencode-v1') { 'opencode' } else { 'copilot' }
                if ($record -isnot [PSCustomObject] -or $record.owner -isnot [string] -or $record.tool -isnot [string] -or $record.entry -isnot [string] -or ($record.format -isnot [int] -and $record.format -isnot [long])) { $leftovers = $true; continue }
                if ((($record.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'entry,format,owner,tool' -or $record.owner -cne 'com.agents.command-center' -or $record.format -ne 1 -or $record.tool -cne $expectedTool -or $record.entry -cne $entry.Name) { $leftovers = $true; continue }
                Remove-OwnedEntry $entry.FullName
                $removed += $entry.Name
            }
            foreach ($active in @(Get-ChildItem -LiteralPath $folder -Force | Where-Object { $_.Name -eq 'active.json' -or $_.Name -cmatch '^active-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$' })) {
            if ($active -and -not $active.PSIsContainer -and $active.Length -le 4096 -and -not ($active.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                try {
                    $descriptor = [IO.File]::ReadAllText($active.FullName) | ConvertFrom-Json
                    if ($descriptor -isnot [PSCustomObject] -or $descriptor.version -isnot [string] -or $descriptor.executable -isnot [string]) { throw 'Invalid descriptor' }
                    if ((($descriptor.PSObject.Properties.Name | Sort-Object) -join ',') -eq 'executable,version' -and $descriptor.version -cmatch '^1\.\d+\.\d+$' -and $descriptor.executable -cmatch '^(install-[a-f0-9-]+)[\\/](?:opencode\.exe|copilot\.exe|npm[\\/]opencode\.cmd)$' -and $removed -ccontains $Matches[1]) { [IO.File]::Delete($active.FullName) }
                } catch { $leftovers = $true }
            }
            }
            if (@(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) { [IO.Directory]::Delete($folder, $false) } else { $leftovers = $true }
        } catch { $leftovers = $true }
    }
    if (@(Get-ChildItem -LiteralPath $tools -Force).Count -eq 0) { [IO.Directory]::Delete($tools, $false) } else { $leftovers = $true }
    if (@(Get-ChildItem -LiteralPath $app -Force).Count -eq 0) { [IO.Directory]::Delete($app, $false) }
    if ($leftovers) { throw 'Entries preserved' }
    Write-Output 'Managed tools removed.'
    exit 0
} catch {
    Write-Output 'Some tool files were kept because they could not be safely removed. Command Center can still be uninstalled.'
    exit 5
}
