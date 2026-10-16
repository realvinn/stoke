// Fixed native account-check cleanup ABI. Compiled during Windows builds only.
// Keep error capture inside managed code, before PowerShell can enter its binder.
using System;
using System.Runtime.InteropServices;

public static class StokeIdentityNative
{
    public static int LastError;

    // Primitive pairs avoid PowerShell object wrappers and any Automation
    // assembly dependency. The caller retains the exact pinned records.
    public static uint[] OrderByDepth(uint[] ids, int[] depths)
    {
        if (ids == null || depths == null || ids.Length != depths.Length)
            throw new ArgumentException("Mismatched pinned-process ordering arrays");
        uint[] ordered = (uint[])ids.Clone();
        int[] keys = (int[])depths.Clone();
        Array.Sort(keys, ordered);
        return ordered;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    public static IntPtr CreateToolhelp32SnapshotChecked(uint flags, uint processId)
    {
        IntPtr result = CreateToolhelp32Snapshot(flags, processId);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool Process32FirstW(IntPtr snapshot, IntPtr entry);

    public static bool Process32FirstWChecked(IntPtr snapshot, IntPtr entry)
    {
        bool result = Process32FirstW(snapshot, entry);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool Process32NextW(IntPtr snapshot, IntPtr entry);

    public static bool Process32NextWChecked(IntPtr snapshot, IntPtr entry)
    {
        bool result = Process32NextW(snapshot, entry);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool CloseHandle(IntPtr handle);

    public static bool CloseHandleChecked(IntPtr handle)
    {
        bool result = CloseHandle(handle);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    public static IntPtr OpenProcessChecked(uint access, bool inherit, uint processId)
    {
        IntPtr result = OpenProcess(access, inherit, processId);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool GetProcessTimes(IntPtr process, ref long created, ref long exited, ref long kernel, ref long user);

    public static bool GetProcessTimesChecked(IntPtr process, ref long created, ref long exited, ref long kernel, ref long user)
    {
        bool result = GetProcessTimes(process, ref created, ref exited, ref kernel, ref user);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern uint GetSystemDirectoryW(IntPtr buffer, uint size);

    public static uint GetSystemDirectoryWChecked(IntPtr buffer, uint size)
    {
        uint result = GetSystemDirectoryW(buffer, size);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, IntPtr buffer, ref uint size);

    public static bool QueryFullProcessImageNameWChecked(IntPtr process, uint flags, IntPtr buffer, ref uint size)
    {
        bool result = QueryFullProcessImageNameW(process, flags, buffer, ref size);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    public static uint WaitForSingleObjectChecked(IntPtr handle, uint milliseconds)
    {
        uint result = WaitForSingleObject(handle, milliseconds);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    public static IntPtr CreateJobObjectWChecked(IntPtr attributes, string name)
    {
        IntPtr result = CreateJobObjectW(attributes, name);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);

    public static bool SetInformationJobObjectChecked(IntPtr job, int informationClass, IntPtr information, uint length)
    {
        bool result = SetInformationJobObject(job, informationClass, information, length);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returnLength);

    public static bool QueryInformationJobObjectChecked(IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returnLength)
    {
        bool result = QueryInformationJobObject(job, informationClass, information, length, returnLength);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    public static bool AssignProcessToJobObjectChecked(IntPtr job, IntPtr process)
    {
        bool result = AssignProcessToJobObject(job, process);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, ref bool inside);

    public static bool IsProcessInJobChecked(IntPtr process, IntPtr job, ref bool inside)
    {
        bool result = IsProcessInJob(process, job, ref inside);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    public static bool TerminateJobObjectChecked(IntPtr job, uint exitCode)
    {
        bool result = TerminateJobObject(job, exitCode);
        LastError = Marshal.GetLastWin32Error();
        return result;
    }

}
