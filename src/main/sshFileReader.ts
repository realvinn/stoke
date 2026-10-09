/** Read-only remote helper. Request data arrives on stdin, never in shell code.
 * Descriptor-relative opens are documented at https://docs.python.org/3/library/os.html.
 * The chosen root is resolved once; every descendant is opened with O_NOFOLLOW.
 * Nothing is installed or written on the execution host. */
export const SSH_FILE_READER = String.raw`
import errno, json, os, stat, sys
LIMIT = 100 * 1024 * 1024
def reply(value):
    sys.stdout.buffer.write((json.dumps(dict(protocol="stoke-files-1", **value), ensure_ascii=True) + "\n").encode("ascii"))
    sys.stdout.buffer.flush()
def valid(path):
    return isinstance(path, str) and len(path) <= 2048 and not any(ord(c) < 32 or ord(c) == 127 or c in "\\:" or 0xD800 <= ord(c) <= 0xDFFF for c in path) and (not path or all(p and p not in (".", "..") for p in path.split("/")))
fds = []
started = False
try:
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        reply(dict(error="unsupported")); sys.exit(2)
    req = json.loads(sys.stdin.buffer.read(16385).decode("utf-8"))
    root, path, operation = req["root"], req["path"], req["operation"]
    if not isinstance(root, str) or len(root) > 2048 or not (root.startswith("/") or root.startswith("~/")) or not valid(path) or operation not in ("list", "download"):
        reply(dict(error="invalid")); sys.exit(2)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(os.path.realpath(os.path.expanduser(root)), flags | os.O_DIRECTORY)
    fds.append(fd)
    parts = path.split("/") if path else []
    if operation == "download" and not parts:
        reply(dict(error="invalid")); sys.exit(2)
    for index, part in enumerate(parts):
        directory = operation == "list" or index < len(parts) - 1
        fd = os.open(part, flags | (os.O_DIRECTORY if directory else 0), dir_fd=fd)
        fds.append(fd)
    if operation == "list":
        entries, scanned, truncated = [], 0, False
        with os.scandir(fd) as items:
            for item in items:
                scanned += 1
                relative = path + "/" + item.name if path else item.name
                if not item.name.startswith(".") and valid(relative):
                    try:
                        info = item.stat(follow_symlinks=False)
                        if stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode):
                            entries.append(dict(name=item.name, path=relative, kind="folder" if stat.S_ISDIR(info.st_mode) else "file", size=None if stat.S_ISDIR(info.st_mode) else info.st_size))
                    except OSError:
                        pass
                if len(entries) > 200 or scanned >= 2000:
                    truncated = True; break
        entries.sort(key=lambda item: (item["kind"] != "folder", item["name"]))
        reply(dict(path=path, entries=entries[:200], truncated=truncated))
    else:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            reply(dict(error="not-file")); sys.exit(2)
        if before.st_size > LIMIT:
            reply(dict(error="too-large")); sys.exit(2)
        reply(dict(size=before.st_size))
        started = True
        remaining = before.st_size
        while remaining:
            chunk = os.read(fd, min(262144, remaining))
            if not chunk:
                sys.exit(3)
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
        sys.stdout.buffer.flush()
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            sys.exit(3)
except OSError as error:
    if not started:
        code = "not-found" if error.errno == errno.ENOENT else "denied" if error.errno in (errno.EACCES, errno.EPERM, errno.ELOOP, errno.ENOTDIR) else "read-failed"
        reply(dict(error=code))
    sys.exit(2)
except (ValueError, KeyError, TypeError, UnicodeError):
    if not started:
        reply(dict(error="invalid"))
    sys.exit(2)
finally:
    for fd in reversed(fds):
        os.close(fd)
`
