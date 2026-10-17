"""code-flow's pseudo-terminal for the side panel's Terminal (src/shell.ts starts it).

    python3 pty.py COLS ROWS PROGRAM ARGV0 [ARG...]

Runs PROGRAM (your login shell) in a new pseudo-terminal, so pagers, prompts, colours and
full-screen programs work, without a native npm module. Bytes are relayed as they are:

    fd 0  keystrokes in             fd 1  what the terminal shows, out
    fd 3  control, JSON lines both ways:
            in   {"resize": [cols, rows]}
            out  {"pid": n, "tty": "/dev/ttys004"} once, then {"fg": pgid} whenever the
                 terminal's foreground process group changes (PROGRAM's own pid: nothing
                 else is running in the foreground)

It stops when PROGRAM exits, on SIGTERM/SIGHUP/SIGINT, or when fd 0 closes (code-flow went
away). Everything still in PROGRAM's session (what it started, unless that called setsid) then
gets SIGHUP (and SIGCONT, for stopped jobs), and SIGKILL a second later. Exits with PROGRAM's exit code, or 128 + the signal that ended it.
Standard library only; Python 3.6 or later.
"""

import errno
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

CONTROL = 3
GRACE = 1.0


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    """Write everything, waiting when the other end is full (a non-blocking pipe)."""
    view = memoryview(data)
    while view:
        try:
            view = view[os.write(fd, view):]
        except BlockingIOError:
            select.select([], [fd], [], 1.0)


def start(program, argv, cols, rows, control_open):
    master, slave = os.openpty()
    set_size(slave, cols, rows)
    tty = os.ttyname(slave)
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            if control_open:
                os.close(CONTROL)
            os.setsid()  # a session of its own, with this terminal as its controlling terminal
            if hasattr(termios, "TIOCSCTTY"):
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            else:
                os.close(os.open(tty, os.O_RDWR))
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            # Python ignores these at start-up, and ignored signals survive exec: `yes | head`
            # would complain about a broken pipe instead of just stopping.
            for sig in ("SIGPIPE", "SIGXFSZ"):
                if hasattr(signal, sig):
                    signal.signal(getattr(signal, sig), signal.SIG_DFL)
            os.execv(program, argv)
        except BaseException as err:  # noqa: B902 (anything: report it on the terminal and stop)
            os.write(2, ("couldn't start %s: %s\r\n" % (program, err)).encode())
            os._exit(127)
    os.close(slave)
    return pid, master, tty


def groups_of(session):
    """The process groups of everything in PROGRAM's session: what it started, still running.

    By session, not by terminal: once PROGRAM (the session's leader) has exited, its jobs no longer
    have a controlling terminal, but they keep its session.
    """
    if os.path.isdir("/proc/self"):
        pids = [int(entry) for entry in os.listdir("/proc") if entry.isdigit()]  # Linux: no ps needed
    else:
        try:
            out = subprocess.run(["ps", "-ax", "-o", "pid="], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5).stdout
            pids = [int(word) for word in out.split() if word.isdigit()]
        except (OSError, subprocess.SubprocessError):
            pids = []
    found = {session}
    for pid in pids:
        try:
            if os.getsid(pid) == session:
                found.add(os.getpgid(pid))
        except OSError:
            pass  # gone, or not ours to look at
    return {g for g in found if g > 1 and g != os.getpgrp()}


def hang_up(pid):
    """SIGHUP to everything PROGRAM started, as when a terminal window closes; SIGKILL to what's left."""
    groups = groups_of(pid)
    for g in groups:
        for sig in (signal.SIGHUP, signal.SIGCONT):
            try:
                os.killpg(g, sig)
            except OSError:
                pass
    deadline = time.monotonic() + GRACE
    while groups and time.monotonic() < deadline:
        reap(pid)
        time.sleep(0.05)
        groups = {g for g in groups if alive(g)}
    for g in groups | groups_of(pid):
        try:
            os.killpg(g, signal.SIGKILL)
        except OSError:
            pass


def alive(group):
    try:
        os.killpg(group, 0)
        return True
    except OSError:
        return False


status = {"code": None}


def reap(pid):
    """PROGRAM's exit code once it has exited (and been waited for), else None."""
    if status["code"] is None:
        try:
            done, raw = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done, raw = pid, 0
        if done:
            status["code"] = 128 + os.WTERMSIG(raw) if os.WIFSIGNALED(raw) else os.WEXITSTATUS(raw)
    return status["code"]


def main():
    cols, rows, program, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4:]
    control_open = True
    try:
        os.fstat(CONTROL)
    except OSError:
        control_open = False  # started by hand: no control channel
    pid, master, tty = start(program, argv, cols, rows, control_open)
    os.set_blocking(master, False)

    def tell(message):
        if control_open:
            try:
                write_all(CONTROL, (json.dumps(message) + "\n").encode())
            except OSError:
                pass

    tell({"pid": pid, "tty": tty})
    try:
        relay(pid, master, tell, [0, CONTROL] if control_open else [0])
    except OSError:
        pass  # code-flow went away mid-write: hang up all the same
    finally:
        if status["code"] is not None:
            # PROGRAM exited: pass on what it printed last before hanging up.
            deadline = time.monotonic() + 0.3
            while time.monotonic() < deadline:
                try:
                    if not select.select([master], [], [], 0.05)[0]:
                        break
                    data = os.read(master, 65536)
                    if not data:
                        break
                    write_all(1, data)
                except OSError:
                    break
        hang_up(pid)
        os.close(master)
        deadline = time.monotonic() + GRACE
        while reap(pid) is None and time.monotonic() < deadline:
            time.sleep(0.05)
    code = status["code"]
    sys.exit(code if code is not None else 129)


def relay(pid, master, tell, inputs):
    """Bytes both ways until PROGRAM exits, the terminal closes, a stop signal, or code-flow goes away."""
    # Signals only wake the loop; it decides what to do.
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)
    stop = {"now": False}

    def on_stop(*_):
        stop["now"] = True

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, on_stop)
    signal.signal(signal.SIGCHLD, lambda *_: None)

    keys = bytearray()  # keystrokes the terminal hasn't taken yet
    control = b""
    fg = None
    while not stop["now"]:
        readable, writable, _ = select.select([master, wake_r] + inputs, [master] if keys else [], [], 0.5)
        if wake_r in readable:
            try:
                os.read(wake_r, 512)
            except OSError:
                pass
        if master in readable:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = None
            except OSError as err:  # EIO on Linux once nothing holds the terminal open
                if err.errno != errno.EIO:
                    raise
                data = b""
            if data:
                write_all(1, data)
            elif data == b"":
                break
        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                break  # code-flow went away
            keys += data
        if keys:
            try:
                del keys[:os.write(master, keys)]
            except BlockingIOError:
                pass
        if CONTROL in readable:
            try:
                data = os.read(CONTROL, 65536)
            except BlockingIOError:
                data = None
            if data == b"":
                inputs.remove(CONTROL)
            elif data:
                control += data
                *lines, control = control.split(b"\n")
                for line in lines:
                    try:
                        size = json.loads(line.decode()).get("resize")
                        set_size(master, max(2, int(size[0])), max(1, int(size[1])))
                    except (ValueError, TypeError, IndexError, AttributeError, OSError):
                        pass
        if reap(pid) is not None:
            break
        try:
            now = os.tcgetpgrp(master)
        except OSError:
            now = None
        if now != fg:
            fg = now
            tell({"fg": fg})


if __name__ == "__main__":
    main()
