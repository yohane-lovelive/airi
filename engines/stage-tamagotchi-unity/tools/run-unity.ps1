<#
Runs the Unity Editor of this project in batch mode and reports its result.

Use this script for each batch run, because of the Microsoft Store version of Unity Hub. That version keeps its license
in a virtualized folder of its package, so a plain Unity.exe run fails with "No valid Unity Editor license found". This
script starts Unity inside the package of the Hub in that case. The license files stay as they are.

A start inside a package gives no exit code and no stdout, so this script reads the result from the log of Unity.
Unity can end with no result in its log, for example after EditorApplication.Exit(1) in a method of the Editor. So
this script also watches the process of Unity, and such an end is a failure with exit code 1.

Examples:
  ./tools/run-unity.ps1 -Arguments '-quit'
  ./tools/run-unity.ps1 -Arguments '-quit', '-executeMethod', 'Airi.Stage.Editor.StageBuild.BuildPlayer'
#>
param(
    # The arguments for Unity, after the arguments that this script gives.
    [string[]] $Arguments = @('-quit'),

    [int] $TimeoutSeconds = 1800
)

$ErrorActionPreference = 'Stop'

# A `powershell -File` run gives the comma list of a package.json script as one string, so Unity ignores `-quit` and
# never exits. A run inside PowerShell already gives an array, and this split does not change it.
$Arguments = @($Arguments | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

$projectPath = Split-Path -Parent $PSScriptRoot
$versionLine = Select-String -Path (Join-Path $projectPath 'ProjectSettings/ProjectVersion.txt') -Pattern '^m_EditorVersion: (.+)$'
$version = $versionLine.Matches[0].Groups[1].Value.Trim()

# AIRI_UNITY_EDITOR has priority, for an Editor outside the default folder of the Hub.
$editor = if ($env:AIRI_UNITY_EDITOR) {
    $env:AIRI_UNITY_EDITOR
}
else {
    Join-Path $env:ProgramFiles "Unity/Hub/Editor/$version/Editor/Unity.exe"
}

if (-not (Test-Path -LiteralPath $editor)) {
    throw "Unity $version not found at $editor. Install it with Unity Hub, or set AIRI_UNITY_EDITOR."
}

# This folder is outside AppData on purpose. Inside a package, Windows redirects writes under AppData to the package.
$logFolder = Join-Path $projectPath 'Logs'
New-Item -ItemType Directory -Force -Path $logFolder | Out-Null
$logFile = Join-Path $logFolder 'run-unity.log'
Remove-Item -LiteralPath $logFile -ErrorAction SilentlyContinue

$unityArguments = @('-batchmode', '-nographics', '-projectPath', "`"$projectPath`"", '-logFile', "`"$logFile`"") + $Arguments
$hub = Get-AppxPackage -Name 'UnityTechnologies.UnityHub' -ErrorAction SilentlyContinue

if ($hub) {
    $applicationId = (Get-AppxPackageManifest $hub).Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id
    Invoke-CommandInDesktopPackage `
        -PackageFamilyName $hub.PackageFamilyName `
        -AppId $applicationId `
        -Command $editor `
        -Args ($unityArguments -join ' ') `
        -PreventBreakaway
}
else {
    Start-Process -FilePath $editor -ArgumentList $unityArguments | Out-Null
}

# Gives the exit code from the result line of the log, or null when the log has no result line yet.
function Read-UnityResult {
    if (-not (Test-Path -LiteralPath $logFile)) {
        return $null
    }

    $end = Select-String -LiteralPath $logFile -Pattern 'Application will terminate with return code (\d+)|^Exiting batchmode successfully' | Select-Object -Last 1
    if (-not $end) {
        return $null
    }

    if ($end.Matches[0].Groups[1].Success) {
        return [int] $end.Matches[0].Groups[1].Value
    }

    return 0
}

# Tells whether the Unity of this run still runs. Its command line holds the path of this log, and the asset import
# workers of Unity have logs of their own.
function Test-UnityRunning {
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Unity.exe'"
    return [bool] ($processes | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($logFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

# Unity that never appears in this time counts as ended, for example after a license error at the start.
$startSeconds = 60
$started = Get-Date
$deadline = $started.AddSeconds($TimeoutSeconds)
$exitCode = $null
$seen = $false
$endedWithoutResult = $false

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3

    $exitCode = Read-UnityResult
    if ($null -ne $exitCode) {
        break
    }

    if (Test-UnityRunning) {
        $seen = $true
        continue
    }

    if ($seen -or ((Get-Date) - $started).TotalSeconds -ge $startSeconds) {
        # The log can get its last lines just after the process ends, so it gets one more read.
        Start-Sleep -Seconds 1
        $exitCode = Read-UnityResult
        $endedWithoutResult = $null -eq $exitCode
        break
    }
}

if ($null -eq $exitCode -and -not $endedWithoutResult) {
    Write-Output "Unity did not finish in $TimeoutSeconds seconds. Read $logFile."
    exit 124
}

if (Test-Path -LiteralPath $logFile) {
    Select-String -LiteralPath $logFile -Pattern 'error CS\d+|Scripts have compiler errors|\[Package Manager\].*[Ee]rror|No valid Unity Editor license|^\[Airi\]' |
        Select-Object -First 40 |
        ForEach-Object { $_.Line }
}

if ($endedWithoutResult) {
    Write-Output "Unity ended with no result in its log, for example after EditorApplication.Exit(1). Read $logFile."
    $exitCode = 1
}

Write-Output "Unity exit code: $exitCode (log: $logFile)"
exit $exitCode
