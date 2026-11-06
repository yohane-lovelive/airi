<#
Runs the Unity Editor of this project in batch mode and reports its result.

Use this script for each batch run, because of the Microsoft Store version of Unity Hub. That version keeps its license
in a virtualized folder of its package, so a plain Unity.exe run fails with "No valid Unity Editor license found". This
script starts Unity inside the package of the Hub in that case. The license files stay as they are.

A start inside a package gives no exit code and no stdout, so this script reads the result from the log of Unity.

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

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$exitCode = $null

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3

    if (-not (Test-Path -LiteralPath $logFile)) {
        continue
    }

    $end = Select-String -LiteralPath $logFile -Pattern 'Application will terminate with return code (\d+)|^Exiting batchmode successfully' | Select-Object -Last 1

    if ($end) {
        $exitCode = if ($end.Matches[0].Groups[1].Success) { [int] $end.Matches[0].Groups[1].Value } else { 0 }
        break
    }
}

if ($null -eq $exitCode) {
    Write-Output "Unity did not finish in $TimeoutSeconds seconds. Read $logFile."
    exit 124
}

Select-String -LiteralPath $logFile -Pattern 'error CS\d+|Scripts have compiler errors|\[Package Manager\].*[Ee]rror|No valid Unity Editor license|^\[Airi\]' |
    Select-Object -First 40 |
    ForEach-Object { $_.Line }

Write-Output "Unity exit code: $exitCode (log: $logFile)"
exit $exitCode
