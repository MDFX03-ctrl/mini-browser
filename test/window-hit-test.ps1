param([string]$WindowHandle, [int]$X, [int]$Y, [int]$ViewportWidth)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrowserHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
}
'@
[BrowserHitTest]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$handle = [IntPtr]([long]::Parse($WindowHandle))
$origin = New-Object BrowserHitTest+POINT
$rect = New-Object BrowserHitTest+RECT
if (-not [BrowserHitTest]::ClientToScreen($handle, [ref]$origin) -or -not [BrowserHitTest]::GetClientRect($handle, [ref]$rect)) { throw 'Test window unavailable' }
$scale = ($rect.Right - $rect.Left) / [double]$ViewportWidth
$px = $origin.X + [int][Math]::Round($X * $scale)
$py = $origin.Y + [int][Math]::Round($Y * $scale)
$packed = (($py -band 65535) -shl 16) -bor ($px -band 65535)
$result = [IntPtr]::Zero
$sent = [BrowserHitTest]::SendMessageTimeout($handle, 132, [IntPtr]::Zero, [IntPtr]$packed, 2, 2000, [ref]$result)
if ($sent -eq [IntPtr]::Zero) { throw 'Window hit test timed out' }
$result.ToInt64()
