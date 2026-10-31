# =============================================================================
# media-control.ps1 — Controla la música (Spotify, YouTube en el navegador, etc.)
#
# Queda abierto esperando órdenes por stdin, una por línea:
#   toggle → play/pausa     next → siguiente     prev → anterior
# Usa el mismo control de medios de Windows que lee win-sensors.ps1, así que
# manda la orden a la app que esté sonando (sin simular teclas, así no aparece
# el cartel de volumen de Windows).
# Responde una línea JSON por orden: {"type":"media-control","cmd":"next","ok":true}
# =============================================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$t) {
  $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# ¿A qué app le hablamos? La "actual" de Windows a veces es un video pausado del
# navegador, así que elegimos: 1) la que está sonando, 2) Spotify, 3) la actual.
# (win-sensors.ps1 elige igual, así el menú muestra la misma canción.)
function Pick-Session {
  $all = @($mgr.GetSessions())
  $playing = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
  $s = $all | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq $playing } | Select-Object -First 1
  if (-not $s) { $s = $all | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1 }
  if (-not $s) { $s = $mgr.GetCurrentSession() }
  $s
}

# Espera órdenes. ReadLine devuelve $null cuando Node cierra stdin → terminamos.
while ($null -ne ($cmd = [Console]::In.ReadLine())) {
  $cmd = $cmd.Trim()
  try {
    $s = Pick-Session
    if (-not $s) { Emit @{ type = 'media-control'; cmd = $cmd; ok = $false; reason = 'sin-musica' }; continue }
    $op = switch ($cmd) {
      'toggle' { $s.TryTogglePlayPauseAsync() }
      'next'   { $s.TrySkipNextAsync() }
      'prev'   { $s.TrySkipPreviousAsync() }
      default  { $null }
    }
    if (-not $op) { continue }
    $ok = Await $op ([bool])
    Emit @{ type = 'media-control'; cmd = $cmd; ok = [bool]$ok }
  } catch {
    Emit @{ type = 'media-control'; cmd = $cmd; ok = $false; reason = $_.Exception.Message }
  }
}
