// The session microphone's name reaches the shim through the environment, never the command line,
// so a device name with quotes or brackets cannot change the script.
export const MIC_NAME_ENV = 'DW_MIC_NAME';

// Reads or sets the mute flag on a capture endpoint through Core Audio: the active one whose name
// is in DW_MIC_NAME (exactly, or the only one starting with it: SoX's waveaudio names are cut at
// 31 characters), else the default one.
// Printed contract: "device:<name>" (diagnostic), then exactly "muted:true" or "muted:false".
export const MUTE_SHIM_SCRIPT = `
$ErrorActionPreference = 'Stop'
$action = $args[0]
$name = $env:${MIC_NAME_ENV}
if ($null -eq $name) { $name = '' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  int GetCount(out int count);
  int Item(int index, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int access, out IPropertyStore store);
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  int GetCount(out int count);
  int GetAt(int index, out PropertyKey key);
  int GetValue(ref PropertyKey key, out PropVariant value);
}
[StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
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
  public static string DeviceName = "";
  public static bool Get(string name) { bool muted; Marshal.ThrowExceptionForHR(Volume(name).GetMute(out muted)); return muted; }
  public static void Set(bool mute, string name) { var context = Guid.Empty; Marshal.ThrowExceptionForHR(Volume(name).SetMute(mute, ref context)); }
  static IAudioEndpointVolume Volume(string name) {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator() as object);
    var device = Find(enumerator, name);
    object o;
    var iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  static IMMDevice Find(IMMDeviceEnumerator enumerator, string name) {
    if (!string.IsNullOrEmpty(name)) {
      IMMDeviceCollection all;
      // eCapture, DEVICE_STATE_ACTIVE
      Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(1, 1, out all));
      int count;
      Marshal.ThrowExceptionForHR(all.GetCount(out count));
      IMMDevice prefixMatch = null;
      int prefixMatches = 0;
      for (int i = 0; i < count; i++) {
        IMMDevice candidate;
        Marshal.ThrowExceptionForHR(all.Item(i, out candidate));
        var friendly = FriendlyName(candidate);
        if (string.Equals(friendly, name, StringComparison.OrdinalIgnoreCase)) { DeviceName = friendly; return candidate; }
        if (friendly.StartsWith(name, StringComparison.OrdinalIgnoreCase)) { prefixMatch = candidate; prefixMatches++; }
      }
      if (prefixMatches == 1) { DeviceName = FriendlyName(prefixMatch); return prefixMatch; }
    }
    IMMDevice device;
    // eCapture, eMultimedia
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(1, 1, out device));
    DeviceName = FriendlyName(device);
    return device;
  }
  static string FriendlyName(IMMDevice device) {
    IPropertyStore store;
    if (device.OpenPropertyStore(0, out store) != 0) return "";
    // PKEY_Device_FriendlyName
    var key = new PropertyKey { fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid = 14 };
    PropVariant value;
    if (store.GetValue(ref key, out value) != 0 || value.vt != 31) return "";
    return Marshal.PtrToStringUni(value.p);
  }
}
'@
if ($action -eq 'mute') { [MicMute]::Set($true, $name) }
elseif ($action -eq 'unmute') { [MicMute]::Set($false, $name) }
$muted = [MicMute]::Get($name)
Write-Output ("device:" + [MicMute]::DeviceName)
Write-Output ("muted:" + $muted.ToString().ToLower())
`;

export function buildShimArgs(action: 'get' | 'mute' | 'unmute'): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', `& {${MUTE_SHIM_SCRIPT}} ${action}`];
}

// The environment for one shim run: the session microphone's name, or '' for the default device.
export function shimEnv(deviceName: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [MIC_NAME_ENV]: deviceName };
}

export function parseMuteOutput(stdout: string): boolean | null {
  const match = /muted:(true|false)/i.exec(stdout.trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}
