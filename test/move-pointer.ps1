param([int]$PointerX, [int]$PointerY)
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class MiniBrowserTestPointer {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
}
'@
if (-not [MiniBrowserTestPointer]::SetCursorPos($PointerX, $PointerY)) { throw 'Could not move the test pointer.' }
