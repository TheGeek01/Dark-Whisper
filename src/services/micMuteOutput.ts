// Reads or sets the mute flag on the default capture endpoint through Core Audio.
// Printed contract: exactly "muted:true" or "muted:false" on stdout.
export const MUTE_SHIM_SCRIPT = `
$ErrorActionPreference = 'Stop'
$action = $args[0]
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  // Eleven methods precede SetMute in the vtable (RegisterControlChangeNotify .. GetChannelVolumeLevelScalar).
  int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
  int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8();
  int NotImpl9(); int NotImpl10(); int NotImpl11();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
public static class MicMute {
  public static bool Get() { return Volume().Item1; }
  public static void Set(bool mute) { var v = Volume(); var context = Guid.Empty; Marshal.ThrowExceptionForHR(v.Item2.SetMute(mute, ref context)); }
  static Tuple<bool, IAudioEndpointVolume> Volume() {
    IMMDevice device;
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator() as object);
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(1, 1, out device));
    object o;
    var iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
    var volume = (IAudioEndpointVolume)o;
    bool muted;
    Marshal.ThrowExceptionForHR(volume.GetMute(out muted));
    return Tuple.Create(muted, volume);
  }
}
'@
if ($action -eq 'get') { }
elseif ($action -eq 'mute') { [MicMute]::Set($true) }
elseif ($action -eq 'unmute') { [MicMute]::Set($false) }
Write-Output ("muted:" + [MicMute]::Get().ToString().ToLower())
`;

export function buildShimArgs(action: 'get' | 'mute' | 'unmute'): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', `& {${MUTE_SHIM_SCRIPT}} ${action}`];
}

export function parseMuteOutput(stdout: string): boolean | null {
  const match = /muted:(true|false)/i.exec(stdout.trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}
