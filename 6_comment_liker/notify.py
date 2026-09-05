#!/usr/bin/env python3
"""
Get someone's attention when a run needs a person.

A captcha stops the whole thing until somebody drags a slider, and it gives up
after four minutes whether anyone noticed or not. A run lasts hours and nobody
watches a terminal for hours, so the one moment that needs a human was the one
moment most likely to be missed. The terminal bell is not enough: it is silent in
plenty of terminals and invisible if the window is behind something.

So: a Windows toast that survives being ignored, and a sound that repeats until
the captcha is gone.

    import notify
    with notify.nagging("Captcha", "profile e needs you"):
        ...wait for the person...

Everything here fails quietly. A notification that raises would end a run that was
otherwise fine, which is a worse outcome than a missed captcha.

    python notify.py          # send a test alert
"""
import subprocess
import sys
import threading
import time

WINDOWS = sys.platform == "win32"

# PowerShell that raises a real Windows toast. Written against the shell rather
# than a pip package so there is nothing to install: this runs on a stock box.
#
# The AppId is PowerShell's own. A toast needs an application registered with the
# Start menu to appear at all, and borrowing PowerShell's is what makes this work
# without installing and registering something of our own.
_TOAST_PS = """
$ErrorActionPreference = 'Stop'
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $x = $t.GetElementsByTagName('text')
    $x.Item(0).AppendChild($t.CreateTextNode('__TITLE__')) | Out-Null
    $x.Item(1).AppendChild($t.CreateTextNode('__BODY__')) | Out-Null
    $n = [Windows.UI.Notifications.ToastNotification]::new($t)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($n)
} catch {
    # Older shells and locked-down boxes have no WinRT toast. The tray balloon
    # is uglier and always available, and Windows renders it as a toast anyway.
    Add-Type -AssemblyName System.Windows.Forms
    $i = New-Object System.Windows.Forms.NotifyIcon
    $i.Icon = [System.Drawing.SystemIcons]::Exclamation
    $i.BalloonTipTitle = '__TITLE__'
    $i.BalloonTipText = '__BODY__'
    $i.Visible = $true
    $i.ShowBalloonTip(20000)
    Start-Sleep -Seconds 12
    $i.Dispose()
}
"""


def _clean(s: str) -> str:
    """Make text safe to paste into the script above.

    Single quotes end a PowerShell string, and newlines would break the one-line
    assignments. Doubling and flattening is enough; nothing here is untrusted.
    """
    return " ".join(str(s).split()).replace("'", "''")[:180]


def toast(title: str, body: str) -> bool:
    """Raise a Windows notification. False if it could not be sent."""
    if not WINDOWS:
        return False
    script = _TOAST_PS.replace("__TITLE__", _clean(title)).replace("__BODY__", _clean(body))
    try:
        # -EncodedCommand takes base64 UTF-16LE, which sidesteps every layer of
        # quoting between here and the shell.
        import base64

        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return True
    except Exception:  # noqa: BLE001
        return False


def sound(times: int = 3) -> None:
    """Play the system alert, out loud, more than once.

    PlaySound goes through the sound card, so it is audible on headphones and at
    whatever volume the machine is set to. Beep() drives the motherboard speaker
    and is inaudible on most laptops, which is why it is only the fallback.
    """
    try:
        import winsound

        for i in range(max(1, times)):
            if i:
                time.sleep(0.35)
            try:
                winsound.PlaySound(
                    "SystemExclamation", winsound.SND_ALIAS | winsound.SND_ASYNC
                )
            except Exception:  # noqa: BLE001
                winsound.Beep(880, 250)
    except Exception:  # noqa: BLE001
        # Not Windows, or no audio at all. The bell is better than silence.
        try:
            sys.stdout.write("\a")
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass


def alert(title: str, body: str, times: int = 3) -> None:
    """One toast and a burst of sound."""
    toast(title, body)
    sound(times)


class nagging:
    """Keep alerting until the block clears, then stop.

    A single notification four minutes before a timeout is easy to miss; one that
    repeats is not. The toast goes out once — a stack of identical toasts is just
    noise — and the sound repeats.

    Used as a context manager so the reminder cannot outlive whatever it was
    reminding about, including when that ends by exception.
    """

    def __init__(self, title: str, body: str, every: float = 20.0):
        self.title, self.body, self.every = title, body, max(5.0, every)
        self._stop = threading.Event()
        self._thread = None

    def __enter__(self):
        alert(self.title, self.body)

        def loop():
            while not self._stop.wait(self.every):
                sound(2)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        return False


def main() -> int:
    print("sending a test notification and playing the alert sound…")
    ok = toast("Captcha waiting", "Test alert from the comment liker.")
    sound(3)
    print(f"toast: {'sent' if ok else 'could not send (sound only)'}")
    print("Nagging for 25 seconds — this is what a captcha sounds like.")
    with nagging("Captcha waiting", "Test — nagging every 10s", every=10):
        time.sleep(25)
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
