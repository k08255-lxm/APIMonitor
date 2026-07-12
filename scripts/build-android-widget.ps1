$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$widgetRoot = Join-Path $projectRoot 'android-widget'
$toolRoot = Join-Path $widgetRoot '.tooling'
$jdkRoot = Join-Path $toolRoot 'jdk'
$gradle = Join-Path $toolRoot 'gradle\gradle-8.7\bin\gradle.bat'
$sdkRoot = Join-Path $toolRoot 'android-sdk'
$sdkManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
$gradleHome = Join-Path $toolRoot 'gradle-home'

function Read-KeyValueFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $properties = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
            continue
        }

        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) {
            throw "Invalid signing metadata line in $Path"
        }

        $properties[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1).Trim()
    }

    return $properties
}

function Write-KeyValueFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Properties
    )

    @(
        '# Local signing metadata. Keep this file out of source control.'
        "storePassword=$($Properties['storePassword'])"
        "keyAlias=$($Properties['keyAlias'])"
        "keyPassword=$($Properties['keyPassword'])"
    ) | Set-Content -LiteralPath $Path -Encoding Ascii
}

function Test-KeystoreEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Keytool,
        [Parameter(Mandatory = $true)][string]$Keystore,
        [Parameter(Mandatory = $true)][string]$StorePassword,
        [Parameter(Mandatory = $true)][string]$Alias
    )

    & $Keytool -list -keystore $Keystore -storepass $StorePassword -alias $Alias *> $null
    return $LASTEXITCODE -eq 0
}

function New-SigningPassword {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    } finally {
        $random.Dispose()
    }

    return [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').TrimEnd('=')
}

function Initialize-LocalSigning {
    param(
        [Parameter(Mandatory = $true)][string]$WidgetRoot,
        [Parameter(Mandatory = $true)][string]$Keytool
    )

    $localAppData = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Join-Path $env:USERPROFILE 'AppData\Local'
    } else {
        $env:LOCALAPPDATA
    }
    $signingRoot = Join-Path $localAppData 'APIMonitor\android-signing'
    $keystore = Join-Path $signingRoot 'api-monitor-widget.jks'
    $metadataPath = Join-Path $signingRoot 'api-monitor-widget.properties'
    $gradlePropertiesPath = Join-Path $WidgetRoot 'local-signing.properties'

    New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null

    if (Test-Path $keystore) {
        if (-not (Test-Path $metadataPath)) {
            throw "Stable signing keystore exists at $keystore but its metadata is missing. Restore $metadataPath from your private backup; do not create a replacement key."
        }
        $metadata = Read-KeyValueFile -Path $metadataPath
        $requiredFields = 'storePassword', 'keyAlias', 'keyPassword'
        $missingFields = @($requiredFields | Where-Object { [string]::IsNullOrWhiteSpace($metadata[$_]) })
        if ($missingFields.Count -gt 0) {
            throw "Stable signing metadata is incomplete: $($missingFields -join ', '). Restore it from your private backup."
        }
        if (-not (Test-KeystoreEntry -Keytool $Keytool -Keystore $keystore -StorePassword $metadata['storePassword'] -Alias $metadata['keyAlias'])) {
            throw "Stable signing metadata does not open $keystore. Restore the matching private signing backup; do not generate a different key."
        }
        Write-Host 'Reusing the existing stable APK signing key.'
    } else {
        $legacyDebugKeystore = Join-Path $env:USERPROFILE '.android\debug.keystore'
        if ((Test-Path $legacyDebugKeystore) -and (Test-KeystoreEntry -Keytool $Keytool -Keystore $legacyDebugKeystore -StorePassword 'android' -Alias 'androiddebugkey')) {
            Copy-Item -LiteralPath $legacyDebugKeystore -Destination $keystore
            $metadata = @{
                storePassword = 'android'
                keyAlias = 'androiddebugkey'
                keyPassword = 'android'
            }
            Write-KeyValueFile -Path $metadataPath -Properties $metadata
            Write-Host 'Preserved the existing Android debug signing key for update compatibility.'
        } else {
            $password = New-SigningPassword
            $metadata = @{
                storePassword = $password
                keyAlias = 'apimonitorwidget'
                keyPassword = $password
            }
            & $Keytool -genkeypair -noprompt -storetype PKCS12 -keystore $keystore `
                -storepass $metadata['storePassword'] -keypass $metadata['keyPassword'] `
                -alias $metadata['keyAlias'] -keyalg RSA -keysize 4096 -validity 10000 `
                -dname 'CN=API Monitor, OU=Local Build, O=API Monitor, C=CN'
            if ($LASTEXITCODE -ne 0) {
                throw 'Could not create the stable APK signing key.'
            }
            Write-KeyValueFile -Path $metadataPath -Properties $metadata
            Write-Host 'Created a new stable local APK signing key.'
        }
    }

    @(
        '# Generated by scripts/build-android-widget.ps1. Do not commit this file.'
        "storeFile=$($keystore.Replace('\', '/'))"
        "storePassword=$($metadata['storePassword'])"
        "keyAlias=$($metadata['keyAlias'])"
        "keyPassword=$($metadata['keyPassword'])"
    ) | Set-Content -LiteralPath $gradlePropertiesPath -Encoding Ascii

    return $keystore
}

$jdk = Get-ChildItem -LiteralPath $jdkRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
    Select-Object -First 1
if ($null -eq $jdk -or -not (Test-Path $gradle) -or -not (Test-Path $sdkManager)) {
    throw 'Android build tools are incomplete. Run the toolchain setup before building.'
}

$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:GRADLE_USER_HOME = $gradleHome
$env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$($env:PATH)"
New-Item -ItemType Directory -Force -Path $sdkRoot, $gradleHome | Out-Null
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
if (-not (Test-Path $keytool)) {
    throw 'The bundled JDK does not include keytool.exe.'
}

Write-Host 'Review and accept the Android SDK licenses to continue.'
& $sdkManager "--sdk_root=$sdkRoot" --licenses
if ($LASTEXITCODE -ne 0) {
    throw 'Android SDK licenses were not accepted. The APK was not built.'
}

Write-Host 'Installing Android SDK Platform 35 and build tools...'
& $sdkManager "--sdk_root=$sdkRoot" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
if ($LASTEXITCODE -ne 0) {
    throw 'Android SDK package installation failed.'
}

$keystore = Initialize-LocalSigning -WidgetRoot $widgetRoot -Keytool $keytool

Push-Location $widgetRoot
try {
    Write-Host 'Building signed release APK...'
    & $gradle --no-daemon ':app:assembleRelease'
    if ($LASTEXITCODE -ne 0) {
        throw 'Gradle did not produce the signed release APK.'
    }
} finally {
    Pop-Location
}

$apk = Join-Path $widgetRoot 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) {
    throw "Build completed but APK was not found at $apk"
}

$apksigner = Join-Path $sdkRoot 'build-tools\35.0.0\apksigner.bat'
if (-not (Test-Path $apksigner)) {
    throw 'Android build tools did not provide apksigner.bat.'
}

Write-Host 'Verifying APK signature...'
& $apksigner verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) {
    throw 'APK signature verification failed.'
}

$artifact = Get-Item -LiteralPath $apk
Write-Host "Signed APK ready: $($artifact.FullName) ($($artifact.Length) bytes)"
Write-Host "Stable signing key: $keystore"
