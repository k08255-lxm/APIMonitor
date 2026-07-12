param(
    [Parameter(Mandatory = $true)]
    [string]$StatusPath
)

$ErrorActionPreference = 'Stop'

function Write-SetupStatus([string]$status, [string]$message) {
    $directory = Split-Path -Parent $StatusPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    [ordered]@{
        status = $status
        message = $message
        completedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding utf8
}

try {
    $displayName = 'API Monitor (Private LAN)'
    $description = 'Allow API Monitor dashboard access from trusted private networks.'
    $existing = @(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue)

    if ($existing.Count -gt 1) {
        throw "More than one firewall rule is named '$displayName'. Refusing to change an ambiguous rule."
    }

    if ($existing.Count -eq 1) {
        $rule = $existing[0]
        $portFilters = @($rule | Get-NetFirewallPortFilter)
        $matchesPort = $portFilters.Count -eq 1 -and $portFilters[0].Protocol -eq 'TCP' -and $portFilters[0].LocalPort -eq '8787'
        $matchesScope = $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and $rule.Profile -eq 'Private'
        if (-not ($matchesPort -and $matchesScope)) {
            throw "An existing '$displayName' rule does not match the required Private TCP 8787 scope. Refusing to change it."
        }
        if ($rule.Enabled -ne 'True') {
            Set-NetFirewallRule -DisplayName $displayName -Enabled True | Out-Null
        }
    } else {
        New-NetFirewallRule `
            -DisplayName $displayName `
            -Description $description `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort 8787 `
            -Profile Private | Out-Null
    }

    $rule = Get-NetFirewallRule -DisplayName $displayName
    $portFilter = $rule | Get-NetFirewallPortFilter
    $message = "Rule: {0}; Profile: {1}; Protocol: {2}; Port: {3}" -f $rule.DisplayName, $rule.Profile, $portFilter.Protocol, $portFilter.LocalPort
    Write-SetupStatus 'ok' $message
    Write-Host 'Private LAN access is enabled for API Monitor.'
    Write-Host $message
} catch {
    $message = $_.Exception.Message
    Write-SetupStatus 'error' $message
    Write-Error $message
    exit 1
}
