# =============================================================================
# win-sensors.ps1 — Sensores de Windows: ventana activa, música y notificaciones.
#
# Corre en un bucle infinito (una vuelta por segundo) e imprime una línea JSON
# por cada cambio. La lee src/sensors/index.js.
#   - Ventana activa: cada 1 s (API user32 de Windows).
#   - Música: cada 2 s (control de medios de Windows: Spotify, YouTube, etc.).
#   - Notificaciones: cada 3 s (UserNotificationListener). Funciona aunque esté
#     activado "No molestar", porque Windows igual las guarda en el centro de
#     notificaciones.
# Este script NO manda nada a internet: solo lee y le pasa los datos a Node.
# =============================================================================
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

# Las APIs de Windows (WinRT) son asíncronas. Await() espera el resultado:
# convierte la operación en una Task de .NET y la espera.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$t) {
  $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

[Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$access = Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
Emit @{ type = 'status'; notifications = "$access" }

$mediaMgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$firstNotifPass = $true
$lastWin = ''
$lastMedia = ''
$tick = 0

# Lee las notificaciones y emite solo las NUEVAS (las ya vistas se guardan en
# $seen). En la primera vuelta solo marca las viejas como vistas, para no
# repetir todo el historial al arrancar.
function Read-Notifications {
  $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
  foreach ($n in $list) {
    if (-not $seen.Add($n.Id)) { continue }
    if ($script:firstNotifPass) { continue }
    $texts = @()
    try {
      $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      if ($binding) { $texts = @($binding.GetTextElements() | ForEach-Object { $_.Text }) }
    } catch {}
    $app = ''
    try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch {}
    Emit @{ type = 'notification'; app = $app; title = ($texts | Select-Object -First 1); body = (($texts | Select-Object -Skip 1) -join "`n") }
  }
  $script:firstNotifPass = $false
}

# Qué está sonando ahora (la sesión de medios activa de Windows).
function Read-Media {
  $s = $mediaMgr.GetCurrentSession()
  if (-not $s) { return @{ type = 'media'; playing = $false } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  @{
    type = 'media'; source = $s.SourceAppUserModelId; artist = $p.Artist; title = $p.Title
    playing = ($s.GetPlaybackInfo().PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)
  }
}

# Bucle principal. $tick cuenta segundos para repartir cada lectura.
while ($true) {
  try {
    # Ventana activa: título + nombre del proceso (ej: "Code", "brave", "Spotify")
    $h = [Fg]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [Fg]::GetWindowText($h, $sb, 512) | Out-Null
    $procId = 0
    [Fg]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $proc = ''
    try { $proc = (Get-Process -Id $procId).ProcessName } catch {}
    $key = "$proc|$($sb.ToString())"
    if ($key -ne $lastWin -and $sb.Length -gt 0) {
      $lastWin = $key
      Emit @{ type = 'window'; process = $proc; title = $sb.ToString() }
    }

    if ($tick % 2 -eq 0) {
      $m = Read-Media
      $mk = "$($m.artist)|$($m.title)|$($m.playing)"
      if ($mk -ne $lastMedia) { $lastMedia = $mk; Emit $m }
    }
    if ($tick % 3 -eq 0 -and "$access" -eq 'Allowed') { Read-Notifications }
  } catch {
    Emit @{ type = 'error'; message = $_.Exception.Message }
  }
  $tick++
  Start-Sleep -Milliseconds 1000
}
